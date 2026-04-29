// Sword glow tier tests. Mirrors canonical Zork I I-SWORD daemon behavior:
//   - bright when a hostile is in the player's current room
//   - faint when a hostile is in any directly-adjacent room (one hop)
//   - none otherwise
//
// Glow is surfaced via Item.variants on the sword — first-match, so the
// bright variant takes precedence over the faint variant when both apply.
//
// Run: npx tsx scripts/smoke-sword-glow.ts

import { Engine } from "../src/engine/engine";
import zork from "../src/stories/zork-1.json" with { type: "json" };
import type { Story } from "../src/story/schema";
import { resolveItemDescription, itemById } from "../src/engine/state";

let passed = 0;
let failed = 0;
function pass(label: string) { console.log(`  ✓ ${label}`); passed++; }
function fail(label: string, detail?: string) {
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  failed++;
}

const story = zork as unknown as Story;
const sword = itemById(story, "sword")!;

function describe(e: Engine): string {
  return resolveItemDescription(sword, e.state, e.story);
}

// ----- Tier 0: no danger -----
console.log("\n=== Tier 0: no glow (no hostile in current/adjacent rooms) ===");
{
  const e = new Engine(story);
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "west-of-house", sword: "player" },
  };
  const desc = describe(e);
  if (!desc.includes("glowing")) {
    pass("at west-of-house with sword in inventory: base description (no glow)");
  } else {
    fail("expected no glow", desc);
  }
}

// ----- Tier 1: faint glow (hostile one room away) -----
console.log("\n=== Tier 1: faint glow (hostile in adjacent room) ===");
{
  const e = new Engine(story);
  // cellar.up = troll-room. Place player at cellar with sword; troll already
  // at troll-room with state.hostile=true (default startState).
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "cellar", sword: "player" },
  };
  const desc = describe(e);
  if (desc.includes("faint blue light")) {
    pass("at cellar (one room from troll-room): faint blue glow");
  } else {
    fail("expected faint blue glow", desc);
  }
}

// ----- Tier 2: bright glow (hostile in current room) -----
console.log("\n=== Tier 2: bright glow (hostile in current room) ===");
{
  const e = new Engine(story);
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "troll-room", sword: "player" },
  };
  const desc = describe(e);
  if (desc.includes("very brightly")) {
    pass("at troll-room with troll present: glowing very brightly");
  } else {
    fail("expected very brightly", desc);
  }
}

// ----- Tier precedence: bright wins over faint when both apply -----
console.log("\n=== Tier precedence: bright wins when troll is also in adjacent room ===");
{
  const e = new Engine(story);
  // Player at troll-room (bright). cellar (south exit) → put a second hostile
  // there to ensure adjacent check would also trigger. Use thief — flag hostile.
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "troll-room", sword: "player", thief: "cellar" },
    itemStates: {
      ...e.state.itemStates,
      thief: { ...(e.state.itemStates["thief"] ?? {}), hostile: true },
    },
  };
  const desc = describe(e);
  if (desc.includes("very brightly")) {
    pass("same-room hostile takes precedence over adjacent-room hostile");
  } else {
    fail("expected bright (precedence over faint)", desc);
  }
}

// ----- Hostile killed: glow drops -----
console.log("\n=== Hostile killed: no glow ===");
{
  const e = new Engine(story);
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "cellar", sword: "player" },
    itemStates: {
      ...e.state.itemStates,
      // Override troll's hostile flag → false (simulating death-cleanup).
      troll: { ...(e.state.itemStates["troll"] ?? {}), hostile: false },
    },
  };
  const desc = describe(e);
  if (!desc.includes("glowing")) {
    pass("troll no longer hostile → adjacent check returns false → no glow");
  } else {
    fail("expected no glow after hostile cleared", desc);
  }
}

// ----- Sword on floor: no glow (variants gate on hasItem) -----
console.log("\n=== Sword not in inventory: no glow ===");
{
  const e = new Engine(story);
  // Sword on floor in troll-room with player at troll-room. The bright variant
  // gates on hasItem(sword); since sword isn't held, the variant doesn't fire.
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "troll-room", sword: "troll-room" },
  };
  const desc = describe(e);
  if (!desc.includes("glowing")) {
    pass("sword on floor with hostile present: no glow (canonical: glow only while held)");
  } else {
    fail("expected no glow when sword is on floor", desc);
  }
}

// ----- Bat triggers glow (canonical ACTORBIT) -----
console.log("\n=== Bat triggers glow (canonical ACTORBIT) ===");
{
  const e = new Engine(story);
  // shaft-room.west = bat-room. Place player at shaft-room with sword.
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "shaft-room", sword: "player" },
  };
  const desc = describe(e);
  if (desc.includes("faint blue light")) {
    pass("at shaft-room (adjacent to bat-room): faint blue glow from bat");
  } else {
    fail("expected faint glow from bat", desc);
  }
}

// ----- Per-turn cue: trigger surfaces glow tier to narrationCues -----
//
// The variants drive the on-demand `examine` description. The
// `sword-glow-tick` afterAction trigger surfaces the glow tier passively
// each turn via the narrationCues channel — that's the path the LLM
// actually sees during play. These cases exercise that channel.
console.log("\n=== Per-turn cue: trigger emits glow narration via cues ===");
{
  const e = new Engine(story);
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "cellar", sword: "player" },
  };
  const r = e.execute({ type: "wait" });
  if (r.narrationCues.some((c) => c.includes("faint blue glow"))) {
    pass("at cellar (one room from troll-room): faint cue in narrationCues");
  } else {
    fail("expected faint cue in narrationCues", JSON.stringify(r.narrationCues));
  }
}

{
  const e = new Engine(story);
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "troll-room", sword: "player" },
  };
  const r = e.execute({ type: "wait" });
  if (r.narrationCues.some((c) => c.includes("very brightly"))) {
    pass("at troll-room: bright cue in narrationCues");
  } else {
    fail("expected bright cue in narrationCues", JSON.stringify(r.narrationCues));
  }
}

{
  const e = new Engine(story);
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "west-of-house", sword: "player" },
  };
  const r = e.execute({ type: "wait" });
  if (!r.narrationCues.some((c) => c.includes("glow"))) {
    pass("at west-of-house (no hostile in range): no glow cue");
  } else {
    fail("expected no glow cue", JSON.stringify(r.narrationCues));
  }
}

{
  // Sword not held → trigger gated on hasItem(sword) → no cue even when
  // standing on a hostile.
  const e = new Engine(story);
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "troll-room", sword: "troll-room" },
  };
  const r = e.execute({ type: "wait" });
  if (!r.narrationCues.some((c) => c.includes("glow"))) {
    pass("sword on floor with hostile present: no cue (trigger gated on hasItem)");
  } else {
    fail("expected no cue when sword not held", JSON.stringify(r.narrationCues));
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
