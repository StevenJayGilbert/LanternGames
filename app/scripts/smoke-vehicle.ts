// Vehicle primitive smoke tests. Built against zork-1 because we need a real
// story for itemById/roomById lookups, but the assertions are engine-only —
// no boat puzzle content wired yet. We use /tp + /give style direct state
// mutation to set up scenarios.
//
// Run: npx tsx scripts/smoke-vehicle.ts

import { Engine } from "../src/engine/engine";
import zork from "../src/stories/zork-1.json" with { type: "json" };
import type { Story, Item } from "../src/story/schema";
import { evaluateCondition } from "../src/engine/state";

let passed = 0;
let failed = 0;
function pass(label: string) { console.log(`  ✓ ${label}`); passed++; }
function fail(label: string, detail?: string) { console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }

const story = zork as unknown as Story;

// ----- Helpers: inject a vehicle item without re-extracting -----
//
// We monkey-patch a story copy so the inflatable-boat (which has no `vehicle`
// field yet — content not wired) becomes a vehicle for these tests.
function storyWithBoatAsVehicle(): Story {
  const items: Item[] = story.items.map((it) =>
    it.id === "inflatable-boat"
      ? {
          ...it,
          state: { ...(it.state ?? {}), inflation: "inflated" },
          vehicle: { mobile: true },
        }
      : it,
  );
  return { ...story, items };
}

// ----- #11: inventoryHasTag condition -----
console.log("\n=== #11 inventoryHasTag condition ===");
{
  const e = new Engine(story);
  // Player carrying nothing → no weapon
  evaluateCondition({ type: "inventoryHasTag", tag: "weapon" }, e.state, e.story) === false
    ? pass("empty inventory → inventoryHasTag(weapon) is false")
    : fail("expected false");

  // Give sword (sword has weapon tag in extracted story)
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, sword: "inventory" },
  };
  evaluateCondition({ type: "inventoryHasTag", tag: "weapon" }, e.state, e.story) === true
    ? pass("with sword in inventory → inventoryHasTag(weapon) is true")
    : fail("expected true");

  evaluateCondition({ type: "inventoryHasTag", tag: "treasure" }, e.state, e.story) === false
    ? pass("with sword (no treasure) → inventoryHasTag(treasure) is false")
    : fail("expected false");

  // Give a treasure too — bag-of-coins has the treasure tag (added in earlier batch)
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, "bag-of-coins": "inventory" },
  };
  evaluateCondition({ type: "inventoryHasTag", tag: "treasure" }, e.state, e.story) === true
    ? pass("with bag-of-coins → inventoryHasTag(treasure) is true")
    : fail("expected true");
}

// ----- #12: board / disembark engine actions -----
console.log("\n=== #12 board / disembark ===");
{
  const e = new Engine(storyWithBoatAsVehicle());
  // Place player at dam-base where the boat is
  e.state = { ...e.state, playerLocation: "dam-base" };

  // Initial state: not in any vehicle
  e.state.playerVehicle === null
    ? pass("playerVehicle starts null")
    : fail(`playerVehicle = ${e.state.playerVehicle}`);

  // Board the boat
  const r1 = e.execute({ type: "board", itemId: "inflatable-boat" });
  r1.event.type === "boarded" && e.state.playerVehicle === "inflatable-boat"
    ? pass("board sets playerVehicle and emits boarded event")
    : fail(`event=${r1.event.type} playerVehicle=${e.state.playerVehicle}`);

  // Try to board again — should still succeed (re-boarding is idempotent in our impl)
  const r2 = e.execute({ type: "board", itemId: "inflatable-boat" });
  r2.ok ? pass("re-boarding same vehicle succeeds (idempotent)") : fail("re-board rejected");

  // Disembark
  const r3 = e.execute({ type: "disembark" });
  r3.event.type === "disembarked" && e.state.playerVehicle === null
    ? pass("disembark clears playerVehicle and emits disembarked event")
    : fail(`event=${r3.event.type} playerVehicle=${e.state.playerVehicle}`);

  // Disembark while not in vehicle → reject
  const r4 = e.execute({ type: "disembark" });
  !r4.ok && r4.event.type === "rejected" && (r4.event as { reason?: string }).reason === "not-in-vehicle"
    ? pass("disembark while on foot is rejected (not-in-vehicle)")
    : fail(`expected rejected/not-in-vehicle, got ${JSON.stringify(r4.event)}`);
}

// ----- #13: board honors enterableWhen + go() carries mobile vehicle -----
console.log("\n=== #13 enterableWhen + mobile go() ===");
{
  // Mark boat as deflated AND vehicle.enterableWhen requires inflated
  const items: Item[] = story.items.map((it) =>
    it.id === "inflatable-boat"
      ? {
          ...it,
          state: { ...(it.state ?? {}), inflation: "deflated" },
          vehicle: {
            mobile: true,
            enterableWhen: {
              type: "itemState",
              itemId: "inflatable-boat",
              key: "inflation",
              equals: "inflated",
            },
            enterBlockedMessage: "The boat is a deflated pile.",
          },
        }
      : it,
  );
  const customStory: Story = { ...story, items };
  const e = new Engine(customStory);
  e.state = { ...e.state, playerLocation: "dam-base" };

  // Board with deflated → reject
  const r1 = e.execute({ type: "board", itemId: "inflatable-boat" });
  !r1.ok && (r1.event as { reason?: string }).reason === "vehicle-blocked"
    ? pass("board with enterableWhen=false → vehicle-blocked rejection")
    : fail(`expected vehicle-blocked, got ${JSON.stringify(r1.event)}`);

  // Inflate by mutating state (simulates pump+inflate trigger)
  e.state = {
    ...e.state,
    itemStates: {
      ...e.state.itemStates,
      "inflatable-boat": { ...(e.state.itemStates["inflatable-boat"] ?? {}), inflation: "inflated" },
    },
  };

  const r2 = e.execute({ type: "board", itemId: "inflatable-boat" });
  r2.ok ? pass("board with enterableWhen=true → succeeds") : fail("board still blocked");

  // Boat at dam-base; player in boat. Now go(north) — boat should follow.
  const r3 = e.execute({ type: "go", direction: "north" });
  r3.ok &&
    e.state.playerLocation === "dam-room" &&
    e.state.itemLocations["inflatable-boat"] === "dam-room"
    ? pass("mobile vehicle follows player on go()")
    : fail(
        `player=${e.state.playerLocation} boat=${e.state.itemLocations["inflatable-boat"]}`,
      );
}

// ----- #14: stationary vehicle refuses go() -----
console.log("\n=== #14 stationary vehicle refuses go() ===");
{
  // Use mailbox at west-of-house — unconditional exits in all 4 directions,
  // so the vehicle-stationary check is the one that fires (not exit-blocked).
  const items: Item[] = story.items.map((it) =>
    it.id === "mailbox"
      ? {
          ...it,
          vehicle: {
            mobile: false,
            enterBlockedMessage: "You'd have to climb out of the mailbox first.",
          },
        }
      : it,
  );
  const customStory: Story = { ...story, items };
  const e = new Engine(customStory);
  e.state = { ...e.state, playerLocation: "west-of-house" };

  const r1 = e.execute({ type: "board", itemId: "mailbox" });
  r1.ok ? pass("board stationary 'vehicle' (silly but allowed) succeeds") : fail(`board failed: ${JSON.stringify(r1.event)}`);

  const r2 = e.execute({ type: "go", direction: "north" });
  !r2.ok && (r2.event as { reason?: string }).reason === "vehicle-stationary"
    ? pass("go() while in stationary vehicle is rejected (vehicle-stationary)")
    : fail(`expected vehicle-stationary, got ${JSON.stringify(r2.event)}`);
}

// ----- inVehicle Condition -----
console.log("\n=== #14b inVehicle condition ===");
{
  const e = new Engine(storyWithBoatAsVehicle());
  e.state = { ...e.state, playerLocation: "dam-base" };

  evaluateCondition({ type: "inVehicle" }, e.state, e.story) === false
    ? pass("on foot → inVehicle() is false")
    : fail("expected false");

  e.execute({ type: "board", itemId: "inflatable-boat" });

  evaluateCondition({ type: "inVehicle" }, e.state, e.story) === true
    ? pass("in any vehicle → inVehicle() is true")
    : fail("expected true");

  evaluateCondition({ type: "inVehicle", itemId: "inflatable-boat" }, e.state, e.story) === true
    ? pass("in specific vehicle → inVehicle(itemId) matches")
    : fail("expected true");

  evaluateCondition({ type: "inVehicle", itemId: "trophy-case" }, e.state, e.story) === false
    ? pass("not in queried vehicle → inVehicle(other) is false")
    : fail("expected false");
}

// ----- WorldView vehicle field populated -----
console.log("\n=== #14c WorldView.vehicle populated when boarded ===");
{
  const e = new Engine(storyWithBoatAsVehicle());
  e.state = { ...e.state, playerLocation: "dam-base" };

  let v = e.getView();
  v.vehicle === undefined ? pass("on foot: view.vehicle absent") : fail("expected undefined");

  e.execute({ type: "board", itemId: "inflatable-boat" });
  v = e.getView();
  v.vehicle?.id === "inflatable-boat" && v.vehicle.mobile === true
    ? pass("boarded: view.vehicle = { id, mobile, ... }")
    : fail(`view.vehicle = ${JSON.stringify(v.vehicle)}`);
}

// ----- Done -----
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
