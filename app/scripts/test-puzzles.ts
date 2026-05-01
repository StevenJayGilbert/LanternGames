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

  // Step 3: strike a match (consumes one of 5; sets matchBurning + 2-turn countdown).
  e.execute({ type: "recordIntent", signalId: "light-match" });
  e.state.itemStates["match"]?.matchesRemaining === 4
    ? pass("match.matchesRemaining = 4 after strike")
    : fail("matches remaining wrong", JSON.stringify(e.state.itemStates["match"]));
  e.state.itemStates["match"]?.matchBurning === true
    ? pass("match.matchBurning = true after strike")
    : fail("match.matchBurning wrong", JSON.stringify(e.state.itemStates["match"]));

  // Step 4: light candles using the burning match.
  e.execute({ type: "recordIntent", signalId: "light-candles" });
  e.state.itemStates["candles"]?.isLit === true
    ? pass("candles relit via light-candles intent")
    : fail("candles not relit", JSON.stringify(e.state.itemStates["candles"]));
  e.state.itemStates["match"]?.matchBurning === false
    ? pass("match.matchBurning = false after lighting candles")
    : fail("match still burning after lighting candles", JSON.stringify(e.state.itemStates["match"]));

  // Step 5: read book at hades (capstone).
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

// ----- Puzzle #1b: Match burns out after 2 turns if unused -----
console.log("\n=== #1b Match burns out after 2 turns ===");
{
  const e = newEngine();
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "entrance-to-hades", match: "player" },
  };
  // Strike match: matchesRemaining: 4, matchBurning: true, countdown: 2.
  e.execute({ type: "recordIntent", signalId: "light-match" });
  // Tick 1 (any wait action triggers afterAction tick).
  e.execute({ type: "wait" });
  e.state.itemStates["match"]?.matchBurning === true
    ? pass("match still burning after 1 wait tick")
    : fail("match extinguished too early", JSON.stringify(e.state.itemStates["match"]));
  // Tick 2: countdown hits 0; match-burns-out fires.
  e.execute({ type: "wait" });
  e.state.itemStates["match"]?.matchBurning === false
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
    itemStates: { ...e.state.itemStates, match: { matchesRemaining: 0, matchBurning: false } },
  };
  const r = e.execute({ type: "recordIntent", signalId: "light-match" });
  r.narrationCues.some((c) => c.includes("matchbook is empty"))
    ? pass("light-match with 0 matches → 'matchbook is empty' cue")
    : fail("expected empty-matchbook cue", JSON.stringify(r.narrationCues));
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
  e.state = { ...e.state, itemLocations: { ...e.state.itemLocations, player: "maintenance-room", wrench: "player" } };
  e.execute({ type: "recordIntent", signalId: "push-yellow-button" });
  e.state.flags["gate-flag"] === true
    ? pass("gate-flag set by yellow button")
    : fail("gate-flag not set");

  // Step 2: walk to dam-room, turn bolt
  e.state = { ...e.state, itemLocations: { ...e.state.itemLocations, player: "dam-room" } };
  e.execute({ type: "recordIntent", signalId: "turn-dam-bolt", args: { withItemId: "wrench" } });
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
  e.execute({ type: "recordIntent", signalId: "inflate-boat" });
  e.state.itemStates["inflatable-boat"]?.inflation === "inflated"
    ? pass("inflate intent → boat state is inflated")
    : fail(`inflation = ${e.state.itemStates["inflatable-boat"]?.inflation}`);

  // Try to board with sword in inventory → puncture trigger fires
  const e2 = newEngine();
  e2.state = {
    ...e2.state,
    itemLocations: { ...e2.state.itemLocations, player: "dam-base", pump: "player", sword: "player" },
  };
  e2.execute({ type: "recordIntent", signalId: "inflate-boat" });
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
  e4.execute({ type: "recordIntent", signalId: "inflate-boat" });
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
  e6.state.finished?.won === false &&
    /waterfall/i.test(e6.state.finished?.message ?? "")
    ? pass("river-5 + 2 turns → endGame waterfall death")
    : fail(`finished=${JSON.stringify(e6.state.finished)}`);
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

  // Put back in → re-credit. Final breakdown: take +4, visit-living-room +5,
  // deposit +6, debit -6, re-credit +6 = 15.
  e.execute({ type: "put", itemId: "painting", targetId: "trophy-case" });
  const finalScore = e.state.flags.score as number;
  finalScore === 15
    ? pass(`re-deposit nets back: take(+4) + visit-living-room(+5) + deposit(+6) - debit(-6) + redeposit(+6) = 15 (got ${finalScore})`)
    : fail(`expected 15, got ${finalScore}`);
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
  v.score?.max === 357
    ? pass(`view.score.max = 357`)
    : fail(`view.score.max = ${v.score?.max}`);
}

// ----- Done -----
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
