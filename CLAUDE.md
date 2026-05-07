# Project context for Claude

## What this project is

**LanternGames** is a generic LLM-narrated text-adventure engine. Authors write JSON story files; the engine is the source of truth for world state; an LLM (Claude or local Ollama) handles parsing player input and writing prose.

**Zork I is a test story, not the engine.** The engine and the narrator system prompt must remain story-agnostic. Zork-specific behavior lives in `app/src/stories/zork-1.overrides.json` (and the extractor `app/scripts/extract-zork.ts`, which is Zork-only by design).

## Critical rules

### 1. Never add Zork-specific code to the engine or narrator prompt

The engine in `app/src/engine/`, the schema in `app/src/story/schema.ts`, the narrator prompt in `app/src/llm/narrator.ts`, the validator in `app/src/story/validate.ts`, and the persistence layer in `app/src/persistence/localSave.ts` are all **generic**. They support any story that conforms to the schema. They MUST NOT reference Zork ids, Zork rooms, Zork items, or Zork-specific behaviors.

If a Zork puzzle exposes an engine gap, fix it by **adding a generic primitive** (a new Condition type, a new Effect type, a new Item capability) — not by hardcoding Zork's name in the engine. The Zork override file uses the new primitive; future stories use it too.

The narrator's STYLE_INSTRUCTIONS (`app/src/llm/narrator.ts`) are likewise universal. No Zork-specific instructions belong there.

Save migrations in `localSave.ts` may reference specific item ids when backfilling state for an in-flight story upgrade — but the migration logic itself stays generic; only the backfilled-defaults dictionary is content-specific.

### 2. Never put hints in narration

The narrator must NEVER tell the player how to solve puzzles. No "you might want to drop everything," "perhaps a key would help," "this lock looks pickable." Refusal narration may describe **why** an action fails atmospherically ("the passage narrows to a slit"), but it must NOT prescribe the solution ("if you drop everything you could squeeze through").

This applies to:
- `description` and `appearance` fields on items, rooms, passages.
- `successNarration` and `failedNarration` in customTool handlers.
- `narration` on triggers.
- `narrate` Effect text.
- `blockedMessage` on exits.

The player discovers solutions through experimentation. The narrator describes the world; it does not coach the player.

### 3. Never break the fourth wall

Refusal prose stays in story voice. Forbidden phrasings: "the game doesn't have a verb for that", "no command exists", "I don't have a tool for that", "that action isn't supported." Replace with in-world reasons in the room's tone. Already enforced by a STYLE rule in the narrator prompt — preserve it.

### 4. Always check plan-mode status before editing

Before any state-changing tool call — Edit, Write, Bash that mutates state, anything that touches the filesystem or shell — check whether plan mode is currently active. The system surfaces plan mode via "Plan mode is active" system reminders in the conversation. When plan mode is on, the ONLY file you may edit is the plan file named in the reminder; every other tool call must be read-only (Read, Grep, Glob, the Explore subagent).

A "Re-entering Plan Mode" reminder supersedes whatever task is in flight. If a state-changing edit is in progress when plan mode activates, stop immediately, leave the partial work, and return to planning.

If the user asserts you are in plan mode and your context doesn't show it, default to the user's assertion. They may be seeing UI signals you can't. Switch to read-only and ask for confirmation before continuing.

### 5. Re-enter plan mode after every code-change task

When a task that involved a state-changing tool call (Edit, Write, mutating Bash, anything that touches files or shell state) reaches a natural stopping point — final summary written, tests green, awaiting the user's next instruction — call `EnterPlanMode` before yielding the turn. The next user instruction lands in plan mode and starts with explicit alignment.

This applies to:
- Multi-step refactors and feature work, even if the user said "go ahead and do it" upfront — re-enter plan mode at the end, not between sub-steps the user already approved.
- Bug fixes that involved an Edit / Write.
- Test additions, doc updates, save migrations.

This does NOT apply to:
- Pure research / Q&A turns (no edits this turn).
- Single-call read-only lookups ("what does X do?", "where is Y wired?").
- Mid-task progress when more edits remain — only at the end.

If the user explicitly tells me to stay in execute mode for a follow-up sequence ("don't re-plan, just continue"), respect that and skip the call. Plan-mode entry is a request, not an enforcement; the user can always decline and continue in execute mode.

## Supporting docs

| Doc | What it's for |
|---|---|
| [docs/authors-guide.md](docs/authors-guide.md) | Tutorial for authors writing new stories. Cookbook of recipes (locked door, light source, container, vehicle, NPC, finite resource, burn timer, movement-blocked refusal, enter-room cue, multi-step ritual, scoring, random outcomes). Read this first to understand the authoring model. |
| [docs/story-format.md](docs/story-format.md) | Schema reference companion. Every type, every field. Use when you need the exact shape of a Condition / Effect / CustomTool / Passage / etc. |
| [docs/narrator-prompts.md](docs/narrator-prompts.md) | The LLM narrator's system prompt, documented and explained. Read before changing prompts. |
| [docs/dev.md](docs/dev.md) | Contributor / dev-environment notes. |
| [docs/local-llm.md](docs/local-llm.md) | Setting up Ollama for the free local-LLM tier. |
| [docs/puzzles.txt](docs/puzzles.txt), [docs/walkthrough.txt](docs/walkthrough.txt), [docs/walkthrough2.txt](docs/walkthrough2.txt) | Canonical Zork I puzzle / walkthrough notes. Reference when wiring Zork-specific overrides. |
| [docs/zork-canonical-text.md](docs/zork-canonical-text.md), [docs/zork-canon-sources.md](docs/zork-canon-sources.md) | Canonical Zork text + source citations for fidelity work. |
| [docs/text-audit.md](docs/text-audit.md) | Content-text audit notes for Zork. |
| [app/src/story/schema.ts](app/src/story/schema.ts) | The canonical TypeScript types. **Final source of truth.** If a doc and the schema disagree, the schema wins. |
| [app/src/stories/zork-1.overrides.json](app/src/stories/zork-1.overrides.json) | The biggest worked example (~12k lines). Most authoring patterns you'd want to write are already wired here. |

## Code organization

- `app/src/engine/` — generic engine. Action dispatch, state evaluation, view building, trigger cascade. **Never references story content.**
- `app/src/story/` — schema types, runtime validator. **Never references story content.**
- `app/src/llm/` — narrator (Claude/Ollama clients, system prompt). **Never references story content.**
- `app/src/persistence/` — save/load + migrations. Migrations may reference specific ids in backfill dictionaries.
- `app/src/stories/` — story files. **All Zork-specific logic lives here.** `zork-1.json` is the extracted/built file; `zork-1.overrides.json` is the hand-authored layer the extractor merges in.
- `app/scripts/` — build + test scripts. `extract-zork.ts` is Zork-only by design; `test-puzzles.ts` / `test-walkthrough.ts` exercise the Zork story; `smoke-handler.ts` exercises generic engine behavior.

## Workflow

1. Edit `app/src/stories/zork-1.overrides.json` (Zork content) or engine code (generic primitives).
2. Re-extract: `cd app && npx tsx scripts/extract-zork.ts`
3. Typecheck: `npx tsc --noEmit`
4. Run tests: `npx tsx scripts/test-puzzles.ts && npx tsx scripts/test-walkthrough.ts && npx tsx scripts/smoke-handler.ts`
5. Manual playtest in the app.

When adding a new engine primitive (Condition, Effect, etc.), update:
- [app/src/story/schema.ts](app/src/story/schema.ts) — type
- [app/src/story/validate.ts](app/src/story/validate.ts) — validator
- [app/src/engine/state.ts](app/src/engine/state.ts) — evaluator (Condition) or [actions.ts](app/src/engine/actions.ts) (Effect)
- [app/src/engine/substituteArgs.ts](app/src/engine/substituteArgs.ts) — IdRef substitution if applicable
- [docs/story-format.md](docs/story-format.md) — reference table
- [docs/authors-guide.md](docs/authors-guide.md) — recipe / pattern if it unlocks a new authoring move
- A smoke or puzzle test exercising the new primitive

## Save versioning

When adding new persistent state fields, bump `SAVE_VERSION` in [app/src/persistence/localSave.ts](app/src/persistence/localSave.ts) and add a backfill migration for older save versions. Test that old saves load cleanly with the new field defaulted.
