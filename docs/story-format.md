# Story Format Reference

A **story** is a JSON file describing an interactive world. The engine reads the file, builds runtime state from it, and an LLM narrates over both. Authors write stories; the engine plays them.

This document is the **schema reference** — every field, every type, every shape. For a tutorial that walks you through building one, see [authors-guide.md](./authors-guide.md). For the canonical TypeScript types, see [`app/src/story/schema.ts`](../app/src/story/schema.ts). The runtime validator in [`app/src/story/validate.ts`](../app/src/story/validate.ts) enforces every rule documented here.

`schemaVersion` is currently `"0.1"`. The surface has grown substantially since first release; future bumps will document migration.

---

## Top-level shape

```jsonc
{
  "schemaVersion": "0.1",
  "id": "my-story",
  "title": "My Story",
  "author": "Your Name",
  "description": "Optional short blurb shown in the story picker.",
  "intro": "Optional. Shown when a new game starts.",
  "systemPromptOverride": "Optional. Appended to the engine's narrator system prompt.",
  "startRoom": "starting-room-id",
  "startState": { "score": 0 },
  "rooms": [ /* Room[] */ ],
  "items": [ /* Item[] */ ],
  "passages": [ /* Passage[] */ ],
  "triggers": [ /* Trigger[] */ ],
  "customTools": [ /* CustomTool[] */ ],
  "npcs": [ /* NPC[] */ ],
  "templates": { /* string -> Partial<Item> */ },
  "defaultVisibility": { /* Condition */ },
  "sharedVariants": [ /* TextVariant[] */ ]
}
```

| Field | Required | Purpose |
|---|---|---|
| `schemaVersion` | yes | Currently `"0.1"`. The engine refuses unknown versions. |
| `id` | yes | Unique slug, used for save segregation. Lowercase + hyphens. |
| `title`, `author` | yes | Shown in the story picker. |
| `description` | no | Shown in the story picker as a one-liner. |
| `intro` | no | Shown once when a new game starts. |
| `systemPromptOverride` | no | Appended to the narrator's system prompt. Use for story-specific narration guidance ("speak in formal Victorian English"). |
| `startRoom` | yes | Room id where the player begins. |
| `startState` | no | Initial flag values. `{ key: Atom }` where `Atom = string \| number \| boolean`. |
| `rooms` | yes | Array of [Room](#rooms). |
| `items` | yes | Array of [Item](#items). |
| `passages` | no | Array of [Passage](#passages) — named connectors between rooms (doors, windows, archways, hatches). |
| `triggers` | no | Array of [Trigger](#triggers). |
| `customTools` | no | Array of [CustomTool](#custom-tools) — author-declared verbs the LLM can call. |
| `npcs` | no | Array of [NPC](#npcs) — placeholder; minimal v0.1 support. |
| `templates` | no | `Record<string, Partial<Item>>` — build-time inheritance for repeated item shapes (resolved by extractor; engine never sees this field). |
| `defaultVisibility` | no | Story-level [Condition](#conditions) gating EVERY object's visibility. Composed with each object's own `visibleWhen`. Used for darkness, fog, blindness — generic perception. |
| `sharedVariants` | no | Array of [TextVariant](#text-variants) appended to every room's variants list. Used for global descriptions like "pitch black" applied to all dark rooms without per-room copy. |

---

## Rooms

```jsonc
{
  "id": "kitchen",
  "name": "Kitchen",
  "description": "A small kitchen with a stove. A door leads east.",
  "variants": [
    {
      "when": { "type": "flag", "key": "stove_on", "equals": true },
      "text": "A small kitchen. The stove glows red. A door leads east."
    }
  ],
  "exits": {
    "east": { "to": "hallway" },
    "down": {
      "to": "cellar",
      "when": { "type": "hasItem", "itemId": "trapdoor-key" },
      "blockedMessage": "The trapdoor is locked."
    }
  },
  "state": { "dark": true },
  "narratorNote": "Treat anything 'on the counter' as resting on the work surface."
}
```

| Field | Type | Purpose |
|---|---|---|
| `id` | string | Unique within rooms. |
| `name` | string | Short label ("Kitchen", "West of House"). |
| `description` | string | Canonical description. Sent to LLM as the room's "official" prose. |
| `variants` | [TextVariant](#text-variants)[] | State-conditional descriptions. First match wins; falls back to `description`. |
| `exits` | `Record<string, Exit>` | Direction → [Exit](#exits) map. Direction keys are lowercase, free-form. |
| `state` | `Record<string, Atom>` | Per-room typed state. Mutated by `setRoomState`; read via `roomState` / `currentRoomState` Conditions. Common pattern: `{ "dark": true }`. |
| `narratorNote` | string | Engine-side guidance for the LLM. Never quoted to the player. Use for non-obvious narration rules ("describe in past tense", "treat anything 'in' as resting on the surface"). |

### Exits

```jsonc
{
  "to": "cellar",
  "when": { "type": "flag", "key": "trapdoor-open", "equals": true },
  "blockedMessage": "The trapdoor is locked.",
  "hidden": true,
  "visibleWhen": { /* Condition */ },
  "passage": "trapdoor"
}
```

| Field | Type | Purpose |
|---|---|---|
| `to` | string | Target room id. |
| `when` | [Condition](#conditions) | If false, traversal is refused with `blockedMessage`. |
| `blockedMessage` | string | Text shown on refused traversal. Falls back to a generic refusal if absent. |
| `hidden` | boolean | If `true`, exit is filtered from the view (and from the listed exits) when `when` is false. Use to suppress toggle exposure for puzzle gates. |
| `visibleWhen` | [Condition](#conditions) | Per-exit visibility gate, composed with `Story.defaultVisibility`. |
| `passage` | string | If set, the engine evaluates the named [Passage](#passages)'s `traversableWhen` (per-side, falling back to passage-level) on traversal attempts. |

---

## Items

The engine's most expansive schema. Items model takeable objects, scenery, NPCs (in part), containers, light sources, vehicles — anything that has a position and/or state.

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
  "appearsIn": ["pantry"],
  "takeable": true,
  "fixed": false,
  "tags": ["light-source", "carryable"],
  "state": { "isLit": false, "batteryTurns": 330 },
  "lightSource": {},
  "narratorNote": "The lantern can be picked up; respect its current isLit state in prose."
}
```

| Field | Type | Purpose |
|---|---|---|
| `id` | string | Unique across items AND passages (shared id namespace). |
| `name` | string | Display name shown in inventory and narration. Falls back if `nameVariants` doesn't match. |
| `nameVariants` | `{ when: Condition, name: string }[]` | State-conditional display-name overrides. First match wins; falls back to `name`. Used everywhere the engine renders the item label (view, parser keyword fallback, `{arg.X.name}` substitution, rejection messages). Use when an item's identity changes with state — e.g. folded boat ↔ magic boat ↔ deflated boat. |
| `description` | string | Shown by `examine`. Authoritative "look closely" text. |
| `variants` | [TextVariant](#text-variants)[] | State-conditional `description` overrides. Used by `examine`. |
| `appearance` | string | Short room-presence line. Surfaced in the view's `itemsHere[i].appearance` every turn the item is in the room. Authoring guideline: 1 sentence. |
| `appearanceVariants` | [TextVariant](#text-variants)[] | State-conditional `appearance` overrides. First match wins; falls back to `appearance`. Use for light/dark, opened/closed, lit/unlit. |
| `location` | string | Initial location: roomId, itemId (parent container), `"player"` (in inventory; legacy alias `"inventory"`), or `"nowhere"` (not yet in play). |
| `appearsIn` | string[] | Additional rooms where the item is **perceivable** (NOT physically located). For shared scenery: a window visible from both sides of a wall, a basket on a chain visible from both ends of a shaft. Item itself is visible from these rooms; its CONTENTS are NOT (contents follow the actual `location`). Only meaningful for `fixed` items. |
| `takeable` | boolean | Player can pick it up. Default `false`. |
| `fixed` | boolean | Scenery; never moves. Mutually exclusive with `takeable`. |
| `tags` | string[] | Author-chosen classification labels (e.g. `["weapon", "sword"]`, `["treasure"]`, `["enemy", "troll"]`). Matched by `itemHasTag` / `flagItemHasTag` Conditions. |
| `state` | `Record<string, Atom>` | Per-item typed state. Authors choose key names. Mutated via `setItemState`/`adjustItemState`; read via `itemState` Condition or `itemState` NumericExpr. Common patterns: `{"isOpen": false}`, `{"isLit": false}`, `{"broken": false}`. |
| `narratorNote` | string | Engine-side guidance for the LLM. Never quoted to the player. |
| `personality` | string | NPC voice/manner. The LLM speaks the entity in character. Use for talking NPCs. |
| `readable` | `{ text: string }` | If set, the `read(itemId)` customTool surfaces this text. |
| `container` | [Container](#containers) | Opt in to container behavior (other items can be inside this one). |
| `lightSource` | `Record<string, never>` | Marker capability — presence indicates "this item can emit light." The lit state itself lives in `state.isLit`. Field shape is reserved for future per-source metadata (radius, color). |
| `vehicle` | [Vehicle](#vehicles) | Opt in to vehicle behavior (player can BOARD / DISEMBARK). |
| `visibleWhen` | [Condition](#conditions) | Per-item visibility gate. Composed with `Story.defaultVisibility`. False → item not in view AND not accessible. |
| `openWhen` / `closeWhen` | [Condition](#conditions) | Extra gates on the auto-generated `open`/`close` customTool intents. AND'd into the auto-gen `active` clause. Use to suppress auto-gen entirely (e.g. `not(always)`) or add lock checks. |
| `fromTemplate` | string | Build-time template inheritance (extractor-only; stripped before engine load). |

### Containers

```jsonc
"container": {
  "capacity": 5,
  "accessibleWhen": { "type": "itemState", "itemId": "chest", "key": "isOpen", "equals": true },
  "accessBlockedMessage": "The chest is closed."
}
```

| Field | Type | Purpose |
|---|---|---|
| `capacity` | number | Max items the container holds. Omit for unlimited. |
| `accessibleWhen` | [Condition](#conditions) | When false, contents are invisible/inaccessible (closed openable container). Omit for always-accessible (open basket). |
| `accessBlockedMessage` | string | Shown on `put` failure due to inaccessibility. |

Open/close intents are auto-generated for any item with `state.isOpen` defined. To disable auto-gen, set `openWhen: { type: "not", condition: { type: "always" } }`.

### Vehicles

```jsonc
"vehicle": {
  "mobile": true,
  "enterableWhen": { "type": "itemState", "itemId": "boat", "key": "inflated", "equals": true },
  "enterBlockedMessage": "The boat is deflated; you'd sink instantly."
}
```

| Field | Type | Purpose |
|---|---|---|
| `mobile` | boolean | If `true`, vehicle travels with the player on `go(direction)`. Default `false` (stationary booth, throne). |
| `enterableWhen` | [Condition](#conditions) | Gate on entering the vehicle. |
| `enterBlockedMessage` | string | Shown on board attempt when `enterableWhen` is false. |

While the player is inside a vehicle, the view includes a top-level `vehicle: { id, name, mobile, ... }` field. The `inVehicle` Condition checks current vehicle state. `setPlayerVehicle` is implicit through `board`/`disembark` actions — there's no direct setter Effect.

---

## Passages

A **passage** is a named connector between exactly two rooms. Examineable from either side. An [Exit](#exits) references a passage by id; the engine refuses traversal when the passage's `traversableWhen` is false.

Passages share an id namespace with items (the validator enforces no collisions). Use passages for **named** physical features that span two rooms — doors, windows, gates, hatches, archways, narrow gaps, magic portals, chimneys. Use plain exits for unnamed direction-only links.

```jsonc
{
  "kind": "simple",
  "id": "kitchen-window",
  "name": "kitchen window",
  "description": "A small grimy window that latches from the inside.",
  "variants": [],
  "sides": [
    { "roomId": "east-of-house", "name": "small window" },
    { "roomId": "kitchen", "name": "kitchen window" }
  ],
  "glimpse": {
    "when": { "type": "always" },
    "description": "Through the glass you can see the kitchen beyond — a chipped table, a dim lamp."
  },
  "state": { "isOpen": false },
  "openWhen": { /* optional gate on auto-gen open intent */ },
  "closeWhen": { /* optional gate on auto-gen close intent */ },
  "traversableWhen": { "type": "passageState", "passageId": "kitchen-window", "key": "isOpen", "equals": true },
  "traverseBlockedMessage": "The window is closed.",
  "visibleWhen": { /* optional */ },
  "narratorNote": "Treat the window as a square pane, latched from inside."
}
```

| Field | Type | Purpose |
|---|---|---|
| `kind` | `"simple"` (optional) | Discriminator. v0.1 supports only `"simple"`. Defaults to `"simple"`. |
| `id` | string | Unique across items AND passages. |
| `name` | string | Default name. Per-side `name` overrides this. |
| `description` | string | Default description. |
| `variants` | [TextVariant](#text-variants)[] | State-conditional description overrides. |
| `sides` | `[PassageSide, PassageSide]` | Always exactly two. Each side carries `roomId` plus optional per-side overrides (`name`, `description`, `variants`, `glimpse`, `traversableWhen`, `traverseBlockedMessage`, `visibleWhen`). |
| `glimpse` | [PassageGlimpse](#passage-glimpse) | Declares the passage is see-through; provides content shown when looking through. |
| `state` | `Record<string, Atom>` | Per-passage typed state. Common: `{"isOpen": false}`. |
| `openWhen` / `closeWhen` | [Condition](#conditions) | Extra gates on auto-gen open/close intents. AND'd into the auto-gen `active` clause. |
| `traversableWhen` | [Condition](#conditions) | Default traversal gate. Per-side overrides take precedence. |
| `traverseBlockedMessage` | string | Refusal message. Per-side > passage-level > generic. |
| `visibleWhen` | [Condition](#conditions) | Composes with per-side and `Story.defaultVisibility`. |
| `narratorNote` | string | Engine-side guidance for the LLM. |

### Passage glimpse

A glimpse declares "the player can see through this passage." Presence enables see-through; absence means opaque.

```jsonc
"glimpse": {
  "when": { "type": "passageState", "passageId": "hatch", "key": "isOpen", "equals": true },
  "description": "Below, you see a dim chamber.",
  "prompt": "Describe the chamber briefly, emphasizing the smell of damp earth."
}
```

| Field | Type | Purpose |
|---|---|---|
| `when` | [Condition](#conditions) | When the glimpse is active. Default: always (set explicitly to gate, e.g. on door isOpen). |
| `description` | string | Static text shown when looking through. |
| `prompt` | string | LLM guidance ("describe briefly, focus on warmth"). |

If both omitted, the engine still passes the other room's name + description for the LLM to improvise.

### Passage sides

Each side may override passage-level fields:

| Field | Type | Purpose |
|---|---|---|
| `roomId` | string | Required. Which room this side faces. |
| `name` | string | Per-side display name (e.g. "back door" outside vs. "kitchen door" inside). |
| `description` | string | Per-side description. |
| `variants` | TextVariant[] | Per-side state-conditional descriptions. |
| `glimpse` | PassageGlimpse | Per-side glimpse override. |
| `traversableWhen` | Condition | Per-side traversal gate (e.g. chimney climbable from one room only). |
| `traverseBlockedMessage` | string | Per-side refusal message. |
| `visibleWhen` | Condition | Per-side visibility gate. |

---

## Text variants

Used in `Room.variants`, `Item.variants`, `Item.appearanceVariants`, `Passage.variants`, `PassageSide.variants`, `Story.sharedVariants`.

```jsonc
{
  "when": { "type": "flag", "key": "stove_on", "equals": true },
  "text": "A small kitchen. The stove glows red."
}
```

Variants are evaluated in array order. First match wins; falls back to the parent's `description`/`appearance`.

---

## Conditions

Conditions are boolean expressions over `GameState`. They appear in: exit gating, text variants, trigger `when`, customTool preconditions, vehicle gates, container gates, glimpse activation, visibility gates.

| Type | Shape | Meaning |
|---|---|---|
| `flag` | `{ type, key, equals }` | `state.flags[key] === equals` |
| `hasItem` | `{ type, itemId }` | item is in player's inventory |
| `itemAt` | `{ type, itemId, location }` | item is at a specific location (roomId / itemId / `"inventory"` / `"nowhere"`) |
| `playerAt` | `{ type, roomId }` | player is currently in this room |
| `visited` | `{ type, roomId }` | player has entered this room at least once |
| `examined` | `{ type, itemId }` | player has examined this item at least once |
| `triggerFired` | `{ type, triggerId }` | a specific trigger has fired |
| `passageState` | `{ type, passageId, key, equals }` | per-passage state equality. `passageId` may be `{fromArg: "..."}` inside a tool handler |
| `passagePerceivable` | `{ type, passageId }` | passage is visible AND one of its sides matches the player's room |
| `passageHasStateKey` | `{ type, passageId, key }` | passage has a defined `state[key]` (handler precondition for "this verb doesn't apply here") |
| `itemState` | `{ type, itemId, key, equals }` | per-item state equality. `itemId` may be `{fromArg: "..."}` |
| `roomState` | `{ type, roomId, key, equals }` | per-room state equality |
| `currentRoomState` | `{ type, key, equals }` | shortcut for `roomState` on the player's current room |
| `anyPerceivableItemWith` | `{ type, key, equals }` | any item perceivable to the player has `state[key] === equals` (used for darkness gating: any perceivable lit item) |
| `anyAdjacentRoomItemWith` | `{ type, key, equals }` | any item directly located in a room reachable via the current room's exits has `state[key] === equals`. Walks all exits regardless of `visibleWhen`/`traversableWhen` — matches canonical "danger one room away" patterns |
| `itemHasTag` | `{ type, itemId, tag }` | the named item carries this tag |
| `flagItemHasTag` | `{ type, flagKey, tag }` | look up an itemId from a flag value, then check tags. Load-bearing for "the weapon being used (whichever it is)" combat patterns |
| `intentMatched` | `{ type, signalId }` | a customTool intent OR a built-in action has been matched at least once. Built-in signalIds: `look`, `examine`, `take`, `drop`, `put`, `inventory`, `go`, `wait`, `attack`, `board`, `disembark` |
| `intentArg` | `{ type, signalId, key, equals }` | matched intent's `args[key] === equals`. Examples: `intentArg("go", "direction", "west")`, `intentArg("read", "itemId", "book")` |
| `itemAccessible` | `{ type, itemId }` | item is currently perceivable to the player (in their room, inventory, or open container they can reach). `itemId` may be `{fromArg: "..."}` |
| `itemHasStateKey` | `{ type, itemId, key }` | item has a defined `state[key]` (handler precondition for "this verb doesn't apply") |
| `itemReadable` | `{ type, itemId }` | item has a defined `readable.text` field |
| `inventoryHasTag` | `{ type, tag }` | any item in the player's inventory has this tag |
| `inVehicle` | `{ type, itemId? }` | player is currently inside a vehicle. With `itemId`, must be that specific vehicle |
| `compare` | `{ type, left: NumericExpr, op, right: NumericExpr }` | numeric comparison. `op`: `==`, `!=`, `<`, `<=`, `>`, `>=` |
| `always` | `{ type }` | unconditionally true |
| `and` | `{ type, all: Condition[] }` | every sub-condition is true |
| `or` | `{ type, any: Condition[] }` | at least one sub-condition is true |
| `not` | `{ type, condition }` | inner condition is false |

Conditions nest arbitrarily.

### Built-in intent recording

Built-in actions populate `state.matchedIntents` after dispatch (whether the action succeeded or was rejected). Args mirror the action's input fields:

| Built-in action | signalId | args |
|---|---|---|
| `look` | `look` | `{}` |
| `examine(itemId)` | `examine` | `{itemId}` |
| `take(itemId)` | `take` | `{itemId}` |
| `drop(itemId)` | `drop` | `{itemId}` |
| `put(itemId, targetId)` | `put` | `{itemId, targetId}` |
| `inventory` | `inventory` | `{}` |
| `go(direction)` | `go` | `{direction}` |
| `wait` | `wait` | `{}` |
| `attack(itemId, targetId, mode?)` | `attack` | `{itemId, targetId, mode?}` |
| `board(itemId)` | `board` | `{itemId}` |
| `disembark` | `disembark` | `{}` |

Triggers gating on built-in intents should call `removeMatchedIntent` to consume them — otherwise the matched flag persists and the trigger may re-fire on later turns when its other gates align.

---

## NumericExpr

Produces a number from current `GameState`. Used as `left`/`right` operands of `compare` Conditions.

Discriminator is `kind` (not `type`) to keep these visually distinct from Conditions when they nest.

| Kind | Shape | Meaning |
|---|---|---|
| `literal` | `{ kind, value }` | the literal number |
| `flag` | `{ kind, key }` | `state.flags[key]` (0 if unset / non-numeric) |
| `passageState` | `{ kind, passageId, key }` | numeric value from passage state (0 if unset) |
| `itemState` | `{ kind, itemId, key }` | numeric value from item state (0 if unset) |
| `roomState` | `{ kind, roomId, key }` | numeric value from room state (0 if unset) |
| `inventoryCount` | `{ kind }` | number of items currently in inventory |
| `itemCountAt` | `{ kind, location }` | number of items whose location matches |
| `matchedIntentsCount` | `{ kind }` | number of distinct intents matched |
| `visitedCount` | `{ kind }` | number of distinct rooms visited |

NumericExpr is **evaluated lazily** on every condition eval. There is no `random` kind because re-rolling on every eval would be a foot-gun; for randomness use the `setFlagRandom` Effect to materialize a roll into a flag, then `compare` against it.

---

## IdRef

Three variants:

```ts
type IdRef =
  | string                                       // literal item / passage id
  | { fromArg: string }                          // pulled from a tool-handler's call args
  | { fromIntent: string; key: string };         // pulled from state.matchedIntentArgs[signalId][key]
```

**`{ fromArg }` — handler context.** Inside a customTool handler's preconditions or effects, write `{ fromArg: "<argName>" }` instead of a hardcoded id. The dispatcher substitutes the call's args before evaluation:

```jsonc
{ "type": "itemAccessible", "itemId": { "fromArg": "itemId" } }
```

Built-ins also use this — e.g. `take` injects `{ self: itemId }` so `takeableWhen` can reference the item being taken via `{ fromArg: "self" }`.

**`{ fromIntent }` — trigger context.** Inside a trigger's effects (and the conditions of nested `if`-effects), write `{ fromIntent: "<signalId>", key: "<argName>" }` to dynamically reference args of an intent matched earlier this turn. Used to write generic hooks like "the item the player just dropped":

```jsonc
{
  "id": "items-fall-from-tree",
  "when": {
    "type": "and",
    "all": [
      { "type": "intentMatched", "signalId": "drop" },
      { "type": "playerAt", "roomId": "up-a-tree" }
    ]
  },
  "effects": [
    { "type": "moveItem", "itemId": { "fromIntent": "drop", "key": "itemId" }, "to": "path" },
    { "type": "removeMatchedIntent", "signalId": "drop" }
  ]
}
```

The trigger should gate on `intentMatched(signalId)` so the args are guaranteed populated. If the resolved arg can't be looked up, the effect is skipped defensively (no crash, no stringified-object key in `itemLocations`).

**Outside handlers and triggers, all id fields should be plain strings.**

Fields that accept IdRef (in addition to plain strings):
- `Condition.passageState.passageId`
- `Condition.passagePerceivable.passageId`
- `Condition.passageHasStateKey.passageId`
- `Condition.itemState.itemId`
- `Condition.itemAccessible.itemId`
- `Condition.itemHasStateKey.itemId`
- `Condition.itemReadable.itemId`
- `Effect.moveItem.itemId`
- `Effect.setPassageState.passageId`
- `Effect.setItemState.itemId`
- `Effect.adjustItemState.itemId`

---

## Triggers

Triggers are how the world reacts to player actions. After every player action, the engine runs triggers in three phases:

1. **Phase 1**: Regular triggers (no `afterAction`) in a fixed-point loop. Re-evaluates after each fire until state is stable.
2. **Phase 2**: AfterAction triggers (one pass, at most once each).
3. **Phase 3**: Regular triggers again, in case Phase 2 mutated state.

Within each pass, triggers fire in **priority order** (higher first; ties keep authored order). The engine bails after `MAX_TRIGGER_ITERATIONS` (100) to prevent runaway cycles.

```jsonc
{
  "id": "reveal_key",
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
    { "type": "moveItem", "itemId": "key", "to": "chamber" }
  ],
  "narration": "Behind the painting, a brass key dangles from a small nail."
}
```

| Field | Type | Purpose |
|---|---|---|
| `id` | string | Unique within triggers. |
| `when` | [Condition](#conditions) | Fires when this evaluates true. |
| `effects` | [Effect](#effects)[] | State mutations applied in order. |
| `narration` | string | Cue queued into the LLM's next turn ("note that this just happened"). The LLM may paraphrase. |
| `once` | boolean | Defaults to `true`. Set `false` for re-fireable triggers (timers, recurring encounters). |
| `priority` | number | Sort order within a pass. Higher fires first. Default 0. Recommended bands: 100+ status-aware overrides; 50-99 specific-id; 10-49 class-based; 0 default; -100 catchall cleanup. Pair higher-priority triggers with intent-consumption (`removeMatchedIntent`) to short-circuit lower-priority catchalls. |
| `afterAction` | boolean | If `true`, fires in Phase 2 (one pass per turn). Combine with `once: false` for true tick behavior — re-evaluates each turn, fires whenever `when` is true. Used for lantern battery drain, grue checks, NPC wandering, dam timer, etc. |

---

## Effects

Effects mutate `GameState`. Triggers fire effects when their `when` becomes true; tool handlers fire effects after preconditions pass.

| Type | Shape | Meaning |
|---|---|---|
| `setFlag` | `{ key, value }` | `state.flags[key] = value` |
| `moveItem` | `{ itemId, to }` | move item to roomId / itemId (parent container) / `"player"` (inventory) / `"nowhere"` / `"<current-room>"` (sentinel — player's current room). Moving the player item updates currentRoom; if the destination is a room, `visitedRooms` is updated. `itemId` may be `{fromArg}` in handlers or `{fromIntent}` in triggers — useful for hooking action targets dynamically. |
| `moveItemsFrom` | `{ from, to }` | bulk: every item currently at `from` moves to `to`. Generic primitive for "container empties" — NPC drops everything, trophy case shatters, bag torn open |
| `setPassageState` | `{ passageId, key, value }` | mutate passage state. `passageId` may be `{fromArg: "..."}` inside a tool handler |
| `setItemState` | `{ itemId, key, value }` | mutate item state. `itemId` may be `{fromArg: "..."}` |
| `setRoomState` | `{ roomId, key, value }` | mutate room state |
| `adjustFlag` | `{ key, by }` | signed delta on a numeric flag (treats unset as 0) |
| `adjustItemState` | `{ itemId, key, by }` | signed delta on a numeric item-state value (treats unset as 0) |
| `removeMatchedIntent` | `{ signalId }` | un-match an intent so its triggers don't re-fire forever. Pair with every intent-gated trigger. Also clears `matchedIntentArgs[signalId]` |
| `setFlagRandom` | `{ key, min, max }` | roll a uniform random integer in `[min, max]` inclusive and write to `state.flags[key]` as a number. Materializes the roll once (vs. NumericExpr's lazy re-eval) |
| `narrate` | `{ text }` | append text to `narrationCues`. No state mutation. Used inside `if`/`then`/`else` so a single trigger emits branch-specific prose. Goes through `renderNarration` so `{flag.X}` substitution works |
| `if` | `{ if: Condition, then: Effect[], else?: Effect[] }` | deterministic conditional. Evaluates `if`; runs `then` if true, else `else` (or no-op if absent) |
| `endGame` | `{ won: boolean, message: string }` | end the game immediately with message. `won` flag distinguishes success ending from death |

### Effect templating

Effect string fields support template substitution:

- `{flag.<key>}` — value of `state.flags[key]`
- `{rank}` — derived rank tier from `state.flags["score"]`

Inside a tool handler's effects, `IdRef` fields support `{fromArg: "..."}` substitution.

---

## Custom tools

A **CustomTool** is an author-declared verb the LLM can call by name, alongside the engine's built-in actions.

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

| Field | Type | Purpose |
|---|---|---|
| `id` | string | The tool's name as the LLM sees it. Must NOT collide with reserved built-in names (`look`, `examine`, `take`, `drop`, `put`, `inventory`, `go`, `wait`, `attack`, `board`, `disembark`). |
| `description` | string | LLM-facing tool description. The LLM matches player input to tools by description. Be specific about verbs and synonyms. |
| `args` | [ToolArgsSchema](#tool-args-schema) | JSON-schema-style declaration of parameters. |
| `alwaysAvailable` | boolean | If `true`, the tool stays in the LLM's cache-stable tier (always offered). Otherwise it's conditionally injected (currently behaves like always-on; the conditional path is reserved for future use). |
| `handler` | [ToolHandler](#tool-handler) | Optional declarative response. Runs synchronously when the tool is called, before the trigger pipeline. |

### Tool args schema

```jsonc
"args": {
  "type": "object",
  "properties": {
    "itemId": { "type": "string", "description": "..." },
    "amount": { "type": "number" },
    "loud": { "type": "boolean", "enum": [true, false] }
  },
  "required": ["itemId"]
}
```

| Field | Type | Notes |
|---|---|---|
| `type` | `"object"` | Required literal. |
| `properties` | `Record<string, ToolArgProp>` | Each prop has `type` (`"string" \| "number" \| "boolean"`), optional `description`, optional `enum`. |
| `required` | string[] | Names of required props. |

### Tool handler

A handler runs **synchronously** when the tool is called, BEFORE the trigger pipeline:

1. Engine records `intentMatched(toolId)` + `matchedIntentArgs[toolId] = args`. (Recording happens regardless of preconditions.)
2. Preconditions evaluate top-down. **First failure short-circuits** with its `failedNarration` as a cue. No effects applied.
3. If all preconditions pass, effects apply in order.
4. If `successNarration` is set, it emits as a cue.

```jsonc
"handler": {
  "preconditions": [ /* ToolPrecondition[] */ ],
  "effects": [ /* Effect[] */ ],
  "successNarration": "string template"
}
```

| Field | Type | Purpose |
|---|---|---|
| `preconditions` | `ToolPrecondition[]` | Each: `{ when: Condition, failedNarration: string }`. Conditions may use `{fromArg}` IdRefs. |
| `effects` | `Effect[]` | Applied in order on success. May contain `{fromArg}` substitutions in id fields. |
| `successNarration` | string | Template; supports `{arg.<argName>.name|id}` for item/passage args, `{arg.<argName>.readable.text}` for the read tool, `{flag.<key>}`, and `{rank}`. |

### Triggers vs. handlers

- **Handlers** run synchronously inside `recordIntent`, before any cascade. Best for verb-intrinsic refusals (`"You don't see X here"`, `"X is already open"`).
- **Triggers** run in the cascade after the handler. Best for puzzle-state side effects, multi-condition gates, soft-fail recovery, and consequences that span turns.

Generic verbs (`open`, `close`, `read`, `light`, `extinguish`) typically have both: a generic handler with universal preconditions + per-item triggers gated on `intentMatched(toolId) + intentArg(toolId, "itemId", X)` for special cases.

---

## NPCs

```jsonc
{
  "id": "old-sailor",
  "name": "Old Sailor",
  "personality": "A weathered ex-sailor who speaks slowly. Trusts no one but the lighthouse keeper.",
  "location": "tavern"
}
```

In v0.1, NPCs are a thin wrapper around personality. Most actual NPC behavior in real stories goes through the **Item** schema with `personality` set — it gives access to the full state/triggers/customTool surface (combat, dialogue intents, inventory). Treat the top-level `npcs` array as a placeholder for future structured-dialogue support.

---

## Templates

Build-time inheritance for repeated item shapes. The extractor merges template fields into items (item fields win; arrays union dedupe-by-JSON), strips `fromTemplate`, and emits the final flat JSON. **The engine never sees templates** — by the time a story loads, every item is fully resolved.

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

After merge: the platinum-bar carries `tags: ["treasure", "valuable", "carryable"]` and `takeable: true`.

---

## Visibility model (darkness, fog, blindness)

Three composable layers gate what the player perceives. **All three must hold** for an object to appear in the view:

1. **Object's own `visibleWhen`** (per-item, per-passage, per-exit, per-side) — explicit override.
2. **`Story.defaultVisibility`** — story-level default applied to every object lacking its own gate.
3. **For items**: physical reachability (`itemAccessible`, walking the location chain).

Canonical Zork dark-room model:

```jsonc
"defaultVisibility": {
  "type": "or",
  "any": [
    { "type": "not", "condition": { "type": "currentRoomState", "key": "dark", "equals": true } },
    { "type": "anyPerceivableItemWith", "key": "isLit", "equals": true }
  ]
}
```

Translation: an object is visible IF the current room is NOT dark, OR the player can perceive any lit item.

To make a room dark, set `room.state.dark = true`. To make an item a light source, give it `lightSource: {}` and `state.isLit: false` (initially). The engine's `anyPerceivableItemWith` walks all perceivable items (using `isItemPresent` to avoid recursive visibility deadlock). When a lit item is in inventory or in the room, defaultVisibility evaluates true → all objects perceivable.

**Inventory bypass**: items the player is currently carrying bypass `defaultVisibility` (the player can feel for things in the dark). This is enforced in `isItemAccessible` and means the player can always `light(lamp)` even if the room is pitch black.

---

## Game state

The runtime `GameState` (in [`app/src/story/schema.ts`](../app/src/story/schema.ts)):

```ts
interface GameState {
  storyId: string;
  schemaVersion: string;
  flags: Record<string, Atom>;
  itemLocations: Record<string, string>;
  passageStates: Record<string, Record<string, Atom>>;
  itemStates: Record<string, Record<string, Atom>>;
  roomStates: Record<string, Record<string, Atom>>;
  matchedIntents: string[];
  matchedIntentArgs: Record<string, Record<string, Atom>>;
  visitedRooms: string[];
  examinedItems: string[];
  firedTriggers: string[];
  finished?: { won: boolean; message: string };
}
```

The player itself is tracked in `itemLocations` under the id `"player"`. The legacy magic string `"inventory"` for `Item.location` is normalized to `"player"` by `initialState`; engine code should never compare against `"inventory"` directly.

---

## Authoring checklist

A valid story has:

- [ ] All required top-level fields present (`schemaVersion`, `id`, `title`, `author`, `startRoom`, `rooms`, `items`).
- [ ] `startRoom` matches an existing room id.
- [ ] All exit `to` values match existing room ids.
- [ ] All exit `passage` values match existing passage ids.
- [ ] All passage `sides[i].roomId` values match existing room ids.
- [ ] All item `location` values resolve (room id, item id, `"player"`, `"inventory"` — legacy, or `"nowhere"`).
- [ ] All `itemId` references in conditions/effects/triggers/handlers match an existing item OR are `{fromArg: "..."}` inside a handler.
- [ ] All `passageId` references match an existing passage OR are `{fromArg: "..."}` inside a handler.
- [ ] All `roomId` references match an existing room.
- [ ] All `triggerId` references match an existing trigger.
- [ ] No duplicate ids within a category (rooms, items, passages, triggers, npcs, customTools).
- [ ] No customTool id collides with a built-in action name.
- [ ] No id collision between items and passages (shared namespace).
- [ ] All NumericExpr `compare` operands are valid expressions.

The runtime validator (`validateStory` in [`app/src/story/validate.ts`](../app/src/story/validate.ts)) enforces these and reports specific paths on failure.

---

## Versioning

`schemaVersion` is currently `"0.1"`. The schema has grown substantially since first release (passages, customTools, vehicles, light model, intent system, built-in intent recording) but remains backward-compatible — every addition is additive. A `"0.2"` bump would document any breaking change.

---

## Related docs

- [authors-guide.md](./authors-guide.md) — tutorial: how to build a game from scratch, with patterns and recipes.
- [narrator-prompts.md](./narrator-prompts.md) — what the LLM is told and why.
- [`app/src/story/schema.ts`](../app/src/story/schema.ts) — the canonical TypeScript types. If this doc and the schema disagree, the schema wins.
- [`app/src/stories/zork-1.overrides.json`](../app/src/stories/zork-1.overrides.json) — the most extensive worked example (~12k lines).
