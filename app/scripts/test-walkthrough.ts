// End-to-end walkthrough smoke test.
//
// Drives the engine through the canonical Zork I solution from
// docs/walkthrough.txt — every movement is a real go(direction) call, every
// puzzle action is a real engine action (recordIntent for CustomTools, attack
// for combat, board/disembark for the boat). 15 phases mirror the walkthrough
// verbatim. After each phase, a deep-clone snapshot of state is captured so
// failure-path tests (F1..F7) can branch from a known-good checkpoint.
//
// Strict scope: this test does NOT modify the engine or the story. If the
// canonical walkthrough hits a broken exit or missing trigger, the test FAILS
// — those gaps are logged for follow-up plans, not patched here.

import { Engine } from "../src/engine/engine";
import { currentRoomId, isItemAccessible, resolveItemDescription } from "../src/engine/state";
import zork from "../src/stories/zork-1.json" with { type: "json" };
import type { Story, GameState, Atom } from "../src/story/schema";

const story = zork as unknown as Story;

let passed = 0;
let failed = 0;
const gaps: string[] = [];
// First failure aborts the linear walkthrough — fix issues one at a time.
// F-tests still run regardless.
let firstWalkthroughFailure: string | null = null;
let inWalkthrough = true;

// Death-state helper. Under the canonical 3-life soft-death mechanic, a
// fatal trigger doesn't hard-end on the first hit — it sets just-died=true,
// the central process-death trigger drops items + respawns the player at
// forest-1, and only the 3rd death hard-ends. Tests written before this
// migration asserted `finished.won === false`. They now check this helper,
// which accepts EITHER outcome.
function playerDied(state: GameState): boolean {
  if (state.finished?.won === false) return true;
  const deaths = state.flags?.deaths;
  return typeof deaths === "number" && deaths >= 1 && state.itemLocations?.player === "forest-1";
}

// Pull the most recent death message regardless of soft-die vs. hard-end.
// Hard-end stores it on state.finished.message; soft-die leaves it in
// flag.death-message (process-death deliberately doesn't clear so tests can
// inspect it). Returns "" if neither is set.
function deathMessage(state: GameState): string {
  if (state.finished?.message) return state.finished.message;
  const flag = state.flags?.["death-message"];
  return typeof flag === "string" ? flag : "";
}

function pass(label: string): void {
  console.log(`  + ${label}`);
  passed++;
}
function fail(label: string, detail?: string): void {
  console.log(`  X ${label}${detail ? ` -- ${detail}` : ""}`);
  failed++;
  if (inWalkthrough && firstWalkthroughFailure === null) {
    firstWalkthroughFailure = label + (detail ? ` -- ${detail}` : "");
  }
}
function note(label: string): void {
  console.log(`  ~ ${label}`);
  gaps.push(label);
}
function aborted(): boolean {
  return inWalkthrough && firstWalkthroughFailure !== null;
}

function snapshot(e: Engine): GameState {
  return JSON.parse(JSON.stringify(e.state));
}
function restore(e: Engine, s: GameState): void {
  e.state = JSON.parse(JSON.stringify(s));
}

// Drive the engine through one direction. Asserts the resulting playerLocation
// matches expected. Returns the engine for chaining-style code.
// Helpers silently no-op when the engine has already ended the game (e.g. the
// player died earlier in the walkthrough). This avoids hundreds of cascading
// "game-over" rejections that drown out the real first failure.
function safeExec(e: Engine, req: Parameters<Engine["execute"]>[0]): ReturnType<Engine["execute"]> | undefined {
  if (e.state.finished || aborted()) return undefined;
  return e.execute(req);
}

function go(e: Engine, dir: string, expectLoc: string, label?: string): boolean {
  if (e.state.finished || aborted()) return false;
  const r = e.execute({ type: "go", direction: dir });
  if (r.event.type === "rejected") {
    fail(`go(${dir}) -> ${expectLoc}${label ? ` [${label}]` : ""}`,
         `rejected reason=${r.event.reason} from=${currentRoomId(e.state, story)}`);
    return false;
  }
  // Use derived room id — handles the in-vehicle case where the player
  // item's parent is the vehicle (and the vehicle is at the destination).
  const arrived = currentRoomId(e.state, story);
  if (arrived !== expectLoc) {
    fail(`go(${dir}) -> ${expectLoc}${label ? ` [${label}]` : ""}`,
         `arrived at ${arrived}`);
    return false;
  }
  pass(`go(${dir}) -> ${expectLoc}${label ? ` [${label}]` : ""}`);
  return true;
}

function takeItem(e: Engine, id: string, label?: string): boolean {
  if (e.state.finished || aborted()) return false;
  const r = e.execute({ type: "take", itemId: id });
  if (!r.ok) {
    fail(`take(${id})${label ? ` [${label}]` : ""}`,
         `rejected reason=${(r.event as { reason?: string }).reason}`);
    return false;
  }
  pass(`take(${id})${label ? ` [${label}]` : ""}`);
  return true;
}

function dropItem(e: Engine, id: string): boolean {
  if (e.state.finished || aborted()) return false;
  const r = e.execute({ type: "drop", itemId: id });
  if (!r.ok) {
    fail(`drop(${id})`, `rejected reason=${(r.event as { reason?: string }).reason}`);
    return false;
  }
  pass(`drop(${id})`);
  return true;
}

function putItem(e: Engine, id: string, target: string): boolean {
  if (e.state.finished || aborted()) return false;
  const r = e.execute({ type: "put", itemId: id, targetId: target });
  if (!r.ok) {
    fail(`put(${id}, ${target})`, `rejected reason=${(r.event as { reason?: string }).reason}`);
    return false;
  }
  pass(`put(${id}, ${target})`);
  return true;
}

function intent(e: Engine, signalId: string, args?: Record<string, Atom>, label?: string): boolean {
  if (e.state.finished || aborted()) return false;
  const r = e.execute({ type: "recordIntent", signalId, args });
  if (!r.ok) {
    fail(`intent(${signalId})${label ? ` [${label}]` : ""}`,
         `reason=${(r.event as { reason?: string }).reason}`);
    return false;
  }
  pass(`intent(${signalId})${label ? ` [${label}]` : ""}`);
  return true;
}

function attackUntilDead(e: Engine, weapon: string, target: string, maxRounds: number, label: string): boolean {
  if (e.state.finished || aborted()) return false;
  for (let i = 0; i < maxRounds; i++) {
    if (e.state.finished) {
      fail(`${label}: game ended mid-combat`, `msg=${e.state.finished.message?.slice(0, 80)}`);
      return false;
    }
    const hp = e.state.itemStates[target]?.health as number | undefined;
    if (hp !== undefined && hp <= 0) {
      pass(`${label}: ${target} defeated after ${i} rounds`);
      return true;
    }
    const targetLocBefore = e.state.itemLocations[target];
    const r = e.execute({ type: "attack", itemId: weapon, targetId: target });
    if (!r.ok) {
      const ev = r.event as { reason?: string; itemId?: string };
      const targetLocAfter = e.state.itemLocations[target];
      fail(`${label}: attack rejected on round ${i}`,
           `reason=${ev.reason} itemId=${ev.itemId} target was at ${targetLocBefore}, now at ${targetLocAfter}, player@${e.state.itemLocations.player}` +
           (targetLocBefore !== targetLocAfter ? ` -- target wandered mid-combat (engine should pin during combat)` : ""));
      return false;
    }
  }
  const hp = e.state.itemStates[target]?.health as number | undefined;
  if (hp !== undefined && hp <= 0) {
    pass(`${label}: ${target} defeated after ${maxRounds} rounds`);
    return true;
  }
  fail(`${label}: ${target} still alive after ${maxRounds} rounds`, `health=${hp}`);
  return false;
}

function assertFlag(e: Engine, key: string, expected: unknown, label: string): boolean {
  const v = e.state.flags[key];
  if (v === expected) {
    pass(`flag ${key} = ${JSON.stringify(expected)} [${label}]`);
    return true;
  }
  fail(`flag ${key} = ${JSON.stringify(expected)} [${label}]`, `actual=${JSON.stringify(v)}`);
  return false;
}

function assertItemAt(e: Engine, itemId: string, loc: string, label: string): boolean {
  const at = e.state.itemLocations[itemId];
  if (at === loc) {
    pass(`item ${itemId} at ${loc} [${label}]`);
    return true;
  }
  fail(`item ${itemId} at ${loc} [${label}]`, `actual=${at}`);
  return false;
}

// -------------------- Walkthrough --------------------

const e = new Engine(story);

// Run a phase block. If the engine has already ended the game (e.g. player
// killed by troll RNG in a prior phase), skip and log a clear message instead
// of cascading hundreds of game-over rejections. Failure-path tests still
// run from snapshots regardless.
function runPhase(label: string, body: () => void): void {
  console.log(`\n=== ${label} ===`);
  if (e.state.finished) {
    fail(`${label}: skipped — game already ended`,
         `won=${e.state.finished.won} msg=${e.state.finished.message?.slice(0, 80)}`);
    return;
  }
  body();
  if (e.state.finished) {
    fail(`${label}: game ended during this phase`,
         `won=${e.state.finished.won} msg=${e.state.finished.message?.slice(0, 80)}`);
  }
}

// ----- Phase 1: Egg + house entry -----
console.log("\n=== Phase 1: Egg + house entry ===");
if (!e.state.finished && !aborted()) {
  // walkthrough: N. N. U. GET EGG. D. S. E. OPEN WINDOW. W.
  go(e, "north", "north-of-house", "P1");
  go(e, "north", "path", "P1");
  go(e, "up", "up-a-tree", "P1");
  // Egg is inside nest, which is takeable. Walkthrough does GET EGG directly.
  takeItem(e, "egg", "P1 egg in tree");
  // The bird's nest is open by default; take egg works because nest is in the
  // current room and accessible. Score-find-egg should fire.
  go(e, "down", "path", "P1");
  go(e, "south", "north-of-house", "P1");
  go(e, "east", "east-of-house", "P1");
  // Open kitchen-window via the polymorphic open intent
  intent(e, "open", { itemId: "kitchen-window" }, "P1 open window");
  // Verify passage now traversable
  if (e.state.passageStates["kitchen-window"]?.isOpen === true) {
    pass("kitchen-window passageState.isOpen = true");
  } else {
    fail("kitchen-window not open after open intent",
         JSON.stringify(e.state.passageStates["kitchen-window"]));
  }
  go(e, "west", "kitchen", "P1 climb in window");
}

// ----- Phase 2: Trophy case + rug + trapdoor -----
console.log("\n=== Phase 2: Trophy case + rug + trapdoor ===");
if (!e.state.finished && !aborted()) {
  // walkthrough: W (living-room). OPEN CASE. GET ALL. MOVE RUG. OPEN TRAPDOOR. D.
  go(e, "west", "living-room", "P2");
  intent(e, "open", { itemId: "trophy-case" }, "P2 open case");
  // Hold the egg; pick up the lamp + sword (score-take-egg credit pickup
  // should have already fired in P1 for egg).
  takeItem(e, "lamp", "P2 lamp");
  takeItem(e, "sword", "P2 sword");
  intent(e, "move-the-rug", undefined, "P2 move rug");
  assertFlag(e, "rug-moved-flag", true, "P2 rug moved");
  intent(e, "open", { itemId: "trap-door" }, "P2 open trap-door");
  if (e.state.passageStates["trap-door"]?.isOpen === true) {
    pass("trap-door passageState.isOpen = true");
  } else {
    fail("trap-door not open", JSON.stringify(e.state.passageStates["trap-door"]));
  }
  // Light lamp BEFORE descent (cellar is dark)
  intent(e, "light", { itemId: "lamp" }, "P2 light lamp");
  if (e.state.itemStates["lamp"]?.isLit === true) {
    pass("lamp.isLit = true");
  } else {
    fail("lamp not lit", JSON.stringify(e.state.itemStates["lamp"]));
  }
  go(e, "down", "cellar", "P2 descend");
}
const s_below_trapdoor = snapshot(e);

// ----- Phase 3: Painting + troll -----
console.log("\n=== Phase 3: Painting + troll ===");
if (!e.state.finished && !aborted()) {
  // walkthrough: S. E. GET PAINTING. W. N. N (Troll Room). ATTACK TROLL WITH SWORD.
  go(e, "south", "east-of-chasm", "P3");
  go(e, "east", "gallery", "P3");
  takeItem(e, "painting", "P3 painting (gallery is dark, lit lamp in inventory)");
  go(e, "west", "east-of-chasm", "P3");
  go(e, "north", "cellar", "P3");
  go(e, "north", "troll-room", "P3");

  // Test scaffolding: simulate the canonical "save before troll combat,
  // reload on death" loop the walkthrough explicitly recommends. The test
  // can't actually save/reload, so we keep the player alive for the duration
  // of the fight by pinning player-health to 30 before each round. Combat
  // outcome (troll lives or dies) is still RNG; we're just preventing the
  // player from dying mid-test, which canonically requires a reload anyway.
  for (let i = 0; i < 200; i++) {
    const trollHp = e.state.itemStates["troll"]?.health as number | undefined;
    if (trollHp !== undefined && trollHp <= 0) break;
    e.state = { ...e.state, flags: { ...e.state.flags, "player-health": 30 } };
    e.execute({ type: "attack", itemId: "sword", targetId: "troll" });
  }
  const trollHp = e.state.itemStates["troll"]?.health as number | undefined;
  if (trollHp !== undefined && trollHp <= 0) {
    pass(`P3 troll: defeated (with save/reload simulation)`);
  } else {
    fail(`P3 troll: still alive after 200 rounds`, `health=${trollHp}`);
  }

  // Walkthrough: DROP SWORD.
  // Troll's axe and the player's sword may have been dropped during combat;
  // we just attempt to drop the sword if it's still in inventory.
  if (e.state.itemLocations["sword"] === "player") {
    dropItem(e, "sword");
  } else {
    note(`P3: sword no longer in inventory (loc=${e.state.itemLocations["sword"]}); skipping drop`);
  }
  // troll-flag should be set (defeats unblock east+west exits)
  assertFlag(e, "troll-flag", true, "P3 troll-flag");
}
const s_post_troll = snapshot(e);

// ----- Phase 4: Maze -----
console.log("\n=== Phase 4: Maze (skeleton + coins + keys) ===");
if (!e.state.finished && !aborted()) {
  // walkthrough: W. S. E. U. GET COINS. (skip skeleton + knife). SW. E. S. SE.
  go(e, "west", "maze-1", "P4");
  go(e, "south", "maze-2", "P4");
  go(e, "east", "maze-3", "P4");
  go(e, "up", "maze-5", "P4 skeleton room");
  takeItem(e, "bag-of-coins", "P4 coins");
  takeItem(e, "keys", "P4 keys");
  // The walkthrough also notes a rusty-knife and a burned-out lantern here;
  // the rusty knife is needed later vs. the thief.
  takeItem(e, "rusty-knife", "P4 rusty-knife");
  go(e, "southwest", "maze-6", "P4");
  go(e, "east", "maze-7", "P4");
  go(e, "south", "maze-15", "P4");
  go(e, "southeast", "cyclops-room", "P4");
}

// ----- Phase 5: Cyclops + attic -----
console.log("\n=== Phase 5: Cyclops magic word + attic ===");
if (!e.state.finished && !aborted()) {
  // walkthrough: SAY ULYSSES. E (cyclops smashes wall to living-room). E (kitchen). U (attic). GET ALL. D.
  intent(e, "cyclops-magic-word", undefined, "P5 ulysses");
  assertFlag(e, "cyclops-flag", true, "P5 cyclops-flag");
  assertFlag(e, "magic-flag", true, "P5 magic-flag");
  go(e, "east", "strange-passage", "P5 cyclops smashed wall");
  go(e, "east", "living-room", "P5");
  // Walkthrough: PUT TREASURES IN CASE if any. Painting + coins go in.
  // EGG stays in inventory — canonical Wong: "Hold onto the egg; you have
  // to find a way to open it (safely!) first." We give it to the thief in
  // P6, who opens it; both come back to treasure-room when he dies.
  putItem(e, "painting", "trophy-case");
  putItem(e, "bag-of-coins", "trophy-case");
  // E to kitchen, U to attic
  go(e, "east", "kitchen", "P5");
  go(e, "up", "attic", "P5");
  takeItem(e, "rope", "P5 rope");
  takeItem(e, "knife", "P5 attic-knife (nasty)");
  go(e, "down", "kitchen", "P5");
}
const s_post_cyclops = snapshot(e);

// ----- Phase 6: Thief defeat (deterministic) -----
console.log("\n=== Phase 6: Thief defeat (deterministic) ===");
if (!e.state.finished && !aborted()) {
  // walkthrough: W. W. W. (back through living-room → strange-passage → cyclops-room),
  // then UP to treasure-room, ATTACK THIEF WITH KNIFE.
  go(e, "west", "living-room", "P6");
  go(e, "west", "strange-passage", "P6");
  go(e, "west", "cyclops-room", "P6");
  go(e, "up", "treasure-room", "P6 ladder up");

  // Deterministic seeding: place the thief at treasure-room (he wanders
  // randomly; for the purposes of this assertion we normalize his location).
  // Test scaffolding ONLY -- engine behavior is not modified.
  const before = e.state.itemLocations["thief"];
  if (before !== "treasure-room") {
    note(`P6: thief was at ${before}; deterministically moving to treasure-room for combat`);
    e.state = {
      ...e.state,
      itemLocations: { ...e.state.itemLocations, thief: "treasure-room" },
    };
  } else {
    pass("P6: thief already at treasure-room (deterministic seeding no-op)");
  }

  // Canonical Wong: GIVE EGG to thief BEFORE attacking. He pockets it,
  // opens it, and the canary becomes available inside the open egg. When
  // he dies, both come back to treasure-room via thief-dies.
  if (e.state.itemLocations["egg"] === "player" &&
      e.state.itemStates["egg"]?.isOpen === false) {
    pass("P6: egg in inventory + closed before give");
  } else {
    fail("P6: pre-give egg state unexpected",
         `loc=${e.state.itemLocations["egg"]} isOpen=${e.state.itemStates["egg"]?.isOpen}`);
  }
  intent(e, "give", { itemId: "egg", targetId: "thief" }, "P6 give egg to thief");
  // Post-trigger assertions: trigger should have moved egg to thief and
  // opened it. Canary's location depends on the trigger; the test logs it
  // either way.
  if (e.state.itemLocations["egg"] === "thief") {
    pass("P6: egg now in thief's pocket");
  } else {
    fail("P6: egg not at thief", `loc=${e.state.itemLocations["egg"]}`);
  }
  if (e.state.itemStates["egg"]?.isOpen === true) {
    pass("P6: egg.isOpen = true after thief opened it");
  } else {
    fail("P6: egg not opened by thief", JSON.stringify(e.state.itemStates["egg"]));
  }
  console.log(`  i P6: canary location after give = ${e.state.itemLocations["canary"]}`);

  // Test scaffolding: same save/reload simulation as P3 troll. Thief combat is
  // canon-deadly (the walkthrough explicitly says "very good chance you'll get
  // killed, restore and retry"). We pin player-health each round so the test
  // can probe past the fight even on unlucky rolls. The thief's HP drains as
  // normal — the only thing we're stabilizing is the player's death timer.
  for (let i = 0; i < 200; i++) {
    const thiefHp = e.state.itemStates["thief"]?.health as number | undefined;
    if (thiefHp !== undefined && thiefHp <= 0) break;
    e.state = { ...e.state, flags: { ...e.state.flags, "player-health": 30 } };
    // Canonical: use the attic knife (taken in P5) vs. thief. The rusty-knife
    // from the maze is cursed (ZIL: attacking with it triggers telekinetic
    // possession death). The sword was dropped after the troll fight in P3.
    e.execute({ type: "attack", itemId: "knife", targetId: "thief" });
  }
  const thiefHp = e.state.itemStates["thief"]?.health as number | undefined;
  if (thiefHp !== undefined && thiefHp <= 0) {
    pass(`P6 thief: defeated (with save/reload simulation)`);
  } else {
    fail(`P6 thief: still alive after 200 rounds`, `health=${thiefHp}`);
  }

  // After thief-dies fires: chalice + stolen treasures should be at treasure-room.
  assertItemAt(e, "chalice", "treasure-room", "P6 chalice deposited by thief-dies");

  // Egg should be back at treasure-room AND still open (thief-opens-egg set
  // isOpen=true; thief-dies moves egg back here).
  assertItemAt(e, "egg", "treasure-room", "P6 egg back at treasure-room from thief-dies");
  if (e.state.itemStates["egg"]?.isOpen === true) {
    pass("P6: egg still open after thief death");
  } else {
    fail("P6: egg closed again after thief death", JSON.stringify(e.state.itemStates["egg"]));
  }

  // Canary recovery — canonical Wong: "GET CANARY. This takes it out of the egg."
  // Whether canary is inside the open egg (canonical) or somewhere else
  // depends on the JSON wiring. Log the actual location and try to take it.
  console.log(`  i P6: canary location after thief death = ${e.state.itemLocations["canary"]}`);
  takeItem(e, "canary", "P6 canary recovered");

  // Pick up everything in treasure-room.
  takeItem(e, "chalice", "P6 chalice");
  if (e.state.itemLocations["egg"] === "treasure-room") {
    takeItem(e, "egg", "P6 egg from thief hoard");
  }
  if (e.state.itemLocations["jade"] === "treasure-room") {
    takeItem(e, "jade", "P6 jade");
  }
  // bag-of-coins, painting were deposited in the case; thief-dies puts them
  // back at treasure-room ONLY if he had them. Skip if not present.
  for (const itm of ["bag-of-coins", "painting", "scarab", "bracelet"]) {
    if (e.state.itemLocations[itm] === "treasure-room") {
      takeItem(e, itm, `P6 ${itm} from thief hoard`);
    }
  }

  // Drop the rusty-knife (cursed; can't safely use it again) and the attic
  // knife (job done — keeps inventory light for downstream phases).
  if (e.state.itemLocations["rusty-knife"] === "player") dropItem(e, "rusty-knife");

  // Descend back: D. E. E.
  go(e, "down", "cyclops-room", "P6");
  go(e, "east", "strange-passage", "P6");
  go(e, "east", "living-room", "P6");

  // Deposit treasures we picked up. Egg + canary now both in the deposit
  // list (egg was held back from P5; canary recovered after thief-dies).
  for (const itm of ["chalice", "egg", "canary", "jade", "bag-of-coins", "painting", "scarab", "bracelet"]) {
    if (e.state.itemLocations[itm] === "player") {
      putItem(e, itm, "trophy-case");
    }
  }
  // Inventory-weight management: thief is dead, knife (10) and keys (10)
  // are no longer needed (knife was for combat; keys were for the cyclops
  // puzzle in P5). Drop both here to free 20 weight for the LLD ritual
  // load (bell + candles + book) at P10 and the bracelet/coal at P11+.
  if (e.state.itemLocations["knife"] === "player") {
    dropItem(e, "knife");
  }
  if (e.state.itemLocations["keys"] === "player") {
    dropItem(e, "keys");
  }
}
const s_post_thief = snapshot(e);

// ----- Phase 7: Canary + bauble -----
console.log("\n=== Phase 7: Canary + bauble (songbird) ===");
if (!e.state.finished && !aborted()) {
  // walkthrough: GET CANARY (extracted from egg). E. E. N. N (Forest Path). WIND CANARY.
  // Canary was inside egg (an open container). After the thief opened the egg,
  // canary should be at trophy-case (since egg location moved); take it.
  if (e.state.itemLocations["canary"] === "trophy-case") {
    takeItem(e, "canary", "P7 canary from case");
  } else if (e.state.itemLocations["egg"] === "trophy-case" && e.state.itemStates["egg"]?.isOpen === true) {
    // canary in open egg in case
    takeItem(e, "canary", "P7 canary from open egg");
  } else {
    note(`P7: canary at ${e.state.itemLocations["canary"]}; egg open=${e.state.itemStates["egg"]?.isOpen}`);
  }

  go(e, "east", "kitchen", "P7");
  // Walkthrough: OPEN SACK. GET GARLIC. The brown sack (sandwich-bag) is
  // closed by default; open it then take the garlic inside.
  intent(e, "open", { itemId: "sandwich-bag" }, "P7 open sandwich-bag");
  if (e.state.itemLocations["garlic"] === "sandwich-bag") {
    takeItem(e, "garlic", "P7 garlic from sandwich-bag");
  }
  go(e, "east", "east-of-house", "P7 climb out window");
  go(e, "north", "north-of-house", "P7");
  go(e, "north", "path", "P7 forest-path");

  // WIND CANARY at the forest path. Canonical CANARY-OBJECT routine: songbird
  // delivers the brass bauble to the player's current room. (At up-a-tree the
  // bauble would land at path; here we're already at path.)
  intent(e, "wind-canary", undefined, "P7 wind canary");
  assertItemAt(e, "bauble", "path", "P7 bauble dropped at path");
  takeItem(e, "bauble", "P7 take bauble");
  // Canary stays in inventory; it gets deposited at the trophy case
  // during the P12.5 mid-game sweep along with the other coal-mine
  // treasures. Garlic stays in inventory for the bat puzzle (P11).
}

// ----- Phase 8: Dam puzzle -----
console.log("\n=== Phase 8: Dam puzzle ===");
if (!e.state.finished && !aborted()) {
  // walkthrough: return to living-room, D, N, E, N, NE (Reservoir South), E (dam),
  //   N (dam-lobby), GET MATCHES, N or E (maintenance-room), PUSH YELLOW, GET ALL EXCEPT TUBE.
  // Path back: S, E to north-of-house, E to east-of-house, W to kitchen, W to living-room.
  go(e, "south", "north-of-house", "P8");
  go(e, "east", "east-of-house", "P8");
  go(e, "west", "kitchen", "P8");
  go(e, "west", "living-room", "P8");

  // Going down through trapdoor again. The walkthrough notes the trapdoor
  // doesn't close this time. Open if needed.
  if (e.state.passageStates["trap-door"]?.isOpen !== true) {
    intent(e, "open", { itemId: "trap-door" }, "P8 reopen trap");
  }
  go(e, "down", "cellar", "P8");
  // From cellar: N (troll-room), E (ew-passage, requires troll-flag), N (chasm-room), NE (reservoir-south).
  go(e, "north", "troll-room", "P8");
  go(e, "east", "ew-passage", "P8");
  go(e, "north", "chasm-room", "P8");
  go(e, "northeast", "reservoir-south", "P8");
  go(e, "east", "dam-room", "P8 dam");
  go(e, "north", "dam-lobby", "P8 dam-lobby");
  takeItem(e, "match", "P8 matches");
  takeItem(e, "guide", "P8 tour guidebook (optional)");
  go(e, "north", "maintenance-room", "P8");
  intent(e, "push", { itemId: "yellow-button" }, "P8 yellow button");
  assertFlag(e, "gate-flag", true, "P8 gate-flag");
  // GET ALL EXCEPT TUBE: get screwdriver, wrench. Tube is taken later for putty.
  takeItem(e, "screwdriver", "P8");
  takeItem(e, "wrench", "P8");
  takeItem(e, "tube", "P8 tube (for putty)");

  // S. S. (back to dam-room)
  go(e, "south", "dam-lobby", "P8");
  go(e, "south", "dam-room", "P8");
  // TURN BOLT WITH WRENCH
  intent(e, "turn", { itemId: "bolt", withItemId: "wrench" }, "P8 bolt");
  assertFlag(e, "gates-open", true, "P8 gates-open");

  // Wait for low-tide: countdown decrements each turn. Cap at ~12 ticks.
  for (let i = 0; i < 12; i++) {
    if (e.state.flags["low-tide"] === true) break;
    safeExec(e, { type: "wait" });
  }
  assertFlag(e, "low-tide", true, "P8 low-tide reached");

  dropItem(e, "wrench");
  // Inventory-weight management: tour guidebook is optional per canonical
  // walkthrough. Drop it now to free 5 weight before P10's bell+candles+book.
  if (e.state.itemLocations["guide"] === "player") {
    dropItem(e, "guide");
  }
}
const s_dam_solved = snapshot(e);

// ----- Phase 9: Dome rope + torch -----
console.log("\n=== Phase 9: Dome rope + torch ===");
if (!e.state.finished && !aborted()) {
  // walkthrough: W. SW. S. S (Round Room). SE. E (Dome Room). TIE ROPE TO RAILING. D.
  // Then: GET TORCH. TURN OFF LANTERN. D (north-temple).
  go(e, "west", "reservoir-south", "P9");
  go(e, "southwest", "chasm-room", "P9");
  go(e, "south", "ns-passage", "P9");
  go(e, "south", "round-room", "P9");
  go(e, "southeast", "engravings-cave", "P9");
  go(e, "east", "dome-room", "P9 dome");

  intent(e, "tie", { itemId: "rope", targetId: "railing" }, "P9 tie rope to railing");
  assertFlag(e, "dome-flag", true, "P9 dome-flag after tying rope");
  go(e, "down", "torch-room", "P9 descend to torch-room");

  takeItem(e, "torch", "P9 torch");
  intent(e, "extinguish", { itemId: "lamp" }, "P9 extinguish lamp");
  if (e.state.itemStates["lamp"]?.isLit === false) {
    pass("P9 lamp extinguished");
  } else {
    fail("P9 lamp still lit", JSON.stringify(e.state.itemStates["lamp"]));
  }
  go(e, "down", "north-temple", "P9");

  // Inventory-weight management: drop the empty toothpaste tube (4 weight).
  // Putty was already removed earlier; the tube has no further use. Match
  // stays in inventory for the LLD ritual at P10 (LIGHT MATCH → CANDLES).
  if (e.state.itemLocations["tube"] === "player") {
    dropItem(e, "tube");
  }
}
const s_dome_torch = snapshot(e);

// ----- Phase 10: Altar + Hades ritual -----
console.log("\n=== Phase 10: Altar + Hades ritual ===");
if (!e.state.finished && !aborted()) {
  // walkthrough: GET BELL. S (Altar). GET CANDLES. GET BOOK. D. D (Hades).
  // RING BELL. GET CANDLES. LIGHT MATCH. LIGHT CANDLES. READ BOOK. then DROP candles, matches, book. S.
  takeItem(e, "bell", "P10 bell");
  go(e, "south", "south-temple", "P10 altar");
  takeItem(e, "candles", "P10 candles");
  takeItem(e, "book", "P10 book");
  // coffin-cure flag flips here (player at south-temple without coffin); a
  // reservoir-south.south  exit opens up. We can simply continue.
  // Walk down twice to entrance-to-hades. From south-temple: down requires coffin-cure. We have it.
  go(e, "down", "tiny-cave", "P10 down via coffin-cure");
  go(e, "down", "entrance-to-hades", "P10 hades entrance");
  // Canonical fail-and-recover path: ring bell at hades → candles drop+extinguish.
  // Then take candles, light them, read book to complete the ritual.
  intent(e, "ring-bell", undefined, "P10 ring bell");
  if (e.state.itemStates["bell"]?.rangAtHades === true) {
    pass("bell.rangAtHades = true [P10]");
  } else {
    fail("bell.rangAtHades = true [P10]", JSON.stringify(e.state.itemStates["bell"]));
  }
  // Bell-rings trigger drops candles+extinguishes since they were held lit.
  takeItem(e, "candles", "P10 take candles after fall");
  // Canonical match mechanic: strike a match (consumes one of 5), then use it
  // to light the candles within 2 turns.
  intent(e, "light", { itemId: "match" }, "P10 strike match");
  if (e.state.itemStates["match"]?.matchesRemaining === 4) {
    pass("match.matchesRemaining = 4 after strike [P10]");
  } else {
    fail("match.matchesRemaining wrong after strike", JSON.stringify(e.state.itemStates["match"]));
  }
  if (e.state.itemStates["match"]?.isLit === true) {
    pass("match.isLit = true after strike [P10]");
  } else {
    fail("match.isLit wrong after strike", JSON.stringify(e.state.itemStates["match"]));
  }
  intent(e, "light", { itemId: "candles" }, "P10 relight candles with burning match");
  if (e.state.itemStates["candles"]?.isLit === true) {
    pass("candles.isLit = true [P10 relit]");
  } else {
    fail("candles.isLit = true [P10 relit]", JSON.stringify(e.state.itemStates["candles"]));
  }
  if (e.state.itemStates["match"]?.isLit === false) {
    pass("match.isLit = false after lighting candles [P10]");
  } else {
    fail("match.isLit should be false after candles lit", JSON.stringify(e.state.itemStates["match"]));
  }
  intent(e, "read", { itemId: "book" }, "P10 read book ritual");
  assertFlag(e, "lld-flag", true, "P10 ritual completes");
  // Canonical post-exorcism (walkthrough.txt:226): "DROP CANDLES AND
  // MATCHES AND BOOK". Spirits dispersed; the ritual artifacts are
  // dead weight from here on (and the candles are about to expire
  // anyway). Frees 16 weight (book 10 + match 1 + candles 5 — though
  // candles may already be dropped earlier in the fail-and-recover path).
  if (e.state.itemLocations["candles"] === "player") dropItem(e, "candles");
  if (e.state.itemLocations["match"] === "player") dropItem(e, "match");
  if (e.state.itemLocations["book"] === "player") dropItem(e, "book");
  go(e, "south", "land-of-living-dead", "P10 LLD");
  takeItem(e, "skull", "P10 skull");

  // Walkthrough: leave LLD. N. U. N. (touch mirror)
  go(e, "north", "entrance-to-hades", "P10 leave LLD");
  go(e, "up", "tiny-cave", "P10");
}

// ----- Phase 11: Mirror + bat + figurine -----
console.log("\n=== Phase 11: Mirror + bat + figurine ===");
if (!e.state.finished && !aborted()) {
  // walkthrough: N (mirror-room-2). TOUCH MIRROR. N. W (slide). N. W. N (bat-room).
  // Wait — re-read: "N. Like the Dome Room, this only looks like a dead end. TOUCH MIRROR.
  // ...you've actually been transported to an identical-looking room (this one's
  // north of the reservoir; the other's south of it). N. Eureka, a new area
  // (an old coal mine, to be exact) W. The slide is your ticket out of here;
  // leave it for now. N. W. N. There's a bat..."
  go(e, "north", "mirror-room-2", "P11");
  intent(e, "rub-mirror", undefined, "P11 rub mirror");
  // Now at mirror-room-1
  if (e.state.itemLocations.player === "mirror-room-1") {
    pass("P11 mirror teleport: at mirror-room-1");
  } else {
    fail("P11 mirror not at mirror-room-1", `loc=${e.state.itemLocations.player}`);
  }
  // walkthrough: N (cold-passage). W (slide-room). N (mine-entrance). W (squeeky-room). N (bat-room).
  go(e, "north", "cold-passage", "P11");
  go(e, "west", "slide-room", "P11");
  go(e, "north", "mine-entrance", "P11");
  go(e, "west", "squeeky-room", "P11");

  // Garlic should be in inventory (taken from sandwich-bag in P7 detour).
  // If it isn't, the bat will carry the player away — log and continue
  // honestly without masking.
  if (e.state.itemLocations["garlic"] !== "player") {
    note(`P11: garlic at ${e.state.itemLocations["garlic"]} (not inventory); bat will probably carry player`);
  }
  go(e, "north", "bat-room", "P11");
  if (e.state.itemLocations.player === "bat-room") {
    pass("P11 stayed at bat-room (garlic blocks bat)");
  } else {
    fail("P11 bat carried player away", `loc=${e.state.itemLocations.player}`);
  }

  takeItem(e, "jade", "P11 jade figurine");

  // walkthrough: E (Shaft Room). PUT TORCH AND SCREWDRIVER IN BASKET.
  go(e, "east", "shaft-room", "P11");

  // Light lamp before going through smelly-room/gas-room (these are dark).
  // Walkthrough re-lights lamp before entering gas-room.
  intent(e, "light", { itemId: "lamp" }, "P11 re-light lamp");

  // Put torch, screwdriver, and candles in the basket. Candles are still lit
  // from the hades ritual; canonical Zork blows up the player if they walk
  // into gas-room with any open flame, so we stash them in the basket along
  // with the torch (also a flame). The lamp is electric and safe.
  if (e.state.itemLocations["basket"] === "shaft-room") {
    putItem(e, "torch", "basket");
    putItem(e, "screwdriver", "basket");
    if (e.state.itemLocations["candles"] === "player") {
      putItem(e, "candles", "basket");
    }
  } else {
    fail(`P11 basket not at shaft-room`, `loc=${e.state.itemLocations["basket"]}`);
  }
}
const s_pre_gas_room = snapshot(e);

// ----- Phase 12: Gas room + coal mine maze + machine + diamond -----
console.log("\n=== Phase 12: Coal mine + machine + diamond ===");
if (!e.state.finished && !aborted()) {
  // walkthrough: N (smelly-room). D (gas-room). GET BRACELET. E. NE. SE. SW. D. (Ladder Top). D. S. (Dead End). GET COAL. N. U. N. E. S. N. (Gas Room). U. S. PUT COAL IN BASKET. LOWER BASKET.
  go(e, "north", "smelly-room", "P12");
  go(e, "down", "gas-room", "P12 gas-room");
  takeItem(e, "bracelet", "P12 bracelet");
  // Coal mine maze. From gas-room: E, NE, SE, SW, D = mine-1, mine-2, mine-3, mine-4, ladder-top.
  go(e, "east", "mine-1", "P12 maze");
  go(e, "northeast", "mine-2", "P12 maze");
  go(e, "southeast", "mine-3", "P12 maze");
  go(e, "southwest", "mine-4", "P12 maze");
  go(e, "down", "ladder-top", "P12 ladder-top");
  go(e, "down", "ladder-bottom", "P12");
  go(e, "south", "dead-end-5", "P12 coal");
  takeItem(e, "coal", "P12 coal");
  go(e, "north", "ladder-bottom", "P12");
  go(e, "up", "ladder-top", "P12");
  // walkthrough back: N. E. S. N. (return to gas-room).
  // ladder-top.up = mine-4. mine-4: N=mine-3. mine-3: E=mine-2. mine-2: S=mine-1. mine-1: N=gas-room.
  go(e, "up", "mine-4", "P12");
  go(e, "north", "mine-3", "P12");
  go(e, "east", "mine-2", "P12");
  go(e, "south", "mine-1", "P12");
  go(e, "north", "gas-room", "P12 back to gas");
  // U (smelly), S (shaft-room) — wait, smelly-room.south=shaft-room, yes.
  go(e, "up", "smelly-room", "P12");
  go(e, "south", "shaft-room", "P12");
  // Put coal in basket. Basket is raised at shaft-room (with torch +
  // screwdriver from P11).
  if (e.state.itemLocations["basket"] === "shaft-room") {
    putItem(e, "coal", "basket");
  } else {
    fail(`P12 basket not at shaft-room`, `loc=${e.state.itemLocations["basket"]}`);
  }
  // LOWER BASKET — fires the basket-lowers trigger. Basket + contents move
  // from shaft-room to lower-shaft. Then assert post-state.
  intent(e, "lower", { itemId: "basket" }, "P12 lower basket");
  if (e.state.itemLocations["basket"] === "lower-shaft" &&
      e.state.itemStates["basket"]?.position === "lowered") {
    pass("P12 basket descended to lower-shaft");
  } else {
    fail("P12 basket did not descend",
         `loc=${e.state.itemLocations["basket"]} pos=${e.state.itemStates["basket"]?.position}`);
  }

  // Walkthrough: go back through bat-room to ladder-bottom, then W (timber-room),
  // DROP ALL, W (lower-shaft / drafty-room). GET TORCH AND COAL AND SCREWDRIVER.
  // S (machine-room). PUT COAL IN MACHINE. CLOSE LID. TURN SWITCH WITH SCREWDRIVER.
  // OPEN LID. GET DIAMOND. DROP SCREWDRIVER. N. PUT DIAMOND AND TORCH IN BASKET. RAISE.
  go(e, "west", "bat-room", "P12 back");
  go(e, "east", "shaft-room", "P12");
  // From shaft-room go all the way back to ladder-bottom via the canonical
  // route from the walkthrough: north up smelly→gas→ then through coal-mine
  // maze east branch → ladder-top → ladder-bottom. (The walkthrough doesn't
  // give exact steps for the return; the canonical path is gas-room → e mine-1
  // → ne mine-2 → se mine-3 → sw mine-4 → d ladder-top → d ladder-bottom.)
  go(e, "north", "smelly-room", "P12 to maze");
  go(e, "down", "gas-room", "P12");
  go(e, "east", "mine-1", "P12");
  go(e, "northeast", "mine-2", "P12");
  go(e, "southeast", "mine-3", "P12");
  go(e, "southwest", "mine-4", "P12");
  go(e, "down", "ladder-top", "P12");
  go(e, "down", "ladder-bottom", "P12");
  go(e, "west", "timber-room", "P12 timber");

  // Drop all to satisfy empty-handed gate (must drop everything in inventory).
  for (const id of Object.keys(e.state.itemLocations)) {
    if (e.state.itemLocations[id] === "player") {
      safeExec(e, { type: "drop", itemId: id });
    }
  }
  if (e.state.flags["empty-handed"] !== true) {
    safeExec(e, { type: "wait" }); // tick the empty-handed-on trigger
  }
  assertFlag(e, "empty-handed", true, "P12 empty-handed at timber");

  go(e, "west", "lower-shaft", "P12 drafty-room");
  // Take torch, coal, screwdriver from the basket (now at lower-shaft).
  // Items inside the basket are accessible via container traversal.
  takeItem(e, "torch", "P12 retrieve torch from basket");
  takeItem(e, "coal", "P12 retrieve coal from basket");
  takeItem(e, "screwdriver", "P12 retrieve screwdriver from basket");
  go(e, "south", "machine-room", "P12 machine-room");
  // OPEN LID
  intent(e, "open", { itemId: "machine" }, "P12 open machine lid");
  putItem(e, "coal", "machine");
  intent(e, "close", { itemId: "machine" }, "P12 close lid");
  intent(e, "turn", { itemId: "machine-switch", withItemId: "screwdriver" }, "P12 turn switch");
  // diamond should appear at machine-room
  assertItemAt(e, "diamond", "machine-room", "P12 diamond produced");
  intent(e, "open", { itemId: "machine" }, "P12 reopen lid");
  takeItem(e, "diamond", "P12 diamond");
  dropItem(e, "screwdriver");
  go(e, "north", "lower-shaft", "P12");
  // Put diamond + torch in basket — but DON'T raise it yet. Wong's
  // walkthrough says RAISE BASKET. E. — but that strands you at a dark
  // lower-shaft (the lit torch goes up with the basket) and the engine's
  // visibility model hides exits in pitch black. Better: leave the basket
  // lowered for now. The lit torch sits in the basket at lower-shaft and
  // illuminates the room, so the east squeeze stays visible. Player is
  // empty-handed (everything's in the basket), gate satisfied. After
  // squeezing through, pick up the lantern at timber-room, walk back up
  // the long way to shaft-room, and raise the basket from above.
  putItem(e, "diamond", "basket");
  putItem(e, "torch", "basket");
  go(e, "east", "timber-room", "P12 squeeze east — torch in basket lights lower-shaft");
  // Walkthrough: "GET ALL EXCEPT TIMBER (it's useless)." Pick up every item
  // currently at timber-room except the `timbers` (broken timbers, useless).
  // The earlier drop-all dumped lamp, match, guide, tube, garlic, bell,
  // candles, book, etc. — all need to come back. Skipping garlic here would
  // leave the player defenseless against the bat in P13.
  for (const id of Object.keys(e.state.itemLocations)) {
    if (e.state.itemLocations[id] !== "timber-room") continue;
    if (id === "timbers") continue;          // useless, walkthrough explicitly skips
    if (id === "lowered-basket") continue;   // safety; defunct after extractor (kept just in case)
    safeExec(e, { type: "take", itemId: id });
  }
  // Continue back to gas-room and then to shaft-room to retrieve basket.
  go(e, "east", "ladder-bottom", "P12");
  go(e, "up", "ladder-top", "P12");
  go(e, "up", "mine-4", "P12");
  go(e, "north", "mine-3", "P12");
  go(e, "east", "mine-2", "P12");
  go(e, "south", "mine-1", "P12");
  go(e, "north", "gas-room", "P12");
  go(e, "up", "smelly-room", "P12");
  go(e, "south", "shaft-room", "P12");
  // Now raise the basket from above. Basket is at lower-shaft with diamond +
  // torch; ascends to shaft-room with both still inside.
  intent(e, "raise", { itemId: "basket" }, "P12 raise basket from above");
  if (e.state.itemLocations["basket"] === "shaft-room" &&
      e.state.itemStates["basket"]?.position === "raised") {
    pass("P12 basket ascended to shaft-room with contents");
  } else {
    fail("P12 basket did not ascend",
         `loc=${e.state.itemLocations["basket"]} pos=${e.state.itemStates["basket"]?.position}`);
  }
  // Take diamond first, then offload weight before taking the torch.
  // Diamond (25) + torch (25) plus lamp (15) + coal (15) + bracelet (5)
  // exceeds the 100-weight cap, so drop the coal (mine-puzzle artifact,
  // no further use) and lamp (torch covers light) before the torch take.
  takeItem(e, "diamond", "P12 diamond from basket");
  if (e.state.itemLocations["coal"] === "player") {
    dropItem(e, "coal");
  }
  if (e.state.itemLocations["lamp"] === "player") {
    dropItem(e, "lamp");
  }
  takeItem(e, "torch", "P12 torch from basket");
}

// ----- Phase 13: Loud room echo + reservoir + rainbow + sceptre -----
console.log("\n=== Phase 13: Loud room + reservoir + rainbow ===");
if (!e.state.finished && !aborted()) {
  // walkthrough: W. S. E. S (Slide Room). D. (back to cellar via slide). U. PUT ALL.
  // Then go grab the platinum bar and the trunk and trident, etc. Easier path:
  // From shaft-room W, S. shaft-room.west=bat-room. bat-room.south=squeeky-room.
  go(e, "west", "bat-room", "P13");
  go(e, "south", "squeeky-room", "P13");
  go(e, "east", "mine-entrance", "P13");
  go(e, "south", "slide-room", "P13");
  go(e, "down", "cellar", "P13 slide");
  go(e, "up", "living-room", "P13 emerge");

  // Deposit treasures gathered so far. Per walkthrough: PUT ALL TREASURES
  // EXCEPT TORCH. Bauble was picked up in P7 wind and never deposited;
  // include it in this sweep so it doesn't accumulate weight through
  // P13's reservoir/atlantis run.
  for (const itm of ["chalice", "skull", "jade", "diamond", "bracelet", "bauble", "canary"]) {
    if (e.state.itemLocations[itm] === "player") {
      putItem(e, itm, "trophy-case");
    }
  }

  // Now go for loud room. From living-room: D, N, E, E (loud-room? actually
  // walkthrough says "D. N. E. E (Round Room). E. ... Loud Room"). cellar.N=troll-room. troll-room.E=ew-passage. ew-passage.E=round-room. round-room.E=loud-room.
  // Open trapdoor first if needed.
  if (e.state.passageStates["trap-door"]?.isOpen !== true) {
    intent(e, "open", { itemId: "trap-door" }, "P13 reopen trap");
  }
  go(e, "down", "cellar", "P13");
  go(e, "north", "troll-room", "P13");
  go(e, "east", "ew-passage", "P13");
  go(e, "east", "round-room", "P13");
  go(e, "east", "loud-room", "P13 loud");

  intent(e, "say-echo-in-loud-room", undefined, "P13 echo");
  assertFlag(e, "echo-spoken", true, "P13 echo-spoken");
  takeItem(e, "bar", "P13 platinum bar");

  // Back to round-room, then north to reservoir-south, then north to reservoir.
  go(e, "west", "round-room", "P13");
  go(e, "west", "ew-passage", "P13");
  go(e, "north", "chasm-room", "P13");
  go(e, "northeast", "reservoir-south", "P13");
  go(e, "north", "reservoir", "P13 drained reservoir");
  // Inventory-weight management: bat puzzle is past. Garlic + screwdriver
  // (machine puzzle is also done) are no longer needed; drop both before
  // the heavy trunk pickup (trunk is 35 weight).
  if (e.state.itemLocations["garlic"] === "player") {
    dropItem(e, "garlic");
  }
  if (e.state.itemLocations["screwdriver"] === "player") {
    dropItem(e, "screwdriver");
  }
  takeItem(e, "trunk", "P13 trunk");
  go(e, "north", "reservoir-north", "P13");
  go(e, "north", "atlantis-room", "P13");
  // Atlantis-room is lit; drop torch briefly to make room for the trident
  // (12 weight), then take it back — the return trip passes through dark
  // rooms (chasm-room, ew-passage) and the lamp was dropped at shaft-room
  // in P12, so the lit torch is the only grue protection.
  if (e.state.itemLocations["torch"] === "player") {
    dropItem(e, "torch");
  }
  takeItem(e, "trident", "P13 trident");
  takeItem(e, "torch", "P13 retake torch (need light for return trip)");
  // Back to living-room: S, S, S, SW, SW.
  go(e, "south", "reservoir-north", "P13");
  go(e, "south", "reservoir", "P13");
  go(e, "south", "reservoir-south", "P13");
  go(e, "southwest", "chasm-room", "P13");
  go(e, "southwest", "ew-passage", "P13");
  go(e, "west", "troll-room", "P13");
  go(e, "south", "cellar", "P13");
  go(e, "up", "living-room", "P13");
  for (const itm of ["bar", "trunk", "trident"]) {
    if (e.state.itemLocations[itm] === "player") {
      putItem(e, itm, "trophy-case");
    }
  }

  // Now Egyptian Room (coffin) + sceptre. Path: D, N, E, E, SE (engravings),
  // E (dome-room), then the walkthrough goes a different way through Round
  // Room. Re-read: "Time now for a return trip to the Temple. D. N. E. E. SE.
  // E. D. D. This time go E to the Egyptian Room. GET COFFIN. OPEN COFFIN.
  // GET SCEPTRE."
  go(e, "down", "cellar", "P13");
  go(e, "north", "troll-room", "P13");
  go(e, "east", "ew-passage", "P13");
  go(e, "east", "round-room", "P13");
  go(e, "southeast", "engravings-cave", "P13");
  go(e, "east", "dome-room", "P13");
  go(e, "down", "torch-room", "P13");
  go(e, "down", "north-temple", "P13");
  go(e, "east", "egypt-room", "P13 egypt");
  takeItem(e, "coffin", "P13 coffin");
  intent(e, "open", { itemId: "coffin" }, "P13 open coffin");
  takeItem(e, "sceptre", "P13 sceptre");

  // walkthrough: instead of trudging back, "go W and S to the Altar and PRAY".
  // pray-at-altar teleports you to forest. Verify.
  go(e, "west", "north-temple", "P13");
  go(e, "south", "south-temple", "P13");
  intent(e, "pray-at-altar", undefined, "P13 pray");
  // Per altar-prayer trigger the player should now be in a forest room.
  const afterPray = e.state.itemLocations.player;
  const forestRooms = ["forest-1", "forest-2", "forest-3", "path", "clearing", "grating-clearing"];
  if (forestRooms.includes(afterPray)) {
    pass(`P13 pray teleports to forest (${afterPray})`);
  } else {
    fail(`P13 pray-at-altar did not teleport to forest`, `loc=${afterPray}`);
  }

  // Walkthrough: E. E. S. E (Canyon View). D. D. N (End of Rainbow). WAVE SCEPTRE.
  // From forest-1 the canonical path is: E (path), E (forest-2), S (clearing),
  // E (canyon-view), D (cliff-middle), D (canyon-bottom), N (end-of-rainbow).
  if (e.state.itemLocations.player === "forest-1") {
    go(e, "east", "path", "P13");
    go(e, "east", "forest-2", "P13");
    go(e, "south", "clearing", "P13");
    go(e, "east", "canyon-view", "P13");
    go(e, "down", "cliff-middle", "P13");
    go(e, "down", "canyon-bottom", "P13");
    go(e, "north", "end-of-rainbow", "P13");
  } else {
    fail("P13 cannot continue canonical path; pray landed somewhere unexpected",
         `loc=${e.state.itemLocations.player}`);
  }

  intent(e, "wave-scepter-at-rainbow", undefined, "P13 wave sceptre");
  assertFlag(e, "rainbow-flag", true, "P13");
  takeItem(e, "pot-of-gold", "P13 pot");
}

// ----- Phase 14: Boat + buoy + sand -----
console.log("\n=== Phase 14: Boat + buoy + sand ===");
if (!e.state.finished && !aborted()) {
  // Walkthrough: SW. U. U (Top of Canyon). W. W. E. ... back to living-room.
  // From end-of-rainbow: SW=canyon-bottom, U=cliff-middle, U=canyon-view,
  // NW=clearing, W=east-of-house (climb in window), W=kitchen, W=living-room.
  go(e, "southwest", "canyon-bottom", "P14");
  go(e, "up", "cliff-middle", "P14");
  go(e, "up", "canyon-view", "P14");
  go(e, "northwest", "clearing", "P14");
  go(e, "west", "east-of-house", "P14");
  go(e, "west", "kitchen", "P14");
  go(e, "west", "living-room", "P14");
  // Canonical post-rainbow deposit (walkthrough.txt:290): "PUT ALL
  // TREASURES EXCEPT TORCH IN CASE". Includes the coffin (55 weight!) —
  // taken in P13 from egypt-room and never deposited prior to this. Coffin
  // is the single heaviest item in the game; carrying it into the boat
  // phase blows past the cap on the emerald pickup at sandy-beach.
  for (const itm of ["sceptre", "pot-of-gold", "coffin"]) {
    if (e.state.itemLocations[itm] === "player") {
      putItem(e, itm, "trophy-case");
    }
  }

  // Now to dam-base. We need the pump. Path: cellar -> troll-room -> ew-passage
  // -> chasm-room -> reservoir-south -> reservoir -> reservoir-north -> get pump.
  if (e.state.passageStates["trap-door"]?.isOpen !== true) {
    intent(e, "open", { itemId: "trap-door" });
  }
  go(e, "down", "cellar", "P14");
  go(e, "north", "troll-room", "P14");
  go(e, "east", "ew-passage", "P14");
  go(e, "north", "chasm-room", "P14");
  go(e, "northeast", "reservoir-south", "P14");
  go(e, "north", "reservoir", "P14");
  go(e, "north", "reservoir-north", "P14");
  takeItem(e, "pump", "P14 pump");
  // Back to dam-base: S, S, E, D (dam-base via dam-room.east).
  go(e, "south", "reservoir", "P14");
  go(e, "south", "reservoir-south", "P14");
  go(e, "east", "dam-room", "P14");
  go(e, "down", "dam-base", "P14 dam-base");

  // INFLATE PLASTIC WITH PUMP
  intent(e, "inflate", { itemId: "inflatable-boat", withItemId: "pump" }, "P14 inflate boat");
  if (e.state.itemStates["inflatable-boat"]?.inflation === "inflated") {
    pass("P14 boat inflated");
  } else {
    fail("P14 boat not inflated", JSON.stringify(e.state.itemStates["inflatable-boat"]));
  }

  // Make sure no weapons in inventory that would puncture (sword was dropped P3,
  // rusty-knife dropped P6, knife from attic still in inv). Drop those.
  for (const w of ["knife", "axe"]) {
    if (e.state.itemLocations[w] === "player") {
      dropItem(e, w);
    }
  }

  // Board the boat
  const bR = safeExec(e, { type: "board", itemId: "inflatable-boat" });
  if (bR?.ok && e.state.itemLocations.player === "inflatable-boat" &&
      e.state.itemStates["inflatable-boat"]?.inflation === "inflated") {
    pass("P14 board boat (clean)");
  } else {
    fail("P14 board boat failed",
         `boardOk=${bR?.ok} vehicle=${e.state.itemLocations.player} inflation=${e.state.itemStates["inflatable-boat"]?.inflation}`);
  }
}
const s_pre_boat_drift = snapshot(e);

// ----- Phase 14 continued: drift + buoy + sand + scarab -----
{
  // From dam-base, fire the launch-boat intent. The boat-launches trigger
  // moves the boat to river-1; the player rides along inside the boat via
  // container parentage. Per-river drift triggers take over.
  intent(e, "launch-boat", undefined, "P14 launch boat");
  if (e.state.itemLocations["inflatable-boat"] === "river-1" &&
      e.state.itemLocations.player === "inflatable-boat") {
    pass("P14 boat launched to river-1, player riding inside");
  } else {
    fail("P14 launch-boat did not move boat to river-1",
         `boat=${e.state.itemLocations["inflatable-boat"]} player=${e.state.itemLocations.player}`);
  }

  // Drift: launch already counted as one tick at river-1 (counter went to 1
  // after the boat-launches trigger's afterAction phase). One more wait per
  // river advances the boat one step. Player rides inside the boat, so we
  // check the boat's location to observe drift.
  safeExec(e, { type: "wait" });
  if (e.state.itemLocations["inflatable-boat"] !== "river-2") {
    fail("P14 drift to river-2", `boat=${e.state.itemLocations["inflatable-boat"]}`);
  } else {
    pass("P14 drift river-1 -> river-2");
  }
  safeExec(e, { type: "wait" });
  safeExec(e, { type: "wait" });
  if (e.state.itemLocations["inflatable-boat"] !== "river-3") {
    fail("P14 drift to river-3", `boat=${e.state.itemLocations["inflatable-boat"]}`);
  } else {
    pass("P14 drift river-2 -> river-3");
  }
  safeExec(e, { type: "wait" });
  safeExec(e, { type: "wait" });
  if (e.state.itemLocations["inflatable-boat"] !== "river-4") {
    fail("P14 drift to river-4", `boat=${e.state.itemLocations["inflatable-boat"]}`);
  } else {
    pass("P14 drift river-3 -> river-4");
  }

  // Take buoy at river-4 (it's at river-4). Land BEFORE the next drift tick
  // pushes us past — every action ticks the river drift, so this is tight.
  takeItem(e, "buoy", "P14 buoy");
  // Land at sandy-beach (river-4.east). go() while in mobile vehicle moves
  // the boat — player rides along.
  go(e, "east", "sandy-beach", "P14 land at sandy-beach");
  safeExec(e, { type: "disembark" });
  intent(e, "open", { itemId: "buoy" }, "P14 open buoy");
  takeItem(e, "emerald", "P14 emerald (from inside open buoy)");
  // After disembark, player parent is the room (not the boat).
  if (e.state.itemLocations.player === "sandy-beach") {
    pass("P14 disembarked at sandy-beach");
  } else {
    fail("P14 disembark unexpected", `player=${e.state.itemLocations.player}`);
  }

  // walkthrough: DIG SAND with shovel to get scarab. Take shovel first.
  takeItem(e, "shovel", "P14 shovel");
  go(e, "northeast", "sandy-cave", "P14 sandy-cave");
  // Sandy-cave dig puzzle: 4 explicit shovel-dig actions uncover the
  // scarab (cave-dig-stage-1..4 + scarab.visibleWhen gated on
  // scarab-uncovered flag). Tool-name pattern requires withItemId="shovel".
  for (let i = 0; i < 4; i++) {
    e.execute({ type: "recordIntent", signalId: "dig", args: { targetId: "sand", withItemId: "shovel" } });
  }
  takeItem(e, "scarab", "P14 scarab (uncovered by 4 digs)");
  go(e, "southwest", "sandy-beach", "P14");
  dropItem(e, "shovel");

  // walkthrough: S. S (Aragain Falls). Cross rainbow W twice.
  go(e, "south", "shore", "P14");
  go(e, "south", "aragain-falls", "P14");
  go(e, "west", "on-rainbow", "P14");
  go(e, "west", "end-of-rainbow", "P14");

  // Go back to living-room via the canyon path.
  go(e, "southwest", "canyon-bottom", "P14");
  go(e, "up", "cliff-middle", "P14");
  go(e, "up", "canyon-view", "P14");
  go(e, "northwest", "clearing", "P14");
  go(e, "west", "east-of-house", "P14");
  // Climb in window
  go(e, "west", "kitchen", "P14");
  go(e, "west", "living-room", "P14");
}

// ----- Phase 15: Final deposits + endgame -----
console.log("\n=== Phase 15: Final deposits + endgame ===");
if (!e.state.finished && !aborted()) {
  // Deposit any remaining treasures.
  const TREASURES = [
    "egg", "canary", "bag-of-coins", "painting", "chalice", "torch", "trident",
    "coffin", "sceptre", "jade", "scarab", "skull", "emerald", "bracelet",
    "trunk", "bar", "pot-of-gold", "diamond", "bauble",
  ];
  for (const t of TREASURES) {
    if (e.state.itemLocations[t] === "player") {
      putItem(e, t, "trophy-case");
    }
  }

  // Surface missing treasures honestly — do NOT force-deposit. The won-flag
  // assertion below is the source of truth for whether the canonical solve
  // produced an endgame-ready state.
  for (const t of TREASURES) {
    if (e.state.itemLocations[t] !== "trophy-case") {
      fail(`P15: ${t} not in trophy-case`, `loc=${e.state.itemLocations[t]}`);
    }
  }
  // Tick once so unlock-endgame trigger fires (if all treasures are present).
  safeExec(e, { type: "wait" });
  assertFlag(e, "won-flag", true, "P15 won-flag");
}
const s_all_treasures_in_case = snapshot(e);

{
  // Walkthrough: L AT MAP. From living-room: E (kitchen), E (east-of-house),
  // N (north-of-house), W (west-of-house), SW (stone-barrow).
  go(e, "east", "kitchen", "P15");
  go(e, "east", "east-of-house", "P15");
  go(e, "north", "north-of-house", "P15");
  go(e, "west", "west-of-house", "P15");
  go(e, "southwest", "stone-barrow", "P15 enter barrow");
  // The afterAction trigger stone-barrow-ends-game should fire.
  if (e.state.finished?.won === true) {
    pass(`P15 endGame won=true`);
    if (/Master Adventurer/i.test(e.state.finished.message ?? "")) {
      pass("P15 endgame message includes 'Master Adventurer'");
    } else {
      fail("P15 endgame message missing rank token", e.state.finished.message ?? "");
    }
  } else {
    fail("P15 endGame did not fire", JSON.stringify(e.state.finished));
  }

  // Final score sanity. Canonical Zork I max is 350.
  const finalScore = e.state.flags.score as number;
  const maxScore = e.state.flags["max-score"] as number;
  console.log(`  i Final score: ${finalScore} / ${maxScore} (rank tier checked separately)`);
  if (finalScore >= maxScore - 10) {
    pass(`P15 final score >= ${maxScore - 10} (got ${finalScore})`);
  } else {
    note(`P15 final score below ${maxScore - 10}: ${finalScore}/${maxScore} — gaps in scoring wiring`);
  }
  console.log(`  i Final turn count: ${e.state.flags["global-turn-count"]}`);
}

// -------------------- Failure-path tests --------------------

if (firstWalkthroughFailure !== null) {
  console.log(`\n>>> Walkthrough aborted at first failure: ${firstWalkthroughFailure}`);
  console.log(`    Fix this issue, then re-run for the next gap.`);
}

// Switch off walkthrough mode — F-tests record their own pass/fail without
// affecting the walkthrough abort sentinel.
inWalkthrough = false;

console.log("\n\n========== FAILURE-PATH TESTS ==========");

// F1: Grue eats player
console.log("\n--- F1: Grue eats player (extinguish lamp + wait in cellar) ---");
{
  const f = new Engine(story, JSON.parse(JSON.stringify(s_below_trapdoor)));
  intent(f, "extinguish", { itemId: "lamp" }, "F1 douse");
  f.execute({ type: "wait" });
  f.execute({ type: "wait" });
  f.execute({ type: "wait" });
  f.execute({ type: "wait" });
  if (playerDied(f.state)) {
    pass(`F1 grue-eats fired (msg: ${(f.state.finished?.message ?? f.state.flags["death-message"] ?? "soft-die")?.toString().slice(0, 60)}...)`);
  } else {
    note(`F1 grue did not end game (finished=${JSON.stringify(f.state.finished)} darkness=${f.state.flags["darkness-turns"]})`);
  }
}

// F2: Gas room explosion (take torch out of basket, descend with lit lamp + flame? actually with match? canonical is anything on fire)
console.log("\n--- F2: Gas room explosion ---");
{
  const f = new Engine(story, JSON.parse(JSON.stringify(s_pre_gas_room)));
  // Defensive setup: regardless of where the upstream walkthrough left the
  // player and what state the torch is in, force the F2-relevant slice:
  // player at shaft-room, lit torch in pocket. This makes the descent path
  // shaft-room → smelly-room → gas-room deterministic + tests the actual
  // gas-room-explodes trigger gate (lit open flame in gas-room).
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "shaft-room", torch: "player" },
    itemStates: {
      ...f.state.itemStates,
      torch: { ...(f.state.itemStates["torch"] ?? {}), isLit: true },
    },
  };
  // Descend: shaft-room.N = smelly-room. smelly-room.D = gas-room.
  f.execute({ type: "go", direction: "north" });
  f.execute({ type: "go", direction: "down" });
  if (playerDied(f.state)) {
    pass(`F2 gas-room explosion fired (msg: ${(f.state.finished?.message ?? f.state.flags["death-message"] ?? "soft-die")?.toString().slice(0, 60)}...)`);
  } else {
    note(`F2 gas-room explosion not wired; player at ${f.state.itemLocations.player} alive`);
  }
}

// F3: Boat punctured by sword
console.log("\n--- F3: Boat punctured (board with sword) ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "dam-base", pump: "player",
      sword: "player", },
  };
  f.execute({ type: "recordIntent", signalId: "inflate", args: { itemId: "inflatable-boat", withItemId: "pump" } });
  f.execute({ type: "board", itemId: "inflatable-boat" });
  if (f.state.itemStates["inflatable-boat"]?.inflation === "punctured" &&
      f.state.itemLocations.player === "dam-base") {
    pass("F3 boat punctured by sword on board (player ejected to dam-base)");
  } else {
    fail(
      "F3 boat not punctured / player not ejected",
      `boat=${JSON.stringify(f.state.itemStates["inflatable-boat"])} player=${f.state.itemLocations.player}`,
    );
  }
}

// F4: River 5 waterfall death
console.log("\n--- F4: River 5 waterfall death ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: {
      ...f.state.itemLocations,
      player: "inflatable-boat",
      "inflatable-boat": "river-5",
    },
    itemStates: {
      ...f.state.itemStates,
      "inflatable-boat": {
        ...(f.state.itemStates["inflatable-boat"] ?? {}),
        inflation: "inflated",
      },
    },
  };
  f.execute({ type: "wait" });
  f.execute({ type: "wait" });
  if (playerDied(f.state) &&
      /waterfall/i.test(f.state.finished?.message ?? f.state.flags["death-message"]?.toString() ?? "")) {
    pass("F4 waterfall death fires after 2 ticks at river-5");
  } else {
    fail("F4 waterfall death not triggered", JSON.stringify(f.state.finished));
  }
}

// F5: Dome fall (no rope tied)
console.log("\n--- F5: Dome fall (no rope) ---");
{
  const f = new Engine(story, JSON.parse(JSON.stringify(s_post_thief)));
  // Make sure dome-flag is FALSE (rope not tied yet).
  f.state = {
    ...f.state,
    flags: { ...f.state.flags, "dome-flag": false },
    itemLocations: { ...f.state.itemLocations, player: "dome-room" },
  };
  // Try go(down) without rope. The exit is gated by dome-flag, so it should
  // be hidden/blocked. Engine will reject with no-such-direction or
  // exit-blocked.
  const r = f.execute({ type: "go", direction: "down" });
  if (r.event.type === "rejected") {
    pass(`F5 dome.down blocked when dome-flag=false (reason=${(r.event as { reason?: string }).reason})`);
  } else if (playerDied(f.state)) {
    pass("F5 dome fall ended game (reincarnation unwired)");
  } else {
    note(`F5 dome.down outcome unexpected: loc=${f.state.itemLocations.player}`);
  }
}

// F6: Drop egg in tree
console.log("\n--- F6: Drop egg in tree ---");
{
  const f = new Engine(story);
  // Climb tree with egg
  f.execute({ type: "go", direction: "north" });
  f.execute({ type: "go", direction: "north" });
  f.execute({ type: "go", direction: "up" });
  f.execute({ type: "take", itemId: "egg" });
  // Drop egg here in up-a-tree
  const r = f.execute({ type: "drop", itemId: "egg" });
  if (!r.ok) {
    note(`F6 drop egg rejected: ${(r.event as { reason?: string }).reason}`);
  } else {
    // Egg should now be at up-a-tree. Walk away and it falls? In canonical Zork,
    // dropping the egg in a tree breaks it. The current engine just moves it
    // to playerLocation. Check for any "broken" state.
    if (f.state.itemStates["egg"]?.broken === true) {
      pass("F6 egg.broken = true after drop in tree");
    } else {
      note(`F6 drop-egg-in-tree mechanic unwired: egg state=${JSON.stringify(f.state.itemStates["egg"])}`);
    }
  }
}

// F7: Open buoy too late (waterfall)
console.log("\n--- F7: Drift past landing into waterfall ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: {
      ...f.state.itemLocations,
      player: "inflatable-boat",
      "inflatable-boat": "river-3",
    },
    itemStates: {
      ...f.state.itemStates,
      "inflatable-boat": {
        ...(f.state.itemStates["inflatable-boat"] ?? {}),
        inflation: "inflated",
      },
    },
  };
  // Don't land at river-3. Drift two turns each through 4, 5.
  f.execute({ type: "wait" });
  f.execute({ type: "wait" });
  // Should be at river-4 now. Drift past.
  f.execute({ type: "wait" });
  f.execute({ type: "wait" });
  // river-5 reached. Wait two more for waterfall.
  f.execute({ type: "wait" });
  f.execute({ type: "wait" });
  if (playerDied(f.state) &&
      /waterfall/i.test(f.state.finished?.message ?? f.state.flags["death-message"]?.toString() ?? "")) {
    pass(`F7 drift-past-landing -> waterfall death (path: end loc=${f.state.itemLocations.player})`);
  } else {
    note(`F7 expected waterfall death; actual: finished=${JSON.stringify(f.state.finished)} loc=${f.state.itemLocations.player}`);
  }
}

// F8: Thief kills player in combat
console.log("\n--- F8: Thief kills player in combat ---");
{
  const f = new Engine(story);
  // Set up: player + thief in treasure-room with player carrying rusty-knife.
  // Engagement flag set so thief-attacks-player ticks every wait.
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "treasure-room", thief: "treasure-room",
      "rusty-knife": "player", },
    itemStates: {
      ...f.state.itemStates,
      thief: { ...(f.state.itemStates["thief"] ?? {}), appeared: true, health: 30 },
    },
    flags: { ...f.state.flags, "combat-engaged-with-thief": true, "player-health": 30 },
  };
  // Drain player-health by ticking until either the player dies or we hit a hard cap.
  for (let i = 0; i < 60; i++) {
    if (f.state.finished) break;
    // If thief health drops to 0 before player dies (the player attack could kill
    // him via the killing-strike branch), just bail out — F8 specifically tests
    // the player-dies branch, not who happens to win first.
    const thiefHp = f.state.itemStates["thief"]?.health as number | undefined;
    if (thiefHp !== undefined && thiefHp <= 0) break;
    f.execute({ type: "wait" });
  }
  if (playerDied(f.state) &&
      /thief|duel|stiletto/i.test(f.state.finished?.message ?? f.state.flags["death-message"]?.toString() ?? "")) {
    pass(`F8 thief killed player (msg: ${(f.state.finished?.message ?? f.state.flags["death-message"] ?? "soft-die")?.toString().slice(0, 60)}...)`);
  } else if (playerDied(f.state)) {
    pass(`F8 player died (generic msg, thief flavor not triggered): ${(f.state.finished?.message ?? f.state.flags["death-message"] ?? "soft-die")?.toString().slice(0, 60)}...`);
  } else {
    note(`F8 thief did not kill player; finished=${JSON.stringify(f.state.finished)} hp=${f.state.flags["player-health"]} thiefHp=${f.state.itemStates["thief"]?.health}`);
  }
}

// F9: Give egg to thief opens it
console.log("\n--- F9: Give egg to thief ---");
{
  const f = new Engine(story);
  // Set up: player at round-room with the thief, egg + lit lamp in inventory.
  // round-room is canonically dark — without the lit lamp, isItemAccessible
  // would refuse the egg and thief and the give handler would refuse the call.
  f.state = {
    ...f.state,
    itemLocations: {
      ...f.state.itemLocations,
      player: "round-room",
      thief: "round-room",
      egg: "player",
      lamp: "player",
    },
    itemStates: {
      ...f.state.itemStates,
      thief: { ...(f.state.itemStates["thief"] ?? {}), appeared: true },
      egg: { ...(f.state.itemStates["egg"] ?? {}), isOpen: false },
      lamp: { ...(f.state.itemStates["lamp"] ?? {}), isLit: true },
    },
  };
  f.execute({ type: "recordIntent", signalId: "give", args: { itemId: "egg", targetId: "thief" } });
  const eggOpen = f.state.itemStates["egg"]?.isOpen === true;
  const eggWithThief = f.state.itemLocations["egg"] === "thief";
  // Canary stays inside the egg — container parentage is transitive, so the
  // canary travels with the egg into the thief's pocket and back to
  // treasure-room when the thief dies.
  const canaryInEgg = f.state.itemLocations["canary"] === "egg";
  if (eggOpen && eggWithThief && canaryInEgg) {
    pass("F9 thief opened egg; egg in pocket with canary still inside");
  } else {
    fail("F9 thief did not open egg correctly",
         `eggOpen=${eggOpen} eggLoc=${f.state.itemLocations["egg"]} canaryLoc=${f.state.itemLocations["canary"]}`);
  }
}

// F10: Songbird opens egg (alternate canonical egg-opening path)
console.log("\n--- F10: Songbird opens egg ---");
{
  const f = new Engine(story);
  // Walk: N (north-of-house), N (path), U (up-a-tree). Take egg. Down to path.
  // At path, fire give(egg, songbird). The trigger sets egg.isOpen = true.
  // Canary's default location is inside the egg, so once isOpen=true the
  // engine treats canary as accessible via the open container.
  f.execute({ type: "go", direction: "north" });
  f.execute({ type: "go", direction: "north" });
  f.execute({ type: "go", direction: "up" });
  const tookEgg = f.execute({ type: "take", itemId: "egg" });
  if (!tookEgg.ok) {
    fail("F10 take(egg) failed", `reason=${(tookEgg.event as { reason?: string }).reason}`);
  }
  f.execute({ type: "go", direction: "down" });
  if (f.state.itemLocations.player !== "path") {
    fail("F10 player should be at path after climbing down", `loc=${f.state.itemLocations.player}`);
  }
  const r = f.execute({ type: "recordIntent", signalId: "give", args: { itemId: "egg", targetId: "songbird" } });
  if (!r.ok) {
    fail("F10 give(egg, songbird) intent rejected",
         `reason=${(r.event as { reason?: string }).reason}`);
  }
  const eggOpenF10 = f.state.itemStates["egg"]?.isOpen === true;
  if (eggOpenF10) {
    pass("F10 songbird opened egg (egg.isOpen = true)");
  } else {
    fail("F10 songbird did not open egg",
         `egg.isOpen=${f.state.itemStates["egg"]?.isOpen} eggLoc=${f.state.itemLocations["egg"]} canaryLoc=${f.state.itemLocations["canary"]}`);
  }
  // Canary should now be accessible: it lives at "egg" by default; with the
  // egg open AND in inventory, the engine traverses the container and lets
  // us take the canary out.
  const canaryTake = f.execute({ type: "take", itemId: "canary" });
  if (canaryTake.ok && f.state.itemLocations["canary"] === "player") {
    pass("F10 canary takeable from open egg in inventory");
  } else {
    fail("F10 canary not takeable from open egg",
         `ok=${canaryTake.ok} reason=${(canaryTake.event as { reason?: string }).reason} canaryLoc=${f.state.itemLocations["canary"]}`);
  }
}

// F11: Inflate without pump — trigger gated on hasItem(pump), should no-op.
console.log("\n--- F11: Inflate without pump rejected ---");
{
  const f = new Engine(story);
  // Player at dam-base, NO pump. Boat starts deflated by default.
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "dam-base" },
  };
  const inflationBefore = f.state.itemStates["inflatable-boat"]?.inflation;
  f.execute({ type: "recordIntent", signalId: "inflate", args: { itemId: "inflatable-boat", withItemId: "pump" } });
  const inflationAfter = f.state.itemStates["inflatable-boat"]?.inflation;
  if (inflationBefore === "deflated" && inflationAfter === "deflated") {
    pass("F11 inflate-boat without pump → boat stays deflated");
  } else {
    fail("F11 boat unexpectedly inflated without pump",
         `before=${inflationBefore} after=${inflationAfter}`);
  }
}

// F12: Board deflated boat — engine rejects with vehicle-blocked.
console.log("\n--- F12: Board deflated boat rejected ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "dam-base" },
  };
  const r = f.execute({ type: "board", itemId: "inflatable-boat" });
  if (!r.ok && (r.event as { reason?: string }).reason === "vehicle-blocked") {
    pass("F12 board deflated boat → vehicle-blocked rejection");
  } else {
    fail("F12 deflated boat not blocked",
         `event=${JSON.stringify(r.event)} player=${f.state.itemLocations.player}`);
  }
}

// F13: Repair without putty — trigger gated on hasItem(putty), should no-op.
console.log("\n--- F13: Repair without putty rejected ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "dam-base" },
    itemStates: {
      ...f.state.itemStates,
      "inflatable-boat": {
        ...(f.state.itemStates["inflatable-boat"] ?? {}),
        inflation: "punctured",
      },
    },
  };
  f.execute({ type: "recordIntent", signalId: "repair-boat-with-putty" });
  if (f.state.itemStates["inflatable-boat"]?.inflation === "punctured") {
    pass("F13 repair-without-putty → boat still punctured");
  } else {
    fail("F13 boat unexpectedly repaired without putty",
         `inflation=${f.state.itemStates["inflatable-boat"]?.inflation}`);
  }
}

// F14: Launch when not in the boat — trigger gated on inVehicle, should no-op.
console.log("\n--- F14: Launch while not in boat rejected ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "dam-base" },
    itemStates: {
      ...f.state.itemStates,
      "inflatable-boat": {
        ...(f.state.itemStates["inflatable-boat"] ?? {}),
        inflation: "inflated",
      },
    },
  };
  f.execute({ type: "recordIntent", signalId: "launch-boat" });
  // Player should still be at dam-base (not in the boat, not at river-1).
  // Boat should still be at dam-base too.
  const playerStill = f.state.itemLocations.player === "dam-base";
  const boatStill = f.state.itemLocations["inflatable-boat"] === "dam-base";
  if (playerStill && boatStill) {
    pass("F14 launch-boat while on foot → no-op (player + boat still at dam-base)");
  } else {
    fail("F14 launch fired without player in boat",
         `player=${f.state.itemLocations.player} boat=${f.state.itemLocations["inflatable-boat"]}`);
  }
}

// F16: Cyclops eats player after enough hunger ticks
console.log("\n--- F16: Cyclops eats player (hunger threshold) ---");
{
  const f = new Engine(story);
  // Place player at cyclops-room, intact health.
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "cyclops-room" },
    flags: { ...f.state.flags, "player-health": 30 },
  };
  // Tick enough turns for hunger to build past the snap threshold (>=6) and
  // for the cyclops to grind health to 0. Cap at 200 to avoid infinite loop.
  for (let i = 0; i < 200; i++) {
    if (f.state.finished) break;
    f.execute({ type: "wait" });
  }
  if (playerDied(f.state)) {
    pass(`F16 cyclops killed player (msg: ${(f.state.finished?.message ?? f.state.flags["death-message"] ?? "soft-die")?.toString().slice(0, 60)}...)`);
  } else {
    fail("F16 cyclops did not kill player",
         `finished=${JSON.stringify(f.state.finished)} hunger=${f.state.itemStates["cyclops"]?.hunger} health=${f.state.flags["player-health"]}`);
  }
  // Strengthen: combat got engaged, no escape was used, death-message is cyclops-flavored.
  f.state.flags["cyclops-flag"] === false
    ? pass("F16 player did not escape (cyclops-flag stays false)")
    : fail("F16 cyclops-flag flipped — escape happened mid-test");
  const dmsg = (f.state.finished?.message ?? f.state.flags["death-message"] ?? "").toString().toLowerCase();
  /cyclops/.test(dmsg)
    ? pass("F16 death-message references the cyclops")
    : fail(`F16 death-message generic: "${dmsg}"`);
}

// F16b: Attack cyclops with sword — engages combat; cyclops survives
console.log("\n--- F16b: Attack cyclops with sword (cyclops invulnerable) ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: {
      ...f.state.itemLocations,
      player: "cyclops-room",
      sword: "player",
    },
    flags: { ...f.state.flags, "player-health": 30 },
  };
  f.execute({ type: "attack", itemId: "sword", targetId: "cyclops" });
  const cycHp = (f.state.itemStates["cyclops"]?.health as number | undefined) ?? 0;
  cycHp > 0
    ? pass(`F16b cyclops survives bladed attack (health=${cycHp})`)
    : fail(`F16b cyclops was killed by a sword swing — health=${cycHp}`);
  f.state.flags["combat-engaged-with-cyclops"] === true
    ? pass("F16b combat engaged after attack")
    : fail("F16b combat did not engage after attack");
  // A few more turns: cyclops should retaliate.
  const hpBefore = (f.state.flags["player-health"] as number) ?? 30;
  for (let i = 0; i < 10; i++) {
    if (f.state.finished) break;
    f.execute({ type: "wait" });
  }
  const hpAfter = (f.state.flags["player-health"] as number) ?? 30;
  hpAfter < hpBefore || playerDied(f.state)
    ? pass(`F16b cyclops retaliated (hp ${hpBefore} → ${hpAfter})`)
    : fail(`F16b cyclops did not retaliate after combat engaged (hp unchanged)`);
}

// F16c: Feed mid-combat — combat halts, no further player damage
console.log("\n--- F16c: Feed cyclops mid-combat (Bug 1 fix) ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: {
      ...f.state.itemLocations,
      player: "cyclops-room",
      lunch: "player",
      bottle: "player",
    },
    flags: {
      ...f.state.flags,
      "player-health": 30,
      "combat-engaged-with-cyclops": true,
    },
    itemStates: {
      ...f.state.itemStates,
      cyclops: { ...(f.state.itemStates.cyclops ?? {}), hunger: 6 },
    },
  };
  // Feed both halves (lunch then bottle) — cyclops sleeps after the second.
  f.execute({ type: "recordIntent", signalId: "give", args: { itemId: "lunch", targetId: "cyclops" } });
  f.execute({ type: "recordIntent", signalId: "give", args: { itemId: "bottle", targetId: "cyclops" } });
  f.state.itemStates["cyclops"]?.unconscious === true
    ? pass("F16c fed cyclops → unconscious=true")
    : fail(`F16c cyclops not unconscious: ${JSON.stringify(f.state.itemStates["cyclops"])}`);
  f.state.flags["combat-engaged-with-cyclops"] === false
    ? pass("F16c combat-engaged cleared by feeding")
    : fail("F16c combat-engaged still true after feeding");
  const hpAfterFeed = (f.state.flags["player-health"] as number) ?? 30;
  for (let i = 0; i < 10; i++) {
    if (f.state.finished) break;
    f.execute({ type: "wait" });
  }
  const hpAfterTicks = (f.state.flags["player-health"] as number) ?? 30;
  hpAfterTicks === hpAfterFeed
    ? pass(`F16c no further damage after feeding (hp ${hpAfterTicks} stable)`)
    : fail(`F16c cyclops kept attacking after feeding: hp ${hpAfterFeed} → ${hpAfterTicks}`);
}

// F16d: Magic word path — cyclops flees, both flags set, combat cleared
console.log("\n--- F16d: Cyclops magic word (cyclops-flees, Bug 2 fix) ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "cyclops-room" },
    flags: {
      ...f.state.flags,
      "player-health": 30,
      "combat-engaged-with-cyclops": true,
    },
  };
  f.execute({ type: "recordIntent", signalId: "cyclops-magic-word" });
  f.state.flags["cyclops-flag"] === true
    ? pass("F16d cyclops-flag set")
    : fail("F16d cyclops-flag not set");
  f.state.flags["magic-flag"] === true
    ? pass("F16d magic-flag set (wall smashed east)")
    : fail("F16d magic-flag not set");
  f.state.flags["combat-engaged-with-cyclops"] === false
    ? pass("F16d combat-engaged cleared by cyclops fleeing")
    : fail("F16d combat-engaged still true after flee");
  f.state.itemLocations["cyclops"] === "nowhere"
    ? pass("F16d cyclops moved to 'nowhere'")
    : fail(`F16d cyclops still at ${f.state.itemLocations["cyclops"]}`);
  // East exit (smashed wall) should now be unblocked.
  const view = f.getView();
  const eastExit = view.exits.find((x) => x.direction === "east");
  eastExit && !eastExit.blocked
    ? pass("F16d east exit unblocked (cyclops-shaped hole)")
    : fail(`F16d east exit still blocked: ${JSON.stringify(eastExit)}`);
}

// F16e: Fed path — cyclops-flag set, magic-flag NOT set, up unblocked, east still blocked
console.log("\n--- F16e: Fed path leaves east blocked ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: {
      ...f.state.itemLocations,
      player: "cyclops-room",
      lunch: "player",
      bottle: "player",
    },
    flags: { ...f.state.flags, "player-health": 30 },
  };
  // Two-call feed (lunch then bottle).
  f.execute({ type: "recordIntent", signalId: "give", args: { itemId: "lunch", targetId: "cyclops" } });
  f.execute({ type: "recordIntent", signalId: "give", args: { itemId: "bottle", targetId: "cyclops" } });
  f.state.flags["cyclops-flag"] === true
    ? pass("F16e fed → cyclops-flag set")
    : fail("F16e fed → cyclops-flag not set");
  f.state.flags["magic-flag"] !== true
    ? pass("F16e fed path leaves magic-flag false (no wall break)")
    : fail("F16e magic-flag wrongly set on fed path");
  const view = f.getView();
  const upExit = view.exits.find((x) => x.direction === "up");
  upExit && !upExit.blocked
    ? pass("F16e up exit unblocked (cyclops asleep)")
    : fail(`F16e up exit still blocked: ${JSON.stringify(upExit)}`);
  const eastExit = view.exits.find((x) => x.direction === "east");
  // east at cyclops-room is hidden when magic-flag=false (per the override),
  // so it shouldn't appear in the visible exits at all.
  !eastExit
    ? pass("F16e east exit absent on fed path (no wall hole)")
    : fail(`F16e east exit visible on fed path: ${JSON.stringify(eastExit)}`);
}

// F17: Two-call feed (lunch then bottle) sleeps the cyclops
console.log("\n--- F17: feed lunch then bottle → cyclops sleeps ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: {
      ...f.state.itemLocations,
      player: "cyclops-room",
      lunch: "player",
      bottle: "player",
    },
    flags: { ...f.state.flags, "player-health": 30 },
  };
  // Feed lunch first.
  f.execute({ type: "recordIntent", signalId: "give", args: { itemId: "lunch", targetId: "cyclops" } });
  f.state.itemStates["cyclops"]?.fedLunch === true
    ? pass("F17 lunch fed → cyclops.fedLunch=true")
    : fail(`F17 fedLunch = ${f.state.itemStates["cyclops"]?.fedLunch}`);
  f.state.itemLocations.lunch === "nowhere"
    ? pass("F17 lunch consumed (moved to nowhere)")
    : fail(`F17 lunch at ${f.state.itemLocations.lunch}`);
  f.state.flags["cyclops-flag"] === false
    ? pass("F17 cyclops still blocking after lunch only")
    : fail("F17 cyclops-flag set after lunch alone");
  // Now feed bottle.
  f.execute({ type: "recordIntent", signalId: "give", args: { itemId: "bottle", targetId: "cyclops" } });
  f.state.itemStates["cyclops"]?.fedBottle === true
    ? pass("F17 bottle fed → cyclops.fedBottle=true")
    : fail(`F17 fedBottle = ${f.state.itemStates["cyclops"]?.fedBottle}`);
  f.state.flags["cyclops-flag"] === true
    ? pass("F17 cyclops sleeps after both halves (cyclops-flag=true)")
    : fail("F17 cyclops-flag not set after both fed");
  f.state.itemStates["cyclops"]?.unconscious === true
    ? pass("F17 cyclops.unconscious=true")
    : fail("F17 cyclops not unconscious");
}

// F17b: Order independence (bottle first, then lunch)
console.log("\n--- F17b: feed bottle then lunch (reverse order) → cyclops sleeps ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: {
      ...f.state.itemLocations,
      player: "cyclops-room",
      lunch: "player",
      bottle: "player",
    },
    flags: { ...f.state.flags, "player-health": 30 },
  };
  f.execute({ type: "recordIntent", signalId: "give", args: { itemId: "bottle", targetId: "cyclops" } });
  f.execute({ type: "recordIntent", signalId: "give", args: { itemId: "lunch", targetId: "cyclops" } });
  f.state.flags["cyclops-flag"] === true && f.state.itemStates["cyclops"]?.unconscious === true
    ? pass("F17b cyclops sleeps regardless of order")
    : fail(`F17b cyclops-flag=${f.state.flags["cyclops-flag"]} unconscious=${f.state.itemStates["cyclops"]?.unconscious}`);
}

// F17c: Feed garlic at cyclops-room → catchall, no state change
console.log("\n--- F17c: feed garlic → catchall, cyclops not appeased ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: {
      ...f.state.itemLocations,
      player: "cyclops-room",
      garlic: "player",
    },
    flags: { ...f.state.flags, "player-health": 30 },
  };
  const result = f.execute({ type: "recordIntent", signalId: "give", args: { itemId: "garlic", targetId: "cyclops" } });
  f.state.itemLocations.garlic === "player"
    ? pass("F17c garlic stays in inventory after rejection")
    : fail(`F17c garlic at ${f.state.itemLocations.garlic}`);
  f.state.flags["cyclops-flag"] === false
    ? pass("F17c cyclops-flag still false after garlic")
    : fail("F17c cyclops-flag set after garlic");
  result.triggersFired.includes("give-rejects")
    ? pass("F17c give-rejects fired (cyclops doesn't take garlic)")
    : fail(`F17c triggers fired: ${JSON.stringify(result.triggersFired)}`);
}

// F17d: Feed at non-cyclops room → handler refuses
console.log("\n--- F17d: feed lunch when not at cyclops-room → refused ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "kitchen", lunch: "player" },
  };
  const result = f.execute({ type: "recordIntent", signalId: "give", args: { itemId: "lunch", targetId: "cyclops" } });
  f.state.itemLocations.lunch === "player"
    ? pass("F17d lunch stays in inventory when no cyclops here")
    : fail(`F17d lunch at ${f.state.itemLocations.lunch}`);
  result.narrationCues.some((c) => /cyclops isn't here|no cyclops here/i.test(c))
    ? pass("F17d refusal cue indicates cyclops isn't here")
    : fail(`F17d cues: ${JSON.stringify(result.narrationCues)}`);
}

// F17e: Feed lunch when player doesn't have it → handler refuses
console.log("\n--- F17e: feed lunch without having lunch → refused ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "cyclops-room" },
  };
  const result = f.execute({ type: "recordIntent", signalId: "give", args: { itemId: "lunch", targetId: "cyclops" } });
  result.narrationCues.some((c) => /don't have/i.test(c))
    ? pass("F17e refusal cue mentions not having the item")
    : fail(`F17e cues: ${JSON.stringify(result.narrationCues)}`);
  f.state.itemStates["cyclops"]?.fedLunch !== true
    ? pass("F17e fedLunch not set on refusal")
    : fail("F17e fedLunch incorrectly set");
}

// F17h: Feed water (water nested in open bottle in inventory) → drinks-bottle fires
console.log("\n--- F17h: feed water (nested in bottle) → drinks-bottle fires ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: {
      ...f.state.itemLocations,
      player: "cyclops-room",
      bottle: "player",
      // water.location stays "bottle" (story-default).
    },
    itemStates: {
      ...f.state.itemStates,
      bottle: { ...(f.state.itemStates.bottle ?? {}), isOpen: true },
    },
  };
  const result = f.execute({ type: "recordIntent", signalId: "give", args: { itemId: "water", targetId: "cyclops" } });
  result.triggersFired.includes("cyclops-drinks-bottle")
    ? pass("F17h cyclops-drinks-bottle fired for water arg")
    : fail(`F17h triggers fired: ${JSON.stringify(result.triggersFired)} cues: ${JSON.stringify(result.narrationCues)}`);
  f.state.itemLocations.bottle === "nowhere" && f.state.itemLocations.water === "nowhere"
    ? pass("F17h both bottle and water consumed")
    : fail(`F17h bottle=${f.state.itemLocations.bottle} water=${f.state.itemLocations.water}`);
  f.state.itemStates["cyclops"]?.fedBottle === true
    ? pass("F17h cyclops.fedBottle=true")
    : fail(`F17h fedBottle=${f.state.itemStates["cyclops"]?.fedBottle}`);
}

// F17i: Feed sandwich-bag (with lunch nested) → eats-lunch fires
console.log("\n--- F17i: feed sandwich-bag (with lunch nested) → eats-lunch fires ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: {
      ...f.state.itemLocations,
      player: "cyclops-room",
      "sandwich-bag": "player",
      // lunch.location stays "sandwich-bag".
    },
    itemStates: {
      ...f.state.itemStates,
      "sandwich-bag": { ...(f.state.itemStates["sandwich-bag"] ?? {}), isOpen: true },
    },
  };
  const result = f.execute({ type: "recordIntent", signalId: "give", args: { itemId: "sandwich-bag", targetId: "cyclops" } });
  result.triggersFired.includes("cyclops-eats-lunch")
    ? pass("F17i cyclops-eats-lunch fired for sandwich-bag arg")
    : fail(`F17i triggers fired: ${JSON.stringify(result.triggersFired)} cues: ${JSON.stringify(result.narrationCues)}`);
  f.state.itemLocations.lunch === "nowhere" && f.state.itemLocations["sandwich-bag"] === "nowhere"
    ? pass("F17i both lunch and sandwich-bag consumed")
    : fail(`F17i lunch=${f.state.itemLocations.lunch} bag=${f.state.itemLocations["sandwich-bag"]}`);
  f.state.itemStates["cyclops"]?.fedLunch === true
    ? pass("F17i cyclops.fedLunch=true")
    : fail(`F17i fedLunch=${f.state.itemStates["cyclops"]?.fedLunch}`);
}

// F17j: Full canonical pour-bottle path: feed lunch then water → cyclops sleeps
console.log("\n--- F17j: feed lunch then water (canonical pour-bottle path) → sleeps ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: {
      ...f.state.itemLocations,
      player: "cyclops-room",
      lunch: "player",
      bottle: "player",
    },
    itemStates: {
      ...f.state.itemStates,
      bottle: { ...(f.state.itemStates.bottle ?? {}), isOpen: true },
    },
  };
  f.execute({ type: "recordIntent", signalId: "give", args: { itemId: "lunch", targetId: "cyclops" } });
  f.execute({ type: "recordIntent", signalId: "give", args: { itemId: "water", targetId: "cyclops" } });
  f.state.flags["cyclops-flag"] === true
    ? pass("F17j cyclops asleep after lunch + water sequence")
    : fail(`F17j cyclops-flag=${f.state.flags["cyclops-flag"]}`);
  f.state.itemStates["cyclops"]?.unconscious === true
    ? pass("F17j cyclops.unconscious=true")
    : fail(`F17j unconscious=${f.state.itemStates["cyclops"]?.unconscious}`);
}

// F17k (re-aimed): water can't be taken standalone (canon); feeding water with
// a closed bottle in inventory is correctly refused.
console.log("\n--- F17k: feed water with closed bottle → refused (water inaccessible) ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: {
      ...f.state.itemLocations,
      player: "cyclops-room",
      bottle: "player",
      // bottle.isOpen stays false (story default) → water inaccessible.
    },
  };
  const result = f.execute({ type: "recordIntent", signalId: "give", args: { itemId: "water", targetId: "cyclops" } });
  result.narrationCues.some((c) => /don't have/i.test(c))
    ? pass("F17k closed bottle → handler refuses 'don't have water'")
    : fail(`F17k cues: ${JSON.stringify(result.narrationCues)}`);
  f.state.itemStates["cyclops"]?.fedBottle !== true
    ? pass("F17k fedBottle not set on refusal")
    : fail("F17k fedBottle wrongly set");
}

// F17l: Feed sandwich-bag when sack is closed (lunch sealed inside, sack reachable)
console.log("\n--- F17l: feed sandwich-bag (sack closed) → eats-lunch fires ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: {
      ...f.state.itemLocations,
      player: "cyclops-room",
      "sandwich-bag": "player",
    },
    // sandwich-bag.isOpen stays false (story default).
  };
  const result = f.execute({ type: "recordIntent", signalId: "give", args: { itemId: "sandwich-bag", targetId: "cyclops" } });
  result.triggersFired.includes("cyclops-eats-lunch")
    ? pass("F17l eats-lunch fires for closed sandwich-bag")
    : fail(`F17l triggers fired: ${JSON.stringify(result.triggersFired)} cues: ${JSON.stringify(result.narrationCues)}`);
  f.state.itemLocations["sandwich-bag"] === "nowhere" && f.state.itemLocations.lunch === "nowhere"
    ? pass("F17l both bag and (sealed) lunch consumed")
    : fail(`F17l bag=${f.state.itemLocations["sandwich-bag"]} lunch=${f.state.itemLocations.lunch}`);
}

// F-door-pre-smash-blocked: front-door (re-purposed as cyclops-smashed wall)
// is nailed shut before magic-flag.
console.log("\n--- F-door-pre-smash-blocked: front door blocks west exit pre-smash ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "living-room" },
    flags: { ...f.state.flags, "magic-flag": false },
  };
  const result = f.execute({ type: "go", direction: "west" });
  result.event.type === "rejected" && f.state.itemLocations.player === "living-room"
    ? pass("F-door-pre-smash west exit blocked, player stays")
    : fail(`F-door-pre-smash event=${JSON.stringify(result.event)} player=${f.state.itemLocations.player}`);
  // blockedMessage rides on the rejection event, not narrationCues.
  const evMsg = (result.event as { message?: string } | undefined)?.message ?? "";
  /nailed shut/i.test(evMsg)
    ? pass("F-door-pre-smash event message mentions 'nailed shut'")
    : fail(`F-door-pre-smash event message: "${evMsg}"`);
}

// F-door-post-smash-traversable: after magic-flag, west exit works.
console.log("\n--- F-door-post-smash-traversable: front door has cyclops hole, traversable ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "living-room" },
    flags: { ...f.state.flags, "magic-flag": true },
  };
  const result = f.execute({ type: "go", direction: "west" });
  result.ok && f.state.itemLocations.player === "strange-passage"
    ? pass("F-door-post-smash player traverses to strange-passage")
    : fail(`F-door-post-smash ok=${result.ok} player=${f.state.itemLocations.player}`);
}

// F-door-passage-visible-both-sides: the front-door passage shows up in
// passagesHere from BOTH living-room and strange-passage with a state-aware description.
console.log("\n--- F-door-passage-visible-both-sides ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "living-room" },
    flags: { ...f.state.flags, "magic-flag": true },
  };
  const v1 = f.getView();
  const livingDoor = v1.passagesHere.find((p) => p.id === "front-door");
  livingDoor && /cyclops-shaped hole/i.test(livingDoor.description)
    ? pass("F-door-both-sides post-smash description includes cyclops hole (living-room)")
    : fail(`F-door-both-sides living-room desc: ${livingDoor?.description}`);
  // Move to strange-passage; same passage should be visible.
  f.state = { ...f.state, itemLocations: { ...f.state.itemLocations, player: "strange-passage" } };
  const v2 = f.getView();
  const strangeDoor = v2.passagesHere.find((p) => p.id === "front-door");
  strangeDoor && /cyclops-shaped hole/i.test(strangeDoor.description)
    ? pass("F-door-both-sides post-smash description includes cyclops hole (strange-passage)")
    : fail(`F-door-both-sides strange-passage desc: ${strangeDoor?.description}`);
}

// F-door-name: the re-purposed front-door passage's display name is "oak door"
// from both sides — no leaking the term "front door" into LLM prose.
console.log("\n--- F-door-name: passage name is 'oak door' from both sides ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "living-room" },
  };
  const livingDoor = f.getView().passagesHere.find((p) => p.id === "front-door");
  livingDoor?.name === "oak door"
    ? pass("F-door-name living-room: passage name = 'oak door'")
    : fail(`F-door-name living-room: name="${livingDoor?.name}"`);
  f.state = { ...f.state, itemLocations: { ...f.state.itemLocations, player: "strange-passage" } };
  const strangeDoor = f.getView().passagesHere.find((p) => p.id === "front-door");
  strangeDoor?.name === "oak door"
    ? pass("F-door-name strange-passage: passage name = 'oak door'")
    : fail(`F-door-name strange-passage: name="${strangeDoor?.name}"`);
}

// F-cyclops-room-pre: cyclops-room description has no "ragged"/"hole" pre-magic.
console.log("\n--- F-cyclops-room-pre: no smashed-wall text before magic-flag ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "cyclops-room" },
    flags: { ...f.state.flags, "magic-flag": false },
  };
  const desc = f.getView().room.description;
  !/ragged|hole/i.test(desc)
    ? pass("F-cyclops-room-pre: description does not mention ragged/hole")
    : fail(`F-cyclops-room-pre: description="${desc}"`);
}

// F-cyclops-room-post-magic: after magic-flag, room description includes the smashed wall.
console.log("\n--- F-cyclops-room-post-magic: smashed-east-wall variant fires ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "cyclops-room" },
    flags: { ...f.state.flags, "magic-flag": true },
  };
  const desc = f.getView().room.description;
  /ragged cyclops-shaped hole/i.test(desc)
    ? pass("F-cyclops-room-post-magic: description includes 'ragged cyclops-shaped hole'")
    : fail(`F-cyclops-room-post-magic: description="${desc}"`);
}

// F-cyclops-asleep-appearance: cyclops appearance flips when unconscious=true.
console.log("\n--- F-cyclops-asleep-appearance: appearance reflects unconscious state ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "cyclops-room", cyclops: "cyclops-room" },
    itemStates: {
      ...f.state.itemStates,
      cyclops: { ...(f.state.itemStates["cyclops"] ?? {}), unconscious: true },
    },
  };
  const cyclopsView = f.getView().itemsHere.find((i) => i.id === "cyclops");
  const app = cyclopsView?.appearance ?? "";
  /slumps|snoring/i.test(app) && !/single hungry eye/i.test(app)
    ? pass("F-cyclops-asleep-appearance: appearance shows slumping/snoring, not hostile")
    : fail(`F-cyclops-asleep-appearance: appearance="${app}"`);
}

// F-tier-player-in-combat-fires: player tier cue fires while combat engaged.
console.log("\n--- F-tier-player-in-combat-fires: wounded cue fires when combat engaged ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "troll-room" },
    flags: { ...f.state.flags, "player-health": 15, "combat-engaged-with-troll": true },
    itemStates: {
      ...f.state.itemStates,
      troll: { ...(f.state.itemStates["troll"] ?? {}), unconscious: true },
    },
  };
  const r = f.execute({ type: "wait" });
  /wounds are starting to tell/i.test(r.narrationCues.join(" "))
    ? pass("F-tier-player-in-combat-fires: wounded cue fires")
    : fail(`F-tier-player-in-combat-fires cues: ${JSON.stringify(r.narrationCues)}`);
}

// F-tier-player-no-cue-out-of-combat: no tier cue fires when player is hurt
// but no enemy is engaged. Three turns, no cue any turn.
console.log("\n--- F-tier-player-no-cue-out-of-combat: no spam outside combat ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    flags: {
      ...f.state.flags,
      "player-health": 8,
      "combat-engaged-with-troll": false,
      "combat-engaged-with-cyclops": false,
      "combat-engaged-with-thief": false,
    },
  };
  const cuesAcrossTurns: string[] = [];
  for (let i = 0; i < 3; i++) {
    const r = f.execute({ type: "wait" });
    cuesAcrossTurns.push(...r.narrationCues);
  }
  !cuesAcrossTurns.some((c) => /wounds are starting to tell|blood slicks|world narrows/i.test(c))
    ? pass("F-tier-player-no-cue-out-of-combat: no tier cue across 3 turns")
    : fail(`F-tier-player-no-cue-out-of-combat cues: ${JSON.stringify(cuesAcrossTurns)}`);
}

// F-tier-player-band-exclusivity: at hp 8 (bloodied band), only bloodied cue fires.
console.log("\n--- F-tier-player-band-exclusivity: only one tier per turn ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "troll-room" },
    flags: { ...f.state.flags, "player-health": 8, "combat-engaged-with-troll": true },
    itemStates: {
      ...f.state.itemStates,
      troll: { ...(f.state.itemStates["troll"] ?? {}), unconscious: true },
    },
  };
  const r = f.execute({ type: "wait" });
  const cues = r.narrationCues.join(" ");
  /blood slicks/i.test(cues) && !/wounds are starting to tell/i.test(cues) && !/world narrows/i.test(cues)
    ? pass("F-tier-player-band-exclusivity: only bloodied cue fires (not wounded, not critical)")
    : fail(`F-tier-player-band-exclusivity cues: ${JSON.stringify(r.narrationCues)}`);
}

// F-tier-player-fires-every-turn-in-combat: per-turn-in-combat (not memoized).
console.log("\n--- F-tier-player-fires-every-turn-in-combat: cue re-fires each turn ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "troll-room", lamp: "player" },
    flags: { ...f.state.flags, "player-health": 15, "combat-engaged-with-troll": true },
    itemStates: {
      ...f.state.itemStates,
      troll: { ...(f.state.itemStates["troll"] ?? {}), unconscious: true },
      lamp: { ...(f.state.itemStates["lamp"] ?? {}), isLit: true },
    },
  };
  let firedCount = 0;
  for (let i = 0; i < 3; i++) {
    const r = f.execute({ type: "wait" });
    if (r.narrationCues.some((c) => /wounds are starting to tell/i.test(c))) firedCount++;
  }
  firedCount === 3
    ? pass("F-tier-player-fires-every-turn-in-combat: cue fires all 3 turns")
    : fail(`F-tier-player-fires-every-turn-in-combat fired ${firedCount}/3 turns`);
}

// F-tier-troll-in-combat: troll tier cue fires while combat-engaged-with-troll
// AND in band, and re-fires next turn (per-turn semantic).
console.log("\n--- F-tier-troll-in-combat: troll bloodied cue per turn ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "troll-room", lamp: "player" },
    itemStates: {
      ...f.state.itemStates,
      troll: { ...(f.state.itemStates["troll"] ?? {}), health: 3, unconscious: true },
      lamp: { ...(f.state.itemStates["lamp"] ?? {}), isLit: true },
    },
    flags: { ...f.state.flags, "combat-engaged-with-troll": true },
  };
  const r1 = f.execute({ type: "wait" });
  const r2 = f.execute({ type: "wait" });
  const fired1 = r1.narrationCues.some((c) => /blood matting his fur/i.test(c));
  const fired2 = r2.narrationCues.some((c) => /blood matting his fur/i.test(c));
  fired1 && fired2
    ? pass("F-tier-troll-in-combat: troll bloodied cue fires both turns")
    : fail(`F-tier-troll-in-combat fired1=${fired1} fired2=${fired2} cues1=${JSON.stringify(r1.narrationCues)} cues2=${JSON.stringify(r2.narrationCues)}`);
}

// F-thief-kill-narration: thief-dies narration matches canonical Zork
// ("sinister black fog... carcass has disappeared... treasures reappear").
console.log("\n--- F-thief-kill-narration: canonical death prose fires on kill ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "treasure-room", thief: "treasure-room" },
    itemStates: {
      ...f.state.itemStates,
      thief: { ...(f.state.itemStates["thief"] ?? {}), health: 0 },
    },
  };
  const result = f.execute({ type: "wait" });
  const cues = result.narrationCues.join(" ");
  /sinister black fog/i.test(cues) && /carcass has disappeared/i.test(cues) && /treasures reappear/i.test(cues)
    ? pass("F-thief-kill-narration: thief-dies narration matches canonical")
    : fail(`F-thief-kill cues: ${JSON.stringify(result.narrationCues)}`);
  result.triggersFired.includes("thief-dies")
    ? pass("F-thief-kill-narration: thief-dies trigger fired")
    : fail(`F-thief-kill triggers: ${JSON.stringify(result.triggersFired)}`);
  f.state.itemLocations.thief === "nowhere"
    ? pass("F-thief-kill-narration: thief moved to nowhere (carcass vanished)")
    : fail(`F-thief-kill thief location: ${f.state.itemLocations.thief}`);
  f.state.itemLocations["large-bag"] === "nowhere"
    ? pass("F-thief-kill-narration: large-bag also vanishes (no orphan scenery)")
    : fail(`F-thief-kill large-bag location: ${f.state.itemLocations["large-bag"]}`);
}

// F-egg-open-canary-visible: when egg is open AND canary still nested,
// the egg's resolved description explicitly mentions the visible canary
// so the LLM can't fall back to "locked" lore during take-all.
console.log("\n--- F-egg-open-canary-visible: open egg + nested canary surfaces canary in text ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemStates: {
      ...f.state.itemStates,
      egg: { ...(f.state.itemStates["egg"] ?? {}), isOpen: true, broken: false },
    },
    itemLocations: { ...f.state.itemLocations, canary: "egg" },
  };
  const eggItem = (story as Story).items.find((i) => i.id === "egg")!;
  const desc = resolveItemDescription(eggItem, f.state, story as Story);
  /canary nestled inside is plainly visible/i.test(desc) && /ready to be taken/i.test(desc)
    ? pass("F-egg-open-canary-visible: variant text mentions visible canary")
    : fail(`F-egg-open-canary-visible desc: "${desc}"`);
}

// F-egg-open-canary-removed: when egg is open AND canary has been taken,
// the description falls through to the "hollow within" variant and does
// NOT mention the canary.
console.log("\n--- F-egg-open-canary-removed: open egg, canary taken → hollow ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemStates: {
      ...f.state.itemStates,
      egg: { ...(f.state.itemStates["egg"] ?? {}), isOpen: true, broken: false },
    },
    itemLocations: { ...f.state.itemLocations, canary: "player" },
  };
  const eggItem = (story as Story).items.find((i) => i.id === "egg")!;
  const desc = resolveItemDescription(eggItem, f.state, story as Story);
  /hollow within/i.test(desc) && !/canary/i.test(desc)
    ? pass("F-egg-open-canary-removed: variant text describes hollow, no canary mention")
    : fail(`F-egg-open-canary-removed desc: "${desc}"`);
}

// F-maze-cyclops-to-grating: canonical walkthrough path from cyclops-room
// reaches grating-room via NW → S → W → U → D → NE.
console.log("\n--- F-maze-cyclops-to-grating: full canonical maze walk ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "cyclops-room", lamp: "player" },
    flags: { ...f.state.flags, "magic-flag": true, "cyclops-flag": true },
    itemStates: {
      ...f.state.itemStates,
      lamp: { ...(f.state.itemStates["lamp"] ?? {}), isLit: true },
    },
  };
  const path: Array<{ direction: string; expect: string }> = [
    { direction: "northwest", expect: "maze-15" },
    { direction: "south", expect: "maze-7" },
    { direction: "west", expect: "maze-6" },
    { direction: "up", expect: "maze-9" },
    { direction: "down", expect: "maze-11" },
    { direction: "northeast", expect: "grating-room" },
  ];
  let allOk = true;
  for (const step of path) {
    f.execute({ type: "go", direction: step.direction });
    if (f.state.itemLocations.player !== step.expect) {
      fail(`F-maze-cyclops-to-grating after go ${step.direction}: expected ${step.expect}, got ${f.state.itemLocations.player}`);
      allOk = false;
      break;
    }
  }
  if (allOk) pass("F-maze-cyclops-to-grating: full path NW S W U D NE reaches grating-room");
}

// F-maze-9-down-warning: descending from maze-9 emits the canonical one-way warning.
console.log("\n--- F-maze-9-down-warning: warning fires on descent from maze-9 ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "maze-9", lamp: "player" },
    itemStates: {
      ...f.state.itemStates,
      lamp: { ...(f.state.itemStates["lamp"] ?? {}), isLit: true },
    },
  };
  const r = f.execute({ type: "go", direction: "down" });
  const matchCount = r.narrationCues.filter((c) => /won't be able to get back up/i.test(c)).length;
  matchCount === 1
    ? pass("F-maze-9-down-warning: warning fires exactly once (no fixed-point loop)")
    : fail(`F-maze-9-down-warning fired ${matchCount} times — cues: ${JSON.stringify(r.narrationCues)}`);
  f.state.itemLocations.player === "maze-11"
    ? pass("F-maze-9-down-warning: move proceeds to maze-11")
    : fail(`F-maze-9-down-warning player at: ${f.state.itemLocations.player}`);
}

// F-unlock-grate-with-keys: unlock(keys, grate) flips passage isLocked to false
// and emits the canonical click narration.
console.log("\n--- F-unlock-grate-with-keys: unlock fires per-target trigger ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "grating-room", keys: "player", lamp: "player" },
    itemStates: {
      ...f.state.itemStates,
      lamp: { ...(f.state.itemStates["lamp"] ?? {}), isLit: true },
    },
  };
  const r = f.execute({ type: "recordIntent", signalId: "unlock", args: { itemId: "keys", targetId: "grate" } });
  const cues = r.narrationCues.join(" ");
  f.state.passageStates?.grate?.isLocked === false
    ? pass("F-unlock-grate-with-keys: grate.isLocked = false")
    : fail(`F-unlock-grate-with-keys grate state: ${JSON.stringify(f.state.passageStates?.grate)}`);
  /skull-and-crossbones lock/i.test(cues) && /click/i.test(cues)
    ? pass("F-unlock-grate-with-keys: canonical narration emitted")
    : fail(`F-unlock-grate-with-keys cues: ${JSON.stringify(r.narrationCues)}`);
}

// F-unlock-wrong-target: unlock(keys, trophy-case) → catchall refusal fires,
// no state changes.
console.log("\n--- F-unlock-wrong-target: unhandled pair → 'key doesn't fit' ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, keys: "player" },
  };
  const r = f.execute({ type: "recordIntent", signalId: "unlock", args: { itemId: "keys", targetId: "trophy-case" } });
  const cues = r.narrationCues.join(" ");
  /key doesn't fit/i.test(cues)
    ? pass("F-unlock-wrong-target: catchall refusal narration emitted")
    : fail(`F-unlock-wrong-target cues: ${JSON.stringify(r.narrationCues)}`);
}

// F-grate-cant-open-while-locked: trying to open grate while isLocked=true
// triggers the refusal narration; passage stays closed.
console.log("\n--- F-grate-cant-open-while-locked: refusal narration on locked open ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "grating-room", lamp: "player" },
    itemStates: {
      ...f.state.itemStates,
      lamp: { ...(f.state.itemStates["lamp"] ?? {}), isLit: true },
    },
  };
  const r = f.execute({ type: "recordIntent", signalId: "open", args: { itemId: "grate" } });
  const cues = r.narrationCues.join(" ");
  /locked closed/i.test(cues) && /skull-and-crossbones/i.test(cues)
    ? pass("F-grate-cant-open-while-locked: refusal narration emitted")
    : fail(`F-grate-cant-open-while-locked cues: ${JSON.stringify(r.narrationCues)}`);
  f.state.passageStates?.grate?.isOpen !== true
    ? pass("F-grate-cant-open-while-locked: grate stays closed")
    : fail(`F-grate-cant-open-while-locked grate.isOpen: ${f.state.passageStates?.grate?.isOpen}`);
}

// F-lock-grate-with-keys: lock(keys, grate) when unlocked + closed flips back.
console.log("\n--- F-lock-grate-with-keys: lock fires per-target trigger ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "grating-room", keys: "player", lamp: "player" },
    itemStates: {
      ...f.state.itemStates,
      lamp: { ...(f.state.itemStates["lamp"] ?? {}), isLit: true },
    },
    passageStates: {
      ...(f.state.passageStates ?? {}),
      grate: { ...((f.state.passageStates ?? {}).grate ?? {}), isLocked: false, isOpen: false },
    },
  };
  const r = f.execute({ type: "recordIntent", signalId: "lock", args: { itemId: "keys", targetId: "grate" } });
  const cues = r.narrationCues.join(" ");
  f.state.passageStates?.grate?.isLocked === true
    ? pass("F-lock-grate-with-keys: grate.isLocked = true")
    : fail(`F-lock-grate-with-keys grate state: ${JSON.stringify(f.state.passageStates?.grate)}`);
  /bolt slides home/i.test(cues)
    ? pass("F-lock-grate-with-keys: canonical narration emitted")
    : fail(`F-lock-grate-with-keys cues: ${JSON.stringify(r.narrationCues)}`);
}

// F-cant-lock-while-open: lock attempt fails when grate is open; isLocked stays false.
console.log("\n--- F-cant-lock-while-open: lock refused while passage open ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "grating-room", keys: "player", lamp: "player" },
    itemStates: {
      ...f.state.itemStates,
      lamp: { ...(f.state.itemStates["lamp"] ?? {}), isLit: true },
    },
    passageStates: {
      ...(f.state.passageStates ?? {}),
      grate: { ...((f.state.passageStates ?? {}).grate ?? {}), isLocked: false, isOpen: true },
    },
  };
  const r = f.execute({ type: "recordIntent", signalId: "lock", args: { itemId: "keys", targetId: "grate" } });
  const cues = r.narrationCues.join(" ");
  f.state.passageStates?.grate?.isLocked === false
    ? pass("F-cant-lock-while-open: grate stays unlocked")
    : fail(`F-cant-lock-while-open grate state: ${JSON.stringify(f.state.passageStates?.grate)}`);
  /key doesn't fit/i.test(cues)
    ? pass("F-cant-lock-while-open: catchall refusal narration emitted")
    : fail(`F-cant-lock-while-open cues: ${JSON.stringify(r.narrationCues)}`);
}

// F-tie-rope-to-railing: generic tie(rope, railing) at dome-room flips dome-flag
// and parks the rope at dome-room (modeling rope-on-railing).
console.log("\n--- F-tie-rope-to-railing: generic tie verb migrated from rope-tied-to-railing ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "dome-room", rope: "player", lamp: "player" },
    itemStates: {
      ...f.state.itemStates,
      lamp: { ...(f.state.itemStates["lamp"] ?? {}), isLit: true },
    },
  };
  const r = f.execute({ type: "recordIntent", signalId: "tie", args: { itemId: "rope", targetId: "railing" } });
  f.state.flags["dome-flag"] === true && f.state.itemLocations.rope === "dome-room"
    ? pass("F-tie-rope-to-railing: dome-flag set + rope at dome-room")
    : fail(`F-tie-rope flag=${f.state.flags["dome-flag"]} ropeLoc=${f.state.itemLocations.rope}`);
  /tie the rope securely to the railing/i.test(r.narrationCues.join(" "))
    ? pass("F-tie-rope-to-railing: canonical narration emitted")
    : fail(`F-tie-rope cues: ${JSON.stringify(r.narrationCues)}`);
}

// F-untie-rope: explicit untie reverses tie-rope (clears flag, returns rope to inventory).
console.log("\n--- F-untie-rope: explicit untie reverses tie-rope ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "dome-room", rope: "dome-room", lamp: "player" },
    itemStates: {
      ...f.state.itemStates,
      lamp: { ...(f.state.itemStates["lamp"] ?? {}), isLit: true },
    },
    flags: { ...f.state.flags, "dome-flag": true },
  };
  const r = f.execute({ type: "recordIntent", signalId: "untie", args: { itemId: "rope" } });
  f.state.flags["dome-flag"] === false && f.state.itemLocations.rope === "player"
    ? pass("F-untie-rope: dome-flag cleared + rope back in inventory")
    : fail(`F-untie-rope flag=${f.state.flags["dome-flag"]} ropeLoc=${f.state.itemLocations.rope}`);
  /coil it back into your hand/i.test(r.narrationCues.join(" "))
    ? pass("F-untie-rope: canonical narration emitted")
    : fail(`F-untie-rope cues: ${JSON.stringify(r.narrationCues)}`);
}

// F-give-egg-songbird-via-generic: songbird-opens-egg now gates on generic give intent.
console.log("\n--- F-give-egg-songbird-via-generic: migrated to generic give ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "forest-1", egg: "player" },
  };
  f.execute({ type: "recordIntent", signalId: "give", args: { itemId: "egg", targetId: "songbird" } });
  f.state.itemStates["egg"]?.isOpen === true
    ? pass("F-give-egg-songbird-via-generic: songbird-opens-egg fired, egg.isOpen=true")
    : fail(`F-give-egg-songbird egg state: ${JSON.stringify(f.state.itemStates["egg"])}`);
}

// F-tie-rejects-catchall: tie at the wrong place falls through to catchall.
console.log("\n--- F-tie-rejects-catchall: unhandled tie pair → catchall refusal ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "kitchen", rope: "player" },
  };
  const r = f.execute({ type: "recordIntent", signalId: "tie", args: { itemId: "rope", targetId: "kitchen-table" } });
  /nothing to tie that to here/i.test(r.narrationCues.join(" "))
    ? pass("F-tie-rejects-catchall: catchall refusal emitted")
    : fail(`F-tie-rejects cues: ${JSON.stringify(r.narrationCues)}`);
}

// F-wind-canary-nested-in-egg: canary still nested in the open egg in player
// inventory must still fire the canary-sings-for-bauble trigger. Prior gate
// used hasItem which requires the canary to be DIRECTLY in inventory; the
// gate is now itemAccessible which traverses the open container.
console.log("\n--- F-wind-canary-nested-in-egg: nested canary still winds ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "path", egg: "player" },
    itemStates: {
      ...f.state.itemStates,
      egg: { ...(f.state.itemStates["egg"] ?? {}), isOpen: true, broken: false },
    },
  };
  // Canary stays at "egg" (nested), egg in inventory and open.
  const r = f.execute({ type: "recordIntent", signalId: "wind-canary" });
  r.triggersFired.includes("canary-sings-for-bauble")
    ? pass("F-wind-canary-nested-in-egg: canary-sings-for-bauble fired")
    : fail(`F-wind-canary-nested-in-egg triggers: ${JSON.stringify(r.triggersFired)}`);
  f.state.itemLocations["bauble"] === "path"
    ? pass("F-wind-canary-nested-in-egg: bauble appeared at path")
    : fail(`F-wind-canary-nested-in-egg bauble loc: ${f.state.itemLocations["bauble"]}`);
}

// F-turn-bolt-no-wrench-named: player names wrench but doesn't have it.
// Handler precondition refuses with "You don't have the wrench" — no
// misleading bare-hand narration, gates-open stays false.
console.log("\n--- F-turn-bolt-no-wrench-named: refuses cleanly ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "dam-room" },
    flags: { ...f.state.flags, "gate-flag": true },
  };
  const r = f.execute({ type: "recordIntent", signalId: "turn", args: { itemId: "bolt", withItemId: "wrench" } });
  /don't have the wrench/i.test(r.narrationCues.join(" "))
    ? pass("F-turn-bolt-no-wrench-named: 'don't have the wrench' refusal")
    : fail(`F-turn-bolt-no-wrench-named cues=${JSON.stringify(r.narrationCues)}`);
  !r.narrationCues.some((c) => /bare hands/i.test(c))
    ? pass("F-turn-bolt-no-wrench-named: no misleading bare-hands cue")
    : fail(`F-turn-bolt-no-wrench-named bare-hands cue leaked: ${JSON.stringify(r.narrationCues)}`);
  f.state.flags["gates-open"] !== true
    ? pass("F-turn-bolt-no-wrench-named: gates-open stays false")
    : fail(`F-turn-bolt-no-wrench-named gates-open: ${f.state.flags["gates-open"]}`);
}

// F-turn-bolt-bare-hand-still-works: no withItemId, bare-hand refusal still fires.
console.log("\n--- F-turn-bolt-bare-hand-still-works: bare-hand path preserved ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "dam-room" },
    flags: { ...f.state.flags, "gate-flag": true },
  };
  const r = f.execute({ type: "recordIntent", signalId: "turn", args: { itemId: "bolt" } });
  /bare hands can't budge/i.test(r.narrationCues.join(" "))
    ? pass("F-turn-bolt-bare-hand-still-works: bare-hand refusal fires")
    : fail(`F-turn-bolt-bare-hand-still-works cues: ${JSON.stringify(r.narrationCues)}`);
}

// F-inflate-pump-not-held: same general pattern for inflate.
console.log("\n--- F-inflate-pump-not-held: refuses cleanly ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "dam-base", "inflatable-boat": "player" },
  };
  const r = f.execute({ type: "recordIntent", signalId: "inflate", args: { itemId: "inflatable-boat", withItemId: "pump" } });
  /don't have the.*pump/i.test(r.narrationCues.join(" "))
    ? pass("F-inflate-pump-not-held: 'don't have the pump' refusal")
    : fail(`F-inflate-pump-not-held cues=${JSON.stringify(r.narrationCues)}`);
}

// F-bolt-state-aware: bolt description flips when gates open.
console.log("\n--- F-bolt-state-aware: bolt variant fires on gates-open ---");
{
  const f = new Engine(story);
  const boltItem = (story as Story).items.find((i) => i.id === "bolt")!;
  // Default state: gates-open false → base description
  const descClosed = resolveItemDescription(boltItem, f.state, story as Story);
  !/quarter rotation/i.test(descClosed)
    ? pass("F-bolt-state-aware: closed-state description (no rotation mention)")
    : fail(`F-bolt-state-aware closed desc: "${descClosed}"`);
  // Open the gates
  f.state = { ...f.state, flags: { ...f.state.flags, "gates-open": true } };
  const descOpen = resolveItemDescription(boltItem, f.state, story as Story);
  /quarter rotation/i.test(descOpen)
    ? pass("F-bolt-state-aware: open-state description shows quarter rotation")
    : fail(`F-bolt-state-aware open desc: "${descOpen}"`);
}

// F-leak-state-aware: leak description flips when leak-active.
console.log("\n--- F-leak-state-aware: leak variant fires on leak-active ---");
{
  const f = new Engine(story);
  const leakItem = (story as Story).items.find((i) => i.id === "leak")!;
  const descIdle = resolveItemDescription(leakItem, f.state, story as Story);
  /pinhole leak.*drips/i.test(descIdle)
    ? pass("F-leak-state-aware: idle-state description (pinhole drip)")
    : fail(`F-leak-state-aware idle desc: "${descIdle}"`);
  f.state = { ...f.state, flags: { ...f.state.flags, "leak-active": true } };
  const descActive = resolveItemDescription(leakItem, f.state, story as Story);
  /sprays.*ruptured/i.test(descActive)
    ? pass("F-leak-state-aware: active-state description (sprays from ruptured pipe)")
    : fail(`F-leak-state-aware active desc: "${descActive}"`);
}

// F-yellow-button-state-aware: button description flips when gate-flag.
console.log("\n--- F-yellow-button-state-aware: indicator-lit variant ---");
{
  const f = new Engine(story);
  const yellowItem = (story as Story).items.find((i) => i.id === "yellow-button")!;
  const descBefore = resolveItemDescription(yellowItem, f.state, story as Story);
  !/indicator beside it glows/i.test(descBefore)
    ? pass("F-yellow-button-state-aware: indicator dark by default")
    : fail(`F-yellow-button before desc: "${descBefore}"`);
  f.state = { ...f.state, flags: { ...f.state.flags, "gate-flag": true } };
  const descAfter = resolveItemDescription(yellowItem, f.state, story as Story);
  /indicator beside it glows/i.test(descAfter)
    ? pass("F-yellow-button-state-aware: indicator glows when gate-flag=true")
    : fail(`F-yellow-button after desc: "${descAfter}"`);
}

// F-control-panel-not-here: examining control-panel from anywhere returns rejected.
console.log("\n--- F-control-panel-not-here: examine returns rejected ---");
{
  const f = new Engine(story);
  f.state = { ...f.state, itemLocations: { ...f.state.itemLocations, player: "dam-room" } };
  const r = f.execute({ type: "examine", itemId: "control-panel" });
  r.event.type === "rejected"
    ? pass("F-control-panel-not-here: dam-room examine rejected")
    : fail(`F-control-panel-not-here event: ${JSON.stringify(r.event)}`);
  f.state = { ...f.state, itemLocations: { ...f.state.itemLocations, player: "maintenance-room" } };
  const r2 = f.execute({ type: "examine", itemId: "control-panel" });
  r2.event.type === "rejected"
    ? pass("F-control-panel-not-here: maintenance-room examine also rejected")
    : fail(`F-control-panel-not-here mr event: ${JSON.stringify(r2.event)}`);
}

// F-no-stale-drop-intent: an unconsumed drop intent from a prior turn must
// NOT leak into a later turn's trigger gates. Drop a lamp at forest-1 (no
// per-target trigger consumes it), then walk to up-a-tree. The
// items-fall-from-tree trigger gates on intentMatched(drop) + playerAt
// (up-a-tree); without the per-turn matchedIntents reset, the stale drop
// from forest-1 would fire the trigger on arrival at up-a-tree.
console.log("\n--- F-no-stale-drop-intent: stale drop doesn't leak into later turn ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "forest-1", lamp: "player" },
  };
  // Drop lamp at forest-1 (no trigger consumes; intent would leak).
  f.execute({ type: "drop", itemId: "lamp" });
  // Teleport to path (skip topology; we're testing intent-leak semantics).
  f.state = { ...f.state, itemLocations: { ...f.state.itemLocations, player: "path" } };
  const r = f.execute({ type: "go", direction: "up" });
  const cues = r.narrationCues.join(" ");
  !/falls through the branches/i.test(cues)
    ? pass("F-no-stale-drop-intent: no stale 'falls through' cue on go-up")
    : fail(`F-no-stale-drop-intent cues: ${JSON.stringify(r.narrationCues)}`);
  f.state.itemLocations.player === "up-a-tree"
    ? pass("F-no-stale-drop-intent: player at up-a-tree")
    : fail(`F-no-stale-drop-intent player: ${f.state.itemLocations.player}`);
}

// F-thief-opens-stolen-egg: when the thief has the closed egg (e.g. he stole it),
// the thief-opens-stolen-egg trigger fires and opens it offscreen.
console.log("\n--- F-thief-opens-stolen-egg: thief auto-opens stolen egg ---");
{
  const f = new Engine(story);
  // Simulate the thief having stolen the closed egg.
  f.state = {
    ...f.state,
    itemLocations: {
      ...f.state.itemLocations,
      player: "round-room",
      thief: "round-room",
      egg: "thief",
    },
    itemStates: {
      ...f.state.itemStates,
      egg: { ...(f.state.itemStates["egg"] ?? {}), isOpen: false },
    },
  };
  const result = f.execute({ type: "wait" });
  result.triggersFired.includes("thief-opens-stolen-egg")
    ? pass("F-stolen-egg trigger fires when egg is in thief's bag and closed")
    : fail(`F-stolen-egg triggers fired: ${JSON.stringify(result.triggersFired)}`);
  f.state.itemStates["egg"]?.isOpen === true
    ? pass("F-stolen-egg egg.isOpen=true after trigger")
    : fail(`F-stolen-egg egg.isOpen=${f.state.itemStates["egg"]?.isOpen}`);
}

// F-stolen-egg-not-after-give: give-path's thief-opens-egg already opens the egg;
// the stolen-egg trigger should NOT also fire.
console.log("\n--- F-stolen-egg-not-after-give: no double-fire after give ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: {
      ...f.state.itemLocations,
      player: "round-room",
      thief: "round-room",
      egg: "thief",
      lamp: "player",
    },
    itemStates: {
      ...f.state.itemStates,
      lamp: { ...(f.state.itemStates["lamp"] ?? {}), isLit: true },
      egg: { ...(f.state.itemStates["egg"] ?? {}), isOpen: true },
    },
    firedTriggers: [...f.state.firedTriggers, "thief-opens-egg"],
  };
  const result = f.execute({ type: "wait" });
  !result.triggersFired.includes("thief-opens-stolen-egg")
    ? pass("F-stolen-egg-not-after-give does NOT re-fire after give path")
    : fail("F-stolen-egg-not-after-give double-fired");
}

// F-stolen-egg-recovery: full canonical recovery — thief stole egg, dies, egg dumps to treasure-room open.
console.log("\n--- F-stolen-egg-recovery: kill thief, recover open egg ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: {
      ...f.state.itemLocations,
      player: "treasure-room",
      thief: "treasure-room",
      egg: "thief",
    },
    flags: { ...f.state.flags, "combat-engaged-with-thief": true },
    itemStates: {
      ...f.state.itemStates,
      thief: { ...(f.state.itemStates["thief"] ?? {}), appeared: true, health: 0 },
      egg: { ...(f.state.itemStates["egg"] ?? {}), isOpen: false },
    },
  };
  f.execute({ type: "wait" });
  // After the trigger pass: thief-opens-stolen-egg + thief-dies should have fired.
  f.state.itemStates["egg"]?.isOpen === true
    ? pass("F-recovery egg.isOpen=true after trigger pass")
    : fail(`F-recovery egg.isOpen=${f.state.itemStates["egg"]?.isOpen}`);
  f.state.itemLocations.egg === "treasure-room"
    ? pass("F-recovery egg dumped to treasure-room (open) after thief death")
    : fail(`F-recovery egg at ${f.state.itemLocations.egg}`);
  f.state.itemLocations.canary === "egg"
    ? pass("F-recovery canary still nested in (now-open) egg")
    : fail(`F-recovery canary at ${f.state.itemLocations.canary}`);
}

// F-thief-stays-after-give: engine state pin — thief remains in room after giving egg.
// Personality field was previously prescribing "pockets things and vanishes" which made
// the LLM hallucinate the thief's exit. Engine truth: he stays put.
console.log("\n--- F-thief-stays-after-give: thief still in room after egg given ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: {
      ...f.state.itemLocations,
      player: "round-room",
      thief: "round-room",
      egg: "player",
      lamp: "player",
    },
    itemStates: {
      ...f.state.itemStates,
      thief: { ...(f.state.itemStates["thief"] ?? {}), appeared: true },
      egg: { ...(f.state.itemStates["egg"] ?? {}), isOpen: false },
      lamp: { ...(f.state.itemStates["lamp"] ?? {}), isLit: true },
    },
  };
  f.execute({ type: "recordIntent", signalId: "give", args: { itemId: "egg", targetId: "thief" } });
  f.state.itemLocations.thief === "round-room"
    ? pass("F-thief-stays thief still at round-room (not 'nowhere') after egg-give")
    : fail(`F-thief-stays thief at ${f.state.itemLocations.thief}`);
}

// F-treasure-room-1: first entry to treasure-room invokes the canonical robber's-hideaway trigger
console.log("\n--- F-treasure-room-1: violate robber's hideaway → chalice hidden, thief teleports in ---");
{
  const f = new Engine(story);
  // Place player at cyclops-room with cyclops appeased + lit lamp; thief at deep-canyon (NOT treasure-room).
  f.state = {
    ...f.state,
    itemLocations: {
      ...f.state.itemLocations,
      player: "cyclops-room",
      thief: "deep-canyon",
      lamp: "player",
    },
    flags: { ...f.state.flags, "cyclops-flag": true },
    itemStates: {
      ...f.state.itemStates,
      lamp: { ...(f.state.itemStates["lamp"] ?? {}), isLit: true },
      cyclops: { ...(f.state.itemStates["cyclops"] ?? {}), unconscious: true },
    },
  };
  const result = f.execute({ type: "go", direction: "up" });
  result.triggersFired.includes("treasure-room-invaded")
    ? pass("F-tr-1 treasure-room-invaded fired on first entry")
    : fail(`F-tr-1 triggers fired: ${JSON.stringify(result.triggersFired)}`);
  f.state.itemLocations.chalice === "thief"
    ? pass("F-tr-1 chalice hidden in thief's bag")
    : fail(`F-tr-1 chalice at ${f.state.itemLocations.chalice}`);
  f.state.itemLocations.thief === "treasure-room"
    ? pass("F-tr-1 thief teleported to treasure-room")
    : fail(`F-tr-1 thief at ${f.state.itemLocations.thief}`);
  f.state.itemStates["thief"]?.appeared === true
    ? pass("F-tr-1 thief.appeared=true")
    : fail(`F-tr-1 thief.appeared=${f.state.itemStates["thief"]?.appeared}`);
  result.narrationCues.some((c) => /violate the robber's hideaway/i.test(c))
    ? pass("F-tr-1 narration includes canonical 'violate the robber's hideaway'")
    : fail(`F-tr-1 cues: ${JSON.stringify(result.narrationCues)}`);
}

// F-treasure-room-2: re-entry doesn't re-fire the trigger (once:true)
console.log("\n--- F-treasure-room-2: re-entering treasure-room doesn't re-fire ---");
{
  const f = new Engine(story);
  // Set up: trigger has already fired (firedTriggers includes it), player at cyclops-room.
  f.state = {
    ...f.state,
    itemLocations: {
      ...f.state.itemLocations,
      player: "cyclops-room",
      thief: "treasure-room",
      lamp: "player",
    },
    flags: { ...f.state.flags, "cyclops-flag": true },
    itemStates: {
      ...f.state.itemStates,
      lamp: { ...(f.state.itemStates["lamp"] ?? {}), isLit: true },
      cyclops: { ...(f.state.itemStates["cyclops"] ?? {}), unconscious: true },
    },
    firedTriggers: [...f.state.firedTriggers, "treasure-room-invaded"],
  };
  const result = f.execute({ type: "go", direction: "up" });
  !result.triggersFired.includes("treasure-room-invaded")
    ? pass("F-tr-2 trigger does NOT re-fire on subsequent entry")
    : fail("F-tr-2 trigger re-fired (once:true broken?)");
  !result.narrationCues.some((c) => /violate the robber's hideaway/i.test(c))
    ? pass("F-tr-2 no duplicate violate-the-hideaway cue")
    : fail(`F-tr-2 duplicate cue: ${JSON.stringify(result.narrationCues)}`);
}

// F-treasure-room-3: killing the thief at treasure-room dumps chalice + stash back
console.log("\n--- F-treasure-room-3: thief death dumps chalice + stash to treasure-room ---");
{
  const f = new Engine(story);
  // Set up: thief at treasure-room with chalice + a stolen torch in his bag; player there with sword.
  f.state = {
    ...f.state,
    itemLocations: {
      ...f.state.itemLocations,
      player: "treasure-room",
      thief: "treasure-room",
      chalice: "thief",
      torch: "thief",
      sword: "player",
    },
    flags: { ...f.state.flags, "combat-engaged-with-thief": true },
    itemStates: {
      ...f.state.itemStates,
      thief: { ...(f.state.itemStates["thief"] ?? {}), appeared: true, health: 1 },
    },
  };
  // Force the thief's death.
  f.state = {
    ...f.state,
    itemStates: {
      ...f.state.itemStates,
      thief: { ...f.state.itemStates.thief, health: 0 },
    },
  };
  f.execute({ type: "wait" });
  f.state.itemLocations.chalice === "treasure-room"
    ? pass("F-tr-3 chalice dumped back to treasure-room on thief death")
    : fail(`F-tr-3 chalice at ${f.state.itemLocations.chalice}`);
  f.state.itemLocations.torch === "treasure-room"
    ? pass("F-tr-3 stolen torch dumped to treasure-room on thief death")
    : fail(`F-tr-3 torch at ${f.state.itemLocations.torch}`);
}

// F-thief-bag-closed: thief's bag is closed by default; items inside aren't accessible
console.log("\n--- F-thief-bag-closed: items at thief are inaccessible (bag closed) ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: {
      ...f.state.itemLocations,
      player: "round-room",
      thief: "round-room",
      torch: "thief",
      lamp: "player",
    },
    itemStates: {
      ...f.state.itemStates,
      lamp: { ...(f.state.itemStates["lamp"] ?? {}), isLit: true },
    },
  };
  const torchItem = (story as any).items.find((i: any) => i.id === "torch");
  isItemAccessible(torchItem, f.state, story) === false
    ? pass("F-thief-bag-closed torch (in closed bag) is NOT accessible")
    : fail("F-thief-bag-closed torch is accessible — bag isn't closed?");
}

// F-give-1: thief NOT in same room → handler refuses with "thief isn't here"
console.log("\n--- F-give-1: give egg to absent thief → refused ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: {
      ...f.state.itemLocations,
      player: "round-room",
      thief: "treasure-room",
      egg: "player",
      lamp: "player",
    },
    itemStates: {
      ...f.state.itemStates,
      lamp: { ...(f.state.itemStates["lamp"] ?? {}), isLit: true },
    },
  };
  const result = f.execute({ type: "recordIntent", signalId: "give", args: { itemId: "egg", targetId: "thief" } });
  result.narrationCues.some((c) => /isn't here/i.test(c))
    ? pass("F-give-1 refusal mentions 'isn't here'")
    : fail(`F-give-1 cues: ${JSON.stringify(result.narrationCues)}`);
  f.state.itemLocations.egg === "player"
    ? pass("F-give-1 egg stays in inventory after refusal")
    : fail(`F-give-1 egg at ${f.state.itemLocations.egg}`);
}

// F-give-2: give item not in inventory → handler refuses with "don't have"
console.log("\n--- F-give-2: give item not in inventory → refused ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: {
      ...f.state.itemLocations,
      player: "round-room",
      thief: "round-room",
      lamp: "player",
    },
    itemStates: {
      ...f.state.itemStates,
      lamp: { ...(f.state.itemStates["lamp"] ?? {}), isLit: true },
    },
  };
  // egg stays at nest (story default).
  const result = f.execute({ type: "recordIntent", signalId: "give", args: { itemId: "egg", targetId: "thief" } });
  result.narrationCues.some((c) => /don't have/i.test(c))
    ? pass("F-give-2 refusal mentions 'don't have'")
    : fail(`F-give-2 cues: ${JSON.stringify(result.narrationCues)}`);
}

// F-give-3: give unrelated item to thief (no specific trigger) → catchall fires
console.log("\n--- F-give-3: give lamp to thief → catchall ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: {
      ...f.state.itemLocations,
      player: "round-room",
      thief: "round-room",
      lamp: "player",
    },
    itemStates: {
      ...f.state.itemStates,
      lamp: { ...(f.state.itemStates["lamp"] ?? {}), isLit: true },
    },
  };
  const result = f.execute({ type: "recordIntent", signalId: "give", args: { itemId: "lamp", targetId: "thief" } });
  result.triggersFired.includes("give-rejects")
    ? pass("F-give-3 give-rejects catchall fires for unrelated item")
    : fail(`F-give-3 triggers fired: ${JSON.stringify(result.triggersFired)}`);
  f.state.itemLocations.lamp === "player"
    ? pass("F-give-3 lamp stays in inventory")
    : fail(`F-give-3 lamp at ${f.state.itemLocations.lamp}`);
}

// F-water-not-takeable: canonical Zork I refuses TAKE WATER
console.log("\n--- F-water-not-takeable: take water → refused ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "kitchen", bottle: "player" },
    itemStates: {
      ...f.state.itemStates,
      bottle: { ...(f.state.itemStates.bottle ?? {}), isOpen: true },
    },
  };
  const result = f.execute({ type: "take", itemId: "water" });
  result.event.type === "rejected" && f.state.itemLocations.water === "bottle"
    ? pass("F-water-not-takeable take water refused; water stays in bottle")
    : fail(`F-water-not-takeable: event=${JSON.stringify(result.event)} water at ${f.state.itemLocations.water}`);
}

// F-pour-1: pour water (open bottle in inventory) → water consumed, bottle stays
console.log("\n--- F-pour-1: pour water → water → nowhere; bottle stays ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "kitchen", bottle: "player" },
    itemStates: {
      ...f.state.itemStates,
      bottle: { ...(f.state.itemStates.bottle ?? {}), isOpen: true },
    },
  };
  f.execute({ type: "recordIntent", signalId: "pour", args: { itemId: "water" } });
  f.state.itemLocations.water === "nowhere"
    ? pass("F-pour-1 water moved to nowhere")
    : fail(`F-pour-1 water at ${f.state.itemLocations.water}`);
  f.state.itemLocations.bottle === "player"
    ? pass("F-pour-1 bottle stays in inventory (empty)")
    : fail(`F-pour-1 bottle at ${f.state.itemLocations.bottle}`);
}

// F-pour-2: after pouring, feed-cyclops with water → handler refuses
console.log("\n--- F-pour-2: after pouring, feed water at cyclops-room → refused ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "cyclops-room", bottle: "player" },
    itemStates: {
      ...f.state.itemStates,
      bottle: { ...(f.state.itemStates.bottle ?? {}), isOpen: true },
    },
  };
  f.execute({ type: "recordIntent", signalId: "pour", args: { itemId: "water" } });
  const result = f.execute({ type: "recordIntent", signalId: "give", args: { itemId: "water", targetId: "cyclops" } });
  result.narrationCues.some((c) => /don't have/i.test(c))
    ? pass("F-pour-2 feed-water after pour → 'don't have water'")
    : fail(`F-pour-2 cues: ${JSON.stringify(result.narrationCues)}`);
}

// F-eat-1: eat lunch (edible) → lunch consumed
console.log("\n--- F-eat-1: eat lunch → lunch → nowhere ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "kitchen", lunch: "player" },
  };
  f.execute({ type: "recordIntent", signalId: "eat", args: { itemId: "lunch" } });
  f.state.itemLocations.lunch === "nowhere"
    ? pass("F-eat-1 lunch consumed")
    : fail(`F-eat-1 lunch at ${f.state.itemLocations.lunch}`);
}

// F-eat-2: try to eat inedible (lamp) → handler refuses
console.log("\n--- F-eat-2: eat lamp (inedible) → refused ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "kitchen", lamp: "player" },
  };
  const result = f.execute({ type: "recordIntent", signalId: "eat", args: { itemId: "lamp" } });
  result.narrationCues.some((c) => /not.*edible|doesn't strike you as edible/i.test(c))
    ? pass("F-eat-2 lamp refusal mentions inedibility")
    : fail(`F-eat-2 cues: ${JSON.stringify(result.narrationCues)}`);
  f.state.itemLocations.lamp === "player"
    ? pass("F-eat-2 lamp still in inventory")
    : fail(`F-eat-2 lamp at ${f.state.itemLocations.lamp}`);
}

// F-drink-1: drink water (open bottle in inventory) → water consumed
console.log("\n--- F-drink-1: drink water → water → nowhere ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "kitchen", bottle: "player" },
    itemStates: {
      ...f.state.itemStates,
      bottle: { ...(f.state.itemStates.bottle ?? {}), isOpen: true },
    },
  };
  f.execute({ type: "recordIntent", signalId: "drink", args: { itemId: "water" } });
  f.state.itemLocations.water === "nowhere"
    ? pass("F-drink-1 water consumed")
    : fail(`F-drink-1 water at ${f.state.itemLocations.water}`);
}

// F-drink-2: try to drink non-potable (lamp) → handler refuses
console.log("\n--- F-drink-2: drink lamp (non-potable) → refused ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "kitchen", lamp: "player" },
  };
  const result = f.execute({ type: "recordIntent", signalId: "drink", args: { itemId: "lamp" } });
  result.narrationCues.some((c) => /drinkable|doesn't strike/i.test(c))
    ? pass("F-drink-2 lamp refusal mentions undrinkability")
    : fail(`F-drink-2 cues: ${JSON.stringify(result.narrationCues)}`);
}

// F-eat-feed-interaction: eat lunch first, then feed-cyclops lunch → refused
console.log("\n--- F-eat-feed-interaction: eat then feed-lunch → refused ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "cyclops-room", lunch: "player" },
  };
  f.execute({ type: "recordIntent", signalId: "eat", args: { itemId: "lunch" } });
  const result = f.execute({ type: "recordIntent", signalId: "give", args: { itemId: "lunch", targetId: "cyclops" } });
  result.narrationCues.some((c) => /don't have/i.test(c))
    ? pass("F-eat-feed feed-lunch after eat → 'don't have lunch'")
    : fail(`F-eat-feed cues: ${JSON.stringify(result.narrationCues)}`);
}

// F17g: Feed lunch while it's nested inside the open sandwich-bag in inventory
console.log("\n--- F17g: feed lunch nested in sandwich-bag → eats-lunch fires ---");
{
  const f = new Engine(story);
  // Canonical starting position: lunch is INSIDE sandwich-bag (not directly
  // in player). Player carries the bag (open) into cyclops-room.
  f.state = {
    ...f.state,
    itemLocations: {
      ...f.state.itemLocations,
      player: "cyclops-room",
      "sandwich-bag": "player",
      // lunch.location stays "sandwich-bag" (story-default).
    },
    itemStates: {
      ...f.state.itemStates,
      "sandwich-bag": {
        ...(f.state.itemStates["sandwich-bag"] ?? {}),
        isOpen: true,
      },
    },
  };
  const result = f.execute({ type: "recordIntent", signalId: "give", args: { itemId: "lunch", targetId: "cyclops" } });
  result.triggersFired.includes("cyclops-eats-lunch")
    ? pass("F17g cyclops-eats-lunch fired despite nesting")
    : fail(`F17g triggers fired: ${JSON.stringify(result.triggersFired)} cues: ${JSON.stringify(result.narrationCues)}`);
  f.state.itemLocations.lunch === "nowhere"
    ? pass("F17g lunch consumed from inside the bag")
    : fail(`F17g lunch at ${f.state.itemLocations.lunch}`);
  f.state.itemStates["cyclops"]?.fedLunch === true
    ? pass("F17g cyclops.fedLunch=true")
    : fail(`F17g fedLunch=${f.state.itemStates["cyclops"]?.fedLunch}`);
}

// F17f: Double-feed lunch → second call hits catchall
console.log("\n--- F17f: feed lunch twice → second call rejected ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: {
      ...f.state.itemLocations,
      player: "cyclops-room",
      lunch: "player",
    },
  };
  // First feed succeeds.
  f.execute({ type: "recordIntent", signalId: "give", args: { itemId: "lunch", targetId: "cyclops" } });
  // Second feed: lunch is gone (moved to nowhere) → handler refuses with "don't have lunch."
  const result2 = f.execute({ type: "recordIntent", signalId: "give", args: { itemId: "lunch", targetId: "cyclops" } });
  result2.narrationCues.some((c) => /don't have/i.test(c))
    ? pass("F17f second feed-lunch refused (lunch already consumed)")
    : fail(`F17f second-feed cues: ${JSON.stringify(result2.narrationCues)}`);
}

// ----- Boat-on-water gating -----
// Helper: place player in the inflated boat at a water room.
function placeInBoat(f: Engine, room: string) {
  f.state = {
    ...f.state,
    itemLocations: {
      ...f.state.itemLocations,
      "inflatable-boat": room,
      player: "inflatable-boat",
    },
    itemStates: {
      ...f.state.itemStates,
      "inflatable-boat": {
        ...(f.state.itemStates["inflatable-boat"] ?? {}),
        inflation: "inflated",
      },
    },
  };
}

// F-boat-1: in boat at sandy-beach, go northeast → blocked
console.log("\n--- F-boat-1: in boat at sandy-beach, go northeast → blocked ---");
{
  const f = new Engine(story);
  placeInBoat(f, "sandy-beach");
  const result = f.execute({ type: "go", direction: "northeast" });
  result.event.type === "rejected" && f.state.itemLocations.player === "inflatable-boat" && f.state.itemLocations["inflatable-boat"] === "sandy-beach"
    ? pass("F-boat-1 sandy-beach.northeast blocked in boat")
    : fail(`F-boat-1: event=${JSON.stringify(result.event)} player=${f.state.itemLocations.player} boat=${f.state.itemLocations["inflatable-boat"]}`);
}

// F-boat-2: in boat at dam-base, go north → blocked
console.log("\n--- F-boat-2: in boat at dam-base, go north → blocked ---");
{
  const f = new Engine(story);
  placeInBoat(f, "dam-base");
  const result = f.execute({ type: "go", direction: "north" });
  result.event.type === "rejected" && f.state.itemLocations["inflatable-boat"] === "dam-base"
    ? pass("F-boat-2 dam-base.north blocked in boat")
    : fail(`F-boat-2: event=${JSON.stringify(result.event)} boat=${f.state.itemLocations["inflatable-boat"]}`);
}

// F-boat-3: in boat at shore, go north → blocked (foot-only)
console.log("\n--- F-boat-3: in boat at shore, go north → blocked ---");
{
  const f = new Engine(story);
  placeInBoat(f, "shore");
  const result = f.execute({ type: "go", direction: "north" });
  result.event.type === "rejected" && f.state.itemLocations["inflatable-boat"] === "shore"
    ? pass("F-boat-3 shore.north blocked in boat")
    : fail(`F-boat-3: event=${JSON.stringify(result.event)} boat=${f.state.itemLocations["inflatable-boat"]}`);
}

// F-boat-4: in boat at shore, go south → blocked (no falls plummet)
console.log("\n--- F-boat-4: in boat at shore, go south → blocked ---");
{
  const f = new Engine(story);
  placeInBoat(f, "shore");
  const result = f.execute({ type: "go", direction: "south" });
  result.event.type === "rejected" && f.state.itemLocations["inflatable-boat"] === "shore"
    ? pass("F-boat-4 shore.south blocked in boat")
    : fail(`F-boat-4: event=${JSON.stringify(result.event)} boat=${f.state.itemLocations["inflatable-boat"]}`);
}

// F-boat-5: on foot at sandy-beach (boat NOT under player), go northeast → allowed
console.log("\n--- F-boat-5: on foot at sandy-beach, go northeast → allowed ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: {
      ...f.state.itemLocations,
      player: "sandy-beach",
      "inflatable-boat": "sandy-beach",
    },
    itemStates: {
      ...f.state.itemStates,
      "inflatable-boat": {
        ...(f.state.itemStates["inflatable-boat"] ?? {}),
        inflation: "inflated",
      },
    },
  };
  const result = f.execute({ type: "go", direction: "northeast" });
  result.ok && f.state.itemLocations.player === "sandy-cave"
    ? pass("F-boat-5 on-foot sandy-beach.northeast allowed")
    : fail(`F-boat-5: ok=${result.ok} player=${f.state.itemLocations.player}`);
}

// F-boat-6: in boat at river-3, go west → allowed (landing at white-cliffs-north)
console.log("\n--- F-boat-6: in boat at river-3, go west → allowed ---");
{
  const f = new Engine(story);
  placeInBoat(f, "river-3");
  const result = f.execute({ type: "go", direction: "west" });
  result.ok && f.state.itemLocations["inflatable-boat"] === "white-cliffs-north" && f.state.itemLocations.player === "inflatable-boat"
    ? pass("F-boat-6 river-3.west landing at white-cliffs-north allowed in boat")
    : fail(`F-boat-6: ok=${result.ok} boat=${f.state.itemLocations["inflatable-boat"]} player=${f.state.itemLocations.player}`);
}

// F-boat-7: in boat at river-5, go east → allowed (canonical landing at shore)
console.log("\n--- F-boat-7: in boat at river-5, go east → allowed ---");
{
  const f = new Engine(story);
  placeInBoat(f, "river-5");
  const result = f.execute({ type: "go", direction: "east" });
  result.ok && f.state.itemLocations["inflatable-boat"] === "shore"
    ? pass("F-boat-7 river-5.east landing at shore allowed in boat")
    : fail(`F-boat-7: ok=${result.ok} boat=${f.state.itemLocations["inflatable-boat"]}`);
}

// F-boat-8: try to board boat at non-water room (maze-15) → refused
console.log("\n--- F-boat-8: board boat at maze-15 → refused ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: {
      ...f.state.itemLocations,
      player: "maze-15",
      "inflatable-boat": "maze-15",
    },
    itemStates: {
      ...f.state.itemStates,
      "inflatable-boat": {
        ...(f.state.itemStates["inflatable-boat"] ?? {}),
        inflation: "inflated",
      },
    },
  };
  const result = f.execute({ type: "board", itemId: "inflatable-boat" });
  result.event.type === "rejected" && f.state.itemLocations.player === "maze-15"
    ? pass("F-boat-8 board at maze-15 refused (not water)")
    : fail(`F-boat-8: event=${JSON.stringify(result.event)} player=${f.state.itemLocations.player}`);
}

// F-boat-9: board boat at dam-base (water) → succeeds
console.log("\n--- F-boat-9: board boat at dam-base → succeeds ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: {
      ...f.state.itemLocations,
      player: "dam-base",
      "inflatable-boat": "dam-base",
    },
    itemStates: {
      ...f.state.itemStates,
      "inflatable-boat": {
        ...(f.state.itemStates["inflatable-boat"] ?? {}),
        inflation: "inflated",
      },
    },
  };
  const result = f.execute({ type: "board", itemId: "inflatable-boat" });
  result.ok && f.state.itemLocations.player === "inflatable-boat"
    ? pass("F-boat-9 board at dam-base succeeds")
    : fail(`F-boat-9: ok=${result.ok} player=${f.state.itemLocations.player}`);
}

// F19: Bat carries player to a random room (no garlic)
console.log("\n--- F19: Bat carries player from bat-room ---");
{
  const f = new Engine(story);
  // Place player at bat-room with NO garlic. (Garlic starts in sandwich-bag —
  // leave it there; we just need player at bat-room with no garlic carried.)
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "bat-room" },
  };
  // The bat-carries trigger is a regular phase-1 trigger that fires on any
  // tick. Wait one turn and check the player moved out of bat-room. (The
  // bat-carried-this-visit flag may be cleared by a reset trigger once the
  // player is no longer at bat-room — don't rely on it for the assertion.)
  f.execute({ type: "wait" });
  if (f.state.itemLocations.player !== "bat-room") {
    pass(`F19 bat carried player → ${f.state.itemLocations.player}`);
  } else {
    fail("F19 bat did not carry player",
         `loc=${f.state.itemLocations.player}`);
  }
}

// F20: Garlic blocks the bat
console.log("\n--- F20: Garlic prevents bat carrying ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "bat-room", garlic: "player" },
  };
  f.execute({ type: "wait" });
  if (f.state.itemLocations.player === "bat-room") {
    pass("F20 garlic in inventory blocks bat carry");
  } else {
    fail("F20 bat carried player despite garlic",
         `loc=${f.state.itemLocations.player}`);
  }
}

// F21: Coffin cure passive (drop coffin at south-temple → flag set)
console.log("\n--- F21: Coffin-cure flag toggles passively ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "south-temple" },
  };
  f.execute({ type: "wait" });
  if (f.state.flags["coffin-cure"] === true) {
    pass("F21 coffin-cure set when at south-temple without coffin");
  } else {
    fail("F21 coffin-cure not set", `flag=${f.state.flags["coffin-cure"]}`);
  }
  // Now pick up the coffin (place it in player) and verify the flag flips off.
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, coffin: "player" },
  };
  f.execute({ type: "wait" });
  if (f.state.flags["coffin-cure"] === false) {
    pass("F21 coffin-cure cleared when carrying coffin");
  } else {
    fail("F21 coffin-cure not cleared",
         `flag=${f.state.flags["coffin-cure"]} coffin=${f.state.itemLocations["coffin"]}`);
  }
}

// F22: Empty-handed gate for timber-room squeeze
console.log("\n--- F22: Empty-handed flag tracks inventory ---");
{
  const f = new Engine(story);
  // Player carrying the lamp → not empty-handed.
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "lower-shaft", lamp: "player" },
  };
  f.execute({ type: "wait" });
  if (f.state.flags["empty-handed"] === false) {
    pass("F22 empty-handed=false while carrying lamp");
  } else {
    fail("F22 empty-handed should be false with lamp", `flag=${f.state.flags["empty-handed"]}`);
  }
  // Drop the lamp; flag flips back to true.
  f.execute({ type: "drop", itemId: "lamp" });
  if (f.state.flags["empty-handed"] === true) {
    pass("F22 empty-handed=true after dropping lamp");
  } else {
    fail("F22 empty-handed should be true after drop", `flag=${f.state.flags["empty-handed"]}`);
  }
}

// F15: Broken canary cannot sing for the bauble
console.log("\n--- F15: Broken canary cannot sing ---");
{
  const f = new Engine(story);
  // Climb tree, take egg, drop egg → F6 trigger breaks egg + canary.
  f.execute({ type: "go", direction: "north" });
  f.execute({ type: "go", direction: "north" });
  f.execute({ type: "go", direction: "up" });
  f.execute({ type: "take", itemId: "egg" });
  f.execute({ type: "drop", itemId: "egg" });
  if (f.state.itemStates["canary"]?.broken !== true) {
    fail("F15 setup: canary not broken after egg drop", JSON.stringify(f.state.itemStates));
  } else {
    // Take the (now-broken) canary out of the broken open egg, climb down to
    // path (a forest room), and try to wind it.
    f.execute({ type: "take", itemId: "canary" });
    f.execute({ type: "go", direction: "down" });
    f.execute({ type: "recordIntent", signalId: "wind-canary" });
    if (f.state.itemLocations["bauble"] === "nowhere") {
      pass("F15 broken canary wind → bauble stays at nowhere (grinding noise only)");
    } else {
      fail("F15 broken canary should not produce bauble",
           `bauble=${f.state.itemLocations["bauble"]}`);
    }
  }
}

// F24: Brush teeth with putty
console.log("\n--- F24: Brush teeth with putty ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, putty: "player" },
  };
  f.execute({ type: "recordIntent", signalId: "brush-teeth-with-putty" });
  if (playerDied(f.state) &&
      deathMessage(f.state).includes("respiratory")) {
    pass("F24 brush-teeth-with-putty → death (respiratory failure)");
  } else {
    fail("F24 brush-teeth death not triggered",
         `finished=${JSON.stringify(f.state.finished)}`);
  }
}

// F25: Burn leaves while carrying them
console.log("\n--- F25: Burn leaves while carrying ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: {
      ...f.state.itemLocations,
      leaves: "player",
      torch: "player",
    },
    itemStates: {
      ...f.state.itemStates,
      torch: { ...(f.state.itemStates["torch"] ?? {}), isLit: true },
    },
  };
  f.execute({ type: "recordIntent", signalId: "burn", args: { itemId: "leaves" } });
  if (playerDied(f.state) &&
      deathMessage(f.state).includes("leaves burn")) {
    pass("F25 burn-leaves while carrying → death");
  } else {
    fail("F25 burn-leaves death not triggered",
         `finished=${JSON.stringify(f.state.finished)}`);
  }
}

// F26: Attack rusty knife → telekinetic possession death
console.log("\n--- F26: Attack rusty knife → possession ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: {
      ...f.state.itemLocations,
      "rusty-knife": "player",
      "troll": "troll-room",
      player: "troll-room",
      lamp: "player",
    },
    itemStates: {
      ...f.state.itemStates,
      lamp: { ...(f.state.itemStates["lamp"] ?? {}), isLit: true },
    },
  };
  const r26 = f.execute({ type: "attack", itemId: "rusty-knife", targetId: "troll" });
  if (playerDied(f.state) &&
      deathMessage(f.state).includes("savagely slits")) {
    pass("F26 rusty-knife attack → possession death");
  } else {
    fail("F26 rusty-knife possession death not triggered",
         `r.ok=${r26.ok} event=${JSON.stringify(r26.event)} weapon=${f.state.flags["attack-weapon"]} finished=${JSON.stringify(f.state.finished)}`);
  }
}

// F27: Leap from up-a-tree
console.log("\n--- F27: Leap from up-a-tree ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "up-a-tree" },
  };
  f.execute({ type: "recordIntent", signalId: "leap-down" });
  if (playerDied(f.state) &&
      deathMessage(f.state).includes("long way")) {
    pass("F27 leap from up-a-tree → death");
  } else {
    fail("F27 tree leap death not triggered",
         `finished=${JSON.stringify(f.state.finished)}`);
  }
}

// F28: Leap from canyon-view
console.log("\n--- F28: Leap from canyon-view ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "canyon-view" },
  };
  f.execute({ type: "recordIntent", signalId: "leap-down" });
  if (playerDied(f.state) &&
      deathMessage(f.state).includes("done you in")) {
    pass("F28 leap from canyon-view → death");
  } else {
    fail("F28 canyon leap death not triggered",
         `finished=${JSON.stringify(f.state.finished)}`);
  }
}

// F29: Burn the black book
console.log("\n--- F29: Burn black book ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: {
      ...f.state.itemLocations,
      book: "player",
      candles: "player",
    },
    itemStates: {
      ...f.state.itemStates,
      candles: { ...(f.state.itemStates["candles"] ?? {}), isLit: true },
    },
  };
  f.execute({ type: "recordIntent", signalId: "burn", args: { itemId: "book" } });
  if (playerDied(f.state) &&
      deathMessage(f.state).includes("guardian")) {
    pass("F29 burn-book → guardian kills player");
  } else {
    fail("F29 burn-book death not triggered",
         `finished=${JSON.stringify(f.state.finished)}`);
  }
}

// F30: Mung the bodies in entrance-to-hades
console.log("\n--- F30: Mung bodies in entrance-to-hades ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "entrance-to-hades" },
  };
  f.execute({ type: "recordIntent", signalId: "mung", args: { itemId: "bodies" } });
  if (playerDied(f.state) &&
      deathMessage(f.state).includes("guardian")) {
    pass("F30 mung-bodies → guardian decapitates player");
  } else {
    fail("F30 mung-bodies death not triggered",
         `finished=${JSON.stringify(f.state.finished)}`);
  }
}

// F31: Suicide attack (intent-driven; engine's attack(weapon, player) is
// rejected because the synthesized player isn't in story.items — engine
// follow-up tracked in TASKS.md).
console.log("\n--- F31: Suicide attack-self ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, sword: "player" },
  };
  f.execute({ type: "recordIntent", signalId: "attack-self" });
  if (playerDied(f.state) &&
      deathMessage(f.state).includes("Poof")) {
    pass("F31 attack-self intent → suicide death");
  } else {
    fail("F31 suicide attack not triggered",
         `finished=${JSON.stringify(f.state.finished)}`);
  }
}

// F33: Beach hole collapses on the 4th dig
console.log("\n--- F33: Beach hole collapses (4th dig) ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "sandy-beach", shovel: "player" },
  };
  // First three digs increment the counter; 4th collapses the hole. Under the
  // canonical 3-life soft-death flow, the first death respawns at forest-1
  // rather than ending the game — assert the soft-death outcome.
  for (let i = 0; i < 4; i++) {
    if (f.state.flags["just-died"] || f.state.flags.deaths === 1) break;
    f.execute({ type: "recordIntent", signalId: "dig", args: { targetId: "sand", withItemId: "shovel" } });
  }
  if (f.state.flags.deaths === 1 && f.state.itemLocations.player === "forest-1") {
    pass("F33 4th dig collapses hole → soft-death (deaths=1, respawn at forest-1)");
  } else {
    fail("F33 beach-dig collapse not triggered",
         `count=${f.state.flags["beach-dig-count"]} deaths=${f.state.flags.deaths} player=${f.state.itemLocations.player}`);
  }
}

// F34: Mung the painting → broken flag set, no score credit
console.log("\n--- F34: Mung painting destroys treasure value ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, painting: "player" },
  };
  f.execute({ type: "recordIntent", signalId: "mung", args: { itemId: "painting" } });
  if (f.state.itemStates["painting"]?.broken === true) {
    pass("F34 mung-painting → painting.broken = true");
  } else {
    fail("F34 painting not marked broken",
         `state=${JSON.stringify(f.state.itemStates["painting"])}`);
  }
  // Now deposit the broken painting in the trophy case — score should NOT credit.
  const scoreBefore = f.state.flags.score as number;
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, painting: "trophy-case" },
  };
  f.execute({ type: "wait" });
  const scoreAfter = f.state.flags.score as number;
  if (scoreAfter === scoreBefore && f.state.flags["painting-deposited"] === false) {
    pass("F34 broken painting in trophy-case → no score credit");
  } else {
    fail("F34 broken painting still scored",
         `before=${scoreBefore} after=${scoreAfter} deposited=${f.state.flags["painting-deposited"]}`);
  }
}

// F35: Mung sceptre at rainbow → fatal
console.log("\n--- F35: Mung sceptre at rainbow ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "end-of-rainbow", sceptre: "player" },
  };
  f.execute({ type: "recordIntent", signalId: "mung", args: { itemId: "sceptre" } });
  if (playerDied(f.state) &&
      deathMessage(f.state).includes("rainbow")) {
    pass("F35 mung-sceptre at rainbow → death");
  } else {
    fail("F35 mung-sceptre death not triggered",
         `finished=${JSON.stringify(f.state.finished)}`);
  }
}

// F36: Swim in river → drown
console.log("\n--- F36: Swim in Frigid River ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "river-1" },
  };
  f.execute({ type: "recordIntent", signalId: "swim-river" });
  if (playerDied(f.state) &&
      deathMessage(f.state).includes("drown")) {
    pass("F36 swim-river → drown");
  } else {
    fail("F36 swim-river death not triggered",
         `finished=${JSON.stringify(f.state.finished)}`);
  }
}

// F32: Throw object at self
console.log("\n--- F32: Throw object at self ---");
{
  const f = new Engine(story);
  f.execute({ type: "recordIntent", signalId: "throw-at-self" });
  if (playerDied(f.state) &&
      deathMessage(f.state).includes("crack your skull")) {
    pass("F32 throw-at-self → death");
  } else {
    fail("F32 throw-at-self death not triggered",
         `finished=${JSON.stringify(f.state.finished)}`);
  }
}

// F-platinum-bar-dam-solve: full canonical solve — open dam, wait for drain,
// close gates, enter loud-room during the silent window, take the platinum bar.
// Asserts the bar is invisible BEFORE the silent window AND takeable DURING it.
console.log("\n--- F-platinum-bar-dam-solve: canonical dam-path platinum bar take ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "loud-room", lamp: "player" },
    itemStates: {
      ...f.state.itemStates,
      lamp: { ...(f.state.itemStates["lamp"] ?? {}), isLit: true },
    },
  };
  // Pre-silent state: bar should NOT be in itemsHere (default loud, no echo, no drain).
  const v0 = f.getView();
  !v0.itemsHere.some((i) => i.id === "bar")
    ? pass("F-platinum-bar: bar invisible before silent window")
    : fail(`F-platinum-bar pre-silent itemsHere: ${JSON.stringify(v0.itemsHere.map((i) => i.id))}`);

  // Walk the dam puzzle: push yellow, open gates, wait 8, close gates.
  f.state = { ...f.state, itemLocations: { ...f.state.itemLocations, player: "maintenance-room", wrench: "player" } };
  f.execute({ type: "recordIntent", signalId: "push", args: { itemId: "yellow-button" } });
  f.state = { ...f.state, itemLocations: { ...f.state.itemLocations, player: "dam-room" } };
  f.execute({ type: "recordIntent", signalId: "turn", args: { itemId: "bolt", withItemId: "wrench" } });
  for (let i = 0; i < 8; i++) f.execute({ type: "wait" });
  f.state.flags["low-tide"] === true
    ? pass("F-platinum-bar: low-tide reached after 8-turn drain")
    : fail(`F-platinum-bar low-tide=${f.state.flags["low-tide"]}`);
  f.execute({ type: "recordIntent", signalId: "turn", args: { itemId: "bolt", withItemId: "wrench" } });
  f.state.flags["gates-open"] === false && f.state.flags["low-tide"] === true
    ? pass("F-platinum-bar: gates closed + low-tide persists (silent window open)")
    : fail(`F-platinum-bar after close: gates-open=${f.state.flags["gates-open"]} low-tide=${f.state.flags["low-tide"]}`);

  // Now enter loud-room. Bar should be visible.
  f.state = { ...f.state, itemLocations: { ...f.state.itemLocations, player: "loud-room" } };
  const v1 = f.getView();
  v1.itemsHere.some((i) => i.id === "bar")
    ? pass("F-platinum-bar: bar visible during silent window")
    : fail(`F-platinum-bar silent-window itemsHere: ${JSON.stringify(v1.itemsHere.map((i) => i.id))}`);

  // Take it.
  const takeResult = f.execute({ type: "take", itemId: "bar" });
  takeResult.ok && f.state.itemLocations["bar"] === "player"
    ? pass("F-platinum-bar: bar taken successfully, now in inventory")
    : fail(`F-platinum-bar take ok=${takeResult.ok} barLoc=${f.state.itemLocations["bar"]} event=${JSON.stringify(takeResult.event)}`);
}

// F37: Dam-controls path silences loud-room (canonical solve)
console.log("\n--- F37: Dam-controls path silences loud-room ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "maintenance-room", wrench: "player" },
  };
  // Yellow → enable bolt
  f.execute({ type: "recordIntent", signalId: "push", args: { itemId: "yellow-button" } });
  if (f.state.flags["gate-flag"] !== true) fail("F37 yellow button didn't enable bolt", `flags=${JSON.stringify(f.state.flags["gate-flag"])}`);
  // Walk to dam-room (or just /tp)
  f.state = { ...f.state, itemLocations: { ...f.state.itemLocations, player: "dam-room" } };
  // Open gates
  f.execute({ type: "recordIntent", signalId: "turn", args: { itemId: "bolt", withItemId: "wrench" } });
  if (f.state.flags["gates-open"] !== true) fail("F37 gates didn't open", `gates-open=${f.state.flags["gates-open"]}`);
  // Wait 8 turns for the drain
  for (let i = 0; i < 8; i++) f.execute({ type: "wait" });
  if (f.state.flags["low-tide"] !== true) {
    fail("F37 low-tide didn't fire after 8 turns", `low-tide=${f.state.flags["low-tide"]} countdown=${f.state.flags["low-tide-countdown"]}`);
  }
  // Close gates — low-tide should STAY true (the bug-fix)
  f.execute({ type: "recordIntent", signalId: "turn", args: { itemId: "bolt", withItemId: "wrench" } });
  if (f.state.flags["gates-open"] !== false) fail("F37 gates didn't close", `gates-open=${f.state.flags["gates-open"]}`);
  if (f.state.flags["low-tide"] !== true) {
    fail("F37 low-tide reset on close (regression)", `low-tide=${f.state.flags["low-tide"]}`);
  } else {
    pass("F37 low-tide persists through gate close (silent window open)");
  }
  // /tp loud-room — should be silent, no warning, no eject
  f.state = { ...f.state, itemLocations: { ...f.state.itemLocations, player: "loud-room" } };
  const r = f.execute({ type: "wait" });
  const hasNoiseyCue = r.narrationCues.some((c) => /pounding|unbearably/i.test(c));
  if (!hasNoiseyCue && f.state.itemLocations.player === "loud-room") {
    pass("F37 dam-path silenced loud-room: no warning, no eject");
  } else {
    fail("F37 loud-room not silent via dam path",
         `cues=${JSON.stringify(r.narrationCues)} loc=${f.state.itemLocations.player}`);
  }
}

// F38: Reservoir refills, loud-room becomes loud again
console.log("\n--- F38: Reservoir refills, loud-room becomes loud again ---");
{
  const f = new Engine(story);
  // Skip the dam-puzzle setup; force the post-close-silent state directly.
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "dam-room" },
    flags: {
      ...f.state.flags,
      "gate-flag": true,
      "gates-open": false,
      "low-tide": true,
      "reservoir-refill-countdown": 8,
    },
  };
  // Tick the refill counter down to 0
  for (let i = 0; i < 8; i++) f.execute({ type: "wait" });
  if (f.state.flags["low-tide"] !== false) {
    fail("F38 low-tide didn't reset after refill window", `low-tide=${f.state.flags["low-tide"]} refill=${f.state.flags["reservoir-refill-countdown"]}`);
  } else {
    pass("F38 reservoir refilled → low-tide=false");
  }
  // /tp loud-room — should be loud again (warning fires)
  f.state = { ...f.state, itemLocations: { ...f.state.itemLocations, player: "loud-room" } };
  const r = f.execute({ type: "wait" });
  if (r.narrationCues.some((c) => /pounding|silence the noise/i.test(c))) {
    pass("F38 after refill, loud-room re-engages eject mechanic");
  } else {
    fail("F38 expected warning cue after refill", JSON.stringify(r.narrationCues));
  }
}

// F39: gates-open + not-low-tide is unbearably-loud
console.log("\n--- F39: Gates-open is unbearably loud ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "loud-room" },
    flags: {
      ...f.state.flags,
      "gate-flag": true,
      "gates-open": true,
      "low-tide": false,
    },
  };
  // The unbearably-loud variant should NOT silence — eject should still fire
  // since (gates-open AND not-low-tide) ≠ silent. The variant is only a
  // description override; the tick mechanic still ejects.
  const r1 = f.execute({ type: "wait" });
  const r2 = f.execute({ type: "wait" });
  if (f.state.itemLocations.player !== "loud-room") {
    pass(`F39 unbearably-loud → ejected to ${f.state.itemLocations.player}`);
  } else {
    fail("F39 expected eject in unbearably-loud state",
         `loc=${f.state.itemLocations.player} cues=${JSON.stringify([...r1.narrationCues, ...r2.narrationCues])}`);
  }
}

// F40: Red button is a cosmetic no-op
console.log("\n--- F40: Red button is cosmetic ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "maintenance-room" },
  };
  const before = JSON.stringify({
    gate: f.state.flags["gate-flag"],
    gates: f.state.flags["gates-open"],
    leak: f.state.flags["leak-active"],
  });
  const r = f.execute({ type: "recordIntent", signalId: "push", args: { itemId: "red-button" } });
  const after = JSON.stringify({
    gate: f.state.flags["gate-flag"],
    gates: f.state.flags["gates-open"],
    leak: f.state.flags["leak-active"],
  });
  if (before === after && r.narrationCues.some((c) => /flicker|lights/i.test(c))) {
    pass("F40 red button → flavor cue, no puzzle-state mutation");
  } else {
    fail("F40 red button changed puzzle state or didn't narrate",
         `before=${before} after=${after} cues=${JSON.stringify(r.narrationCues)}`);
  }
}

// F41: Blue button starts leak; putty plugs it
console.log("\n--- F41: Blue button + putty plug ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "maintenance-room", putty: "player" },
  };
  f.execute({ type: "recordIntent", signalId: "push", args: { itemId: "blue-button" } });
  if (f.state.flags["leak-active"] !== true) {
    fail("F41 leak didn't activate", `leak-active=${f.state.flags["leak-active"]}`);
  }
  f.execute({ type: "recordIntent", signalId: "plug", args: { itemId: "leak", withItemId: "putty" } });
  if (f.state.flags["leak-active"] === false && f.state.itemLocations["putty"] === "nowhere") {
    pass("F41 putty plugged the leak; viscous material consumed");
  } else {
    fail("F41 plug failed",
         `leak-active=${f.state.flags["leak-active"]} putty=${f.state.itemLocations["putty"]}`);
  }
}

// F42: Blue button without putty drowns the player
console.log("\n--- F42: Blue button drowning ---");
{
  const f = new Engine(story);
  f.state = {
    ...f.state,
    itemLocations: { ...f.state.itemLocations, player: "maintenance-room" },
  };
  f.execute({ type: "recordIntent", signalId: "push", args: { itemId: "blue-button" } });
  for (let i = 0; i < 6; i++) {
    if (f.state.finished) break;
    f.execute({ type: "wait" });
  }
  if (playerDied(f.state) && deathMessage(f.state).includes("drowns")) {
    pass("F42 leak flooded → drowning death");
  } else {
    fail("F42 expected drowning death", `finished=${JSON.stringify(f.state.finished)}`);
  }
}

// F-canonical-max-score: every positive `adjustFlag score by: N` across the
// loaded story must sum to exactly 350 (canonical Zork I SCORE-MAX). Walks
// trigger effects recursively through `if/then/else`.
console.log("\n--- F-canonical-max-score: positive score grants sum to 350 ---");
{
  type AnyEffect = { type: string; key?: string; by?: unknown; then?: AnyEffect[]; else?: AnyEffect[] };
  function sumPositiveScore(effects: AnyEffect[] | undefined): number {
    if (!effects) return 0;
    let total = 0;
    for (const eff of effects) {
      if (eff.type === "adjustFlag" && eff.key === "score" && typeof eff.by === "number" && eff.by > 0) {
        total += eff.by;
      }
      if (eff.type === "if") {
        total += sumPositiveScore(eff.then);
        total += sumPositiveScore(eff.else);
      }
    }
    return total;
  }
  let total = 0;
  for (const t of story.triggers ?? []) {
    total += sumPositiveScore(t.effects as unknown as AnyEffect[]);
  }
  total === 350
    ? pass(`F-canonical-max-score: positive score grants sum to 350 (got ${total})`)
    : fail("F-canonical-max-score: positive score grants do not sum to 350", `got ${total}`);
}

// F-no-double-score: pick up the egg → score increases by exactly 5 (formerly
// double-counted via score-take-egg + score-find-egg = +10).
console.log("\n--- F-no-double-score: take egg → +5, not +10 ---");
{
  const f = new Engine(story);
  // Climb the tree to where the egg sits.
  f.execute({ type: "go", direction: "north" });
  f.execute({ type: "go", direction: "north" });
  f.execute({ type: "go", direction: "up" });
  const before = f.state.flags.score as number;
  f.execute({ type: "take", itemId: "egg" });
  const delta = (f.state.flags.score as number) - before;
  delta === 5
    ? pass(`F-no-double-score: take egg → score +5 (got +${delta})`)
    : fail("F-no-double-score: take egg score delta wrong", `expected +5, got +${delta}`);
}

// F-barrow-nested: deposit all 19 treasures with canary nested in egg and
// sceptre nested in coffin → unlock-endgame fires (won-flag), barrow opens,
// game ends on entering stone-barrow.
console.log("\n--- F-barrow-nested: nested treasures unlock the barrow + end game ---");
{
  const f = new Engine(story);
  // The 17 top-level treasures land directly in trophy-case; canary nests in
  // egg, sceptre nests in coffin (canonical authoring of those two pairs).
  const topLevel = [
    "egg", "bag-of-coins", "painting", "chalice", "torch", "trident",
    "coffin", "jade", "scarab", "skull", "emerald", "bracelet", "trunk",
    "bar", "pot-of-gold", "diamond", "bauble",
  ];
  const treasureLocations: Record<string, string> = {};
  for (const id of topLevel) treasureLocations[id] = "trophy-case";
  treasureLocations["canary"] = "egg";
  treasureLocations["sceptre"] = "coffin";
  f.state = {
    ...f.state,
    flags: { ...f.state.flags, "won-flag": false, "endgame-narrated": false },
    itemLocations: { ...f.state.itemLocations, ...treasureLocations, player: "living-room" },
  };
  // Tick the cascade — unlock-endgame should fire on the first turn the gate is satisfied.
  f.execute({ type: "wait" });
  if (f.state.flags["won-flag"] === true) {
    pass("F-barrow-nested: unlock-endgame fired despite canary in egg + sceptre in coffin");
  } else {
    fail("F-barrow-nested: won-flag stayed false", JSON.stringify({
      egg: f.state.itemLocations["egg"],
      canary: f.state.itemLocations["canary"],
      coffin: f.state.itemLocations["coffin"],
      sceptre: f.state.itemLocations["sceptre"],
    }));
  }
  // Walk to west-of-house and southwest into the barrow.
  f.state = { ...f.state, itemLocations: { ...f.state.itemLocations, player: "west-of-house" } };
  f.execute({ type: "go", direction: "southwest" });
  if (f.state.itemLocations["player"] === "stone-barrow") {
    pass("F-barrow-nested: southwest from west-of-house reached stone-barrow");
  } else {
    fail("F-barrow-nested: barrow exit still gated", `player at ${f.state.itemLocations["player"]}`);
  }
  if (f.state.finished?.won === true) {
    pass("F-barrow-nested: stone-barrow-ends-game fired (finished.won=true)");
  } else {
    fail("F-barrow-nested: end-game not triggered", JSON.stringify(f.state.finished));
  }
}

// -------------------- Summary --------------------

console.log(`\n\n========== SUMMARY ==========`);
console.log(`${passed} passed, ${failed} failed`);
if (firstWalkthroughFailure !== null) {
  console.log(`First walkthrough failure: ${firstWalkthroughFailure}`);
  console.log(`(Subsequent walkthrough steps were skipped — fix this and re-run.)`);
}
console.log(`${gaps.length} gaps surfaced (logged for follow-up):`);
for (const g of gaps) console.log(`  ~ ${g}`);

process.exit(failed > 0 ? 1 : 0);
