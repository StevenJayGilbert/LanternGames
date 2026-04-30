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

// ---------- Relevance-check helpers (currently unused) ----------
//
// These three helpers powered the per-turn conditional-tool filter that we
// retired in favor of always-on tools (see CustomTool partition section
// below). They're kept exported because they're general-purpose utilities
// for "does this signal matter right now?" reasoning and may be reused if
// we later need to trim intents from the system message (instead of from
// the tool list, which now lives entirely in the cache-stable tier).

// Every Condition the engine evaluates anywhere in the story.
export function collectConditionSites(story: Story): Condition[] {
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

export function conditionReferencesSignal(c: Condition, signalId: string): boolean {
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
export function evaluateAssumingIntent(
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

// ----- CustomTool partition: all tools always-on for cache stability -----
//
// All custom tools are now exposed every turn regardless of the
// alwaysAvailable flag. The tier partition is collapsed to keep the LLM's
// tool list byte-stable across turns — Anthropic's prompt cache prefix
// includes the tool list, so any per-turn churn in conditional tools
// invalidates the entire cache (system prompt + tools + history together).
// The ~1,550 extra cached tokens per turn are far cheaper than paying the
// cache-write premium on a ~17K-token prefix every time the conditional
// set shifted (which used to happen on most state changes — moves, takes,
// flag flips). Tool preconditions on the handler side keep the LLM from
// successfully calling tools out of context; visibility-gating was a
// performance concern, not a correctness one.
//
// The alwaysAvailable schema flag is preserved for forward flexibility
// (e.g. a future story-level opt-out for stories with hundreds of niche
// tools). It's a no-op today.

// All custom tools, always exposed.
export function alwaysOnCustomTools(story: Story): CustomTool[] {
  return story.customTools ?? [];
}

// Returns []. Kept as a callable so the narrator's per-turn debug-log code
// path and tests that distinguish "conditional vs always-on" still compile.
export function activeConditionalCustomTools(
  _state: GameState,
  _story: Story,
): CustomTool[] {
  return [];
}
