// CustomTool handler smoke tests. Exercises the new intent/handler path:
//   - recordIntent stores args
//   - intentArg condition reads them back
//   - Tool handler runs preconditions in order, short-circuits on first
//     failure with its failedNarration, applies effects + emits success
//     narration on the happy path
//   - Args are substituted into Conditions/Effects via {fromArg}
//   - alwaysOnCustomTools / activeConditionalCustomTools split
//
// Run: npx tsx scripts/smoke-handler.ts

import { Engine } from "../src/engine/engine";
import zork from "../src/stories/zork-1.json" with { type: "json" };
import type { Story, CustomTool } from "../src/story/schema";
import { evaluateCondition } from "../src/engine/state";
import { alwaysOnCustomTools, activeConditionalCustomTools } from "../src/engine/intents";

let passed = 0;
let failed = 0;
function pass(label: string) { console.log(`  ✓ ${label}`); passed++; }
function fail(label: string, detail?: string) {
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  failed++;
}

// Build a story copy with a synthetic `open` custom tool. The real "open"
// custom tool from zork-1.json would also work, but using a synthetic id
// ("test-open") keeps the assertions independent of any author triggers
// that might layer on top of the live "open" call.
function storyWithTestTools(): Story {
  const openTool: CustomTool = {
    id: "test-open",
    description: "Test: open an item.",
    args: {
      type: "object",
      properties: { itemId: { type: "string" } },
      required: ["itemId"],
    },
    alwaysAvailable: true,
    handler: {
      preconditions: [
        {
          when: { type: "itemAccessible", itemId: { fromArg: "itemId" } },
          failedNarration: "You don't see {arg.itemId.name} here.",
        },
        {
          when: { type: "itemHasStateKey", itemId: { fromArg: "itemId" }, key: "isOpen" },
          failedNarration: "{arg.itemId.name} isn't something you can open.",
        },
        {
          when: { type: "itemState", itemId: { fromArg: "itemId" }, key: "isOpen", equals: false },
          failedNarration: "{arg.itemId.name} is already open.",
        },
      ],
      effects: [
        { type: "setItemState", itemId: { fromArg: "itemId" }, key: "isOpen", value: true },
      ],
      successNarration: "You open the {arg.itemId.name}.",
    },
  };
  // Conditional tool with no triggers — should never appear in active list.
  const danglingTool: CustomTool = {
    id: "test-dangling",
    description: "No triggers reference this.",
    alwaysAvailable: false,
  };
  return {
    ...(zork as unknown as Story),
    customTools: [openTool, danglingTool],
  };
}

// ----- intentArg condition + recordIntent stores args -----
console.log("\n=== intentArg ===");
{
  const e = new Engine(zork as unknown as Story);
  evaluateCondition(
    { type: "intentArg", signalId: "test-open", key: "itemId", equals: "mailbox" },
    e.state,
    e.story,
  ) === false
    ? pass("intentArg false before any recordIntent")
    : fail("expected false");

  // Manually inject args (skipping the customTool lookup since story doesn't have it).
  e.state = {
    ...e.state,
    matchedIntents: ["test-open"],
    matchedIntentArgs: { "test-open": { itemId: "mailbox" } },
  };
  evaluateCondition(
    { type: "intentArg", signalId: "test-open", key: "itemId", equals: "mailbox" },
    e.state,
    e.story,
  ) === true
    ? pass("intentArg true after recording the matching arg")
    : fail("expected true");
  evaluateCondition(
    { type: "intentArg", signalId: "test-open", key: "itemId", equals: "altar" },
    e.state,
    e.story,
  ) === false
    ? pass("intentArg false for non-matching arg value")
    : fail("expected false");
}

// ----- Handler happy path -----
console.log("\n=== handler happy path ===");
{
  const e = new Engine(storyWithTestTools());
  // mailbox starts at west-of-house, closed. Player is at west-of-house.
  const before = e.state.itemStates["mailbox"]?.isOpen;
  before === false ? pass("mailbox starts closed") : fail(`isOpen=${before}`);

  const r = e.execute({ type: "recordIntent", signalId: "test-open", args: { itemId: "mailbox" } });
  r.ok ? pass("recordIntent ok=true") : fail(`ok=${r.ok}`);
  e.state.itemStates["mailbox"]?.isOpen === true
    ? pass("mailbox.isOpen=true after handler effect")
    : fail(`isOpen=${e.state.itemStates["mailbox"]?.isOpen}`);
  r.narrationCues.some((c) => c.includes("open the small mailbox"))
    ? pass("success narration cue emitted with substituted name")
    : fail(`cues=${JSON.stringify(r.narrationCues)}`);
}

// ----- Handler precondition: not accessible -----
console.log("\n=== handler precondition: not accessible ===");
{
  const e = new Engine(storyWithTestTools());
  // Player at west-of-house; trophy-case is in living-room (not accessible).
  // Trophy case starts closed.
  const before = e.state.itemStates["trophy-case"]?.isOpen;
  before === false ? pass("trophy-case starts closed") : fail(`isOpen=${before}`);
  const r = e.execute({ type: "recordIntent", signalId: "test-open", args: { itemId: "trophy-case" } });
  r.ok ? pass("recordIntent ok=true (handler doesn't reject the call)") : fail("ok=false");
  r.narrationCues.some((c) => c.includes("You don't see") && c.includes("trophy"))
    ? pass("emitted 'don't see trophy case' failure cue")
    : fail(`cues=${JSON.stringify(r.narrationCues)}`);
  e.state.itemStates["trophy-case"]?.isOpen === false
    ? pass("trophy-case stays closed (effect short-circuited)")
    : fail(`unexpected isOpen=${e.state.itemStates["trophy-case"]?.isOpen}`);
}

// ----- Handler precondition: item has no isOpen state key -----
console.log("\n=== handler precondition: not openable ===");
{
  const e = new Engine(storyWithTestTools());
  // Give the player the leaflet (initially in mailbox). Then try to open it.
  // Leaflet has no state.isOpen.
  e.state = {
    ...e.state,
    itemLocations: { ...e.state.itemLocations, "advertisement": "player" },
  };
  const r = e.execute({ type: "recordIntent", signalId: "test-open", args: { itemId: "advertisement" } });
  r.ok ? pass("recordIntent ok=true") : fail("ok=false");
  r.narrationCues.some((c) => c.includes("isn't something you can open"))
    ? pass("emitted 'isn't something you can open' failure cue")
    : fail(`cues=${JSON.stringify(r.narrationCues)}`);
}

// ----- Handler precondition: already open -----
console.log("\n=== handler precondition: already open ===");
{
  const e = new Engine(storyWithTestTools());
  // Pre-open the mailbox. Calling open again should hit the third precondition.
  e.state = {
    ...e.state,
    itemStates: {
      ...e.state.itemStates,
      mailbox: { ...e.state.itemStates["mailbox"], isOpen: true },
    },
  };
  const r = e.execute({ type: "recordIntent", signalId: "test-open", args: { itemId: "mailbox" } });
  r.narrationCues.some((c) => c.includes("already open"))
    ? pass("emitted 'already open' failure cue")
    : fail(`cues=${JSON.stringify(r.narrationCues)}`);
}

// ----- alwaysOn / conditional split (now collapsed for cache stability) -----
console.log("\n=== alwaysOn / conditional split ===");
{
  // The conditional tier has been retired: every custom tool is always-on
  // so the LLM's tool list stays byte-stable across turns and Anthropic's
  // prompt cache survives. alwaysOnCustomTools returns the entire story
  // customTools list regardless of the alwaysAvailable flag;
  // activeConditionalCustomTools always returns [].
  const story = storyWithTestTools();
  const alwaysOn = alwaysOnCustomTools(story);
  alwaysOn.length === 2 &&
  alwaysOn.some((t) => t.id === "test-open") &&
  alwaysOn.some((t) => t.id === "test-dangling")
    ? pass("alwaysOnCustomTools returns ALL custom tools (collapsed tier)")
    : fail(`alwaysOn=${alwaysOn.map((t) => t.id).join(", ")}`);

  const e = new Engine(story);
  const conditional = activeConditionalCustomTools(e.state, e.story);
  conditional.length === 0
    ? pass("activeConditionalCustomTools always returns [] (tier retired)")
    : fail(`conditional=${conditional.map((t) => t.id).join(", ")}`);
}

// ----- Handler also handles passages -----
console.log("\n=== handler: passage open/close ===");
{
  // Use the real customTools from zork-1.json (open/close are alwaysAvailable
  // and operate on items OR passages thanks to the polymorphic preconditions).
  const e = new Engine(zork as unknown as Story);
  // kitchen-window is a passage between east-of-house and kitchen, starts closed.
  e.state = { ...e.state, itemLocations: { ...e.state.itemLocations, player: "east-of-house" } };
  const before = e.state.passageStates["kitchen-window"]?.isOpen;
  before === false ? pass("kitchen-window starts closed") : fail(`isOpen=${before}`);

  const r = e.execute({
    type: "recordIntent",
    signalId: "open",
    args: { itemId: "kitchen-window" },
  });
  r.ok ? pass("recordIntent open(kitchen-window) ok=true") : fail("ok=false");
  e.state.passageStates["kitchen-window"]?.isOpen === true
    ? pass("kitchen-window.isOpen=true after handler effect")
    : fail(`isOpen=${e.state.passageStates["kitchen-window"]?.isOpen}`);
  r.narrationCues.some((c) => c.includes("open the kitchen window"))
    ? pass("success narration with substituted passage name")
    : fail(`cues=${JSON.stringify(r.narrationCues)}`);

  // Close it
  const r2 = e.execute({
    type: "recordIntent",
    signalId: "close",
    args: { itemId: "kitchen-window" },
  });
  e.state.passageStates["kitchen-window"]?.isOpen === false
    ? pass("close handler toggles kitchen-window back to closed")
    : fail(`isOpen=${e.state.passageStates["kitchen-window"]?.isOpen}`);
  void r2;

  // Open from a far-away room → precondition fails
  const e2 = new Engine(zork as unknown as Story);
  e2.state = { ...e2.state, itemLocations: { ...e2.state.itemLocations, player: "west-of-house" } };
  const r3 = e2.execute({
    type: "recordIntent",
    signalId: "open",
    args: { itemId: "kitchen-window" },
  });
  r3.narrationCues.some((c) => c.includes("You don't see"))
    ? pass("open(kitchen-window) from far room → 'don't see' cue")
    : fail(`cues=${JSON.stringify(r3.narrationCues)}`);
  e2.state.passageStates["kitchen-window"]?.isOpen === false
    ? pass("kitchen-window stays closed when not perceivable")
    : fail("isOpen mutated unexpectedly");
}

// ----- narratorNote surfaces in the view -----
console.log("\n=== view: narratorNote on surface items ===");
{
  const e = new Engine(zork as unknown as Story);
  e.state = { ...e.state, itemLocations: { ...e.state.itemLocations, player: "kitchen" } };
  const view = e.getView();
  const kt = view.itemsHere.find((i) => i.id === "kitchen-table");
  kt?.narratorNote?.includes("flat work surface")
    ? pass("kitchen-table view includes narratorNote")
    : fail(`narratorNote missing or wrong: ${JSON.stringify(kt?.narratorNote)}`);
  // Author description should also be the real prose, not the placeholder.
  const examined = e.execute({ type: "examine", itemId: "kitchen-table" });
  examined.event.type === "examined" &&
  (examined.event as { description?: string }).description?.includes("kitchen table")
    ? pass("examine returns the authored description")
    : fail(`examine event: ${JSON.stringify(examined.event)}`);
}

// ----- Surface items refuse close (kitchen-table etc.) -----
console.log("\n=== handler: close refuses on surface containers ===");
{
  const e = new Engine(zork as unknown as Story);
  e.state = { ...e.state, itemLocations: { ...e.state.itemLocations, player: "kitchen" } };
  // kitchen-table has no state.isOpen after the surface override → close
  // handler's itemHasStateKey precondition fails with the right narration.
  const r = e.execute({
    type: "recordIntent",
    signalId: "close",
    args: { itemId: "kitchen-table" },
  });
  r.narrationCues.some((c) => c.includes("isn't something you can close"))
    ? pass("close(kitchen-table) refused with 'isn't something you can close' cue")
    : fail(`cues=${JSON.stringify(r.narrationCues)}`);
  e.state.itemStates["kitchen-table"]?.isOpen === undefined
    ? pass("kitchen-table.isOpen stays undefined (no phantom mutation)")
    : fail(`unexpected isOpen=${e.state.itemStates["kitchen-table"]?.isOpen}`);
}

// ----- Built-in actions record matched intents -----
console.log("\n=== built-in actions: matchedIntents recording ===");
{
  // go(direction) — args.direction is recorded
  const e = new Engine(zork as unknown as Story);
  e.execute({ type: "go", direction: "north" });
  e.state.matchedIntents.includes("go")
    ? pass("matchedIntents includes 'go' after go(direction=north)")
    : fail(`matchedIntents=${JSON.stringify(e.state.matchedIntents)}`);
  e.state.matchedIntentArgs["go"]?.direction === "north"
    ? pass("matchedIntentArgs.go.direction === 'north'")
    : fail(`args=${JSON.stringify(e.state.matchedIntentArgs["go"])}`);

  // take(itemId) — args.itemId is recorded; works on rejected actions too
  // (rock doesn't exist → rejected, but intent still records).
  e.execute({ type: "take", itemId: "leaflet" });
  e.state.matchedIntents.includes("take")
    ? pass("matchedIntents includes 'take' after take(leaflet)")
    : fail(`matchedIntents=${JSON.stringify(e.state.matchedIntents)}`);
  e.state.matchedIntentArgs["take"]?.itemId === "leaflet"
    ? pass("matchedIntentArgs.take.itemId === 'leaflet'")
    : fail(`args=${JSON.stringify(e.state.matchedIntentArgs["take"])}`);

  // wait — no args, just signalId
  e.execute({ type: "wait" });
  e.state.matchedIntents.includes("wait")
    ? pass("matchedIntents includes 'wait' (no-arg action)")
    : fail(`matchedIntents=${JSON.stringify(e.state.matchedIntents)}`);

  // Rejected action still records intent
  const e2 = new Engine(zork as unknown as Story);
  const r = e2.execute({ type: "go", direction: "down" });
  r.event.type === "rejected"
    ? pass("go(down) from west-of-house is rejected (no such direction)")
    : fail(`event=${JSON.stringify(r.event)}`);
  e2.state.matchedIntentArgs["go"]?.direction === "down"
    ? pass("rejected go still records matchedIntentArgs.go.direction='down'")
    : fail(`args=${JSON.stringify(e2.state.matchedIntentArgs["go"])}`);

  // Args supersede on subsequent calls (same signalId, new args)
  e2.execute({ type: "go", direction: "east" });
  e2.state.matchedIntentArgs["go"]?.direction === "east"
    ? pass("subsequent go(east) overwrites args (direction='east')")
    : fail(`args=${JSON.stringify(e2.state.matchedIntentArgs["go"])}`);
}

// ----- removeMatchedIntent clears args -----
console.log("\n=== removeMatchedIntent clears args ===");
{
  const e = new Engine(zork as unknown as Story);
  e.state = {
    ...e.state,
    matchedIntents: ["test-open"],
    matchedIntentArgs: { "test-open": { itemId: "mailbox" } },
  };
  // Apply a removeMatchedIntent effect manually via state mutation to test
  // applyEffect's behavior. Use the engine's applyEffects through a trigger
  // would require a trigger; simpler: call applyEffect directly.
  const { applyEffect } = await import("../src/engine/state");
  e.state = applyEffect(e.state, { type: "removeMatchedIntent", signalId: "test-open" });
  e.state.matchedIntents.includes("test-open") === false
    ? pass("matchedIntents cleared")
    : fail("still in matchedIntents");
  e.state.matchedIntentArgs["test-open"] === undefined
    ? pass("matchedIntentArgs entry cleared")
    : fail(`args still: ${JSON.stringify(e.state.matchedIntentArgs)}`);
}

// ----- <current-room> sentinel resolves at effect-application time -----
console.log("\n=== <current-room> sentinel ===");
{
  const e = new Engine(zork as unknown as Story);
  e.state = {
    ...e.state,
    itemLocations: {
      ...e.state.itemLocations,
      player: "gallery",
      sword: "player",
      lamp: "player",
    },
  };
  const { applyEffect: applySentinelEffect } = await import("../src/engine/state");
  const after = applySentinelEffect(
    e.state,
    { type: "moveItemsFrom", from: "player", to: "<current-room>" },
    zork as unknown as Story,
  );
  after.itemLocations.sword === "gallery" && after.itemLocations.lamp === "gallery"
    ? pass("moveItemsFrom <current-room> drops carried items at the player's room")
    : fail(`sword=${after.itemLocations.sword} lamp=${after.itemLocations.lamp}`);

  const after2 = applySentinelEffect(
    e.state,
    { type: "moveItem", itemId: "sword", to: "<current-room>" },
    zork as unknown as Story,
  );
  after2.itemLocations.sword === "gallery"
    ? pass("moveItem <current-room> places item at the player's room")
    : fail(`sword at ${after2.itemLocations.sword}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
