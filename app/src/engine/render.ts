// Dev / test renderer.
//
// In production, the LLM produces all player-facing prose from event + view +
// narration cues. This module exists for: pre-LLM smoke testing, debugging,
// and any internal surface that needs a quick string representation of the
// engine output.
//
// It is NOT the canonical view-layer for the game. The LLM is.

import type { Story } from "../story/schema";
import type { ActionEvent, RejectionReason } from "./events";
import type { EngineResult } from "./engine";
import type { WorldView } from "./view";
import { doorById, itemById } from "./state";

export function renderResult(result: EngineResult, story: Story): string {
  const lines: string[] = [];

  const eventText = renderEvent(result.event, story);
  if (eventText) lines.push(eventText);

  // For look, the room view IS the result.
  if (result.event.type === "looked") {
    lines.push(renderRoomView(result.view));
  }

  // For inventory, the inventory section IS the result.
  if (result.event.type === "inventoried") {
    lines.push(renderInventory(result.view));
  }

  // After moving, show the new room.
  if (result.ok && result.event.type === "moved") {
    lines.push(renderRoomView(result.view));
  }

  // Narration cues from triggers.
  for (const cue of result.narrationCues) {
    if (lines.length > 0) lines.push("");
    lines.push(cue);
  }

  if (result.ended) {
    lines.push("");
    lines.push(
      `*** ${result.ended.won ? "GAME WON" : "GAME LOST"} *** ${result.ended.message}`,
    );
  }

  return lines.join("\n");
}

export function renderRoomView(view: WorldView): string {
  const lines = [view.room.name, view.room.description];

  // Top-level (directly in room) non-scenery items
  const topLevel = view.itemsHere.filter((i) => !i.fixed && !i.containedIn);
  if (topLevel.length > 0) {
    lines.push(`You see: ${topLevel.map(renderItemLabel).join(", ")}.`);
  }

  // Items inside open containers — list separately, attributed to their parent
  const nested = view.itemsHere.filter((i) => !i.fixed && i.containedIn);
  if (nested.length > 0) {
    // Group by parent for nicer phrasing.
    const byParent = new Map<string, { parentName: string; items: ItemViewLite[] }>();
    for (const i of nested) {
      const key = i.containedIn!.id;
      const entry = byParent.get(key) ?? { parentName: i.containedIn!.name, items: [] };
      entry.items.push(i);
      byParent.set(key, entry);
    }
    for (const { parentName, items } of byParent.values()) {
      lines.push(`Inside the ${parentName}: ${items.map((i) => i.name).join(", ")}.`);
    }
  }

  // Doors visible from the current room — list with open/closed state.
  if (view.doorsHere.length > 0) {
    const doorLabels = view.doorsHere.map(
      (d) => `${d.name} (${d.isOpen ? "open" : "closed"})`,
    );
    lines.push(`Doors: ${doorLabels.join(", ")}.`);
  }

  if (view.exits.length > 0) {
    const exitLabels = view.exits.map((e) => (e.blocked ? `${e.direction}*` : e.direction));
    lines.push(`Exits: ${exitLabels.join(", ")}.`);
  }

  return lines.join("\n");
}

export function renderInventory(view: WorldView): string {
  if (view.inventory.length === 0) return "You are empty-handed.";
  return ["You are carrying:", ...view.inventory.map((i) => `  ${i.name}`)].join("\n");
}

interface ItemViewLite {
  id: string;
  name: string;
  containedIn?: { id: string; name: string };
}

function renderItemLabel(item: ItemViewLite & { container?: { isOpen: boolean; openable: boolean } }): string {
  if (item.container && item.container.openable) {
    return `${item.name} (${item.container.isOpen ? "open" : "closed"})`;
  }
  return item.name;
}

function renderEvent(event: ActionEvent, story: Story): string {
  switch (event.type) {
    case "looked":
    case "inventoried":
    case "moved":
      return ""; // composed elsewhere in renderResult
    case "intent-recorded":
      // Silent for the player — intent matching is an internal LLM signal.
      return "";
    case "examined":
      return event.description;
    case "took":
      return `Taken: ${nameOf(story, event.itemId)}.`;
    case "dropped":
      return `Dropped: ${nameOf(story, event.itemId)}.`;
    case "put":
      return `You put the ${nameOf(story, event.itemId)} into the ${nameOf(story, event.targetId)}.`;
    case "opened":
      return `You open the ${nameOf(story, event.itemId)}.`;
    case "closed":
      return `You close the ${nameOf(story, event.itemId)}.`;
    case "read":
      return event.text;
    case "rejected":
      return renderRejection(event, story);
  }
}

function renderRejection(
  event: Extract<ActionEvent, { type: "rejected" }>,
  story: Story,
): string {
  const itemName = event.itemId ? nameOf(story, event.itemId) : null;
  const targetName = event.targetId ? nameOf(story, event.targetId) : null;
  return rejectionMessage(event.reason, {
    itemName,
    targetName,
    direction: event.direction,
    message: event.message,
  });
}

function rejectionMessage(
  reason: RejectionReason,
  ctx: { itemName: string | null; targetName?: string | null; direction?: string; message?: string },
): string {
  const item = ctx.itemName ?? "thing";
  const target = ctx.targetName ?? "that";
  switch (reason) {
    case "unknown-item": return `(unknown item)`;
    case "not-accessible":
    case "not-in-room": return `You don't see any ${item} here.`;
    case "already-carrying": return `You're already carrying the ${item}.`;
    case "not-carrying": return `You're not carrying the ${item}.`;
    case "fixed-item": return `The ${item} is fixed in place.`;
    case "not-takeable": return `You can't take the ${item}.`;
    case "no-such-direction": return `You can't go ${ctx.direction ?? "that way"} from here.`;
    case "exit-blocked": return ctx.message ?? `You can't go that way right now.`;
    case "broken-exit-target": return `(error: exit target "${ctx.message ?? "?"}" doesn't exist)`;
    case "not-openable": return `You can't open the ${item}.`;
    case "already-open": return `The ${item} is already open.`;
    case "already-closed": return `The ${item} is already closed.`;
    case "open-blocked": return ctx.message ?? `You can't open the ${item} right now.`;
    case "unknown-intent": return `(unknown intent signal: ${ctx.itemName ?? "?"})`;
    case "not-readable": return `There's nothing to read on the ${item}.`;
    case "not-container": return `The ${target} can't hold things.`;
    case "container-closed": return `The ${target} is closed.`;
    case "container-full": return `The ${target} is full.`;
    case "self-containment": return `You can't put the ${item} inside itself.`;
    case "no-current-room": return `(error: you are nowhere)`;
    case "game-over": return `The game has ended.`;
  }
}

// Polymorphic name lookup — id may refer to an item OR a door, since action
// tools dispatch over both kinds.
function nameOf(story: Story, id: string): string {
  return itemById(story, id)?.name ?? doorById(story, id)?.name ?? id;
}
