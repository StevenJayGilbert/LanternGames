# ZorkAI — Task Plan

**Project shape:** A generic LLM-driven text adventure engine. Players can play, authors can write. Zork I is the first test story — proof that the engine and schema can host a real, complex adventure. The deliverable is a runtime + schema, not a Zork port.

User brings their own Anthropic API key (BYOK). Static site, no backend at first; accounts added later.

## Decisions already made

- **Stack:** Vite + React + TypeScript
- **LLM:** Anthropic Claude via browser-direct calls (`dangerouslyAllowBrowser: true`), BYOK
- **Hosting:** Cloudflare Pages (static, free)
- **Storage v1:** localStorage (API key + saves, per-browser only)
- **Storage v2 (later):** Supabase free tier — accounts + cross-device saves; key stays local
- **Architecture:** Hybrid — deterministic TypeScript engine owns game state; LLM handles input parsing, narration, NPC dialogue, creative-puzzle adjudication
- **LLM call abstraction:** All model calls go through an `LLMClient` interface. Day-one impl is `DirectAnthropicClient` (BYOK browser-direct). Leaves room for `HostedProxyClient` (Phase 11) and `OllamaClient` (Phase 10) without touching the engine.
- **Monetization stance:** BYOK stays as a permanent free tier even if a hosted/paid tier is added later. Heavy users self-select to BYOK; casuals pay to skip the API-key friction.
- **Story format:** A generic JSON schema, story-agnostic. Stories are data files. The engine is the interpreter. (Phase 2 is where this gets specced.)
- **Zork's role:** Test content, not the product. Used to validate the schema is rich enough to host a real adventure. Other stories — including hand-written ones — are the long-term vision.
- **License of Zork content:** Code is MIT (Microsoft, Nov 2025). "Zork" trademark NOT licensed — the runtime ships under its own product name; Zork is included as one of several test stories with appropriate attribution.
- **Object model — three architectural commitments** (made after surveying Inform 7, TADS 3, Adventuron, Quest, ZIL):
    - **NPCs are a top-level kind**, not items with a personality field. Their state (mood, dialogue topics, schedule, reactions) is rich enough that overloading items would scatter NPC concerns across optional fields on every object.
    - **Passages are a top-level kind**, not items-with-a-flag. (Originally "Doors"; renamed because the same concept covers windows, chimneys, archways, gates, portals, narrow gaps, etc.) Two-sided, with per-passage typed state (`state: Record<string, Atom>`), per-side `traversableWhen`, per-side glimpses, examineable from either side. Rooms reference passages from their `exits` via `passage: <id>`. State mutation flows through triggers + `setPassageState` effect; the engine has no built-in open/close on passages — the player's intent is matched via `IntentSignal` and a trigger flips state.
    - **Container vs supporter are separate capability fields** (not unified `holds.mode`). An item can have both for chest-of-drawers cases. Easier to validate; clearer signal to the LLM ("in" vs. "on").

## Phase 1 — Foundation (de-risk the unknowns) — ✅ DONE

- [x] Scaffold Vite + React + TS project
- [x] Define `LLMClient` interface (`chat(messages, tools) → AsyncIterable<Chunk>`)
- [x] Implement `DirectAnthropicClient` (browser-direct, BYOK) against the interface
- [x] Build minimal "Hello Claude" loop: API-key input → password-masked → localStorage → call through `LLMClient` → render reply
- [x] Verify browser-direct Anthropic call works end-to-end
- [x] Add basic error handling (invalid key, rate limit, network failure)
- [x] BYOK input copy that sets correct expectations re: subscriptions vs API access
- [x] Workaround for `NODE_ENV=production` env quirk (`cross-env` in `dev` script)

## Phase 2 — Story schema design (the centerpiece) — ✅ DONE

- [x] Spec the story schema as a TypeScript type ([app/src/story/schema.ts](app/src/story/schema.ts)) covering rooms, items, conditions, effects, triggers, NPCs, win/lose
- [x] Write the "Hello, Adventure" story (3 rooms, 1 puzzle, 1 win condition) as a smoke test ([app/src/stories/hello-adventure.json](app/src/stories/hello-adventure.json))
- [x] Runtime validator with helpful error paths ([app/src/story/validate.ts](app/src/story/validate.ts)); used at app boot
- [x] Document the schema in [docs/story-format.md](docs/story-format.md)

JSON Schema (separate from TypeScript types) deferred until needed for an authoring CLI in Phase 9.

## Phase 3 — Engine v1 (story-agnostic) — ✅ DONE

- [x] Engine module: loads any schema-conformant story, builds initial GameState
- [x] Core actions implemented as pure functions: `look`, `examine`, `take`, `drop`, `inventory`, `go`, `open`, `close`, `read`
- [x] Trigger evaluator with fixed-point iteration (cascading triggers; safety cap at 100 iterations)
- [x] **Architecture refactor mid-phase:** actions return structured `ActionEvent` (not formatted strings); engine returns `event + view + cues`; LLM produces all prose. Dev-only renderer in [app/src/engine/render.ts](app/src/engine/render.ts) for testing.
- [x] LLM narrator integration via Anthropic tool-use ([app/src/llm/narrator.ts](app/src/llm/narrator.ts)) with 9 tools mirroring the actions
- [x] System prompt covers narration style + tool-use rules + story metadata
- [x] Conversation-history strategy: sliding window, 30 messages cap (revisit when Zork sessions get long)
- [x] End-to-end smoke test (the toy story is fully playable in the browser with LLM narration)
- [x] Pre-LLM deterministic command parser kept as [app/src/engine/parser.ts](app/src/engine/parser.ts) for reference / future fallback (currently unused by the UI)

## Phase 4 — Zork I as validation content (ongoing)

This is where we discover what the schema missed. Treat schema gaps as a feature — fix the schema, re-extract.

- [x] **`scripts/extract-zork.ts`**: converts `zil-to-json/data/zork1/*.json` into a story file. Mechanical pass: rooms (LDESC + routine-walked M-LOOK branches), items (CONTBIT/LIGHTBIT/READBIT/etc), exits (UEXIT/CEXIT/DEXIT), passages (DOORBIT promotion). Authored content lives in [`app/src/stories/zork-1.overrides.json`](app/src/stories/zork-1.overrides.json) and is merged in by the extractor — adding a new puzzle is a JSON edit, no code change.
- [x] **Above-ground playable end-to-end**: west-of-house → all four sides → forest paths → kitchen → attic. Working including the kitchen-window puzzle.
- [x] **Schema gaps loop**: discovered + fixed: appearsIn for shared scenery; per-side passage glimpse; typed passage state; typed item state; intent signals (LLM-judged fuzzy match); triggers; `compare` + NumericExpr (generic counters); `openWhen`/`closeWhen` (conditional auto-gen); merge-by-id overrides JSON layer.
- [ ] **Underground stretch**: cellar/troll combat, maze navigation, dam controls, coal mine, Hades — most still need engine features (see Phase 7 puzzle list).

### Zork puzzles wired (no engine changes needed)

Authored in [`zork-1.overrides.json`](app/src/stories/zork-1.overrides.json):

- **Kitchen window** — open/close intent gates traversal east-of-house ↔ kitchen.
- **Chimney** — kitchen→studio always refused; studio→kitchen requires lamp + ≤2 carried items.
- **Rope + dome** — tie rope to railing in Dome Room → flips dome-flag → unlocks dome-room.down → torch-room (and the entire Hades / Egyptian / Altar branch beyond).
- **Egg + songbird** — `openWhen: never` suppresses naive open; give-egg-to-songbird intent + trigger flips state.isOpen and reveals canary.
- **Move the rug** — gates trap-door open via rug-moved-flag.
- **Cyclops magic word** — "ulysses"/"odysseus" sets cyclops-flag + magic-flag (he flees, smashes wall to living-room shortcut).
- **Cyclops feed alternative** — give lunch + bottle; cyclops sleeps (cyclops-flag only, no wall smash).
- **Pray at altar** — teleport from south-temple to forest-1.
- **Locked grate** — `openWhen: hasItem(keys)` (the maze's skeleton key).
- **Trophy case win condition** — all 15 currently-extracted treasures in trophy-case → win. Aspirational: 4 more treasures (diamond, platinum bar, pot of gold, crystal sphere) need their puzzles wired before the game is winnable.

### Zork puzzles needing schema-only authoring (low-hanging follow-ups)

Doable now in JSON; just haven't been wired:

- **Bell + candles + book sequence** in temple/Hades — would set flags. No effect today because the spirits in Land-of-Dead aren't modeled as blockers (they're scenery in extraction).
- **Sword glows red/blue near danger** — would need `variants` on `Item` (currently only `Room` and `Passage` have it). Schema extension; trivial when added.
- **Maze navigation by dropping items** — the LLM can narrate this from itemAt visibility; no engine help needed beyond what exists.

### Zork puzzles wired in this batch — landed

- [x] **Lantern battery** — `lamp.state.batteryTurns: 330` decremented by an `afterAction once:false` tick trigger while `state.isLit: true`; auto-extinguishes at 0 with the canonical narration.
- [x] **Light / extinguish lamp** — `light-lamp` and `extinguish-lamp` intents + triggers (hand-authored; auto-gen could be added later for `lightSource` items).
- [x] **Grue / darkness death** — composed entirely from generic primitives. Story-level `defaultVisibility` Condition hides items/passages/exits when `currentRoomState(dark, true) AND not(anyPerceivableItemWith(isLit, true))`. `sharedVariants` swaps room description to "It is pitch black. You are likely to be eaten by a grue." Three afterAction tick triggers maintain a `darkness-turns` counter and end the game on the second consecutive dark turn. ~65 dark rooms marked via `state: { dark: true }` overrides.
- [x] **Room.state symmetry** — `Room.state` parallel to `Item.state`/`Passage.state`; `roomState` / `currentRoomState` Conditions; `roomState` NumericExpr; `setRoomState` Effect; `GameState.roomStates`.
- [x] **Per-turn ticks** — `Trigger.afterAction: true`. Engine.execute now has Phase 1 (regular fixed-point) → Phase 2 (afterAction once each) → Phase 3 (regular cascade).
- [x] **Counter mutation primitives** — `Effect.adjustFlag { key, by }` and `Effect.adjustItemState { itemId, key, by }` (signed deltas; treat unset as 0). Skipping adjustRoomState / adjustPassageState until first needed.
- [x] **Generic visibility primitives** — `Item.visibleWhen`, `Passage.visibleWhen`, `PassageSide.visibleWhen`, `Exit.visibleWhen`, `Story.defaultVisibility`, `Story.sharedVariants`. Engine has no darkness-aware code; authors compose perception filters from generic Conditions. Visibility participates in both view-rendering AND `isItemAccessible`, so `take` in the dark fails the same way `take leaflet` in the kitchen would: `not-accessible` rejection.
- [x] **`anyPerceivableItemWith` Condition** — generic "any perceivable item satisfies state[key] === equals." Used by darkness for "any lit lamp"; reusable for "any broken thing", "any magical thing", etc.
- [x] **lightSource → state.isLit migration** — `Item.lightSource: {}` is now a marker; lit state lives in `state.isLit`. `GameState.lightSourcesLit` removed. Validator rejects legacy `lightSource.isLit` with a migration hint.

### Zork puzzles needing engine code (future work)

These still don't fit the current schema:

- **Echo room → silver bar** — needs an item-add path in the overrides merge (currently merge only modifies existing items by id; new items would need to be appended, parallel to passages).
- **Inflate raft with pump** — raft item not extracted; same item-add gap as above. After mergeItems supports appending, this becomes content.
- **Coal → diamond machine** — multi-step puzzle (coal in machine, screwdriver to lid, switch). Doable as content, but needs the diamond and machine outputs handled by triggers.
- **Dam control panel** — multi-button state. Could be done with passage state + 4 intents; needs content.
- **Boat / river travel** — directional travel along a river with current; landing decisions; cliff death. Needs travel mechanic.
- **Troll combat** — turn-based fight, randomness, sword hits. Needs combat loop + NPC HP.
- **Thief NPC** — wandering, steals, fights. Needs NPC tick mechanism (now possible via afterAction triggers + an NPC kind).
- **Bat carry** — randomly transports player to one of several rooms. Needs randomness primitive in effects.
- **Score system** — point-per-treasure, max 350; rank thresholds. Now possible with counter primitives; just needs the per-treasure trigger plumbing + display.
- **Death + reincarnation** — needs death state + altar-respawn integration.
- **Rainbow + scepter → pot of gold** — wave scepter at rainbow → solidifies → cross to pot. Specific intent + state + new exit.
- **Bank of Zork** — walk through specific wall combinations. Specific.
- **Mirror room** — break mirror, walk through. Specific.

## Phase 4.5 — Schema additions backlog (rolling)

Discoveries from Phase 4 play and from surveying established IF systems. All additions are **non-breaking** — every new field is optional, every new top-level kind is independent. Pull each one in when actual gameplay (or a planned story) demands it.

### Already in flight

- [x] `appearsIn?: string[]` for shared scenery (kitchen window, grate, river, stairs, etc.)
- [x] `put` action + `put` tool for placing items into containers
- [x] `Item.location` accepts item ids; engine accessibility walks the chain through open containers
- [x] **Intent signals + triggers** — LLM-judged fuzzy player intent → engine flag flip. Used for every open/close + every story-specific puzzle.
- [x] **Compare + NumericExpr** — generic numeric comparisons (replaced narrow `inventoryCount` Condition). Sources: literal, flag, passageState, itemState, inventoryCount, itemCountAt, matchedIntentsCount, visitedCount.
- [x] **`openWhen?: Condition` / `closeWhen?: Condition`** on Item and Passage — extra Condition AND'd into the auto-gen open/close intent's active clause. Enables locked-chest, ritual-only-open, suppress-auto-gen patterns. Egg + grate + trap-door use it.
- [x] **Overrides JSON layer** — [`zork-1.overrides.json`](app/src/stories/zork-1.overrides.json) holds hand-authored content (descriptions, glimpse prompts, manual passages, room exit patches, intents, triggers, win/lose conditions) merged into the mechanical extraction by id. Adding a new puzzle is a JSON edit, not a code change.

### Tier 1 — Must-have (puzzles break without these)

- [x] **DOORBIT → Passage** — DOORBIT objects are promoted to top-level `Passage` (kitchen-window, trap-door, grate). Open/close handled via auto-generated intent signals + triggers; traversal gated by `traversableWhen`.
- [ ] **Item routine description extraction** — apply the room routine walker to items too. Many items (kitchen window, grate, mirror, dam controls) have placeholder descriptions because their text lives in routines, not LDESC.
- [ ] **`lockable: { isLocked: boolean; keyId?: string }`** — universal puzzle. Locked doors, trophy cases, safes. With `unlock(itemId, withItemId?)` action.
- [x] **Unify container open/close with the passage model** — DONE. Items have generic typed `state` (parallel to Passage); `container.accessibleWhen` (Condition) gates access to contents; mutation flows through trigger-fired `setItemState` effects. Engine `open`/`close` actions deleted. Extractor auto-generates open/close intent+trigger pairs for any item or passage with `state.isOpen` (and break intent+trigger for `state.broken`). Same machinery now powers container open/close, passage open/close, and item breakable.
- [ ] **`scenery: boolean`** — distinct from `fixed`. Scenery suppresses auto-listing; fixed prevents movement. A pedestal can be fixed but listed.
- [x] **Passage as a top-level kind** — DONE. `Passage = { id, name, description, sides: [PassageSide, PassageSide], state?, traversableWhen?, traverseBlockedMessage? }`; rooms reference passages via `exit.passage`. Per-side overrides (name/description/glimpse/traversableWhen) supported.
- [ ] **Reservoir room placeholder** — one-off; routine walker missed this room's M-LOOK branch.

### Tier 2 — Should-have (common, workaroundable for now)

- [ ] **`supporter: { capacity? }`** — things on top of (table, altar, pedestal, shelf). Parallel to `container`. An item can have both.
- [ ] **`wearable: boolean`** + **`worn: boolean`** — cloak, ring, spacesuit, Babel fish. Two flat booleans.
- [ ] **`device: { isOn: boolean }`** — switchable things that aren't lights (radios, machines, buttons, levers).
- [ ] **`NPC` as a top-level kind** — `id, name, description, location, personality, dialogueTopics?, mood?, schedule?`. Engine tracks state; LLM drives dialogue from `personality`. Floyd, the troll, the thief.
- [ ] **`backdrop: boolean`** hint on items with `appearsIn` — signals the LLM to treat as ambient ("the river runs east-west") rather than discrete.

### Tier 3 — Defer until a story needs them

These exist in established systems but would be over-engineering until we have a concrete puzzle that demands them. The LLM can usually narrate them from a generic flag plus a trigger.

- `transparent: boolean` (glass cases — see contents without opening)
- `edible`, `drinkable`
- `flammable`, `burnable`
- `climbable` (often expressible as a custom exit)
- `enterable` / `vehicle` (Zork II boat, Eliza's couch)
- `pushable between rooms`
- `region` (story-wide grouping; LLM handles ambient mood from prose)
- `weapon`, `plural-named`, `proper-named` — niche or LLM-handled

### Architectural deliberately not added

The LLM-as-narrator architecture lets us skip ~30 properties Inform 7 has specifically because of its parser:

- Listing/grouping rules ("a brass lamp and three coins")
- Pluralization, gender, articles, mass-noun handling
- Most disambiguation properties (`proper-named`, `plural-named`, etc.)
- Verb-extension hooks for verbs the LLM can narrate generically

If a story really needs a named property, add it. Don't pre-add the parser-driven set.

### Actions backlog (player verbs)

Current engine verbs: `look`, `examine`, `take`, `drop`, `inventory`, `go`, `open`, `close`, `read`, `put`. Below are candidate additions surfaced by play and design discussion. The LLM handles arbitrary natural language, so these are about which verbs the **engine** needs to enforce as state-changing actions vs. let the LLM narrate generically.

**Already mapped:**
- **Place / put on** → covered by `put` (places into a container). For surfaces ("place X on table"), needs a `supporter` field on the target item — Tier 2 schema item already in the backlog. Likely the same `put` action with target being a supporter.

**Candidates to add (Tier 1 — common across adventures):**
- [ ] **`consume(itemId)`** — single action that absorbs eat/drink/swallow/taste. Item must have an `edible` and/or `drinkable` capability flag (Tier 3 schema). Engine: removes item from inventory, fires any author-defined trigger (poison, healing, satiation). LLM picks the right verb in narration based on the item's flags.
- [ ] **`throw(itemId, targetId?)`** — toss/hurl/throw at. Optional target (item, NPC, or door). Variants like "throw through" (window/gap) handled by passing a door id as target. Engine: item leaves inventory; with target, may fire trigger or move item to other side / break / hit target. LLM resolves the player's intent ("throw rock at troll" vs. "throw key through window") to the right targetId.
- [ ] **`use(itemId, targetId?)`** — generic "use X on Y" for cases that don't fit a specific verb (apply, attach, push, etc.). May supersede some specific verbs.

**Candidates to consider (Tier 2):**
- [ ] **`give(itemId, npcId)`** — hand item to NPC. Requires NPC kind (Tier 2 schema).
- [ ] **`attack(itemId?, targetId)`** — combat or destruction; needs a weapon model.
- [ ] **`talk(npcId, topicId?)`** — conversation; deeper NPC schema needed.
- [ ] **`light(itemId)` / `extinguish(itemId)`** — toggle a `lightSource`. Engine already tracks lit state; missing the verb.
- [ ] **`wear(itemId)` / `remove(itemId)`** — toggle `worn` on a wearable item.

**Physical properties — weight, size, fit (future):**

Many puzzles in established adventures depend on physical constraints the
current schema doesn't model. Two related additions:

- **`Item.weight?: number`** + **`Item.size?: number`** — abstract units; authors choose their meaning. Engine then supports:
    - `Condition.inventoryWeight { op, value }` — total weight carried
    - `Condition.inventorySize { op, value }` — total volume/size carried
    - Container `weightCapacity?`, `sizeCapacity?` — refuse `put` when exceeded
- **`Door.openingSize?: number`** + per-side variants — refuses `go` if the player (counted as size N) plus carried items exceed the opening. Useful for "you're too encumbered to climb through that gap" cases (the chimney puzzle is a degenerate count-based version of this).

These compose with `inventoryCount` (already implemented) to express:

- "Carry only as much as you can lift." (weight)
- "Carry only what fits in your pack." (size; or container capacity)
- "Don't try to climb the chimney with both arms full." (count or size)
- "The mailbox is too small for that letter." (item size vs. container sizeCapacity)
- "You can't squeeze the harpsichord through the door." (door openingSize)

**Implementation order** when ready: weight first (broadest impact), then size, then door openingSize. Adding them is purely additive — items without `weight` are treated as 0 (or unlimited capacity); existing stories keep working.

**How these slot into existing primitives:** weight/size totals and per-item values all just become new variants in the `NumericExpr` discriminated union (already in the schema). The `compare` condition automatically supports comparing any of them to literals or to each other. No new condition types needed — only new value kinds. Same pattern as `inventoryCount` already uses.

**Custom state + extensibility:**

Schema state today: per-flag atoms + per-passage typed `state: Record<string, Atom>` + per-item typed `state: Record<string, Atom>`. Conditions: fixed expression language including `compare` over a `NumericExpr` union (literals, flags, passageState, itemState, inventoryCount, itemCountAt, matchedIntentsCount, visitedCount). Effects: setFlag, moveItem, movePlayer, setPassageState, setItemState, endGame.

- [x] **Comparison/math conditions** — `compare` + `NumericExpr` lands the "score >= 100" / "weight <= capacity" pattern generically. New numeric sources are one-case extensions of `NumericExpr`.
- [x] **Counter mutation primitives** — `Effect.adjustFlag { key, by }` and `Effect.adjustItemState { itemId, key, by }`. Signed deltas; treat unset as 0. Used by lantern battery + grue darkness counter.
- [x] **Per-turn ticks** — `Trigger.afterAction: true` fires after every action exactly once (not in a fixed-point loop, to avoid counter-incrementing infinite loops). Engine.execute runs Phase 1 (regular fixed-point) → Phase 2 (afterAction) → Phase 3 (regular cascade). Used by lantern battery drain and grue darkness check; ready for thief wandering, dam timer, etc.
- [ ] **Randomness primitive** — `Effect.movePlayer` to one of N options; `NumericExpr.random(min, max)`; `Condition.chance(probability)`. Needed for bat carry, troll attacks, thief encounters.
- [ ] **Combat / NPC HP model** — separate concern from above; probably needs an NPC top-level kind with `hp`, `damage`, attack/defense triggers.
- [ ] **Custom state shapes** (collections, structured data) — authors fake with many flags today. Defer until a story actually needs sets/maps.
- [ ] **Named handlers / hooks** — JS escape hatch for story-supplied functions. Significant security surface; defer until a real story can't be expressed declaratively.

**Passage state — already general, no migration needed:**

Originally a "future multi-state doors" concern. Resolved by the **Passage refactor** (Door → Passage with typed `state: Record<string, Atom>`). A passage now carries any number of typed state variables of any Atom type, so multi-state ("ajar"/"half-open"/"open") is just a string key authors declare and manipulate via `setPassageState`. `Condition.passageState` is equality; `compare` + `NumericExpr.passageState` handles ordered comparison for numeric counters. No new condition or effect types needed.

What's still future:
- A convenience for ordered state ("string enum where 'open' >= 'ajar' >= 'closed'"). For now authors can model with a numeric state (0..2) + `compare` instead.
- Per-side `state` overlay (rare; YAGNI).

**Defer / LLM-handles-with-prose:**
- Smell, listen, taste (without eating), touch, kiss, dance, sleep, wait, sing, yell. These don't change engine state for most stories. The LLM can respond in prose with `examined`-style sensory descriptions or just narrate "you sing; nothing happens."

**Design principle worth committing to:** keep the engine's verb set small and **state-changing**. Any verb that doesn't change persistent game state is the LLM's job (it narrates from the current view + story tone). Each engine verb is a contract: when called, the engine commits a specific state mutation. If two player intents map to the same state mutation (eat / drink / consume), they share one engine action. If two intents have different mutations (throw at / drop on the floor), they're separate actions.

This means `consume` is one action regardless of food vs. drink (the *narration* differs by item flags, the *state change* is the same). `throw` is one action with optional target (the target shape determines what mutation fires). Don't proliferate engine verbs to match natural-language richness — that's what the LLM is for.

## Phase 5 — UI

- [ ] Terminal-style game console (scrollback + monospace)
- [ ] Command input with history (up-arrow recalls)
- [ ] Loading indicator while Claude is thinking
- [ ] Mobile-friendly layout
- [ ] Save game to localStorage (auto-save + manual save slots; multi-story aware)
- [ ] Story picker — list all loadable stories from `public/stories/`
- [ ] Export/import save as JSON file (workaround for cross-device until Supabase phase)

## Phase 6 — First deploy

- [ ] Push repo to GitHub
- [ ] Connect Cloudflare Pages, configure build (`npm run build`, output `dist/`)
- [ ] Verify deployed URL works end-to-end with a real key, against both the toy story and Zork start area
- [ ] Settle a product name (NOT "Zork"; trademark risk). Examples to riff on: "Lantern", "Adventurer", "Scribe Tales", "Grueless".
- [ ] Share with one or two friends; collect feedback

## Phase 7 — Complete Zork I as flagship test story

- [ ] Expand engine to cover any verbs Zork needs that aren't yet in the core verb set
- [ ] Author all major puzzles as schema triggers, falling back to LLM judgment for fuzzy ones
- [ ] Win condition: all 19 treasures in the trophy case
- [ ] Score tracking and ranks
- [ ] End-to-end winnability playtest

## Phase 8 — Accounts and cloud saves

- [ ] Sign up for Supabase, create project
- [ ] Schema: `users` (auth) + `saves` (user_id, story_id, slot, world_state_json, updated_at)
- [ ] Wire Supabase auth (email + at least one OAuth provider)
- [ ] Sync strategy: local-first, push to cloud when authenticated; conflict resolution by `updated_at`

## Phase 9 — Authoring (the actual long-term goal)

The point of building a generic engine. If Phase 4 proved the schema can host real stories, this phase makes it usable by people who aren't us.

- [ ] Author docs: `docs/story-format.md` polished, complete, with examples for every feature
- [ ] Standalone JSON Schema validator + helpful error messages (catch typos, dangling references, unreachable rooms)
- [ ] Example stories shipped in-repo: 3-room toy, 10-room mid-size, the full Zork
- [ ] CLI: `npm run validate <story.json>` for authors editing locally
- [ ] (Stretch) In-browser story uploader so authors can playtest without forking the repo
- [ ] (Stretch) Visual map editor for room/exit graph
- [ ] (Stretch) Story-sharing library / community submissions

## Phase 10 — Polish & stretch

- [ ] Multi-LLM: `OllamaClient` (only path to true $0 player experience) and `OpenAIClient` implementations of `LLMClient`
- [ ] Add Zork II, Zork III as additional test stories (data already in `zil-to-json/data/`)
- [ ] Achievements / leaderboard
- [ ] Sound / music toggle
- [ ] Accessibility pass (screen reader, keyboard-only)

## Phase 11 — Hosted/paid tier (optional, only if there's demand)

Deferred until BYOK is stable, deployed, and there is real evidence of users churning over the API-key friction. BYOK stays as the free tier regardless.

- [ ] Implement `HostedProxyClient` against the existing `LLMClient` interface (frontend change is one line)
- [ ] Build proxy backend on Cloudflare Workers: auth check → rate limit → call Anthropic with platform key → log usage
- [ ] Per-user usage tracking table in Supabase (already exists for accounts by then)
- [ ] Spend monitoring + alarm (critical — runaway loops can drain the platform key fast)
- [ ] Payment via LemonSqueezy (merchant of record — handles VAT/sales tax in 70+ countries; ~5% + 50¢ per txn)
- [ ] Pricing model decision: token bucket vs. subscription with soft cap. Run the numbers against real session data from BYOK users first.
- [ ] Terms of service, privacy policy, refund policy
- [ ] Customer-support email pipeline (basic)

**Realistic effort estimate:** ~2 weeks of focused work, mostly backend + payments. Frontend change is trivial because of the `LLMClient` abstraction baked in at Phase 1.

## Open questions / unresolved design choices

- **Faithful vs. generative spectrum** — how strictly does the engine constrain the LLM? Default to ~70/30 faithful (engine owns state; LLM owns prose), revisit after Phase 3 once we've seen it in motion.
- **Tool-use granularity** — one big `execute_action(verb, object)` tool, or many small typed tools (`take`, `go`, etc.)? Lean toward many small tools for clearer model behavior.
- **Trigger DSL expressiveness** — keep it simple (boolean conditions over flags + state mutations) vs. add scripting affordances (counters, side-effects on other objects, scheduled events)? Start simple; expand only when a Zork puzzle forces it.
- **Conversation history strategy** — full history vs. summarized vs. state-only? Affects token cost a lot. Start with last N turns + state snapshot.
- **Product name** — needs to land before public deploy (Phase 6).
- **Schema versioning** — once stories exist in the wild, schema breaking changes will need a migration story. Bake `schemaVersion` into the format from day one.
