// Resolve {fromArg: "name"} placeholders in Conditions, Effects, and
// NumericExprs to literal strings using the args of a tool call. Used by the
// handler dispatcher before evaluating preconditions or applying effects, so
// the rest of the engine never has to deal with IdRefs.
//
// Built-in actions also call this — e.g. `take` substitutes `self: itemId` so
// authored takeableWhen conditions can reference the item being taken via
// `{fromArg: "self"}`.
//
// Adding new IdRef fields to the schema means adding a case here.

import type { Condition, Effect, IdRef, NumericExpr } from "../story/schema";

type Args = Record<string, unknown>;

function resolveIdRef(ref: IdRef, args: Args): string | null {
  if (typeof ref === "string") return ref;
  const value = args[ref.fromArg];
  if (typeof value === "string") return value;
  // Missing or wrong-typed arg — return null. Callers treat null as "skip
  // this Condition/Effect" which gracefully degrades rather than crashing.
  console.warn(`[substituteArgs] arg "${ref.fromArg}" is not a string:`, value);
  return null;
}

// Walk a NumericExpr tree; substitute IdRefs in the kinds that have them.
// Returns null if any required substitution fails.
export function substituteNumericExpr(expr: NumericExpr, args: Args): NumericExpr | null {
  switch (expr.kind) {
    case "itemState": {
      const id = resolveIdRef(expr.itemId, args);
      if (id === null) return null;
      return { ...expr, itemId: id };
    }
    case "passageState": {
      const id = resolveIdRef(expr.passageId, args);
      if (id === null) return null;
      return { ...expr, passageId: id };
    }
    case "add": {
      const left = substituteNumericExpr(expr.left, args);
      if (left === null) return null;
      const right = substituteNumericExpr(expr.right, args);
      if (right === null) return null;
      return { kind: "add", left, right };
    }
    case "negate": {
      const of = substituteNumericExpr(expr.of, args);
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
export function substituteCondition(c: Condition, args: Args): Condition | null {
  switch (c.type) {
    case "itemState": {
      const id = resolveIdRef(c.itemId, args);
      if (id === null) return null;
      return { ...c, itemId: id };
    }
    case "itemAccessible": {
      const id = resolveIdRef(c.itemId, args);
      if (id === null) return null;
      return { ...c, itemId: id };
    }
    case "itemHasStateKey": {
      const id = resolveIdRef(c.itemId, args);
      if (id === null) return null;
      return { ...c, itemId: id };
    }
    case "itemReadable": {
      const id = resolveIdRef(c.itemId, args);
      if (id === null) return null;
      return { ...c, itemId: id };
    }
    case "passageState": {
      const id = resolveIdRef(c.passageId, args);
      if (id === null) return null;
      return { ...c, passageId: id };
    }
    case "passagePerceivable": {
      const id = resolveIdRef(c.passageId, args);
      if (id === null) return null;
      return { ...c, passageId: id };
    }
    case "passageHasStateKey": {
      const id = resolveIdRef(c.passageId, args);
      if (id === null) return null;
      return { ...c, passageId: id };
    }
    case "compare": {
      const left = substituteNumericExpr(c.left, args);
      if (left === null) return null;
      const right = substituteNumericExpr(c.right, args);
      if (right === null) return null;
      return { ...c, left, right };
    }
    case "and": {
      const subs: Condition[] = [];
      for (const sub of c.all) {
        const r = substituteCondition(sub, args);
        if (r === null) return null;
        subs.push(r);
      }
      return { type: "and", all: subs };
    }
    case "or": {
      const subs: Condition[] = [];
      for (const sub of c.any) {
        const r = substituteCondition(sub, args);
        if (r === null) return null;
        subs.push(r);
      }
      return { type: "or", any: subs };
    }
    case "not": {
      const r = substituteCondition(c.condition, args);
      if (r === null) return null;
      return { type: "not", condition: r };
    }
    default:
      // No IdRef fields — return as-is.
      return c;
  }
}

// Walk an Effect tree; substitute IdRefs in arms that have them.
export function substituteEffect(e: Effect, args: Args): Effect | null {
  switch (e.type) {
    case "setItemState": {
      const id = resolveIdRef(e.itemId, args);
      if (id === null) return null;
      return { ...e, itemId: id };
    }
    case "setPassageState": {
      const id = resolveIdRef(e.passageId, args);
      if (id === null) return null;
      return { ...e, passageId: id };
    }
    case "adjustFlag": {
      // `by` may be a literal number or a NumericExpr possibly containing IdRefs.
      if (typeof e.by === "number") return e;
      const by = substituteNumericExpr(e.by, args);
      if (by === null) return null;
      return { ...e, by };
    }
    case "adjustItemState": {
      const id = resolveIdRef(e.itemId, args);
      if (id === null) return null;
      const by = typeof e.by === "number" ? e.by : substituteNumericExpr(e.by, args);
      if (by === null) return null;
      return { ...e, itemId: id, by };
    }
    case "if": {
      // Substitute inside the condition AND both effect arms.
      const cond = substituteCondition(e.if, args);
      if (cond === null) return null;
      const thens: Effect[] = [];
      for (const sub of e.then) {
        const r = substituteEffect(sub, args);
        if (r === null) return null;
        thens.push(r);
      }
      let elses: Effect[] | undefined;
      if (e.else) {
        elses = [];
        for (const sub of e.else) {
          const r = substituteEffect(sub, args);
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
