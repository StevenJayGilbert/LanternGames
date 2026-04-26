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

import type { Condition, GameState, IntentSignal, Story } from "../story/schema";
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
  }

  for (const trigger of story.triggers ?? []) out.push(trigger.when);
  for (const c of story.winConditions ?? []) out.push(c.when);
  for (const c of story.loseConditions ?? []) out.push(c.when);

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

// The signals worth showing the LLM right now: not already matched, the
// author's active gate passes, and matching them would actually unblock at
// least one condition site.
export function gatherActiveIntentSignals(
  state: GameState,
  story: Story,
): IntentSignal[] {
  const signals = story.intentSignals ?? [];
  if (signals.length === 0) return [];

  const sites = collectConditionSites(story);

  return signals.filter((signal) => {
    if (state.matchedIntents.includes(signal.id)) return false;
    if (signal.active && !evaluateCondition(signal.active, state, story)) return false;
    return sites.some(
      (site) =>
        conditionReferencesSignal(site, signal.id) &&
        evaluateAssumingIntent(site, state, story, signal.id),
    );
  });
}
