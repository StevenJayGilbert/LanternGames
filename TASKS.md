# LanternGames — Task Plan

(Working title was "ZorkAI" while Zork was the only test story; renamed once the engine proved generic across content.)

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
- **Maze navigation by dropping items** — the LLM can narrate this from itemAt visibility; no engine help needed beyond what exists.
- **Restore canonical max-score = 350** — current `max-score` is 357 because the wind-canary/bauble wiring landed without rebalancing the existing treasure scores down by 7. Canonical Zork I caps at 350 with `Master Adventurer` at 350. Several treasures over-score the canonical values (canary 6+4=10 vs canonical 4+4=8; etc.) — a balancing pass should shave the over-allocations to fit bauble's +7 inside 350.
- **Engine: let `itemById` resolve the synthesized player** — discovered while wiring F31 suicide-attack. The player-as-item refactor synthesizes `"player"` at engine init (in `state.itemLocations` and the runtime player-item shape) but the canonical item lookup `itemById(story, "player")` returns `undefined` because the player isn't in `story.items`. As a result, `engine.execute({ type: "attack", itemId: "sword", targetId: "player" })` is rejected with `unknown-item`. We worked around it by routing F31 through a customTool intent (`attack-self`), but the canonical-correct behavior is to allow the direct attack form. Fix: `itemById` (and probably `isItemAccessible`/`isItemPresent`) should special-case `"player"` to return the synthesized player descriptor. Once that lands, F31 can be tightened to the literal `attack(weapon, "player")` form, and the suicide-attack-self trigger can revert to gating on the engine's `attack-target` flag instead of an intent.
- **Match-lit lifecycle** — striking the match (state.isLit transition, 2-turn burn timer, lighting candles from a flaming match). Wiring it would let the gas-room explosion (F2) also catch lit-match entry. Currently F2's trigger only checks torch and candles. Would need an `extinguish-match` afterAction tick (auto-burnout after 2 turns) and `light-match` / `light-X-with-match` intents.
- **Smelly-room explosion** — some Zork I walkthroughs mark the smelly-room as gas-filled too, but the original ZIL source only fires the explosion in `gas-room` itself. We follow ZIL. If a future content pass wants the wider canonical-fragility model, extend the F2 trigger's `playerAt` check to include `smelly-room`.
- **Egg fragility from non-tree drops** — canonical Zork lets the egg break from being thrown, hit during combat, dropped from non-tree heights, etc. We only wire the `up-a-tree` drop case (F6). A wider fragility pass would either generalize via an `Item.fragile` flag + a generic damage trigger, or add per-room overrides where falls/impacts apply.
- **Reduced point values for broken-egg / broken-canary deposits** — canonical Zork I awards fewer points for depositing the broken-via-tree-drop pair than for the intact pair recovered via the thief's death. The current scoring system doesn't differentiate states. Would require either dual treasure ids (`egg` / `broken-egg`, `canary` / `broken-canary`) with different deposit rewards, or a state-aware scoring trigger (`if egg.broken` then award N points else M).
- **Variant descriptions for `egg.broken === true` and `canary.broken === true`** — once the F6 trigger flips these flags, an `Item.variants` entry should swap the egg's prose to "the broken jewel-encrusted egg, its shell split" and the canary's to "the clockwork canary, its delicate mechanism mangled and silent." Pure description polish; no mechanical effect.
- ~~**Canonical-text alignment pass (room descriptions)**~~ — IN PROGRESS. Built [docs/zork-canonical-text.md](docs/zork-canonical-text.md) (66 rooms parsed from [docs/walkthrough2.txt](docs/walkthrough2.txt)) and [docs/text-audit.md](docs/text-audit.md) (per-room verdicts: 50 identical, 14 equivalent, 24 partial, 5 wrong, 17 missing-canonical). First batch of fixes landed in `zork-1.overrides.json`: `kitchen`, `east-of-house`, `living-room`, `gallery` (reverted — painting takeable), `grating-clearing`, `grating-room`, `deep-canyon`, `bat-room`, `machine-room`, `aragain-falls`, plus `cyclops` item description. **Authoring rules established:**
    - Descriptions must be state-independent. No "locked" if unlockable, no "open" if closeable, no item references for items that can be removed.
    - Use the `variants?: TextVariant[]` field for state-conditional text overlays. Pattern: state-neutral base + variants keyed by `passageState` / `itemState` / `flag` Conditions.
    - For NPC/item descriptions that canonically appear inline in the room LDESC (cyclops, bat, troll, thief), put the canonical text on the NPC/item's `description` — engine displays them inline at view-render time.
    - Throwaway parser scripts: `app/scripts/parse-walkthrough.ts` (rooms → markdown reference) and `app/scripts/audit-text.ts` (per-room diff). Re-runnable for follow-up batches.
    - Follow-up batches: ~17 rooms with "missing-canonical" need ZIL fallback or manual review; item descriptions audit (~105 items) deferred. Walkthrough still 388/0/1 gap; smoke suites all pass.
- ~~**Comprehensive trap & failure-path coverage (F16–F36)**~~ — DONE. 21 new tests covering canonical Zork I deaths and trap mechanics, sourced from the ZIL files in `zork1-source/` and cross-referenced against [Eristic walkthrough](http://www.eristic.net/games/infocom/zork1.html) and the IF-community ways-to-die thread. Categories:
    - **Already-wired mechanics, just lacked tests:** F16 cyclops eats player, F17 cyclops feeds & sleeps, F19 bat carries, F20 garlic blocks bat, F21 coffin-cure passive, F22 empty-handed gate.
    - **Tier 1 deaths (newly wired):** F24 brush-teeth-with-putty (respiratory failure), F25 burn-leaves while carrying, F26 attack-with-rusty-knife (telekinetic possession), F27 leap from up-a-tree, F28 leap from canyon-view, F29 burn-book (guardian), F30 mung-bodies-in-hades (guardian), F31 attack-self (suicide), F32 throw-at-self.
    - **Tier 2 deaths and treasure-loss (newly wired):** F33 beach-hole-collapses on 4th dig, F34 mung-painting (treasure value zeroed via `painting.broken = true` flag, score-credit-painting now gates on `not(broken)`), F35 mung-sceptre at rainbow, F36 swim-in-river.
    - Walkthrough P6 thief combat updated: previously used the rusty-knife (which canonically possesses the wielder); now uses the attic `knife` (also bladed). Final results: 389 passed, 0 failed, 0 gaps.
    - Source-of-truth: [docs/zork-canon-sources.md](docs/zork-canon-sources.md) — ZIL line citations for each mechanic.
- ~~**WIND-CANARY → bauble pickup (P7 gap)**~~ — DONE. New `bauble` item (location: `nowhere`, treasure tag), `wind-canary` customTool, and two triggers: `canary-sings-for-bauble` (priority 10, once: true — songbird drops bauble in current forest room; up-a-tree → path special case) and `canary-wind-fallback` (priority 0, once: false — broken canary grinds, already-sung canary chirps blithely, non-forest-room chirps in vain). Guards on `not(canary.broken === true)` to handle uninitialized state correctly. F15 test confirms the broken-canary trap. `max-score` bumped 350 → 357 to accommodate the bauble's +1 take + +6 deposit.

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
- [x] **Generic randomness primitive** — `Effect.random { branches: [{weight, effects?, narration?}] }`. Weighted branch selection with per-branch narration cue and effects chain. Engine resolves random branches via `resolveEffects` helper (one roll per invocation, surfaces narration to cues). Reusable for combat, bat carry, thief table, dam timer flooding outcomes, etc.
- [x] **Item.variants** — parallel to Room.variants and Passage.variants. State-conditional alternate descriptions resolved by `examine` via `resolveItemDescription`. Used for sword glow ("glowing with a faint blue glow" when player carries it AND a hostile NPC is perceivable).
- [x] **Troll combat** — fully composed from primitives. Two `afterAction` ticks (player attacks troll, troll attacks player) each roll via `Effect.random` with light/serious/kill/miss outcomes. `troll-dies` regular trigger drops the axe + opens exits. `player-killed` ends the game when `flag('player-health')` hits zero. Sword glows when troll is perceivable (Item.variants). No NPC kind needed — troll is an Item with `state.hostile=true, state.health=10`.
- [x] **Generic `attack` primitive (engine has zero combat knowledge)** — `ActionRequest.attack { itemId, targetId, mode? }` and `ActionEvent.attacked { itemId, targetId, mode }`. Engine validates accessibility, sets four transient flags (`attack-weapon`, `attack-target`, `attack-mode`, `attack-this-turn`), emits the event. No HP, damage, statuses, or outcomes baked in — those are story conventions. Authors gate triggers on the flags + their chosen status state to model whatever combat shape they want. Same engine supports HP-based, narrative-only, or wound-level combat.
- [x] **`Item.tags?: string[]`** — author-defined classification labels (multi-class). Composes with two new Conditions: `itemHasTag { itemId, tag }` (direct) and `flagItemHasTag { flagKey, tag }` (look up an item id from a flag, then check its tags). Lets one class trigger cover N×M (weapon-class × target-class) combat pairs without enumeration. Used story-wide too: treasures, light sources, consumables, NPCs, etc.
- [x] **`Trigger.priority?: number`** (default 0) — higher fires first within a trigger pass; stable sort within a priority. Replaces implicit array-order ordering. Combined with the consume-the-flag pattern, lets status-aware overrides (priority 100) win over class triggers (priority 10) win over catchalls (priority -100).
- [x] **`Item.personality?: string`** — LLM-facing voice/manner note for NPCs and other speakable entities. Surfaced via `ItemView.personality`; system prompt instructs the LLM to embody it for free-form dialogue ("talk to troll", "ask wizard about gold"). Engine ignores entirely.
- [x] **`Story.templates?: Record<string, Partial<Item>>` + `Item.fromTemplate?: string`** — build-time templates that items inherit from. Extractor merges (item fields win at the leaf, arrays union, nested objects deep-merged) and strips `fromTemplate`. Engine never sees templates. Lets one definition seed many instances (mountain troll / swamp troll / troll king share state shape but vary in health and personality).
- [x] **Zork combat rewired around the generic `attack` primitive** — old auto-attack-every-turn replaced with: `combat-class-bladed-vs-troll` (priority 10, gates on `flagItemHasTag(attack-weapon, bladed)` — covers sword, axe, knife in one trigger); `combat-finish-unconscious-troll` (priority 100, instant kill on stunned target); `combat-axe-throw-vs-troll` (priority 50, mode-gated — throwing axe leaves it on the floor regardless of hit/miss); `combat-knife-vs-troll` (priority 50, weaker outcome table); `combat-troll-attacks-player` (afterAction tick, gated on engagement flag + troll-not-unconscious-or-down); `combat-disengage-on-flee`; `combat-cleanup` (priority -100 catchall); plus stuck-weapon recovery (active intent + passive 3-turn auto-release tick). Combat now starts only when the player explicitly attacks; troll just stands menacingly until then.
- [x] **`extractor mergeItems` now appends new override items** — previously override items only patched existing ids; new combat items (rusty-knife/axe state, knife template) require appending. Brand-new items must supply all required Item fields; validator catches gaps.
- [x] **NPC autonomous behavior pattern** — engine-blind recipe of four trigger kinds (provocation tick + threshold + autonomous-action tick + decay/reset) makes NPCs act on their own. Documented and proven on three NPCs in zork-1: **troll** snaps after 3 talks (NPC-initiated combat boots into the existing engagement loop); **cyclops** ticks a hunger counter while you linger and attacks at threshold 6 (full combat wiring incl. class trigger, dies, disengage); **thief** appears after 30 global turns, wanders the underground via random `Effect.random` over `moveItem` branches, steals treasures via OR-of-(playerAt + itemAt) pairs (no engine "co-located" Condition exists), drops everything to the Treasure Room on death. Zero engine code added — pure content + an NPC-dialogue-intent bullet in STYLE_INSTRUCTIONS that tells the LLM to call `recordIntent` before narrating in-character dialogue.
- [x] **`startState` boolean flag pre-init** — discovered during NPC autonomy authoring that `flag(key, false)` strict-compares against `undefined` (so unset boolean flags fail "false" gates silently). Pre-initialized `combat-engaged-with-troll`, `combat-engaged-with-cyclops`, `cyclops-flag`, `magic-flag`, `troll-flag`, `rug-moved-flag`, `dome-flag`, `attack-this-turn`, `global-turn-count`, `darkness-turns` in startState. Authors must do this for any boolean flag they gate "false" on.
- [x] **`moveItem.to` accepts item ids** — validator now matches what `Item.location` already permits (and what the runtime always supported). Lets `moveItem(treasure, "thief")` work for thief-steals; lets the player `put` mechanism's runtime parent be expressed in triggers. Self-containment (`moveItem(X, X)`) is rejected.
- [x] **Movement with extra nouns — STYLE_INSTRUCTIONS rule** — fixes the "go down the stairs" bug where the LLM saw a scenery item with a matching noun and refused movement. Rule: "extract just the direction; the room's `exits` list is the source of truth; do NOT refuse a movement command because of a named scenery item." Generalizes to "go up the chimney", "enter the kitchen", "climb the ladder", "go through the door". Tightened the `go` tool description with an explicit example.

### Soft-locks from unwired flag-gated exits (audit, 2026)

Originally 18 exits gated on flags that nothing set. After the canonical-Zork-puzzle batch (Phase 4 content wiring), only 3 remain — all from a single deferred puzzle.

| Flag | Puzzle | Status |
|---|---|---|
| ~~`won-flag`~~ | endgame stone barrow | ✓ WIRED — `unlock-endgame` trigger fires when all 18 treasures in trophy-case |
| ~~`low-tide`~~ | dam / reservoir drain | ✓ WIRED — yellow-button → bolt-with-wrench → 8-turn delay → `low-tide` |
| ~~`lld-flag`~~ | bell + book + candles ritual | ✓ WIRED — ring bell + read book at hades w/ lit candles |
| ~~`coffin-cure`~~ | coffin at altar | ✓ WIRED — passive: leave coffin out of inventory at south-temple |
| ~~`rainbow-flag`~~ | wave scepter at rainbow | ✓ WIRED — wave sceptre at end-of-rainbow or aragain-falls; pot-of-gold materializes |
| ~~`empty-handed`~~ | coal-mine "drop everything" | ✓ WIRED — 2 symmetric triggers track `inventoryCount` in real time, flipping `empty-handed` automatically as the player picks up / drops items. Player drops the lit lamp on the floor of timber-room (room stays lit via perceivable-light), squeezes through, retrieves on return. |
| ~~`deflate`~~ | magic raft / boat | ~~HOT-FIXED~~ (white-cliffs ungated). Boat itself deferred — vehicle concept missing; canonical mechanics doc'd in puzzle list below. |

Repro audit: same `node -e` snippet — re-running confirms **0 unwired flag-gated exits remain**. Down from 18 → 0 in one batch.

### Zork puzzles needing engine code (future work)

These still don't fit the current schema:

- ~~**Echo room → bar (platinum)**~~ — DONE. Item is `bar` (already extracted, was hidden via SACREDBIT in canonical); we adapt with `visibleWhen: flag(echo-spoken)`. Intent + 1 trigger.
- ~~**Coal → diamond machine**~~ — DONE. NEW `diamond` item appended via mergeItems, located at `nowhere` initially. `turn-machine-switch` intent + 2 triggers (success and no-coal-fallback) move coal to nowhere and diamond to machine-room when the lid is closed.
- ~~**Dam control panel**~~ — DONE. Multi-step canonical mechanics: yellow-button enables `gate-flag`, brown-button disables it, `turn-dam-bolt` (with wrench at dam-room) toggles `gates-open` and queues an 8-turn `low-tide-countdown` via afterAction tick, which then sets `low-tide`. 4 intents + 6 triggers + 4 flags.
- ~~**Bat carry**~~ — DONE. M-ENTER trigger (regular, gated on `playerAt(bat-room) AND not(garlic accessible) AND not(bat-carried-this-visit)`) with `Effect.random` over 8 canonical drop rooms. Reset trigger clears the flag when player leaves bat-room.
- ~~**Rainbow + scepter → pot of gold**~~ — DONE. Wave-scepter intent at end-of-rainbow OR aragain-falls. Sets `rainbow-flag`; pot-of-gold's `visibleWhen` flips it perceivable.
- ~~**Mirror room**~~ — DONE. Adapted from canonical RUB mechanic. `rub-mirror` intent + 2 directional triggers teleport player between mirror-room-1 and mirror-room-2.
- ~~**Bell + candles + book ritual** (LLD-flag)~~ — DONE. Adapted: ring-bell sets bell-rung; read-book-at-hades intent (gated on bell-rung + lit candles + book in inventory at hades) sets lld-flag and unblocks the in/south exits.
- ~~**Coffin at altar**~~ — DONE. Passive triggers (no intent): on/off based on whether player carries the coffin while at south-temple. Mirrors canonical SOUTH-TEMPLE-FCN exactly.
- ~~**Endgame stone barrow + won-flag**~~ — DONE. `unlock-endgame` trigger fires when all 18 treasures in trophy-case (15 original + bar + pot-of-gold + diamond), sets won-flag, narrates "almost inaudible voice" line. `stone-barrow-ends-game` afterAction trigger ends the game with credits when player enters.
- ~~**Coal-mine "drop everything" (`empty-handed`)**~~ — DONE. 2 symmetric triggers track inventoryCount and toggle the flag automatically.
- ~~**Boat / river travel**~~ — DONE via the new vehicle primitive (see Phase 4.5 schema additions below). `inflatable-boat` is a real engine vehicle with `state.inflation: deflated|inflated|punctured`, mobile=true so it travels with the player on go(). Boarding with any item tagged `weapon` triggers the puncture (`inVehicle + inventoryHasTag(weapon)` → eject + setItemState(punctured)). Per-river current via afterAction tick + threshold pattern: 5 ticks, 4 advances (river-1..4), 1 waterfall death (river-5). Putty repair available in tube. River-tick-counter resets on advance, no cascade.
- **Score system** — point-per-treasure, max 350; rank thresholds. Counter mechanics work but **dynamic narration substitution** (interpolating running score into prose) doesn't exist; would require templated narration. Defer.
- **Death + reincarnation** — current `player-killed` calls `endGame` (terminal). Needs new `respawn` effect OR per-treasure conditional moveItem chain to drop everything and respawn at temple altar.
- **Bank of Zork** — needs new rooms (`bank-of-zork`, `safe-deposit-room`) and new items (`portrait`, `stack-of-bills`). Complex spatial walk-through-walls puzzle. Author later as own batch.

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
- [x] **Vehicle primitive** — `Item.vehicle = { mobile?, enterableWhen?, enterBlockedMessage? }` + `GameState.playerVehicle: string | null` + `board(itemId)` / `disembark()` actions + `Condition.inVehicle({ itemId? })` + `Effect.setPlayerVehicle({ itemId })` + `WorldView.vehicle` field. Mobile vehicles travel with the player on `go()`; stationary ones reject movement (`vehicle-stationary`). The `inflatable-boat` is the first consumer; pattern generalizes to mounts, carts, magic carpets.
- [x] **`inventoryHasTag` Condition** — `{ type: "inventoryHasTag", tag: string }` mirrors `itemHasTag` but scopes to the player's inventory. Lets triggers fire on tag-based player state (e.g. `inVehicle(boat) AND inventoryHasTag(weapon)` → puncture) without enumerating item ids. Future weapons participate automatically by carrying the `weapon` tag.

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
- [x] **`attack(itemId, targetId, mode?)`** — DONE. Engine sets transient flags (`attack-weapon`, `attack-target`, `attack-mode`, `attack-this-turn`); story triggers compute outcomes. No weapon model in engine — authors classify weapons via tags and gate triggers on them.
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
- [x] **Randomness primitive** — `Effect.random { branches: [{weight, effects?, narration?}] }`. Generic weighted-branch selection with per-branch narration. `NumericExpr.random(min, max)` and `Condition.chance(probability)` not added — `Effect.random` covers the use cases without them.
- [x] **Combat / NPC HP model** — RESOLVED via the engine-blind `attack` primitive (above). Engine never models HP, damage, or NPC kinds. Authors define HP via `state.health` (number) on items, statuses via boolean state keys, weapon classifications via `tags`, and outcomes via `Effect.random` branches in story triggers. No NPC top-level kind needed — items with state and personality cover it.
- [ ] **Arithmetic NumericExpr** (`add`, `multiply`, `negate`) — prerequisite for proper buffs/debuffs. Once landed, `Effect.adjustItemState.by` becomes a NumericExpr and one combat trigger can compute `damage = base * (1 + pct/100) + add` from weapon state. Until then, buff state keys are author conventions but no engine math reads them.
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
- [ ] **Hint system / difficulty levels.** Player setting on the story picker (`Easy / Normal / Hard / Iron` or similar). Surfaces hints when the player asks ("hint", "I'm stuck", "what should I do?") and on Easy also volunteers them automatically after N turns of no progress. Two implementation paths to weigh:
    - **Authored hints (canonical-style):** stories declare a `hints?: Hint[]` array on each puzzle/trigger or at story root. Each hint has a `when` (Condition gating relevance — e.g., "player has the egg AND egg is closed AND not in treasure-room"), a `tier` (vague → specific → spoiler, à la InvisiClues), and `text`. Engine picks the first hint whose `when` is true at the player's current most-vague unspoiled tier. Costs nothing at runtime; authors control quality. Best fit for the Zork canon.
    - **LLM-derived hints:** at request time, send the LLM the current state, recent transcript, and the *expected* solution path (from a per-puzzle `solution: { steps, conditions }` field on the story), and have it generate a hint at the requested specificity. Cheaper to author, but quality varies and it can spoil unintended details.
    - Hybrid is realistic — authored hints for the major canonical puzzles (Zork's 30-ish set-pieces), LLM-derived for the long tail. Score penalty per hint surfaced (canonical Zork printed "Your score is being reduced" in InvisiClues mode); store `state.hintsUsed: number` and reflect in the rank message.

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
- [ ] **Validator rule: detect intent-loop foot-guns.** If a trigger has `once: false` AND its `when` evaluates `intentMatched(X)` (anywhere in the condition tree, including inside `and`/`or`/`not`), AND its effects don't include `removeMatchedIntent(X)` for that signal (anywhere, including inside `random` branches), warn at story-load. Reason: `matchedIntents` persists forever once flipped, so without consume-the-flag the trigger re-fires every iteration of the regular fixed-point loop and floods narrationCues until `MAX_TRIGGER_ITERATIONS` (100). Hit this in v0 — the hand-authored `lamp-lights` and `lamp-extinguishes` triggers shipped without the consume; ~100 duplicate "The brass lantern flickers on" cues per turn until detected via the dev debug panel. Caveat: false positives possible when `when` is `intentMatched(X) AND not(flag(Y))` and effects flip `flag(Y)` to invalidate the second clause — make the warning suppressible with a `$validator-skip-intent-loop-check: true` annotation on the trigger if needed. Existing reusable scan: see the inline `node -e` script used to detect the bug; that logic is the spec.
- [ ] Example stories shipped in-repo: 3-room toy, 10-room mid-size, the full Zork
- [ ] CLI: `npm run validate <story.json>` for authors editing locally
- [ ] (Stretch) In-browser story uploader so authors can playtest without forking the repo
- [ ] (Stretch) Visual map editor for room/exit graph
- [ ] (Stretch) Story-sharing library / community submissions

## Phase 10 — Polish & stretch

- [x] **`OllamaClient`** — local-LLM backend, the genuine $0 player tier. Talks to Ollama's OpenAI-compat endpoint at `localhost:11434/v1/chat/completions`. Defaults to `qwen3:14b` (parity with GPT-4 on practical tool-call evals; `qwen3:8b` for low-RAM). Two load-bearing translations: (a) Anthropic-style batched `tool_result` blocks split into separate OpenAI `role:"tool"` messages; (b) tool-call arguments arrive as JSON strings and get `JSON.parse`'d with try/catch. Plus three operational details: explicit `num_ctx: 32768` (Ollama's #1 footgun is its 4K default that silently truncates), `think: false` to disable Qwen3 reasoning chains, and `<think>...</think>` tag stripping for models that leak them. App.tsx adds a provider picker (Anthropic / Local) with conditional config form; localStorage tracks `provider`, `ollama_url`, `ollama_model`, `ollama_ready`. Three small-model reliability bullets added to STYLE_INSTRUCTIONS (don't call tools for chitchat, validate item ids against the view, re-anchor on NPC personality). 24-assertion deterministic smoke test (mocked fetch) covers the full request/response translation path. Browser CORS requires users to run `OLLAMA_ORIGINS="*" ollama serve` — surfaced in the gate's setup hint.
- [ ] **`OpenAIClient`** — same translation layer as OllamaClient against `api.openai.com`. ~30-line subclass once someone asks for it.
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
