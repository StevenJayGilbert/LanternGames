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

// ----- Puzzle #10 (bonus): Empty-handed coal mine -----
console.log("\n=== #10 Empty-handed (timber-room squeeze) ===");
{
  const e = newEngine();
  // Player starts with empty inventory; empty-handed should be true at boot
  e.state.flags["empty-handed"] === true
    ? pass("empty-handed = true at start (player has nothing)")
    : fail(`empty-handed = ${e.state.flags["empty-handed"]} at start`);

  // Pick up an item — flag should flip to false
  e.state = { ...e.state, itemLocations: { ...e.state.itemLocations, lamp: "inventory" } };
  e.execute({ type: "wait" });
  e.state.flags["empty-handed"] === false
    ? pass("empty-handed flips false when player carries lamp")
    : fail(`empty-handed = ${e.state.flags["empty-handed"]} after pickup`);

  // Drop the item LIT at timber-room — flag flips back true; lit lamp on
  // floor keeps the dark room visible so the exit appears in the view.
  e.state = {
    ...e.state,
    playerLocation: "timber-room",
    itemLocations: { ...e.state.itemLocations, lamp: "timber-room" },
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
    playerLocation: "dam-base",
    itemLocations: { ...e.state.itemLocations, pump: "inventory" },
  };
  // Confirm boat starts deflated and not boardable
  const r0 = e.execute({ type: "board", itemId: "inflatable-boat" });
  !r0.ok && (r0.event as { reason?: string }).reason === "vehicle-blocked"
    ? pass("can't board deflated boat (vehicle-blocked)")
    : fail(`expected vehicle-blocked, got ${JSON.stringify(r0.event)}`);

  // Match inflate intent → trigger fires → boat is inflated
  e.execute({ type: "recordIntent", signalId: "inflate-boat" });
  e.state.itemStates["inflatable-boat"]?.inflation === "inflated"
    ? pass("inflate intent → boat state is inflated")
    : fail(`inflation = ${e.state.itemStates["inflatable-boat"]?.inflation}`);

  // Try to board with sword in inventory → puncture trigger fires
  const e2 = newEngine();
  e2.state = {
    ...e2.state,
    playerLocation: "dam-base",
    itemLocations: { ...e2.state.itemLocations, pump: "inventory", sword: "inventory" },
  };
  e2.execute({ type: "recordIntent", signalId: "inflate-boat" });
  // Now board — engine boards (no weapon check at engine level), but the
  // puncture trigger fires immediately (priority 100) on inVehicle+weapon.
  e2.execute({ type: "board", itemId: "inflatable-boat" });
  e2.state.itemStates["inflatable-boat"]?.inflation === "punctured" &&
    e2.state.playerVehicle === null &&
    e2.state.playerLocation === "dam-base"
    ? pass("board with sword → puncture trigger ejects player + sets boat punctured")
    : fail(
        `inflation=${e2.state.itemStates["inflatable-boat"]?.inflation} vehicle=${e2.state.playerVehicle} loc=${e2.state.playerLocation}`,
      );

  // Repair with putty → boat back to deflated
  const e3 = newEngine();
  e3.state = {
    ...e3.state,
    playerLocation: "dam-base",
    itemLocations: { ...e3.state.itemLocations, putty: "inventory" },
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
    playerLocation: "dam-base",
    itemLocations: { ...e4.state.itemLocations, pump: "inventory" },
  };
  e4.execute({ type: "recordIntent", signalId: "inflate-boat" });
  e4.execute({ type: "board", itemId: "inflatable-boat" });
  e4.state.playerVehicle === "inflatable-boat"
    ? pass("clean board → playerVehicle set")
    : fail(`vehicle=${e4.state.playerVehicle}`);

  // go(down) from dam-base → river-1? Actually dam-base has no down exit.
  // Use movePlayer effect via /tp-style state to start at river-1 with the boat.
  e4.state = {
    ...e4.state,
    playerLocation: "river-1",
    itemLocations: { ...e4.state.itemLocations, "inflatable-boat": "river-1" },
  };

  // Tick 1 — counter increments to 1, no advance
  e4.execute({ type: "wait" });
  e4.state.flags["river-tick-counter"] === 1 && e4.state.playerLocation === "river-1"
    ? pass("river-1 turn 1: counter=1, still at river-1")
    : fail(`counter=${e4.state.flags["river-tick-counter"]} loc=${e4.state.playerLocation}`);

  // Tick 2 — counter hits 2, advance fires, player moves to river-2 + counter
  // resets to 0. River-2-tick was already checked earlier in this Phase 2
  // pass (when player was still at river-1) so it doesn't fire — player
  // arrives at river-2 with counter=0, getting the full grace turn at the
  // new room. Generous-by-design.
  e4.execute({ type: "wait" });
  e4.state.playerLocation === "river-2" &&
    e4.state.itemLocations["inflatable-boat"] === "river-2" &&
    e4.state.flags["river-tick-counter"] === 0
    ? pass("river-1 turn 2: advance to river-2 (boat follows, counter resets, no cascade)")
    : fail(
        `loc=${e4.state.playerLocation} boat=${e4.state.itemLocations["inflatable-boat"]} counter=${e4.state.flags["river-tick-counter"]}`,
      );

  // Land at river-3 via go(west) → boat travels to white-cliffs-north
  const e5 = newEngine();
  e5.state = {
    ...e5.state,
    playerLocation: "river-3",
    itemLocations: { ...e5.state.itemLocations, "inflatable-boat": "river-3" },
    itemStates: {
      ...e5.state.itemStates,
      "inflatable-boat": { ...(e5.state.itemStates["inflatable-boat"] ?? {}), inflation: "inflated" },
    },
    playerVehicle: "inflatable-boat",
  };
  e5.execute({ type: "go", direction: "west" });
  e5.state.playerLocation === "white-cliffs-north" &&
    e5.state.itemLocations["inflatable-boat"] === "white-cliffs-north"
    ? pass("go(west) at river-3 lands player + boat at white-cliffs-north")
    : fail(
        `player=${e5.state.playerLocation} boat=${e5.state.itemLocations["inflatable-boat"]}`,
      );

  // Disembark at landing → playerVehicle clears
  e5.execute({ type: "disembark" });
  e5.state.playerVehicle === null
    ? pass("disembark at landing → playerVehicle null")
    : fail(`vehicle=${e5.state.playerVehicle}`);

  // Waterfall death: at river-5, in-boat, after 2 ticks → endGame
  const e6 = newEngine();
  e6.state = {
    ...e6.state,
    playerLocation: "river-5",
    itemLocations: { ...e6.state.itemLocations, "inflatable-boat": "river-5" },
    itemStates: {
      ...e6.state.itemStates,
      "inflatable-boat": { ...(e6.state.itemStates["inflatable-boat"] ?? {}), inflation: "inflated" },
    },
    playerVehicle: "inflatable-boat",
  };
  e6.execute({ type: "wait" }); // tick 1
  e6.execute({ type: "wait" }); // tick 2 → death
  e6.state.finished?.won === false &&
    /waterfall/i.test(e6.state.finished?.message ?? "")
    ? pass("river-5 + 2 turns → endGame waterfall death")
    : fail(`finished=${JSON.stringify(e6.state.finished)}`);
}

// ----- Done -----
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
