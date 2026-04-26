// Phase 3 smoke test: play Hello Adventure end-to-end through the engine.
// Logs to the browser dev console at app boot.
//
// The expected sequence:
//   look           -> Sealed Chamber description
//   examine painting -> reveals key (trigger fires; cue queued)
//   look           -> key now visible
//   take key       -> "Taken: small brass key."
//   go east        -> moves to Hallway, view shown
//   go east        -> moves to Garden, win condition fires
//
// Engine returns structured event + view + cues every turn; render.ts turns
// those into the readable lines below. In production this rendering job
// belongs to the LLM.

import { Engine } from "./engine";
import type { ActionRequest } from "./actions";
import { renderResult, renderRoomView } from "./render";
import { assertValid } from "../story/validate";
import helloAdventure from "../stories/hello-adventure.json";

interface Step {
  label: string;
  action: ActionRequest;
}

const SCRIPT: Step[] = [
  { label: "look (start)", action: { type: "look" } },
  { label: "examine painting", action: { type: "examine", itemId: "painting" } },
  { label: "look (after reveal)", action: { type: "look" } },
  { label: "take key", action: { type: "take", itemId: "key" } },
  { label: "go east (to hallway)", action: { type: "go", direction: "east" } },
  { label: "go east (to garden)", action: { type: "go", direction: "east" } },
];

export function runEngineSmoke(): boolean {
  console.groupCollapsed("[engine] Hello Adventure smoke test");
  try {
    const story = assertValid(helloAdventure, "hello-adventure");
    const engine = new Engine(story);

    if (story.intro) console.info("intro:", story.intro);
    console.info("(initial view)\n" + renderRoomView(engine.getView()));

    for (const step of SCRIPT) {
      const result = engine.execute(step.action);
      const header = `▸ ${step.label}  [ok=${result.ok}, event=${result.event.type}]`;
      const body = renderResult(result, story);
      console.info(header + (body ? "\n" + body : ""));
      if (result.triggersFired.length > 0) {
        console.info(`  triggers fired: ${result.triggersFired.join(", ")}`);
      }
    }

    if (!engine.state.finished?.won) {
      console.error("[engine] smoke test FAILED: game did not reach a win state");
      return false;
    }
    console.info("[engine] ✓ smoke test passed (game won)");
    return true;
  } catch (err) {
    console.error("[engine] smoke test threw:", err);
    return false;
  } finally {
    console.groupEnd();
  }
}
