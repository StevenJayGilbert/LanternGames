// Smoke test the 9 wired puzzles. Each section seeds engine state directly
// to skip travel + setup, then exercises the puzzle's canonical action sequence
// and asserts the expected flag/state outcome.

import { Engine } from "../src/engine/engine";
import zork from "../src/stories/zork-1.json" with { type: "json" };
import type { Story } from "../src/story/schema";

const story = zork as unknown as Story;
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

function newEngine(): Engine {
  return new Engine(story);
}

// ----- Puzzle #2: Coffin at altar -----
console.log("\n=== #2 Coffin at altar ===");
{
  const e = newEngine();
  // Walk to south-temple WITHOUT coffin — flag should set
  e.state = { ...e.state, itemLocations: { ...e.state.itemLocations, player: "south-temple" } };
  e.execute({ type: "wait" }); // tick triggers
  e.state.flags["coffin-cure"] === true
    ? pass("coffin-cure flips true when at south-temple without coffin")
    : fail("coffin-cure false", JSON.stringify(e.state.flags["coffin-cure"]));

  // Now pick up coffin (simulate by adding to inventory)
  e.state = { ...e.state, itemLocations: { ...e.state.itemLocations, coffin: "player" } };
  e.execute({ type: "wait" });
  e.state.flags["coffin-cure"] === false
    ? pass("coffin-cure flips back false when carrying coffin")
    : fail("coffin-cure not cleared", JSON.stringify(e.state.flags["coffin-cure"]));
}

// ----- Puzzle #6: Echo room -----
console.log("\n=== #6 Echo → bar ===");
{
  const e = newEngine();
  // loud-room is dark — must have a lit light source for items to be perceivable
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "loud-room", lamp: "player" },
    itemStates: { ...e.state.itemStates, lamp: { ...(e.state.itemStates.lamp ?? {}), isLit: true } },
  };
  // Bar should be HIDDEN at start (visibleWhen: echo-spoken)
  const v0 = e.getView();
  const barVisible0 = v0.itemsHere.some((i) => i.id === "bar");
  !barVisible0 ? pass("bar hidden before echo") : fail("bar already visible");

  // Match the say-echo intent
  e.execute({ type: "recordIntent", signalId: "say-echo-in-loud-room" });
  e.state.flags["echo-spoken"] === true
    ? pass("echo-spoken flag set")
    : fail("echo-spoken not set");

  const v1 = e.getView();
  const barVisible1 = v1.itemsHere.some((i) => i.id === "bar");
  barVisible1 ? pass("bar now visible after echo") : fail("bar still hidden after echo");
}

// ----- Puzzle #3: Wave scepter at rainbow -----
console.log("\n=== #3 Wave scepter at rainbow ===");
{
  const e = newEngine();
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "end-of-rainbow", sceptre: "player" },
  };
  // Pot-of-gold hidden initially
  const v0 = e.getView();
  const pog0 = v0.itemsHere.some((i) => i.id === "pot-of-gold");
  !pog0 ? pass("pot-of-gold hidden before wave") : fail("pot-of-gold already visible");

  const r = e.execute({ type: "recordIntent", signalId: "wave-scepter-at-rainbow" });
  e.state.flags["rainbow-flag"] === true
    ? pass("rainbow-flag set")
    : fail("rainbow-flag not set");
  r.narrationCues.join(" ").includes("pot of gold")
    ? pass("wave from end-of-rainbow → cue describes the pot of gold at your feet")
    : fail("end-of-rainbow wave cue missing the pot", JSON.stringify(r.narrationCues));

  // on-rainbow exits should now be visible/passable
  const v1 = e.getView();
  const pog1 = v1.itemsHere.some((i) => i.id === "pot-of-gold");
  pog1 ? pass("pot-of-gold visible after wave") : fail("pot-of-gold still hidden");
  const upExit = v1.exits.find((x) => x.direction === "up");
  upExit && !upExit.blocked
    ? pass("end-of-rainbow.up unblocked")
    : fail("up still blocked", JSON.stringify(upExit));
}
{
  // Wave from the OTHER side (aragain-falls): the rainbow solidifies, but the
  // pot of gold is across the bridge — the cue must NOT place it "at your feet".
  const e = newEngine();
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "aragain-falls", sceptre: "player" },
  };
  const r = e.execute({ type: "recordIntent", signalId: "wave-scepter-at-rainbow" });
  e.state.flags["rainbow-flag"] === true
    ? pass("rainbow-flag set (wave from aragain-falls)")
    : fail("rainbow-flag not set from aragain-falls");
  !r.narrationCues.join(" ").includes("pot of gold")
    ? pass("wave from aragain-falls → cue does NOT place the pot of gold at your feet")
    : fail("aragain-falls wave cue wrongly mentions the pot", JSON.stringify(r.narrationCues));
  // The pot still materializes at end-of-rainbow (the far side).
  e.state = { ...e.state, itemLocations: { ...e.state.itemLocations, player: "end-of-rainbow" } };
  e.getView().itemsHere.some((i) => i.id === "pot-of-gold")
    ? pass("pot-of-gold visible at end-of-rainbow after the aragain-falls wave")
    : fail("pot-of-gold not visible at end-of-rainbow");
}

// ----- Puzzle #4: Endgame won-flag -----
console.log("\n=== #4 Endgame ===");
{
  const e = newEngine();
  // Force all 19 treasures into trophy-case
  const treasures = [
    "egg", "canary", "bag-of-coins", "painting", "chalice", "torch", "trident",
    "coffin", "sceptre", "jade", "scarab", "skull", "emerald", "bracelet", "trunk",
    "bar", "pot-of-gold", "diamond", "bauble",
  ];
  const newLocs = { ...e.state.itemLocations, player: "west-of-house" };
  for (const t of treasures) newLocs[t] = "trophy-case";
  e.state = { ...e.state, itemLocations: newLocs };
  e.execute({ type: "wait" });
  e.state.flags["won-flag"] === true
    ? pass("won-flag set when all treasures in case")
    : fail("won-flag not set", JSON.stringify(e.state.flags["won-flag"]));
  // Stone barrow exit should be unblocked
  const v = e.getView();
  const sw = v.exits.find((x) => x.direction === "southwest");
  sw && !sw.blocked
    ? pass("west-of-house.southwest → stone-barrow unblocked")
    : fail("sw still blocked", JSON.stringify(sw));
}

// ----- Puzzle #5: Mirror room rub -----
console.log("\n=== #5 Mirror room rub ===");
{
  const e = newEngine();
  e.state = { ...e.state, itemLocations: { ...e.state.itemLocations, player: "mirror-room-1" } };
  e.execute({ type: "recordIntent", signalId: "rub-mirror" });
  e.state.itemLocations.player === "mirror-room-2"
    ? pass("rub at mirror-room-1 teleports to mirror-room-2")
    : fail(`location is ${e.state.itemLocations.player}`);

  e.execute({ type: "recordIntent", signalId: "rub-mirror" });
  e.state.itemLocations.player === "mirror-room-1"
    ? pass("rub at mirror-room-2 teleports back to mirror-room-1")
    : fail(`location is ${e.state.itemLocations.player}`);
}

// ----- Puzzle #8: Bat carry -----
console.log("\n=== #8 Bat carry ===");
{
  const drops = ["mine-1","mine-2","mine-3","mine-4","ladder-top","ladder-bottom","squeeky-room","mine-entrance"];
  // Run 5 trials so we don't get unlucky on randomness
  let allCarried = true;
  let allInDropList = true;
  for (let trial = 0; trial < 5; trial++) {
    const e = newEngine();
    e.state = { ...e.state, itemLocations: { ...e.state.itemLocations, player: "bat-room" } };
    e.execute({ type: "wait" });
    if (e.state.itemLocations.player === "bat-room") {
      allCarried = false;
      break;
    }
    if (!drops.includes(e.state.itemLocations.player)) {
      allInDropList = false;
      console.log(`     unexpected drop: ${e.state.itemLocations.player}`);
    }
  }
  allCarried ? pass("bat carried player out of bat-room (5 trials)") : fail("bat did not carry");
  allInDropList ? pass("all drops in canonical drop list") : fail("drop outside canonical list");

  // With garlic in inventory, bat does NOT carry
  const e2 = newEngine();
  e2.state = { ...e2.state, itemLocations: { ...e2.state.itemLocations, player: "bat-room", garlic: "player" } };
  e2.execute({ type: "wait" });
  e2.state.itemLocations.player === "bat-room"
    ? pass("garlic in inventory blocks bat-carry")
    : fail(`bat carried player anyway to ${e2.state.itemLocations.player}`);
}

// ----- Puzzle #1: Bell + book + candles (canonical fail-and-recover path) -----
console.log("\n=== #1 Bell + book + candles ===");
{
  const e = newEngine();
  // Player at entrance-to-hades with bell + book + lit candles + matchbook.
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "entrance-to-hades", bell: "player",
      book: "player",
      candles: "player",
      match: "player", },
  };
  // Step 1: ring bell at hades. Bell drops + candles drop+extinguish.
  e.execute({ type: "recordIntent", signalId: "ring-bell" });
  e.state.itemStates["bell"]?.rangAtHades === true
    ? pass("bell.rangAtHades after ring-bell intent at hades")
    : fail("bell.rangAtHades not set", JSON.stringify(e.state.itemStates["bell"]));
  e.state.itemStates["candles"]?.isLit === false
    ? pass("candles extinguished by bell ring")
    : fail("candles still lit after bell ring", JSON.stringify(e.state.itemStates["candles"]));

  // Step 2: take candles back into inventory (engine moved them to entrance-to-hades).
  e.execute({ type: "take", itemId: "candles" });

  // Step 3: strike a match (consumes one of 5; sets isLit + 2-turn countdown).
  e.execute({ type: "recordIntent", signalId: "light", args: { itemId: "match" } });
  e.state.itemStates["match"]?.matchesRemaining === 4
    ? pass("match.matchesRemaining = 4 after strike")
    : fail("matches remaining wrong", JSON.stringify(e.state.itemStates["match"]));
  e.state.itemStates["match"]?.isLit === true
    ? pass("match.isLit = true after strike")
    : fail("match.isLit wrong", JSON.stringify(e.state.itemStates["match"]));

  // Step 4: light candles using the burning match.
  e.execute({ type: "recordIntent", signalId: "light", args: { itemId: "candles" } });
  e.state.itemStates["candles"]?.isLit === true
    ? pass("candles relit via light(candles) intent")
    : fail("candles not relit", JSON.stringify(e.state.itemStates["candles"]));
  e.state.itemStates["match"]?.isLit === false
    ? pass("match.isLit = false after lighting candles")
    : fail("match still burning after lighting candles", JSON.stringify(e.state.itemStates["match"]));

  // Step 5: read book at hades (capstone).
  e.execute({ type: "recordIntent", signalId: "read", args: { itemId: "book" } });
  e.state.flags["lld-flag"] === true
    ? pass("lld-flag set after capstone")
    : fail("lld-flag not set");

  // Verify entrance-to-hades exits unblocked
  const v = e.getView();
  const inExit = v.exits.find((x) => x.direction === "in");
  inExit && !inExit.blocked
    ? pass("entrance-to-hades.in → land-of-living-dead unblocked")
    : fail("in still blocked", JSON.stringify(inExit));
}

// ----- Puzzle #1b: Match burns out after 2 turns if unused -----
console.log("\n=== #1b Match burns out after 2 turns ===");
{
  const e = newEngine();
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "entrance-to-hades", match: "player" },
  };
  // Strike match: matchesRemaining: 4, isLit: true, countdown: 3.
  e.execute({ type: "recordIntent", signalId: "light", args: { itemId: "match" } });
  // Tick 1 (any wait action triggers afterAction tick).
  e.execute({ type: "wait" });
  e.state.itemStates["match"]?.isLit === true
    ? pass("match still burning after 1 wait tick")
    : fail("match extinguished too early", JSON.stringify(e.state.itemStates["match"]));
  // Tick 2: countdown hits 0; match-burns-out fires.
  e.execute({ type: "wait" });
  e.state.itemStates["match"]?.isLit === false
    ? pass("match extinguished after 2 wait ticks")
    : fail("match still burning after 2 ticks", JSON.stringify(e.state.itemStates["match"]));
}

// ----- Puzzle #1c: Out of matches -----
console.log("\n=== #1c Empty matchbook ===");
{
  const e = newEngine();
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, match: "player" },
    itemStates: { ...e.state.itemStates, match: { matchesRemaining: 0, isLit: false } },
  };
  const r = e.execute({ type: "recordIntent", signalId: "light", args: { itemId: "match" } });
  r.narrationCues.some((c) => c.includes("matchbook is empty"))
    ? pass("light(match) with 0 matches → 'matchbook is empty' cue")
    : fail("expected empty-matchbook cue", JSON.stringify(r.narrationCues));
}

// ----- Puzzle #1d: Wind gust blows out the candles in tiny-cave -----
console.log("\n=== #1d Candle wind gust (tiny-cave) ===");
// tiny-cave is a dark room, and the gust extinguishes the candles. Every setup
// below also carries a lit lamp (batteryTurns: 330 — ample for 30 turns) so the
// room stays lit no matter what the candles do: the grue/darkness path is fully
// decoupled, and these tests exercise only the wind-gust mechanic.
{
  // Positive: lit candles carried into tiny-cave → a ~50%-per-turn gust blows
  // them out. P(no gust in 30 turns) ≈ 9e-10.
  const e = newEngine();
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "tiny-cave", candles: "player", lamp: "player" },
    itemStates: {
      ...e.state.itemStates,
      candles: { isLit: true, burnTurnsRemaining: 230, weight: 5 },
      lamp: { isLit: true, batteryTurns: 330, weight: 15 },
    },
  };
  let blownOut = false;
  for (let i = 0; i < 30 && !blownOut; i++) {
    e.execute({ type: "wait" });
    if (e.state.itemStates["candles"]?.isLit === false) blownOut = true;
  }
  blownOut
    ? pass("gust blew out the carried candles within 30 turns in tiny-cave")
    : fail("candles never blown out in tiny-cave", JSON.stringify(e.state.itemStates["candles"]));
  (e.state.itemStates["candles"]?.burnTurnsRemaining ?? 0) > 0
    ? pass("burnTurnsRemaining still > 0 after the gust — candles remain relightable")
    : fail("gust consumed the wax", JSON.stringify(e.state.itemStates["candles"]));
}
{
  // Negative — wrong room: lit candles carried elsewhere are never gusted out.
  const e = newEngine();
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "south-temple", candles: "player", lamp: "player" },
    itemStates: {
      ...e.state.itemStates,
      candles: { isLit: true, burnTurnsRemaining: 230, weight: 5 },
      lamp: { isLit: true, batteryTurns: 330, weight: 15 },
    },
  };
  for (let i = 0; i < 30; i++) e.execute({ type: "wait" });
  e.state.itemStates["candles"]?.isLit === true
    ? pass("candles stay lit outside tiny-cave (no gust)")
    : fail("candles blown out in the wrong room", JSON.stringify(e.state.itemStates["candles"]));
}
{
  // Negative — not carried: lit candles on the ground in tiny-cave are not
  // gusted out (canonical: the gust requires IN? CANDLES WINNER).
  const e = newEngine();
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "tiny-cave", candles: "tiny-cave", lamp: "player" },
    itemStates: {
      ...e.state.itemStates,
      candles: { isLit: true, burnTurnsRemaining: 230, weight: 5 },
      lamp: { isLit: true, batteryTurns: 330, weight: 15 },
    },
  };
  for (let i = 0; i < 30; i++) e.execute({ type: "wait" });
  e.state.itemStates["candles"]?.isLit === true
    ? pass("candles on the ground in tiny-cave stay lit (gust needs them carried)")
    : fail("ground candles blown out", JSON.stringify(e.state.itemStates["candles"]));
}

// ----- Puzzle #1e: Lighting the candles requires a burning match -----
console.log("\n=== #1e Candle lighting needs a match ===");
// The `light` tool gates on itemAccessible (carried OR on the ground); the candle
// validation triggers must match that scope, or candles on the ground get lit with
// no match. Every setup carries a lit lamp so room darkness is irrelevant here.
{
  // Candles on the ground, no burning match → light candles → they stay dark.
  const e = newEngine();
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "round-room", candles: "round-room", match: "player", lamp: "player" },
    itemStates: {
      ...e.state.itemStates,
      candles: { isLit: false, burnTurnsRemaining: 230, weight: 5 },
      match: { matchesRemaining: 5, isLit: false, weight: 1 },
      lamp: { isLit: true, batteryTurns: 330, weight: 15 },
    },
  };
  const r = e.execute({ type: "recordIntent", signalId: "light", args: { itemId: "candles" } });
  e.state.itemStates["candles"]?.isLit === false
    ? pass("light ground candles with no burning match → candles stay dark")
    : fail("ground candles lit without a match", JSON.stringify(e.state.itemStates["candles"]));
  r.narrationCues.some((c) => c.includes("nothing burning"))
    ? pass("no-match light → 'nothing burning to light them with' cue")
    : fail("expected no-match cue", JSON.stringify(r.narrationCues));
}
{
  // Candles on the ground, burning match in hand → light candles → lit, match consumed.
  const e = newEngine();
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "round-room", candles: "round-room", match: "player", lamp: "player" },
    itemStates: {
      ...e.state.itemStates,
      candles: { isLit: false, burnTurnsRemaining: 230, weight: 5 },
      match: { matchesRemaining: 5, isLit: true, weight: 1 },
      lamp: { isLit: true, batteryTurns: 330, weight: 15 },
    },
  };
  e.execute({ type: "recordIntent", signalId: "light", args: { itemId: "candles" } });
  e.state.itemStates["candles"]?.isLit === true
    ? pass("light ground candles WITH a burning match → candles lit")
    : fail("ground candles not lit despite burning match", JSON.stringify(e.state.itemStates["candles"]));
  e.state.itemStates["match"]?.isLit === false
    ? pass("burning match consumed lighting ground candles")
    : fail("match not consumed", JSON.stringify(e.state.itemStates["match"]));
}
{
  // At entrance-to-hades (bell rung), candles on the ground: a no-match attempt must
  // NOT consume the once-only cower narration; the real match-backed lighting fires it.
  const e = newEngine();
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "entrance-to-hades", candles: "entrance-to-hades", match: "player", lamp: "player" },
    itemStates: {
      ...e.state.itemStates,
      candles: { isLit: false, burnTurnsRemaining: 230, weight: 5 },
      match: { matchesRemaining: 5, isLit: false, weight: 1 },
      bell: { rangAtHades: true, weight: 10 },
      lamp: { isLit: true, batteryTurns: 330, weight: 15 },
    },
  };
  const r1 = e.execute({ type: "recordIntent", signalId: "light", args: { itemId: "candles" } });
  !r1.triggersFired.includes("candles-relit-at-hades-cower")
    ? pass("no-match light at hades does NOT consume the once-only cower narration")
    : fail("cower narration wasted on a failed no-match attempt");
  e.state = { ...e.state, itemStates: { ...e.state.itemStates, match: { ...e.state.itemStates["match"], isLit: true } } };
  const r2 = e.execute({ type: "recordIntent", signalId: "light", args: { itemId: "candles" } });
  e.state.itemStates["candles"]?.isLit === true
    ? pass("match-backed light at hades → candles lit")
    : fail("candles not lit with match at hades", JSON.stringify(e.state.itemStates["candles"]));
  r2.triggersFired.includes("candles-relit-at-hades-cower")
    ? pass("cower narration fires on the real match-backed lighting")
    : fail("cower did not fire on the real lighting", JSON.stringify(r2.triggersFired));
}

// ----- Puzzle #1f: Burn-out narration is co-location-gated -----
console.log("\n=== #1f Light-source burn-out narration is co-location-gated ===");
// A burning candle/lamp runs out wherever it sits, but the "it went out" message
// must only reach the player when they can perceive the item. Each setup puts the
// light source at fuel 0 + isLit:true; one `wait` fires the burn-out trigger.
{
  // Candles burn out in the player's own room → cue shown.
  const e = newEngine();
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "round-room", candles: "round-room" },
    itemStates: { ...e.state.itemStates, candles: { isLit: true, burnTurnsRemaining: 0, weight: 5 } },
  };
  const r = e.execute({ type: "wait" });
  e.state.itemStates["candles"]?.isLit === false
    ? pass("candles burn out (isLit→false) when out of fuel")
    : fail("candles did not burn out", JSON.stringify(e.state.itemStates["candles"]));
  r.narrationCues.some((c) => c.includes("burned down"))
    ? pass("candles burn out in the player's room → 'burned down' cue shown")
    : fail("expected burned-down cue when co-located", JSON.stringify(r.narrationCues));
}
{
  // Candles burn out while carried → cue shown.
  const e = newEngine();
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "round-room", candles: "player" },
    itemStates: { ...e.state.itemStates, candles: { isLit: true, burnTurnsRemaining: 0, weight: 5 } },
  };
  const r = e.execute({ type: "wait" });
  r.narrationCues.some((c) => c.includes("burned down"))
    ? pass("candles burn out while carried → 'burned down' cue shown")
    : fail("expected burned-down cue when carried", JSON.stringify(r.narrationCues));
}
{
  // Candles burn out in a DIFFERENT room → trigger still fires, but no cue leaks.
  const e = newEngine();
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "round-room", candles: "south-temple" },
    itemStates: { ...e.state.itemStates, candles: { isLit: true, burnTurnsRemaining: 0, weight: 5 } },
  };
  const r = e.execute({ type: "wait" });
  e.state.itemStates["candles"]?.isLit === false
    ? pass("candles in another room still burn out (isLit→false)")
    : fail("candles did not burn out off-screen", JSON.stringify(e.state.itemStates["candles"]));
  !r.narrationCues.some((c) => c.includes("burned down"))
    ? pass("candles burn out in another room → NO 'burned down' cue leaks to the player")
    : fail("cross-room burn-out cue leaked", JSON.stringify(r.narrationCues));
}
{
  // Lamp runs out in a DIFFERENT room → trigger fires, no cue leaks (sibling fix).
  const e = newEngine();
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "round-room", lamp: "south-temple" },
    itemStates: { ...e.state.itemStates, lamp: { isLit: true, batteryTurns: 0, weight: 15 } },
  };
  const r = e.execute({ type: "wait" });
  e.state.itemStates["lamp"]?.isLit === false
    ? pass("lamp in another room still runs out (isLit→false)")
    : fail("lamp did not run out off-screen", JSON.stringify(e.state.itemStates["lamp"]));
  !r.narrationCues.some((c) => c.includes("lamp dims"))
    ? pass("lamp runs out in another room → NO 'lamp dims' cue leaks to the player")
    : fail("cross-room lamp cue leaked", JSON.stringify(r.narrationCues));
}

// ----- launch-boat refuses when the player isn't aboard -----
console.log("\n=== launch-boat refuses when not aboard ===");
{
  // Player on the beach beside the inflated boat but NOT aboard → launch refused,
  // boat stays put (no silent no-op for the LLM to hallucinate over).
  const e = newEngine();
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "sandy-beach", "inflatable-boat": "sandy-beach" },
    itemStates: { ...e.state.itemStates, "inflatable-boat": { inflation: "inflated", weight: 20 } },
  };
  const r = e.execute({ type: "recordIntent", signalId: "launch-boat" });
  e.state.itemLocations["inflatable-boat"] === "sandy-beach"
    ? pass("launch-boat while not aboard → boat stays on the beach")
    : fail("boat moved despite player not aboard", `boat at ${e.state.itemLocations["inflatable-boat"]}`);
  r.triggersFired.includes("launch-boat-rejects")
    ? pass("launch-boat-rejects fired → refusal cue instead of a silent no-op")
    : fail("launch-boat-rejects did not fire", JSON.stringify(r.triggersFired));
}
{
  // Player aboard the inflated boat at sandy-beach → real launch still works,
  // and the catchall stays out of the way.
  const e = newEngine();
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "sandy-beach", "inflatable-boat": "sandy-beach" },
    itemStates: { ...e.state.itemStates, "inflatable-boat": { inflation: "inflated", weight: 20 } },
  };
  e.execute({ type: "board", itemId: "inflatable-boat" });
  const r = e.execute({ type: "recordIntent", signalId: "launch-boat" });
  e.state.itemLocations["inflatable-boat"] !== "sandy-beach"
    ? pass("launch-boat while aboard → boat launches off the beach")
    : fail("boat did not launch despite player aboard", `boat at ${e.state.itemLocations["inflatable-boat"]}`);
  !r.triggersFired.includes("launch-boat-rejects")
    ? pass("launch-boat-rejects did NOT fire on a valid launch")
    : fail("catchall fired on a real launch", JSON.stringify(r.triggersFired));
}

// ----- customTool no-op catchalls -----
console.log("\n=== customTool no-op catchalls ===");
// Each of these customTools, invoked in a context where no per-context trigger
// consumes the intent, must hit its `-rejects` catchall — a refusal cue, not a
// silent no-op the narrating LLM would hallucinate over.
for (const tool of [
  "move-the-rug", "cyclops-magic-word", "say-granite-word", "pray-at-altar",
  "free-stuck-weapon", "say-echo-in-loud-room", "wave-scepter-at-rainbow", "wind-canary",
  "brush-teeth-with-putty", "leap-down", "attack-self", "swim-river", "rub-mirror",
  "repair-boat-with-putty",
]) {
  const e = newEngine();
  e.state = { ...e.state, itemLocations: { ...e.state.itemLocations, player: "west-of-house" } };
  const r = e.execute({ type: "recordIntent", signalId: tool });
  r.triggersFired.includes(`${tool}-rejects`) && r.narrationCues.length > 0
    ? pass(`${tool} out of context → ${tool}-rejects fires with a refusal cue`)
    : fail(`${tool}-rejects missing`, `fired=${JSON.stringify(r.triggersFired)} cues=${JSON.stringify(r.narrationCues)}`);
}
{
  // light-rejects: light the torch — it has no per-item light trigger (it is the
  // eternal flame), so the handler succeeds silently and the catchall must catch it.
  const e = newEngine();
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "west-of-house", torch: "player" },
  };
  const r = e.execute({ type: "recordIntent", signalId: "light", args: { itemId: "torch" } });
  r.triggersFired.includes("light-rejects") && r.narrationCues.length > 0
    ? pass("light torch (no per-item trigger) → light-rejects fires with a refusal cue")
    : fail("light-rejects missing", `fired=${JSON.stringify(r.triggersFired)} cues=${JSON.stringify(r.narrationCues)}`);
}

// ----- customTool catchalls: the OTHER branch (reason-specific refusal) -----
console.log("\n=== customTool catchall second branch ===");
{
  // move-the-rug in living-room after the rug is already moved.
  const e = newEngine();
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "living-room" },
    firedTriggers: [...e.state.firedTriggers, "rug-moved"],
  };
  const r = e.execute({ type: "recordIntent", signalId: "move-the-rug" });
  const cue = r.narrationCues.join(" ");
  r.triggersFired.includes("move-the-rug-rejects") && cue.includes("heap")
    ? pass("move-the-rug in living-room (rug already moved) → 'already...heap' branch")
    : fail("move-the-rug second branch wrong", `cues=${JSON.stringify(r.narrationCues)}`);
}
{
  // cyclops-magic-word at cyclops-room after the cyclops has fled.
  const e = newEngine();
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "cyclops-room" },
    flags: { ...e.state.flags, "cyclops-flag": true },
  };
  const r = e.execute({ type: "recordIntent", signalId: "cyclops-magic-word" });
  const cue = r.narrationCues.join(" ");
  r.triggersFired.includes("cyclops-magic-word-rejects") && cue.includes("long gone")
    ? pass("cyclops-magic-word at cyclops-room (already fled) → 'long gone' branch")
    : fail("cyclops second branch wrong", `cues=${JSON.stringify(r.narrationCues)}`);
}
{
  // say-echo-in-loud-room at loud-room after the echo has already been spoken.
  const e = newEngine();
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "loud-room" },
    flags: { ...e.state.flags, "echo-spoken": true },
  };
  const r = e.execute({ type: "recordIntent", signalId: "say-echo-in-loud-room" });
  const cue = r.narrationCues.join(" ");
  r.triggersFired.includes("say-echo-in-loud-room-rejects") && cue.includes("quiet room")
    ? pass("say-echo at loud-room (already solved) → 'quiet room' branch")
    : fail("say-echo second branch wrong", `cues=${JSON.stringify(r.narrationCues)}`);
}
{
  // wave-scepter-at-rainbow holding the sceptre but in the wrong place.
  const e = newEngine();
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "west-of-house", sceptre: "player" },
  };
  const r = e.execute({ type: "recordIntent", signalId: "wave-scepter-at-rainbow" });
  const cue = r.narrationCues.join(" ");
  r.triggersFired.includes("wave-scepter-at-rainbow-rejects") && cue.includes("answers the gesture")
    ? pass("wave-scepter holding sceptre, wrong place → 'nothing answers' branch (not 'no sceptre')")
    : fail("wave-scepter second branch wrong", `cues=${JSON.stringify(r.narrationCues)}`);
}
{
  // repair-boat-with-putty holding the putty but with no punctured boat.
  const e = newEngine();
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "west-of-house", putty: "player" },
  };
  const r = e.execute({ type: "recordIntent", signalId: "repair-boat-with-putty" });
  const cue = r.narrationCues.join(" ");
  r.triggersFired.includes("repair-boat-with-putty-rejects") && cue.includes("torn")
    ? pass("repair-boat holding putty, nothing punctured → 'nothing torn' branch (not 'no putty')")
    : fail("repair-boat second branch wrong", `cues=${JSON.stringify(r.narrationCues)}`);
}

// ----- Boat: examine reflects inflation; container.contents lists what's inside -----
console.log("\n=== boat examine variant + container.contents ===");
{
  const e = newEngine();
  e.state = {
    ...e.state,
    itemLocations: {
      ...e.state.itemLocations,
      player: "sandy-beach", "inflatable-boat": "sandy-beach", sceptre: "inflatable-boat",
    },
    itemStates: { ...e.state.itemStates, "inflatable-boat": { inflation: "inflated", weight: 20 } },
  };
  e.execute({ type: "examine", itemId: "inflatable-boat" });
  const boat = e.getView().itemsHere.find((i) => i.id === "inflatable-boat");
  boat?.description && !boat.description.includes("folded pile of plastic") &&
    boat.description.toLowerCase().includes("air")
    ? pass("examine inflated boat → description reflects the inflated state, not 'folded plastic'")
    : fail("boat examine description not inflation-aware", boat?.description ?? "(none)");
  boat?.container?.contents?.some((c) => c.id === "sceptre")
    ? pass("inflated boat view → container.contents lists the sceptre inside")
    : fail("boat container.contents missing the sceptre", JSON.stringify(boat?.container?.contents));
}

// ----- Endgame map: hidden in the trophy case until the endgame unlocks -----
console.log("\n=== endgame map hidden until won-flag ===");
{
  const e = newEngine();
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "living-room" },
    itemStates: { ...e.state.itemStates, "trophy-case": { isOpen: true } },
  };
  // Before the endgame — won-flag unset → the ancient map is hidden in the case.
  !e.getView().itemsHere.some((i) => i.id === "map")
    ? pass("ancient map hidden before the endgame (won-flag unset)")
    : fail("map visible in the trophy case too early");
  // Endgame unlocked (all treasures cased → unlock-endgame sets won-flag).
  e.state = { ...e.state, flags: { ...e.state.flags, "won-flag": true } };
  e.getView().itemsHere.some((i) => i.id === "map")
    ? pass("ancient map appears in the trophy case once won-flag is set")
    : fail("map still hidden after won-flag set");
}

// ----- Puzzle #7: Coal → diamond -----
console.log("\n=== #7 Coal → diamond ===");
{
  const e = newEngine();
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "machine-room", screwdriver: "player",
      coal: "machine", },
    itemStates: {
      ...e.state.itemStates,
      machine: { ...(e.state.itemStates.machine ?? {}), isOpen: false },
    },
  };
  e.execute({ type: "recordIntent", signalId: "turn", args: { itemId: "machine-switch", withItemId: "screwdriver" } });
  e.state.itemLocations.diamond === "machine-room"
    ? pass("diamond moved to machine-room")
    : fail(`diamond at ${e.state.itemLocations.diamond}`);
  e.state.itemLocations.coal === "nowhere"
    ? pass("coal consumed (moved to nowhere)")
    : fail(`coal at ${e.state.itemLocations.coal}`);
  e.state.itemStates.machine?.isOpen === true
    ? pass("machine lid is open after success (matches 'the lid pops open' narration)")
    : fail(`machine.isOpen = ${e.state.itemStates.machine?.isOpen}`);
}

// ----- Puzzle #7b: Bare-hand push-machine-switch must NOT fire the puzzle -----
console.log("\n=== #7b Machine switch refuses bare-hand ===");
{
  const e = newEngine();
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "machine-room", screwdriver: "player",
      coal: "machine", },
    itemStates: {
      ...e.state.itemStates,
      machine: { ...(e.state.itemStates.machine ?? {}), isOpen: false },
    },
  };
  const r = e.execute({ type: "recordIntent", signalId: "push", args: { itemId: "machine-switch" } });
  e.state.itemLocations.coal === "machine"
    ? pass("coal still in machine (puzzle did not fire)")
    : fail(`coal at ${e.state.itemLocations.coal}`);
  e.state.itemLocations.diamond === "nowhere"
    ? pass("diamond still at nowhere")
    : fail(`diamond at ${e.state.itemLocations.diamond}`);
  r.narrationCues.some((c) => c.includes("too small"))
    ? pass("push-machine-switch → 'switch is too small' refusal cue")
    : fail("expected too-small refusal cue", JSON.stringify(r.narrationCues));
}

// ----- Puzzle #7c: Wrong-tool turn-machine-switch (e.g. withItemId='wrench') still refused -----
console.log("\n=== #7c Machine switch refuses wrong tool ===");
{
  const e = newEngine();
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "machine-room", screwdriver: "player",
      coal: "machine", wrench: "player", },
    itemStates: {
      ...e.state.itemStates,
      machine: { ...(e.state.itemStates.machine ?? {}), isOpen: false },
    },
  };
  const r = e.execute({ type: "recordIntent", signalId: "turn", args: { itemId: "machine-switch", withItemId: "wrench" } });
  e.state.itemLocations.coal === "machine"
    ? pass("coal still in machine (wrong-tool path did not fire puzzle)")
    : fail(`coal at ${e.state.itemLocations.coal}`);
  r.narrationCues.some((c) => c.includes("doesn't budge"))
    ? pass("wrong-tool turn-machine-switch → 'switch doesn't budge' refusal cue")
    : fail("expected switch-doesn't-budge refusal cue", JSON.stringify(r.narrationCues));
}

// ----- Puzzle #7d: Lid-open turn-machine-switch produces dedicated failure -----
console.log("\n=== #7d Machine refuses with lid open ===");
{
  const e = newEngine();
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "machine-room", screwdriver: "player",
      coal: "machine", },
    itemStates: {
      ...e.state.itemStates,
      machine: { ...(e.state.itemStates.machine ?? {}), isOpen: true },
    },
  };
  const r = e.execute({ type: "recordIntent", signalId: "turn", args: { itemId: "machine-switch", withItemId: "screwdriver" } });
  e.state.itemLocations.coal === "machine"
    ? pass("coal still in machine (lid-open did not consume)")
    : fail(`coal at ${e.state.itemLocations.coal}`);
  e.state.itemLocations.diamond === "nowhere"
    ? pass("diamond still at nowhere (no diamond spawn)")
    : fail(`diamond at ${e.state.itemLocations.diamond}`);
  r.narrationCues.some((c) => c.includes("dissipates") || c.includes("chamber"))
    ? pass("lid-open turn → dedicated escape-of-smoke refusal cue")
    : fail("expected lid-open refusal cue", JSON.stringify(r.narrationCues));
}

// ----- Puzzle #9: Dam control panel -----
console.log("\n=== #9 Dam control panel ===");
{
  const e = newEngine();
  // Step 1: yellow button at maintenance-room
  e.state = { ...e.state, itemLocations: { ...e.state.itemLocations, player: "maintenance-room", wrench: "player" } };
  e.execute({ type: "recordIntent", signalId: "push", args: { itemId: "yellow-button" } });
  e.state.flags["gate-flag"] === true
    ? pass("gate-flag set by yellow button")
    : fail("gate-flag not set");

  // Step 2: walk to dam-room, turn bolt
  e.state = { ...e.state, itemLocations: { ...e.state.itemLocations, player: "dam-room" } };
  e.execute({ type: "recordIntent", signalId: "turn", args: { itemId: "bolt", withItemId: "wrench" } });
  e.state.flags["gates-open"] === true
    ? pass("gates-open set by bolt turn")
    : fail("gates-open not set");
  // Note: countdown is 7 (not 8) immediately after the bolt-turn because the
  // low-tide-tick afterAction trigger fires in the same turn — Phase 1 sets
  // countdown=8 via bolt-opens-gates, then Phase 2 ticks it down to 7.
  e.state.flags["low-tide-countdown"] === 7
    ? pass("low-tide-countdown ticked to 7 after bolt-turn (initial 8 - 1 same-turn tick)")
    : fail(`countdown=${e.state.flags["low-tide-countdown"]}`);

  // Step 3: tick 8 turns
  for (let i = 0; i < 9; i++) e.execute({ type: "wait" });
  e.state.flags["low-tide"] === true
    ? pass("low-tide flag set after 8 ticks")
    : fail(`low-tide=${e.state.flags["low-tide"]} countdown=${e.state.flags["low-tide-countdown"]}`);

  // Now reservoir.south.north should be unblocked
  e.state = { ...e.state, itemLocations: { ...e.state.itemLocations, player: "reservoir-south" } };
  const v = e.getView();
  const n = v.exits.find((x) => x.direction === "north");
  n && !n.blocked
    ? pass("reservoir-south.north unblocked at low-tide")
    : fail("north still blocked", JSON.stringify(n));
}

// ----- Puzzle #9b: Bare-hand dam bolt must NOT toggle gates -----
console.log("\n=== #9b Dam bolt refuses bare-hand ===");
{
  const e = newEngine();
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "dam-room", wrench: "player" },
    flags: { ...e.state.flags, "gate-flag": true, "gates-open": false },
  };
  const r = e.execute({ type: "recordIntent", signalId: "turn", args: { itemId: "bolt" } });
  e.state.flags["gates-open"] !== true
    ? pass("gates-open still false (bare-hand did not fire bolt)")
    : fail("gates-open flipped on bare-hand");
  r.narrationCues.some((c) => c.includes("bare hands") || c.includes("budge"))
    ? pass("turn-dam-bolt-by-hand → 'bolt won't budge' refusal cue")
    : fail("expected bare-hand refusal cue", JSON.stringify(r.narrationCues));
}

// ----- Puzzle #9c: Plug-leak by hand must NOT seal the leak -----
console.log("\n=== #9c Leak refuses bare-hand plug ===");
{
  const e = newEngine();
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "maintenance-room" },
    flags: { ...e.state.flags, "leak-active": true, "leak-flood-counter": 5 },
  };
  const r = e.execute({ type: "recordIntent", signalId: "plug", args: { itemId: "leak" } });
  e.state.flags["leak-active"] === true
    ? pass("leak still active (bare-hand did not seal it)")
    : fail("leak-active flipped on bare-hand");
  r.narrationCues.some((c) => c.includes("Water sprays") || c.includes("fingers"))
    ? pass("plug-leak-by-hand → bare-hand refusal cue")
    : fail("expected bare-hand leak refusal cue", JSON.stringify(r.narrationCues));
}

// ----- Puzzle #11b: Inflate-boat by mouth must NOT inflate the boat -----
console.log("\n=== #11b Boat refuses bare-mouth inflation ===");
{
  const e = newEngine();
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "dam-base", "inflatable-boat": "player" },
    itemStates: {
      ...e.state.itemStates,
      "inflatable-boat": { ...(e.state.itemStates["inflatable-boat"] ?? {}), inflation: "deflated" },
    },
  };
  const r = e.execute({ type: "recordIntent", signalId: "inflate", args: { itemId: "inflatable-boat" } });
  e.state.itemStates["inflatable-boat"]?.inflation === "deflated"
    ? pass("boat still deflated (bare-mouth did not inflate it)")
    : fail(`boat state = ${e.state.itemStates["inflatable-boat"]?.inflation}`);
  r.narrationCues.some((c) => c.includes("blow") || c.includes("doesn't budge"))
    ? pass("inflate-boat-by-mouth → bare-mouth refusal cue")
    : fail("expected bare-mouth refusal cue", JSON.stringify(r.narrationCues));
}

// ----- Puzzle #10 (bonus): Empty-handed coal mine -----
console.log("\n=== #10 Empty-handed (timber-room squeeze) ===");
{
  const e = newEngine();
  // Player starts with empty inventory; empty-handed should be true at boot
  e.state.flags["empty-handed"] === true
    ? pass("empty-handed = true at start (player has nothing)")
    : fail(`empty-handed = ${e.state.flags["empty-handed"]} at start`);

  // Pick up an item — flag should flip to false
  e.state = { ...e.state, itemLocations: { ...e.state.itemLocations, lamp: "player" } };
  e.execute({ type: "wait" });
  e.state.flags["empty-handed"] === false
    ? pass("empty-handed flips false when player carries lamp")
    : fail(`empty-handed = ${e.state.flags["empty-handed"]} after pickup`);

  // Drop the item LIT at timber-room — flag flips back true; lit lamp on
  // floor keeps the dark room visible so the exit appears in the view.
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "timber-room", lamp: "timber-room" },
    itemStates: { ...e.state.itemStates, lamp: { ...(e.state.itemStates.lamp ?? {}), isLit: true } },
  };
  e.execute({ type: "wait" });
  e.state.flags["empty-handed"] === true
    ? pass("empty-handed flips back true when player drops everything")
    : fail(`empty-handed = ${e.state.flags["empty-handed"]} after drop`);

  // Verify the gated exit is now passable
  const v = e.getView();
  const w = v.exits.find((x) => x.direction === "west");
  w && !w.blocked
    ? pass("timber-room.west → lower-shaft unblocked when empty-handed")
    : fail("west still blocked or hidden", JSON.stringify(w));
}

// ----- Puzzle #11: Boat / river travel (vehicle primitive) -----
console.log("\n=== #11 Boat / river travel ===");
{
  // Inflate path: pump + boat in inventory + at dam-base + deflated
  const e = newEngine();
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "dam-base", pump: "player" },
  };
  // Confirm boat starts deflated and not boardable
  const r0 = e.execute({ type: "board", itemId: "inflatable-boat" });
  !r0.ok && (r0.event as { reason?: string }).reason === "vehicle-blocked"
    ? pass("can't board deflated boat (vehicle-blocked)")
    : fail(`expected vehicle-blocked, got ${JSON.stringify(r0.event)}`);

  // Match inflate intent → trigger fires → boat is inflated
  e.execute({ type: "recordIntent", signalId: "inflate", args: { itemId: "inflatable-boat", withItemId: "pump" } });
  e.state.itemStates["inflatable-boat"]?.inflation === "inflated"
    ? pass("inflate intent → boat state is inflated")
    : fail(`inflation = ${e.state.itemStates["inflatable-boat"]?.inflation}`);

  // Try to board with sword in inventory → puncture trigger fires
  const e2 = newEngine();
  e2.state = {
    ...e2.state,
    itemLocations: { ...e2.state.itemLocations, player: "dam-base", pump: "player", sword: "player" },
  };
  e2.execute({ type: "recordIntent", signalId: "inflate", args: { itemId: "inflatable-boat", withItemId: "pump" } });
  // Now board — engine boards (no weapon check at engine level), but the
  // puncture trigger fires immediately (priority 100) on inVehicle+weapon.
  e2.execute({ type: "board", itemId: "inflatable-boat" });
  // Player should be ejected to dam-base (parent is the room, not the boat).
  e2.state.itemStates["inflatable-boat"]?.inflation === "punctured" &&
    e2.state.itemLocations.player === "dam-base"
    ? pass("board with sword → puncture trigger ejects player + sets boat punctured")
    : fail(
        `inflation=${e2.state.itemStates["inflatable-boat"]?.inflation} player=${e2.state.itemLocations.player}`,
      );

  // Repair with putty → boat back to deflated
  const e3 = newEngine();
  e3.state = {
    ...e3.state,
    itemLocations: { ...e3.state.itemLocations, player: "dam-base", putty: "player" },
    itemStates: {
      ...e3.state.itemStates,
      "inflatable-boat": {
        ...(e3.state.itemStates["inflatable-boat"] ?? {}),
        inflation: "punctured",
      },
    },
  };
  e3.execute({ type: "recordIntent", signalId: "repair-boat-with-putty" });
  e3.state.itemStates["inflatable-boat"]?.inflation === "deflated" &&
    e3.state.itemLocations.putty === "nowhere"
    ? pass("repair with putty → boat deflated, putty consumed")
    : fail(
        `inflation=${e3.state.itemStates["inflatable-boat"]?.inflation} putty=${e3.state.itemLocations.putty}`,
      );

  // Clean launch: no weapons, inflated, board → in vehicle, then ride downstream
  const e4 = newEngine();
  e4.state = {
    ...e4.state,
    itemLocations: { ...e4.state.itemLocations, player: "dam-base", pump: "player" },
  };
  e4.execute({ type: "recordIntent", signalId: "inflate", args: { itemId: "inflatable-boat", withItemId: "pump" } });
  e4.execute({ type: "board", itemId: "inflatable-boat" });
  e4.state.itemLocations.player === "inflatable-boat"
    ? pass("clean board → player parent is the vehicle")
    : fail(`player=${e4.state.itemLocations.player}`);

  // go(down) from dam-base → river-1? Actually dam-base has no down exit.
  // Player INSIDE the boat at river-1 (player.location === boat id; boat at river-1).
  e4.state = {
    ...e4.state,
    itemLocations: {
      ...e4.state.itemLocations,
      player: "inflatable-boat",
      "inflatable-boat": "river-1",
    },
  };

  // Tick 1 — counter increments to 1, no advance
  e4.execute({ type: "wait" });
  e4.state.flags["river-tick-counter"] === 1 &&
    e4.state.itemLocations["inflatable-boat"] === "river-1"
    ? pass("river-1 turn 1: counter=1, still at river-1")
    : fail(
        `counter=${e4.state.flags["river-tick-counter"]} boat=${e4.state.itemLocations["inflatable-boat"]}`,
      );

  // Tick 2 — counter hits 2, advance fires, BOAT moves to river-2 (player rides
  // along via parentage). Counter resets to 0.
  e4.execute({ type: "wait" });
  e4.state.itemLocations["inflatable-boat"] === "river-2" &&
    e4.state.itemLocations.player === "inflatable-boat" &&
    e4.state.flags["river-tick-counter"] === 0
    ? pass("river-1 turn 2: advance to river-2 (boat follows, counter resets, no cascade)")
    : fail(
        `boat=${e4.state.itemLocations["inflatable-boat"]} player=${e4.state.itemLocations.player} counter=${e4.state.flags["river-tick-counter"]}`,
      );

  // Land at river-3 via go(west) → boat travels to white-cliffs-north.
  // Player is INSIDE the boat: itemLocations[player] === boat id.
  const e5 = newEngine();
  e5.state = {
    ...e5.state,
    itemLocations: {
      ...e5.state.itemLocations,
      player: "inflatable-boat",
      "inflatable-boat": "river-3",
    },
    itemStates: {
      ...e5.state.itemStates,
      "inflatable-boat": { ...(e5.state.itemStates["inflatable-boat"] ?? {}), inflation: "inflated" },
    },
  };
  e5.execute({ type: "go", direction: "west" });
  // Player still in boat, boat now at white-cliffs-north.
  e5.state.itemLocations.player === "inflatable-boat" &&
    e5.state.itemLocations["inflatable-boat"] === "white-cliffs-north"
    ? pass("go(west) at river-3 lands player + boat at white-cliffs-north")
    : fail(
        `player=${e5.state.itemLocations.player} boat=${e5.state.itemLocations["inflatable-boat"]}`,
      );

  // Disembark at landing → player parent is the room (not the boat anymore)
  e5.execute({ type: "disembark" });
  e5.state.itemLocations.player === "white-cliffs-north"
    ? pass("disembark at landing → player on foot at white-cliffs-north")
    : fail(`player=${e5.state.itemLocations.player}`);

  // Waterfall death: at river-5, in-boat, after 2 ticks → endGame
  const e6 = newEngine();
  e6.state = {
    ...e6.state,
    itemLocations: {
      ...e6.state.itemLocations,
      player: "inflatable-boat",
      "inflatable-boat": "river-5",
    },
    itemStates: {
      ...e6.state.itemStates,
      "inflatable-boat": { ...(e6.state.itemStates["inflatable-boat"] ?? {}), inflation: "inflated" },
    },
  };
  e6.execute({ type: "wait" }); // tick 1
  e6.execute({ type: "wait" }); // tick 2 → death
  // First death is soft (canonical 3-life flow): respawn at forest-1, deaths counter +1.
  e6.state.flags.deaths === 1 &&
    e6.state.itemLocations.player === "forest-1" &&
    e6.state.finished === undefined
    ? pass("river-5 + 2 turns → soft-death (deaths=1, respawn at forest-1)")
    : fail(`deaths=${e6.state.flags.deaths} player=${e6.state.itemLocations.player} finished=${JSON.stringify(e6.state.finished)}`);
}

// ----- #12: Scoring (canonical Zork I) -----
console.log("\n=== #12 scoring ===");
{
  const e = new Engine(zork);
  // Gallery is dark — give the player a lit lamp so the painting is perceivable.
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "gallery", painting: "gallery", lamp: "player" },
    itemStates: {
      ...e.state.itemStates,
      lamp: { ...(e.state.itemStates.lamp ?? {}), isLit: true },
    },
  };
  const before = e.state.flags.score as number;
  e.execute({ type: "take", itemId: "painting" });
  const afterTake = (e.state.flags.score as number) - before;
  afterTake === 4
    ? pass(`take painting → score +4 (got +${afterTake})`)
    : fail(`expected +4, got +${afterTake}`);

  // Drop + retake → no double pickup credit
  e.execute({ type: "drop", itemId: "painting" });
  e.execute({ type: "take", itemId: "painting" });
  const afterRetake = (e.state.flags.score as number) - before;
  afterRetake === 4
    ? pass("retake painting → no double-credit (still +4 total)")
    : fail(`expected +4, got +${afterRetake}`);

  // Teleport to living-room, force trophy-case open, deposit painting → +TV (canonical TV=6).
  // Fire a no-op `look` first so the visit-living-room trigger settles BEFORE
  // we measure the deposit delta (state mutations don't fire triggers — only
  // execute() does).
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "living-room" },
    itemStates: {
      ...e.state.itemStates,
      "trophy-case": { ...(e.state.itemStates["trophy-case"] ?? {}), isOpen: true },
    },
  };
  e.execute({ type: "look" }); // settle the visit-living-room +5 trigger
  const beforeDeposit = e.state.flags.score as number;
  e.execute({ type: "put", itemId: "painting", targetId: "trophy-case" });
  const afterDeposit = (e.state.flags.score as number) - beforeDeposit;
  afterDeposit === 6
    ? pass(`deposit painting → score +6 TV (got +${afterDeposit})`)
    : fail(`expected +6, got +${afterDeposit}`);
  e.state.flags["painting-deposited"] === true
    ? pass("painting-deposited flag flipped true")
    : fail(`flag = ${e.state.flags["painting-deposited"]}`);

  // Take painting back out → -TV (canonical refund)
  const beforeDebit = e.state.flags.score as number;
  e.execute({ type: "take", itemId: "painting" });
  const afterDebit = (e.state.flags.score as number) - beforeDebit;
  afterDebit === -6
    ? pass(`removing painting from case → score -6 (got ${afterDebit})`)
    : fail(`expected -6, got ${afterDebit}`);
  e.state.flags["painting-deposited"] === false
    ? pass("painting-deposited flag flipped back false")
    : fail(`flag = ${e.state.flags["painting-deposited"]}`);

  // Put back in → re-credit. Final breakdown: enter-house +10, take +4,
  // deposit +6, debit -6, re-credit +6 = 20.
  e.execute({ type: "put", itemId: "painting", targetId: "trophy-case" });
  const finalScore = e.state.flags.score as number;
  finalScore === 20
    ? pass(`re-deposit nets back: enter-house(+10) + take(+4) + deposit(+6) - debit(-6) + redeposit(+6) = 20 (got ${finalScore})`)
    : fail(`expected 20, got ${finalScore}`);
}

// ----- #13: Score view + rank tier table -----
console.log("\n=== #13 score view + rank tier ===");
{
  const e = new Engine(zork);
  for (const [score, expected] of [
    [0, "Beginner"],
    [25, "Amateur Adventurer"],
    [110, "Novice Adventurer"],
    [200, "Junior Adventurer"],
    [300, "Adventurer"],
    [340, "Wizard"],
    [350, "Master Adventurer"],
  ] as Array<[number, string]>) {
    e.state = { ...e.state, flags: { ...e.state.flags, score } };
    const v = e.getView();
    v.score?.rank === expected
      ? pass(`score=${score} → rank "${expected}"`)
      : fail(`score=${score} expected "${expected}" got "${v.score?.rank}"`);
  }
  const v = e.getView();
  v.score?.max === 350
    ? pass(`view.score.max = 350`)
    : fail(`view.score.max = ${v.score?.max}`);
}

// ----- NumericExpr arithmetic + inventoryWeight -----
console.log("\n=== NumericExpr arithmetic + inventoryWeight ===");
{
  const { evaluateNumericExpr } = await import("../src/engine/state");
  const e = newEngine();
  e.state = { ...e.state, flags: { ...e.state.flags, "x": 5, "y": 10 } };

  const lit = evaluateNumericExpr({ kind: "literal", value: 7 }, e.state);
  lit === 7 ? pass("literal evaluates to 7") : fail(`literal got ${lit}`);

  const sum = evaluateNumericExpr(
    { kind: "add", left: { kind: "flag", key: "x" }, right: { kind: "flag", key: "y" } },
    e.state,
  );
  sum === 15 ? pass("add(flag(x)=5, flag(y)=10) = 15") : fail(`add got ${sum}`);

  const neg = evaluateNumericExpr({ kind: "negate", of: { kind: "flag", key: "x" } }, e.state);
  neg === -5 ? pass("negate(flag(x)=5) = -5") : fail(`negate got ${neg}`);

  // inventoryWeight: synthesize two items in inventory with weights.
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, lamp: "player", sword: "player" },
    itemStates: {
      ...e.state.itemStates,
      lamp: { ...(e.state.itemStates.lamp ?? {}), weight: 15 },
      sword: { ...(e.state.itemStates.sword ?? {}), weight: 30 },
    },
  };
  const w = evaluateNumericExpr({ kind: "inventoryWeight" }, e.state);
  w === 45 ? pass("inventoryWeight(lamp=15, sword=30) = 45") : fail(`inventoryWeight got ${w}`);

  // Items at "nowhere" or in rooms don't count.
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, axe: "troll-room" },
    itemStates: {
      ...e.state.itemStates,
      axe: { ...(e.state.itemStates.axe ?? {}), weight: 25 },
    },
  };
  const w2 = evaluateNumericExpr({ kind: "inventoryWeight" }, e.state);
  w2 === 45 ? pass("inventoryWeight excludes items not in inventory") : fail(`got ${w2}`);
}

// ----- adjustFlag.by accepts NumericExpr -----
console.log("\n=== adjustFlag.by NumericExpr deltas ===");
{
  const { applyEffect } = await import("../src/engine/state");
  const e = newEngine();
  e.state = { ...e.state, flags: { ...e.state.flags, "score": 100, "bonus": 5 } };

  // Literal still works (backwards compatible).
  const s1 = applyEffect(e.state, { type: "adjustFlag", key: "score", by: 10 });
  s1.flags.score === 110 ? pass("adjustFlag literal by: 10 → score 110") : fail(`got ${s1.flags.score}`);

  // NumericExpr by — adjust score by flag(bonus).
  const s2 = applyEffect(e.state, {
    type: "adjustFlag",
    key: "score",
    by: { kind: "flag", key: "bonus" },
  });
  s2.flags.score === 105 ? pass("adjustFlag by NumericExpr flag(bonus)=5 → score 105") : fail(`got ${s2.flags.score}`);

  // Composite: by add(flag(bonus), literal(2)) = 7
  const s3 = applyEffect(e.state, {
    type: "adjustFlag",
    key: "score",
    by: { kind: "add", left: { kind: "flag", key: "bonus" }, right: { kind: "literal", value: 2 } },
  });
  s3.flags.score === 107 ? pass("adjustFlag by add(flag(bonus), 2) → score 107") : fail(`got ${s3.flags.score}`);

  // Negate: by negate(flag(bonus)) = -5
  const s4 = applyEffect(e.state, {
    type: "adjustFlag",
    key: "score",
    by: { kind: "negate", of: { kind: "flag", key: "bonus" } },
  });
  s4.flags.score === 95 ? pass("adjustFlag by negate(flag(bonus)) → score 95") : fail(`got ${s4.flags.score}`);
}

// ----- takeableWhen rejection (inventory-weight gate) -----
console.log("\n=== takeableWhen rejects when carry-weight would exceed cap ===");
{
  // Mutate the story for this test: give the lamp a takeableWhen that rejects
  // when total weight would exceed max-carry-weight, plus state.weight.
  const testStory = JSON.parse(JSON.stringify(story));
  const lamp = testStory.items.find((i: { id: string }) => i.id === "lamp");
  lamp.state = { ...(lamp.state ?? {}), weight: 15 };
  lamp.takeableWhen = {
    type: "compare",
    left: {
      kind: "add",
      left: { kind: "inventoryWeight" },
      right: { kind: "itemState", itemId: { fromArg: "self" }, key: "weight" },
    },
    op: "<=",
    right: { kind: "flag", key: "max-carry-weight" },
  };
  lamp.takeBlockedMessage = "Your load is too heavy.";
  // Sword too — to make total weight exceed cap when both held + lamp attempted.
  const sword = testStory.items.find((i: { id: string }) => i.id === "sword");
  sword.state = { ...(sword.state ?? {}), weight: 30 };

  const { Engine: TestEngine } = await import("../src/engine/engine");
  const te = new TestEngine(testStory);
  // Player at living-room (lamp's location is irrelevant for this test;
  // we'll move the lamp to the player's room directly).
  te.state = {
    ...te.state,
    itemLocations: { ...te.state.itemLocations, player: "living-room", lamp: "living-room", sword: "player" },
    flags: { ...te.state.flags, "max-carry-weight": 40 },
  };
  // Sword (30) is in inventory; lamp (15) attempt: 30 + 15 = 45 > 40 → reject.
  const r = te.execute({ type: "take", itemId: "lamp" });
  r.ok === false &&
    r.event.type === "rejected" &&
    (r.event as { reason?: string }).reason === "take-blocked"
    ? pass("take(lamp) rejected with reason 'take-blocked' when over cap")
    : fail(`event=${JSON.stringify(r.event)}`);
  te.state.itemLocations.lamp === "living-room"
    ? pass("lamp stayed in room (take did not commit)")
    : fail(`lamp at ${te.state.itemLocations.lamp}`);

  // Now raise the cap and retry — should succeed.
  te.state = { ...te.state, flags: { ...te.state.flags, "max-carry-weight": 100 } };
  const r2 = te.execute({ type: "take", itemId: "lamp" });
  r2.ok === true && te.state.itemLocations.lamp === "player"
    ? pass("take(lamp) succeeds when cap is raised")
    : fail(`event=${JSON.stringify(r2.event)} loc=${te.state.itemLocations.lamp}`);
}

// ----- nameVariants resolution -----
console.log("\n=== Item.nameVariants resolves with state ===");
{
  const e = newEngine();
  // Boat is wired with three states (deflated / inflated / punctured) and
  // matching nameVariants. Force each state, build the view, assert the
  // resolved name in itemsHere.
  const placeBoatHere = () => {
    const room = e.state.itemLocations.player;
    e.state = {
      ...e.state,
      itemLocations: { ...e.state.itemLocations, "inflatable-boat": room },
    };
  };
  const setInflation = (v: "deflated" | "inflated" | "punctured") => {
    e.state = {
      ...e.state,
      itemStates: {
        ...e.state.itemStates,
        "inflatable-boat": { ...(e.state.itemStates["inflatable-boat"] ?? {}), inflation: v },
      },
    };
  };
  const boatViewName = () =>
    e.getView().itemsHere.find((i) => i.id === "inflatable-boat")?.name;

  placeBoatHere();

  setInflation("deflated");
  boatViewName() === "pile of plastic"
    ? pass("deflated → 'pile of plastic' (canonical name)")
    : fail(`deflated boat name = ${boatViewName()}`);

  setInflation("inflated");
  boatViewName() === "magic boat"
    ? pass("inflated → 'magic boat' (variant)")
    : fail(`inflated boat name = ${boatViewName()}`);

  setInflation("punctured");
  boatViewName() === "deflated boat"
    ? pass("punctured → 'deflated boat' (variant)")
    : fail(`punctured boat name = ${boatViewName()}`);

  // appearanceVariants should track in lockstep.
  setInflation("inflated");
  e.getView().itemsHere.find((i) => i.id === "inflatable-boat")?.appearance ===
    "There is a magic boat here."
    ? pass("inflated → appearance 'There is a magic boat here.'")
    : fail(`inflated appearance = ${e.getView().itemsHere.find((i) => i.id === "inflatable-boat")?.appearance}`);
}

// ----- Canonical 3-life soft-death mechanic -----
console.log("\n=== 3-life soft-death (canonical JIGS-UP) ===");
{
  // Helper: trigger one death by writing the canonical signal directly.
  const die = (e: Engine, message: string) => {
    e.state = {
      ...e.state,
      flags: {
        ...e.state.flags,
        "death-message": message,
        "just-died": true,
      },
    };
    // Wait turn drives the afterAction trigger sweep; process-death fires.
    e.execute({ type: "wait" });
  };

  // 1st death: respawn at forest-1, items dropped at the death room.
  const e1 = newEngine();
  e1.state = {
    ...e1.state,
    itemLocations: {
      ...e1.state.itemLocations,
      player: "gallery",
      sword: "player",
      lamp: "player",
    },
    itemStates: {
      ...e1.state.itemStates,
      lamp: { ...(e1.state.itemStates.lamp ?? {}), isLit: true },
    },
  };
  die(e1, "Test death 1.");
  e1.state.flags.deaths === 1
    ? pass("1st death → deaths=1")
    : fail(`deaths=${e1.state.flags.deaths}`);
  e1.state.itemLocations.player === "forest-1"
    ? pass("1st death → player respawns at forest-1")
    : fail(`player at ${e1.state.itemLocations.player}`);
  e1.state.itemLocations.sword === "gallery" && e1.state.itemLocations.lamp === "gallery"
    ? pass("1st death → carried items dropped at death-room (gallery)")
    : fail(`sword=${e1.state.itemLocations.sword} lamp=${e1.state.itemLocations.lamp}`);
  e1.state.itemStates.lamp?.isLit === false
    ? pass("1st death → lit lamp extinguished")
    : fail(`lamp.isLit=${e1.state.itemStates.lamp?.isLit}`);
  e1.state.flags["just-died"] === false
    ? pass("1st death → just-died cleared (death-message persists for inspection)")
    : fail(`just-died=${e1.state.flags["just-died"]}`);
  e1.state.flags["death-message"] === "Test death 1."
    ? pass("1st death → death-message persists post-resolution")
    : fail(`death-message=${JSON.stringify(e1.state.flags["death-message"])}`);
  e1.state.finished === undefined
    ? pass("1st death → game NOT finished (soft-death)")
    : fail(`finished=${JSON.stringify(e1.state.finished)}`);

  // 3rd death: hard-end with Land of the Living Dead.
  const e2 = newEngine();
  e2.state = {
    ...e2.state,
    itemLocations: { ...e2.state.itemLocations, player: "gallery" },
    flags: { ...e2.state.flags, deaths: 2 },
  };
  die(e2, "Final death.");
  e2.state.finished?.won === false &&
    /land of the living dead/i.test(e2.state.finished?.message ?? "")
    ? pass("3rd death → endGame with Land of the Living Dead message")
    : fail(`finished=${JSON.stringify(e2.state.finished)}`);
  e2.state.flags.deaths === 3
    ? pass("3rd death → deaths=3")
    : fail(`deaths=${e2.state.flags.deaths}`);
}

// ----- Force-open egg destroys canary (canonical "indelicate handling") -----
console.log("\n=== open egg destroys canary ===");
{
  const e = newEngine();
  e.state.itemStates.egg?.broken === false
    ? pass("fresh state: egg.broken === false (initial-state seeded)")
    : fail(`egg.broken = ${JSON.stringify(e.state.itemStates.egg?.broken)}`);
  e.state.itemStates.canary?.broken === false
    ? pass("fresh state: canary.broken === false")
    : fail(`canary.broken = ${JSON.stringify(e.state.itemStates.canary?.broken)}`);

  // Player carries the closed egg; force-open it.
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "west-of-house", egg: "player" },
  };
  e.execute({ type: "recordIntent", signalId: "open", args: { itemId: "egg" } });

  e.state.itemStates.egg?.broken === true
    ? pass("egg.broken === true after open")
    : fail(`egg.broken = ${JSON.stringify(e.state.itemStates.egg?.broken)}`);
  e.state.itemStates.canary?.broken === true
    ? pass("canary.broken === true after open")
    : fail(`canary.broken = ${JSON.stringify(e.state.itemStates.canary?.broken)}`);
  e.state.firedTriggers.includes("open-egg-destroys-canary")
    ? pass("open-egg-destroys-canary fired")
    : fail("trigger did not fire", JSON.stringify(e.state.firedTriggers.filter((t) => /egg|canary/.test(t))));

  // Close handler refuses a broken egg — engine-enforced, no LLM flavor needed.
  const closeResult = e.execute({ type: "recordIntent", signalId: "close", args: { itemId: "egg" } });
  e.state.itemStates.egg?.isOpen === true
    ? pass("close handler refuses broken egg (isOpen stays true)")
    : fail(`isOpen flipped to ${e.state.itemStates.egg?.isOpen}`);
  closeResult.narrationCues.some((c) => /too bent out of true to close/.test(c))
    ? pass("close-refusal cue mentions 'bent out of true'")
    : fail(`cues = ${JSON.stringify(closeResult.narrationCues)}`);
}

// ----- Thief-opens-egg blocks the force-open trigger -----
console.log("\n=== thief-opens-egg blocks force-open ===");
{
  const e = newEngine();
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "west-of-house", egg: "player" },
    firedTriggers: [...e.state.firedTriggers, "thief-opens-egg"],
  };
  e.execute({ type: "recordIntent", signalId: "open", args: { itemId: "egg" } });

  !e.state.firedTriggers.includes("open-egg-destroys-canary")
    ? pass("open-egg-destroys-canary suppressed when thief-opens-egg already fired")
    : fail("trigger fired despite thief-opens-egg gate");
  // Canary still intact (whatever the thief left behind is the thief's problem).
  e.state.itemStates.canary?.broken === false
    ? pass("canary still intact in thief-already-opened scenario")
    : fail(`canary.broken = ${JSON.stringify(e.state.itemStates.canary?.broken)}`);
}

// ----- Stale firedTriggers entry must NOT block force-open (once:true relaxed) -----
console.log("\n=== open-egg-destroys-canary fires despite stale firedTriggers ===");
{
  const e = newEngine();
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "west-of-house", egg: "player" },
    firedTriggers: [...e.state.firedTriggers, "open-egg-destroys-canary"],
  };
  e.execute({ type: "recordIntent", signalId: "open", args: { itemId: "egg" } });
  e.state.itemStates.egg?.broken === true
    ? pass("trigger fires despite stale firedTriggers entry (no once:true lockout)")
    : fail(`egg.broken = ${JSON.stringify(e.state.itemStates.egg?.broken)}`);
}

// ----- Live-scenario reproduction: open egg from nest at up-a-tree -----
console.log("\n=== open egg from nest at up-a-tree (live-scenario reproduction) ===");
{
  const e = newEngine();
  e.execute({ type: "go", direction: "north" });
  e.execute({ type: "go", direction: "north" });
  e.execute({ type: "go", direction: "up" });

  console.log("  pre-open state:", {
    playerAt: e.state.itemLocations.player,
    eggAt: e.state.itemLocations.egg,
    eggState: e.state.itemStates.egg,
    nestState: e.state.itemStates.nest,
    matchedIntents: e.state.matchedIntents,
    firedTriggers_relevant: e.state.firedTriggers.filter((t) => /egg|canary|thief/.test(t)),
  });

  const result = e.execute({ type: "recordIntent", signalId: "open", args: { itemId: "egg" } });

  console.log("  post-open cues:", result.narrationCues);
  console.log("  post-open triggersFired:", result.triggersFired);
  console.log("  post-open state:", {
    eggIsOpen: e.state.itemStates.egg?.isOpen,
    eggBroken: e.state.itemStates.egg?.broken,
    canaryBroken: e.state.itemStates.canary?.broken,
    matchedIntents: e.state.matchedIntents,
    matchedArg_open: e.state.matchedIntentArgs?.open,
    firedTriggers_relevant: e.state.firedTriggers.filter((t) => /egg|canary|thief/.test(t)),
  });

  e.state.itemStates.egg?.broken === true
    ? pass("LIVE-SCENARIO: trigger fires when egg opened from nest at up-a-tree")
    : fail("trigger DID NOT fire — see post-open dumps above for diagnosis");
}

// ----- Drop-from-tree: items fall to the path below (generic primitive) -----
console.log("\n=== drop from up-a-tree → items fall to path ===");
{
  // Walk to up-a-tree carrying the lamp; drop the lamp; assert it lands at path.
  const e = newEngine();
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, lamp: "player" },
  };
  e.execute({ type: "go", direction: "north" });
  e.execute({ type: "go", direction: "north" });
  e.execute({ type: "go", direction: "up" });
  const result = e.execute({ type: "drop", itemId: "lamp" });

  e.state.itemLocations.lamp === "path"
    ? pass("dropped lamp lands at path (not up-a-tree)")
    : fail(`lamp at ${e.state.itemLocations.lamp}`);
  result.triggersFired.includes("items-fall-from-tree")
    ? pass("items-fall-from-tree fired")
    : fail("trigger did not fire");
  result.triggersFired.includes("egg-breaks-on-tree-drop")
    ? fail("egg-breaks fired on lamp drop (should only fire for egg)")
    : pass("egg-breaks did NOT fire on non-egg drop");
}

// ----- Drop egg from tree: shell breaks, canary spills out, both at path -----
console.log("\n=== drop egg from up-a-tree → both shatter onto path ===");
{
  const e = newEngine();
  // Walk to up-a-tree, take egg from nest, then drop it.
  e.execute({ type: "go", direction: "north" });
  e.execute({ type: "go", direction: "north" });
  e.execute({ type: "go", direction: "up" });
  e.execute({ type: "take", itemId: "egg" });
  e.state.itemLocations.egg === "player"
    ? pass("setup: egg in player inventory")
    : fail(`egg at ${e.state.itemLocations.egg}`);

  const result = e.execute({ type: "drop", itemId: "egg" });

  e.state.itemLocations.egg === "path"
    ? pass("dropped egg lands at path")
    : fail(`egg at ${e.state.itemLocations.egg}`);
  e.state.itemLocations.canary === "path"
    ? pass("canary spilled out onto path")
    : fail(`canary at ${e.state.itemLocations.canary}`);
  e.state.itemStates.egg?.broken === true
    ? pass("egg broken=true")
    : fail(`egg.broken = ${e.state.itemStates.egg?.broken}`);
  e.state.itemStates.canary?.broken === true
    ? pass("canary broken=true")
    : fail(`canary.broken = ${e.state.itemStates.canary?.broken}`);
  e.state.itemStates.egg?.isOpen === true
    ? pass("egg isOpen=true")
    : fail(`egg.isOpen = ${e.state.itemStates.egg?.isOpen}`);
  result.triggersFired.includes("egg-breaks-on-tree-drop") &&
    result.triggersFired.includes("items-fall-from-tree")
    ? pass("both egg-breaks-on-tree-drop and items-fall-from-tree fired")
    : fail(`triggersFired = ${JSON.stringify(result.triggersFired)}`);
}

// ----- Granite-wall teleport (canonical TEMPLE / TREASURE) -----
console.log("\n=== granite-wall teleport (say temple / treasure) ===");
{
  const e = new Engine(zork as unknown as Story);

  // At the North Temple, saying the word teleports to the Treasure Room.
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "north-temple" },
  };
  e.execute({ type: "recordIntent", signalId: "say-granite-word" });
  e.state.itemLocations.player === "treasure-room"
    ? pass("say-granite-word at north-temple → teleports to treasure-room")
    : fail(`player at ${e.state.itemLocations.player}, expected treasure-room`);

  // From the Treasure Room, saying it again returns to the Temple — and does
  // NOT bounce straight back (removeMatchedIntent stops the same-turn ping-pong).
  e.execute({ type: "recordIntent", signalId: "say-granite-word" });
  e.state.itemLocations.player === "north-temple"
    ? pass("say-granite-word at treasure-room → teleports back to north-temple (no double-hop)")
    : fail(`player at ${e.state.itemLocations.player}, expected north-temple`);

  // Said anywhere else → no teleport (canonical "Nothing happens").
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "kitchen" },
  };
  e.execute({ type: "recordIntent", signalId: "say-granite-word" });
  e.state.itemLocations.player === "kitchen"
    ? pass("say-granite-word away from a granite wall → player unmoved")
    : fail(`player at ${e.state.itemLocations.player}, expected kitchen`);
}

// ----- Give any item to the thief -----
console.log("\n=== thief accepts any gift ===");
{
  const e = new Engine(zork as unknown as Story);
  e.state = {
    ...e.state,
    itemLocations: {
      ...e.state.itemLocations,
      player: "round-room",
      thief: "round-room",
      torch: "player",
      lamp: "player",
    },
    itemStates: {
      ...e.state.itemStates,
      thief: { ...(e.state.itemStates.thief ?? {}), appeared: true },
      lamp: { ...(e.state.itemStates.lamp ?? {}), isLit: true },
    },
  };
  const r = e.execute({
    type: "recordIntent",
    signalId: "give",
    args: { itemId: "torch", targetId: "thief" },
  });
  e.state.itemLocations.torch === "thief"
    ? pass("give torch to thief → thief pockets it (location = thief)")
    : fail(`torch at ${e.state.itemLocations.torch}, expected thief`);
  r.triggersFired.includes("thief-accepts-gift")
    ? pass("thief-accepts-gift fired (not the give-rejects catchall)")
    : fail(`triggersFired = ${JSON.stringify(r.triggersFired)}`);
}

// ----- DIAGNOSE -----
console.log("\n=== diagnose command ===");
{
  const wounded = new Engine(zork as unknown as Story);
  wounded.state = {
    ...wounded.state,
    flags: { ...wounded.state.flags, "player-health": 15 },
  };
  const r = wounded.execute({ type: "recordIntent", signalId: "diagnose" });
  r.triggersFired.includes("diagnose-report")
    ? pass("diagnose → diagnose-report fired")
    : fail(`triggersFired = ${JSON.stringify(r.triggersFired)}`);
  r.narrationCues.some((c) => /serious wound/i.test(c))
    ? pass("diagnose at health 15 → reports a serious wound")
    : fail(`cues = ${JSON.stringify(r.narrationCues)}`);

  const healthy = new Engine(zork as unknown as Story);
  const r2 = healthy.execute({ type: "recordIntent", signalId: "diagnose" });
  r2.narrationCues.some((c) => /perfect health/i.test(c))
    ? pass("diagnose at full health → perfect health")
    : fail(`cues = ${JSON.stringify(r2.narrationCues)}`);
}

// ----- Passive healing -----
console.log("\n=== passive healing ===");
{
  const resting = new Engine(zork as unknown as Story);
  resting.state = {
    ...resting.state,
    flags: { ...resting.state.flags, "player-health": 20 },
  };
  resting.execute({ type: "wait" });
  resting.state.flags["player-health"] === 21
    ? pass("wait while wounded + out of combat → player-health +1 (20 → 21)")
    : fail(`player-health = ${resting.state.flags["player-health"]}, expected 21`);

  // In combat: player and thief together (so the disengage trigger can't clear
  // the engagement), combat-engaged true. Assert player-heals does NOT fire —
  // checked on triggersFired rather than the health number, which combat noise
  // would otherwise muddy.
  const fighting = new Engine(zork as unknown as Story);
  fighting.state = {
    ...fighting.state,
    itemLocations: {
      ...fighting.state.itemLocations,
      player: "round-room",
      thief: "round-room",
      lamp: "player",
    },
    itemStates: {
      ...fighting.state.itemStates,
      thief: { ...(fighting.state.itemStates.thief ?? {}), appeared: true },
      lamp: { ...(fighting.state.itemStates.lamp ?? {}), isLit: true },
    },
    flags: {
      ...fighting.state.flags,
      "player-health": 20,
      "combat-engaged-with-thief": true,
    },
  };
  const fr = fighting.execute({ type: "wait" });
  !fr.triggersFired.includes("player-heals")
    ? pass("wait while combat-engaged → player-heals does not fire")
    : fail(`player-heals fired in combat; triggersFired = ${JSON.stringify(fr.triggersFired)}`);

  const full = new Engine(zork as unknown as Story);
  full.execute({ type: "wait" });
  full.state.flags["player-health"] === 30
    ? pass("wait at full health → stays at 30 (no overshoot)")
    : fail(`player-health = ${full.state.flags["player-health"]}, expected 30`);
}

// ----- Inventory weight: recursive + skip-when-carried -----
console.log("\n=== inventory weight (recursive itemWeight + already-carried skip) ===");
{
  // (a) Take an item OUT of a container you already carry — never weight-blocked,
  // even with the cap set absurdly low (the gate is skipped entirely).
  const a = new Engine(zork as unknown as Story);
  a.state = {
    ...a.state,
    flags: { ...a.state.flags, "max-carry-weight": 1 },
    itemLocations: { ...a.state.itemLocations, egg: "player", canary: "egg" },
    itemStates: {
      ...a.state.itemStates,
      egg: { ...(a.state.itemStates.egg ?? {}), weight: 10, isOpen: true },
      canary: { ...(a.state.itemStates.canary ?? {}), weight: 10 },
    },
  };
  const ra = a.execute({ type: "take", itemId: "canary" });
  a.state.itemLocations.canary === "player"
    ? pass("take canary out of a carried egg → succeeds (weight gate skipped)")
    : fail(`canary at ${a.state.itemLocations.canary}; event=${JSON.stringify(ra.event)}`);

  // (b) Take a loaded container off the floor — recursive itemWeight counts its
  // contents, pushing it over the cap.
  const b = new Engine(zork as unknown as Story);
  const bRoom = b.state.itemLocations.player;
  b.state = {
    ...b.state,
    flags: { ...b.state.flags, "max-carry-weight": 15 },
    itemLocations: { ...b.state.itemLocations, egg: bRoom, canary: "egg" },
    itemStates: {
      ...b.state.itemStates,
      egg: { ...(b.state.itemStates.egg ?? {}), weight: 10, isOpen: true },
      canary: { ...(b.state.itemStates.canary ?? {}), weight: 10 },
    },
  };
  const rb = b.execute({ type: "take", itemId: "egg" });
  !rb.ok && (rb.event as { reason?: string }).reason === "take-blocked"
    ? pass("take loaded egg (egg 10 + canary 10 > cap 15) → take-blocked (contents counted)")
    : fail(`expected take-blocked; ok=${rb.ok} event=${JSON.stringify(rb.event)}`);
  b.state.itemLocations.egg === bRoom
    ? pass("rejected loaded egg stays in the room")
    : fail(`egg at ${b.state.itemLocations.egg}`);

  // (c) Same loaded container, generous cap → take succeeds (gate still works).
  const c = new Engine(zork as unknown as Story);
  const cRoom = c.state.itemLocations.player;
  c.state = {
    ...c.state,
    flags: { ...c.state.flags, "max-carry-weight": 100 },
    itemLocations: { ...c.state.itemLocations, egg: cRoom, canary: "egg" },
    itemStates: {
      ...c.state.itemStates,
      egg: { ...(c.state.itemStates.egg ?? {}), weight: 10, isOpen: true },
      canary: { ...(c.state.itemStates.canary ?? {}), weight: 10 },
    },
  };
  c.execute({ type: "take", itemId: "egg" });
  c.state.itemLocations.egg === "player"
    ? pass("take loaded egg under a generous cap → succeeds")
    : fail(`egg at ${c.state.itemLocations.egg}`);
}

// ----- Done -----
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
