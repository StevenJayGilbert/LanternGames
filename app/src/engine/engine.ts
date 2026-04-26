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

    // Triggers and end-conditions only run after a successful action. A rejected
    // action (e.g. trying to take something that isn't there) shouldn't tick the
    // world forward.
    if (!actionResult.ok) {
      this.state = actionResult.state;
      return {
        event: actionResult.event,
        view: buildView(this.state, this.story),
        narrationCues: [],
        triggersFired: [],
        ok: false,
        ended: this.state.finished,
      };
    }

    const triggerOutcome = runTriggers(actionResult.state, this.story);
    let nextState = triggerOutcome.state;
    const ended = checkEndConditions(nextState, this.story);
    if (ended) nextState = { ...nextState, finished: ended };

    this.state = nextState;
    return {
      event: actionResult.event,
      view: buildView(this.state, this.story),
      narrationCues: triggerOutcome.cues,
      triggersFired: triggerOutcome.fired,
      ok: true,
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

export function runTriggers(state: GameState, story: Story): TriggerRunOutcome {
  const cues: string[] = [];
  const fired: string[] = [];
  const triggers = story.triggers ?? [];
  if (triggers.length === 0) return { state, cues, fired };

  let current = state;
  let changed = true;
  let iterations = 0;
  while (changed && iterations < MAX_TRIGGER_ITERATIONS) {
    changed = false;
    iterations++;
    for (const trigger of triggers) {
      if (shouldFire(trigger, current)) {
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

function shouldFire(trigger: Trigger, state: GameState): boolean {
  const once = trigger.once !== false; // default true
  if (once && state.firedTriggers.includes(trigger.id)) return false;
  return evaluateCondition(trigger.when, state);
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
    if (evaluateCondition(cond.when, state)) {
      return { won: true, message: cond.message };
    }
  }
  for (const cond of story.loseConditions ?? []) {
    if (evaluateCondition(cond.when, state)) {
      return { won: false, message: cond.message };
    }
  }
  return undefined;
}
