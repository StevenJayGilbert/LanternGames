# Author's Guide — Building Your Own Game

This is a tutorial. It walks you through writing a game from scratch on this engine, using patterns and examples from the Zork I implementation that ships in this repo.

For the schema reference (every field, every type), see [story-format.md](./story-format.md). For what the LLM is told, see [narrator-prompts.md](./narrator-prompts.md). For the canonical TypeScript types, see [`app/src/story/schema.ts`](../app/src/story/schema.ts).

This guide is organized by **what an author actually wants to build**, not by how the engine is structured internally. Skim Part 1 for orientation, then use the cookbook (Part 6) as you go.

---

## Table of contents

- [Part 1: How this engine thinks](#part-1-how-this-engine-thinks)
- [Part 2: Building blocks — rooms, items, passages, exits](#part-2-building-blocks)
- [Part 3: State and gates](#part-3-state-and-gates)
- [Part 4: Triggers — making the world react](#part-4-triggers--making-the-world-react)
- [Part 5: Custom tools — extending the verb namespace](#part-5-custom-tools--extending-the-verb-namespace)
- [Part 6: Cookbook — concrete recipes](#part-6-cookbook--concrete-recipes)
- [Part 7: The narrator — what the LLM sees](#part-7-the-narrator--what-the-llm-sees)
- [Part 8: Workflow — from idea to playable](#part-8-workflow--from-idea-to-playable)
- [Part 9: Reference and next steps](#part-9-reference-and-next-steps)

---

# Part 1: How this engine thinks

## Two halves

This engine has two halves and **you only write one of them**:

```
┌──────────────────┐         ┌──────────────────┐
│  Engine (you)    │         │  LLM (us)        │
│  - rooms, items  │ ───────►│  - reads view    │
│  - state, gates  │  view   │  - parses input  │
│  - triggers      │ ◄───────│  - calls tools   │
│  - custom tools  │  tool   │  - writes prose  │
└──────────────────┘  call   └──────────────────┘
```

You write JSON describing **the world** (rooms, items, what's where, what changes when). The LLM reads the engine's view of the world plus the player's natural-language input, calls engine tools to act, and writes the prose the player sees.

You do NOT write per-scene narration. You author state. The LLM dramatizes whatever the engine reports.

## Why this split

- **Engine guarantees consistency.** Item locations, scoring, win conditions, gate logic — all deterministic. The LLM can't cheat the rules; it can only narrate them.
- **LLM handles fuzziness.** "Open the brass thingy" → `open(mailbox)`. "Look around" → `look`. "i" → `inventory`. "Yes" right after you offered an action → that action. You don't author parsers; the LLM does.
- **Authoring scales.** A typical Zork puzzle is 1–5 triggers + 0–2 customTools + a handful of state mutations. The narrative complexity is unbounded because the LLM provides it.

## Anatomy of a turn

```
Player types: "open the mailbox"

  → Narrator (LLM):
       Reads view. Sees mailbox in itemsHere with state.isOpen=false.
       Calls tool: open(itemId="mailbox")

  → Engine:
       performAction({type:"recordIntent", signalId:"open", args:{itemId:"mailbox"}})
       Records intent in matchedIntents.
       Runs the open-tool handler:
         - Precondition: itemAccessible(mailbox) → true
         - Precondition: itemHasStateKey(mailbox, isOpen) → true
         - Precondition: itemState(mailbox, isOpen, false) → true
         - Effect: setItemState(mailbox, isOpen, true)
         - Success narration: "You open the small mailbox."
       Runs trigger cascade (Phase 1).
         - mailbox-reveal-leaflet trigger fires (gates on isOpen=true).
         - Effect: moveItem(leaflet, mailbox).
         - Trigger narration: "A leaflet is inside."
       Builds new view.
       Returns: event=intent-recorded, cues=["You open...", "A leaflet is inside."], view=...

  → Narrator (LLM):
       Sees cues + new view. Writes:
       "You open the small mailbox. Inside lies a single leaflet."
```

Three things to notice:
- **You authored zero prose for the parser.** The LLM matched "open the mailbox" to your `open` customTool.
- **You authored zero prose for the success.** The handler's `successNarration` was a template; the LLM polished it.
- **The trigger fired automatically.** You wrote `when` + `effects`; the engine watched state and fired when conditions held.

For full prompt details, see [narrator-prompts.md](./narrator-prompts.md). For the engine's three-phase trigger cascade, see [`app/src/engine/engine.ts`](../app/src/engine/engine.ts).

## A complete tiny game

Save this as `tiny-adventure.json` and load it in the app. It's a real, playable story.

```jsonc
{
  "schemaVersion": "0.1",
  "id": "tiny-adventure",
  "title": "The Locked Garden",
  "author": "you",
  "description": "Find the key, open the gate, escape into the garden.",
  "intro": "You wake up in a small cottage. The front door is locked. Find a way out.",
  "startRoom": "cottage",
  "startState": { "score": 0 },
  "rooms": [
    {
      "id": "cottage",
      "name": "Cottage",
      "description": "A one-room cottage. A wooden door leads east. A faded painting hangs over the hearth.",
      "exits": {
        "east": {
          "to": "garden",
          "when": { "type": "hasItem", "itemId": "key" },
          "blockedMessage": "The door is locked. You'll need a key."
        }
      }
    },
    {
      "id": "garden",
      "name": "Garden",
      "description": "Sunlight, birdsong, and a winding path stretching off into the world.",
      "exits": {
        "west": { "to": "cottage" }
      }
    }
  ],
  "items": [
    {
      "id": "painting",
      "name": "faded painting",
      "description": "A landscape, badly faded. There's a small bulge behind the canvas.",
      "location": "cottage",
      "fixed": true
    },
    {
      "id": "key",
      "name": "iron key",
      "description": "A heavy iron key.",
      "location": "nowhere",
      "takeable": true
    }
  ],
  "triggers": [
    {
      "id": "examine-painting-reveals-key",
      "once": true,
      "when": {
        "type": "and",
        "all": [
          { "type": "examined", "itemId": "painting" },
          { "type": "itemAt", "itemId": "key", "location": "nowhere" }
        ]
      },
      "effects": [
        { "type": "moveItem", "itemId": "key", "to": "cottage" }
      ],
      "narration": "Behind the painting, an iron key falls and clatters to the floor."
    },
    {
      "id": "win-on-garden-entry",
      "once": true,
      "afterAction": true,
      "when": { "type": "playerAt", "roomId": "garden" },
      "effects": [
        { "type": "endGame", "won": true, "message": "You stand free in the garden. Adventure complete." }
      ]
    }
  ]
}
```

Play it. The full puzzle: `examine painting` → key drops → `take key` → `go east` → win.

What you wrote: 60 lines of JSON. What the LLM provides: the prose around every interaction. What the engine guarantees: the painting actually drops the key (once), the door is actually locked until you have the key, the game actually ends when you enter the garden.

You now know the model. The rest of this guide is depth.

---

# Part 2: Building blocks

## Rooms

A **room** is a place the player can be. It has an id, a name, a description, and (usually) exits.

```jsonc
{
  "id": "kitchen",
  "name": "Kitchen",
  "description": "A small kitchen with a stove. A door leads east, a trapdoor in the floor leads down.",
  "exits": {
    "east": { "to": "hallway" },
    "down": {
      "to": "cellar",
      "when": { "type": "passageState", "passageId": "trapdoor", "key": "isOpen", "equals": true },
      "blockedMessage": "The trapdoor is closed.",
      "passage": "trapdoor"
    }
  },
  "state": { "dark": false }
}
```

Three things to notice:
- The **description** is canonical. Don't write "the trapdoor is closed" in the description text — the door's STATE changes; baking it in goes stale. Use **variants** for state-driven prose changes.
- **Exits** are a map of `direction → exit`. Direction names are free-form lowercase; the LLM and parser both understand cardinals (`north`/`south`/...), `up`/`down`, `in`/`out`, etc. Use whatever fits your map.
- **State** on a room is for global-ish flags about the room itself (e.g. `dark`, `flooded`). For one-off puzzle flags, use `Story.startState`.

### Room variants

When the room's prose should change with state, write `variants`:

```jsonc
"variants": [
  {
    "when": { "type": "flag", "key": "stove_on", "equals": true },
    "text": "A small kitchen. The stove glows red. A door leads east."
  }
]
```

First match wins; falls back to `description`. Use variants for **persistent** state changes (window open, fire lit, room flooded). For **transient** state-change cues, use trigger narration instead.

### Room narratorNote

Engine-side guidance for the LLM, never quoted to the player:

```jsonc
"narratorNote": "When narrating items 'on' the kitchen counter, treat them as resting on the work surface."
```

Use sparingly. Most rooms don't need one.

## Items

The biggest schema. Items model takeable objects, scenery, NPCs, containers, light sources, vehicles — anything with a position and/or state.

```jsonc
{
  "id": "lantern",
  "name": "brass lantern",
  "description": "A battered brass lantern. It looks like it still works.",
  "appearance": "A brass lantern sits on the floor, dark and cold.",
  "appearanceVariants": [
    {
      "when": { "type": "itemState", "itemId": "lantern", "key": "isLit", "equals": true },
      "text": "A brass lantern glows steadily on the floor."
    }
  ],
  "location": "kitchen",
  "takeable": true,
  "tags": ["light-source", "carryable"],
  "state": { "isLit": false, "batteryTurns": 330 },
  "lightSource": {}
}
```

### `appearance` vs `description` vs `variants` vs `appearanceVariants`

These four fields confuse first-time authors. The distinction:

| Field | Surfaced when | Use for |
|---|---|---|
| `description` | Player runs `examine` | The "look closely" text. Rich, detailed. |
| `variants` | Same as description, when state-conditional | State-aware examine text (sword-glowing-in-presence-of-enemies). |
| `appearance` | Player is in the same room (every turn) | A short room-presence line ("A brass lantern sits on the floor"). |
| `appearanceVariants` | Same as appearance, when state-conditional | State-aware room-presence ("dark and cold" vs "glows steadily"). |

Don't confuse them. The LLM uses `appearance` to weave the item into the room narration ("you see X here"); it uses `description` to answer `examine X`.

### `location` — where the item starts

| Value | Meaning |
|---|---|
| `"<roomId>"` | At that room. |
| `"<itemId>"` | Inside that item (must be a container). |
| `"player"` | In the player's inventory at game start. |
| `"inventory"` | Legacy alias for `"player"`. The engine normalizes; new stories should use `"player"`. |
| `"nowhere"` | Not in play. Reveal later via a trigger's `moveItem` effect. |

### `appearsIn` — shared scenery

For an item that should be **perceivable** from multiple rooms without physically being in all of them. Used for:
- A window visible from inside AND outside.
- A statue visible from the courtyard AND the balcony.
- A basket on a chain visible from both ends of a shaft.

```jsonc
"appearsIn": ["lower-shaft"]
```

The item is in its `location` room AND additionally appears in every room listed in `appearsIn`. **Critical**: only the item itself is perceivable from `appearsIn` rooms — its CONTENTS stay with the actual location. If a basket is at shaft-room with coal inside, and `appearsIn: ["lower-shaft"]`, the player at lower-shaft sees the basket but NOT the coal.

`appearsIn` is only meaningful for `fixed` items.

### `tags` — classification

Free-form labels for cross-cutting categories: `["weapon", "sword", "bladed"]`, `["enemy", "troll"]`, `["treasure"]`. Matched by `itemHasTag` / `flagItemHasTag` / `inventoryHasTag` Conditions. Use to gate triggers without enumerating ids:

```jsonc
"when": { "type": "inventoryHasTag", "tag": "weapon" }
```

### Capabilities — `lightSource`, `vehicle`, `container`, `readable`

Marker fields that opt the item into specific behaviors:

```jsonc
"lightSource": {},                                    // can emit light when state.isLit is true
"vehicle": { "mobile": true },                        // player can BOARD/DISEMBARK
"container": { "capacity": 5, "accessibleWhen": ... }, // holds other items
"readable": { "text": "..." }                         // surfaces via the read customTool
```

The capabilities don't conflict. A treasure chest is a container; a lit lantern is a light source AND carryable; a magic carpet is a vehicle. Combine freely.

### `narratorNote` and `personality`

Two LLM-facing fields:

- **`narratorNote`** — engine-side guidance the LLM follows silently. "Treat anything 'in' this as on the surface." "Describe in past tense." Never quoted.
- **`personality`** — NPC voice. The LLM speaks the entity in character. Use for talking entities (troll, cyclops, songbird).

## Passages

A **passage** is a named connector between exactly two rooms — door, window, archway, hatch, gate, narrow gap, magic portal, chimney. Use passages when the connector itself has identity (player can `examine` it, `open` it, look through it). Use plain exits for unnamed direction-only links.

```jsonc
{
  "id": "kitchen-window",
  "name": "kitchen window",
  "description": "A small grimy window that latches from the inside.",
  "sides": [
    { "roomId": "east-of-house", "name": "small window" },
    { "roomId": "kitchen",       "name": "kitchen window" }
  ],
  "state": { "isOpen": false },
  "traversableWhen": {
    "type": "passageState",
    "passageId": "kitchen-window",
    "key": "isOpen",
    "equals": true
  },
  "traverseBlockedMessage": "The window is closed.",
  "glimpse": {
    "when": { "type": "always" },
    "description": "Through the glass you see the kitchen — a chipped table, a dim lamp."
  }
}
```

A passage has:
- Two **sides**, each with its own `roomId` and optional per-side overrides (`name`, `description`, `glimpse`, `traversableWhen`).
- Optional **state** (e.g. `isOpen: false`) like an item.
- Optional **glimpse** — declares "this is see-through" + content shown when looked through. A window's glimpse is always-on; a hatch's glimpse activates when open.
- Optional **traversableWhen** + **traverseBlockedMessage** — refused traversal with a story-specific reason.

Exits reference passages by id:

```jsonc
"exits": {
  "in": { "to": "kitchen", "passage": "kitchen-window" }
}
```

When the player tries to traverse, the engine evaluates the passage's `traversableWhen` (per-side, falling back to passage-level). The engine auto-generates `open(kitchen-window)` and `close(kitchen-window)` customTools whenever a passage has `state.isOpen` defined.

## Exits

The two simple cases:

```jsonc
"east": { "to": "hallway" }                    // unconditional
"east": {                                       // gated
  "to": "hallway",
  "when": { "type": "flag", "key": "door-open", "equals": true },
  "blockedMessage": "The door is locked."
}
```

Three less-obvious patterns:

**Hidden exit** (suppressed from view until the gate is satisfied — for secret passages, mid-puzzle reveals):

```jsonc
"down": {
  "to": "cellar",
  "hidden": true,
  "when": { "type": "flag", "key": "trapdoor-found", "equals": true }
}
```

**Toggle suppression** (use `hidden: true` to keep the LLM from dramatizing exit-blocked-vs-not toggles between turns; pair with a trigger that emits the canonical refusal text on attempt — see the [movement-blocked thematic refusal](#movement-blocked-thematic-refusal) recipe):

```jsonc
"west": {
  "to": "lower-shaft",
  "hidden": true,
  "when": { "type": "flag", "key": "empty-handed", "equals": true }
}
```

**Passage-gated exit** (let a passage's `traversableWhen` do the gating):

```jsonc
"in": { "to": "kitchen", "passage": "kitchen-window" }
```

## Templates

If you have many similar items (six treasures, ten torches), declare a template once and reference it:

```jsonc
"templates": {
  "treasure": {
    "tags": ["treasure", "valuable", "carryable"],
    "takeable": true
  }
}
```

```jsonc
{
  "id": "platinum-bar",
  "name": "platinum bar",
  "description": "A shining bar of pure platinum.",
  "location": "loud-room",
  "fromTemplate": "treasure"
}
```

Templates are resolved at extract time; the engine never sees them. Item fields override template fields; arrays union (dedupe by JSON string).

---

# Part 3: State and gates

State is what makes an interactive world interactive. The engine tracks it; you author rules that read and mutate it.

## Five state primitives

| Primitive | Stored in | Use for |
|---|---|---|
| **Flags** | `state.flags[key]` | Global game state: scoring, won-flag, ritual-completed flag, named "this happened" markers. |
| **Item state** | `state.itemStates[itemId][key]` | Per-item typed state: `isOpen`, `isLit`, `isLocked`, `broken`, `batteryTurns`, custom-by-author. |
| **Room state** | `state.roomStates[roomId][key]` | Per-room state: `dark`, `flooded`, `windowOpen`. |
| **Passage state** | `state.passageStates[passageId][key]` | Per-passage state: `isOpen`, `isLocked`. |
| **Engine sets** | `visitedRooms`, `examinedItems`, `matchedIntents`, `firedTriggers` | Auto-tracked. Read via `visited`, `examined`, `intentMatched`, `triggerFired` Conditions. |

Authoring guideline: keep state **near where it conceptually lives**. The trapdoor's open/closed state belongs on the trapdoor passage, not on a global flag. The lantern's batteryTurns belongs on the lantern item. Use flags for genuinely global facts (score, ritual completed, won).

### Setting initial state

- **Flags**: `Story.startState`.
- **Item state**: `Item.state` field. Initialized from this at game start.
- **Room state**: `Room.state` field.
- **Passage state**: `Passage.state` field.

```jsonc
"startState": { "score": 0 },
"items": [
  {
    "id": "lantern",
    "state": { "isLit": false, "batteryTurns": 330 }
  }
]
```

## Conditions — gating on state

Conditions are boolean expressions. They appear in: exit gates, text variants, trigger `when`, customTool preconditions, vehicle gates, container gates, glimpse activation, visibility gates.

The full table is in [story-format.md#conditions](./story-format.md#conditions). Here are the ones you'll use most:

| Pattern | Condition |
|---|---|
| "the player is in this room" | `{ type: "playerAt", roomId: "..." }` |
| "the player has this item" | `{ type: "hasItem", itemId: "..." }` |
| "this flag is set" | `{ type: "flag", key: "...", equals: true }` |
| "this item's state field is X" | `{ type: "itemState", itemId: "...", key: "...", equals: ... }` |
| "the player examined this item before" | `{ type: "examined", itemId: "..." }` |
| "this trigger has fired" | `{ type: "triggerFired", triggerId: "..." }` |
| "they tried to go west" (built-in intent) | `{ type: "intentMatched", signalId: "go" }` + `{ type: "intentArg", signalId: "go", key: "direction", equals: "west" }` |

Compose with `and` / `or` / `not`:

```jsonc
{
  "type": "and",
  "all": [
    { "type": "playerAt", "roomId": "shaft-room" },
    { "type": "itemState", "itemId": "basket", "key": "position", "equals": "raised" },
    { "type": "not", "condition": { "type": "flag", "key": "basket-busy", "equals": true } }
  ]
}
```

Nest as deep as you need.

### Numeric comparisons

For "this counter is greater than N" patterns, use `compare` with a NumericExpr:

```jsonc
{
  "type": "compare",
  "left":  { "kind": "itemState", "itemId": "match", "key": "matchesRemaining" },
  "op":    ">",
  "right": { "kind": "literal", "value": 0 }
}
```

NumericExpr kinds: `literal`, `flag`, `passageState`, `itemState`, `roomState`, `inventoryCount`, `itemCountAt`, `matchedIntentsCount`, `visitedCount`. Operators: `==`, `!=`, `<`, `<=`, `>`, `>=`.

## IdRef — referencing args inside a tool handler

Inside a customTool handler, you can write `{ fromArg: "itemId" }` instead of a hardcoded id, and the engine substitutes the call's args at runtime:

```jsonc
"preconditions": [
  {
    "when": { "type": "itemAccessible", "itemId": { "fromArg": "itemId" } },
    "failedNarration": "You don't see {arg.itemId.name} here."
  }
]
```

This is what makes generic verbs possible. One handler, any item.

Outside handlers, use plain string ids.

---

# Part 4: Triggers — making the world react

A **trigger** watches state and fires effects when its `when` becomes true. Triggers are how puzzles progress, how the world changes between turns, how you write death conditions, scoring, NPC behavior, and most consequence-of-player-action logic.

## Anatomy

```jsonc
{
  "id": "examine-painting-reveals-key",
  "when": {
    "type": "and",
    "all": [
      { "type": "examined", "itemId": "painting" },
      { "type": "itemAt", "itemId": "key", "location": "nowhere" }
    ]
  },
  "once": true,
  "priority": 0,
  "afterAction": false,
  "effects": [
    { "type": "moveItem", "itemId": "key", "to": "cottage" }
  ],
  "narration": "Behind the painting, an iron key falls and clatters to the floor."
}
```

Five fields shape behavior:

- **`when`** — Condition. The trigger fires when this is true.
- **`once`** — defaults to `true`. Set `false` for re-fireable triggers (timers, recurring encounters).
- **`priority`** — sort order within a pass. Higher fires first. Default 0. See [priority bands](#priority-bands).
- **`afterAction`** — if `true`, fires in Phase 2 (one pass per turn). Combine with `once: false` for true tick behavior.
- **`effects`** — state mutations applied in order on fire.
- **`narration`** — cue queued into the LLM's next response. The LLM weaves cues into prose. Optional; cue-less triggers are silent state changes.

## The cascade

After every player action, the engine runs triggers in three phases:

1. **Phase 1**: Regular triggers in a fixed-point loop. Each pass evaluates every trigger; fired triggers may flip state that activates more triggers, so the loop re-runs until state is stable.
2. **Phase 2**: AfterAction triggers. One pass, at most once each per turn. Used for ticks (lamp battery drain, grue countdown, dam timer).
3. **Phase 3**: Regular triggers again, in case Phase 2 mutated state.

Within each pass, triggers fire in **priority order** (higher first; ties keep authored array order).

The engine bails after `MAX_TRIGGER_ITERATIONS` (100) to prevent runaway cycles. If you write two triggers that flip each other's gates, the engine logs a warning and stops.

## Priority bands

Recommended convention:

| Band | Use for |
|---|---|
| 100+ | Status-aware overrides ("rusty knife possesses attacker"). |
| 50–99 | Specific-id triggers ("light candles AT entrance-to-hades shows the cower cue"). |
| 10–49 | Class-based triggers (any sword swing). |
| 0 | Default. |
| -10 to -99 | Catchall cleanup (intent that didn't match a specific success path). |
| -100 | Last-resort fallback. |

Combine priority with the **consume-the-flag pattern**: high-priority trigger fires, applies effects, calls `removeMatchedIntent` (or sets a sentinel flag) so lower-priority catchalls see the cleared state and short-circuit.

## Effects

Effects mutate state. Run in order. Full table in [story-format.md#effects](./story-format.md#effects). Most-used:

| Effect | What it does |
|---|---|
| `setFlag` | `state.flags[key] = value` |
| `moveItem` | move item to a roomId / itemId / `"player"` / `"nowhere"` |
| `setItemState` | mutate per-item state |
| `setPassageState` / `setRoomState` | per-passage / per-room state |
| `adjustFlag` / `adjustItemState` | signed delta on a numeric value (treats unset as 0) |
| `removeMatchedIntent` | un-match an intent so its triggers don't re-fire |
| `narrate` | append text to narrationCues (use inside `if`/`then` for branch-specific prose) |
| `if` / `then` / `else` | conditional effect chains within one trigger |
| `setFlagRandom` | roll a uniform random integer in `[min, max]` and write to a flag |
| `endGame` | end the game (`won` distinguishes success from death) |

### The `narrate` Effect

`narrate` lets one trigger emit different prose per branch:

```jsonc
"effects": [
  { "type": "setItemState", "itemId": "lamp", "key": "isLit", "value": true },
  {
    "type": "if",
    "if": { "type": "compare", "left": { "kind": "itemState", "itemId": "lamp", "key": "batteryTurns" }, "op": ">", "right": { "kind": "literal", "value": 0 } },
    "then": [{ "type": "narrate", "text": "The lantern flickers on, casting a warm glow." }],
    "else": [
      { "type": "setItemState", "itemId": "lamp", "key": "isLit", "value": false },
      { "type": "narrate", "text": "The lantern's battery is dead." }
    ]
  }
]
```

Without `narrate` you'd need TWO triggers (one per branch). With `narrate`, one trigger handles both.

## Common patterns

### State machine

A trigger sets a flag; downstream triggers gate on the flag. The cascade lets multiple triggers fire from one player action.

```jsonc
// Trigger 1: pull lever sets gate-open
{
  "id": "pull-lever",
  "when": { "type": "intentMatched", "signalId": "pull-lever" },
  "effects": [
    { "type": "setFlag", "key": "gate-open", "value": true },
    { "type": "removeMatchedIntent", "signalId": "pull-lever" }
  ],
  "narration": "The lever clicks into place."
}

// Trigger 2: gate-open reveals the path (fires same turn via cascade)
{
  "id": "gate-opens-reveal-path",
  "once": true,
  "when": { "type": "flag", "key": "gate-open", "equals": true },
  "effects": [
    { "type": "moveItem", "itemId": "treasure", "to": "vault" }
  ],
  "narration": "Beyond the gate, a treasure glints in the gloom."
}
```

### One-shot reveal

`once: true` (the default) ensures the trigger fires at most once per game.

```jsonc
{
  "id": "first-time-cellar-warning",
  "once": true,
  "when": { "type": "playerAt", "roomId": "cellar" },
  "narration": "The damp air bites. Something scuffles in the corner."
}
```

### Soft-fail (success + fallback pattern)

When a player action might succeed OR have a thematic refusal, write TWO triggers:

```jsonc
// High-priority success path
{
  "id": "ring-bell-summons-helper",
  "priority": 0,
  "when": {
    "type": "and",
    "all": [
      { "type": "intentMatched", "signalId": "ring-bell" },
      { "type": "playerAt", "roomId": "courtyard" }
    ]
  },
  "effects": [
    { "type": "moveItem", "itemId": "helper", "to": "courtyard" },
    { "type": "removeMatchedIntent", "signalId": "ring-bell" }
  ],
  "narration": "A figure approaches from the shadows."
}

// Low-priority catchall
{
  "id": "ring-bell-no-effect",
  "priority": -10,
  "once": false,
  "when": { "type": "intentMatched", "signalId": "ring-bell" },
  "effects": [
    { "type": "removeMatchedIntent", "signalId": "ring-bell" }
  ],
  "narration": "The bell rings out. Nothing happens."
}
```

The success trigger fires first (higher priority), consumes the matched intent. If the success conditions weren't met, the catchall fires and emits the "nothing happens" cue.

### Tick triggers

For per-turn ticking (timers, drains, NPC wandering), use `afterAction: true` + `once: false`:

```jsonc
// Lamp battery drains 1 turn while lit
{
  "id": "lamp-burns-fuel",
  "afterAction": true,
  "once": false,
  "when": {
    "type": "and",
    "all": [
      { "type": "itemState", "itemId": "lamp", "key": "isLit", "equals": true },
      { "type": "compare", "left": { "kind": "itemState", "itemId": "lamp", "key": "batteryTurns" }, "op": ">", "right": { "kind": "literal", "value": 0 } }
    ]
  },
  "effects": [
    { "type": "adjustItemState", "itemId": "lamp", "key": "batteryTurns", "by": -1 }
  ]
}

// Auto-extinguish on hit-zero
{
  "id": "lamp-runs-out",
  "afterAction": true,
  "once": true,
  "when": {
    "type": "and",
    "all": [
      { "type": "itemState", "itemId": "lamp", "key": "isLit", "equals": true },
      { "type": "compare", "left": { "kind": "itemState", "itemId": "lamp", "key": "batteryTurns" }, "op": "<=", "right": { "kind": "literal", "value": 0 } }
    ]
  },
  "effects": [
    { "type": "setItemState", "itemId": "lamp", "key": "isLit", "value": false }
  ],
  "narration": "Your lamp dims, flickers, and goes dark."
}
```

### Death

```jsonc
{
  "id": "drink-poison-dies",
  "once": true,
  "when": { "type": "intentMatched", "signalId": "drink-poison" },
  "effects": [
    { "type": "endGame", "won": false, "message": "You crumple, foaming. The chalice falls from your fingers." }
  ]
}
```

### Win

```jsonc
{
  "id": "treasure-deposit-wins",
  "once": true,
  "afterAction": true,
  "when": {
    "type": "compare",
    "left":  { "kind": "flag", "key": "score" },
    "op":    ">=",
    "right": { "kind": "literal", "value": 350 }
  },
  "effects": [
    { "type": "endGame", "won": true, "message": "Your treasures shine in the trophy case. You have won." }
  ]
}
```

A story without any `endGame` trigger is sandbox-mode and never ends on its own.

---

# Part 5: Custom tools — extending the verb namespace

The engine ships with 11 **built-in actions**: `look`, `examine`, `take`, `drop`, `put`, `inventory`, `go`, `wait`, `attack`, `board`, `disembark`. For everything else — `open`, `close`, `read`, `light`, `extinguish`, `push`, `turn`, `give`, `pray`, `ring`, `dig`, `wave`, `rub`, `tie`, `pour`, `sing`, `kiss`, `talk-to-X`, your-custom-verb-here — you author **customTools**.

A customTool is a tool the LLM can call. The LLM matches the player's input against your tool's `description` and calls it with structured args. The engine runs your handler (preconditions + effects + success narration) and the cascade.

## Anatomy

```jsonc
{
  "id": "open",
  "description": "Player opens, pulls open, lifts the lid of, or unlatches an item or passage. Pass the id from the current view's itemsHere or passagesHere.",
  "args": {
    "type": "object",
    "properties": {
      "itemId": { "type": "string", "description": "id of the item or passage to open" }
    },
    "required": ["itemId"]
  },
  "alwaysAvailable": true,
  "handler": {
    "preconditions": [
      {
        "when": { "type": "itemAccessible", "itemId": { "fromArg": "itemId" } },
        "failedNarration": "You don't see {arg.itemId.name} here."
      },
      {
        "when": { "type": "itemHasStateKey", "itemId": { "fromArg": "itemId" }, "key": "isOpen" },
        "failedNarration": "{arg.itemId.name} isn't something you can open."
      },
      {
        "when": { "type": "itemState", "itemId": { "fromArg": "itemId" }, "key": "isOpen", "equals": false },
        "failedNarration": "{arg.itemId.name} is already open."
      }
    ],
    "effects": [
      { "type": "setItemState", "itemId": { "fromArg": "itemId" }, "key": "isOpen", "value": true }
    ],
    "successNarration": "You open {arg.itemId.name}."
  }
}
```

Three pieces:

- **`description`** — what the LLM reads to decide which tool matches the player input. Be specific. List synonyms. The LLM's matching is good but it's not a mind-reader.
- **`args`** — JSON-schema-style declaration of parameters. Most custom tools take an `itemId`; some take a `direction`, a `targetId`, etc.
- **`handler`** (optional) — declarative response. Preconditions evaluate top-down; first failure short-circuits with `failedNarration`. Effects apply in order on success; `successNarration` emits as a cue.

## When to use a customTool

Add a customTool when:
- The verb is something the player would type (`pray`, `dig`, `give`).
- It needs structured args the LLM can't fudge.
- You want puzzle triggers to react to the verb (via `intentMatched` + `intentArg`).

Don't add a customTool when:
- The built-in covers it (`take`, `drop`, `examine`, `go`, `attack`).
- The verb is purely flavor and the LLM can ad-lib (`smell`, `listen`, `sing`).

## Generic verb pattern (read, light, extinguish)

For verbs that work on **many** items with item-specific behavior, write ONE tool with generic preconditions, then per-item triggers handle specifics. Example: `read(itemId)`.

```jsonc
{
  "id": "read",
  "description": "Read the contents of an item with readable text — book pages, leaflet, prayer inscription, matchbook cover, etc. Pass the id of an item from the current view.",
  "args": {
    "type": "object",
    "properties": { "itemId": { "type": "string" } },
    "required": ["itemId"]
  },
  "alwaysAvailable": true,
  "handler": {
    "preconditions": [
      {
        "when": { "type": "itemAccessible", "itemId": { "fromArg": "itemId" } },
        "failedNarration": "You don't see {arg.itemId.name} here."
      },
      {
        "when": { "type": "itemReadable", "itemId": { "fromArg": "itemId" } },
        "failedNarration": "{arg.itemId.name} has nothing to read."
      }
    ],
    "successNarration": "{arg.itemId.readable.text}"
  }
}
```

Any item with a `readable.text` field works. For special cases — reading the prayer book at the entrance to Hades has a side effect — write a trigger:

```jsonc
{
  "id": "lld-ritual-completes",
  "when": {
    "type": "and",
    "all": [
      { "type": "intentMatched", "signalId": "read" },
      { "type": "intentArg", "signalId": "read", "key": "itemId", "equals": "book" },
      { "type": "playerAt", "roomId": "entrance-to-hades" },
      { "type": "itemState", "itemId": "bell", "key": "rangAtHades", "equals": true },
      { "type": "itemState", "itemId": "candles", "key": "isLit", "equals": true },
      { "type": "flag", "key": "lld-flag", "equals": false }
    ]
  },
  "effects": [
    { "type": "setFlag", "key": "lld-flag", "value": true },
    { "type": "removeMatchedIntent", "signalId": "read" }
  ],
  "narration": "Each word of the prayer reverberates through the hall..."
}
```

The handler is generic. The trigger handles the puzzle. This is the **pattern**: one generic tool + N per-item triggers.

## Intent recording

Both customTool calls AND built-in actions populate `state.matchedIntents` after dispatch (regardless of success/failure). This means you can write a trigger that fires when the player tries to `go west`:

```jsonc
{
  "id": "timber-room-too-loaded",
  "when": {
    "type": "and",
    "all": [
      { "type": "intentMatched", "signalId": "go" },
      { "type": "intentArg", "signalId": "go", "key": "direction", "equals": "west" },
      { "type": "playerAt", "roomId": "timber-room" },
      { "type": "flag", "key": "empty-handed", "equals": false }
    ]
  },
  "effects": [
    { "type": "removeMatchedIntent", "signalId": "go" }
  ],
  "narration": "Your load is too great. The passage west narrows to a slit barely a person's width."
}
```

Built-in signalIds: `look`, `examine`, `take`, `drop`, `put`, `inventory`, `go`, `wait`, `attack`, `board`, `disembark`. Args mirror the action's input fields. **Triggers gating on a built-in intent should call `removeMatchedIntent` to consume it** — otherwise the matched flag persists across turns and the trigger may re-fire when its other gates align.

## Reserved names

Never use a built-in action name as a customTool id. The validator refuses these. The engine reserves: `look`, `examine`, `take`, `drop`, `put`, `inventory`, `go`, `wait`, `attack`, `board`, `disembark`.

## Triggers vs handlers

Both can react to a tool call. Choose by the kind of refusal:

| Use a **handler precondition** for | Use a **trigger** for |
|---|---|
| Verb-intrinsic refusal: "X isn't something you can read" | Puzzle-state refusal: "the prayer doesn't work without the bell rung" |
| Universal gate: "you don't see X here" | Multi-condition gate: "X + Y + Z must all be true" |
| Synchronous user feedback before any cascade | Side effects that should fire after the dispatch + cascade settle |
| Author wants ONE clear failure message per case | Author needs to compose state + emit narration + mutate things |

Generic verbs typically have BOTH: a handler with universal preconditions + per-item triggers for special cases.

---

# Part 6: Cookbook — concrete recipes

Each recipe is a real puzzle pattern from the Zork I implementation. The shape: (1) the puzzle in plain English, (2) the JSON, (3) what the LLM sees and how it'll narrate.

## Locked door

**Puzzle**: door is locked. Player needs the key. Once unlocked, player passes through.

```jsonc
{
  "id": "trapdoor",
  "name": "trapdoor",
  "description": "A heavy wooden trapdoor in the floor.",
  "sides": [
    { "roomId": "kitchen", "name": "trapdoor (in floor)" },
    { "roomId": "cellar",  "name": "trapdoor (in ceiling)" }
  ],
  "state": { "isOpen": false, "isLocked": true },
  "traversableWhen": {
    "type": "passageState", "passageId": "trapdoor", "key": "isOpen", "equals": true
  },
  "traverseBlockedMessage": "The trapdoor is closed."
}
```

```jsonc
// customTool: unlock-trapdoor
{
  "id": "unlock-trapdoor",
  "description": "Player unlocks, picks, or opens the lock on the trapdoor (with a key).",
  "alwaysAvailable": true,
  "handler": {
    "preconditions": [
      {
        "when": { "type": "playerAt", "roomId": "kitchen" },
        "failedNarration": "There's no trapdoor here."
      },
      {
        "when": { "type": "hasItem", "itemId": "trapdoor-key" },
        "failedNarration": "You'd need a key."
      },
      {
        "when": { "type": "passageState", "passageId": "trapdoor", "key": "isLocked", "equals": true },
        "failedNarration": "The trapdoor is already unlocked."
      }
    ],
    "effects": [
      { "type": "setPassageState", "passageId": "trapdoor", "key": "isLocked", "value": false }
    ],
    "successNarration": "The lock clicks open."
  }
}
```

The auto-generated `open(trapdoor)` customTool now works (since `isLocked` is false). Or write a tighter `open` override in your story that gates on `isLocked`.

What the LLM sees: an `open` tool that turns the trapdoor's `isOpen` from false to true. An `unlock-trapdoor` tool that requires the key. The player types "unlock the door with the key" → LLM calls `unlock-trapdoor` → succeeds → "the lock clicks open." Then the player types "open the trapdoor" → `open(trapdoor)` succeeds.

## Light source + dark room

**Puzzle**: cellar is dark. Player needs the lantern lit to see anything.

```jsonc
// Story-level visibility gate
"defaultVisibility": {
  "type": "or",
  "any": [
    { "type": "not", "condition": { "type": "currentRoomState", "key": "dark", "equals": true } },
    { "type": "anyPerceivableItemWith", "key": "isLit", "equals": true }
  ]
}
```

```jsonc
// Cellar room
{
  "id": "cellar",
  "name": "Cellar",
  "description": "A damp cellar.",
  "state": { "dark": true }
}
```

```jsonc
// Lantern item
{
  "id": "lantern",
  "name": "brass lantern",
  "description": "A battered brass lantern.",
  "appearance": "A brass lantern sits on the floor.",
  "appearanceVariants": [
    {
      "when": { "type": "itemState", "itemId": "lantern", "key": "isLit", "equals": true },
      "text": "A brass lantern glows steadily on the floor."
    }
  ],
  "location": "cottage",
  "takeable": true,
  "tags": ["light-source"],
  "state": { "isLit": false },
  "lightSource": {}
}
```

The story-level `defaultVisibility` is the canonical Zork dark-room model: an object is visible iff the room is NOT dark, OR the player can perceive any lit item. Set `room.state.dark: true` for any dark room. Give every light source `lightSource: {}` + `state.isLit: false`.

Use a `light(lantern)` customTool (or a generic `light(itemId)`) to flip `isLit` to true. Once lit, the cellar becomes perceivable.

**Important**: items the player is **carrying** bypass `defaultVisibility` — the player can always feel for things in their pocket. That's why `light(lantern)` works even in pitch black.

## Container that gates on state (closed chest)

**Puzzle**: a chest holds a treasure. Closed initially. Player must open it to take the treasure.

```jsonc
{
  "id": "chest",
  "name": "wooden chest",
  "description": "A heavy wooden chest with iron bands.",
  "appearance": "A wooden chest sits in the corner.",
  "location": "vault",
  "fixed": true,
  "state": { "isOpen": false },
  "container": {
    "capacity": 10,
    "accessibleWhen": { "type": "itemState", "itemId": "chest", "key": "isOpen", "equals": true },
    "accessBlockedMessage": "The chest is closed."
  }
}
```

```jsonc
// Treasure inside
{
  "id": "ruby",
  "name": "ruby",
  "description": "A blood-red ruby.",
  "location": "chest",
  "takeable": true,
  "tags": ["treasure"]
}
```

The auto-generated `open(chest)` customTool toggles `state.isOpen`. Until the chest is open, the ruby is inaccessible — `take(ruby)` fails with "The chest is closed." Once open, `take(ruby)` works.

Containers like baskets and bags that don't lock or close don't need `accessibleWhen` at all — omit it for always-accessible.

## Vehicle (boat / cart / mount)

**Puzzle**: an inflatable boat. Player must inflate it (with a pump) before boarding. Once inflated, the boat is mobile — `go(direction)` carries the boat too.

```jsonc
{
  "id": "boat",
  "name": "magic boat",
  "description": "A flat plastic envelope with a tan label and a punctured-then-patched seam.",
  "appearance": "A flat plastic envelope lies here.",
  "appearanceVariants": [
    {
      "when": { "type": "itemState", "itemId": "boat", "key": "inflated", "equals": true },
      "text": "A bright yellow inflated boat sits ready on the bank."
    }
  ],
  "location": "shore",
  "fixed": true,
  "state": { "inflated": false },
  "vehicle": {
    "mobile": true,
    "enterableWhen": { "type": "itemState", "itemId": "boat", "key": "inflated", "equals": true },
    "enterBlockedMessage": "The boat is deflated; you'd sink instantly."
  }
}
```

```jsonc
// inflate-boat customTool — sets inflated=true
{
  "id": "inflate-boat",
  "description": "Player inflates, blows up, or pumps up the boat (typically with a pump).",
  "alwaysAvailable": true,
  "handler": {
    "preconditions": [
      {
        "when": { "type": "hasItem", "itemId": "pump" },
        "failedNarration": "You'd need a pump."
      },
      {
        "when": { "type": "itemState", "itemId": "boat", "key": "inflated", "equals": false },
        "failedNarration": "The boat is already inflated."
      }
    ],
    "effects": [
      { "type": "setItemState", "itemId": "boat", "key": "inflated", "value": true }
    ],
    "successNarration": "You pump the boat full of air. It rises into a sturdy yellow raft."
  }
}
```

The player types "pump up the boat" → `inflate-boat` fires → `state.inflated = true`. Then "get in the boat" → `board(boat)` → enterableWhen evaluates true → the player is now "in" the boat. Then "go south" → `go(south)` succeeds → both player AND boat move to the next room (because `vehicle.mobile = true`).

To check "the player is currently in a vehicle" for trigger gating, use `Condition.inVehicle`. To check a specific vehicle, `{ type: "inVehicle", itemId: "boat" }`.

## NPC that talks (personality-driven)

```jsonc
{
  "id": "troll",
  "name": "troll",
  "description": "A nasty-looking troll, brandishing a bloody axe.",
  "appearance": "A nasty-looking troll, brandishing a bloody axe, blocks all passages out of the room.",
  "location": "troll-room",
  "fixed": true,
  "tags": ["enemy", "troll"],
  "state": { "alive": true, "aggravation": 0 },
  "personality": "A vile, blood-thirsty troll with the IQ of a goldfish. Speaks in growls and grunts. Easily provoked. Sometimes laughs at its own threats."
}
```

```jsonc
{
  "id": "talk-to-troll",
  "description": "Player tries to talk to, address, ask, shout at, insult, threaten, bargain with, or otherwise engage the troll conversationally.",
  "alwaysAvailable": true
}
```

```jsonc
{
  "id": "troll-aggravates",
  "once": false,
  "when": {
    "type": "and",
    "all": [
      { "type": "intentMatched", "signalId": "talk-to-troll" },
      { "type": "itemState", "itemId": "troll", "key": "alive", "equals": true }
    ]
  },
  "effects": [
    { "type": "adjustItemState", "itemId": "troll", "key": "aggravation", "by": 1 },
    { "type": "removeMatchedIntent", "signalId": "talk-to-troll" }
  ]
}

{
  "id": "troll-snaps",
  "priority": 50,
  "once": true,
  "when": {
    "type": "compare",
    "left":  { "kind": "itemState", "itemId": "troll", "key": "aggravation" },
    "op":    ">=",
    "right": { "kind": "literal", "value": 3
  }},
  "narration": "The troll's eyes go red. With a guttural roar, he swings the axe."
}
```

The LLM sees `personality` and speaks the troll in character. Each "talk" attempt bumps `aggravation`; at threshold the troll snaps. The narrator handles all the actual dialogue prose; you author the structure.

## Item that's a finite resource (matches)

```jsonc
{
  "id": "match",
  "name": "matchbook",
  "description": "A matchbook holding a few matches.",
  "location": "lobby",
  "takeable": true,
  "state": { "matchesRemaining": 5, "isLit": false }
}
```

```jsonc
// In a generic light(itemId) tool's handler effects:
{ "type": "adjustItemState", "itemId": "match", "key": "matchesRemaining", "by": -1 }
```

The `adjustItemState` Effect treats unset values as 0, so you don't need to initialize. Use `compare` against the value to gate "you've burned all your matches" refusals:

```jsonc
{
  "when": {
    "type": "compare",
    "left":  { "kind": "itemState", "itemId": "match", "key": "matchesRemaining" },
    "op":    "<=",
    "right": { "kind": "literal", "value": 0 }
  },
  "narration": "The matchbook is empty — you've burned all your matches."
}
```

## Burn timer (auto-extinguish)

**Puzzle**: matches burn for a few turns then go out.

```jsonc
// Tick: drain countdown each turn while match is lit
{
  "id": "match-burn-tick",
  "afterAction": true,
  "once": false,
  "when": {
    "type": "and",
    "all": [
      { "type": "itemState", "itemId": "match", "key": "isLit", "equals": true },
      { "type": "compare", "left": { "kind": "flag", "key": "match-burn-countdown" }, "op": ">", "right": { "kind": "literal", "value": 0 } }
    ]
  },
  "effects": [
    { "type": "adjustFlag", "key": "match-burn-countdown", "by": -1 }
  ]
}

// Auto-extinguish on hit-zero
{
  "id": "match-burns-out",
  "afterAction": true,
  "once": false,
  "when": {
    "type": "and",
    "all": [
      { "type": "itemState", "itemId": "match", "key": "isLit", "equals": true },
      { "type": "compare", "left": { "kind": "flag", "key": "match-burn-countdown" }, "op": "<=", "right": { "kind": "literal", "value": 0 } }
    ]
  },
  "effects": [
    { "type": "setItemState", "itemId": "match", "key": "isLit", "value": false }
  ],
  "narration": "The match has gone out."
}
```

When the player lights a match, set `match-burn-countdown` to 3. The tick trigger drains it each turn; the burn-out trigger fires when it hits zero.

Same pattern works for the lantern battery, candle wax, etc. — see [zork-1.overrides.json](../app/src/stories/zork-1.overrides.json) `lamp-burns-fuel` / `lamp-runs-out` and `candles-burn-fuel` / `candles-burn-out`.

## Empty-handed squeeze (inventory-gated movement)

**Puzzle**: a passage west of the timber-room is too narrow to squeeze through unless the player drops everything.

```jsonc
// Track empty-handed state via inventoryCount
{
  "id": "empty-handed-on",
  "once": false,
  "when": {
    "type": "and",
    "all": [
      { "type": "compare", "left": { "kind": "inventoryCount" }, "op": "<=", "right": { "kind": "literal", "value": 0 } },
      { "type": "flag", "key": "empty-handed", "equals": false }
    ]
  },
  "effects": [
    { "type": "setFlag", "key": "empty-handed", "value": true },
    {
      "type": "if",
      "if": { "type": "playerAt", "roomId": "timber-room" },
      "then": [
        { "type": "narrate", "text": "With your hands free, you think you might just be able to squeeze through the narrow passage to the west." }
      ]
    }
  ]
}

{
  "id": "empty-handed-off",
  "once": false,
  "when": {
    "type": "and",
    "all": [
      { "type": "compare", "left": { "kind": "inventoryCount" }, "op": ">", "right": { "kind": "literal", "value": 0 } },
      { "type": "flag", "key": "empty-handed", "equals": true }
    ]
  },
  "effects": [
    { "type": "setFlag", "key": "empty-handed", "value": false }
  ]
}
```

```jsonc
// Exit gated on empty-handed, hidden when blocked (so the LLM doesn't see the toggle and dramatize it)
"timber-room": {
  "exits": {
    "west": {
      "to": "lower-shaft",
      "hidden": true,
      "when": { "type": "flag", "key": "empty-handed", "equals": true }
    }
  }
}
```

The conditional `narrate` effect inside the `empty-handed-on` trigger emits a one-shot hint when the player drops their last item AT timber-room. Other rooms get the flag flip silently (no narrate cue).

## Movement-blocked thematic refusal

**Puzzle**: when the player tries to `go west` from timber-room while loaded, give them a thematic refusal instead of the engine's generic "you can't go that way."

This needs the **built-in intent recording** mechanism: `intentMatched("go") + intentArg(go, direction, west)`.

```jsonc
{
  "id": "timber-room-too-loaded",
  "once": false,
  "when": {
    "type": "and",
    "all": [
      { "type": "intentMatched", "signalId": "go" },
      { "type": "intentArg", "signalId": "go", "key": "direction", "equals": "west" },
      { "type": "playerAt", "roomId": "timber-room" },
      { "type": "flag", "key": "empty-handed", "equals": false }
    ]
  },
  "effects": [
    { "type": "removeMatchedIntent", "signalId": "go" }
  ],
  "narration": "Your load is too great. The passage west narrows to a slit barely a person's width."
}
```

The trigger fires whether the engine accepted or refused the `go` action — built-in intents record on dispatch regardless of success. With the exit `hidden: true`, the engine returns "no-such-direction" rejection, and this trigger supplies the canonical thematic refusal cue.

## Enter-room cue

**Puzzle**: emit a one-shot atmospheric cue when the player enters a specific room.

Same mechanism — `intentMatched("go") + playerAt(target)` fires after every successful entry:

```jsonc
{
  "id": "lower-shaft-enter-look-up",
  "once": false,
  "when": {
    "type": "and",
    "all": [
      { "type": "intentMatched", "signalId": "go" },
      { "type": "playerAt", "roomId": "lower-shaft" }
    ]
  },
  "effects": [
    { "type": "removeMatchedIntent", "signalId": "go" },
    {
      "type": "if",
      "if": { "type": "itemState", "itemId": "basket", "key": "position", "equals": "raised" },
      "then": [
        { "type": "narrate", "text": "Far above you at the top of the shaft, the wicker basket sways gently on its chain — well out of reach." }
      ]
    },
    {
      "type": "if",
      "if": { "type": "itemState", "itemId": "basket", "key": "position", "equals": "lowered" },
      "then": [
        { "type": "narrate", "text": "The wicker basket sits at your feet at the bottom of the shaft, the chain rising into darkness above." }
      ]
    }
  ]
}
```

Use `once: false` for re-fire on every entry; `once: true` for first-entry-only.

## Multi-step ritual (bell-book-candles)

**Puzzle**: at the entrance to Hades, the player must (1) ring a bell, (2) light candles, (3) read the prayer book — in sequence — to banish the spirits and unlock the path forward.

The ritual is composed of three intents (`ring-bell`, `light(candles)`, `read(book)`) and triggers that gate on the cumulative state:

```jsonc
// Bell rings: persistent flag rangAtHades
{
  "id": "bell-rings",
  "when": { "type": "intentMatched", "signalId": "ring-bell" },
  "effects": [
    {
      "type": "if",
      "if": { "type": "playerAt", "roomId": "entrance-to-hades" },
      "then": [
        { "type": "setItemState", "itemId": "bell", "key": "rangAtHades", "value": true },
        // ...drop candles, etc.
      ]
    },
    { "type": "removeMatchedIntent", "signalId": "ring-bell" }
  ],
  "narration": "The bell rings out. Its toll is loud and clear."
}

// Capstone: read book at hades with bell rung + candles lit → ritual completes
{
  "id": "lld-ritual-completes",
  "once": true,
  "when": {
    "type": "and",
    "all": [
      { "type": "intentMatched", "signalId": "read" },
      { "type": "intentArg", "signalId": "read", "key": "itemId", "equals": "book" },
      { "type": "playerAt", "roomId": "entrance-to-hades" },
      { "type": "itemState", "itemId": "bell", "key": "rangAtHades", "equals": true },
      { "type": "itemState", "itemId": "candles", "key": "isLit", "equals": true }
    ]
  },
  "effects": [
    { "type": "setFlag", "key": "lld-flag", "value": true },
    { "type": "removeMatchedIntent", "signalId": "read" }
  ],
  "narration": "Each word of the prayer reverberates through the hall in a deafening confusion..."
}
```

Soft-fail catchalls handle wrong-order attempts:

```jsonc
{
  "id": "read-book-no-bell-rung",
  "priority": -10,
  "once": false,
  "when": {
    "type": "and",
    "all": [
      { "type": "intentMatched", "signalId": "read" },
      { "type": "intentArg", "signalId": "read", "key": "itemId", "equals": "book" },
      { "type": "playerAt", "roomId": "entrance-to-hades" },
      { "type": "itemState", "itemId": "bell", "key": "rangAtHades", "equals": false }
    ]
  },
  "effects": [{ "type": "removeMatchedIntent", "signalId": "read" }],
  "narration": "You read the prayer aloud. The words have no power; the spirits jeer."
}
```

The success trigger has higher priority and fires first when conditions hold; otherwise the soft-fail trigger picks up the same intent. See [zork-1.overrides.json](../app/src/stories/zork-1.overrides.json) `lld-ritual-completes` / `read-book-no-bell-rung` / `read-book-candles-out` for the full trio.

## Scoring

```jsonc
// Story-level
"startState": { "score": 0 }
```

```jsonc
// Per-event scoring trigger
{
  "id": "score-take-painting",
  "once": true,
  "when": { "type": "hasItem", "itemId": "painting" },
  "effects": [
    { "type": "adjustFlag", "key": "score", "by": 4 }
  ],
  "narration": "(+4 points)"
}
```

For score-based ranks, the narrator surfaces a `{rank}` template in narration that maps `score` to a tier (Beginner, Adventurer, Wizard, etc.). See [zork-1.overrides.json](../app/src/stories/zork-1.overrides.json) for the full rank ladder.

## Random outcomes

```jsonc
{
  "id": "thief-attack-roll",
  "when": { "type": "intentMatched", "signalId": "attack-thief" },
  "effects": [
    { "type": "setFlagRandom", "key": "attack-roll", "min": 1, "max": 20 },
    {
      "type": "if",
      "if": { "type": "compare", "left": { "kind": "flag", "key": "attack-roll" }, "op": ">=", "right": { "kind": "literal", "value": 15 } },
      "then": [
        { "type": "adjustItemState", "itemId": "thief", "key": "health", "by": -1 },
        { "type": "narrate", "text": "Your blow lands true — the thief reels." }
      ],
      "else": [
        { "type": "narrate", "text": "Your swing misses. The thief grins." }
      ]
    },
    { "type": "removeMatchedIntent", "signalId": "attack-thief" }
  ]
}
```

`setFlagRandom` rolls once and writes to a flag. Subsequent `compare` Conditions read the materialized roll. Don't try to use a NumericExpr `random` kind — it doesn't exist, deliberately, because lazy re-evaluation per condition would be a foot-gun.

---

# Part 7: The narrator — what the LLM sees

You author state. The LLM authors prose. Understanding what the LLM sees per turn — and what it's instructed to do with it — is the difference between authoring that flows and authoring that breaks.

## The view contract

Every turn, the engine builds a `WorldView` and hands it to the narrator. The view is a structured snapshot of what the player perceives:

```ts
interface WorldView {
  room: { id, name, description };
  itemsHere: ItemView[];
  passagesHere: PassageView[];
  exits: ExitView[];
  inventory: ItemView[];
  score?: { current: number; max: number; rank: string };
  vehicle?: { id, name, mobile, ... };  // when player is in a vehicle
  finished?: { won, message };
}
```

Per item:

```ts
interface ItemView {
  id, name;
  appearance?: string;        // resolved via appearanceVariants
  description?: string;       // present only if player has examined this item before
  state?: Record<string, Atom>;
  narratorNote?: string;
  personality?: string;
  containedIn?: string;       // when item is in a container
  // ... container/lightSource/vehicle marker fields
}
```

The view is the LLM's **only** source of ground truth about the current world. Anything not in the view is invisible to the LLM (or — more precisely — the LLM is instructed not to invent it).

## Narration cues

When a trigger has `narration` (or runs a `narrate` Effect inside `if`/`then`), the engine queues that text in `narrationCues`. The LLM weaves cues into prose for its next response.

**Cues are MUCH harder for the LLM to ignore than view-embedded text.** When the player MUST notice a state change, emit a cue. When the change is purely descriptive, an `appearance` variant is enough.

Examples:
- "The bell tolls; the candles dim." — emit as a `narration` cue. (Players need to notice.)
- "A brass lantern glows steadily." — `appearanceVariants` is enough. (Just descriptive.)

## `narratorNote` and `personality`

Two LLM-facing item fields:

- **`narratorNote`** — engine-side guidance the LLM follows silently. "Treat anything 'in' this as on the surface." "Describe in past tense." Never quoted to the player.
- **`personality`** — NPC voice. The LLM speaks the entity in character.

Use `narratorNote` when the structural facts need interpretation guidance. Use `personality` for talking entities. Both are surfaced in the view's per-item ItemView.

## Common LLM failure modes

Even with a clean view + clear cues, the LLM sometimes hallucinates. Author defensively:

### Hallucinated state

LLM narrates "the door is locked" when the door is unlocked. **Cause**: stale memory from earlier turns. **Author fix**: emit a state-change cue when the lock flips. Don't rely on the LLM to re-read view fields it saw three turns ago.

### Stale memory of items

LLM narrates "you see the coal" in a room where the coal isn't currently in `itemsHere`. **Cause**: LLM remembers the coal from a previous turn. **Author fix**: cues for moves ("the coal vanishes into the basket"). Use `appearanceVariants` to give the LLM fresh per-turn descriptive prose.

### Tip leakage

LLM narrates the puzzle solution in description text ("with your hands empty, you might be able to squeeze through"). **Cause**: author put a hint in `description` or `appearance`. **Author fix**: keep descriptions canonical and atmospheric; put hints in **trigger narrations** that fire on attempt or on transition.

### Fourth-wall breaks

LLM says "the game doesn't have a verb for that." **Cause**: the LLM mistakenly thinks the player asked for something impossible. **Author fix**: covered by the existing STYLE rule in [narrator-prompts.md](./narrator-prompts.md). If you see it persistently, file an engine issue.

### Narrating exit toggles

LLM dramatizes "the way is now open!" when an exit's `blocked` state flips between turns. **Cause**: the LLM saw the view diff. **Author fix**: use `hidden: true` on the exit (so it's filtered when blocked) plus a trigger that emits the canonical refusal on attempt. The empty-handed timber-room pattern in [Part 6](#movement-blocked-thematic-refusal) is the canonical example.

## Read [narrator-prompts.md](./narrator-prompts.md) once

The narrator's full system prompt is documented in [narrator-prompts.md](./narrator-prompts.md). You don't need to memorize it, but read it once. It lists every rule the LLM is told. Knowing what the LLM is instructed to do (and not do) helps you author around its known behaviors.

---

# Part 8: Workflow — from idea to playable

## The dev loop

```
edit JSON → validate → typecheck → run tests → manual playtest → repeat
```

Specifically:

1. Edit your story file (or the overrides JSON if you're using the Zork extractor).
2. (If using extractor) re-run extraction:
   ```
   cd app && npx tsx scripts/extract-zork.ts
   ```
3. Typecheck:
   ```
   npx tsc --noEmit
   ```
4. Run tests:
   ```
   npx tsx scripts/test-puzzles.ts
   npx tsx scripts/test-walkthrough.ts
   npx tsx scripts/smoke-handler.ts
   ```
5. Manual playtest in the app.

## Tests you should write

For every non-trivial puzzle, write a unit test that:
- Seeds engine state to JUST BEFORE the puzzle (skip travel + setup).
- Executes the canonical action sequence.
- Asserts the expected flag/state outcome.

```ts
// In scripts/test-puzzles.ts:
console.log("\n=== #N My puzzle ===");
{
  const e = newEngine();
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "puzzle-room", widget: "player" },
  };
  e.execute({ type: "recordIntent", signalId: "use-widget" });
  e.state.flags["puzzle-done"] === true
    ? pass("puzzle-done flag set after use-widget")
    : fail("puzzle-done not set", JSON.stringify(e.state.flags));
}
```

For custom tool handlers, add a smoke test in `scripts/smoke-handler.ts` that exercises happy + sad paths.

## Validation

The runtime validator (`validateStory` in [`app/src/story/validate.ts`](../app/src/story/validate.ts)) runs at story load and refuses bad files with specific error paths:
- Missing required fields.
- Unknown room/item/passage/trigger ids in references.
- Duplicate ids.
- CustomTool ids that collide with built-in action names.
- Item/passage id collisions (shared namespace).

Errors print on the dev console. Fix them before playtesting.

## Save versions

Whenever you add a new persistent state field (a new flag, a new item state key, a new room state key), consider whether existing saves need a backfill migration. The engine has a `SAVE_VERSION` constant in [`app/src/persistence/localSave.ts`](../app/src/persistence/localSave.ts). Bump it whenever you ship a new field, and add a backfill function (`applyVNBackfill`) that adds defaults to old saves.

You don't need a migration if:
- The new field is read-only and defaults to a sensible value (numeric flags default to 0; boolean state defaults to false; `state[key] === undefined` won't crash anything).
- Old saves not having the field is functionally equivalent to having the default.

You DO need a migration if:
- A trigger gates on the field being explicitly set (e.g. `equals: false` requires the key to actually exist in the saved state).
- Players in mid-game would be stuck without the new field.

See [zork-1.overrides.json](../app/src/stories/zork-1.overrides.json) and the localSave.ts `applyV11Backfill` for examples.

## Templates and the Zork extractor

Two authoring paths exist in this repo:

1. **Hand-authored stories** — write the JSON directly (e.g. tiny-adventure from Part 1).
2. **Zork extraction** — `scripts/extract-zork.ts` reads ZIL routine dumps + `zork-1.overrides.json` and produces the final `zork-1.json`. Authors edit the overrides; the extractor merges them with extracted ZIL data.

The extractor is **specific to Zork I**. If you're writing a new story, hand-author it. If you're tweaking Zork I, edit overrides and re-extract.

`Story.templates` (build-time inheritance for repeated item shapes) is resolved by the extractor. It's optional; you can skip templates entirely for hand-authored stories.

---

# Part 9: Reference and next steps

## Authoritative references

- **[story-format.md](./story-format.md)** — schema reference. Every type, every field, every shape. Companion to this guide.
- **[`app/src/story/schema.ts`](../app/src/story/schema.ts)** — the canonical TypeScript types. If a doc and the schema disagree, the schema wins.
- **[narrator-prompts.md](./narrator-prompts.md)** — the LLM's system prompt and rules.
- **[`app/src/stories/zork-1.overrides.json`](../app/src/stories/zork-1.overrides.json)** — the most extensive worked example. ~12k lines covering every pattern in this guide.
- **[`app/src/engine/engine.ts`](../app/src/engine/engine.ts)** — the three-phase trigger cascade implementation, if you need to know exactly when triggers fire.
- **[`app/src/engine/state.ts`](../app/src/engine/state.ts)** — Condition evaluation, NumericExpr evaluation, accessibility/visibility logic.

## What's not yet supported

- **Multi-player.** Single-player only.
- **Real-time.** Turn-based only.
- **Structured NPC dialogue trees.** NPCs work via `personality` + customTool intents + triggers; there's no dialogue-tree authoring schema yet.
- **Voice / image generation.** Text only.
- **In-engine save migration codegen.** You write migrations by hand in localSave.ts.
- **Hot-reload during play.** Edit-then-restart loop.

## Asking for help

- File issues on the repo.
- Open the dev tools console while playing — `[tool]` and `[Anthropic usage]` log lines show what the LLM called and what cues fired. Useful for diagnosing "why did the LLM do that?"
- Skim [zork-1.overrides.json](../app/src/stories/zork-1.overrides.json) — most patterns you want to write are already wired there.

Now go build something.

