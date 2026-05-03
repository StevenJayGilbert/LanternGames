// Resolve {fromArg: "name"} placeholders in Conditions and Effects to literal
// strings using the args of a tool call. Used by the handler dispatcher
// before evaluating preconditions or applying effects, so the rest of the
// engine never has to deal with IdRefs.
//
// The substitution is shallow-typed: schema-wise only a few id fields are
// IdRef (Condition.itemState.itemId, Condition.itemAccessible.itemId,
// Condition.itemHasStateKey.itemId, Condition.itemReadable.itemId, Effect.setItemState.itemId). We cover
// those explicitly. Adding new IdRef fields means widening the schema arm
// AND adding a case here.

import type { Condition, Effect, IdRef } from "../story/schema";

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
