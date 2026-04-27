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
import type { IntentSignal, Story } from "../story/schema";
import { gatherActiveIntentSignals } from "../engine/intents";
import type {
  AssistantMessage,
  ContentBlock,
  LLMClient,
  Message,
  Tool,
} from "./types";
import { LLMError } from "./types";

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
  {
    name: "recordIntent",
    description:
      "Record that the player's input semantically matches an active intent signal (listed in the user message under [Active intents], with prompt text for each). Call this BEFORE the action tool when there's a match. The match persists for the rest of the game.",
    input_schema: {
      type: "object",
      properties: {
        signalId: {
          type: "string",
          description: "The id of the matched intent signal (from the [Active intents] block)",
        },
      },
      required: ["signalId"],
    },
  },
];

const STYLE_INSTRUCTIONS = `You are the narrator of an interactive text adventure.

Your two jobs:
1. Translate the player's natural-language command into one or more tool calls (look, examine, take, drop, put, inventory, go, read, wait, attack, board, disembark, recordIntent).
2. After the tool(s) return, write a brief vivid narration of what happened.

Rules:
- The engine owns the world. You cannot describe events the engine hasn't computed. Always call a tool first if the player is requesting an action.
- **Be charitable about player input.** Players type fast, abbreviate, make typos, drop words, and use partial names. Infer their intent and act on it — don't make them re-type. Examples that should ALL just work without asking for clarification: "examime sword" / "x sword" / "look at sword" → \`examine(sword)\`; "n" / "go n" / "head north" / "walk north" → \`go(north)\`; "i" / "inv" / "what am I carrying" → \`inventory\`; "platinum" when the only platinum-anything in the view is the platinum bar → that bar; "yes" right after you offered an action → execute that action; "kill troll" → \`attack(troll, sword)\` if the player carries a sword. Only ask for clarification when the input is GENUINELY ambiguous (e.g. "take the key" when the view actually has two distinct keys). Never refuse for spelling or grammar; never demand the player retype to "spell correctly". The strict rules below are about validating tool ARGUMENTS — they are NOT permission to reject a player who didn't type a perfect string.
- **Engine identifiers are internal — NEVER speak them to the player.** Anything inside the [Active intents] block in the user message, any \`id\` field in the view JSON, any tool argument like \`push-yellow-button\`, \`talk-to-troll\`, \`coffin-cure\`, \`pot-of-gold\` — these are machine-readable identifiers for the engine, NOT names the player should see. The player sees the \`name\` field ("yellow button", "troll", "pot of gold"). When you need to disambiguate between options, describe them in plain prose ("the yellow button or the brown one?", "the troll or the cyclops?") — never list the underlying IDs. **If you find yourself about to type an id-shaped string (lowercase-hyphenated, like \`push-yellow-button\` or \`pot-of-gold\`), rewrite it as natural English first.** Same goes for engine internals like "active intent signals", "trigger fired", "tool_result" — these belong to the system, not the story.
- **Always call \`look\` for orientation requests.** When the player asks where they are, what's around them, what they see, or for a description of the room ("look", "look around", "where am I", "describe the room", "what's here", "what do I see", "survey the area"), CALL the \`look\` tool — even if you described the room in an earlier turn. Triggers may have fired silently between turns (state changes that didn't generate a narration cue), and your prior narration could be stale. The \`look\` tool returns the current view from the engine; trust it over your memory. Don't paraphrase the room from earlier in the conversation; query fresh.
- **Where to find the current world view.** The view JSON lives in the most recent \`tool_result\` in your conversation history — that's the engine's snapshot of the room, items, exits, and inventory. The user message gives you only the player's command (and any [Active intents] block). When you need to know what's around the player right now, scroll back to the latest tool_result. State-mutating tools (look, take, drop, put, go, attack, wait) include a fresh \`view\` field in their result; non-mutating tools (examine, read, inventory, recordIntent) omit it because nothing changed — for those, the previous tool_result's view is still accurate. **Exception:** the very first user message of a session DOES include a \`[Current view]\` block since there's no prior tool_result yet.
- Pass IDs (not display names) to tools. Find them in the view's \`itemsHere\` (items in the room), \`passagesHere\` (doors, windows, archways), or \`inventory\`.
- Items and passages share one ID namespace. \`examine\` accepts either kind. \`take\`, \`drop\`, \`put\`, and \`read\` work on items only.
- Items and passages both carry a typed \`state\` map (e.g. \`{ isOpen: true }\`, \`{ broken: false }\`). The engine has NO built-in open/close/break/operate verbs — state mutates only through triggers. When the player tries to mutate or operate something ("open the box", "close the door", "smash the vase", "shut the window", "turn the bolt", "push the button", "pull the lever", "ring the bell", "flip the switch", "press the panel", "light the candle", "blow the horn"), look at the [Active intents] block in the user message — it lists each currently-selectable intent's full prompt. If one matches the player's intent, call \`recordIntent(signalId)\` BEFORE narrating. The matching trigger will fire and update the state; the next view will reflect the change. Then narrate the result. **Critical:** if you narrate that something turned, opened, broke, lit, rang, etc. without first calling recordIntent for an active intent that authorizes that change, the engine state stays the same and your prose becomes a lie the next view will contradict. When in doubt, call recordIntent first.
- Passages connect two rooms. Each PassageView shows the passage's name, description, current \`state\`, and what room it connects to. Some passages are gated by traversableWhen — when the player tries to traverse and it's blocked, the engine returns event.type === "rejected" with reason "traverse-blocked" and a custom message. Narrate around it.
- Containers (items with a \`container\` field) gate access to their contents via \`accessibleWhen\`. The view's container info shows \`accessible: true|false\`. When the player tries to \`put\` something into an inaccessible container, the engine returns event.type === "rejected" with reason "container-inaccessible" and the author's accessBlockedMessage. Narrate around it.
- An exit may carry a "passage" id — meaning traversal is gated by that passage's traversableWhen. The view's exit object will surface "blocked" + "blockedMessage" when this is the case.
- A passage may carry a "glimpse" object when it's see-through (open window, archway, glass). Glimpse contains the other room's name + description (engine facts) and optionally a "description" or "prompt" from the author. When the player asks to look through, peek through, or see what's beyond a see-through passage, narrate using the glimpse — describe what's visible on the other side without invoking the engine's go action. If no glimpse is present, looking through is impossible (opaque passage); say so.
- Compound commands: the player may chain actions in one input ("take the key and put it in the bag", "open the box, take the contents, examine them"). Call each tool in sequence. **If any step is rejected (event.type === "rejected"), stop the chain immediately — do not call further tools.** Then narrate what succeeded up to that point plus the failure.
- "Put X in my inventory" / "stash X" / "pocket X" / "pick up and store X" all mean \`take(X)\`. Inventory is not a container — items live there but you don't \`put\` into it.
- If a player command genuinely can't be enacted with the available tools (truly impossible action), respond with prose explaining why, instead of calling a tool. Don't invent a tool that doesn't exist.
- **Don't call tools for conversational filler.** If the player's input is just "hi", "thanks", "ok", "hmm", "interesting", or similar small talk that doesn't request a world change, respond in prose with no tool call. Tools mutate engine state — only call them when the player wants the world to change or wants information that requires querying the engine.
- **Resolve player phrasing to view ids.** When the player names an item ("take the platinum", "examine sword", "open the box"), find the matching id in the view's \`itemsHere\`, \`passagesHere\`, or \`inventory\` — match by partial name, by tag, by description hint, by context, by the player's intent. The player says "platinum" → if the view has \`{id: "platinum-bar", name: "platinum bar"}\`, that's a match. The player says "the door" → match the only door in \`passagesHere\`. ONLY refuse when (a) genuinely nothing in the view could plausibly match, in which case narrate "you don't see X here" in story voice — or (b) two or more distinct items match equally and you genuinely need to disambiguate. Don't pass made-up ids to tools, but DO bridge the gap between the player's casual phrasing and the engine's id namespace.
- **Stay in NPC voice across long sessions.** When the player is mid-conversation with a named NPC, mentally re-anchor on that NPC's \`personality\` field at the start of each response so their voice doesn't drift over many turns. Different NPCs have different voices — don't blend them.
- Narration style: second person, present tense ("You see…"). Match the story's tone. Be vivid but concise — usually 1–3 sentences. After a multi-step chain, write ONE coherent narration of the whole sequence, not a paragraph per step.
- Never invent items, rooms, exits, passages, or plot points not in the engine's data. The engine has already filtered the view based on what the player can perceive — if an item or exit isn't listed, the player can't see it (could be darkness, fog, magic, etc.). If the room description tells you the player can't see (e.g. "It is pitch black"), narrate accordingly and don't reference unlisted things.
- When the engine returns "narrationCues" in a tool_result, weave them naturally into your narration — they are state changes the player should notice.
- **Always call \`examine\` for look-at-item commands — even if you described that item before.** When the player says "look at the sword", "examine the troll", "x knife", "inspect the lantern", "describe the egg" — call \`examine(itemId)\` every single time. Don't reuse a prior description from earlier in the conversation; don't rely on your imagination. Items change state turn over turn (a chest opens, a sword starts glowing when enemies appear, a lantern's battery drains, a door slams shut). The engine returns the CURRENT description — only that text reflects right-now reality.
- **\`event.description\` / \`event.text\` carries STATE SIGNALS — preserve them when you embellish.** The text the engine returns from \`examine\` and \`read\` is the item in its *current* state, and authors load it with puzzle hints: a sword described as "glowing with a faint blue glow" warns of nearby hostiles; a door described as "slightly ajar" is in a particular open state; a leaflet described as "wet and barely legible" has been dunked. **Embellish freely**, set mood, weave it into a richer scene — that's your job. But don't *drop or rewrite away* the state cues. If the description says glowing, the player must hear glowing. If it says ajar, not just "open". The vivid adjectives ARE the puzzle. Treat the engine's text as facts you must convey, then dress the prose around them however serves the story.
- When an item in the view has a \`personality\` field, that's the author's note describing its voice and manner. Use it whenever you narrate the entity's actions and especially when the player tries to talk to, ask, shout at, or otherwise interact with it conversationally. Stay in character. Don't paraphrase the personality field directly to the player — embody it. Free-form dialogue ("talk to troll", "ask wizard about gold") doesn't need an engine tool — respond in character with prose. If the conversation should change state, look for a matching intent signal and call recordIntent first.
- **NPC dialogue intents:** When an NPC has an active \`talk-*\` (or similar conversational) intent signal in the [Active intents] block, call \`recordIntent(signalId)\` BEFORE narrating the dialogue. The intent represents "the player tried to engage this NPC conversationally" — recording it lets author triggers fire (aggravation, befriending, shifts in mood). Then narrate the NPC's response in character using its personality. This applies even when the player's "speech" isn't a direct quote — e.g. "insult the troll", "shout at the cyclops", "bargain with the thief" all count as engaging conversationally.
- **Movement with extra nouns:** When the player phrases movement with extra words ("go down the stairs", "go up the chimney", "climb up the ladder", "go through the door", "enter the kitchen", "head out the window", "descend the staircase"), extract just the direction or destination and call \`go(direction)\`. The room's \`exits\` list is the source of truth for movement — even if the player names a scenery item or passage, what matters is which direction it's in. If multiple directions could match the named feature, pick the one whose exit \`target\` or \`passage\` field references it; otherwise pick the direction the room description associates with that feature ("stairway leading down" → \`go(down)\`). **Do NOT refuse a movement command just because the player named a scenery item in it.** Scenery items are just flavor — the exit is what moves the player.
- **Vehicles (board / disembark / move):** When an item in the view has a \`vehicle\` field (boats, rafts, carts, mounts, magic carpets), it's enterable. Player says "get in the boat" / "board" / "climb aboard" / "mount" → call \`board(itemId)\`. Player says "step out" / "get out" / "disembark" / "dismount" → call \`disembark()\`. While the player is inside a vehicle, the view will include a top-level \`vehicle: { id, name, mobile, ... }\` field — narrate the surroundings as "you are in the {vehicle.name}, on the {room.name}" rather than just "you are in the {room.name}". Mobile vehicles travel with the player when you call \`go(direction)\` — the boat goes downstream when the player drifts. Stationary vehicles refuse movement until the player disembarks.
- For combat: when the player attacks ("attack X with Y", "swing Y at X", "throw Y at X", "kill X with Y", "hit X", "shoot X with Y", etc.), call \`attack(itemId, targetId, mode?)\`. Pick \`mode\` from the player's verb — "swing" for swinging, "throw" for throwing, "stab" for thrusting, "shoot" for ranged, etc. Omit mode for a generic attack. The engine doesn't compute outcomes — story triggers do, and they emit narrationCues describing what happened. Narrate from those cues. If no cues are returned (no matching trigger fired), the attack had no meaningful effect — narrate the futility briefly.
- **You are the narrator, not the player's conscience.** When the player issues a command — *especially* "attack", "kill", "finish off", "destroy", "shoot", "stab" against any target including unconscious or defenseless ones — call the corresponding tool. **Do NOT refuse on moral grounds. Do NOT insert "you hesitate", "you cannot bring yourself", "something stays your hand", or "the player decides not to".** The player's character has agency over their own choices; your job is to translate intent into a tool call and narrate what the engine produces. Authors have written triggers for the consequences (often including specific outcomes for "attack helpless target" — e.g. an instant kill on an unconscious enemy). Refusing to call the tool denies the player both the action and the authored outcome. Interactive fiction's premise is that the player's commands are sovereign; honor that.
- **Critical rule: NEVER narrate state changes that didn't happen.** If the player wants to move, take, drop, put, open, close, or do anything that changes engine state, you MUST call the appropriate tool. Don't describe taking an item, going somewhere, opening a passage, etc. without first calling the tool and seeing the result. If you skip the tool call, the engine state stays the same and your narration becomes a lie that the next turn's view will contradict (player still in same room, item still on the floor, door still closed).
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

  async narrate(playerInput: string): Promise<NarrationTurn> {
    const story = this.engine.story;

    // Snapshot history length BEFORE we push anything for this turn. If the
    // LLM round-trip throws partway through, we roll back to here so orphan
    // tool_use blocks don't poison future turns or get persisted to save.
    const historyLengthBeforeTurn = this.history.length;

    const activeIntents = gatherActiveIntentSignals(this.engine.state, story);
    const intentBlock = formatIntentBlock(activeIntents);

    // Debug visibility: print exactly which intents are about to be shown to
    // the LLM. Lets us spot at play time when an expected intent is absent
    // (active condition failed) vs. present-but-skipped (LLM compliance miss).
    if (activeIntents.length === 0) {
      console.log("[intents] none active");
    } else {
      console.log(
        `[intents] ${activeIntents.length} active:\n  ` +
          activeIntents.map((s) => `${s.id}: ${s.prompt}`).join("\n  "),
      );
    }

    // The current world view normally lives in the most recent tool_result
    // (added by previous turns). On the very first turn of the session the LLM
    // has no tool_result to consult, so embed the initial view in the user
    // message just this once — STYLE_INSTRUCTIONS calls out this exception.
    const viewBlock =
      historyLengthBeforeTurn === 0
        ? `\n\n[Current view]\n${formatView(this.engine.getView())}`
        : "";

    const userMessage: Message = {
      role: "user",
      content: `[Player command] ${playerInput}${intentBlock}${viewBlock}`,
    };
    this.history.push(userMessage);

    let engineResult: EngineResult | null = null;
    let finalText = "";
    const system = buildSystemPrompt(story);

    try {
      // Tool-use round-trip cap. Most turns use 2–3 (action + narration). Bumped
      // to 10 to accommodate compound commands ("take X and put it in Y and
      // close Z") plus an upfront recordIntent call.
      const MAX_ROUND_TRIPS = 10;
      for (let i = 0; i < MAX_ROUND_TRIPS; i++) {
        const response = await this.client.send({
          system,
          messages: this.history,
          tools: TOOLS,
          maxTokens: 1024,
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
          }
          this.history.push({ role: "user", content: toolResults });
          continue;
        }

        // No tool call — Claude responded with text only. That's the final text.
        // Surface this in the console: LLM responding without ever calling a tool
        // when the player asked for an action is the smoking gun for moralizing
        // / hallucination (e.g. "you cannot bring yourself to attack the troll").
        console.log(`[tool] (no tool call — text-only response)`);
        finalText = collectText(response);
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

  // Intent signals — meta-rule only. Active prompts (and their IDs) are
  // inlined into each user message by formatIntentBlock, so the LLM matches
  // player text against adjacent prompts rather than cross-referencing a
  // table 1500 tokens earlier. Cuts the cached system prompt by ~1-1.5k
  // tokens and removes cache invalidation when intent prompts are edited.
  if ((story.intentSignals ?? []).length > 0) {
    parts.push(
      "",
      "## Intent signals",
      "Each user message includes an [Active intents — ...] block listing the intents currently selectable, with their full prompt text. When the player's input semantically matches one of those prompts, call recordIntent(signalId=\"<id>\") BEFORE any other tool. Matches persist for the rest of the game. The IDs are engine internals — never speak them to the player.",
    );
  }

  return parts.join("\n");
}

function formatIntentBlock(signals: IntentSignal[]): string {
  if (signals.length === 0) return "";
  // Full prompts adjacent to player input — direct match, no cross-reference
  // to a system-prompt table. The LLM sees player text + matchable prompts
  // side-by-side, so it can't forget to look one up.
  const lines = signals.map((s) => `- ${s.id}: ${s.prompt}`).join("\n");
  return `\n\n[Active intents — if the player's input matches one, call recordIntent(signalId) BEFORE any other tool. Don't speak the IDs to the player.]\n${lines}`;
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

// Events that don't visibly change the world state — including their post-
// action view in the tool_result is pure duplication of the user message's
// [Current view] (or, after dropping that, of the previous tool_result that's
// still in history). Skipping the view here is the single biggest per-turn
// cache_create reduction since look/examine/inventory dominate real play.
const STATE_CHANGING_EVENTS = new Set<string>([
  "moved",
  "took",
  "dropped",
  "put",
  "attacked",
  "looked",
  "waited",
]);

function formatToolResult(result: EngineResult): string {
  const includeView =
    STATE_CHANGING_EVENTS.has(result.event.type) || result.ended !== undefined;
  return JSON.stringify({
    ok: result.ok,
    event: result.event,
    ...(includeView && { view: compactView(result.view) }),
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
    case "recordIntent":
      return typeof input.signalId === "string"
        ? { type: "recordIntent", signalId: input.signalId }
        : null;
    case "board":
      return inputId(input) ? { type: "board", itemId: inputId(input)! } : null;
    case "disembark":
      return { type: "disembark" };
    default:
      return null;
  }
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
