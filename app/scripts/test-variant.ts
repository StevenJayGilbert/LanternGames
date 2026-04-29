// Test that an item or passage variant resolves correctly under a given state.
// Lets you verify what the engine returns for `examine <itemId>` without
// playing the whole game. Add new scenarios at the bottom as you wire variants.
//
// Run: npx tsx scripts/test-variant.ts

import { Engine } from "../src/engine/engine";
import zork from "../src/stories/zork-1.json" with { type: "json" };
import type { Story } from "../src/story/schema";

interface Scenario {
  name: string;
  itemId: string;
  // Mutations applied to a fresh engine before examining the item.
  setup: (e: Engine) => void;
  // Substring(s) the description must contain (case-insensitive).
  expectIncludes?: string[];
  // Substring(s) the description must NOT contain.
  expectExcludes?: string[];
}

function runScenario(scenario: Scenario): { pass: boolean; description: string } {
  const e = new Engine(zork as unknown as Story);
  scenario.setup(e);
  const result = e.execute({ type: "examine", itemId: scenario.itemId });
  const description =
    result.event.type === "examined"
      ? result.event.description
      : `(rejected: ${(result.event as any).reason})`;

  const includesOK = (scenario.expectIncludes ?? []).every((s) =>
    description.toLowerCase().includes(s.toLowerCase()),
  );
  const excludesOK = (scenario.expectExcludes ?? []).every(
    (s) => !description.toLowerCase().includes(s.toLowerCase()),
  );
  return { pass: includesOK && excludesOK, description };
}

function setupSwordCarried(roomId: string) {
  return (e: Engine) => {
    e.state = {
      ...e.state,
      playerLocation: roomId,
      itemLocations: {
        ...e.state.itemLocations,
        sword: "player",
        lamp: "player",
      },
      itemStates: {
        ...e.state.itemStates,
        lamp: { ...(e.state.itemStates.lamp ?? {}), isLit: true },
      },
    };
  };
}

const SCENARIOS: Scenario[] = [
  {
    name: "Sword in troll-room with troll alive (hostile perceivable) → GLOWING",
    itemId: "sword",
    setup: setupSwordCarried("troll-room"),
    expectIncludes: ["glowing", "blue"],
  },
  {
    name: "Sword in west-of-house (no hostile around) → default text, no glow",
    itemId: "sword",
    setup: setupSwordCarried("west-of-house"),
    expectIncludes: ["elvish sword"],
    expectExcludes: ["glowing"],
  },
  {
    name: "Sword in cyclops-room (cyclops is hostile) → GLOWING",
    itemId: "sword",
    setup: setupSwordCarried("cyclops-room"),
    expectIncludes: ["glowing"],
  },
  {
    name: "Sword in troll-room AFTER troll dies (no perceivable hostile) → no glow",
    itemId: "sword",
    setup: (e) => {
      setupSwordCarried("troll-room")(e);
      // Mark troll dead (health <= 0) and remove from room
      e.state = {
        ...e.state,
        itemStates: {
          ...e.state.itemStates,
          troll: { ...(e.state.itemStates.troll ?? {}), health: 0 },
        },
        itemLocations: { ...e.state.itemLocations, troll: "nowhere" },
      };
    },
    expectExcludes: ["glowing"],
  },
];

console.log(`Testing variants for story "${(zork as Story).title}"\n`);

let passed = 0;
let failed = 0;
for (const scenario of SCENARIOS) {
  const { pass, description } = runScenario(scenario);
  const mark = pass ? "✓" : "✗";
  console.log(`${mark} ${scenario.name}`);
  console.log(`  description: ${JSON.stringify(description)}`);
  if (!pass) {
    if (scenario.expectIncludes) console.log(`  expected to include: ${JSON.stringify(scenario.expectIncludes)}`);
    if (scenario.expectExcludes) console.log(`  expected to exclude: ${JSON.stringify(scenario.expectExcludes)}`);
  }
  pass ? passed++ : failed++;
  console.log();
}

console.log(`---`);
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
