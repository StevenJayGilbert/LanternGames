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
    itemLocations: { ...e.state.itemLocations, "advertisement": "inventory" },
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

// ----- alwaysOn / conditional split -----
console.log("\n=== alwaysOn / conditional split ===");
{
  const story = storyWithTestTools();
  const alwaysOn = alwaysOnCustomTools(story);
  alwaysOn.length === 1 && alwaysOn[0].id === "test-open"
    ? pass("alwaysOnCustomTools returns the open tool")
    : fail(`alwaysOn=${alwaysOn.map((t) => t.id).join(", ")}`);

  const e = new Engine(story);
  const conditional = activeConditionalCustomTools(e.state, e.story);
  // test-dangling has no consuming triggers → should be filtered out.
  conditional.length === 0
    ? pass("activeConditionalCustomTools filters dangling tools (no relevant triggers)")
    : fail(`conditional=${conditional.map((t) => t.id).join(", ")}`);
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
