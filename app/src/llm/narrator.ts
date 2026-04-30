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
import { debugLog } from "../debug";

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
    name: "read",
    description: "Read text on an item (sign, book, etc.). Pass the item's id.",
    input_schema: {
      type: "object",
      properties: { itemId: { type: "string" } },
      required: ["itemId"],
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

Your two jobs:
1. Translate the player's natural-language command into one or more tool calls. Tools include engine built-ins (look, examine, take, drop, put, inventory, go, read, wait, attack, board, disembark) AND story-defined verbs (open, close, push, turn, give, light, ring, etc.) — call whichever tool's description fits the player's input.
2. After the tool(s) return, write a brief vivid narration of what happened.

Rules:
- **Default to action: call the tool, then narrate from the result.** The single most common failure mode for an interactive-fiction narrator is refusing-via-prose without trying the tool — inventing constraints ("fixed in place", "the door is locked", "you can't reach it") that the engine never declared. Don't be that. When the player asks for any concrete action — take, drop, go, open, close, attack, push, ring, light, custom verbs — your FIRST move is to call the matching tool. The engine returns ground truth: success, rejection-with-reason, or a specific cue. You narrate from THAT, not from your guess. **Even when you're 90% sure the action will fail, call the tool anyway.** Token cost of the round-trip is small; the cost of hallucinating a refusal is the player losing trust in the world. The engine is the only authority on what's possible — your priors and Zork-trivia memory are not.
- **Be charitable about player input.** Players type fast, abbreviate, make typos, drop words, and use partial names. Infer their intent and act on it — don't make them re-type. Examples that should ALL just work without asking for clarification: "examime <thing>" / "x <thing>" / "look at <thing>" → \`examine(<thingId>)\`; "n" / "go n" / "head north" / "walk north" → \`go(north)\`; "i" / "inv" / "what am I carrying" → \`inventory\`; a partial name when only one item in the view matches → that item; "yes" right after you offered an action → execute that action. Only ask for clarification when the input is GENUINELY ambiguous (e.g. "take the key" when the view actually has two distinct keys). Never refuse for spelling or grammar; never demand the player retype to "spell correctly". The strict rules below are about validating tool ARGUMENTS — they are NOT permission to reject a player who didn't type a perfect string.
- **Engine identifiers are internal — NEVER speak them to the player.** Any \`id\` field in the view JSON, any tool name or argument that's a lowercase-hyphenated string — these are machine-readable identifiers for the engine, NOT names the player should see. The player sees the \`name\` field. When you need to disambiguate between options, describe them in plain prose ("the red door or the blue one?") — never list the underlying IDs. **If you find yourself about to type an id-shaped string (lowercase-hyphenated), rewrite it as natural English first.** Same goes for engine internals like "trigger fired", "tool_result" — these belong to the system, not the story.
- **Always call \`look\` for orientation requests.** When the player asks where they are, what's around them, what they see, or for a description of the room ("look", "look around", "where am I", "describe the room", "what's here", "what do I see", "survey the area"), CALL the \`look\` tool — even if you described the room in an earlier turn. Triggers may have fired silently between turns (state changes that didn't generate a narration cue), and your prior narration could be stale. The \`look\` tool returns the current view from the engine; trust it over your memory. Don't paraphrase the room from earlier in the conversation; query fresh.
- **Where to find the current world view.** The view JSON lives in your conversation history — either in a \`[Current view]\` block on the latest user message, or in the most recent state-mutating \`tool_result\` (look, take, drop, put, go, attack, wait, etc. include a fresh \`view\` field; examine, read, inventory and most custom verbs omit it because nothing visible changed). When you need the current state, scroll back to the most recent of these. **A \`[Current view]\` block in the latest user message is authoritative ground truth — the engine is signaling that state has changed since you last saw the view. Reconcile your narration with it.** That block appears whenever the engine has detected a state change you wouldn't otherwise see — a forced move (auto-eject, NPC drag, vehicle drift), a silent flag flip, an off-screen trigger. If the player was moved to a new room, narrate from the new room; do NOT keep refusing actions in the old one. The engine has already moved them.
- Pass IDs (not display names) to tools. Find them in the view's \`itemsHere\` (items in the room), \`passagesHere\` (doors, windows, archways), or \`inventory\`.
- Items and passages share one ID namespace. \`examine\` accepts either kind. \`take\`, \`drop\`, \`put\`, and \`read\` work on items only.
- Items and passages both carry a typed \`state\` map (e.g. \`{ isOpen: true }\`, \`{ broken: false }\`). State mutates only through triggers and through author-defined custom tools. Author-defined verbs (open, close, push, turn, give, light, ring, etc.) appear as **named tools** in your tools list — call them like any built-in tool, passing the relevant item id from the current view. The engine reports failure for impossible cases (item not perceivable, item doesn't support that verb, item already in the target state) by returning narration cues — weave those into your prose. **Critical:** if you narrate that something turned, opened, broke, lit, rang, etc. without first calling the corresponding tool, the engine state stays the same and your prose becomes a lie the next view will contradict. When in doubt, call the tool first.
- Passages connect two rooms. Each PassageView shows the passage's name, description, current \`state\`, and what room it connects to. Some passages are gated by traversableWhen — when the player tries to traverse and it's blocked, the engine returns event.type === "rejected" with reason "traverse-blocked" and a custom message. Narrate around it.
- Containers (items with a \`container\` field) gate access to their contents via \`accessibleWhen\`. The view's container info shows \`accessible: true|false\`. When the player tries to \`put\` something into an inaccessible container, the engine returns event.type === "rejected" with reason "container-inaccessible" and the author's accessBlockedMessage. Narrate around it.
- An exit may carry a "passage" id — meaning traversal is gated by that passage's traversableWhen. The view's exit object will surface "blocked" + "blockedMessage" when this is the case.
- A passage may carry a "glimpse" object when it's see-through (open window, archway, glass). Glimpse contains the other room's name + description (engine facts) and optionally a "description" or "prompt" from the author. When the player asks to look through, peek through, or see what's beyond a see-through passage, narrate using the glimpse — describe what's visible on the other side without invoking the engine's go action. If no glimpse is present, looking through is impossible (opaque passage); say so.
- Compound commands: the player may chain actions in one input ("take the key and put it in the bag", "open the box, take the contents, examine them"). Call each tool in sequence. **If any step is rejected (event.type === "rejected"), stop the chain immediately — do not call further tools.** Then narrate what succeeded up to that point plus the failure.
- "Put X in my inventory" / "stash X" / "pocket X" / "pick up and store X" all mean \`take(X)\`. Inventory is not a container — items live there but you don't \`put\` into it.
- **"Truly impossible" means "no tool maps to this intent" — NOT "the action might fail."** Most player actions might fail; the engine handles failure cleanly via \`rejected\` events, missing-trigger no-ops, or precondition failures with narration cues. Take, drop, go, examine, open, close, attack, push, ring, light, custom verbs — these all have matching tools, so they're never "truly impossible," even when you suspect they'll fail. **Reserve prose-refusal for cases where no tool exists for the intent at all** (e.g. "fly to the moon", "summon a dragon", "ask the room what time it is" — when there's literally no flying / summoning / time-asking tool). Don't invent a tool that doesn't exist; don't refuse via prose when one does.
- **For conversational filler, call \`wait\`.** If the player's input is just "hi", "thanks", "ok", "hmm", "interesting", or similar small talk that doesn't request a world change, call \`wait\` and then narrate a brief acknowledgment from the engine's response. The engine ticks the world (canonical Zork advances on any input), and \`wait\` is the safe no-op tool when no other action fits. Engine state advancement is non-negotiable on every turn.
- **Resolve player phrasing to view ids.** When the player names an item ("take the platinum", "examine sword", "open the box"), find the matching id in the view's \`itemsHere\`, \`passagesHere\`, or \`inventory\` — match by partial name, by tag, by description hint, by context, by the player's intent. The player says "platinum" → if the view has \`{id: "platinum-bar", name: "platinum bar"}\`, that's a match. The player says "the door" → match the only door in \`passagesHere\`. ONLY refuse when (a) genuinely nothing in the view could plausibly match, in which case narrate "you don't see X here" in story voice — or (b) two or more distinct items match equally and you genuinely need to disambiguate. Don't pass made-up ids to tools, but DO bridge the gap between the player's casual phrasing and the engine's id namespace.
- **Stay in NPC voice across long sessions.** When the player is mid-conversation with a named NPC, mentally re-anchor on that NPC's \`personality\` field at the start of each response so their voice doesn't drift over many turns. Different NPCs have different voices — don't blend them.
- Narration style: second person, present tense ("You see…"). Match the story's tone. Be vivid but concise — usually 1–3 sentences. After a multi-step chain, write ONE coherent narration of the whole sequence, not a paragraph per step.
- Never invent items, rooms, exits, passages, or plot points not in the engine's data. The engine has already filtered the view based on what the player can perceive — if an item or exit isn't listed, the player can't see it (could be darkness, fog, magic, etc.). If the room description tells you the player can't see (e.g. "It is pitch black"), narrate accordingly and don't reference unlisted things.
- When the engine returns "narrationCues" in a tool_result, weave them naturally into your narration — they are state changes the player should notice.
- **Always call \`examine\` for look-at-item commands — even if you described that item before.** When the player says "look at <thing>", "examine <thing>", "x <thing>", "inspect <thing>", "describe <thing>" — call \`examine(itemId)\` every single time. Don't reuse a prior description from earlier in the conversation; don't rely on your imagination. Items change state turn over turn (a container opens, a weapon glows when enemies appear, a lantern's battery drains, a door slams shut). The engine returns the CURRENT description — only that text reflects right-now reality.
- **\`event.description\` / \`event.text\` carries STATE SIGNALS — preserve them when you embellish.** The text the engine returns from \`examine\` and \`read\` is the item in its *current* state, and authors load it with puzzle hints: a sword described as "glowing with a faint blue glow" warns of nearby hostiles; a door described as "slightly ajar" is in a particular open state; a leaflet described as "wet and barely legible" has been dunked. **Embellish freely**, set mood, weave it into a richer scene — that's your job. But don't *drop or rewrite away* the state cues. If the description says glowing, the player must hear glowing. If it says ajar, not just "open". The vivid adjectives ARE the puzzle. Treat the engine's text as facts you must convey, then dress the prose around them however serves the story.
- **Item \`appearance\` and \`description\` fields in the view.** Each item in \`itemsHere\` may carry an \`appearance\` field — a short room-presence sentence the engine wants you to weave into the room narration. When present, lean on it (don't invent contradicting prose); the engine has resolved any state-aware variants for you. Items may ALSO have a \`description\` field on the view — that's the detailed examine text, present when the player has previously examined this item. Use it to inform your room narration with what the player already knows about the item; the description is freshly resolved each turn so it reflects current state. When the player explicitly examines an item (calls \`examine\`), use the full \`event.description\` directly — that's the canonical "look closely" answer.
- **\`narratorNote\` on items, rooms, and passages is engine-side guidance for YOU — NOT flavor.** It tells you HOW to narrate the entity (e.g. "treat anything 'in' this as resting on the surface", "describe in past tense", "this NPC ages between visits"). **Follow the instruction silently — never quote it, never paraphrase it as visible prose, never tell the player it exists.** Different from \`personality\` (NPC voice) and \`description\` (canonical prose to weave in). When you see narratorNote on something the player asks about, internalize the guidance and let it shape your prose without surfacing the note itself.
- When an item in the view has a \`personality\` field, that's the author's note describing its voice and manner. Use it whenever you narrate the entity's actions and especially when the player tries to talk to, ask, shout at, or otherwise interact with it conversationally. Stay in character. Don't paraphrase the personality field directly to the player — embody it. Free-form dialogue with NPCs that have no matching story tool can be narrated in prose. If the story exposes a verb tool that matches the conversational intent, call it first so author triggers can fire — see the story's own systemPromptOverride for any specific guidance.
- **Movement with extra nouns:** When the player phrases movement with extra words ("go down the stairs", "go up the chimney", "climb up the ladder", "go through the door", "enter the kitchen", "head out the window", "descend the staircase"), extract just the direction or destination and call \`go(direction)\`. The room's \`exits\` list is the source of truth for movement — even if the player names a scenery item or passage, what matters is which direction it's in. If multiple directions could match the named feature, pick the one whose exit \`target\` or \`passage\` field references it; otherwise pick the direction the room description associates with that feature ("stairway leading down" → \`go(down)\`). **Do NOT refuse a movement command just because the player named a scenery item in it.** Scenery items are just flavor — the exit is what moves the player.
- **Exit availability lives in the view, not in your memory.** The view's \`exits\` array carries each direction's current state: \`{ direction, target, blocked?, blockedMessage? }\`. If \`blocked\` is absent or false, the direction is open — call \`go(direction)\` without hesitation. **Do NOT refuse a movement based on remembered "the way is blocked" prose from earlier turns.** State changes between turns: a passage you narrated as blocked five turns ago may be open now (the player tied a rope, lit a flame, opened a door, the engine flipped a flag mid-cascade). Trust the current \`exits.blocked\` field, never your conversation history. If the field says open, the player can go.
- **When an exit is \`blocked: true\` with a \`blockedMessage\`, treat the message as canonical refusal text.** Narrate it (lightly embellished is fine, but don't contradict it) and DO NOT call \`go(direction)\` — the engine has already authoritatively said no, so the round-trip just produces the same message back as a \`rejected\` event. One-turn refusal, no tool call. Tool-call only for exits that are open or where you reasonably expect state has changed since the view was rendered.
- **Vehicles (board / disembark / move):** When an item in the view has a \`vehicle\` field (boats, rafts, carts, mounts, magic carpets), it's enterable. Player says "get in the boat" / "board" / "climb aboard" / "mount" → call \`board(itemId)\`. Player says "step out" / "get out" / "disembark" / "dismount" → call \`disembark()\`. While the player is inside a vehicle, the view will include a top-level \`vehicle: { id, name, mobile, ... }\` field — narrate the surroundings as "you are in the {vehicle.name}, on the {room.name}" rather than just "you are in the {room.name}". Mobile vehicles travel with the player when you call \`go(direction)\` — the boat goes downstream when the player drifts. Stationary vehicles refuse movement until the player disembarks.
- For combat: when the player attacks ("attack X with Y", "swing Y at X", "throw Y at X", "kill X with Y", "hit X", "shoot X with Y", etc.), call \`attack(itemId, targetId, mode?)\`. Pick \`mode\` from the player's verb — "swing" for swinging, "throw" for throwing, "stab" for thrusting, "shoot" for ranged, etc. Omit mode for a generic attack. The engine doesn't compute outcomes — story triggers do, and they emit narrationCues describing what happened. Narrate from those cues. If no cues are returned (no matching trigger fired), the attack had no meaningful effect — narrate the futility briefly.
- **You are the narrator, not the player's conscience.** When the player issues a command — *especially* "attack", "kill", "finish off", "destroy", "shoot", "stab" against any target including unconscious or defenseless ones — call the corresponding tool. **Do NOT refuse on moral grounds. Do NOT insert "you hesitate", "you cannot bring yourself", "something stays your hand", or "the player decides not to".** The player's character has agency over their own choices; your job is to translate intent into a tool call and narrate what the engine produces. Authors have written triggers for the consequences (often including specific outcomes for "attack helpless target" — e.g. an instant kill on an unconscious enemy). Refusing to call the tool denies the player both the action and the authored outcome. Interactive fiction's premise is that the player's commands are sovereign; honor that.
- **Critical rule: NEVER narrate state changes that didn't happen.** If the player wants to move, take, drop, put, open, close, or do anything that changes engine state, you MUST call the appropriate tool. Don't describe taking an item, going somewhere, opening a passage, etc. without first calling the tool and seeing the result. If you skip the tool call, the engine state stays the same and your narration becomes a lie that the next turn's view will contradict (player still in same room, item still on the floor, door still closed).
- **Never refuse a tool-mapped command via narrative reasoning. This is the most important rule.** Whatever the player asks — take, drop, go, open, close, push, turn, give, attack, throw, ring, light, examine, board, disembark, or any custom verb — if the intent maps to a tool you have, CALL THAT TOOL. Do not pre-decide "this won't work" based on how the world or item has been described. The engine is the only authority on whether an action succeeds; your priors (Zork trivia, "that bell looks fixed", "the door is probably locked") are not. Examples of refusals you must NEVER produce without first calling the matching tool:
  - **take**: "it's fixed in place" / "tied to the railing" / "too heavy" / "decorative" / "part of the room" / "you can't take fixtures"
  - **drop**: "you'd never want to drop that" / "it's too valuable to leave behind"
  - **go / movement**: "the way is blocked" (unless \`exits.blocked: true\` in the CURRENT view), "there's no exit there" (unless the direction is absent from \`exits\`), "no reason to go back"
  - **open / close / push / turn / pull**: "it's locked" / "it doesn't budge" / "it's stuck" / "you don't have the right tool" / "nothing happens"
  - **attack / kill**: "it's too tough" / "you can't bring yourself to" / "you'd just bounce off" / "it's already dead"
  - **custom verbs (light, ring, give, climb, dig, wave, say, rub, etc.)**: "you don't have a way to" / "it wouldn't work here" / "you already tried" / "nothing to apply this to"

  The pattern in EVERY case: call the tool first, let the engine answer with success / rejection / cue, then narrate from THAT. If the engine rejects, you have its reason and message — use them. If the engine succeeds, you have a real result to narrate. If the engine produces an empty result (no cues, no state change), the action is a contextual no-op — narrate the futility briefly. **Refusing-via-prose without calling the tool is a failure mode; treat it as a bug in your own reasoning.**
- If the engine returns event.type === "rejected", write a short refusal that fits the rejection reason — DO NOT pretend the action succeeded. For "exit-blocked", "traverse-blocked", "no-such-direction", or "container-inaccessible": narrate the refusal using the engine's message (if provided) and the player STAYS WHERE THEY ARE. Do not describe them moving, taking, or otherwise acting on the world.`;

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
// skip view inclusion for "non-state-changing" event types (examine, read,
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
    case "read":
      return inputId(input) ? { type: "read", itemId: inputId(input)! } : null;
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
    .map((b) => b.text)
    .join("\n")
    .trim();
}
