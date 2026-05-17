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
import { renderNarration } from "./renderNarration";
import { substituteEffect } from "./substituteArgs";

// ---------- Player as item ----------

// The player is a tracked item with a reserved id. Their location lives in
// state.itemLocations["player"], and the player's room is derived by walking
// the parent chain. This unifies the player with NPCs and removes the need
// for separate playerLocation / playerVehicle fields on GameState.
export const PLAYER_ITEM_ID = "player";

// Legacy magic location string. Story authors can still write
// "location": "inventory" for items the player starts carrying — the
// initialState normalizer translates it to PLAYER_ITEM_ID. Engine code
// should prefer PLAYER_ITEM_ID; resolveLocation maps either to the canonical
// id.
const LEGACY_INVENTORY_ALIAS = "inventory";
// Sentinel resolved at effect-application time to the player's current room
// id. Lets a story author write generic "drop here" / "teleport here" effects
// without enumerating every possible room. Falls back to "nowhere" if the
// player's location chain is broken at evaluation time.
const CURRENT_ROOM_SENTINEL = "<current-room>";

export function resolveLocation(loc: string): string {
  return loc === LEGACY_INVENTORY_ALIAS ? PLAYER_ITEM_ID : loc;
}

// State-aware resolver. Same as resolveLocation but additionally swaps the
// "<current-room>" sentinel for the player's current room id (or "nowhere"
// if the chain is broken). Use at effect-application sites that touch the
// itemLocations map; not needed where the location is consumed only as a
// match key (since the sentinel string never appears in saved state).
export function resolveLocationDynamic(
  loc: string,
  state: GameState,
  story: Story | undefined,
): string {
  if (loc === CURRENT_ROOM_SENTINEL) {
    return story ? (currentRoomId(state, story) ?? "nowhere") : "nowhere";
  }
  return resolveLocation(loc);
}

// Walk the parent chain from the player item to the deepest room ancestor.
// Returns undefined only if the player's location chain is broken (e.g.
// dangles into "nowhere" or cycles). With normal state, always returns a
// Room.
export function currentRoom(state: GameState, story: Story): Room | undefined {
  const roomId = currentRoomId(state, story);
  return roomId ? roomById(story, roomId) : undefined;
}

// Same as currentRoom, but returns the roomId string. Used by callers that
// only need the id (saves, debug log, equality checks).
export function currentRoomId(state: GameState, story: Story): string | undefined {
  let loc = state.itemLocations[PLAYER_ITEM_ID];
  const seen = new Set<string>();
  while (loc !== undefined) {
    if (seen.has(loc)) return undefined; // cycle
    seen.add(loc);
    if (loc === "nowhere") return undefined;
    if (roomById(story, loc)) return loc;
    // loc is an itemId — recurse into that item's location.
    loc = state.itemLocations[loc];
  }
  return undefined;
}

// The player's immediate parent. Returns the itemId if the player is inside
// a vehicle / NPC / container; returns null if the player is at a room (or
// the chain is broken).
export function playerParentItemId(state: GameState, story: Story): string | null {
  const parent = state.itemLocations[PLAYER_ITEM_ID];
  if (!parent) return null;
  const item = itemById(story, parent);
  return item ? parent : null;
}

// The vehicle the player is currently inside, or null. Replaces the old
// state.playerVehicle field. Returns the itemId of the parent only if that
// parent has a `vehicle` field.
export function playerVehicleId(state: GameState, story: Story): string | null {
  const parentId = playerParentItemId(state, story);
  if (!parentId) return null;
  const item = itemById(story, parentId);
  return item?.vehicle ? parentId : null;
}

// ---------- Initial state ----------

export function initialState(story: Story): GameState {
  const itemLocations: Record<string, string> = {};
  const passageStates: Record<string, Record<string, Atom>> = {};
  const itemStates: Record<string, Record<string, Atom>> = {};
  const roomStates: Record<string, Record<string, Atom>> = {};

  for (const item of story.items) {
    // Normalize legacy "inventory" alias → "player". Stories declared before
    // the player-as-item refactor used the magic string "inventory".
    itemLocations[item.id] = resolveLocation(item.location);
    if (item.state) {
      itemStates[item.id] = { ...item.state };
    }
  }

  // Synthesize the player item if the story didn't declare one. Story authors
  // can override fields by declaring an item with id "player" in story.items;
  // that loop above already seeded itemLocations and itemStates from it.
  // If absent, seed the player's location to startRoom here.
  if (itemLocations[PLAYER_ITEM_ID] === undefined) {
    itemLocations[PLAYER_ITEM_ID] = story.startRoom;
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
    flags: { ...(story.startState ?? {}) },
    itemLocations,
    passageStates,
    itemStates,
    roomStates,
    matchedIntents: [],
    matchedIntentArgs: {},
    visitedRooms: [story.startRoom],
    examinedItems: [],
    firedTriggers: [],
  };
}

// Synthesizes a default player item if a story doesn't declare one. Returns
// the merged item: synthesized defaults + any overrides from story.items.
// Used by callers (view, actions) that need to read player.description /
// player.tags etc. Stories can override these by adding an item with id
// "player" in story.items.
export function getPlayerItem(story: Story): Item {
  const declared = itemById(story, PLAYER_ITEM_ID);
  const synthesized: Item = {
    id: PLAYER_ITEM_ID,
    name: "you",
    description: "As good-looking as ever.",
    location: story.startRoom,
    fixed: true,
    container: { capacity: 100 },
    tags: ["actor", "humanoid", "player"],
  };
  if (!declared) return synthesized;
  // Story-declared fields override defaults; merge fields shallowly.
  return { ...synthesized, ...declared };
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

// Walks the player's current room's exits and returns true if any item is
// directly located in any of those neighbor rooms with state[key] === equals.
//
// Intentionally ignores `visibleWhen` and `traversableWhen` on exits and
// passages — matches canonical Zork I "danger one room away" sword-glow
// detection (the I-SWORD daemon walks UEXIT/CEXIT/DEXIT regardless of
// whether the door is open). One-hop only; no transitive search.
export function anyAdjacentRoomItemWith(
  state: GameState,
  story: Story,
  key: string,
  equals: Atom,
): boolean {
  const room = currentRoom(state, story);
  if (!room?.exits) return false;
  const neighbors = new Set<string>();
  for (const ex of Object.values(room.exits)) {
    if (typeof ex.to === "string") neighbors.add(ex.to);
  }
  if (neighbors.size === 0) return false;
  for (const [itemId, loc] of Object.entries(state.itemLocations)) {
    if (!neighbors.has(loc)) continue;
    if (state.itemStates[itemId]?.[key] === equals) return true;
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
  const playerRoomId = currentRoomId(state, story);
  if (!playerRoomId) return [];
  const passages = story.passages ?? [];
  return passages.filter((p) => {
    const side = p.sides.find((s) => s.roomId === playerRoomId);
    if (!side) return false;
    if (!isVisible(p, state, story)) return false;
    if (!isVisible(side, state, story)) return false;
    return true;
  });
}

// The side metadata facing the player's current room, or undefined if the
// player isn't on either side. Use this to resolve per-side name/description
// or to find the per-side traversableWhen.
export function passageSideHere(
  passage: Passage,
  state: GameState,
  story: Story,
) {
  const playerRoomId = currentRoomId(state, story);
  if (!playerRoomId) return undefined;
  return passage.sides.find((s) => s.roomId === playerRoomId);
}

// Resolve a passage's name/description from the player's perspective. Order
// of precedence: matching side's variants > matching side's description >
// passage's variants > passage's description.
export function passagePresentation(
  passage: Passage,
  state: GameState,
  story: Story,
): { name: string; description: string } {
  const side = passageSideHere(passage, state, story);
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

// Walks the location chain to determine whether the player can perceive an
// item right now. The chain ends at: the player's current roomId (must match
// the room derived via currentRoomId), the player itself ("player" — meaning
// in inventory), or "nowhere" / cycle (never reachable).
//
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
  const playerRoomId = currentRoomId(state, story);
  if (playerRoomId && item.appearsIn?.includes(playerRoomId)) return true;
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
  const playerRoomId = currentRoomId(state, story);
  if (playerRoomId && item.appearsIn?.includes(playerRoomId)) return true;
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
  if (loc === undefined) return false;
  if (loc === "nowhere") return false;
  // Item is in the player's pocket (or transitively, the player is its parent).
  if (loc === PLAYER_ITEM_ID) return true;

  // Item is directly in the player's current room.
  const playerRoomId = currentRoomId(state, story);
  if (playerRoomId && loc === playerRoomId) return true;

  // Item is inside another item — recurse into the parent.
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
  return story.items.filter(
    (i) => i.id !== PLAYER_ITEM_ID && state.itemLocations[i.id] === roomId,
  );
}

// All items the player can currently perceive in the room — directly placed
// items plus items inside open containers (recursively). Inventory excluded;
// fetch that separately. The player item itself is also excluded.
export function itemsAccessibleHere(state: GameState, story: Story): Item[] {
  return story.items.filter((i) => {
    if (i.id === PLAYER_ITEM_ID) return false;
    if (state.itemLocations[i.id] === PLAYER_ITEM_ID) return false; // in inventory
    return isItemAccessible(i, state, story);
  });
}

export function itemsInInventory(state: GameState, story: Story): Item[] {
  return story.items.filter(
    (i) => i.id !== PLAYER_ITEM_ID && state.itemLocations[i.id] === PLAYER_ITEM_ID,
  );
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
      // Defensive: if a {fromArg} slipped through (e.g. handler dispatch
      // skipped substitution), return false rather than crash.
      if (typeof c.itemId !== "string") return false;
      return state.itemLocations[c.itemId] === PLAYER_ITEM_ID;
    case "itemAt":
      // Resolve the legacy "inventory" alias so authors can still write
      // itemAt(X, "inventory") and have it match items at the player.
      return state.itemLocations[c.itemId] === resolveLocation(c.location);
    case "itemContainedBy": {
      // Defensive: if {fromArg} substitution didn't resolve, skip.
      if (typeof c.itemId !== "string" || typeof c.containerId !== "string") return false;
      const visited = new Set<string>();
      let cur: string | undefined = state.itemLocations[c.itemId];
      while (cur !== undefined && !visited.has(cur)) {
        if (cur === c.containerId) return true;
        visited.add(cur);
        cur = state.itemLocations[cur];
      }
      return false;
    }
    case "playerAt":
      return currentRoomId(state, story) === c.roomId;
    case "visited":
      return state.visitedRooms.includes(c.roomId);
    case "examined":
      return state.examinedItems.includes(c.itemId);
    case "triggerFired":
      return state.firedTriggers.includes(c.triggerId);
    case "passageState":
      // IdRef-aware. Defensive false on unresolved {fromArg} or missing passage.
      if (typeof c.passageId !== "string") return false;
      return state.passageStates[c.passageId]?.[c.key] === c.equals;
    case "itemState":
      // IdRef should be resolved before reaching the evaluator. Defensive
      // skip if a {fromArg} slipped through (would always evaluate to false).
      if (typeof c.itemId !== "string") return false;
      return state.itemStates[c.itemId]?.[c.key] === c.equals;
    case "roomState":
      return state.roomStates[c.roomId]?.[c.key] === c.equals;
    case "currentRoomState": {
      const playerRoomId = currentRoomId(state, story);
      if (!playerRoomId) return false;
      return state.roomStates[playerRoomId]?.[c.key] === c.equals;
    }
    case "anyPerceivableItemWith":
      return anyPerceivableItemWith(state, story, c.key, c.equals);
    case "anyAdjacentRoomItemWith":
      return anyAdjacentRoomItemWith(state, story, c.key, c.equals);
    case "itemHasTag": {
      const item = itemById(story, c.itemId);
      return !!item?.tags?.includes(c.tag);
    }
    case "flagItemHasTag": {
      // Look up the item id from a flag, then check tags. Used by combat
      // triggers to ask "the weapon being used (whichever item that is) — does
      // it have tag X?" without needing to enumerate weapons.
      const flagVal = state.flags[c.flagKey];
      if (typeof flagVal !== "string") return false;
      const item = itemById(story, flagVal);
      return !!item?.tags?.includes(c.tag);
    }
    case "intentMatched":
      return state.matchedIntents.includes(c.signalId);
    case "intentArg":
      return state.matchedIntentArgs[c.signalId]?.[c.key] === c.equals;
    case "itemAccessible": {
      // IdRef should be resolved to a string before reaching the evaluator.
      // Defensive: if a {fromArg} slipped through (e.g. handler dispatch
      // skipped substitution), return false rather than crash.
      if (typeof c.itemId !== "string") return false;
      const item = itemById(story, c.itemId);
      return !!item && isItemAccessible(item, state, story);
    }
    case "itemHasStateKey": {
      if (typeof c.itemId !== "string") return false;
      const item = itemById(story, c.itemId);
      if (!item) return false;
      return item.state?.[c.key] !== undefined;
    }
    case "itemReadable": {
      if (typeof c.itemId !== "string") return false;
      const item = itemById(story, c.itemId);
      if (!item) return false;
      return item.readable !== undefined;
    }
    case "passagePerceivable": {
      if (typeof c.passageId !== "string") return false;
      const passage = passageById(story, c.passageId);
      if (!passage) return false;
      // Visible AND one of its sides is the player's current room (otherwise
      // the player isn't standing where they could interact with it).
      if (!isVisible(passage, state, story)) return false;
      const playerRoomId = currentRoomId(state, story);
      if (!playerRoomId) return false;
      return passage.sides.some((s) => s.roomId === playerRoomId);
    }
    case "passageHasStateKey": {
      if (typeof c.passageId !== "string") return false;
      const passage = passageById(story, c.passageId);
      if (!passage) return false;
      return passage.state?.[c.key] !== undefined;
    }
    case "inventoryHasTag":
      // Walk all items; first match wins. O(n) but n is small (~100 for Zork).
      return story.items.some(
        (it) =>
          it.id !== PLAYER_ITEM_ID &&
          state.itemLocations[it.id] === PLAYER_ITEM_ID &&
          (it.tags ?? []).includes(c.tag),
      );
    case "inVehicle": {
      // c.itemId is optional: if given, must be that specific vehicle;
      // otherwise true if player is in any vehicle at all.
      const vehicleId = playerVehicleId(state, story);
      if (c.itemId !== undefined) return vehicleId === c.itemId;
      return vehicleId !== null;
    }
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
// True when the item is transitively in the player's possession — directly in
// inventory, or nested inside any container the player carries. Walks the
// itemLocations chain; cycle-guarded.
export function isCarried(itemId: string, state: GameState): boolean {
  const seen = new Set<string>();
  let loc: string | undefined = state.itemLocations[itemId];
  while (loc !== undefined && !seen.has(loc)) {
    if (loc === PLAYER_ITEM_ID) return true;
    seen.add(loc);
    loc = state.itemLocations[loc];
  }
  return false;
}

// Recursive weight of one item: its own state.weight plus the weight of
// everything located inside it (and their contents). Cycle-guarded.
function itemWeightOf(itemId: string, state: GameState, seen: Set<string>): number {
  if (seen.has(itemId)) return 0;
  seen.add(itemId);
  let total = 0;
  const w = state.itemStates[itemId]?.weight;
  if (typeof w === "number") total += w;
  for (const [id, loc] of Object.entries(state.itemLocations)) {
    if (loc === itemId) total += itemWeightOf(id, state, seen);
  }
  return total;
}

export function evaluateNumericExpr(expr: NumericExpr, state: GameState): number {
  switch (expr.kind) {
    case "literal":
      return expr.value;
    case "flag": {
      const v = state.flags[expr.key];
      return typeof v === "number" ? v : 0;
    }
    case "passageState": {
      // expr.passageId is IdRef. Substitution should have happened upstream;
      // an unsubstituted {fromArg} object means a code path forgot to call
      // the substituter. Fall back to 0 with a warning rather than crashing.
      if (typeof expr.passageId !== "string") {
        console.warn(`[evaluateNumericExpr] passageState.passageId is unsubstituted IdRef:`, expr.passageId);
        return 0;
      }
      const v = state.passageStates[expr.passageId]?.[expr.key];
      return typeof v === "number" ? v : 0;
    }
    case "itemState": {
      if (typeof expr.itemId !== "string") {
        console.warn(`[evaluateNumericExpr] itemState.itemId is unsubstituted IdRef:`, expr.itemId);
        return 0;
      }
      const v = state.itemStates[expr.itemId]?.[expr.key];
      return typeof v === "number" ? v : 0;
    }
    case "roomState": {
      const v = state.roomStates[expr.roomId]?.[expr.key];
      return typeof v === "number" ? v : 0;
    }
    case "inventoryCount":
      return countItemsAt(state, PLAYER_ITEM_ID);
    case "inventoryWeight": {
      // Total weight the player bears: every item transitively in the player's
      // possession, including items nested inside carried containers.
      let total = 0;
      for (const id of Object.keys(state.itemLocations)) {
        if (id === PLAYER_ITEM_ID) continue;
        if (!isCarried(id, state)) continue;
        const w = state.itemStates[id]?.weight;
        if (typeof w === "number") total += w;
      }
      return total;
    }
    case "itemWeight": {
      if (typeof expr.itemId !== "string") {
        console.warn(`[evaluateNumericExpr] itemWeight.itemId is unsubstituted IdRef:`, expr.itemId);
        return 0;
      }
      return itemWeightOf(expr.itemId, state, new Set());
    }
    case "itemCountAt":
      // Resolve the legacy "inventory" alias.
      return countItemsAt(state, resolveLocation(expr.location));
    case "matchedIntentsCount":
      return state.matchedIntents.length;
    case "visitedCount":
      return state.visitedRooms.length;
    case "add":
      return evaluateNumericExpr(expr.left, state) + evaluateNumericExpr(expr.right, state);
    case "negate":
      return -evaluateNumericExpr(expr.of, state);
  }
}

function countItemsAt(state: GameState, location: string): number {
  let n = 0;
  for (const [id, loc] of Object.entries(state.itemLocations)) {
    if (id === PLAYER_ITEM_ID) continue; // never count the player itself
    if (loc === location) n++;
  }
  return n;
}

// ---------- Effect application ----------

export function applyEffect(state: GameState, e: Effect, story?: Story): GameState {
  switch (e.type) {
    case "setFlag":
      return { ...state, flags: { ...state.flags, [e.key]: e.value } };
    case "moveItem": {
      // itemId is IdRef; substitution upstream should have resolved it.
      // If it's still an object ({fromArg} or {fromIntent}), the substitution
      // failed (missing arg, missing matched intent) — skip the mutation
      // defensively rather than corrupt itemLocations with a stringified
      // object key.
      if (typeof e.itemId !== "string") {
        console.warn(`[applyEffect] moveItem.itemId is unsubstituted IdRef:`, e.itemId);
        return state;
      }
      // Resolve "inventory" legacy alias and "<current-room>" sentinel.
      const to = resolveLocationDynamic(e.to, state, story);
      const next = { ...state.itemLocations, [e.itemId]: to };
      // If this is the player moving to a room, update visitedRooms. If
      // moving the player into a vehicle/NPC/etc., the room they're
      // transitively in doesn't change, so visitedRooms stays the same.
      let visitedRooms = state.visitedRooms;
      if (e.itemId === PLAYER_ITEM_ID && story && roomById(story, to)) {
        if (!visitedRooms.includes(to)) {
          visitedRooms = [...visitedRooms, to];
        }
      }
      return { ...state, itemLocations: next, visitedRooms };
    }
    case "moveItemsFrom": {
      // Bulk: every item currently at `from` moves to `to`. No-op for items
      // not at `from`. Iterates state.itemLocations once. Both `from` and
      // `to` resolve the legacy "inventory" alias and the "<current-room>"
      // sentinel.
      const from = resolveLocationDynamic(e.from, state, story);
      const to = resolveLocationDynamic(e.to, state, story);
      const next: Record<string, string> = { ...state.itemLocations };
      for (const [id, loc] of Object.entries(state.itemLocations)) {
        if (loc === from) next[id] = to;
      }
      return { ...state, itemLocations: next };
    }
    case "setPassageState": {
      // Defensive: skip if {fromArg} unresolved OR id doesn't reference a
      // known passage. The latter case is intentional — handlers that target
      // either items OR passages emit BOTH setItemState and setPassageState
      // with the same id; only the matching one mutates.
      if (typeof e.passageId !== "string") return state;
      if (story && !passageById(story, e.passageId)) return state;
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
      // Defensive: skip if {fromArg} unresolved OR id doesn't reference a
      // known item. Same dual-effect pattern as setPassageState.
      if (typeof e.itemId !== "string") return state;
      if (story && !itemById(story, e.itemId)) return state;
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
      // `by` is either a literal number or a NumericExpr; evaluate the latter
      // against current state at effect-application time.
      const delta = typeof e.by === "number" ? e.by : evaluateNumericExpr(e.by, state);
      const n = (typeof cur === "number" ? cur : 0) + delta;
      return { ...state, flags: { ...state.flags, [e.key]: n } };
    }
    case "adjustItemState": {
      // adjustItemState.itemId may be IdRef; substitution upstream should
      // have resolved it. If it's still {fromArg}, log and skip the mutation.
      if (typeof e.itemId !== "string") {
        console.warn(`[applyEffect] adjustItemState.itemId is unsubstituted IdRef:`, e.itemId);
        return state;
      }
      const current = state.itemStates[e.itemId] ?? {};
      const cur = current[e.key];
      const delta = typeof e.by === "number" ? e.by : evaluateNumericExpr(e.by, state);
      const n = (typeof cur === "number" ? cur : 0) + delta;
      return {
        ...state,
        itemStates: {
          ...state.itemStates,
          [e.itemId]: { ...current, [e.key]: n },
        },
      };
    }
    case "removeMatchedIntent": {
      const { [e.signalId]: _removed, ...remainingArgs } = state.matchedIntentArgs;
      return {
        ...state,
        matchedIntents: state.matchedIntents.filter((id) => id !== e.signalId),
        matchedIntentArgs: remainingArgs,
      };
    }
    case "setFlagRandom": {
      // Roll a uniform random integer in [min, max] inclusive and write it
      // as a number to state.flags[key]. Defensive against invalid ranges:
      // if max < min, clamp to min (logged-zero fallback would mask bugs;
      // the validator should have rejected this story load anyway).
      const lo = Math.min(e.min, e.max);
      const hi = Math.max(e.min, e.max);
      const rolled = Math.floor(Math.random() * (hi - lo + 1)) + lo;
      return { ...state, flags: { ...state.flags, [e.key]: rolled } };
    }
    case "narrate":
      // No state mutation — cue collection happens in `resolveEffects`.
      // applyEffect is called directly (without resolveEffects) by the
      // recordIntent handler dispatch; in that path the cue is silently lost.
      // That's acceptable: handlers use successNarration for their output.
      return state;
    case "if": {
      // Deterministic conditional. Evaluates `if` against current state; runs
      // `then` if true, else `else` (or no-op when `else` is absent).
      // Defensive: if story isn't passed (legacy callers), treat condition as
      // unevaluable and skip — same posture as the prior random filter.
      if (!story) return state;
      const branch = evaluateCondition(e.if, state, story) ? e.then : (e.else ?? []);
      return applyEffects(state, branch);
    }
    case "endGame": {
      // Render the message template now so {flag.score}, {rank}, etc.
      // capture the live state at the moment endGame fires. If story isn't
      // passed (defensive — applyEffect's story param is optional for legacy
      // callers), the message is stored verbatim.
      const message = story ? renderNarration(e.message, {}, story, state) : e.message;
      return { ...state, finished: { won: e.won, message } };
    }
  }
}

// Apply a trigger's effects in sequence against rolling state, evaluating
// `if` against the LIVE state (so a `setFlagRandom` earlier in the list is
// visible to a later `if(compare(flag, ...))` — the canonical decomposition
// pattern), and collecting `narrate` cues into the return value.
//
// IdRef substitution: each effect is substituted against the rolling state
// (no handler args, since triggers don't have a call-args context — only
// state.matchedIntentArgs via {fromIntent} IdRefs). substituteEffect
// returns null if a required IdRef can't resolve; in that case the effect
// is skipped (defensive — same posture as handler dispatch).
//
// This is the trigger pipeline's apply path. Handler dispatch (in actions.ts)
// uses applyEffect directly per-effect; that path doesn't capture narrate
// cues (handlers use successNarration instead).
//
// Returns the final state plus the ordered narrate cues. `effects` in the
// return is empty (everything was applied here) — the field is kept for
// caller compatibility; pass it to applyEffects and it'll be a no-op.
export function resolveEffects(
  effects: Effect[] | undefined,
  state: GameState,
  story: Story,
): { state: GameState; effects: Effect[]; cues: string[] } {
  if (!effects || effects.length === 0) {
    return { state, effects: [], cues: [] };
  }
  let cur = state;
  const cues: string[] = [];
  for (const raw of effects) {
    // Resolve {fromIntent} IdRefs against the rolling state. No handler args
    // in trigger context — pass {}. substituteEffect returns null when a
    // required IdRef can't resolve; skip those defensively.
    const e = substituteEffect(raw, {}, cur);
    if (e === null) continue;
    if (e.type === "narrate") {
      // Pure cue. State unchanged.
      cues.push(renderNarration(e.text, {}, story, cur));
      continue;
    }
    if (e.type === "if") {
      // Evaluate against the LIVE rolling state — prior effects (e.g. a
      // setFlagRandom earlier in the list) are visible. Recurse on chosen branch.
      const branch = evaluateCondition(e.if, cur, story) ? e.then : (e.else ?? []);
      const inner = resolveEffects(branch, cur, story);
      cur = inner.state;
      cues.push(...inner.cues);
      continue;
    }
    cur = applyEffect(cur, e, story);
  }
  return { state: cur, effects: [], cues };
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

// Pick the first matching variant for an item, or fall back to the canonical
// description. Used by `examine` so item descriptions can reflect state
// (e.g. sword glowing when a hostile NPC is perceivable).
export function resolveItemDescription(
  item: Item,
  state: GameState,
  story: Story,
): string {
  for (const variant of item.variants ?? []) {
    if (evaluateCondition(variant.when, state, story)) return variant.text;
  }
  return item.description;
}

// Resolve the room-presence "appearance" line. Walks appearanceVariants
// first, then falls back to item.appearance. Returns undefined if neither
// is set — items without an appearance don't surface a room-presence line
// (current behavior pre-feature).
export function resolveItemAppearance(
  item: Item,
  state: GameState,
  story: Story,
): string | undefined {
  for (const variant of item.appearanceVariants ?? []) {
    if (evaluateCondition(variant.when, state, story)) return variant.text;
  }
  return item.appearance;
}

// Resolve the display name. Walks nameVariants first, then falls back to
// item.name. Used everywhere the engine renders the item's label so the
// view stays honest when an item's identity changes with state.
export function resolveItemName(
  item: Item,
  state: GameState,
  story: Story,
): string {
  for (const variant of item.nameVariants ?? []) {
    if (evaluateCondition(variant.when, state, story)) return variant.name;
  }
  return item.name;
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
    // ONLY surface blockedMessage when the exit is actually blocked. Otherwise
    // the canonical refusal text leaks into the view JSON and the LLM
    // pattern-matches against it — narrating a passable exit as blocked using
    // its own authored refusal prose. (See troll-room post-defeat and
    // reservoir-south at low-tide for symptomatic transcripts.)
    const blockedMessage = !open
      ? exit.blockedMessage ?? (!passageOk ? passageBlockedMessage : undefined)
      : undefined;

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
