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
  e.state = { ...e.state, playerLocation: "south-temple" };
  e.execute({ type: "wait" }); // tick triggers
  e.state.flags["coffin-cure"] === true
    ? pass("coffin-cure flips true when at south-temple without coffin")
    : fail("coffin-cure false", JSON.stringify(e.state.flags["coffin-cure"]));

  // Now pick up coffin (simulate by adding to inventory)
  e.state = { ...e.state, itemLocations: { ...e.state.itemLocations, coffin: "inventory" } };
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
    playerLocation: "loud-room",
    itemLocations: { ...e.state.itemLocations, lamp: "inventory" },
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
    playerLocation: "end-of-rainbow",
    itemLocations: { ...e.state.itemLocations, sceptre: "inventory" },
  };
  // Pot-of-gold hidden initially
  const v0 = e.getView();
  const pog0 = v0.itemsHere.some((i) => i.id === "pot-of-gold");
  !pog0 ? pass("pot-of-gold hidden before wave") : fail("pot-of-gold already visible");

  e.execute({ type: "recordIntent", signalId: "wave-scepter-at-rainbow" });
  e.state.flags["rainbow-flag"] === true
    ? pass("rainbow-flag set")
    : fail("rainbow-flag not set");

  // on-rainbow exits should now be visible/passable
  const v1 = e.getView();
  const pog1 = v1.itemsHere.some((i) => i.id === "pot-of-gold");
  pog1 ? pass("pot-of-gold visible after wave") : fail("pot-of-gold still hidden");
  const upExit = v1.exits.find((x) => x.direction === "up");
  upExit && !upExit.blocked
    ? pass("end-of-rainbow.up unblocked")
    : fail("up still blocked", JSON.stringify(upExit));
}

// ----- Puzzle #4: Endgame won-flag -----
console.log("\n=== #4 Endgame ===");
{
  const e = newEngine();
  // Force all 18 treasures into trophy-case
  const treasures = [
    "egg", "canary", "bag-of-coins", "painting", "chalice", "torch", "trident",
    "coffin", "sceptre", "jade", "scarab", "skull", "emerald", "bracelet", "trunk",
    "bar", "pot-of-gold", "diamond",
  ];
  const newLocs = { ...e.state.itemLocations };
  for (const t of treasures) newLocs[t] = "trophy-case";
  e.state = { ...e.state, playerLocation: "west-of-house", itemLocations: newLocs };
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
  e.state = { ...e.state, playerLocation: "mirror-room-1" };
  e.execute({ type: "recordIntent", signalId: "rub-mirror" });
  e.state.playerLocation === "mirror-room-2"
    ? pass("rub at mirror-room-1 teleports to mirror-room-2")
    : fail(`location is ${e.state.playerLocation}`);

  e.execute({ type: "recordIntent", signalId: "rub-mirror" });
  e.state.playerLocation === "mirror-room-1"
    ? pass("rub at mirror-room-2 teleports back to mirror-room-1")
    : fail(`location is ${e.state.playerLocation}`);
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
    e.state = { ...e.state, playerLocation: "bat-room" };
    e.execute({ type: "wait" });
    if (e.state.playerLocation === "bat-room") {
      allCarried = false;
      break;
    }
    if (!drops.includes(e.state.playerLocation)) {
      allInDropList = false;
      console.log(`     unexpected drop: ${e.state.playerLocation}`);
    }
  }
  allCarried ? pass("bat carried player out of bat-room (5 trials)") : fail("bat did not carry");
  allInDropList ? pass("all drops in canonical drop list") : fail("drop outside canonical list");

  // With garlic in inventory, bat does NOT carry
  const e2 = newEngine();
  e2.state = { ...e2.state, playerLocation: "bat-room", itemLocations: { ...e2.state.itemLocations, garlic: "inventory" } };
  e2.execute({ type: "wait" });
  e2.state.playerLocation === "bat-room"
    ? pass("garlic in inventory blocks bat-carry")
    : fail(`bat carried player anyway to ${e2.state.playerLocation}`);
}

// ----- Puzzle #1: Bell + book + candles -----
console.log("\n=== #1 Bell + book + candles ===");
{
  const e = newEngine();
  // Player at entrance-to-hades with bell + book + lit candles
  e.state = {
    ...e.state,
    playerLocation: "entrance-to-hades",
    itemLocations: {
      ...e.state.itemLocations,
      bell: "inventory",
      book: "inventory",
      candles: "inventory",
    },
  };
  // Step 1: ring bell
  e.execute({ type: "recordIntent", signalId: "ring-bell" });
  e.state.flags["bell-rung"] === true
    ? pass("bell-rung after ring-bell intent")
    : fail("bell-rung not set");

  // Step 2: read book at hades (capstone)
  e.execute({ type: "recordIntent", signalId: "read-book-at-hades" });
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

// ----- Puzzle #7: Coal → diamond -----
console.log("\n=== #7 Coal → diamond ===");
{
  const e = newEngine();
  e.state = {
    ...e.state,
    playerLocation: "machine-room",
    itemLocations: {
      ...e.state.itemLocations,
      screwdriver: "inventory",
      coal: "machine",
    },
    itemStates: {
      ...e.state.itemStates,
      machine: { ...(e.state.itemStates.machine ?? {}), isOpen: false },
    },
  };
  e.execute({ type: "recordIntent", signalId: "turn-machine-switch" });
  e.state.itemLocations.diamond === "machine-room"
    ? pass("diamond moved to machine-room")
    : fail(`diamond at ${e.state.itemLocations.diamond}`);
  e.state.itemLocations.coal === "nowhere"
    ? pass("coal consumed (moved to nowhere)")
    : fail(`coal at ${e.state.itemLocations.coal}`);
}

// ----- Puzzle #9: Dam control panel -----
console.log("\n=== #9 Dam control panel ===");
{
  const e = newEngine();
  // Step 1: yellow button at maintenance-room
  e.state = { ...e.state, playerLocation: "maintenance-room", itemLocations: { ...e.state.itemLocations, wrench: "inventory" } };
  e.execute({ type: "recordIntent", signalId: "push-yellow-button" });
  e.state.flags["gate-flag"] === true
    ? pass("gate-flag set by yellow button")
    : fail("gate-flag not set");

  // Step 2: walk to dam-room, turn bolt
  e.state = { ...e.state, playerLocation: "dam-room" };
  e.execute({ type: "recordIntent", signalId: "turn-dam-bolt" });
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
  e.state = { ...e.state, playerLocation: "reservoir-south" };
  const v = e.getView();
  const n = v.exits.find((x) => x.direction === "north");
  n && !n.blocked
    ? pass("reservoir-south.north unblocked at low-tide")
    : fail("north still blocked", JSON.stringify(n));
}

// ----- Done -----
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
