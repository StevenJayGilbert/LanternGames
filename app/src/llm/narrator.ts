// Narrator: bridges player input ↔ engine ↔ LLM.
//
// Per turn:
//   1. Player input + current view sent to Claude (with tools = engine actions)
//   2. Claude calls a tool (e.g. take(itemId="key")) → we execute via engine
//   3. Engine result fed back to Claude as tool_result
//   4. Claude returns final narration text
//
// The engine is the source of truth for state. Claude's job is intent parsing
// (player text → tool call) and prose narration (event + view + cues → text).
// If Claude responds with prose without calling a tool, we treat that as
// "this command can't be enacted by an engine action" — display Claude's
// prose, no state change.

import type { Engine, EngineResult } from "../engine/engine";
import type { ActionRequest } from "../engine/actions";
import type { WorldView } from "../engine/view";
import type { CustomTool, Story } from "../story/schema";
import {
  alwaysOnCustomTools,
  activeConditionalCustomTools,
} from "../engine/intents";
import type {
  AssistantMessage,
  ContentBlock,
  LLMClient,
  Message,
  Tool,
} from "./types";
import { LLMError } from "./types";
import { debugLog, isDebugEnabled } from "../debug";

// Per-turn debug-only system-prompt suffix asking the model to emit a brief
// "[reasoning] …" text block alongside each tool call. Logged by the LLM
// client; stripped from player-facing narration by collectText. Kept
// story-agnostic — no story-specific tools, items, or examples.
const REASONING_DEBUG_SUFFIX = `

# DEBUG MODE — REASONING + VALIDATION TRACE REQUIRED

This session is in debug mode. Every response — including responses where you call a tool — MUST begin with TWO debug paragraphs, in this exact order, BEFORE any narration:

[reasoning] one or two sentences naming (a) which tool you chose and the rationale, (b) for each argument, the EXACT verbatim substring of the player's most recent message that produced its value, in quotes. If you cannot quote a substring that justifies the value, the value is not sourced from the player — switch tools per Step 5 BEFORE emitting.

[validation] report the Step 5 self-check results for the call you are about to emit. Three checks: (1) tool sourced from player's literal words, (2) every argument value sourced from player's literal words (cite the quoted substring), (3) no inventory / scene context / genre / "obvious solution" priors. Each PASS or FAIL with a one-clause reason.

Format requirements:
- The "[reasoning]" prefix MUST be the first non-whitespace characters of your first text block.
- The [validation] paragraph follows immediately, separated by a single blank line.
- Player-facing narration (if any) follows after, separated by a blank line.
- Both prefixes are stripped from player output by the harness — the player never sees them. Write them like engineering notes, not story prose.
- Be ruthlessly honest in [validation]. The trace exists so the human can see your real decision process — never sanitize it.

Step 5 reminder (already in your standing rules above): if any check in [validation] would be FAIL, you MUST NOT emit that tool call. Pivot to a compliant alternative per Step 5 (no-args sibling or \`wait\`), re-run [reasoning] and [validation] for the new candidate, and only emit when every check is PASS. The only acceptable [validation] paragraph is one where every check reports PASS for the tool you actually called. A [validation] paragraph that pairs FAIL with an emitted tool call contradicts Step 5 — the harness flags it as a debug-mode failure. "FAIL but emitting anyway" is never an option.`;

const TOOLS: Tool[] = [
  {
    name: "look",
    description:
      "Look around the current room — get a fresh description from the engine. Use for 'look', 'l', 'look around', 'where am I', 'describe the room', 'what's here', 'what do I see', 'survey the area', or any other request for a current snapshot of surroundings. ALWAYS call this tool for those requests; never narrate the room from memory — triggers may have fired silently between turns and your prior context could be stale.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "examine",
    description:
      "Examine an item or passage closely. Use for 'examine X', 'x X', 'look at X', 'inspect X'. Pass the id (NOT the display name) of an item from the current view's itemsHere/inventory OR a passage (door, window, gate, archway, etc.) from the current view's passagesHere.",
    input_schema: {
      type: "object",
      properties: { itemId: { type: "string", description: "The id of the item or passage to examine, from the current view" } },
      required: ["itemId"],
    },
  },
  {
    name: "take",
    description: "Pick up an item. Use for 'take', 'get', 'grab', 'pick up'. Pass the item's id.",
    input_schema: {
      type: "object",
      properties: { itemId: { type: "string", description: "The item's id from the current view" } },
      required: ["itemId"],
    },
  },
  {
    name: "drop",
    description: "Drop an item from inventory onto the floor of the current room. Pass the item's id.",
    input_schema: {
      type: "object",
      properties: { itemId: { type: "string" } },
      required: ["itemId"],
    },
  },
  {
    name: "put",
    description:
      "Put an item from inventory INTO an accessible container (e.g. 'put coin in box', 'put scroll in chest'). Pass itemId (the thing you're placing) and targetId (the container's id from the current view).",
    input_schema: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "The id of the item being placed (must be in inventory)" },
        targetId: { type: "string", description: "The id of the destination container (must be visible and accessible — check itemsHere[*].container.accessible)" },
      },
      required: ["itemId", "targetId"],
    },
  },
  {
    name: "inventory",
    description: "List items the player is carrying.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "go",
    description:
      "Move in a direction. Pass a lowercase direction word like 'north', 'south', 'east', 'west', 'up', 'down', 'in', 'out'. Extract just the direction even if the player phrased it with additional nouns ('go down the stairs' → direction='down'; 'go up the chimney' → direction='up'; 'go through the door' → pick the direction whose exit references that door). The engine resolves the actual exit/passage from the direction.",
    input_schema: {
      type: "object",
      properties: { direction: { type: "string" } },
      required: ["direction"],
    },
  },
  {
    name: "wait",
    description:
      "Pass a turn without doing anything. Use when the player says 'wait', 'rest', 'pause', 'do nothing', 'listen', 'sleep', or otherwise wants time to pass without affecting state. The world still ticks forward (per-turn triggers fire — light sources may drain, NPCs may move, timers may advance, etc.) but no other player action runs.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "board",
    description:
      "Enter / get into / climb aboard / step into a vehicle (boat, raft, cart, mount, magic carpet, etc.). Use when the player says 'get in the boat', 'board the raft', 'climb in', 'mount the horse', 'step into the carriage'. Pass the itemId of the vehicle (must have a `vehicle` field in the view). The engine validates that the vehicle is enterable in its current state — e.g. an inflatable boat must be inflated first; a chariot might require a key. After boarding, the view will include a `vehicle: {...}` field; mobile vehicles travel with the player on `go(direction)`.",
    input_schema: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "The id of the vehicle to enter (from the view)" },
      },
      required: ["itemId"],
    },
  },
  {
    name: "disembark",
    description:
      "Exit / get out of / step out of / dismount the vehicle the player is currently inside. Use when the player says 'get out', 'step out of the boat', 'leave the cart', 'dismount'. No arguments — the engine knows which vehicle the player is in.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "attack",
    description:
      "Attack a target with an item — a weapon, an improvised tool, or anything else the player wants to use. Use whenever the player says 'attack X with Y', 'kill X with Y', 'fight X with Y', 'hit X with Y', 'swing Y at X', 'throw Y at X', 'shoot X with Y', etc. The engine fires the attack but does not compute damage or outcomes — story-defined triggers handle that. Pass an optional `mode` string describing HOW the weapon is used: 'swing', 'throw', 'stab', 'shoot', 'crush', etc. Authors gate triggers on the mode so the same weapon can produce different outcomes (throwing an axe vs swinging it). Pick the mode that matches the player's verb. Omit mode for a generic 'default' attack.",
    input_schema: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "The id of the item being used to attack (the weapon)" },
        targetId: { type: "string", description: "The id of the thing being attacked" },
        mode: { type: "string", description: "Optional: how the weapon is being used. Author-defined strings like 'swing', 'throw', 'stab', 'shoot'. Omit for default attack." },
      },
      required: ["itemId", "targetId"],
    },
  },
];

// Set of built-in tool names — used by toolToAction to distinguish built-in
// dispatches from author-defined custom tool calls.
const BUILT_IN_TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

// Mark the cache breakpoint at the end of the built-ins. The DirectAnthropic
// client converts this to cache_control on the corresponding tool. This stays
// frozen across turns (built-ins never change), so the prefix up to here
// caches permanently for the session.
TOOLS[TOOLS.length - 1].cacheBreakpoint = true;

const STYLE_INSTRUCTIONS = `You are the narrator of an interactive text adventure.

<mission>
Your two jobs each turn:
1. Translate the player's natural-language command into one or more tool calls.
2. After tools return, write a brief vivid narration of what happened.
Tools include engine built-ins (look, examine, take, drop, put, inventory, go, wait, attack, board, disembark) AND story-defined verbs (open, close, push, turn, give, light, ring, read, etc.). The engine is the only authority on world state; you translate input into tool calls and narrate from results. Your priors and genre-trivia memory are NOT authoritative.
</mission>

<process>
Follow these steps in order, every turn. Step 5 is the final gate before any tool_use is emitted.

<step n="1" name="Read the player's input">
- Be charitable about typos, abbreviations, partial names, and casual phrasing. Players type fast. Examples that should ALL just work without clarification: "examime" / "x" / "look at" → \`examine\`; "n" / "head north" → \`go(north)\`; "i" / "inv" → \`inventory\`; "yes" right after you offered an action → execute that action.
- Identify the player's intent and the literal nouns / verbs in their message. The literal text is the only authoritative source for argument values in Step 4.
- Conversational filler ("hi", "thanks", "ok", "hmm") that doesn't request a world change → call \`wait\` (the safe no-op that ticks the world). Engine state advancement is non-negotiable per turn.
- Only ask for clarification when the input is GENUINELY ambiguous (e.g. "take the key" with two distinct keys in view). Never ask the player to retype for spelling or grammar.
</step>

<step n="2" name="Find ids in the current view">
- The view JSON is in your conversation history — either in a \`[Current view]\` block on the latest user message, or in the most recent state-mutating \`tool_result\`. A \`[Current view]\` block in the latest user message is authoritative ground truth — reconcile narration with it (if the player was force-moved, narrate from the new room; don't keep refusing actions in the old one).
- Resolve player phrasing to view ids by partial-name match, tag, description hint, or context. "platinum" matches \`{id:"platinum-bar", name:"platinum bar"}\`. "the door" matches the only door in \`passagesHere\`.
- Items and passages share one id namespace. \`examine\` accepts either; \`take\`, \`drop\`, and \`put\` work on items only.
- Pass IDs (not display names) to tools. Find them in \`itemsHere\`, \`passagesHere\`, or \`inventory\`.
- Engine identifiers are internal — NEVER speak them to the player. The player sees the \`name\` field. If you find yourself about to type a lowercase-hyphenated string in player-facing prose, rewrite it as natural English first. Same for engine internals like "trigger fired" / "tool_result".
- If genuinely nothing in the view matches, narrate "you don't see X here" in story voice and skip to Step 7.
</step>

<step n="3" name="Pick the tool">
- Default to action: the matching tool is your first move. If the player asks for any concrete action, CALL the matching tool. Even when you're 90% sure the action will fail, call the tool anyway — the engine returns ground truth, your priors do not.
- "Truly impossible" means "no tool maps to this intent" — NOT "this might fail." Most player actions might fail; the engine handles failure cleanly via \`rejected\` events, missing-trigger no-ops, or precondition failures with cues. Reserve prose-refusal for genuinely unmapped intents (e.g. "fly to the moon"); see \`<critical_invariants>\` on never breaking the fourth wall.
- Pattern shortcuts:
  - "look" / "where am I" / "describe the room" / "what's here" → \`look\`. Always re-query; triggers may have fired silently between turns and prior narration could be stale.
  - "examine X" / "x X" / "look at X" / "inspect X" → \`examine(itemId)\`. Always re-query; items change state turn over turn.
  - "put X in inventory" / "stash X" / "pocket X" → \`take(X)\`. Inventory is not a container.
  - Movement with extra nouns ("go down the stairs", "climb the ladder", "enter the kitchen", "head out the window") → extract direction or destination, call \`go(direction)\`. The room's \`exits\` list is the source of truth — don't refuse a movement just because the player named scenery.
  - Vehicles (item has \`vehicle\` field): "get in the boat" / "board" / "mount" → \`board(itemId)\`. "get out" / "disembark" / "dismount" → \`disembark()\`. While inside a vehicle, the view's top-level \`vehicle\` field is present — narrate "you are in the {vehicle.name}, on the {room.name}".
  - Combat: "attack X with Y", "swing Y at X", "throw Y at X", "kill X with Y" → \`attack(itemId, targetId, mode?)\`. Pick \`mode\` from the player's verb (swing/throw/stab/shoot/...) or omit for default. Authors gate triggers on mode.
  - Compound commands ("take the key and put it in the bag") → call each tool in sequence; if any step is rejected, STOP the chain.
  - Glimpse passages (passage has \`glimpse\` field): "look through" / "peek through" → narrate from the glimpse without calling \`go\`. If no glimpse field, looking through is impossible; say so in story voice.
</step>

<step n="4" name="Pick the arguments">
- Argument values come ONLY from the player's literal words. Never from inventory, scene context, world-knowledge, prior turns' state, your reasoning, or "the obvious puzzle solution."
- **Quote-the-input requirement**: for every argument value, you must be able to point to the exact substring of the player's most recent message that produced it. If you cannot quote that substring, the value is not sourced from the player.
- **Missing-value fallback**: if a tool requires an argument the player didn't literally name, do NOT fabricate it. Pick a tool variant that doesn't require it (typically a no-args sibling tool). If no such variant exists, call \`wait\` rather than guessing.
- IDs (not display names): once you have a value, resolve it to an id from the view per Step 2.
</step>

<step n="5" name="Self-check — FINAL GATE before emit">
Before you emit a tool_use, walk this checklist. Every check must report PASS.

1. **Tool sourcing**: did I pick the tool from the player's literal words, not from my own reasoning about what would solve the puzzle?
2. **Argument sourcing**: for each argument, can I quote the exact substring of the player's message that produced it?
3. **No priors**: did inventory contents, scene context, world-knowledge, genre knowledge, or "the obvious solution" influence the call?
   (Compliant answers: 1=player's words; 2=yes for every arg; 3=no.)

On any FAIL: GOTO Step 3 with a different tool candidate. Pick the no-args sibling, or \`wait\`, then re-run Steps 4 and 5. Only emit when every check is PASS.

There is no acceptable form of "I know this fails the check, but the answer is obvious so I'll emit it anyway." Catching yourself about to violate a rule is the cue to PIVOT, not to add a justification and proceed. A correct refusal to fabricate beats a confident wrong tool call.
</step>

<step n="6" name="Emit and execute">
Emit the tool_use(s). Once emitted, a tool_use commits engine state — it cannot be retracted. The engine returns the result (success / rejection-with-reason / narration cues) plus the post-action view.
</step>

<step n="7" name="Narrate from the result">
- Weave \`narrationCues\` from the tool result into prose — they ARE state changes the player should notice.
- Preserve \`event.description\` state signals when embellishing. The engine's wording carries puzzle hints (a sword "glowing with a faint blue glow" warns of nearby hostiles; a door "slightly ajar" is in a particular state; a leaflet "wet and barely legible" has been dunked). Set mood freely; never drop or rewrite the state cues.
- For \`event.type === "rejected"\`: narrate a short refusal fitting the rejection reason (use the engine's \`reason\` and \`message\` if provided). Player STAYS where they are. Do not describe them moving, taking, or otherwise acting on the world.
- Use \`appearance\` (room-presence) and \`description\` (examine text) fields from the view as your canonical text — embellish around them, don't contradict. \`appearance\` is per-turn variant-resolved by the engine; \`description\` appears for items the player has previously examined.
- \`narratorNote\` on items / rooms / passages is engine-side guidance for YOU — NEVER quote it, paraphrase it as visible prose, or surface that it exists. Internalize and let it shape prose silently. Different from \`personality\` (NPC voice) and \`description\` (canonical prose to weave in).
- \`personality\` on an item is its voice. Embody it; don't describe it. Free-form dialogue with NPCs that have no matching story tool can be narrated in prose; if a verb tool matches the conversational intent, call it first so triggers can fire.
- Style: second person, present tense ("You see…"). Match the story's tone. Be vivid but concise — usually 1-3 sentences. After a multi-step compound command, write ONE coherent narration of the whole sequence, not a paragraph per step.
- Stay in NPC voice across long sessions when the player is mid-conversation with a named NPC. Re-anchor on the NPC's \`personality\` field at the start of each response so voices don't drift.
</step>
</process>

<rules_scope_view>
The view's structure is the source of truth for what the player perceives. It is filtered by the engine for visibility / accessibility / darkness — never narrate items, rooms, exits, or passages that aren't in the view.

- Items in \`itemsHere\` and \`inventory\` carry typed \`state\` (e.g. \`{isOpen:true}\`, \`{broken:false}\`, \`{isLit:true}\`). State only mutates through tools and triggers. If you narrate that something turned, opened, broke, lit, rang, etc. without first calling the corresponding tool, your prose contradicts the next view.
- Containers (items with \`container\` field) gate access via \`accessible: true|false\`. Failed \`put\` on inaccessible container returns rejection with the author's \`accessBlockedMessage\`.
- Passages (\`passagesHere\`) connect two rooms; some are gated by \`traversableWhen\`. Failed traversal returns rejection (reason "traverse-blocked") with the passage's message. A passage's \`glimpse\` (when see-through and active) carries the other room's name + description.
- Exits (\`exits\` array) carry \`{direction, target, blocked?, blockedMessage?}\`. \`blocked\` absent or false → direction is OPEN; call \`go(direction)\` without hesitation, ignoring stale "way is blocked" prose from earlier turns. \`blocked: true\` → narrate the \`blockedMessage\` (one-turn refusal, NO tool call — the engine has already authoritatively said no).
- Score, vehicle, finished fields appear when applicable.
</rules_scope_view>

<critical_invariants>
These hold across all steps and override all other guidance on conflict.

- **Never narrate state changes the engine didn't return.** If you narrate that something turned, opened, broke, lit, rang, etc. without first calling the matching tool, the engine state stays the same and your prose becomes a lie the next view will contradict.
- **Never invent items, rooms, exits, passages, barriers, closures, restrictions, or plot points** beyond what the view shows. Atmospheric flourishes are fine ("the cavern feels colder now"); state-changing flourishes are not ("the way back is barred" when the engine has it open; "the door slams shut"; "the candles flicker out" without a cue).
- **Never break the fourth wall when refusing.** Forbidden phrasings: "the game doesn't have an action for that", "I don't have a tool for that", "that action isn't supported", "no command exists", "the game won't let you do that". Replace with non-state-changing in-world reasons in the room's tone ("the air carries only damp stone", "your voice falls flat against the cavern walls", "you're not strong enough", "nothing happens — you can't see how that would help here"). The player should never be reminded they're talking to a machine.
- **You are the narrator, not the player's conscience.** Translate intent — don't moralize. When the player commands "attack", "kill", "destroy", or any other action against any target (including unconscious / defenseless ones), call the matching tool. Don't insert "you hesitate", "you cannot bring yourself", or "something stays your hand". The player's character has agency; your job is to translate intent into a tool call.
- **On Step 5 FAIL: switch tools, never emit the failing call.** "FAIL but emitting anyway because [the answer is obvious / context suggests / prior knowledge says]" is forbidden. The only correct response on detected violation is to choose differently before emitting. This rule overrides "default to action": Step 3 says "always call a tool"; Step 5 redirects WHICH tool. Switching to a no-args sibling or \`wait\` still satisfies "call a tool".
- **Never refuse a tool-mapped command via narrative reasoning.** If the player's intent maps to a tool, CALL THAT TOOL — don't pre-decide "this won't work" based on how the world has been described. Forbidden refusals (without first calling the matching tool):
  - take: "it's fixed in place" / "fastened down" / "too heavy" / "decorative" / "part of the room"
  - drop: "you'd never want to drop that" / "it's too valuable"
  - go: "the way is blocked" (unless \`exits.blocked: true\` in CURRENT view) / "no exit there" (unless absent from \`exits\`) / "no reason to go back"
  - open / close / push / turn / pull: "it's locked" / "doesn't budge" / "stuck" / "you don't have the right tool" / "nothing happens"
  - attack: "too tough" / "can't bring yourself to" / "bounce off" / "already dead"
  - custom verbs (light, ring, give, climb, dig, wave, say, rub, etc.): "no way to" / "wouldn't work here" / "already tried" / "nothing to apply this to"
  Pattern: call the tool first; let the engine answer; narrate from THAT. The engine returns success / rejection / cue / empty (contextual no-op) — narrate accordingly.
</critical_invariants>

<tool_sourcing_examples>
Generic illustrations of correct Step 4 + Step 5 sourcing, story-agnostic. The names of tools, items, and verbs in these examples are placeholders — substitute the equivalents from your current story's tools list.

<example name="paired tool, player named the tool">
Imagine the story exposes a paired pattern: tool-A takes an argument naming the tool used; tool-B is the no-args sibling for bare-handed attempts.

Player: "operate the device with the helper"
Step 4 sourcing: "device" and "helper" are quotable from player's input.
Step 5 self-check: tool from words PASS, every arg quotable PASS, no priors PASS.
Decision: call tool-A with the player-named helper. Compliant.
</example>

<example name="paired tool, player did NOT name a tool">
Same paired pattern as above.

Player: "operate the device"
Step 4 sourcing: target ("device") is quotable; no tool name appears in the input.
Step 5 self-check: argument sourcing FAIL on the missing tool-arg → GOTO Step 3.
Step 3 (re-pick): the no-args sibling tool-B fits the same target.
Step 4 (re-source): no args needed.
Step 5 (re-check): all PASS.
Decision: call tool-B (no-args sibling). Compliant.
</example>

<example name="player named a body part; inventory holds something tempting">
Same paired pattern; the player happens to carry an item that genre-knowledge says is "the obvious solution."

Player: "use my elbow on the device"
Step 4 sourcing: "elbow" is named (body part, not an item id); "device" is named.
Step 5 self-check: tool sourcing FAIL if I auto-fill the inventory item (not in the player's words; inventory is a forbidden source) → GOTO Step 3.
Step 3 (re-pick): no-args sibling tool-B for the bare-handed attempt.
Decision: call tool-B. Compliant.

NOT compliant: calling tool-A with the inventory item because "the player has it and it's the obvious solution." That auto-fills from inventory + priors and violates Step 5 checks 2 and 3.
</example>

<forbidden_shape>
Reasoning that says "the player didn't name the tool, but X is in inventory and X is the obvious solution, so I'll pass X anyway" is FORBIDDEN. So is any internal validation that pairs FAIL with an emitted tool call. The shape "FAIL — but emitting because [justification]" is never compliant. Switch tools first; emit second.
</forbidden_shape>
</tool_sourcing_examples>`;

export interface NarrationTurn {
  // The narration text to show the player.
  text: string;
  // The engine result, if a tool was executed. null if Claude responded with text only.
  engineResult: EngineResult | null;
  // Errors during the LLM round-trip. The engine result, if present, is still valid.
  error?: string;
}

export class Narrator {
  private engine: Engine;
  private client: LLMClient;
  private history: Message[];
  // Sliding window of past turns kept in `history`. Two messages per turn (user
  // command + assistant reply) plus tool_use/tool_result pairs in between.
  private maxHistoryMessages: number;
  // Fingerprint of the most recent world view the LLM has actually seen in
  // its conversation history (via either a [Current view] block in the user
  // message or a tool_result with view embedded). Per-turn user-message
  // construction compares the current view's fingerprint to this value;
  // only includes the [Current view] block when they differ. Keeps the LLM
  // in sync with state changes that happen without a tool call (wait
  // fallback ticks, NPC autonomy, drain countdowns, etc.) without re-sending
  // the view every turn.
  private lastViewSent: string | null = null;

  constructor(opts: {
    engine: Engine;
    client: LLMClient;
    maxHistoryMessages?: number;
    initialHistory?: Message[];
  }) {
    this.engine = opts.engine;
    this.client = opts.client;
    // Sanitize on load: a saved history may contain orphan tool_use blocks
    // (e.g. a previous turn errored mid-round-trip and the bad messages got
    // saved). Truncate to the last consistent prefix so the next API call is
    // valid even when the disk save is corrupt.
    this.history = sanitizeHistory(opts.initialHistory ? [...opts.initialHistory] : []);
    // Bumped to 100 from 30→50 because the §1-§4 cache-shrink optimizations
    // dropped per-turn content so much that a 100-message history is still
    // small (~10K tokens). Higher cap means we trim less often, which matters
    // because trimming invalidates Anthropic's prompt cache (see trimHistory).
    this.maxHistoryMessages = opts.maxHistoryMessages ?? 100;
  }

  // Snapshot of the current message history (for persistence). Returns a copy
  // so callers can't mutate Narrator internals.
  getHistory(): Message[] {
    return [...this.history];
  }

  // Stable string fingerprint of a view, used as the cache key for
  // deciding when the LLM needs a fresh [Current view] block. JSON.stringify
  // on the compactView shape produces deterministic output (object key order
  // is insertion-order in V8) — same view, same fingerprint.
  private viewKey(view: WorldView): string {
    return JSON.stringify(compactView(view));
  }

  async narrate(playerInput: string): Promise<NarrationTurn> {
    const story = this.engine.story;

    // Snapshot history length BEFORE we push anything for this turn. If the
    // LLM round-trip throws partway through, we roll back to here so orphan
    // tool_use blocks don't poison future turns or get persisted to save.
    const historyLengthBeforeTurn = this.history.length;

    // Per-turn tool list: built-ins (cache-stable) + always-on customs
    // (cache-stable for this story) + conditional customs (cache while set
    // is byte-stable across turns).
    const tools = buildPerTurnTools(this.engine.state, story);

    // Debug: log the dynamic part each turn so it's visible at play time.
    const conditionalCustoms = tools.filter((t) =>
      !BUILT_IN_TOOL_NAMES.has(t.name) && !alwaysOnCustomTools(story).some((a) => a.id === t.name),
    );
    if (conditionalCustoms.length > 0) {
      debugLog(
        "tools",
        `[tools] ${conditionalCustoms.length} dynamic intent tool(s) injected:`,
        conditionalCustoms.map((t) => t.name).join(", "),
      );
    }

    // The view JSON is included in the user message ONLY when state has
    // changed since the LLM last saw the view. lastViewSent is a fingerprint
    // of the most recent view that's in the LLM's conversation history (via
    // either an earlier [Current view] block or a state-mutating tool_result
    // with view embedded). If the current view's fingerprint matches, the
    // LLM already has it — skip. If it differs (first turn ever; or off-screen
    // state change since last response), include the block so the LLM sees
    // ground truth. STYLE_INSTRUCTIONS tells the LLM to treat a [Current view]
    // block as authoritative — reconcile narration with it.
    const currentView = this.engine.getView();
    const currentViewKey = this.viewKey(currentView);
    const viewBlock =
      currentViewKey !== this.lastViewSent
        ? `\n\n[Current view]\n${formatView(currentView)}`
        : "";
    if (viewBlock) {
      this.lastViewSent = currentViewKey;
    }

    const userMessage: Message = {
      role: "user",
      content: `[Player command] ${playerInput}${viewBlock}`,
    };
    this.history.push(userMessage);

    let engineResult: EngineResult | null = null;
    let finalText = "";
    const system = buildSystemPrompt(story);

    try {
      // Tool-use round-trip cap. Most turns use 2–3 (action + narration). Bumped
      // to 10 to accommodate compound commands ("take X and put it in Y and
      // close Z") chaining multiple verb tools.
      const MAX_ROUND_TRIPS = 10;
      for (let i = 0; i < MAX_ROUND_TRIPS; i++) {
        // Phase 1 = the round-trip immediately after the player's user msg
        // (before any tool_results are in history for this turn). On Phase 1
        // we force tool_choice: "any" so the model must call a tool — kills
        // the "hallucinated text-only refusal" failure mode that was leaving
        // engine state stuck. Phase 2+ uses default "auto" so the LLM can
        // finish with text-only narration after seeing tool results.
        const isPhase1 = this.history.length === historyLengthBeforeTurn + 1;
        const response = await this.client.send({
          system,
          messages: this.history,
          tools,
          maxTokens: 1024,
          ...(isPhase1 && { toolChoice: { type: "any" } }),
        });

        // Append the assistant turn to history.
        this.history.push({ role: "assistant", content: response.content });

        // Claude may issue MULTIPLE tool_use blocks in one response (compound
        // commands like "open the window and go in"). Anthropic requires every
        // tool_use to have a matching tool_result in the next user message —
        // missing any one causes the next request to fail. So we execute all
        // tool_use blocks in order and batch all results into one user message.
        const toolUses = response.content.filter(
          (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use",
        );

        if (toolUses.length > 0) {
          const toolResults: ContentBlock[] = [];
          for (const toolUse of toolUses) {
            const action = toolToAction(toolUse);
            if (!action) {
              console.warn(`[tool] ${toolUse.name}`, toolUse.input, "→ UNKNOWN TOOL");
              toolResults.push({
                type: "tool_result",
                tool_use_id: toolUse.id,
                content: `Unknown tool: ${toolUse.name}`,
                is_error: true,
              });
              continue;
            }
            engineResult = this.engine.execute(action);
            const reason = engineResult.ok
              ? ""
              : ` (${(engineResult.event as { reason?: string }).reason ?? "?"})`;
            const cues = engineResult.narrationCues.length
              ? ` cues=${JSON.stringify(engineResult.narrationCues)}`
              : "";
            console.log(
              `[tool] ${toolUse.name}`,
              toolUse.input,
              `→ ${engineResult.event.type}${reason}${cues}`,
            );
            toolResults.push({
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: formatToolResult(engineResult),
            });
            // Every tool_result carries the post-action view (see
            // formatToolResult comment), so the LLM has now seen this state.
            // Update the fingerprint so the next user-msg only includes a
            // [Current view] block when something has drifted since.
            this.lastViewSent = this.viewKey(engineResult.view);
          }
          this.history.push({ role: "user", content: toolResults });
          continue;
        }

        // No tool_use in this response — text-only. Phase 1 forces
        // tool_choice: "any", so on Anthropic-backed sessions the LLM cannot
        // return text-only at i=0 — that path is structurally unreachable.
        // We still hit this branch for:
        //   A. engineResult !== null (the common case): a tool ran in an
        //      earlier round-trip and this is the trailing narration response
        //      (loop sent tool_results back, got prose, done). Do NOT tick
        //      again — the tool action already advanced the world.
        //   B. engineResult === null (defensive): if a non-Anthropic backend
        //      (e.g. Ollama, which doesn't yet honor tool_choice) returns
        //      text-only on Phase 1, fire a wait tick so engine state still
        //      advances. Canonical Zork ticks on any player input; this
        //      preserves that invariant on backends without forced-tool
        //      support. With Anthropic this branch should never fire in
        //      normal play — its presence is a regression signal.
        finalText = collectText(response);
        if (engineResult === null) {
          console.log(`[tool] (no tool call — text-only response; firing wait fallback)`);
          const waitResult = this.engine.execute({ type: "wait" });
          engineResult = waitResult;
          if (waitResult.narrationCues.length > 0) {
            const cuesText = waitResult.narrationCues.join("\n");
            finalText = finalText ? `${finalText}\n\n${cuesText}` : cuesText;
          }
        }
        break;
      }

      if (!finalText) {
        finalText = "(narrator returned no text)";
      }

      this.trimHistory();
      return { text: finalText, engineResult };
    } catch (err) {
      // Roll back any partial messages pushed during this turn so the next
      // call sees a consistent history (no orphan tool_use without
      // tool_result). Engine state mutations are NOT rolled back — actions
      // that succeeded before the round-trip failed are real and persistent.
      this.history.length = historyLengthBeforeTurn;
      const message = err instanceof LLMError ? err.message : err instanceof Error ? err.message : String(err);
      return {
        text: engineResult
          ? `[narration failed: ${message}]`
          : `[error: ${message}]`,
        engineResult,
        error: message,
      };
    }
  }

  reset(): void {
    this.history = [];
  }

  // Replace the entire conversation history wholesale. Used when loading a
  // save slot mid-session. Sanitized to drop orphan tool_uses for the same
  // reason the constructor does — a snapshot might end mid tool round-trip.
  replaceHistory(messages: Message[]): void {
    this.history = sanitizeHistory([...messages]);
  }

  // Trim only when SIGNIFICANTLY over the cap, and trim a BIG CHUNK at once.
  // Why: Anthropic's prompt cache is keyed by exact byte prefix. Dropping any
  // message off the front of the history shifts all subsequent byte offsets,
  // invalidating the entire cached message-prefix on the next request. The old
  // implementation trimmed 1-3 messages every turn once over the cap → cache
  // invalidated EVERY TURN → ~5× cost regression. Trimming in chunks of 30
  // pays the cache cost once per ~30 turns instead.
  //
  // Drop snaps to a clean turn boundary so we never strand a tool_result
  // without its corresponding tool_use (which Anthropic rejects as malformed).
  private trimHistory(): void {
    const TRIM_CHUNK = 30;
    if (this.history.length < this.maxHistoryMessages + TRIM_CHUNK) return;

    const before = this.history.length;
    let trimmed = this.history.slice(TRIM_CHUNK);
    while (trimmed.length > 0 && !isCleanUserTurnStart(trimmed[0])) {
      trimmed = trimmed.slice(1);
    }
    this.history = trimmed;
    console.log(
      `[narrator] history trim: ${before} → ${trimmed.length} messages (drop ${
        before - trimmed.length
      }). Prompt cache will reset on next request — expected.`,
    );
  }
}

// A "clean" user message marks the start of a turn — pure text from the
// player, no tool_result blocks referencing any prior tool_use.
function isCleanUserTurnStart(m: Message): boolean {
  if (m.role !== "user") return false;
  if (typeof m.content === "string") return true;
  return !m.content.some((b) => b.type === "tool_result");
}

// Truncate the history to the longest prefix that is internally consistent —
// every assistant tool_use block has a matching tool_result in the next user
// message. Used at narrator construction to recover from corrupt saves
// (e.g. a previous session crashed mid-round-trip and persisted bad data).
function sanitizeHistory(history: Message[]): Message[] {
  let lastConsistentLen = 0;
  for (let i = 1; i <= history.length; i++) {
    if (isHistoryConsistent(history.slice(0, i))) {
      lastConsistentLen = i;
    }
  }
  return history.slice(0, lastConsistentLen);
}

function isHistoryConsistent(history: Message[]): boolean {
  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    if (msg.role !== "assistant" || typeof msg.content === "string") continue;
    const toolUses = msg.content.filter(
      (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use",
    );
    if (toolUses.length === 0) continue;
    // Next message must be a user message containing matching tool_result blocks.
    const next = history[i + 1];
    if (!next || next.role !== "user" || typeof next.content === "string") return false;
    const resultIds = new Set(
      next.content
        .filter((b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result")
        .map((b) => b.tool_use_id),
    );
    for (const tu of toolUses) {
      if (!resultIds.has(tu.id)) return false;
    }
  }
  return true;
}

function buildSystemPrompt(story: Story): string {
  const parts = [STYLE_INSTRUCTIONS, "", `Story: "${story.title}" by ${story.author}.`];
  if (story.description) parts.push("", story.description);
  if (story.systemPromptOverride) parts.push("", story.systemPromptOverride);
  if (isDebugEnabled("thinking")) parts.push(REASONING_DEBUG_SUFFIX);

  return parts.join("\n");
}

// Build the per-turn tools[] array. Layout:
//   [...built-ins (cache marker on last), ...always-on customs (cache marker
//    on last when present), ...sorted conditional customs (cache marker on
//    last when present)]
//
// Cache prefix matching is byte-exact, so we sort the conditional customs
// alphabetically to keep the same set producing the same byte sequence
// across turns.
function buildPerTurnTools(state: import("../engine/engine").Engine["state"], story: Story): Tool[] {
  const out: Tool[] = TOOLS.map((t, i) => ({
    ...t,
    // The TOOLS const carries cacheBreakpoint=true on the last entry. Strip
    // it from non-last entries when always-on customs are present (the
    // breakpoint moves to the end of THAT block instead).
    cacheBreakpoint: undefined,
    ...(i === TOOLS.length - 1 && { cacheBreakpoint: true }),
  }));

  const alwaysOn = alwaysOnCustomTools(story);
  if (alwaysOn.length > 0) {
    // Move the breakpoint to the end of the always-on block.
    out[out.length - 1].cacheBreakpoint = undefined;
    const alwaysOnTools = alwaysOn.map(customToTool);
    alwaysOnTools[alwaysOnTools.length - 1].cacheBreakpoint = true;
    out.push(...alwaysOnTools);
  }

  const conditional = activeConditionalCustomTools(state, story);
  if (conditional.length > 0) {
    const sorted = [...conditional].sort((a, b) => a.id.localeCompare(b.id));
    const conditionalTools = sorted.map(customToTool);
    conditionalTools[conditionalTools.length - 1].cacheBreakpoint = true;
    out.push(...conditionalTools);
  }

  return out;
}

function customToTool(c: CustomTool): Tool {
  return {
    name: c.id,
    description: c.description,
    input_schema: c.args ?? { type: "object", properties: {}, required: [] },
  };
}

// Reshape the WorldView into the JSON-shaped structure we serialize for the
// LLM. Single source of truth so formatView and formatToolResult stay in sync.
function compactView(view: WorldView) {
  return {
    room: view.room,
    itemsHere: view.itemsHere,
    passagesHere: view.passagesHere,
    exits: view.exits.map((e) => ({
      direction: e.direction,
      target: e.targetRoomName,
      ...(e.passageId && { passage: e.passageId }),
      ...(e.blocked && { blocked: true }),
      ...(e.blockedMessage && { blockedMessage: e.blockedMessage }),
    })),
    inventory: view.inventory,
  };
}

function formatView(view: WorldView): string {
  // Minified: pretty-printing the JSON inflates token count by ~25-30% with
  // no LLM benefit (Claude/Qwen parse minified JSON identically).
  return JSON.stringify(compactView(view));
}

// Every tool_result carries the post-action view. Earlier we tried to
// skip view inclusion for "non-state-changing" event types (examine,
// inventory, intent-recorded), reasoning that state hadn't moved. But
// triggers can fire from ANY action's cascade — a customTool that records
// an intent may consume a trigger that flips a flag, moves an item, or
// unblocks an exit. If we omit the view from the tool_result, the LLM's
// narration round runs on stale state and may refuse a now-valid follow-up
// (e.g. tying a rope unblocks the down exit, but the next "go down" gets
// refused because the LLM never saw the post-trigger view). Always
// returning the view kills that bug class. The token cost is small; the
// view changes only when state changes, so the prompt cache stays warm
// across turns whose state was identical.
function formatToolResult(result: EngineResult): string {
  return JSON.stringify({
    ok: result.ok,
    event: result.event,
    view: compactView(result.view),
    narrationCues: result.narrationCues,
    ...(result.ended && { ended: result.ended }),
  });
}

function toolToAction(
  tu: Extract<ContentBlock, { type: "tool_use" }>,
): ActionRequest | null {
  const input = tu.input ?? {};
  switch (tu.name) {
    case "look":
      return { type: "look" };
    case "examine":
      return inputId(input) ? { type: "examine", itemId: inputId(input)! } : null;
    case "take":
      return inputId(input) ? { type: "take", itemId: inputId(input)! } : null;
    case "drop":
      return inputId(input) ? { type: "drop", itemId: inputId(input)! } : null;
    case "put":
      return inputId(input) && typeof input.targetId === "string"
        ? { type: "put", itemId: inputId(input)!, targetId: input.targetId }
        : null;
    case "inventory":
      return { type: "inventory" };
    case "go":
      return typeof input.direction === "string"
        ? { type: "go", direction: input.direction }
        : null;
    case "wait":
      return { type: "wait" };
    case "attack":
      return inputId(input) && typeof input.targetId === "string"
        ? {
            type: "attack",
            itemId: inputId(input)!,
            targetId: input.targetId,
            ...(typeof input.mode === "string" && { mode: input.mode }),
          }
        : null;
    case "board":
      return inputId(input) ? { type: "board", itemId: inputId(input)! } : null;
    case "disembark":
      return { type: "disembark" };
    default:
      // Unknown tool name → assume it's an author-defined CustomTool. Dispatch
      // as a recordIntent with the call args. The engine validates that the
      // signalId references a known custom tool and runs its handler. Any
      // Atom-typed args are passed through; the rest are dropped.
      return {
        type: "recordIntent",
        signalId: tu.name,
        args: extractAtomArgs(input),
      };
  }
}

function extractAtomArgs(input: Record<string, unknown>): Record<string, import("../story/schema").Atom> {
  const out: Record<string, import("../story/schema").Atom> = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    }
  }
  return out;
}

function inputId(input: Record<string, unknown>): string | null {
  return typeof input.itemId === "string" ? input.itemId : null;
}

function collectText(msg: AssistantMessage): string {
  return msg.content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => stripDebugPrefix(b.text))
    .filter((t) => t.length > 0)
    .join("\n")
    .trim();
}

// Strip leading "[reasoning] …" and "[validation] …" paragraphs from a text
// block, keeping any narration that follows. The model often combines its
// debug-mode reasoning trace and the player-facing narration into a single
// text block; this preserves the narration while dropping the debug prefix.
// When the thinking flag is off the model doesn't emit these markers and the
// function is effectively a pass-through.
function stripDebugPrefix(text: string): string {
  const trimmed = text.trimStart();
  const lower = trimmed.toLowerCase();
  if (!lower.startsWith("[reasoning]") && !lower.startsWith("[validation]")) {
    return text;
  }
  // Repeatedly drop leading paragraphs that begin with a debug tag. A
  // "paragraph" ends at the first blank line. If the entire block is debug
  // content with no narration after, return empty.
  let remaining = trimmed;
  while (true) {
    const head = remaining.trimStart().toLowerCase();
    if (!head.startsWith("[reasoning]") && !head.startsWith("[validation]")) break;
    const blankIdx = remaining.search(/\n\s*\n/);
    if (blankIdx === -1) return "";
    remaining = remaining.slice(blankIdx).trimStart();
  }
  return remaining;
}
