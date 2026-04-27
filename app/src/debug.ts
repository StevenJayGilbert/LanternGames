// Centralized debug logging. Every session-level diagnostic console.log
// (tool injection, room moves, Anthropic cache stats) routes through here
// and is gated by the per-category flags in debug.config.json.
//
// To silence a category: edit debug.config.json, set the flag to false,
// rebuild. The flags are NOT tied to the Debug ●/○ header button — that
// button only controls slash-command intercepts.

import config from "./debug.config.json" with { type: "json" };

export type DebugCategory = "tools" | "rooms" | "anthropic";

const FLAGS: Record<DebugCategory, boolean> = {
  tools: !!config.logs?.tools,
  rooms: !!config.logs?.rooms,
  anthropic: !!config.logs?.anthropic,
};

export function debugLog(category: DebugCategory, ...args: unknown[]): void {
  if (FLAGS[category]) {
    console.log(...args);
  }
}
