// Resolve IdRef placeholders to literal strings.
//
// Two reference modes:
//   - {fromArg: "name"}: pulls from tool-handler call args. Handler
//     dispatcher (and built-ins like `take`, which inject `self: itemId`)
//     pass these args in.
//   - {fromIntent: signalId, key}: pulls from state.matchedIntentArgs.
//     Used inside trigger effects/conditions to reference args of a
//     matched intent earlier this turn — e.g. {fromIntent: "drop",
//     key: "itemId"} resolves to whichever item the player just dropped.
//     Requires `state` to be threaded through the substitution call.
//
// Adding new IdRef fields to the schema means adding a case here.

import type { Condition, Effect, GameState, IdRef, NumericExpr } from "../story/schema";

type Args = Record<string, unknown>;

function resolveIdRef(ref: IdRef, args: Args, state?: GameState): string | null {
  if (typeof ref === "string") return ref;
  if ("fromArg" in ref) {
    const value = args[ref.fromArg];
    if (typeof value === "string") return value;
    // Missing or wrong-typed arg — return null. Callers treat null as
    // "skip this Condition/Effect" which gracefully degrades rather
    // than crashing. Missing (undefined) is the LEGITIMATE optional-arg
    // case used by handler preconditions like hasItem({fromArg:
    // "withItemId"}); silent. Wrong-typed values (number/object) are
    // real authoring bugs — keep the warning for those.
    if (value !== undefined) {
      console.warn(`[substituteArgs] arg "${ref.fromArg}" is not a string:`, value);
    }
    return null;
  }
  // fromIntent: pull from state.matchedIntentArgs (trigger context).
  if (state) {
    const v = state.matchedIntentArgs[ref.fromIntent]?.[ref.key];
    if (typeof v === "string") return v;
  }
  // Either no state was passed (called from a handler context) or the
  // intent's arg isn't a string. Skip the Condition/Effect.
  return null;
}

// Walk a NumericExpr tree; substitute IdRefs in the kinds that have them.
// Returns null if any required substitution fails.
export function substituteNumericExpr(
  expr: NumericExpr,
  args: Args,
  state?: GameState,
): NumericExpr | null {
  switch (expr.kind) {
    case "itemState": {
      const id = resolveIdRef(expr.itemId, args, state);
      if (id === null) return null;
      return { ...expr, itemId: id };
    }
    case "passageState": {
      const id = resolveIdRef(expr.passageId, args, state);
      if (id === null) return null;
      return { ...expr, passageId: id };
    }
    case "add": {
      const left = substituteNumericExpr(expr.left, args, state);
      if (left === null) return null;
      const right = substituteNumericExpr(expr.right, args, state);
      if (right === null) return null;
      return { kind: "add", left, right };
    }
    case "negate": {
      const of = substituteNumericExpr(expr.of, args, state);
      if (of === null) return null;
      return { kind: "negate", of };
    }
    default:
      // No IdRef fields in this kind.
      return expr;
  }
}

// Walk a Condition tree; substitute IdRefs in arms that have them.
// Returns null if any required substitution fails.
export function substituteCondition(
  c: Condition,
  args: Args,
  state?: GameState,
): Condition | null {
  switch (c.type) {
    case "itemState": {
      const id = resolveIdRef(c.itemId, args, state);
      if (id === null) return null;
      return { ...c, itemId: id };
    }
    case "itemAccessible": {
      const id = resolveIdRef(c.itemId, args, state);
      if (id === null) return null;
      return { ...c, itemId: id };
    }
    case "hasItem": {
      const id = resolveIdRef(c.itemId, args, state);
      if (id === null) return null;
      return { ...c, itemId: id };
    }
    case "itemHasStateKey": {
      const id = resolveIdRef(c.itemId, args, state);
      if (id === null) return null;
      return { ...c, itemId: id };
    }
    case "itemReadable": {
      const id = resolveIdRef(c.itemId, args, state);
      if (id === null) return null;
      return { ...c, itemId: id };
    }
    case "passageState": {
      const id = resolveIdRef(c.passageId, args, state);
      if (id === null) return null;
      return { ...c, passageId: id };
    }
    case "passagePerceivable": {
      const id = resolveIdRef(c.passageId, args, state);
      if (id === null) return null;
      return { ...c, passageId: id };
    }
    case "passageHasStateKey": {
      const id = resolveIdRef(c.passageId, args, state);
      if (id === null) return null;
      return { ...c, passageId: id };
    }
    case "compare": {
      const left = substituteNumericExpr(c.left, args, state);
      if (left === null) return null;
      const right = substituteNumericExpr(c.right, args, state);
      if (right === null) return null;
      return { ...c, left, right };
    }
    case "and": {
      const subs: Condition[] = [];
      for (const sub of c.all) {
        const r = substituteCondition(sub, args, state);
        if (r === null) return null;
        subs.push(r);
      }
      return { type: "and", all: subs };
    }
    case "or": {
      const subs: Condition[] = [];
      for (const sub of c.any) {
        const r = substituteCondition(sub, args, state);
        if (r === null) return null;
        subs.push(r);
      }
      return { type: "or", any: subs };
    }
    case "not": {
      const r = substituteCondition(c.condition, args, state);
      if (r === null) return null;
      return { type: "not", condition: r };
    }
    default:
      // No IdRef fields — return as-is.
      return c;
  }
}

// Walk an Effect tree; substitute IdRefs in arms that have them.
export function substituteEffect(
  e: Effect,
  args: Args,
  state?: GameState,
): Effect | null {
  switch (e.type) {
    case "moveItem": {
      const id = resolveIdRef(e.itemId, args, state);
      if (id === null) return null;
      return { ...e, itemId: id };
    }
    case "setItemState": {
      const id = resolveIdRef(e.itemId, args, state);
      if (id === null) return null;
      return { ...e, itemId: id };
    }
    case "setPassageState": {
      const id = resolveIdRef(e.passageId, args, state);
      if (id === null) return null;
      return { ...e, passageId: id };
    }
    case "adjustFlag": {
      // `by` may be a literal number or a NumericExpr possibly containing IdRefs.
      if (typeof e.by === "number") return e;
      const by = substituteNumericExpr(e.by, args, state);
      if (by === null) return null;
      return { ...e, by };
    }
    case "adjustItemState": {
      const id = resolveIdRef(e.itemId, args, state);
      if (id === null) return null;
      const by = typeof e.by === "number" ? e.by : substituteNumericExpr(e.by, args, state);
      if (by === null) return null;
      return { ...e, itemId: id, by };
    }
    case "if": {
      // Substitute inside the condition AND both effect arms.
      const cond = substituteCondition(e.if, args, state);
      if (cond === null) return null;
      const thens: Effect[] = [];
      for (const sub of e.then) {
        const r = substituteEffect(sub, args, state);
        if (r === null) return null;
        thens.push(r);
      }
      let elses: Effect[] | undefined;
      if (e.else) {
        elses = [];
        for (const sub of e.else) {
          const r = substituteEffect(sub, args, state);
          if (r === null) return null;
          elses.push(r);
        }
      }
      return { type: "if", if: cond, then: thens, else: elses };
    }
    default:
      return e;
  }
}
