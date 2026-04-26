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
    - **Doors are a top-level kind**, not items-with-a-flag. Two-sided state, lock state, examineable from both sides — clean as their own type with `between: [roomId, roomId]`. Rooms reference doors in their `exits`.
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

## Phase 4 — Zork I as validation content

This is where we discover what the schema missed. Treat schema gaps as a feature — fix the schema, re-extract.

- [ ] Write `scripts/extract-zork.ts`: convert `zil-to-json/data/zork1/*.json` into a story file matching our schema
    - Walk room routines to capture description text + conditional variants (raw ZIL predicates as tags, normalize the ~10–15 stateful rooms)
    - Map objects with synonyms, adjectives, initial locations, flags
    - Hand-author triggers for the famous puzzles (mailbox open, lantern lit, troll sword, thief, dam, cyclops, Hades, etc.)
- [ ] Get above-ground area playable end-to-end (West of House → kitchen → forest)
- [ ] Identify and document schema gaps; loop back to Phase 2 to extend the schema if needed
- [ ] Stretch within phase: complete underground (cellar, troll room, maze, dam, coal mine)

## Phase 4.5 — Schema additions backlog (rolling)

Discoveries from Phase 4 play and from surveying established IF systems. All additions are **non-breaking** — every new field is optional, every new top-level kind is independent. Pull each one in when actual gameplay (or a planned story) demands it.

### Already in flight

- [x] `appearsIn?: string[]` for shared scenery (kitchen window, grate, river, stairs, etc.) — DONE
- [x] `put` action + `put` tool for placing items into containers — DONE
- [x] `Item.location` accepts item ids; engine accessibility walks the chain through open containers — DONE

### Tier 1 — Must-have (puzzles break without these)

- [ ] **DOORBIT extractor fix** — treat ZIL DOORBIT items as openable (`container: { openable: true }` with no capacity). Without this, the kitchen window, grate, trap door, etc. exist but can't be opened.
- [ ] **Item routine description extraction** — apply the room routine walker to items too. Many items (kitchen window, grate, mirror, dam controls) have placeholder descriptions because their text lives in routines, not LDESC.
- [ ] **`lockable: { isLocked: boolean; keyId?: string }`** — universal puzzle. Locked doors, trophy cases, safes. With `unlock(itemId, withItemId?)` action.
- [ ] **`openableWhen?: Condition` + `openBlockedMessage?: string`** on `container` — gates open/close on arbitrary conditions (room, items held, flags). Reuses the existing `Condition` language.
- [ ] **`scenery: boolean`** — distinct from `fixed`. Scenery suppresses auto-listing; fixed prevents movement. A pedestal can be fixed but listed.
- [ ] **`Door` as a top-level kind** — `id, name, description, between: [roomId, roomId], lockable?`. Rooms reference doors in their `exits` instead of inlining.
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

**Custom state + extensibility (future):**

The schema is intentionally narrow today: state is `flags` (string/number/boolean atoms), conditions are a fixed expression language, effects are a fixed action set. This will hit a ceiling. Stories will eventually need things we can't pre-bake:

- **Counters that can be modified** — score, turn count, weight carried, mana, hit points, currency. Currently flags hold values but there's no `incrementFlag` / `decrementFlag` effect or arithmetic in conditions.
- **Comparison/math conditions** — `score >= 100`, `weight + itemWeight <= capacity`. Currently `flag` only checks equality.
- **Custom state shapes** — collections (visited NPCs set, encountered items list), structured data (each NPC's mood map). Authors fake this with many flags.
- **Named handlers / hooks** — a story-supplied function called by the engine for a specific event ("when player drops X in room Y, compute random outcome"). For mechanics that can't be expressed declaratively (random encounters, physics simulations, complex NPC AI).

Likely design path (in rough order):

1. **Counter primitives** — easiest. Add `incrementFlag` / `decrementFlag` / `addToFlag` effects. Add `flagAtLeast` / `flagLessThan` / `flagBetween` conditions. Authors can build score/timer/weight systems from these.
2. **Computed conditions** — small expression language for arithmetic in `Condition` (e.g. `{ type: "compare", left: { flag: "score" }, op: ">=", right: { value: 100 } }`). Generalizes counter conditions.
3. **Named handlers** — story's JSON references named handlers; story bundle includes a JS/TS module mapping names to functions. Sandboxed execution. Engine calls handler at relevant lifecycle hooks (action attempt, after action, on enter room, etc.). Significant security and engineering surface — defer until a real story can't be expressed without it.

**What to do today:** keep the schema additive-friendly. Don't bake assumptions that flags are always atomic-equality. Don't make effect/condition unions hard to extend (they already aren't — adding new variants is a one-line union member).

**Door state — future multi-state path (not now, but design notes to preserve forward-compat):**

Today doors are binary (`isOpen: boolean`, condition `doorOpen`). Some real doors have intermediate states ("ajar," "half-open") that allow slipping items through but not the player. We deliberately don't model this yet, but the migration path is purely additive:

- Add `Door.openStates?: string[]` (ordered, e.g. `["closed","ajar","open"]`) and `Door.initialState?: string`. Default behavior unchanged when omitted.
- Add `GameState.doorState: Record<string, string>` for multi-state doors (existing `doorOpen` boolean stays for binary).
- Add `Condition.doorAtState(doorId, state)` and `Condition.doorAtLeast(doorId, state)`. Existing `doorOpen` semantically becomes "any non-closed state" — still correct.
- New actions for partial open (`openWider`, `pushOpen`) when needed; existing `open`/`close` continue to work.

**What we must not do** in the meantime to avoid cornering ourselves:
- Don't bake "open vs closed" into engine internals beyond the existing fields. Keep `Exit.door` semantics as "the door's gate condition passes," not "the door's boolean is true."
- Don't hardcode string comparisons like `"open"` outside the schema/extractor. Engine logic uses booleans / typed conditions.

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
