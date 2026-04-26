// Pure state utilities: initial-state construction, condition evaluation,
// effect application, and small lookup helpers. No side effects, no I/O.
//
// All state mutations are immutable — every function returns a new GameState
// rather than mutating the input. Keeps debugging sane and makes save/restore
// trivial later.

import type {
  Atom,
  Condition,
  Effect,
  GameState,
  Item,
  NumericExpr,
  Passage,
  Room,
  Story,
} from "../story/schema";

// ---------- Initial state ----------

export function initialState(story: Story): GameState {
  const itemLocations: Record<string, string> = {};
  const passageStates: Record<string, Record<string, Atom>> = {};
  const itemStates: Record<string, Record<string, Atom>> = {};
  const roomStates: Record<string, Record<string, Atom>> = {};

  for (const item of story.items) {
    itemLocations[item.id] = item.location;
    if (item.state) {
      itemStates[item.id] = { ...item.state };
    }
  }

  for (const p of story.passages ?? []) {
    passageStates[p.id] = { ...(p.state ?? {}) };
  }

  for (const r of story.rooms) {
    if (r.state) roomStates[r.id] = { ...r.state };
  }

  return {
    storyId: story.id,
    schemaVersion: story.schemaVersion,
    playerLocation: story.startRoom,
    flags: { ...(story.startState ?? {}) },
    itemLocations,
    passageStates,
    itemStates,
    roomStates,
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

export function passageById(story: Story, id: string): Passage | undefined {
  return story.passages?.find((p) => p.id === id);
}

// Read one key of a passage's state. Returns undefined if the passage or key
// doesn't exist; engine treats that as "value is missing" — equality checks
// fail, numeric extraction returns 0.
export function getPassageStateValue(
  state: GameState,
  passageId: string,
  key: string,
): Atom | undefined {
  return state.passageStates[passageId]?.[key];
}

// Read one key of an item's state. Mirror of getPassageStateValue.
export function getItemStateValue(
  state: GameState,
  itemId: string,
  key: string,
): Atom | undefined {
  return state.itemStates[itemId]?.[key];
}

// Read one key of a room's state.
export function getRoomStateValue(
  state: GameState,
  roomId: string,
  key: string,
): Atom | undefined {
  return state.roomStates[roomId]?.[key];
}

// True if any item physically reachable from the player has state[key] === equals.
// Uses isItemPresent (location-based) NOT isItemAccessible — otherwise we
// recurse infinitely (visibility filter → defaultVisibility →
// anyPerceivableItemWith → visibility filter → ...). Semantically right too:
// a lit lamp's light reaches the player even if sealed inside a closed box.
export function anyPerceivableItemWith(
  state: GameState,
  story: Story,
  key: string,
  equals: Atom,
): boolean {
  for (const item of story.items) {
    if (state.itemStates[item.id]?.[key] !== equals) continue;
    if (isItemPresent(item, state, story)) return true;
  }
  return false;
}

// Story-driven view+accessibility filter. An object is "visible" when both:
//   - its own visibleWhen (if set) evaluates true, AND
//   - story.defaultVisibility (if set) evaluates true
// Default: visible. Used by view rendering AND by isItemAccessible — so any
// action that goes through the accessibility check naturally refuses
// invisible items with the existing not-accessible rejection.
export function isVisible(
  obj: { visibleWhen?: Condition },
  state: GameState,
  story: Story,
): boolean {
  if (obj.visibleWhen && !evaluateCondition(obj.visibleWhen, state, story)) return false;
  if (story.defaultVisibility && !evaluateCondition(story.defaultVisibility, state, story)) return false;
  return true;
}

// True if the player can reach a container's contents right now. Containers
// that don't declare accessibleWhen are unconditionally accessible (e.g. an
// open basket). For openable containers the extractor wires up
// accessibleWhen referencing state.isOpen.
export function isContainerAccessible(
  item: Item,
  state: GameState,
  story: Story,
): boolean {
  if (!item.container) return true;
  if (!item.container.accessibleWhen) return true;
  return evaluateCondition(item.container.accessibleWhen, state, story);
}

// Passages that are perceptible from the player's current room — the player's
// location matches one of the passage's two sides AND the passage (and its
// player-facing side) pass the visibility filter (visibleWhen +
// Story.defaultVisibility). Used by the view AND the `examine` action so
// hidden passages are uniformly filtered out — no leak through examine.
export function passagesHere(state: GameState, story: Story): Passage[] {
  const passages = story.passages ?? [];
  return passages.filter((p) => {
    const side = p.sides.find((s) => s.roomId === state.playerLocation);
    if (!side) return false;
    if (!isVisible(p, state, story)) return false;
    if (!isVisible(side, state, story)) return false;
    return true;
  });
}

// The side metadata facing the player's current room, or undefined if the
// player isn't on either side. Use this to resolve per-side name/description
// or to find the per-side traversableWhen.
export function passageSideHere(passage: Passage, state: GameState) {
  return passage.sides.find((s) => s.roomId === state.playerLocation);
}

// Resolve a passage's name/description from the player's perspective. Order
// of precedence: matching side's variants > matching side's description >
// passage's variants > passage's description.
export function passagePresentation(
  passage: Passage,
  state: GameState,
  story: Story,
): { name: string; description: string } {
  const side = passageSideHere(passage, state);
  const name = side?.name ?? passage.name;
  const description =
    matchVariant(side?.variants, state, story) ??
    side?.description ??
    matchVariant(passage.variants, state, story) ??
    passage.description;
  return { name, description };
}

// Return the first variant whose condition is true, or undefined.
function matchVariant(
  variants: { when: Condition; text: string }[] | undefined,
  state: GameState,
  story: Story,
): string | undefined {
  if (!variants) return undefined;
  for (const v of variants) {
    if (evaluateCondition(v.when, state, story)) return v.text;
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
  if (!isVisible(item, state, story)) return false;
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
  if (requireOpen && parent.container && !isContainerAccessible(parent, state, story)) {
    return false; // hidden inside a closed/inaccessible container
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

export function evaluateCondition(
  c: Condition,
  state: GameState,
  story: Story,
): boolean {
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
    case "passageState":
      return state.passageStates[c.passageId]?.[c.key] === c.equals;
    case "itemState":
      return state.itemStates[c.itemId]?.[c.key] === c.equals;
    case "roomState":
      return state.roomStates[c.roomId]?.[c.key] === c.equals;
    case "currentRoomState":
      return state.roomStates[state.playerLocation]?.[c.key] === c.equals;
    case "anyPerceivableItemWith":
      return anyPerceivableItemWith(state, story, c.key, c.equals);
    case "intentMatched":
      return state.matchedIntents.includes(c.signalId);
    case "compare": {
      const left = evaluateNumericExpr(c.left, state);
      const right = evaluateNumericExpr(c.right, state);
      switch (c.op) {
        case "==": return left === right;
        case "!=": return left !== right;
        case "<": return left < right;
        case "<=": return left <= right;
        case ">": return left > right;
        case ">=": return left >= right;
      }
      return false;
    }
    case "always":
      return true;
    case "and":
      return c.all.every((sub) => evaluateCondition(sub, state, story));
    case "or":
      return c.any.some((sub) => evaluateCondition(sub, state, story));
    case "not":
      return !evaluateCondition(c.condition, state, story);
  }
}

// ---------- Numeric expression evaluation ----------
//
// NumericExpr is the value-producing counterpart to Condition. Used by the
// `compare` condition to compare any two numeric values: literals, flag
// values, derived counts, or (eventually) weight/size totals.
//
// Adding a new "source of integers" — e.g. `inventoryWeight` once items have
// `weight` — is a one-case extension here; the comparison logic doesn't change.
export function evaluateNumericExpr(expr: NumericExpr, state: GameState): number {
  switch (expr.kind) {
    case "literal":
      return expr.value;
    case "flag": {
      const v = state.flags[expr.key];
      return typeof v === "number" ? v : 0;
    }
    case "passageState": {
      const v = state.passageStates[expr.passageId]?.[expr.key];
      return typeof v === "number" ? v : 0;
    }
    case "itemState": {
      const v = state.itemStates[expr.itemId]?.[expr.key];
      return typeof v === "number" ? v : 0;
    }
    case "roomState": {
      const v = state.roomStates[expr.roomId]?.[expr.key];
      return typeof v === "number" ? v : 0;
    }
    case "inventoryCount":
      return countItemsAt(state, "inventory");
    case "itemCountAt":
      return countItemsAt(state, expr.location);
    case "matchedIntentsCount":
      return state.matchedIntents.length;
    case "visitedCount":
      return state.visitedRooms.length;
  }
}

function countItemsAt(state: GameState, location: string): number {
  let n = 0;
  for (const loc of Object.values(state.itemLocations)) {
    if (loc === location) n++;
  }
  return n;
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
    case "setPassageState": {
      const current = state.passageStates[e.passageId] ?? {};
      return {
        ...state,
        passageStates: {
          ...state.passageStates,
          [e.passageId]: { ...current, [e.key]: e.value },
        },
      };
    }
    case "setItemState": {
      const current = state.itemStates[e.itemId] ?? {};
      return {
        ...state,
        itemStates: {
          ...state.itemStates,
          [e.itemId]: { ...current, [e.key]: e.value },
        },
      };
    }
    case "setRoomState": {
      const current = state.roomStates[e.roomId] ?? {};
      return {
        ...state,
        roomStates: {
          ...state.roomStates,
          [e.roomId]: { ...current, [e.key]: e.value },
        },
      };
    }
    case "adjustFlag": {
      const cur = state.flags[e.key];
      const n = (typeof cur === "number" ? cur : 0) + e.by;
      return { ...state, flags: { ...state.flags, [e.key]: n } };
    }
    case "adjustItemState": {
      const current = state.itemStates[e.itemId] ?? {};
      const cur = current[e.key];
      const n = (typeof cur === "number" ? cur : 0) + e.by;
      return {
        ...state,
        itemStates: {
          ...state.itemStates,
          [e.itemId]: { ...current, [e.key]: n },
        },
      };
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
// description. Story.sharedVariants are checked AFTER the room's own variants
// so a story-wide "pitch black" can apply to all dark rooms without per-room
// authoring.
export function resolveRoomDescription(
  room: Room,
  state: GameState,
  story: Story,
): string {
  for (const variant of room.variants ?? []) {
    if (evaluateCondition(variant.when, state, story)) return variant.text;
  }
  for (const variant of story.sharedVariants ?? []) {
    if (evaluateCondition(variant.when, state, story)) return variant.text;
  }
  return room.description;
}

// Filter exits to those currently visible to the player. `hidden: true` exits
// are suppressed unless their gate is satisfied. An exit is gated by:
//   - exit.when condition (if present)
//   - exit.passage (if present, the passage's traversableWhen must hold for
//     the player's current side)
// Both must pass for the exit to be usable. The "blocking" reason for the
// passage check uses the passage's per-side traverseBlockedMessage if set.
export function visibleExits(
  room: Room,
  state: GameState,
  story: Story,
): Array<[
  string,
  { to: string; blocked: boolean; blockedMessage?: string; passageId?: string }
]> {
  const out: Array<[
    string,
    { to: string; blocked: boolean; blockedMessage?: string; passageId?: string }
  ]> = [];
  for (const [dir, exit] of Object.entries(room.exits ?? {})) {
    // Story-driven visibility filter (per-exit visibleWhen + Story.defaultVisibility).
    // Hides the exit entirely from the view (and from `go` resolution).
    if (!isVisible(exit, state, story)) continue;

    const conditionOk = !exit.when || evaluateCondition(exit.when, state, story);

    let passageOk = true;
    let passageBlockedMessage: string | undefined;
    if (exit.passage) {
      const passage = passageById(story, exit.passage);
      if (passage) {
        const fromSide = passage.sides.find((s) => s.roomId === room.id);
        const sideWhen = fromSide?.traversableWhen;
        const passageWhen = passage.traversableWhen;
        const effectiveWhen = sideWhen ?? passageWhen;
        if (effectiveWhen && !evaluateCondition(effectiveWhen, state, story)) {
          passageOk = false;
          passageBlockedMessage =
            fromSide?.traverseBlockedMessage ?? passage.traverseBlockedMessage;
        }
      }
    }

    const open = conditionOk && passageOk;
    if (exit.hidden && !open) continue;

    // Choose blockedMessage: story-authored exit message > passage-supplied
    // blocked message > undefined (renderer/LLM fall back to a generic line).
    const blockedMessage =
      exit.blockedMessage ??
      (!passageOk ? passageBlockedMessage : undefined);

    out.push([
      dir,
      {
        to: exit.to,
        blocked: !open,
        blockedMessage,
        passageId: exit.passage,
      },
    ]);
  }
  return out;
}
