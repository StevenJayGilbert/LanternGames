// The top-level Engine wraps actions with the cross-cutting concerns:
//   - run triggers after every successful action (with fixed-point iteration so
//     cascading triggers settle before returning)
//   - guard against actions after the game has ended
//   - build a fresh WorldView snapshot to include in every result
//
// Win/lose state is set exclusively by `endGame` effects from triggers — there
// is no separate winConditions/loseConditions polling step.
//
// Every EngineResult carries a structured event (what happened) and a view
// (what the player can perceive now). Player-facing prose is the LLM's job
// (or render.ts for dev/test).

import type { Atom, GameState, Story, Trigger } from "../story/schema";
import { currentRoomId, evaluateCondition, initialState, resolveEffects, roomById } from "./state";
import { performAction, type ActionRequest } from "./actions";
import type { ActionEvent } from "./events";
import { buildView, type WorldView } from "./view";
import { renderNarration } from "./renderNarration";
import { debugLog } from "../debug";

export interface EngineResult {
  event: ActionEvent;        // what happened (or why the action was rejected)
  view: WorldView;           // current world state from the player's perspective
  narrationCues: string[];   // queued narration from triggers; LLM weaves in
  triggersFired: string[];   // ids of triggers that fired this turn
  ok: boolean;               // did the action itself succeed
  ended?: { won: boolean; message: string };
}

// Hard cap on cascading-trigger iteration to prevent runaway loops if a story
// has triggers that flip each other's conditions.
const MAX_TRIGGER_ITERATIONS = 100;

export class Engine {
  readonly story: Story;
  state: GameState;

  constructor(story: Story, savedState?: GameState) {
    this.story = story;
    if (savedState) {
      // Re-snapshot roomStates from the current story. Saved roomStates are
      // a frozen copy of room.state taken at game-start; if the story is
      // edited between sessions (e.g., a room loses its `dark` flag after
      // a content fix), the player's save still holds the old value and the
      // fix never reaches them. zork-1 has no triggers that mutate room
      // state via setRoomState, so a fresh re-snapshot loses nothing. If a
      // future story uses setRoomState for runtime mutations, this would
      // need to merge story-as-baseline + saved-as-overlay — for now the
      // simple re-snapshot is correct.
      const refreshedRoomStates: Record<string, Record<string, Atom>> = {};
      for (const r of story.rooms) {
        if (r.state) refreshedRoomStates[r.id] = { ...r.state };
      }
      this.state = { ...savedState, roomStates: refreshedRoomStates };
    } else {
      this.state = initialState(story);
    }
  }

  // Execute a single action request and return the per-turn result.
  execute(req: ActionRequest): EngineResult {
    if (this.state.finished) {
      return {
        event: { type: "rejected", reason: "game-over" },
        view: buildView(this.state, this.story),
        narrationCues: [],
        triggersFired: [],
        ok: false,
        ended: this.state.finished,
      };
    }

    const previousLocation = currentRoomId(this.state, this.story);
    const actionResult = performAction(this.state, this.story, req);

    // Phase 1: regular trigger fixed-point loop. Skipped on rejection because
    // no engine state changed — there's nothing to cascade off of.
    const phase1 = actionResult.ok
      ? runTriggers(actionResult.state, this.story)
      : { state: actionResult.state, cues: [], fired: [] };

    // Phase 2: afterAction (tick) triggers fire exactly once each. ALWAYS runs
    // — including on rejected actions — because a turn passing is a turn
    // passing regardless of whether the player's specific verb succeeded. This
    // is canonical: in Zork even invalid commands tick the world (lantern
    // drains, grue closes in, thief moves, dam timer counts down).
    const phase2 = runAfterActionTriggers(phase1.state, this.story);

    // Phase 3: regular fixed-point loop, picking up cascades from phase-2
    // effects (e.g. battery hit zero → lamp extinguishes → dependent triggers
    // fire). Runs whether the action succeeded or not.
    const phase3 = runTriggers(phase2.state, this.story);

    const nextState = phase3.state;

    const newLocation = currentRoomId(nextState, this.story);
    if (newLocation !== previousLocation && newLocation) {
      const room = roomById(this.story, newLocation);
      debugLog(
        "rooms",
        `[room] ${previousLocation} → ${newLocation}` +
          (room ? ` (${room.name})` : ""),
      );
    }

    const view = buildView(nextState, this.story);
    this.state = nextState;

    return {
      event: actionResult.event,
      view,
      // Action cues (e.g. tool handler success/failure text) come first; trigger
      // cues follow. Order matters: the handler narration sets the scene, then
      // any cascading triggers add their flavor.
      narrationCues: [
        ...(actionResult.cues ?? []),
        ...phase1.cues,
        ...phase2.cues,
        ...phase3.cues,
      ],
      triggersFired: [...phase1.fired, ...phase2.fired, ...phase3.fired],
      ok: actionResult.ok,
      ended: this.state.finished,
    };
  }

  // Snapshot of the current view, e.g. for rendering at game start before any
  // action has been executed.
  getView(): WorldView {
    return buildView(this.state, this.story);
  }

  reset(): void {
    this.state = initialState(this.story);
  }
}

// ---------- Trigger evaluator ----------

interface TriggerRunOutcome {
  state: GameState;
  cues: string[];
  fired: string[];
}

// Regular triggers run in a fixed-point loop (state changes → re-evaluate).
// Filtered to triggers WITHOUT `afterAction: true` — those are tick triggers
// handled by `runAfterActionTriggers` instead.
export function runTriggers(state: GameState, story: Story): TriggerRunOutcome {
  const cues: string[] = [];
  const fired: string[] = [];
  const triggers = sortByPriority((story.triggers ?? []).filter((t) => !t.afterAction));
  if (triggers.length === 0) return { state, cues, fired };

  let current = state;
  let changed = true;
  let iterations = 0;
  while (changed && iterations < MAX_TRIGGER_ITERATIONS) {
    changed = false;
    iterations++;
    for (const trigger of triggers) {
      if (shouldFire(trigger, current, story)) {
        const result = fireTrigger(trigger, current, story);
        current = result.state;
        if (trigger.narration) cues.push(renderNarration(trigger.narration, {}, story, current));
        cues.push(...result.cues);
        fired.push(trigger.id);
        changed = true;
      }
    }
  }
  if (iterations >= MAX_TRIGGER_ITERATIONS) {
    console.warn(
      `[engine] trigger evaluator hit ${MAX_TRIGGER_ITERATIONS} iterations — possible cycle`,
    );
  }
  return { state: current, cues, fired };
}

// Tick triggers fire AT MOST ONCE per action — not in a fixed-point loop. This
// avoids infinite loops on counter-incrementing ticks (e.g. `darkness-turns`)
// whose `when` stays true after the effect runs. Cascades from tick effects
// are picked up by a follow-up regular `runTriggers` call in `Engine.execute`.
export function runAfterActionTriggers(
  state: GameState,
  story: Story,
): TriggerRunOutcome {
  const cues: string[] = [];
  const fired: string[] = [];
  const triggers = sortByPriority((story.triggers ?? []).filter((t) => t.afterAction));
  if (triggers.length === 0) return { state, cues, fired };

  let current = state;
  for (const trigger of triggers) {
    if (shouldFire(trigger, current, story)) {
      const result = fireTrigger(trigger, current, story);
      current = result.state;
      if (trigger.narration) cues.push(renderNarration(trigger.narration, {}, story, current));
      cues.push(...result.cues);
      fired.push(trigger.id);
    }
  }
  return { state: current, cues, fired };
}

// Sort triggers by priority descending (higher fires first). Stable: equal
// priorities keep their authored array order. Triggers without a priority
// default to 0.
function sortByPriority(triggers: Trigger[]): Trigger[] {
  return triggers
    .map((t, i) => ({ t, i }))
    .sort((a, b) => {
      const pa = a.t.priority ?? 0;
      const pb = b.t.priority ?? 0;
      if (pa !== pb) return pb - pa;
      return a.i - b.i;
    })
    .map((x) => x.t);
}

function shouldFire(trigger: Trigger, state: GameState, story: Story): boolean {
  const once = trigger.once !== false; // default true
  if (once && state.firedTriggers.includes(trigger.id)) return false;
  return evaluateCondition(trigger.when, state, story);
}

// Fires a trigger: resolves any `random` effects (rolling once each, capturing
// their narration cues), applies the resolved effects, and marks the trigger
// as fired. Returns both the new state and any cues from random branches —
// the trigger's own `narration` is handled by the caller.
function fireTrigger(
  trigger: Trigger,
  state: GameState,
  story: Story,
): { state: GameState; cues: string[] } {
  // resolveEffects now applies the effects in order against rolling state
  // (so an `if` later in the list sees a `setFlagRandom` earlier in the
  // list). The returned `effects` array is always empty; we use the
  // returned `state` directly.
  const resolved = resolveEffects(trigger.effects, state, story);
  return {
    state: {
      ...resolved.state,
      firedTriggers: resolved.state.firedTriggers.includes(trigger.id)
        ? resolved.state.firedTriggers
        : [...resolved.state.firedTriggers, trigger.id],
    },
    cues: resolved.cues,
  };
}

