// Core player actions. Each action is a pure function:
//   (state, story, args) -> ActionResult
//
// Actions return structured ActionEvents — facts about what happened — rather
// than formatted prose. The Engine wraps these with trigger evaluation and
// view building; render.ts formats them for display.

import type { GameState, Story } from "../story/schema";
import {
  currentRoom,
  doorById,
  doorPresentation,
  doorSideHere,
  doorsHere,
  evaluateCondition,
  isItemAccessible,
  itemById,
  itemsInContainer,
  roomById,
  visibleExits,
} from "./state";
import type { ActionEvent } from "./events";

export type ActionRequest =
  | { type: "look" }
  | { type: "examine"; itemId: string }
  | { type: "take"; itemId: string }
  | { type: "drop"; itemId: string }
  | { type: "put"; itemId: string; targetId: string }
  | { type: "inventory" }
  | { type: "go"; direction: string }
  | { type: "open"; itemId: string }
  | { type: "close"; itemId: string }
  | { type: "read"; itemId: string }
  | { type: "recordIntent"; signalId: string };

export interface ActionResult {
  state: GameState;
  event: ActionEvent;
  ok: boolean;
}

export function performAction(
  state: GameState,
  story: Story,
  req: ActionRequest,
): ActionResult {
  switch (req.type) {
    case "look": return look(state, story);
    case "examine": return examine(state, story, req.itemId);
    case "take": return take(state, story, req.itemId);
    case "drop": return drop(state, story, req.itemId);
    case "put": return put(state, story, req.itemId, req.targetId);
    case "inventory": return inventory(state);
    case "go": return go(state, story, req.direction);
    case "open": return open(state, story, req.itemId);
    case "close": return close(state, story, req.itemId);
    case "read": return read(state, story, req.itemId);
    case "recordIntent": return recordIntent(state, story, req.signalId);
  }
}

// ---------- look ----------

function look(state: GameState, story: Story): ActionResult {
  const room = currentRoom(state, story);
  if (!room) {
    return { state, event: reject("no-current-room"), ok: false };
  }
  return { state, event: { type: "looked" }, ok: true };
}

// ---------- examine ----------

function examine(state: GameState, story: Story, id: string): ActionResult {
  // Polymorphic: id could be an item OR a door. Try item first, then door.
  const item = itemById(story, id);
  if (item) {
    if (!isItemAccessible(item, state, story)) {
      return { state, event: reject("not-accessible", { itemId: item.id }), ok: false };
    }
    const examined = state.examinedItems.includes(item.id)
      ? state.examinedItems
      : [...state.examinedItems, item.id];
    return {
      state: { ...state, examinedItems: examined },
      event: { type: "examined", itemId: item.id, description: item.description },
      ok: true,
    };
  }

  const door = doorById(story, id);
  if (door) {
    const visible = doorsHere(state, story).some((d) => d.id === door.id);
    if (!visible) {
      return { state, event: reject("not-accessible", { itemId: door.id }), ok: false };
    }
    const presentation = doorPresentation(door, state);
    return {
      state,
      event: { type: "examined", itemId: door.id, description: presentation.description },
      ok: true,
    };
  }

  return { state, event: reject("unknown-item", { itemId: id }), ok: false };
}

// ---------- take ----------

function take(state: GameState, story: Story, itemId: string): ActionResult {
  const item = itemById(story, itemId);
  if (!item) {
    return { state, event: reject("unknown-item", { itemId }), ok: false };
  }
  if (state.itemLocations[item.id] === "inventory") {
    return { state, event: reject("already-carrying", { itemId: item.id }), ok: false };
  }
  // Accessibility check covers items directly in the room AND items inside
  // open containers in the room.
  if (!isItemAccessible(item, state, story)) {
    return { state, event: reject("not-in-room", { itemId: item.id }), ok: false };
  }
  if (item.fixed) {
    return { state, event: reject("fixed-item", { itemId: item.id }), ok: false };
  }
  if (!item.takeable) {
    return { state, event: reject("not-takeable", { itemId: item.id }), ok: false };
  }
  return {
    state: {
      ...state,
      itemLocations: { ...state.itemLocations, [item.id]: "inventory" },
    },
    event: { type: "took", itemId: item.id },
    ok: true,
  };
}

// ---------- put (X into container Y) ----------

function put(
  state: GameState,
  story: Story,
  itemId: string,
  targetId: string,
): ActionResult {
  const item = itemById(story, itemId);
  if (!item) {
    return { state, event: reject("unknown-item", { itemId, targetId }), ok: false };
  }
  // Must be carrying the item.
  if (state.itemLocations[item.id] !== "inventory") {
    return { state, event: reject("not-carrying", { itemId: item.id, targetId }), ok: false };
  }

  // Resolve and validate the target container.
  const target = itemById(story, targetId);
  if (!target) {
    return { state, event: reject("unknown-item", { itemId: targetId, targetId }), ok: false };
  }
  if (item.id === target.id) {
    return { state, event: reject("self-containment", { itemId: item.id, targetId: target.id }), ok: false };
  }
  if (!isItemAccessible(target, state, story)) {
    return { state, event: reject("not-accessible", { itemId: target.id, targetId: target.id }), ok: false };
  }
  if (!target.container) {
    return { state, event: reject("not-container", { itemId: item.id, targetId: target.id }), ok: false };
  }
  // If the container is openable, it must be open. (Always-open containers
  // skip this check.)
  if (target.container.openable && !state.containerOpen[target.id]) {
    return { state, event: reject("container-closed", { itemId: item.id, targetId: target.id }), ok: false };
  }
  if (target.container.capacity !== undefined) {
    const contents = itemsInContainer(state, story, target.id);
    if (contents.length >= target.container.capacity) {
      return { state, event: reject("container-full", { itemId: item.id, targetId: target.id }), ok: false };
    }
  }

  return {
    state: {
      ...state,
      itemLocations: { ...state.itemLocations, [item.id]: target.id },
    },
    event: { type: "put", itemId: item.id, targetId: target.id },
    ok: true,
  };
}

// ---------- drop ----------

function drop(state: GameState, story: Story, itemId: string): ActionResult {
  const item = itemById(story, itemId);
  if (!item) {
    return { state, event: reject("unknown-item", { itemId }), ok: false };
  }
  if (state.itemLocations[item.id] !== "inventory") {
    return { state, event: reject("not-carrying", { itemId: item.id }), ok: false };
  }
  return {
    state: {
      ...state,
      itemLocations: { ...state.itemLocations, [item.id]: state.playerLocation },
    },
    event: { type: "dropped", itemId: item.id },
    ok: true,
  };
}

// ---------- inventory ----------

function inventory(state: GameState): ActionResult {
  return { state, event: { type: "inventoried" }, ok: true };
}

// ---------- go ----------

function go(state: GameState, story: Story, direction: string): ActionResult {
  const dir = direction.toLowerCase();
  const room = currentRoom(state, story);
  if (!room) {
    return { state, event: reject("no-current-room"), ok: false };
  }
  const exit = room.exits?.[dir];
  if (!exit) {
    return { state, event: reject("no-such-direction", { direction: dir }), ok: false };
  }
  const visible = visibleExits(room, state, story).find(([d]) => d === dir);
  if (!visible) {
    return { state, event: reject("no-such-direction", { direction: dir }), ok: false };
  }
  if (visible[1].blocked) {
    return {
      state,
      event: reject("exit-blocked", { direction: dir, message: visible[1].blockedMessage }),
      ok: false,
    };
  }
  const target = roomById(story, exit.to);
  if (!target) {
    return {
      state,
      event: reject("broken-exit-target", { direction: dir, message: exit.to }),
      ok: false,
    };
  }
  const visited = state.visitedRooms.includes(exit.to)
    ? state.visitedRooms
    : [...state.visitedRooms, exit.to];
  return {
    state: { ...state, playerLocation: exit.to, visitedRooms: visited },
    event: { type: "moved", from: room.id, to: exit.to, direction: dir },
    ok: true,
  };
}

// ---------- open / close ----------

function open(state: GameState, story: Story, id: string): ActionResult {
  // Polymorphic: id could be an item OR a door. Try item first, then door.
  const item = itemById(story, id);
  if (item) {
    if (!isItemAccessible(item, state, story)) {
      return { state, event: reject("not-accessible", { itemId: item.id }), ok: false };
    }
    if (!item.container?.openable) {
      return { state, event: reject("not-openable", { itemId: item.id }), ok: false };
    }
    if (state.containerOpen[item.id]) {
      return { state, event: reject("already-open", { itemId: item.id }), ok: false };
    }
    return {
      state: { ...state, containerOpen: { ...state.containerOpen, [item.id]: true } },
      event: { type: "opened", itemId: item.id },
      ok: true,
    };
  }

  const door = doorById(story, id);
  if (door) {
    const visible = doorsHere(state, story).some((d) => d.id === door.id);
    if (!visible) {
      return { state, event: reject("not-accessible", { itemId: door.id }), ok: false };
    }
    if (state.doorOpen[door.id]) {
      return { state, event: reject("already-open", { itemId: door.id }), ok: false };
    }
    // Gate on openableWhen — per-side override beats door-level default. Both
    // missing means the door opens freely.
    const here = doorSideHere(door, state);
    const effectiveWhen = here?.openableWhen ?? door.openableWhen;
    if (effectiveWhen && !evaluateCondition(effectiveWhen, state)) {
      const msg = here?.openBlockedMessage ?? door.openBlockedMessage;
      return {
        state,
        event: reject("open-blocked", { itemId: door.id, message: msg }),
        ok: false,
      };
    }
    return {
      state: { ...state, doorOpen: { ...state.doorOpen, [door.id]: true } },
      event: { type: "opened", itemId: door.id },
      ok: true,
    };
  }

  return { state, event: reject("unknown-item", { itemId: id }), ok: false };
}

function close(state: GameState, story: Story, id: string): ActionResult {
  const item = itemById(story, id);
  if (item) {
    if (!isItemAccessible(item, state, story)) {
      return { state, event: reject("not-accessible", { itemId: item.id }), ok: false };
    }
    if (!item.container?.openable) {
      return { state, event: reject("not-openable", { itemId: item.id }), ok: false };
    }
    if (!state.containerOpen[item.id]) {
      return { state, event: reject("already-closed", { itemId: item.id }), ok: false };
    }
    return {
      state: { ...state, containerOpen: { ...state.containerOpen, [item.id]: false } },
      event: { type: "closed", itemId: item.id },
      ok: true,
    };
  }

  const door = doorById(story, id);
  if (door) {
    const visible = doorsHere(state, story).some((d) => d.id === door.id);
    if (!visible) {
      return { state, event: reject("not-accessible", { itemId: door.id }), ok: false };
    }
    if (!state.doorOpen[door.id]) {
      return { state, event: reject("already-closed", { itemId: door.id }), ok: false };
    }
    return {
      state: { ...state, doorOpen: { ...state.doorOpen, [door.id]: false } },
      event: { type: "closed", itemId: door.id },
      ok: true,
    };
  }

  return { state, event: reject("unknown-item", { itemId: id }), ok: false };
}

// ---------- recordIntent ----------
//
// Called by the LLM when the player's input semantically matches an active
// IntentSignal's prompt. Persists the match in state.matchedIntents so any
// `intentMatched` condition referencing the signal evaluates true thereafter.
// No-op if the signal is already matched (idempotent).

function recordIntent(state: GameState, story: Story, signalId: string): ActionResult {
  const signal = story.intentSignals?.find((s) => s.id === signalId);
  if (!signal) {
    return { state, event: reject("unknown-intent", { itemId: signalId }), ok: false };
  }
  if (state.matchedIntents.includes(signalId)) {
    // Already matched — return success but don't duplicate.
    return { state, event: { type: "intent-recorded", signalId }, ok: true };
  }
  return {
    state: { ...state, matchedIntents: [...state.matchedIntents, signalId] },
    event: { type: "intent-recorded", signalId },
    ok: true,
  };
}

// ---------- read ----------

function read(state: GameState, story: Story, itemId: string): ActionResult {
  const item = itemById(story, itemId);
  if (!item) {
    return { state, event: reject("unknown-item", { itemId }), ok: false };
  }
  if (!isItemAccessible(item, state, story)) {
    return { state, event: reject("not-accessible", { itemId: item.id }), ok: false };
  }
  if (!item.readable) {
    return { state, event: reject("not-readable", { itemId: item.id }), ok: false };
  }
  return {
    state,
    event: { type: "read", itemId: item.id, text: item.readable.text },
    ok: true,
  };
}

// ---------- helpers ----------

function reject(
  reason: import("./events").RejectionReason,
  extras: { itemId?: string; targetId?: string; direction?: string; message?: string } = {},
): ActionEvent {
  const event: ActionEvent = { type: "rejected", reason };
  if (extras.itemId !== undefined) event.itemId = extras.itemId;
  if (extras.targetId !== undefined) event.targetId = extras.targetId;
  if (extras.direction !== undefined) event.direction = extras.direction;
  if (extras.message !== undefined) event.message = extras.message;
  return event;
}
