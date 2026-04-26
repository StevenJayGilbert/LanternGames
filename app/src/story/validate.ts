// Runtime validator for the story schema.
//
// Used at story-load time by the engine (Phase 3) and by the authoring CLI
// (Phase 9). Returns either a typed Story or a list of human-readable errors.
//
// Goals: catch the cases that would crash the engine or produce a broken game,
// not enforce every type-system nicety. Common gotchas this catches:
//   - missing required fields
//   - exit destinations that don't resolve
//   - item locations that don't resolve
//   - trigger references to nonexistent items/rooms
//   - startRoom that isn't in the rooms list
//   - duplicate ids

import type { Atom, Story } from "./schema";
import { SCHEMA_VERSION } from "./schema";

export interface ValidationError {
  path: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; story: Story }
  | { ok: false; errors: ValidationError[] };

const SPECIAL_LOCATIONS = new Set(["inventory", "nowhere"]);

export function validateStory(input: unknown): ValidationResult {
  const errors: ValidationError[] = [];
  const err = (path: string, message: string) => errors.push({ path, message });

  if (!isObject(input)) {
    return { ok: false, errors: [{ path: "$", message: "story must be an object" }] };
  }

  requireString(input, "schemaVersion", err);
  requireString(input, "id", err);
  requireString(input, "title", err);
  requireString(input, "author", err);
  requireString(input, "startRoom", err);

  optionalString(input, "description", err);
  optionalString(input, "intro", err);
  optionalString(input, "systemPromptOverride", err);

  if (typeof input.schemaVersion === "string" && input.schemaVersion !== SCHEMA_VERSION) {
    err("schemaVersion", `unsupported schema version "${input.schemaVersion}" (this engine speaks ${SCHEMA_VERSION})`);
  }

  const rooms = expectArray(input, "rooms", err) ?? [];
  const roomIds = collectIds(rooms, "rooms", err);
  rooms.forEach((room, i) => validateRoom(room, `rooms[${i}]`, roomIds, err));

  const items = expectArray(input, "items", err) ?? [];
  const itemIds = collectIds(items, "items", err);
  items.forEach((item, i) => validateItem(item, `items[${i}]`, roomIds, itemIds, err));
  detectContainerCycles(items, err);

  // Doors share an id namespace with items so action tools (open/close/examine)
  // can dispatch on a single id without ambiguity.
  const doors = optionalArray(input, "doors", err) ?? [];
  const doorIds = collectIds(doors, "doors", err);
  for (const id of doorIds) {
    if (itemIds.has(id)) {
      err(`doors`, `door id "${id}" collides with an item id`);
    }
  }
  doors.forEach((d, i) => validateDoor(d, `doors[${i}]`, roomIds, err));

  // Validate exit door references after doors are collected.
  if (Array.isArray(input.rooms)) {
    input.rooms.forEach((rawRoom, ri) => {
      if (!isObject(rawRoom)) return;
      const exits = rawRoom.exits;
      if (!isObject(exits)) return;
      for (const [dir, exit] of Object.entries(exits)) {
        if (!isObject(exit)) continue;
        if (exit.door !== undefined) {
          if (typeof exit.door !== "string") {
            err(`rooms[${ri}].exits.${dir}.door`, "must be a string");
          } else if (!doorIds.has(exit.door)) {
            err(`rooms[${ri}].exits.${dir}.door`, `unknown door "${exit.door}"`);
          }
        }
      }
    });
  }

  if (typeof input.startRoom === "string" && !roomIds.has(input.startRoom)) {
    err("startRoom", `references unknown room "${input.startRoom}"`);
  }

  const triggers = optionalArray(input, "triggers", err) ?? [];
  const triggerIds = collectIds(triggers, "triggers", err);
  triggers.forEach((t, i) =>
    validateTrigger(t, `triggers[${i}]`, roomIds, itemIds, triggerIds, err),
  );

  const npcs = optionalArray(input, "npcs", err) ?? [];
  npcs.forEach((npc, i) => validateNpc(npc, `npcs[${i}]`, roomIds, err));

  const intentSignals = optionalArray(input, "intentSignals", err) ?? [];
  // collectIds runs duplicate-id detection as a side effect; the returned set
  // isn't needed because intentMatched conditions skip reference validation.
  collectIds(intentSignals, "intentSignals", err);
  intentSignals.forEach((s, i) =>
    validateIntentSignal(s, `intentSignals[${i}]`, roomIds, itemIds, triggerIds, err),
  );

  const winConds = optionalArray(input, "winConditions", err) ?? [];
  winConds.forEach((c, i) =>
    validateEndCondition(c, `winConditions[${i}]`, roomIds, itemIds, triggerIds, err),
  );
  const loseConds = optionalArray(input, "loseConditions", err) ?? [];
  loseConds.forEach((c, i) =>
    validateEndCondition(c, `loseConditions[${i}]`, roomIds, itemIds, triggerIds, err),
  );

  if ("startState" in input && input.startState !== undefined) {
    if (!isObject(input.startState)) {
      err("startState", "must be an object of string→atom");
    } else {
      for (const [k, v] of Object.entries(input.startState)) {
        if (!isAtom(v)) err(`startState.${k}`, "must be string, number, or boolean");
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, story: input as unknown as Story };
}

function validateRoom(
  raw: unknown,
  path: string,
  roomIds: Set<string>,
  err: (p: string, m: string) => void,
) {
  if (!isObject(raw)) return err(path, "must be an object");
  requireString(raw, "id", err, path);
  requireString(raw, "name", err, path);
  requireString(raw, "description", err, path);

  const exits = raw.exits;
  if (exits !== undefined) {
    if (!isObject(exits)) {
      err(`${path}.exits`, "must be a direction→exit object");
    } else {
      for (const [dir, exit] of Object.entries(exits)) {
        const ep = `${path}.exits.${dir}`;
        if (!isObject(exit)) { err(ep, "must be an object"); continue; }
        if (typeof exit.to !== "string") err(`${ep}.to`, "missing or not a string");
        else if (!roomIds.has(exit.to)) err(`${ep}.to`, `unknown room "${exit.to}"`);
        if (exit.when !== undefined) validateCondition(exit.when, `${ep}.when`, roomIds, new Set(), new Set(), err);
        if (exit.blockedMessage !== undefined && typeof exit.blockedMessage !== "string") {
          err(`${ep}.blockedMessage`, "must be a string");
        }
      }
    }
  }

  const variants = raw.variants;
  if (variants !== undefined) {
    if (!Array.isArray(variants)) err(`${path}.variants`, "must be an array");
    else variants.forEach((v, i) => {
      if (!isObject(v)) return err(`${path}.variants[${i}]`, "must be an object");
      if (typeof v.text !== "string") err(`${path}.variants[${i}].text`, "must be a string");
      if (v.when === undefined) err(`${path}.variants[${i}].when`, "missing condition");
      else validateCondition(v.when, `${path}.variants[${i}].when`, roomIds, new Set(), new Set(), err);
    });
  }
}

function validateItem(
  raw: unknown,
  path: string,
  roomIds: Set<string>,
  itemIds: Set<string>,
  err: (p: string, m: string) => void,
) {
  if (!isObject(raw)) return err(path, "must be an object");
  requireString(raw, "id", err, path);
  requireString(raw, "name", err, path);
  requireString(raw, "description", err, path);
  requireString(raw, "location", err, path);

  if (typeof raw.location === "string") {
    const loc = raw.location;
    const isOwnId = typeof raw.id === "string" && loc === raw.id;
    const isValid =
      SPECIAL_LOCATIONS.has(loc) ||
      roomIds.has(loc) ||
      (itemIds.has(loc) && !isOwnId);
    if (!isValid) {
      const detail = isOwnId
        ? "an item cannot be located inside itself"
        : `unknown location "${loc}" (must be a roomId, an itemId, "inventory", or "nowhere")`;
      err(`${path}.location`, detail);
    }
  }

  optionalStringArray(raw, "synonyms", err, path);
  optionalStringArray(raw, "adjectives", err, path);
  optionalBoolean(raw, "takeable", err, path);
  optionalBoolean(raw, "fixed", err, path);

  // appearsIn: optional array of room ids where this item is also perceptible
  if ("appearsIn" in raw && raw.appearsIn !== undefined) {
    const arr = raw.appearsIn;
    if (!Array.isArray(arr)) {
      err(`${path}.appearsIn`, "must be an array of room ids");
    } else {
      arr.forEach((r, i) => {
        if (typeof r !== "string") {
          err(`${path}.appearsIn[${i}]`, "must be a string");
        } else if (!roomIds.has(r)) {
          err(`${path}.appearsIn[${i}]`, `unknown room "${r}"`);
        }
      });
    }
  }
}

// Detect container cycles: A → B → A or longer. Items located in other items
// must form a forest (each item has at most one parent), and following parents
// must eventually reach a non-item location.
function detectContainerCycles(
  items: unknown[],
  err: (p: string, m: string) => void,
) {
  const parentOf = new Map<string, string>();
  const itemIds = new Set<string>();
  for (const raw of items) {
    if (!isObject(raw) || typeof raw.id !== "string") continue;
    itemIds.add(raw.id);
    if (typeof raw.location === "string") parentOf.set(raw.id, raw.location);
  }
  for (const id of itemIds) {
    const visited = new Set<string>();
    let current: string | undefined = id;
    while (current && itemIds.has(current)) {
      if (visited.has(current)) {
        err(`items[${id}].location`, `container cycle detected at "${current}"`);
        break;
      }
      visited.add(current);
      current = parentOf.get(current);
    }
  }
}

function validateTrigger(
  raw: unknown,
  path: string,
  roomIds: Set<string>,
  itemIds: Set<string>,
  triggerIds: Set<string>,
  err: (p: string, m: string) => void,
) {
  if (!isObject(raw)) return err(path, "must be an object");
  requireString(raw, "id", err, path);
  if (raw.when === undefined) err(`${path}.when`, "missing condition");
  else validateCondition(raw.when, `${path}.when`, roomIds, itemIds, triggerIds, err);
  if (raw.effects !== undefined) {
    if (!Array.isArray(raw.effects)) err(`${path}.effects`, "must be an array");
    else raw.effects.forEach((e, i) => validateEffect(e, `${path}.effects[${i}]`, roomIds, itemIds, err));
  }
  if (raw.narration !== undefined && typeof raw.narration !== "string") {
    err(`${path}.narration`, "must be a string");
  }
  optionalBoolean(raw, "once", err, path);
}

const SUPPORTED_DOOR_KINDS = new Set(["simple"]);

function validateDoor(
  raw: unknown,
  path: string,
  roomIds: Set<string>,
  err: (p: string, m: string) => void,
) {
  if (!isObject(raw)) return err(path, "must be an object");
  requireString(raw, "id", err, path);
  requireString(raw, "name", err, path);
  requireString(raw, "description", err, path);

  // kind is optional in v1; default "simple". When present, must be supported.
  if (raw.kind !== undefined) {
    if (typeof raw.kind !== "string") {
      err(`${path}.kind`, "must be a string");
    } else if (!SUPPORTED_DOOR_KINDS.has(raw.kind)) {
      err(
        `${path}.kind`,
        `unsupported door kind "${raw.kind}" (this engine speaks: ${[...SUPPORTED_DOOR_KINDS].join(", ")})`,
      );
    }
  }

  const sides = raw.sides;
  if (!Array.isArray(sides)) {
    err(`${path}.sides`, "must be an array of exactly two side objects");
  } else if (sides.length !== 2) {
    err(`${path}.sides`, `must contain exactly two sides (got ${sides.length})`);
  } else {
    sides.forEach((side, i) => validateDoorSide(side, `${path}.sides[${i}]`, roomIds, err));
    if (
      isObject(sides[0]) &&
      isObject(sides[1]) &&
      sides[0].roomId === sides[1].roomId
    ) {
      err(`${path}.sides`, "the two sides must reference different rooms");
    }
  }

  optionalBoolean(raw, "isOpen", err, path);

  // variants: optional, same shape as Room.variants.
  if (raw.variants !== undefined) {
    if (!Array.isArray(raw.variants)) err(`${path}.variants`, "must be an array");
    else raw.variants.forEach((v, i) => {
      if (!isObject(v)) return err(`${path}.variants[${i}]`, "must be an object");
      if (typeof v.text !== "string") err(`${path}.variants[${i}].text`, "must be a string");
      if (v.when === undefined) err(`${path}.variants[${i}].when`, "missing condition");
      else validateCondition(v.when, `${path}.variants[${i}].when`, roomIds, new Set(), new Set(), err);
    });
  }

  if (raw.glimpse !== undefined) {
    validateGlimpse(raw.glimpse, `${path}.glimpse`, roomIds, err);
  }

  if (raw.openableWhen !== undefined) {
    validateCondition(raw.openableWhen, `${path}.openableWhen`, roomIds, new Set(), new Set(), err);
  }
  optionalString(raw, "openBlockedMessage", err, path);
}

function validateGlimpse(
  raw: unknown,
  path: string,
  roomIds: Set<string>,
  err: (p: string, m: string) => void,
) {
  if (!isObject(raw)) return err(path, "must be an object");
  if (raw.when !== undefined) {
    validateCondition(raw.when, `${path}.when`, roomIds, new Set(), new Set(), err);
  }
  optionalString(raw, "description", err, path);
  optionalString(raw, "prompt", err, path);
}

function validateDoorSide(
  raw: unknown,
  path: string,
  roomIds: Set<string>,
  err: (p: string, m: string) => void,
) {
  if (!isObject(raw)) return err(path, "must be an object");
  requireString(raw, "roomId", err, path);
  if (typeof raw.roomId === "string" && !roomIds.has(raw.roomId)) {
    err(`${path}.roomId`, `unknown room "${raw.roomId}"`);
  }
  optionalString(raw, "name", err, path);
  optionalString(raw, "description", err, path);

  if (raw.glimpse !== undefined) {
    validateGlimpse(raw.glimpse, `${path}.glimpse`, roomIds, err);
  }

  if (raw.openableWhen !== undefined) {
    validateCondition(raw.openableWhen, `${path}.openableWhen`, roomIds, new Set(), new Set(), err);
  }
  optionalString(raw, "openBlockedMessage", err, path);

  if (raw.variants !== undefined) {
    if (!Array.isArray(raw.variants)) err(`${path}.variants`, "must be an array");
    else raw.variants.forEach((v, i) => {
      if (!isObject(v)) return err(`${path}.variants[${i}]`, "must be an object");
      if (typeof v.text !== "string") err(`${path}.variants[${i}].text`, "must be a string");
      if (v.when === undefined) err(`${path}.variants[${i}].when`, "missing condition");
      else validateCondition(v.when, `${path}.variants[${i}].when`, roomIds, new Set(), new Set(), err);
    });
  }
}

function validateIntentSignal(
  raw: unknown,
  path: string,
  roomIds: Set<string>,
  itemIds: Set<string>,
  triggerIds: Set<string>,
  err: (p: string, m: string) => void,
) {
  if (!isObject(raw)) return err(path, "must be an object");
  requireString(raw, "id", err, path);
  requireString(raw, "prompt", err, path);
  if (raw.active !== undefined) {
    validateCondition(raw.active, `${path}.active`, roomIds, itemIds, triggerIds, err);
  }
}

function validateNpc(
  raw: unknown,
  path: string,
  roomIds: Set<string>,
  err: (p: string, m: string) => void,
) {
  if (!isObject(raw)) return err(path, "must be an object");
  requireString(raw, "id", err, path);
  requireString(raw, "name", err, path);
  requireString(raw, "personality", err, path);
  requireString(raw, "location", err, path);
  if (typeof raw.location === "string" && !roomIds.has(raw.location)) {
    err(`${path}.location`, `unknown room "${raw.location}"`);
  }
}

function validateEndCondition(
  raw: unknown,
  path: string,
  roomIds: Set<string>,
  itemIds: Set<string>,
  triggerIds: Set<string>,
  err: (p: string, m: string) => void,
) {
  if (!isObject(raw)) return err(path, "must be an object");
  requireString(raw, "message", err, path);
  if (raw.when === undefined) err(`${path}.when`, "missing condition");
  else validateCondition(raw.when, `${path}.when`, roomIds, itemIds, triggerIds, err);
}

function validateCondition(
  raw: unknown,
  path: string,
  roomIds: Set<string>,
  itemIds: Set<string>,
  triggerIds: Set<string>,
  err: (p: string, m: string) => void,
) {
  if (!isObject(raw)) return err(path, "must be an object");
  const t = raw.type;
  switch (t) {
    case "flag":
      if (typeof raw.key !== "string") err(`${path}.key`, "must be a string");
      if (!isAtom(raw.equals)) err(`${path}.equals`, "must be string, number, or boolean");
      return;
    case "hasItem":
    case "examined":
      if (typeof raw.itemId !== "string") err(`${path}.itemId`, "must be a string");
      else if (itemIds.size && !itemIds.has(raw.itemId)) err(`${path}.itemId`, `unknown item "${raw.itemId}"`);
      return;
    case "itemAt":
      if (typeof raw.itemId !== "string") err(`${path}.itemId`, "must be a string");
      else if (itemIds.size && !itemIds.has(raw.itemId)) err(`${path}.itemId`, `unknown item "${raw.itemId}"`);
      if (typeof raw.location !== "string") err(`${path}.location`, "must be a string");
      else if (!SPECIAL_LOCATIONS.has(raw.location) && roomIds.size && !roomIds.has(raw.location)) {
        err(`${path}.location`, `unknown location "${raw.location}"`);
      }
      return;
    case "playerAt":
    case "visited":
      if (typeof raw.roomId !== "string") err(`${path}.roomId`, "must be a string");
      else if (!roomIds.has(raw.roomId)) err(`${path}.roomId`, `unknown room "${raw.roomId}"`);
      return;
    case "triggerFired":
      if (typeof raw.triggerId !== "string") err(`${path}.triggerId`, "must be a string");
      else if (triggerIds.size && !triggerIds.has(raw.triggerId)) err(`${path}.triggerId`, `unknown trigger "${raw.triggerId}"`);
      return;
    case "doorOpen":
      if (typeof raw.doorId !== "string") err(`${path}.doorId`, "must be a string");
      // Note: door id resolution happens later if needed; we don't pass doorIds
      // through every condition site yet. Validator catches obvious typos via
      // missing field, not unresolved references.
      return;
    case "containerOpen":
      if (typeof raw.itemId !== "string") err(`${path}.itemId`, "must be a string");
      else if (itemIds.size && !itemIds.has(raw.itemId)) err(`${path}.itemId`, `unknown item "${raw.itemId}"`);
      return;
    case "intentMatched":
      // Soft validation: signalId must be a string. Reference resolution is
      // skipped here (intent signals may be declared anywhere in the file
      // ordering), so unknown signalIds become "never matched" at runtime.
      if (typeof raw.signalId !== "string") err(`${path}.signalId`, "must be a string");
      return;
    case "always":
      // No fields; always true.
      return;
    case "and":
    case "or": {
      const key = t === "and" ? "all" : "any";
      const list = (raw as Record<string, unknown>)[key];
      if (!Array.isArray(list)) err(`${path}.${key}`, "must be an array of conditions");
      else list.forEach((c, i) => validateCondition(c, `${path}.${key}[${i}]`, roomIds, itemIds, triggerIds, err));
      return;
    }
    case "not":
      if (raw.condition === undefined) err(`${path}.condition`, "missing condition");
      else validateCondition(raw.condition, `${path}.condition`, roomIds, itemIds, triggerIds, err);
      return;
    default:
      err(`${path}.type`, `unknown condition type "${String(t)}"`);
  }
}

function validateEffect(
  raw: unknown,
  path: string,
  roomIds: Set<string>,
  itemIds: Set<string>,
  err: (p: string, m: string) => void,
) {
  if (!isObject(raw)) return err(path, "must be an object");
  switch (raw.type) {
    case "setFlag":
      if (typeof raw.key !== "string") err(`${path}.key`, "must be a string");
      if (!isAtom(raw.value)) err(`${path}.value`, "must be string, number, or boolean");
      return;
    case "moveItem":
      if (typeof raw.itemId !== "string") err(`${path}.itemId`, "must be a string");
      else if (itemIds.size && !itemIds.has(raw.itemId)) err(`${path}.itemId`, `unknown item "${raw.itemId}"`);
      if (typeof raw.to !== "string") err(`${path}.to`, "must be a string");
      else if (!SPECIAL_LOCATIONS.has(raw.to) && !roomIds.has(raw.to)) {
        err(`${path}.to`, `unknown destination "${raw.to}"`);
      }
      return;
    case "movePlayer":
      if (typeof raw.to !== "string") err(`${path}.to`, "must be a string");
      else if (!roomIds.has(raw.to)) err(`${path}.to`, `unknown room "${raw.to}"`);
      return;
    case "endGame":
      if (typeof raw.won !== "boolean") err(`${path}.won`, "must be boolean");
      if (typeof raw.message !== "string") err(`${path}.message`, "must be a string");
      return;
    default:
      err(`${path}.type`, `unknown effect type "${String((raw as Record<string, unknown>).type)}"`);
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isAtom(v: unknown): v is Atom {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

function requireString(
  obj: Record<string, unknown>,
  key: string,
  err: (p: string, m: string) => void,
  parentPath = "$",
) {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    err(`${parentPath}.${key}`, `required string is missing or empty`);
  }
}

function optionalString(
  obj: Record<string, unknown>,
  key: string,
  err: (p: string, m: string) => void,
  parentPath = "$",
) {
  if (key in obj && obj[key] !== undefined && typeof obj[key] !== "string") {
    err(`${parentPath}.${key}`, "must be a string if present");
  }
}

function optionalBoolean(
  obj: Record<string, unknown>,
  key: string,
  err: (p: string, m: string) => void,
  parentPath = "$",
) {
  if (key in obj && obj[key] !== undefined && typeof obj[key] !== "boolean") {
    err(`${parentPath}.${key}`, "must be a boolean if present");
  }
}

function optionalStringArray(
  obj: Record<string, unknown>,
  key: string,
  err: (p: string, m: string) => void,
  parentPath = "$",
) {
  if (!(key in obj) || obj[key] === undefined) return;
  const v = obj[key];
  if (!Array.isArray(v) || v.some((s) => typeof s !== "string")) {
    err(`${parentPath}.${key}`, "must be an array of strings");
  }
}

function expectArray(
  obj: Record<string, unknown>,
  key: string,
  err: (p: string, m: string) => void,
): unknown[] | undefined {
  const v = obj[key];
  if (!Array.isArray(v)) {
    err(`$.${key}`, "required array is missing or wrong type");
    return undefined;
  }
  return v;
}

function optionalArray(
  obj: Record<string, unknown>,
  key: string,
  err: (p: string, m: string) => void,
): unknown[] | undefined {
  if (!(key in obj) || obj[key] === undefined) return undefined;
  const v = obj[key];
  if (!Array.isArray(v)) {
    err(`$.${key}`, "must be an array if present");
    return undefined;
  }
  return v;
}

function collectIds(
  arr: unknown[],
  containerName: string,
  err: (p: string, m: string) => void,
): Set<string> {
  const ids = new Set<string>();
  arr.forEach((entry, i) => {
    if (!isObject(entry)) return;
    const id = entry.id;
    if (typeof id !== "string") return;
    if (ids.has(id)) err(`${containerName}[${i}].id`, `duplicate id "${id}"`);
    ids.add(id);
  });
  return ids;
}

export function assertValid(input: unknown, label = "story"): Story {
  const result = validateStory(input);
  if (result.ok) return result.story;
  const lines = result.errors.map((e) => `  ${e.path}: ${e.message}`).join("\n");
  throw new Error(`${label} failed validation:\n${lines}`);
}
