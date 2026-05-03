// Narration template renderer. Single source of truth used by:
//   - Tool handler successNarration / failedNarration
//   - Trigger narration cues (so triggers can interpolate live state)
//   - endGame Effect message (so the closing prose includes final score etc.)
//
// Supported tokens:
//   {arg.<name>.name}            — resolves an arg's id to an item-or-passage name
//   {arg.<name>.id}              — passes the arg's id through verbatim
//   {arg.<name>.readable.text}   — resolves an arg's id to an item, returns its readable.text
//   {flag.<key>}                 — reads state.flags[key], stringified
//   {rank}                       — computes the rank tier from state.flags["score"]
//
// Unknown tokens / missing values render as empty string (defensive — same
// as the original handler renderer behavior).

import type { Atom, GameState, Story } from "../story/schema";
import { itemById, passageById } from "./state";
import { computeRank } from "./rank";

export function renderNarration(
  template: string,
  args: Record<string, Atom>,
  story: Story,
  state: GameState,
): string {
  let out = template;

  // {arg.<name>.readable.text} — must run before the simpler {arg.X.name|id} pattern
  out = out.replace(/\{arg\.([a-zA-Z0-9_-]+)\.readable\.text\}/g, (_match, argName) => {
    const value = args[argName];
    if (typeof value !== "string") return "";
    const item = itemById(story, value);
    return item?.readable?.text ?? "";
  });

  // {arg.<name>.<name|id>}
  out = out.replace(/\{arg\.([a-zA-Z0-9_-]+)\.(name|id)\}/g, (_match, argName, field) => {
    const value = args[argName];
    if (typeof value !== "string") return String(value ?? "");
    if (field === "id") return value;
    const item = itemById(story, value);
    if (item) return item.name;
    const passage = passageById(story, value);
    if (passage) return passage.name;
    return value;
  });

  // {flag.<key>}
  out = out.replace(/\{flag\.([a-zA-Z0-9_-]+)\}/g, (_match, key) => {
    const value = state.flags[key];
    return value === undefined ? "" : String(value);
  });

  // {rank} — derived from state.flags["score"] (defaults to 0 if absent)
  out = out.replace(/\{rank\}/g, () => {
    const score = state.flags["score"];
    return computeRank(typeof score === "number" ? score : 0);
  });

  return out;
}
