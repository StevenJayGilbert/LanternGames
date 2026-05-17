# Narrator LLM: Prompts and Per-Turn Input

Audit of what the narrator model sees on every player turn — the architecture, the structured data piped into the prompt, and the system instructions that steer it.

Snapshot from commit `f33e082` (2026-04-30).

---

## Architecture: one model, two phases

The narrator at [app/src/llm/narrator.ts](../app/src/llm/narrator.ts) wraps a single Claude conversation. Per player turn there are typically **two round-trips** ("phases") to the same model. The system prompt and tools list are identical between phases; only the conversation history grows AND the `tool_choice` flag differs.

```
Player input
    ↓
┌───────────────────────────────────────────────┐
│  Phase 1: Tool selection                       │
│  ─────────────────────                          │
│  In:  system + tools + history + user msg       │
│       tool_choice: { type: "any" }  ← FORCED    │
│  Out: tool_use blocks (always — never text-only)│
└───────────────────────────────────────────────┘
    ↓ (engine executes each tool, produces results)
┌───────────────────────────────────────────────┐
│  Phase 2: Narration after tools                │
│  ─────────────────────────                      │
│  In:  same system + tools, history now contains │
│       Phase 1's assistant message + tool_results │
│       tool_choice: "auto" (default)             │
│  Out: final narration text shown to player      │
└───────────────────────────────────────────────┘
    ↓
Text shown to player
```

A **single** Claude instance does both jobs. There is no separate "tool-picker model" + "narrator model" pipeline.

### Phase 1 forced tool calls

Phase 1 is detected as the round-trip where the latest message in `this.history` is the user's `[Player command]` (i.e. no `tool_result` blocks have been pushed for this turn yet). On Phase 1, the narrator passes `tool_choice: { type: "any" }` ([narrator.ts](../app/src/llm/narrator.ts) round-trip loop) — the model is structurally required to call at least one tool. This eliminates the "hallucinated text-only refusal" failure mode that previously left engine state stuck.

For genuine conversational filler ("hi", "thanks"), STYLE_INSTRUCTIONS directs the LLM to call `wait` — the safe no-op tool that ticks the engine forward without changing meaningful state.

Phase 2 (and any further round-trips after the first) uses default `tool_choice: "auto"`, allowing the LLM to finish with text-only narration. The wait-fallback path is preserved as a defensive backstop for non-Anthropic backends (e.g. Ollama, which doesn't yet honor `tool_choice`) but should be unreachable on Anthropic-backed Phase 1.

---

## Token budget per turn

| | Cold (first turn) | Steady (cached) |
|---|---|---|
| System prompt + tools | ~3,000-4,500 | ~0 (cached) |
| Conversation history | ~0 | mostly cached, ~50 fresh per turn |
| User msg (`[Player command]` + `[Current view]`) | 400-1,050 | same |
| Phase 1 output (tool_use blocks) | ~50-150 | n/a |
| Tool results | 300-800 | same |
| Phase 2 output (narration) | 100-300 | n/a |
| **Per-turn input cost (effective)** | **~5,000-6,500** | **~500-1,500** |

Anthropic's prompt cache invalidates only when the system prompt or tools change, or when the history sliding-window trims (every ~30 turns). Steady-state turns ride the cache.

---

## The `[Current view]` block

The single most important data structure the LLM sees. It's a minified JSON dump of the engine's snapshot of what the player can perceive right now, embedded in the user message:

```
[Player command] take the bell

[Current view]
{"room":{...},"itemsHere":[...],"passagesHere":[...],"exits":[...],"inventory":[...]}
```

Inclusion is gated by a fingerprint at [narrator.ts:262-275](../app/src/llm/narrator.ts) — the block is only emitted when the view's JSON differs from the most recent view the LLM has seen anywhere in its history (either via a prior `[Current view]` block OR via a `tool_result.view`). Tool results always carry the post-action view, so steady-state turns where state hasn't changed skip the block.

### Top-level shape

```ts
{
  room: { id, name, description, narratorNote? },
  itemsHere: ItemView[],
  passagesHere: PassageView[],
  exits: ExitView[],
  inventory: ItemView[],
  vehicle?: { id, name, description, mobile, state? },     // when player is inside one
  score?: { current, max, moves, rank },                   // when story declares max-score
  finished?: { won, message }                              // when game has ended
}
```

`compactView` lives at [narrator.ts:576-590](../app/src/llm/narrator.ts).

### `ItemView` (per item in `itemsHere` and `inventory`)

```ts
{
  id: string,                   // engine identifier — LLM never speaks this
  name: string,                 // player-facing name
  appearance?: string,          // short room-presence line, variants-resolved each turn
  description?: string,         // examine text — ONLY present when state.examinedItems includes this id
  fixed?: true,                 // scenery flag — won't be enumerated as "you see…"
  tags?: string[],              // ["weapon","treasure","carryable","food",…]
  personality?: string,         // NPC voice instructions
  narratorNote?: string,        // engine-side guidance — silent, never quoted to the player
  state?: { [key]: Atom },      // current item state map: { isOpen: true, broken: false, isLit: true } etc
  containedIn?: { id, name, relation: "in" },   // when item is inside another item
  container?: {
    capacity?: number,
    accessible: boolean,                          // whether put can target this right now
    accessBlockedMessage?: string                 // ONLY present when not accessible
  }
}
```

Defined at [view.ts:31-70](../app/src/engine/view.ts).

### `PassageView` (per passage in `passagesHere`)

```ts
{
  id: string,
  name: string,                 // resolved from current side + variants
  description: string,          // resolved from current side + variants
  narratorNote?: string,
  state: { [key]: Atom },       // e.g. { isOpen: true }
  connectsTo: { id, name },     // the OTHER room the passage leads to
  glimpse?: {                   // when see-through and the glimpse's `when` holds
    otherRoom: { id, name, description },
    description?: string,       // author-canonical text
    prompt?: string             // author guidance for narrating the glimpse
  }
}
```

### `ExitView` (per exit in `exits`)

```ts
{
  direction: string,            // "north", "down", "in", etc.
  target?: string,              // ROOM NAME of destination — only present once the player has visited it (engine-gated on state.visitedRooms). Absent for unvisited destinations so the LLM narrates by direction only and can't leak a room name the player hasn't earned.
  passage?: string,             // passage id if exit traverses a passage
  blocked?: true,               // present only when currently blocked
  blockedMessage?: string       // present only when blocked
}
```

The narrator is instructed (via STYLE rule in the system prompt) to narrate exits without `target` by direction only — no inventing or recalling destination names from canonical world-knowledge. Once `target` is present, the LLM may reference it ("the path back to the Forest Path").

### Concrete example: dome-room with rope tied

Player is in dome-room; they've previously tied the rope to the railing (`dome-flag=true`); they're carrying the lit lamp and a clove of garlic; they've examined the lamp but not the garlic.

```json
{
  "room": {
    "id": "dome-room",
    "name": "Dome Room",
    "description": "You are at the periphery of a large dome, which forms the ceiling of another room below. Protecting you from a precipitous drop is a wooden railing which circles the dome."
  },
  "itemsHere": [
    {
      "id": "rope",
      "name": "rope",
      "appearance": "A rope is tied securely to the wooden railing here, descending into the darkness below.",
      "tags": ["tool", "carryable"],
      "narratorNote": "When the rope is at dome-room with dome-flag=true (tied), take(rope) is the canonical untie mechanic — the engine fires the untie-rope-on-take trigger, moves the rope into the player's inventory, and clears dome-flag. NEVER refuse a take with 'you must untie first' — taking IS untying."
    },
    {
      "id": "railing",
      "name": "wooden railing",
      "fixed": true
    }
  ],
  "passagesHere": [],
  "exits": [
    { "direction": "west", "target": "Engravings Cave" },
    { "direction": "down", "target": "Torch Room" }
  ],
  "inventory": [
    {
      "id": "lamp",
      "name": "brass lantern",
      "description": "A shiny brass lantern, currently lit.",
      "tags": ["light-source", "carryable"],
      "state": { "isLit": true }
    },
    {
      "id": "garlic",
      "name": "clove of garlic",
      "tags": ["food", "carryable"]
    }
  ],
  "score": { "current": 119, "max": 357, "moves": 47, "rank": "Adventurer" }
}
```

In this example, the LLM sees:
- The rope's appearance reflects its tied state via `appearanceVariants`.
- The rope's `narratorNote` instructs the LLM how to handle the take-as-untie mechanic.
- The lamp has `description` because the player has examined it; the garlic does not.
- The lamp's `state.isLit: true` reflects current state.
- The down exit is unblocked (no `blocked` field) because `dome-flag=true`; if it were false, the exit would be omitted entirely (engine pre-filters by `exit.when`).

### What state is and isn't surfaced

**Surfaced**:
- Per-item `state` maps for items in the current view (open/closed, lit, broken, etc.)
- `appearance` — variants-resolved each turn, so state-aware text is current
- `description` — only when item has been examined (gates puzzle-spoiler text)
- Per-passage `state`, including variants-resolved name/description
- `glimpse` only when see-through condition holds
- Exit `blocked`/`blockedMessage` only when blocked
- Score, vehicle, ended fields when applicable

**Not surfaced**:
- `flags` — global flags like `gate-flag`, `lld-flag`, `dome-flag`, `score`, `low-tide-countdown` are baked into variant text but not exposed as fields
- `firedTriggers` — what trigger has already fired
- `matchedIntents` — pending intent signals
- Raw `passageStates` / `roomStates` / `itemStates` maps — only per-item/passage `state` for items currently in view
- `examinedItems` — used to gate `description` inclusion but not exposed as a list
- `visitedRooms`
- Hidden items (engine pre-filters by `visibleWhen` and accessibility)
- Container contents when inaccessible (filtered from `itemsHere`)

The LLM sees concrete results (`exit.blocked: true`, `state.isOpen: false`) but not the gates that produced them. This is by design — the engine is the authority; the LLM doesn't reason about the rule system.

---

## The system prompt

Built at [narrator.ts:520+](../app/src/llm/narrator.ts) in `buildSystemPrompt(story)`. The full system prompt is `STYLE_INSTRUCTIONS` plus a story-specific append.

### Structure

```
{STYLE_INSTRUCTIONS — ~2,500 tokens, ~50 flat bullets}

# Story context
Title: {story.title}
Author: {story.author}
{story.description if present}

{story.systemPromptOverride if present — author's per-story tweaks}
```

### `STYLE_INSTRUCTIONS` topic list

The instructions live at [narrator.ts:155-204](../app/src/llm/narrator.ts) as a single template literal. Topics in order:

1. Mission preamble: "you are the narrator of an interactive text adventure" — the LLM has two jobs (translate input → tool calls; narrate from results).
2. **Default to action.** Call the tool, never refuse via prose. *"Even when 90% sure the action will fail, call the tool anyway."*
3. **Be charitable about player input** — typos, abbreviations, partial names; don't make the player retype.
4. **Engine identifiers are internal** — never speak `id` strings to the player.
5. **Always call `look` for orientation requests.** Triggers may have fired silently; trust the engine's snapshot, not memory.
6. **Where to find the current world view.** Includes the `[Current view]`-as-authoritative-ground-truth rule: when the block appears in the user message, reconcile narration with it (e.g. if forcibly moved, narrate from the new room).
7. *"Truly impossible"* means *"no tool maps to this intent"* — NOT *"this action might fail."*
8. Pass IDs (not display names) to tools.
9. Items and passages share one ID namespace.
10. Item / passage state mechanics; auto-generated open/close intents.
11. Passages — `traversableWhen`, blocked exits, custom messages.
12. Containers — `accessibleWhen`, `accessBlockedMessage`.
13. Exits with a `passage` id — gated by passage state.
14. Glimpse — see-through passages, look-through narration.
15. Compound commands — call each tool in sequence; stop on first rejection.
16. *"Put X in my inventory"* / *"stash X"* mean `take(X)`.
17. **For conversational filler, call `wait`.** ("hi", "thanks", "hmm", "ok") — `wait` is the safe no-op that ticks the engine. Engine state advancement is non-negotiable per turn (Phase 1's `tool_choice: "any"` makes this structural anyway).
18. Resolve player phrasing to view ids.
19. Stay in NPC voice for mid-conversation NPCs.
20. Narration style — second-person present tense, brief.
21. **View fidelity, both directions.** Never invent items / rooms / exits not in view; and never omit a present one — when narrating a room (a `look` or arriving in a room), every `itemsHere` entry must be surfaced to the player, bare-`name` items included. Omitting a present item is as much a fidelity bug as inventing one.
22. Weave `narrationCues` from tool results into prose.
23. **Always call `examine` for look-at-item commands.** State changes turn over turn; trust the engine.
24. `event.description` / `event.text` carry state signals — preserve them when embellishing.
25. `appearance` and `description` field meanings in ItemView.
26. `narratorNote` is engine-side guidance — never quote it to the player.
27. `personality` field for NPC voice.
28. **Movement with extra nouns** — extract direction from "go down the stairs" / "climb up the ladder" etc.
29. **Exit availability lives in the view, not memory.** `exits.blocked` is the source of truth; don't refuse a movement based on remembered "way is blocked" prose.
30. **When `blocked: true` with `blockedMessage`, treat the message as canonical refusal text** — narrate it, don't tool-call.
31. Vehicles — `board` / `disembark` / mobile vs stationary.
32. Combat — call `attack(itemId, targetId, mode?)`; narrate from cues.
33. **You are the narrator, not the player's conscience.** Don't refuse "kill X" on moral grounds.
34. **Critical: NEVER narrate state changes that didn't happen.** Always call the appropriate tool first.
35. **Never refuse a tool-mapped command via narrative reasoning.** Verb-grouped examples of bad refusals (take/drop/go/open/attack/custom verbs).
36. On `event.type === "rejected"`: narrate the engine's reason; player STAYS WHERE THEY ARE.

### Example: full system prompt (excerpt)

This is the actual prompt prefix the LLM sees, abridged to the first ~5 rules and the story append:

```
You are the narrator of an interactive text adventure.

Your two jobs:
1. Translate the player's natural-language command into one or more tool calls. Tools include engine built-ins (look, examine, take, drop, put, inventory, go, read, wait, attack, board, disembark) AND story-defined verbs (open, close, push, turn, give, light, ring, etc.) — call whichever tool's description fits the player's input.
2. After the tool(s) return, write a brief vivid narration of what happened.

Rules:
- **Default to action: call the tool, then narrate from the result.** The single most common failure mode for an interactive-fiction narrator is refusing-via-prose without trying the tool — inventing constraints ("fixed in place", "the door is locked", "you can't reach it") that the engine never declared. Don't be that. When the player asks for any concrete action — take, drop, go, open, close, attack, push, ring, light, custom verbs — your FIRST move is to call the matching tool. The engine returns ground truth: success, rejection-with-reason, or a specific cue. You narrate from THAT, not from your guess. Even when you're 90% sure the action will fail, call the tool anyway. Token cost of the round-trip is small; the cost of hallucinating a refusal is the player losing trust in the world. The engine is the only authority on what's possible — your priors and Zork-trivia memory are not.
- **Be charitable about player input.** Players type fast, abbreviate, make typos, drop words, and use partial names. Infer their intent and act on it — don't make them re-type. Examples that should ALL just work without asking for clarification: "examime <thing>" / "x <thing>" / "look at <thing>" → `examine(<thingId>)`; "n" / "go n" / "head north" / "walk north" → `go(north)`; "i" / "inv" / "what am I carrying" → `inventory`; a partial name when only one item in the view matches → that item; "yes" right after you offered an action → execute that action. Only ask for clarification when the input is GENUINELY ambiguous (e.g. "take the key" when the view actually has two distinct keys). Never refuse for spelling or grammar; never demand the player retype to "spell correctly". The strict rules below are about validating tool ARGUMENTS — they are NOT permission to reject a player who didn't type a perfect string.
- **Engine identifiers are internal — NEVER speak them to the player.** Any `id` field in the view JSON, any tool name or argument that's a lowercase-hyphenated string — these are machine-readable identifiers for the engine, NOT names the player should see. The player sees the `name` field. When you need to disambiguate between options, describe them in plain prose ("the red door or the blue one?") — never list the underlying IDs. **If you find yourself about to type an id-shaped string (lowercase-hyphenated), rewrite it as natural English first.** Same goes for engine internals like "trigger fired", "tool_result" — these belong to the system, not the story.
- **Always call `look` for orientation requests.** When the player asks where they are, what's around them, what they see, or for a description of the room ("look", "look around", "where am I", "describe the room", "what's here", "what do I see", "survey the area"), CALL the `look` tool — even if you described the room in an earlier turn. Triggers may have fired silently between turns (state changes that didn't generate a narration cue), and your prior narration could be stale. The `look` tool returns the current view from the engine; trust it over your memory. Don't paraphrase the room from earlier in the conversation; query fresh.

[… ~30 more bullets, see narrator.ts:155-204 for the full text …]

# Story context
Title: Zork I
Author: Infocom (1980, adapted)

[… story.description and story.systemPromptOverride if present …]
```

---

## Tool list

The narrator passes the following tools to Claude every turn. After the recent collapse of the conditional/always-on tier ([commit 240f32a](../app/src/engine/intents.ts)), all custom tools are exposed every turn for cache stability.

### Built-in tools (11)

Defined as the static `TOOLS` array at [narrator.ts:33-143](../app/src/llm/narrator.ts):

`look`, `examine`, `take`, `drop`, `put`, `inventory`, `go`, `read`, `wait`, `attack`, `board`, `disembark`.

Descriptions are 130-250 chars each, with player-phrasing examples. Sample:

> **`examine`**: *"Examine an item or passage closely. Use for 'examine X', 'x X', 'look at X', 'inspect X'. Pass the id (NOT the display name) of an item from the current view's itemsHere/inventory OR a passage (door, window, gate, archway, etc.) from the current view's passagesHere."*

### Custom tools (45)

Author-defined via `story.customTools`. Includes generic verbs (`open`, `close`, `break`, `light-lamp`, `extinguish-lamp`, `ring-bell`) and puzzle-specific intents (`rope-tied-to-railing`, `say-echo-in-loud-room`, `wave-scepter-at-rainbow`, `feed-cyclops`, `give-egg-to-songbird`, `dig-beach`, `move-the-rug`, etc.). All emitted every turn for cache stability.

Descriptions are author-provided (typically 50-200 chars). Sample:

> **`rope-tied-to-railing`**: *"Player ties, fastens, attaches, lashes, secures, or otherwise affixes the rope to the railing (or to the dome)."*

---

## Conversation history

Each turn appends to `this.history`:

1. User msg: `[Player command] X` (+ optional `[Current view]` block).
2. Assistant msg: `{ role: "assistant", content: [<text blocks>, <tool_use blocks>] }` — kept verbatim including the LLM's prior narration prose.
3. (If Phase 1 had tool_use) User msg with tool_results: `{ role: "user", content: [<tool_result blocks>] }`.
4. Assistant msg: final narration text.

`tool_result` content is the JSON produced by `formatToolResult` ([narrator.ts:610-618](../app/src/llm/narrator.ts)):

```json
{
  "ok": true,
  "event": {
    "type": "moved" | "took" | "examined" | "intent-recorded" | "rejected" | …,
    "description"?: "…",
    "text"?: "…",
    "reason"?: "exit-blocked" | "not-accessible" | …
  },
  "view": { /* full compactView, post-action */ },
  "narrationCues": ["…"],
  "ended"?: { "won": false, "message": "…" }
}
```

**The post-action `view` is always included in tool_results** ([narrator.ts:610-618](../app/src/llm/narrator.ts)) — guarantees the LLM sees fresh state after every action, even when triggers fire from the cascade.

### Trim mechanism

At [narrator.ts:457-472](../app/src/llm/narrator.ts):

- Triggered when `history.length >= maxHistoryMessages + TRIM_CHUNK` (default 100 + 30).
- Drops the oldest 30 messages, snapping to a clean user-turn boundary so no orphan `tool_result` blocks remain.
- Logs: `[narrator] history trim: 130 → 100 messages (drop 30). Prompt cache will reset on next request — expected.`
- Cache busts on trim → next request pays full cache-write cost on the new prefix.

The LLM's own prior narration text stays verbatim in history until trim — self-anchoring across many turns is possible.

---

## What the LLM never sees

By design:

- Items / exits not in the current view (engine pre-filters by visibility, accessibility, and `visibleWhen` conditions).
- Unexamined item descriptions (gated by `state.examinedItems`).
- Container contents when the container is inaccessible.
- Engine internals: `firedTriggers`, raw `flags`, `passageStates`, `roomStates`, `itemStates` (only per-item/passage `state` for items in current view).
- The trigger / handler rule system that produced a given result.
- Save metadata, debug commands, internal IDs in player-facing prose (STYLE rule #4 enforces masking).
