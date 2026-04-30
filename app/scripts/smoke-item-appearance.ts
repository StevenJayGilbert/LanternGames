// Item appearance + description gating smoke tests.
//
// Verifies the per-turn item-description model:
//   - appearance is always surfaced for visible items that have one
//   - description is surfaced ONLY for items in state.examinedItems
//     (the player has examined them at least once)
//   - examine action populates examinedItems
//   - description text reflects current resolved state every turn
//
// Per-turn "should we re-show this to the LLM" gating now lives at the
// narrator level (view-string fingerprint), not the view-builder. This
// suite covers the engine/view contract; narrator-level fingerprint
// behavior is exercised by manual playtest.
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

// ----- Test 3: Examine adds item to examinedItems -----
console.log("\n=== Examine populates examinedItems ===");
{
  const e = new Engine(story);
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "dam-room" },
  };
  e.execute({ type: "examine", itemId: "bubble" });
  if (e.state.examinedItems.includes("bubble")) {
    pass("examine bubble → bubble in examinedItems");
  } else {
    fail("examine did not add bubble to examinedItems");
  }
}

// ----- Test 4: After examine + state change, view shows new description -----
console.log("\n=== State change after examine: view reflects current text ===");
{
  const e = new Engine(story);
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "dam-room" },
  };
  // Examine bubble at gate-flag=false (description = "currently dark…").
  e.execute({ type: "examine", itemId: "bubble" });
  // Flip gate-flag so the bubble's variant resolves to "glowing steadily".
  e.state = {
    ...e.state,
    flags: { ...e.state.flags, "gate-flag": true },
  };
  // Rebuild the view via a wait (touches buildView).
  const r = e.execute({ type: "wait" });
  const bubble = findItem(r.view, "bubble");
  if (bubble?.description && bubble.description.includes("glowing steadily")) {
    pass("examined item: description reflects current variant after state change");
  } else {
    fail("expected description to reflect new variant text",
         `bubble=${JSON.stringify(bubble)}`);
  }
}

// ----- Test 5: Examined items always carry description in subsequent views -----
console.log("\n=== After examine, description is always present in view ===");
{
  const e = new Engine(story);
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, player: "dam-room" },
    flags: { ...e.state.flags, "gate-flag": true },
  };
  // Examine bubble.
  e.execute({ type: "examine", itemId: "bubble" });
  // Wait — same state. Description should still be present (gating moved
  // to the narrator-level fingerprint; view-builder always includes it for
  // examined items in current resolved form).
  const r = e.execute({ type: "wait" });
  const bubble = findItem(r.view, "bubble");
  if (bubble?.description && bubble.description.includes("glowing steadily")) {
    pass("examined item: description always present in view (re-show gating moved to narrator)");
  } else {
    fail("examined item should always have description in view",
         `bubble=${JSON.stringify(bubble)}`);
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
