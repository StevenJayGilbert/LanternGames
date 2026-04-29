// Smoke test for the conditional Effect primitives:
//   - `setFlagRandom`: roll a uniform random integer into a flag
//   - `if`/`then`/`else`: deterministic conditional with optional else
//   - `narrate`: emit a narration cue into narrationCues
//
// The legacy `random` Effect has been removed; its expressive power is
// recovered by composing setFlagRandom + if/then/else + narrate.

import { Engine } from "../src/engine/engine";
import { applyEffect, resolveEffects } from "../src/engine/state";
import type { Story, Effect } from "../src/story/schema";

let passed = 0;
let failed = 0;

function pass(label: string) {
  console.log(`  ✓ ${label}`);
  passed++;
}
function fail(label: string, detail?: string) {
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  failed++;
}

// Minimal fixture — one room, a few flags. Avoids dragging in the full Zork
// JSON so the assertion surface stays tiny.
const story: Story = {
  schemaVersion: "0.1",
  id: "_smoke",
  title: "Conditional Effects Smoke",
  author: "test",
  startRoom: "r1",
  rooms: [{ id: "r1", name: "R1", description: "" }],
  items: [],
  startState: { a: false, b: false, picked: "", _roll: 0 },
};

function freshEngine(): Engine {
  return new Engine(story);
}

// ---------- setFlagRandom: range correctness ----------

console.log("\n=== setFlagRandom range ===");
{
  const eff: Effect = { type: "setFlagRandom", key: "_roll", min: 1, max: 6 };
  const seen = new Set<number>();
  let outOfRange = false;
  for (let i = 0; i < 1000; i++) {
    const e = freshEngine();
    const next = applyEffect(e.state, eff, story);
    const v = next.flags["_roll"];
    if (typeof v !== "number" || v < 1 || v > 6 || !Number.isInteger(v)) {
      outOfRange = true;
      console.log(`     out-of-range: ${v}`);
      break;
    }
    seen.add(v);
  }
  !outOfRange ? pass("1000 trials, all values in [1,6]") : fail("out-of-range value");
  seen.size === 6
    ? pass("all 6 distinct values seen across 1000 trials")
    : fail(`only ${seen.size} distinct values seen: ${[...seen].sort().join(",")}`);
}

// ---------- setFlagRandom: degenerate min===max ----------
{
  const eff: Effect = { type: "setFlagRandom", key: "_roll", min: 7, max: 7 };
  const e = freshEngine();
  const next = applyEffect(e.state, eff, story);
  next.flags["_roll"] === 7
    ? pass("min===max writes the literal value")
    : fail(`expected 7, got ${next.flags["_roll"]}`);
}

// ---------- setFlagRandom: result is readable via compare in a subsequent if ----------
{
  // Roll, then branch: if roll < 5 → set a=true, else b=true.
  const effects: Effect[] = [
    { type: "setFlagRandom", key: "_roll", min: 0, max: 9 },
    {
      type: "if",
      if: {
        type: "compare",
        left: { kind: "flag", key: "_roll" },
        op: "<",
        right: { kind: "literal", value: 5 },
      },
      then: [{ type: "setFlag", key: "a", value: true }],
      else: [{ type: "setFlag", key: "b", value: true }],
    },
  ];
  let aHit = 0, bHit = 0;
  for (let i = 0; i < 200; i++) {
    const e = freshEngine();
    const r = resolveEffects(effects, e.state, story);
    if (r.state.flags.a === true) aHit++;
    if (r.state.flags.b === true) bHit++;
  }
  aHit > 0 && bHit > 0
    ? pass(`200 trials: both branches hit (a=${aHit}, b=${bHit})`)
    : fail(`branches not balanced: a=${aHit} b=${bHit}`);
}

// ---------- narrate: top-level cue capture ----------

console.log("\n=== narrate cue capture ===");
{
  const effects: Effect[] = [{ type: "narrate", text: "hello world" }];
  const e = freshEngine();
  const r = resolveEffects(effects, e.state, story);
  r.cues.length === 1 && r.cues[0] === "hello world"
    ? pass("top-level narrate appends to cues")
    : fail(`cues=${JSON.stringify(r.cues)}`);
  r.effects.length === 0 ? pass("narrate is dropped from flattened effects") : fail("narrate leaked into effects");
}

// ---------- narrate: cue surfaces only on chosen if-branch ----------
{
  const e = freshEngine();
  e.state = { ...e.state, flags: { ...e.state.flags, a: true } };
  const effects: Effect[] = [
    {
      type: "if",
      if: { type: "flag", key: "a", equals: true },
      then: [{ type: "narrate", text: "then-fired" }],
      else: [{ type: "narrate", text: "else-fired" }],
    },
  ];
  const r = resolveEffects(effects, e.state, story);
  r.cues.length === 1 && r.cues[0] === "then-fired"
    ? pass("if-true: only `then`'s narrate surfaces")
    : fail(`cues=${JSON.stringify(r.cues)}`);
}
{
  const e = freshEngine(); // a defaults to false
  const effects: Effect[] = [
    {
      type: "if",
      if: { type: "flag", key: "a", equals: true },
      then: [{ type: "narrate", text: "then-fired" }],
      else: [{ type: "narrate", text: "else-fired" }],
    },
  ];
  const r = resolveEffects(effects, e.state, story);
  r.cues.length === 1 && r.cues[0] === "else-fired"
    ? pass("if-false: only `else`'s narrate surfaces")
    : fail(`cues=${JSON.stringify(r.cues)}`);
}

// ---------- narrate: template substitution via {flag.X} ----------
{
  const e = freshEngine();
  e.state = { ...e.state, flags: { ...e.state.flags, score: 42 } };
  const effects: Effect[] = [
    { type: "narrate", text: "Score is {flag.score}" },
  ];
  const r = resolveEffects(effects, e.state, story);
  r.cues[0] === "Score is 42"
    ? pass("narrate template renders {flag.X}")
    : fail(`cue=${r.cues[0]}`);
}

// ---------- if/then/else: basic deterministic ----------

console.log("\n=== if/then/else basics ===");
{
  // if-true → only then runs
  const e = freshEngine();
  e.state = { ...e.state, flags: { ...e.state.flags, a: true } };
  const eff: Effect = {
    type: "if",
    if: { type: "flag", key: "a", equals: true },
    then: [{ type: "setFlag", key: "picked", value: "then" }],
    else: [{ type: "setFlag", key: "picked", value: "else" }],
  };
  const next = applyEffect(e.state, eff, story);
  next.flags.picked === "then"
    ? pass("if-true → then runs")
    : fail(`expected 'then', got ${next.flags.picked}`);
}
{
  // if-false → only else runs
  const e = freshEngine();
  const eff: Effect = {
    type: "if",
    if: { type: "flag", key: "a", equals: true },
    then: [{ type: "setFlag", key: "picked", value: "then" }],
    else: [{ type: "setFlag", key: "picked", value: "else" }],
  };
  const next = applyEffect(e.state, eff, story);
  next.flags.picked === "else"
    ? pass("if-false → else runs")
    : fail(`expected 'else', got ${next.flags.picked}`);
}
{
  // if-false with no else → no-op
  const e = freshEngine();
  const eff: Effect = {
    type: "if",
    if: { type: "flag", key: "a", equals: true },
    then: [{ type: "setFlag", key: "picked", value: "then" }],
  };
  const next = applyEffect(e.state, eff, story);
  next.flags.picked === ""
    ? pass("if-false, no else → no-op")
    : fail(`expected no mutation, got ${next.flags.picked}`);
}

// ---------- Full decomposition equivalence ----------
//
// The legacy `random` form:
//   { type: "random", branches: [
//     { weight: 30, narration: "miss",  effects: [{adjustFlag a, by:-3}] },
//     { weight: 70, narration: "hit",   effects: [{adjustFlag b, by:-7}] },
//   ]}
//
// decomposes to setFlagRandom + if/then/else + narrate. This test runs many
// trials and asserts both branches fire correctly, with the right cue and
// state mutation, and approximate weight distribution.

console.log("\n=== decomposition equivalence ===");
{
  // Initialize a/b to numeric 0 so adjustFlag works as expected.
  const decomposed: Effect[] = [
    { type: "setFlagRandom", key: "_combat-roll", min: 0, max: 99 },
    {
      type: "if",
      if: {
        type: "compare",
        left: { kind: "flag", key: "_combat-roll" },
        op: "<",
        right: { kind: "literal", value: 30 },
      },
      then: [
        { type: "narrate", text: "miss" },
        { type: "adjustFlag", key: "a", by: -3 },
      ],
      else: [
        { type: "narrate", text: "hit" },
        { type: "adjustFlag", key: "b", by: -7 },
      ],
    },
  ];

  let missCount = 0;
  let hitCount = 0;
  let cuesOk = 0;
  for (let i = 0; i < 500; i++) {
    const e = freshEngine();
    e.state = { ...e.state, flags: { ...e.state.flags, a: 0, b: 0 } };
    const r = resolveEffects(decomposed, e.state, story);
    const next = r.state;
    if (r.cues[0] === "miss") {
      missCount++;
      if (next.flags.a === -3 && next.flags.b === 0) cuesOk++;
    } else if (r.cues[0] === "hit") {
      hitCount++;
      if (next.flags.a === 0 && next.flags.b === -7) cuesOk++;
    }
  }
  missCount + hitCount === 500
    ? pass(`500 trials: every roll picked exactly one branch`)
    : fail(`miss=${missCount} hit=${hitCount} (sum != 500)`);
  cuesOk === 500
    ? pass("each chosen branch fired the right narrate AND state mutation")
    : fail(`cue/state mismatch in ${500 - cuesOk} trials`);
  // Approximate distribution check: 30/70 split, so miss ~ [120, 180] over 500.
  missCount >= 100 && missCount <= 200
    ? pass(`miss frequency ~30% (got ${missCount}/500)`)
    : fail(`miss frequency way off: ${missCount}/500 (expected ~150)`);
}

// ---------- Done ----------

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
