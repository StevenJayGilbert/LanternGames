# Story Format v0.1

A **story** is a JSON file describing an interactive world. The engine reads the file, builds runtime state from it, and an LLM narrates over both. Authors write stories; the engine plays them.

This document is the source of truth for the format. The TypeScript types in [`app/src/story/schema.ts`](../app/src/story/schema.ts) are derived from it; the runtime validator in [`app/src/story/validate.ts`](../app/src/story/validate.ts) enforces it.

---

## Top-level shape

```json
{
  "schemaVersion": "0.1",
  "id": "my-story",
  "title": "My Story",
  "author": "Your Name",
  "description": "Optional short blurb shown in the story picker.",
  "intro": "Optional. Shown when a new game starts.",
  "systemPromptOverride": "Optional. Appended to the engine's narrator system prompt.",
  "startRoom": "starting-room-id",
  "startState": { "score": 0, "darkness": false },
  "rooms": [ ... ],
  "items": [ ... ],
  "triggers": [ ... ],
  "npcs": [ ... ],
  "winConditions": [ ... ],
  "loseConditions": [ ... ]
}
```

| Field | Required | Purpose |
|---|---|---|
| `schemaVersion` | yes | Must be `"0.1"` for now. Future versions will document migration. |
| `id` | yes | Unique slug, used for save segregation. Lowercase + hyphens recommended. |
| `title`, `author` | yes | Shown in the story picker. |
| `description`, `intro`, `systemPromptOverride` | no | Optional flavor and prompting hooks. |
| `startRoom` | yes | The id of the room where play begins. |
| `startState` | no | Initial flag values (`{ key: atom }`, where atom is string \| number \| boolean). |
| `rooms`, `items` | yes | Required arrays. Empty is allowed but unusual. |
| `triggers`, `npcs`, `winConditions`, `loseConditions` | no | Optional. Stories without win conditions are sandbox-mode. |

---

## Rooms

A room has an id, a name, a primary description, and (usually) exits.

```json
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
  }
}
```

- **`description`** is the canonical text. The engine sends it to the LLM as the room's "official" description.
- **`variants`** are evaluated in order; the first whose `when` is true overrides `description`. Use them sparingly — for genuine state-driven changes (window open, light on/off, NPC present).
- **`exits`** is a `direction → exit` map. Direction keys are lowercase, free-form (`north`, `south`, `up`, `down`, `in`, `out`, `enter`, etc.).
- **Exit `when`** gates use of the exit. If absent, the exit is always usable. If present and the condition is false, the engine refuses movement and shows `blockedMessage` (or a default refusal).
- **Exit `hidden: true`** keeps the exit off the listed-exits summary until `when` is true. Use for secret passages.

---

## Items

```json
{
  "id": "lantern",
  "name": "brass lantern",
  "synonyms": ["lantern", "lamp"],
  "adjectives": ["brass"],
  "description": "A battered brass lantern. It looks like it still works.",
  "location": "kitchen",
  "takeable": true,
  "lightSource": { "isLit": false }
}
```

- **`location`** is one of: a room id, `"inventory"` (player starts with it), or `"nowhere"` (not yet in play; revealed by a trigger later).
- **`takeable`** must be `true` for the player to pick it up. Defaults to `false`.
- **`fixed: true`** marks an item as scenery (referenced in narration but never moved). Mutually exclusive with `takeable`.
- **`synonyms` / `adjectives`** help the LLM (and a future deterministic parser) resolve player references. The LLM will usually resolve "lantern" → `lantern` even without synonyms, but they're worth listing for clarity.
- **`readable: { text }`** — `read X` shows this text.
- **`container: { openable, isOpen, capacity }`** — opt in to container behavior. Engine tracks open/closed state.
- **`lightSource: { isLit }`** — opt in to light behavior. Engine tracks lit state.

---

## Conditions

Conditions are boolean expressions over `GameState`. They appear in: exit gating, text variants, triggers, win/lose conditions.

| Type | Shape | Meaning |
|---|---|---|
| `flag` | `{ type, key, equals }` | `state.flags[key] === equals` |
| `hasItem` | `{ type, itemId }` | item is currently in player's inventory |
| `itemAt` | `{ type, itemId, location }` | item is at `roomId` \| `"inventory"` \| `"nowhere"` |
| `playerAt` | `{ type, roomId }` | player is currently in this room |
| `visited` | `{ type, roomId }` | player has entered this room at least once |
| `examined` | `{ type, itemId }` | player has examined this item at least once |
| `triggerFired` | `{ type, triggerId }` | a specific trigger has fired |
| `and` | `{ type, all: [Condition...] }` | all conditions are true |
| `or` | `{ type, any: [Condition...] }` | at least one condition is true |
| `not` | `{ type, condition }` | inner condition is false |

Condition trees can nest arbitrarily.

---

## Triggers

Triggers are how puzzles progress. After every player action, the engine checks each trigger. If `when` is true and the trigger hasn't fired (or `once: false`), it fires.

```json
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
  "effects": [
    { "type": "moveItem", "itemId": "key", "to": "chamber" }
  ],
  "narration": "Behind the painting, a brass key dangles from a small nail."
}
```

- **`once`** defaults to `true`. Set `false` for triggers that should re-fire whenever the condition is true (e.g. a recurring random encounter).
- **`effects`** mutate state. Run in order. See effects table below.
- **`narration`** is queued and woven into the LLM's next response as a state-change cue ("note that this just happened, please mention it"). The LLM may paraphrase or expand.

### Effects

| Type | Shape | Meaning |
|---|---|---|
| `setFlag` | `{ key, value }` | set `state.flags[key] = value` |
| `moveItem` | `{ itemId, to }` | move an item to a roomId, `"inventory"`, or `"nowhere"` |
| `movePlayer` | `{ to }` | teleport the player to a room (rare; usually exits handle movement) |
| `endGame` | `{ won, message }` | end the game immediately |

---

## Win and lose conditions

After every action and after triggers fire, the engine checks win/lose conditions. The first one whose `when` is true ends the game.

```json
"winConditions": [
  {
    "when": { "type": "playerAt", "roomId": "garden" },
    "message": "You have escaped into the garden. Adventure complete."
  }
]
```

If `winConditions` is absent or empty, the story is sandbox-mode and never ends on its own. The player can still quit.

---

## NPCs (v0.1 placeholder)

```json
{
  "id": "old-sailor",
  "name": "Old Sailor",
  "personality": "A weathered ex-sailor who's seen too much. Speaks slowly. Trusts no one but the lighthouse keeper.",
  "location": "tavern"
}
```

In v0.1, NPCs are a personality blurb the LLM uses to drive dialogue. Scripted reactions, dialogue trees, and NPC inventories are reserved for v0.2+. For now, treat NPCs as flavor — don't hang puzzle progression on them yet.

---

## Authoring checklist

A valid story has:

- [ ] All required top-level fields present
- [ ] `startRoom` matches an existing room id
- [ ] All exit `to` values match existing room ids
- [ ] All item `location` values are a room id, `"inventory"`, or `"nowhere"`
- [ ] All `itemId` references in conditions/effects match an existing item
- [ ] All `roomId` references match an existing room
- [ ] All `triggerId` references match an existing trigger
- [ ] No duplicate ids within a category (rooms, items, triggers, npcs)

The runtime validator (`validateStory` in [`app/src/story/validate.ts`](../app/src/story/validate.ts)) enforces all of these and reports specific paths on failure.

---

## Versioning

`schemaVersion` is required from day one. Future minor versions (`0.2`, etc.) will document migration steps. The engine refuses to load stories with unknown versions to avoid silent breakage.

---

## Reference: example story

See [`app/src/stories/hello-adventure.json`](../app/src/stories/hello-adventure.json) for a minimal three-room story exercising rooms, items, a trigger, and a win condition. It's the simplest non-trivial story you can write in this format.
