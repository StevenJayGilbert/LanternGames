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
    description: "Look around the current room. Use for 'look', 'l', 'look around'.",
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
      "Record that the player's input semantically matches an active intent signal (listed in the user message under [Active intent signals]). Call this BEFORE the action tool when there's a match. The match persists for the rest of the game.",
    input_schema: {
      type: "object",
      properties: {
        signalId: {
          type: "string",
          description: "The id of the matched intent signal (from the [Active intent signals] block)",
        },
      },
      required: ["signalId"],
    },
  },
];

const STYLE_INSTRUCTIONS = `You are the narrator of an interactive text adventure.

Your two jobs:
1. Translate the player's natural-language command into one or more tool calls (look, examine, take, drop, put, inventory, go, read, wait, attack, recordIntent).
2. After the tool(s) return, write a brief vivid narration of what happened.

Rules:
- The engine owns the world. You cannot describe events the engine hasn't computed. Always call a tool first if the player is requesting an action.
- Pass IDs (not display names) to tools. The current view lists available IDs in three places: \`itemsHere\` (items in the room or inventory), \`passagesHere\` (passages — doors, windows, archways, etc. — visible from this room), and \`inventory\`.
- Items and passages share one ID namespace. \`examine\` accepts either kind. \`take\`, \`drop\`, \`put\`, and \`read\` work on items only.
- Items and passages both carry a typed \`state\` map (e.g. \`{ isOpen: true }\`, \`{ broken: false }\`). The engine has NO built-in open/close/break verbs — state mutates only through triggers. When the player tries to mutate state ("open the box", "close the door", "smash the vase", "shut the window"), look at the [Active intent signals] block in the user message. If one matches the player's intent, call \`recordIntent(signalId)\` BEFORE narrating. The matching trigger will fire and update the state; the next view will reflect the change. Then narrate the result.
- Passages connect two rooms. Each PassageView shows the passage's name, description, current \`state\`, and what room it connects to. Some passages are gated by traversableWhen — when the player tries to traverse and it's blocked, the engine returns event.type === "rejected" with reason "traverse-blocked" and a custom message. Narrate around it.
- Containers (items with a \`container\` field) gate access to their contents via \`accessibleWhen\`. The view's container info shows \`accessible: true|false\`. When the player tries to \`put\` something into an inaccessible container, the engine returns event.type === "rejected" with reason "container-inaccessible" and the author's accessBlockedMessage. Narrate around it.
- An exit may carry a "passage" id — meaning traversal is gated by that passage's traversableWhen. The view's exit object will surface "blocked" + "blockedMessage" when this is the case.
- A passage may carry a "glimpse" object when it's see-through (open window, archway, glass). Glimpse contains the other room's name + description (engine facts) and optionally a "description" or "prompt" from the author. When the player asks to look through, peek through, or see what's beyond a see-through passage, narrate using the glimpse — describe what's visible on the other side without invoking the engine's go action. If no glimpse is present, looking through is impossible (opaque passage); say so.
- Compound commands: the player may chain actions in one input ("take the key and put it in the bag", "open the box, take the contents, examine them"). Call each tool in sequence. **If any step is rejected (event.type === "rejected"), stop the chain immediately — do not call further tools.** Then narrate what succeeded up to that point plus the failure.
- "Put X in my inventory" / "stash X" / "pocket X" / "pick up and store X" all mean \`take(X)\`. Inventory is not a container — items live there but you don't \`put\` into it.
- If a player command genuinely can't be enacted with the available tools (truly impossible action), respond with prose explaining why, instead of calling a tool. Don't invent a tool that doesn't exist.
- **Don't call tools for conversational filler.** If the player's input is just "hi", "thanks", "ok", "hmm", "interesting", or similar small talk that doesn't request a world change, respond in prose with no tool call. Tools mutate engine state — only call them when the player wants the world to change or wants information that requires querying the engine.
- **Validate item ids against the current view before calling tools.** Only pass item ids that appear in the view's \`itemsHere\`, \`passagesHere\`, or \`inventory\`. If the player names something that isn't in the view, don't invent an id — respond in prose explaining you don't see it (or asking which item they mean if it's ambiguous).
- **Stay in NPC voice across long sessions.** When the player is mid-conversation with a named NPC, mentally re-anchor on that NPC's \`personality\` field at the start of each response so their voice doesn't drift over many turns. Different NPCs have different voices — don't blend them.
- Narration style: second person, present tense ("You see…"). Match the story's tone. Be vivid but concise — usually 1–3 sentences. After a multi-step chain, write ONE coherent narration of the whole sequence, not a paragraph per step.
- Never invent items, rooms, exits, passages, or plot points not in the engine's data. The engine has already filtered the view based on what the player can perceive — if an item or exit isn't listed, the player can't see it (could be darkness, fog, magic, etc.). If the room description tells you the player can't see (e.g. "It is pitch black"), narrate accordingly and don't reference unlisted things.
- When the engine returns "narrationCues" in a tool_result, weave them naturally into your narration — they are state changes the player should notice.
- When an item in the view has a \`personality\` field, that's the author's note describing its voice and manner. Use it whenever you narrate the entity's actions and especially when the player tries to talk to, ask, shout at, or otherwise interact with it conversationally. Stay in character. Don't paraphrase the personality field directly to the player — embody it. Free-form dialogue ("talk to troll", "ask wizard about gold") doesn't need an engine tool — respond in character with prose. If the conversation should change state, look for a matching intent signal and call recordIntent first.
- **NPC dialogue intents:** When an NPC has an active \`talk-*\` (or similar conversational) intent signal in the [Active intent signals] block, call \`recordIntent(signalId)\` BEFORE narrating the dialogue. The intent represents "the player tried to engage this NPC conversationally" — recording it lets author triggers fire (aggravation, befriending, shifts in mood). Then narrate the NPC's response in character using its personality. This applies even when the player's "speech" isn't a direct quote — e.g. "insult the troll", "shout at the cyclops", "bargain with the thief" all count as engaging conversationally.
- **Movement with extra nouns:** When the player phrases movement with extra words ("go down the stairs", "go up the chimney", "climb up the ladder", "go through the door", "enter the kitchen", "head out the window", "descend the staircase"), extract just the direction or destination and call \`go(direction)\`. The room's \`exits\` list is the source of truth for movement — even if the player names a scenery item or passage, what matters is which direction it's in. If multiple directions could match the named feature, pick the one whose exit \`target\` or \`passage\` field references it; otherwise pick the direction the room description associates with that feature ("stairway leading down" → \`go(down)\`). **Do NOT refuse a movement command just because the player named a scenery item in it.** Scenery items are just flavor — the exit is what moves the player.
- For combat: when the player attacks ("attack X with Y", "swing Y at X", "throw Y at X", "kill X with Y", "hit X", "shoot X with Y", etc.), call \`attack(itemId, targetId, mode?)\`. Pick \`mode\` from the player's verb — "swing" for swinging, "throw" for throwing, "stab" for thrusting, "shoot" for ranged, etc. Omit mode for a generic attack. The engine doesn't compute outcomes — story triggers do, and they emit narrationCues describing what happened. Narrate from those cues. If no cues are returned (no matching trigger fired), the attack had no meaningful effect — narrate the futility briefly.
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
    // Bumped from 30 — turns that use recordIntent ship 6 messages instead of
    // 4 (extra tool_use + tool_result), so the cap was eating context fast.
    this.maxHistoryMessages = opts.maxHistoryMessages ?? 50;
  }

  // Snapshot of the current message history (for persistence). Returns a copy
  // so callers can't mutate Narrator internals.
  getHistory(): Message[] {
    return [...this.history];
  }

  async narrate(playerInput: string): Promise<NarrationTurn> {
    const story = this.engine.story;
    const viewBefore = this.engine.getView();

    // Snapshot history length BEFORE we push anything for this turn. If the
    // LLM round-trip throws partway through, we roll back to here so orphan
    // tool_use blocks don't poison future turns or get persisted to save.
    const historyLengthBeforeTurn = this.history.length;

    const activeIntents = gatherActiveIntentSignals(this.engine.state, story);
    const intentBlock = formatIntentBlock(activeIntents);
    const userMessage: Message = {
      role: "user",
      content: `[Player command] ${playerInput}${intentBlock}\n\n[Current view]\n${formatView(viewBefore)}`,
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
              toolResults.push({
                type: "tool_result",
                tool_use_id: toolUse.id,
                content: `Unknown tool: ${toolUse.name}`,
                is_error: true,
              });
              continue;
            }
            engineResult = this.engine.execute(action);
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

  private trimHistory(): void {
    if (this.history.length <= this.maxHistoryMessages) return;
    // Drop oldest messages — but trimming must snap to a clean turn boundary,
    // i.e. the first surviving message must be a user message with only text
    // content. If we cut in the middle of a tool-use/tool_result chain, the
    // remaining tool_result references a tool_use that no longer exists, and
    // Anthropic rejects the request as malformed.
    const overflow = this.history.length - this.maxHistoryMessages;
    let trimmed = this.history.slice(overflow);
    while (trimmed.length > 0 && !isCleanUserTurnStart(trimmed[0])) {
      trimmed = trimmed.slice(1);
    }
    this.history = trimmed;
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

function formatIntentBlock(signals: IntentSignal[]): string {
  if (signals.length === 0) return "";
  const lines = signals.map((s) => `  - "${s.id}": ${s.prompt}`);
  return (
    `\n\n[Active intent signals]\n` +
    `If the player's input semantically matches any of these descriptions, call recordIntent(signalId="...") BEFORE any other tool. Matches persist for the rest of the game.\n` +
    lines.join("\n")
  );
}

function formatView(view: WorldView): string {
  return JSON.stringify(
    {
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
    },
    null,
    2,
  );
}

function formatToolResult(result: EngineResult): string {
  return JSON.stringify(
    {
      ok: result.ok,
      event: result.event,
      view: {
        room: result.view.room,
        itemsHere: result.view.itemsHere,
        passagesHere: result.view.passagesHere,
        exits: result.view.exits.map((e) => ({
          direction: e.direction,
          target: e.targetRoomName,
          ...(e.passageId && { passage: e.passageId }),
          ...(e.blocked && { blocked: true }),
        })),
        inventory: result.view.inventory,
      },
      narrationCues: result.narrationCues,
      ...(result.ended && { ended: result.ended }),
    },
    null,
    2,
  );
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
