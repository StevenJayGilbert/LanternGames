// Pure state utilities: initial-state construction, condition evaluation,
// effect application, and small lookup helpers. No side effects, no I/O.
//
// All state mutations are immutable — every function returns a new GameState
// rather than mutating the input. Keeps debugging sane and makes save/restore
// trivial later.

import type {
  Condition,
  Door,
  Effect,
  GameState,
  Item,
  Room,
  Story,
} from "../story/schema";

// ---------- Initial state ----------

export function initialState(story: Story): GameState {
  const itemLocations: Record<string, string> = {};
  const containerOpen: Record<string, boolean> = {};
  const lightSourcesLit: Record<string, boolean> = {};
  const doorOpen: Record<string, boolean> = {};

  for (const item of story.items) {
    itemLocations[item.id] = item.location;
    if (item.container?.isOpen !== undefined) {
      containerOpen[item.id] = item.container.isOpen;
    }
    if (item.lightSource?.isLit !== undefined) {
      lightSourcesLit[item.id] = item.lightSource.isLit;
    }
  }

  for (const door of story.doors ?? []) {
    doorOpen[door.id] = door.isOpen ?? false;
  }

  return {
    storyId: story.id,
    schemaVersion: story.schemaVersion,
    playerLocation: story.startRoom,
    flags: { ...(story.startState ?? {}) },
    itemLocations,
    containerOpen,
    lightSourcesLit,
    doorOpen,
    matchedIntents: [],
    visitedRooms: [story.startRoom],
    examinedItems: [],
    firedTriggers: [],
  };
}

// ---------- Lookups ----------

export function roomById(story: Story, id: string): Room | undefined {
  return story.rooms.find((r) => r.id === id);
}

export function itemById(story: Story, id: string): Item | undefined {
  return story.items.find((i) => i.id === id);
}

export function doorById(story: Story, id: string): Door | undefined {
  return story.doors?.find((d) => d.id === id);
}

// True if the door is currently in the open state (defaults to false if the
// door's id is unknown, so a missing reference fails closed).
export function isDoorOpen(state: GameState, doorId: string): boolean {
  return !!state.doorOpen[doorId];
}

// Doors that are perceptible from the player's current room — i.e. the
// player's location matches one of the door's two sides. Used by the view +
// by the polymorphic open/close/examine dispatch.
export function doorsHere(state: GameState, story: Story): Door[] {
  const doors = story.doors ?? [];
  return doors.filter((d) =>
    d.sides.some((s) => s.roomId === state.playerLocation),
  );
}

// The side metadata facing the player's current room, or undefined if the
// player isn't on either side. Use this to resolve per-side name/description.
export function doorSideHere(door: Door, state: GameState) {
  return door.sides.find((s) => s.roomId === state.playerLocation);
}

// Resolve a door's name/description from the player's perspective. Order of
// precedence: matching side's variants > matching side's description > door's
// variants > door's description.
export function doorPresentation(
  door: Door,
  state: GameState,
): { name: string; description: string } {
  const side = doorSideHere(door, state);
  const name = side?.name ?? door.name;
  const description =
    matchVariant(side?.variants, state) ??
    side?.description ??
    matchVariant(door.variants, state) ??
    door.description;
  return { name, description };
}

// Return the first variant whose condition is true, or undefined.
function matchVariant(
  variants: { when: Condition; text: string }[] | undefined,
  state: GameState,
): string | undefined {
  if (!variants) return undefined;
  for (const v of variants) {
    if (evaluateCondition(v.when, state)) return v.text;
  }
  return undefined;
}

export function currentRoom(state: GameState, story: Story): Room | undefined {
  return roomById(story, state.playerLocation);
}

// Walks the location chain to determine whether the player can perceive an
// item right now. The chain ends at: a roomId (must match player), "inventory"
// (always accessible), "nowhere" (never), or eventually loops/dangles (never).
// Items inside CLOSED containers are not accessible even if the container is
// in the player's room.
//
// Shared scenery (item.appearsIn) is treated as additional rooms where the
// item is perceptible without needing to be physically located there.
export function isItemAccessible(
  item: Item,
  state: GameState,
  story: Story,
): boolean {
  if (item.appearsIn?.includes(state.playerLocation)) return true;
  return locationReachesPlayer(item, state, story, /*requireOpen=*/ true);
}

// Like isItemAccessible but ignores open/closed state (used for "is this item
// physically present in the player's room" queries that don't care about
// visibility, e.g. hidden contents inventory tracking).
export function isItemPresent(
  item: Item,
  state: GameState,
  story: Story,
): boolean {
  if (item.appearsIn?.includes(state.playerLocation)) return true;
  return locationReachesPlayer(item, state, story, /*requireOpen=*/ false);
}

function locationReachesPlayer(
  item: Item,
  state: GameState,
  story: Story,
  requireOpen: boolean,
  visited: Set<string> = new Set(),
): boolean {
  if (visited.has(item.id)) return false; // cycle guard (validator should prevent)
  visited.add(item.id);

  const loc = state.itemLocations[item.id];
  if (loc === "inventory") return true;
  if (loc === "nowhere") return false;
  if (loc === state.playerLocation) return true;

  const parent = itemById(story, loc);
  if (!parent) return false;
  if (requireOpen && parent.container && !state.containerOpen[parent.id]) {
    return false; // hidden inside a closed container
  }
  return locationReachesPlayer(parent, state, story, requireOpen, visited);
}

// Items at the *immediate* level of the player's current room (location === roomId).
// Used for the room-description listing of "you see:".
export function itemsInRoom(state: GameState, story: Story, roomId: string): Item[] {
  return story.items.filter((i) => state.itemLocations[i.id] === roomId);
}

// All items the player can currently perceive in the room — directly placed
// items plus items inside open containers (recursively). Inventory excluded;
// fetch that separately.
export function itemsAccessibleHere(state: GameState, story: Story): Item[] {
  return story.items.filter((i) => {
    if (state.itemLocations[i.id] === "inventory") return false;
    return isItemAccessible(i, state, story);
  });
}

export function itemsInInventory(state: GameState, story: Story): Item[] {
  return story.items.filter((i) => state.itemLocations[i.id] === "inventory");
}

// Items whose immediate location is the given container item.
export function itemsInContainer(
  state: GameState,
  story: Story,
  containerId: string,
): Item[] {
  return story.items.filter((i) => state.itemLocations[i.id] === containerId);
}

// ---------- Condition evaluation ----------

export function evaluateCondition(c: Condition, state: GameState): boolean {
  switch (c.type) {
    case "flag":
      return state.flags[c.key] === c.equals;
    case "hasItem":
      return state.itemLocations[c.itemId] === "inventory";
    case "itemAt":
      return state.itemLocations[c.itemId] === c.location;
    case "playerAt":
      return state.playerLocation === c.roomId;
    case "visited":
      return state.visitedRooms.includes(c.roomId);
    case "examined":
      return state.examinedItems.includes(c.itemId);
    case "triggerFired":
      return state.firedTriggers.includes(c.triggerId);
    case "doorOpen":
      return !!state.doorOpen[c.doorId];
    case "containerOpen":
      return !!state.containerOpen[c.itemId];
    case "intentMatched":
      return state.matchedIntents.includes(c.signalId);
    case "always":
      return true;
    case "and":
      return c.all.every((sub) => evaluateCondition(sub, state));
    case "or":
      return c.any.some((sub) => evaluateCondition(sub, state));
    case "not":
      return !evaluateCondition(c.condition, state);
  }
}

// ---------- Effect application ----------

export function applyEffect(state: GameState, e: Effect): GameState {
  switch (e.type) {
    case "setFlag":
      return { ...state, flags: { ...state.flags, [e.key]: e.value } };
    case "moveItem":
      return {
        ...state,
        itemLocations: { ...state.itemLocations, [e.itemId]: e.to },
      };
    case "movePlayer": {
      const visited = state.visitedRooms.includes(e.to)
        ? state.visitedRooms
        : [...state.visitedRooms, e.to];
      return { ...state, playerLocation: e.to, visitedRooms: visited };
    }
    case "endGame":
      return { ...state, finished: { won: e.won, message: e.message } };
  }
}

export function applyEffects(state: GameState, effects: Effect[]): GameState {
  return effects.reduce<GameState>((s, e) => applyEffect(s, e), state);
}

// ---------- Variant resolution ----------

// Pick the first matching variant for a room, or fall back to the canonical
// description.
export function resolveRoomDescription(room: Room, state: GameState): string {
  for (const variant of room.variants ?? []) {
    if (evaluateCondition(variant.when, state)) return variant.text;
  }
  return room.description;
}

// Filter exits to those currently visible to the player. `hidden: true` exits
// are suppressed unless their gate is satisfied. An exit is gated by:
//   - exit.when condition (if present)
//   - exit.door (if present, the door must be open)
// Both must pass for the exit to be usable.
export function visibleExits(
  room: Room,
  state: GameState,
  story?: Story,
): Array<[string, { to: string; blocked: boolean; blockedMessage?: string; doorId?: string }]> {
  const out: Array<[string, { to: string; blocked: boolean; blockedMessage?: string; doorId?: string }]> = [];
  for (const [dir, exit] of Object.entries(room.exits ?? {})) {
    const conditionOk = !exit.when || evaluateCondition(exit.when, state);
    const doorOk = !exit.door || isDoorOpen(state, exit.door);
    const open = conditionOk && doorOk;
    if (exit.hidden && !open) continue;
    // Choose blockedMessage: prefer story-authored exit message; fall back to
    // a door-specific note when a closed door is the blocker.
    let blockedMessage = exit.blockedMessage;
    if (!blockedMessage && conditionOk && !doorOk && exit.door && story) {
      const door = doorById(story, exit.door);
      if (door) blockedMessage = `The ${door.name} is closed.`;
    }
    out.push([
      dir,
      {
        to: exit.to,
        blocked: !open,
        blockedMessage,
        doorId: exit.door,
      },
    ]);
  }
  return out;
}
