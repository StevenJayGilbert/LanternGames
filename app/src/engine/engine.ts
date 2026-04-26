// The top-level Engine wraps actions with the cross-cutting concerns:
//   - run triggers after every successful action (with fixed-point iteration so
//     cascading triggers settle before returning)
//   - check win/lose conditions
//   - guard against actions after the game has ended
//   - build a fresh WorldView snapshot to include in every result
//
// Every EngineResult carries a structured event (what happened) and a view
// (what the player can perceive now). Player-facing prose is the LLM's job
// (or render.ts for dev/test).

import type { GameState, Story, Trigger } from "../story/schema";
import { applyEffects, evaluateCondition, initialState } from "./state";
import { performAction, type ActionRequest } from "./actions";
import type { ActionEvent } from "./events";
import { buildView, type WorldView } from "./view";

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
    this.state = savedState ?? initialState(story);
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

    let nextState = phase3.state;
    const ended = checkEndConditions(nextState, this.story);
    if (ended) nextState = { ...nextState, finished: ended };

    this.state = nextState;
    return {
      event: actionResult.event,
      view: buildView(this.state, this.story),
      narrationCues: [...phase1.cues, ...phase2.cues, ...phase3.cues],
      triggersFired: [...phase1.fired, ...phase2.fired, ...phase3.fired],
      ok: actionResult.ok,
      ended: nextState.finished,
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
  const triggers = (story.triggers ?? []).filter((t) => !t.afterAction);
  if (triggers.length === 0) return { state, cues, fired };

  let current = state;
  let changed = true;
  let iterations = 0;
  while (changed && iterations < MAX_TRIGGER_ITERATIONS) {
    changed = false;
    iterations++;
    for (const trigger of triggers) {
      if (shouldFire(trigger, current, story)) {
        current = fireTrigger(trigger, current);
        if (trigger.narration) cues.push(trigger.narration);
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
  const triggers = (story.triggers ?? []).filter((t) => t.afterAction);
  if (triggers.length === 0) return { state, cues, fired };

  let current = state;
  for (const trigger of triggers) {
    if (shouldFire(trigger, current, story)) {
      current = fireTrigger(trigger, current);
      if (trigger.narration) cues.push(trigger.narration);
      fired.push(trigger.id);
    }
  }
  return { state: current, cues, fired };
}

function shouldFire(trigger: Trigger, state: GameState, story: Story): boolean {
  const once = trigger.once !== false; // default true
  if (once && state.firedTriggers.includes(trigger.id)) return false;
  return evaluateCondition(trigger.when, state, story);
}

function fireTrigger(trigger: Trigger, state: GameState): GameState {
  const withEffects = applyEffects(state, trigger.effects ?? []);
  return {
    ...withEffects,
    firedTriggers: withEffects.firedTriggers.includes(trigger.id)
      ? withEffects.firedTriggers
      : [...withEffects.firedTriggers, trigger.id],
  };
}

// ---------- End conditions ----------

export function checkEndConditions(
  state: GameState,
  story: Story,
): { won: boolean; message: string } | undefined {
  for (const cond of story.winConditions ?? []) {
    if (evaluateCondition(cond.when, state, story)) {
      return { won: true, message: cond.message };
    }
  }
  for (const cond of story.loseConditions ?? []) {
    if (evaluateCondition(cond.when, state, story)) {
      return { won: false, message: cond.message };
    }
  }
  return undefined;
}
