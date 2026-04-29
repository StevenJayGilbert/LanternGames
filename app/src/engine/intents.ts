// Helpers for intent signals — the LLM-judged "did the player do something
// like this?" mechanism.
//
// The narrator gathers active signals each turn and includes them in the LLM
// prompt. This module computes which signals are actually relevant given
// current state, so we don't waste tokens asking the LLM about intents that
// can't matter right now.
//
// Relevance check: for each signal, scan every condition expression in the
// story that uses the engine's `evaluateCondition`. If any of those
// expressions WOULD pass when intentMatched(signalId) is treated as true,
// the signal is relevant — matching it could unblock something. Otherwise
// it's pointless to ask.
//
// This implements the "evaluate cheap conditions first; LLM-touching ones
// last" pattern: by substituting `true` for the intent and short-circuiting
// the AND/OR tree as usual, we never bother the LLM unless the surrounding
// cheap conditions already pass.

import type { Condition, CustomTool, GameState, Story } from "../story/schema";
import { evaluateCondition } from "./state";

// Every Condition the engine evaluates anywhere in the story.
function collectConditionSites(story: Story): Condition[] {
  const out: Condition[] = [];

  for (const room of story.rooms) {
    for (const v of room.variants ?? []) out.push(v.when);
    for (const exit of Object.values(room.exits ?? {})) {
      if (exit.when) out.push(exit.when);
    }
  }

  for (const passage of story.passages ?? []) {
    for (const v of passage.variants ?? []) out.push(v.when);
    if (passage.glimpse?.when) out.push(passage.glimpse.when);
    if (passage.traversableWhen) out.push(passage.traversableWhen);
    for (const side of passage.sides) {
      for (const v of side.variants ?? []) out.push(v.when);
      if (side.glimpse?.when) out.push(side.glimpse.when);
      if (side.traversableWhen) out.push(side.traversableWhen);
    }
  }

  for (const item of story.items) {
    if (item.container?.accessibleWhen) out.push(item.container.accessibleWhen);
    for (const v of item.variants ?? []) out.push(v.when);
  }

  for (const trigger of story.triggers ?? []) out.push(trigger.when);

  return out;
}

function conditionReferencesSignal(c: Condition, signalId: string): boolean {
  switch (c.type) {
    case "intentMatched":
      return c.signalId === signalId;
    case "and":
      return c.all.some((s) => conditionReferencesSignal(s, signalId));
    case "or":
      return c.any.some((s) => conditionReferencesSignal(s, signalId));
    case "not":
      return conditionReferencesSignal(c.condition, signalId);
    default:
      return false;
  }
}

// Evaluate a condition treating intentMatched(signalId) as true. If true,
// the signal is "relevant" — matching it would cause the condition to pass.
function evaluateAssumingIntent(
  c: Condition,
  state: GameState,
  story: Story,
  signalId: string,
): boolean {
  switch (c.type) {
    case "intentMatched":
      return c.signalId === signalId
        ? true
        : state.matchedIntents.includes(c.signalId);
    case "and":
      return c.all.every((s) => evaluateAssumingIntent(s, state, story, signalId));
    case "or":
      return c.any.some((s) => evaluateAssumingIntent(s, state, story, signalId));
    case "not":
      return !evaluateAssumingIntent(c.condition, state, story, signalId);
    default:
      return evaluateCondition(c, state, story);
  }
}

// ----- CustomTool partition: always-on (cache-stable) vs. conditional -----

// Always-on tools — exposed every turn regardless of state. Author opts in
// via alwaysAvailable: true. Cached in the stable tool tier.
export function alwaysOnCustomTools(story: Story): CustomTool[] {
  return (story.customTools ?? []).filter((t) => t.alwaysAvailable === true);
}

// Conditional tools — only exposed when at least one consuming trigger
// could fire. Same relevance check we do for any conditional tool, just over
// the customTools list.
export function activeConditionalCustomTools(
  state: GameState,
  story: Story,
): CustomTool[] {
  const tools = (story.customTools ?? []).filter((t) => t.alwaysAvailable !== true);
  if (tools.length === 0) return [];

  const sites = collectConditionSites(story);

  return tools.filter((tool) =>
    sites.some(
      (site) =>
        conditionReferencesSignal(site, tool.id) &&
        evaluateAssumingIntent(site, state, story, tool.id),
    ),
  );
}
