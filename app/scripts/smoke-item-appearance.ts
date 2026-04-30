// Item appearance + description diff-cache smoke tests.
//
// Verifies the per-turn item-description model:
//   - appearance is always surfaced for visible items that have one
//   - description is surfaced ONLY when the player has previously examined
//     this item AND its current resolved examine text differs from cache
//   - examine action populates both caches
//   - cache updates persist across turns
//
// Run: npx tsx scripts/smoke-item-appearance.ts

import { Engine } from "../src/engine/engine";
import zork from "../src/stories/zork-1.json" with { type: "json" };
import type { Story } from "../src/story/schema";

let passed = 0;
let failed = 0;
function pass(label: string) { console.log(`  ✓ ${label}`); passed++; }
function fail(label: string, detail?: string) {
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  failed++;
}

const story = zork as unknown as Story;

function findItem(view: ReturnType<Engine["getView"]>, id: string) {
  return view.itemsHere.find((i) => i.id === id);
}

// ----- Test 1: First visit surfaces appearance, no description -----
console.log("\n=== First visit: appearance surfaces, description does not ===");
{
  const e = new Engine(story);
  // /tp dam-room (need wrench in inventory for the buttons to be reachable
  // contextually — but here we just check view shape).
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "dam-room" },
  };
  e.execute({ type: "wait" });   // commits any cache deltas
  const v = e.getView();
  const bubble = findItem(v, "bubble");
  if (bubble?.appearance && bubble.appearance.includes("green glass bubble")) {
    pass("dam-room first visit: bubble.appearance is surfaced");
  } else {
    fail("expected bubble.appearance", JSON.stringify(bubble));
  }
  if (bubble?.description === undefined) {
    pass("dam-room first visit: bubble.description NOT surfaced (player hasn't examined yet)");
  } else {
    fail("description should be omitted before examine", bubble?.description);
  }
}

// ----- Test 2: Subsequent visit at same state — silent (no re-surface) -----
console.log("\n=== Subsequent visit, same state: no re-surface ===");
{
  const e = new Engine(story);
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "dam-room" },
  };
  // First wait commits cache.
  e.execute({ type: "wait" });
  // Walk away and back without state change.
  e.state = { ...e.state, itemLocations: { ...e.state.itemLocations, player: "dam-lobby" } };
  e.execute({ type: "wait" });
  e.state = { ...e.state, itemLocations: { ...e.state.itemLocations, player: "dam-room" } };
  e.execute({ type: "wait" });
  // Cache should match current; appearance should NOT re-surface (since
  // it's identical to last time, but we always include it in the view —
  // re-surface is signaled by the cache being stale, which it isn't here).
  // The diff-cache only matters for description. Appearance is always shown.
  const v = e.getView();
  const bubble = findItem(v, "bubble");
  // Appearance should still be present (it's the always-on room presence).
  if (bubble?.appearance) {
    pass("re-visit: appearance still surfaced (always-on room presence)");
  } else {
    fail("appearance should still be present on re-visit");
  }
  // description should still be absent (still no examine).
  if (bubble?.description === undefined) {
    pass("re-visit: description still absent (no examine yet)");
  } else {
    fail("description should be absent before any examine");
  }
}

// ----- Test 3: Examine populates the cache -----
console.log("\n=== Examine populates examine cache ===");
{
  const e = new Engine(story);
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "dam-room" },
  };
  e.execute({ type: "examine", itemId: "bubble" });
  if (e.state.lastExamineShown["bubble"]) {
    pass(`examine bubble → cache populated (${e.state.lastExamineShown["bubble"].slice(0, 40)}...)`);
  } else {
    fail("examine did not populate lastExamineShown cache");
  }
}

// ----- Test 4: State change after examine surfaces description -----
console.log("\n=== State change after examine: description re-surfaces ===");
{
  const e = new Engine(story);
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "dam-room" },
  };
  // Examine bubble at gate-flag=false (cache stores "currently dark…")
  e.execute({ type: "examine", itemId: "bubble" });
  const cachedBefore = e.state.lastExamineShown["bubble"];
  // Flip gate-flag (yellow button equivalent) by setting flag directly
  e.state = {
    ...e.state,
    flags: { ...e.state.flags, "gate-flag": true },
  };
  // Walk away and back so the view is rebuilt
  e.state = { ...e.state, itemLocations: { ...e.state.itemLocations, player: "dam-lobby" } };
  e.execute({ type: "wait" });
  e.state = { ...e.state, itemLocations: { ...e.state.itemLocations, player: "dam-room" } };
  const r = e.execute({ type: "wait" });
  const bubble = findItem(r.view, "bubble");
  if (bubble?.description && bubble.description.includes("glowing steadily")) {
    pass("state changed since cache → bubble.description surfaces in view");
  } else {
    fail("expected description to surface after state change",
         `cached=${cachedBefore?.slice(0, 30)} now=${JSON.stringify(bubble)}`);
  }
  // After surfacing, cache should be updated to the new text.
  if (e.state.lastExamineShown["bubble"] === bubble?.description) {
    pass("cache updated to new description after surface");
  } else {
    fail("cache did not catch up to new description");
  }
}

// ----- Test 5: Same state next turn — silent again -----
console.log("\n=== Same state next turn: silent again ===");
{
  const e = new Engine(story);
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "dam-room" },
    flags: { ...e.state.flags, "gate-flag": true },
  };
  // Examine bubble — cache populated with glowing-steadily text.
  e.execute({ type: "examine", itemId: "bubble" });
  // Wait — same state, no diff.
  const r = e.execute({ type: "wait" });
  const bubble = findItem(r.view, "bubble");
  if (bubble?.description === undefined) {
    pass("same state next turn: description NOT re-surfaced");
  } else {
    fail("description should not re-surface when state unchanged",
         `description=${bubble.description}`);
  }
}

// ----- Test 6: Item without appearance — no appearance field -----
console.log("\n=== Item without appearance — no appearance field ===");
{
  const e = new Engine(story);
  // Find an item that has no appearance authored (e.g., something simple)
  // Actually since we authored appearance for bubble, sword, lamp etc.,
  // pick an item we know we did NOT add appearance to.
  // Trophy-case has appearance now; mailbox has appearance now.
  // Pick `keys` or some less-common item.
  const candidate = story.items.find((i) => !i.appearance && !i.fixed);
  if (!candidate) {
    pass("(no items without appearance — phase 1+ complete)");
  } else {
    e.state = {
      ...e.state,
      itemLocations: { ...e.state.itemLocations, player: candidate.location, [candidate.id]: candidate.location },
    };
    e.execute({ type: "wait" });
    const v = e.getView();
    const found = findItem(v, candidate.id);
    if (found && found.appearance === undefined) {
      pass(`item ${candidate.id} (no authored appearance) → ItemView.appearance is undefined`);
    } else {
      fail(`expected no appearance for ${candidate.id}`, JSON.stringify(found));
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
