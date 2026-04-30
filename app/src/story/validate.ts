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

// "player" is the canonical id for items in inventory after the player-as-item
// refactor; "inventory" is kept as a legacy alias the engine normalizes at
// load-time. Both are valid as `location` / `to` / `from` values.
const SPECIAL_LOCATIONS = new Set(["inventory", "player", "nowhere"]);

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
  // Reserved item id: the player is a tracked item in state.itemLocations.
  // Triggers/effects can reference "player" as an itemId (e.g.
  // moveItem(player, room) for teleports / vehicle eject). Add it to the
  // known set so validation doesn't reject these.
  itemIds.add("player");
  items.forEach((item, i) => validateItem(item, `items[${i}]`, roomIds, itemIds, err));
  detectContainerCycles(items, err);

  // Passages share an id namespace with items so the `examine` action can
  // dispatch on a single id without ambiguity.
  const passages = optionalArray(input, "passages", err) ?? [];
  const passageIds = collectIds(passages, "passages", err);
  for (const id of passageIds) {
    if (itemIds.has(id)) {
      err(`passages`, `passage id "${id}" collides with an item id`);
    }
  }
  passages.forEach((p, i) =>
    validatePassage(p, `passages[${i}]`, roomIds, itemIds, new Set(), err),
  );

  // Validate exit passage references after passages are collected.
  if (Array.isArray(input.rooms)) {
    input.rooms.forEach((rawRoom, ri) => {
      if (!isObject(rawRoom)) return;
      const exits = rawRoom.exits;
      if (!isObject(exits)) return;
      for (const [dir, exit] of Object.entries(exits)) {
        if (!isObject(exit)) continue;
        if (exit.passage !== undefined) {
          if (typeof exit.passage !== "string") {
            err(`rooms[${ri}].exits.${dir}.passage`, "must be a string");
          } else if (!passageIds.has(exit.passage)) {
            err(`rooms[${ri}].exits.${dir}.passage`, `unknown passage "${exit.passage}"`);
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

  const customTools = optionalArray(input, "customTools", err) ?? [];
  collectIds(customTools, "customTools", err);
  customTools.forEach((t, i) =>
    validateCustomTool(t, `customTools[${i}]`, roomIds, itemIds, triggerIds, err),
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

  if ("defaultVisibility" in input && input.defaultVisibility !== undefined) {
    validateCondition(
      input.defaultVisibility,
      "defaultVisibility",
      roomIds,
      itemIds,
      triggerIds,
      err,
    );
  }

  // templates: build-time-only Record<string, Partial<Item>>. The extractor
  // resolves and strips Item.fromTemplate references; if templates survive
  // into the validated story, that's a build pipeline error.
  if ("templates" in input && input.templates !== undefined) {
    if (!isObject(input.templates)) {
      err("templates", "must be an object mapping template name to partial item");
    } else {
      err(
        "templates",
        "templates must be resolved at extractor build-time, not present in final story",
      );
    }
  }

  if ("sharedVariants" in input && input.sharedVariants !== undefined) {
    if (!Array.isArray(input.sharedVariants)) {
      err("sharedVariants", "must be an array of TextVariant objects");
    } else {
      input.sharedVariants.forEach((v, i) => {
        if (!isObject(v)) {
          err(`sharedVariants[${i}]`, "must be an object");
          return;
        }
        if (typeof v.text !== "string") err(`sharedVariants[${i}].text`, "must be a string");
        if (v.when === undefined) err(`sharedVariants[${i}].when`, "missing condition");
        else validateCondition(v.when, `sharedVariants[${i}].when`, roomIds, itemIds, triggerIds, err);
      });
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
  optionalString(raw, "narratorNote", err, path);

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
        if (exit.visibleWhen !== undefined) {
          validateCondition(exit.visibleWhen, `${ep}.visibleWhen`, roomIds, new Set(), new Set(), err);
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

  // state: per-room typed state map. Each value must be Atom.
  if ("state" in raw && raw.state !== undefined) {
    if (!isObject(raw.state)) {
      err(`${path}.state`, "must be an object mapping keys to atoms");
    } else {
      for (const [k, v] of Object.entries(raw.state)) {
        if (!isAtom(v)) {
          err(`${path}.state.${k}`, "must be string, number, or boolean");
        }
      }
    }
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

  optionalBoolean(raw, "takeable", err, path);
  optionalBoolean(raw, "fixed", err, path);

  // tags: optional array of non-empty strings — author-defined classification
  // labels. Engine doesn't interpret values; just checks shape.
  if ("tags" in raw && raw.tags !== undefined) {
    if (!Array.isArray(raw.tags)) {
      err(`${path}.tags`, "must be an array of strings");
    } else {
      raw.tags.forEach((t, i) => {
        if (typeof t !== "string" || t.length === 0) {
          err(`${path}.tags[${i}]`, "must be a non-empty string");
        }
      });
    }
  }

  // personality: optional LLM-facing voice/manner string. Engine ignores.
  optionalString(raw, "personality", err, path);
  // narratorNote: engine-side narration guidance — see schema.ts comment.
  optionalString(raw, "narratorNote", err, path);

  // fromTemplate: build-time template inheritance reference. Should be stripped
  // by the extractor before validation runs; if it appears here, the extractor
  // failed to resolve it.
  if ("fromTemplate" in raw && raw.fromTemplate !== undefined) {
    err(
      `${path}.fromTemplate`,
      "fromTemplate must be resolved at extractor build-time, not present in final story",
    );
  }

  // variants: state-conditional alternate descriptions, parallel to Room.variants.
  if ("variants" in raw && raw.variants !== undefined) {
    if (!Array.isArray(raw.variants)) {
      err(`${path}.variants`, "must be an array");
    } else {
      raw.variants.forEach((v, i) => {
        if (!isObject(v)) return err(`${path}.variants[${i}]`, "must be an object");
        if (typeof v.text !== "string") err(`${path}.variants[${i}].text`, "must be a string");
        if (v.when === undefined) err(`${path}.variants[${i}].when`, "missing condition");
        else validateCondition(v.when, `${path}.variants[${i}].when`, roomIds, itemIds, new Set(), err);
      });
    }
  }

  // appearance: optional short room-presence line.
  if ("appearance" in raw && raw.appearance !== undefined) {
    if (typeof raw.appearance !== "string") err(`${path}.appearance`, "must be a string");
  }

  // appearanceVariants: state-conditional appearance overrides, parallel to variants.
  if ("appearanceVariants" in raw && raw.appearanceVariants !== undefined) {
    if (!Array.isArray(raw.appearanceVariants)) {
      err(`${path}.appearanceVariants`, "must be an array");
    } else {
      raw.appearanceVariants.forEach((v, i) => {
        if (!isObject(v)) return err(`${path}.appearanceVariants[${i}]`, "must be an object");
        if (typeof v.text !== "string") err(`${path}.appearanceVariants[${i}].text`, "must be a string");
        if (v.when === undefined) err(`${path}.appearanceVariants[${i}].when`, "missing condition");
        else validateCondition(v.when, `${path}.appearanceVariants[${i}].when`, roomIds, itemIds, new Set(), err);
      });
    }
  }

  // visibleWhen: per-item visibility gate. Composes with Story.defaultVisibility.
  if ("visibleWhen" in raw && raw.visibleWhen !== undefined) {
    validateCondition(raw.visibleWhen, `${path}.visibleWhen`, roomIds, itemIds, new Set(), err);
  }

  // lightSource: marker capability. Reject the deprecated `isLit` field with
  // a migration hint — lit state lives in item.state.isLit now.
  if ("lightSource" in raw && raw.lightSource !== undefined) {
    if (!isObject(raw.lightSource)) {
      err(`${path}.lightSource`, "must be an object (or omit it)");
    } else if ("isLit" in raw.lightSource) {
      err(
        `${path}.lightSource.isLit`,
        "deprecated — model lit state via item.state.isLit (boolean) instead",
      );
    }
  }

  // vehicle: presence makes the item enterable. Validate shape; recurse
  // enterableWhen as a Condition.
  if ("vehicle" in raw && raw.vehicle !== undefined) {
    if (!isObject(raw.vehicle)) {
      err(`${path}.vehicle`, "must be an object (or omit it)");
    } else {
      const v = raw.vehicle;
      if ("mobile" in v && v.mobile !== undefined && typeof v.mobile !== "boolean") {
        err(`${path}.vehicle.mobile`, "must be a boolean if present");
      }
      if ("enterableWhen" in v && v.enterableWhen !== undefined) {
        validateCondition(v.enterableWhen, `${path}.vehicle.enterableWhen`, roomIds, itemIds, new Set(), err);
      }
      if ("enterBlockedMessage" in v && v.enterBlockedMessage !== undefined && typeof v.enterBlockedMessage !== "string") {
        err(`${path}.vehicle.enterBlockedMessage`, "must be a string if present");
      }
    }
  }

  // state: per-item typed state map. Each value must be Atom.
  if ("state" in raw && raw.state !== undefined) {
    if (!isObject(raw.state)) {
      err(`${path}.state`, "must be an object mapping keys to atoms");
    } else {
      for (const [k, v] of Object.entries(raw.state)) {
        if (!isAtom(v)) {
          err(`${path}.state.${k}`, "must be string, number, or boolean");
        }
      }
    }
  }

  // openWhen / closeWhen: extra Conditions AND'd into the auto-gen open/close
  // intents' active clause by the extractor. Engine ignores at runtime.
  if ("openWhen" in raw && raw.openWhen !== undefined) {
    validateCondition(raw.openWhen, `${path}.openWhen`, roomIds, itemIds, new Set(), err);
  }
  if ("closeWhen" in raw && raw.closeWhen !== undefined) {
    validateCondition(raw.closeWhen, `${path}.closeWhen`, roomIds, itemIds, new Set(), err);
  }

  // container: validate new shape; reject deprecated openable/isOpen with a
  // migration hint so stale stories surface clearly.
  if ("container" in raw && raw.container !== undefined) {
    if (!isObject(raw.container)) {
      err(`${path}.container`, "must be an object");
    } else {
      const c = raw.container;
      if ("openable" in c || "isOpen" in c) {
        err(
          `${path}.container`,
          "container.openable / container.isOpen are deprecated — model open state via item.state.isOpen and gate access with container.accessibleWhen referencing it",
        );
      }
      if ("capacity" in c && c.capacity !== undefined) {
        if (typeof c.capacity !== "number" || !Number.isFinite(c.capacity) || c.capacity < 0) {
          err(`${path}.container.capacity`, "must be a non-negative number");
        }
      }
      if ("accessibleWhen" in c && c.accessibleWhen !== undefined) {
        validateCondition(
          c.accessibleWhen,
          `${path}.container.accessibleWhen`,
          roomIds,
          itemIds,
          new Set(),
          err,
        );
      }
      if ("accessBlockedMessage" in c && c.accessBlockedMessage !== undefined) {
        if (typeof c.accessBlockedMessage !== "string") {
          err(`${path}.container.accessBlockedMessage`, "must be a string");
        }
      }
    }
  }

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
    else raw.effects.forEach((e, i) => validateEffect(e, `${path}.effects[${i}]`, roomIds, itemIds, triggerIds, err));
  }
  if (raw.narration !== undefined && typeof raw.narration !== "string") {
    err(`${path}.narration`, "must be a string");
  }
  optionalBoolean(raw, "once", err, path);
  optionalBoolean(raw, "afterAction", err, path);

  // priority: optional finite number; higher fires first within a single
  // trigger pass. Default 0 when absent.
  if ("priority" in raw && raw.priority !== undefined) {
    if (typeof raw.priority !== "number" || !Number.isFinite(raw.priority)) {
      err(`${path}.priority`, "must be a finite number if present");
    }
  }
}

const SUPPORTED_PASSAGE_KINDS = new Set(["simple"]);

function validatePassage(
  raw: unknown,
  path: string,
  roomIds: Set<string>,
  itemIds: Set<string>,
  triggerIds: Set<string>,
  err: (p: string, m: string) => void,
) {
  if (!isObject(raw)) return err(path, "must be an object");
  requireString(raw, "id", err, path);
  requireString(raw, "name", err, path);
  requireString(raw, "description", err, path);
  optionalString(raw, "narratorNote", err, path);

  // kind is optional in v1; default "simple". When present, must be supported.
  if (raw.kind !== undefined) {
    if (typeof raw.kind !== "string") {
      err(`${path}.kind`, "must be a string");
    } else if (!SUPPORTED_PASSAGE_KINDS.has(raw.kind)) {
      err(
        `${path}.kind`,
        `unsupported passage kind "${raw.kind}" (this engine speaks: ${[...SUPPORTED_PASSAGE_KINDS].join(", ")})`,
      );
    }
  }

  const sides = raw.sides;
  if (!Array.isArray(sides)) {
    err(`${path}.sides`, "must be an array of exactly two side objects");
  } else if (sides.length !== 2) {
    err(`${path}.sides`, `must contain exactly two sides (got ${sides.length})`);
  } else {
    sides.forEach((side, i) =>
      validatePassageSide(side, `${path}.sides[${i}]`, roomIds, itemIds, triggerIds, err),
    );
    if (
      isObject(sides[0]) &&
      isObject(sides[1]) &&
      sides[0].roomId === sides[1].roomId
    ) {
      err(`${path}.sides`, "the two sides must reference different rooms");
    }
  }

  // state: optional Record<string, Atom>
  if (raw.state !== undefined) {
    validatePassageStateShape(raw.state, `${path}.state`, err);
  }

  // variants: optional, same shape as Room.variants.
  if (raw.variants !== undefined) {
    if (!Array.isArray(raw.variants)) err(`${path}.variants`, "must be an array");
    else raw.variants.forEach((v, i) => {
      if (!isObject(v)) return err(`${path}.variants[${i}]`, "must be an object");
      if (typeof v.text !== "string") err(`${path}.variants[${i}].text`, "must be a string");
      if (v.when === undefined) err(`${path}.variants[${i}].when`, "missing condition");
      else validateCondition(v.when, `${path}.variants[${i}].when`, roomIds, itemIds, triggerIds, err);
    });
  }

  if (raw.glimpse !== undefined) {
    validateGlimpse(raw.glimpse, `${path}.glimpse`, roomIds, itemIds, triggerIds, err);
  }

  if (raw.traversableWhen !== undefined) {
    validateCondition(raw.traversableWhen, `${path}.traversableWhen`, roomIds, itemIds, triggerIds, err);
  }
  optionalString(raw, "traverseBlockedMessage", err, path);

  if (raw.openWhen !== undefined) {
    validateCondition(raw.openWhen, `${path}.openWhen`, roomIds, itemIds, triggerIds, err);
  }
  if (raw.closeWhen !== undefined) {
    validateCondition(raw.closeWhen, `${path}.closeWhen`, roomIds, itemIds, triggerIds, err);
  }
  if (raw.visibleWhen !== undefined) {
    validateCondition(raw.visibleWhen, `${path}.visibleWhen`, roomIds, itemIds, triggerIds, err);
  }
}

function validatePassageStateShape(
  raw: unknown,
  path: string,
  err: (p: string, m: string) => void,
) {
  if (!isObject(raw)) return err(path, "must be an object of string -> atom");
  for (const [k, v] of Object.entries(raw)) {
    if (!isAtom(v)) err(`${path}.${k}`, "must be string, number, or boolean");
  }
}

function validateGlimpse(
  raw: unknown,
  path: string,
  roomIds: Set<string>,
  itemIds: Set<string>,
  triggerIds: Set<string>,
  err: (p: string, m: string) => void,
) {
  if (!isObject(raw)) return err(path, "must be an object");
  if (raw.when !== undefined) {
    validateCondition(raw.when, `${path}.when`, roomIds, itemIds, triggerIds, err);
  }
  optionalString(raw, "description", err, path);
  optionalString(raw, "prompt", err, path);
}

function validatePassageSide(
  raw: unknown,
  path: string,
  roomIds: Set<string>,
  itemIds: Set<string>,
  triggerIds: Set<string>,
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
    validateGlimpse(raw.glimpse, `${path}.glimpse`, roomIds, itemIds, triggerIds, err);
  }

  if (raw.traversableWhen !== undefined) {
    validateCondition(raw.traversableWhen, `${path}.traversableWhen`, roomIds, itemIds, triggerIds, err);
  }
  optionalString(raw, "traverseBlockedMessage", err, path);

  if (raw.variants !== undefined) {
    if (!Array.isArray(raw.variants)) err(`${path}.variants`, "must be an array");
    else raw.variants.forEach((v, i) => {
      if (!isObject(v)) return err(`${path}.variants[${i}]`, "must be an object");
      if (typeof v.text !== "string") err(`${path}.variants[${i}].text`, "must be a string");
      if (v.when === undefined) err(`${path}.variants[${i}].when`, "missing condition");
      else validateCondition(v.when, `${path}.variants[${i}].when`, roomIds, itemIds, triggerIds, err);
    });
  }

  if (raw.visibleWhen !== undefined) {
    validateCondition(raw.visibleWhen, `${path}.visibleWhen`, roomIds, itemIds, triggerIds, err);
  }
}

function validateCustomTool(
  raw: unknown,
  path: string,
  roomIds: Set<string>,
  itemIds: Set<string>,
  triggerIds: Set<string>,
  err: (p: string, m: string) => void,
) {
  if (!isObject(raw)) return err(path, "must be an object");
  requireString(raw, "id", err, path);
  requireString(raw, "description", err, path);
  if (raw.alwaysAvailable !== undefined && typeof raw.alwaysAvailable !== "boolean") {
    err(`${path}.alwaysAvailable`, "must be a boolean");
  }

  // Validate args schema. Tracks declared arg names so handler {fromArg}
  // refs can be checked.
  const declaredArgs = new Set<string>();
  if (raw.args !== undefined) {
    if (!isObject(raw.args)) {
      err(`${path}.args`, "must be an object");
    } else {
      const a = raw.args as Record<string, unknown>;
      if (a.type !== "object") err(`${path}.args.type`, "must be the literal \"object\"");
      const props = a.properties;
      if (!isObject(props)) {
        err(`${path}.args.properties`, "must be an object of arg-name → schema");
      } else {
        for (const [argName, argSchema] of Object.entries(props)) {
          declaredArgs.add(argName);
          if (!isObject(argSchema)) {
            err(`${path}.args.properties.${argName}`, "must be an object");
            continue;
          }
          const t = (argSchema as Record<string, unknown>).type;
          if (t !== "string" && t !== "number" && t !== "boolean") {
            err(`${path}.args.properties.${argName}.type`, "must be 'string' | 'number' | 'boolean'");
          }
        }
      }
      if (a.required !== undefined) {
        if (!Array.isArray(a.required)) {
          err(`${path}.args.required`, "must be an array of arg names");
        } else {
          for (const name of a.required) {
            if (typeof name !== "string" || !declaredArgs.has(name)) {
              err(`${path}.args.required`, `unknown arg name "${String(name)}" — must appear in args.properties`);
            }
          }
        }
      }
    }
  }

  if (raw.handler !== undefined) {
    if (!isObject(raw.handler)) {
      err(`${path}.handler`, "must be an object");
      return;
    }
    const h = raw.handler as Record<string, unknown>;
    if (h.preconditions !== undefined) {
      if (!Array.isArray(h.preconditions)) {
        err(`${path}.handler.preconditions`, "must be an array");
      } else {
        h.preconditions.forEach((pre, i) => {
          if (!isObject(pre)) {
            err(`${path}.handler.preconditions[${i}]`, "must be an object");
            return;
          }
          if (pre.when === undefined) {
            err(`${path}.handler.preconditions[${i}].when`, "missing condition");
          } else {
            validateCondition(pre.when, `${path}.handler.preconditions[${i}].when`, roomIds, itemIds, triggerIds, err);
          }
          if (typeof pre.failedNarration !== "string") {
            err(`${path}.handler.preconditions[${i}].failedNarration`, "must be a string");
          }
          // fromArg refs inside the precondition's `when` should reference
          // declared args. Cheap check: stringify and look for unknown names.
          const text = JSON.stringify(pre.when);
          const refMatches = text.match(/"fromArg"\s*:\s*"([^"]+)"/g) ?? [];
          for (const m of refMatches) {
            const name = m.match(/"fromArg"\s*:\s*"([^"]+)"/)?.[1];
            if (name && !declaredArgs.has(name)) {
              err(`${path}.handler.preconditions[${i}].when`, `fromArg "${name}" is not declared in args.properties`);
            }
          }
        });
      }
    }
    if (h.effects !== undefined) {
      if (!Array.isArray(h.effects)) {
        err(`${path}.handler.effects`, "must be an array");
      } else {
        h.effects.forEach((eff, i) => {
          validateEffect(eff, `${path}.handler.effects[${i}]`, roomIds, itemIds, triggerIds, err);
          // Same fromArg ref check.
          const text = JSON.stringify(eff);
          const refMatches = text.match(/"fromArg"\s*:\s*"([^"]+)"/g) ?? [];
          for (const m of refMatches) {
            const name = m.match(/"fromArg"\s*:\s*"([^"]+)"/)?.[1];
            if (name && !declaredArgs.has(name)) {
              err(`${path}.handler.effects[${i}]`, `fromArg "${name}" is not declared in args.properties`);
            }
          }
        });
      }
    }
    if (h.successNarration !== undefined && typeof h.successNarration !== "string") {
      err(`${path}.handler.successNarration`, "must be a string");
    }
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

// IdRef = string (item id) | { fromArg: string } (substituted at handler
// dispatch). For the literal-string form, validate it's a known item id.
// For the {fromArg} form, just check shape — arg-existence is checked when
// validating the enclosing CustomTool.
function validateIdRef(
  raw: unknown,
  path: string,
  itemIds: Set<string>,
  err: (p: string, m: string) => void,
) {
  if (typeof raw === "string") {
    if (itemIds.size && !itemIds.has(raw)) err(path, `unknown item "${raw}"`);
    return;
  }
  if (isObject(raw) && typeof (raw as Record<string, unknown>).fromArg === "string") {
    return;
  }
  err(path, "must be a string item id or { fromArg: <argName> }");
}

// Sibling of validateIdRef for passage ids. Cross-ref to passages array is
// not threaded through validateCondition today — accept any string and let
// runtime "missing passage" become a no-op (parallels item validation).
function validatePassageIdRef(
  raw: unknown,
  path: string,
  err: (p: string, m: string) => void,
) {
  if (typeof raw === "string") return;
  if (isObject(raw) && typeof (raw as Record<string, unknown>).fromArg === "string") return;
  err(path, "must be a string passage id or { fromArg: <argName> }");
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
      else if (
        !SPECIAL_LOCATIONS.has(raw.location) &&
        (roomIds.size === 0 || !roomIds.has(raw.location)) &&
        (itemIds.size === 0 || !itemIds.has(raw.location))
      ) {
        err(
          `${path}.location`,
          `unknown location "${raw.location}" (must be a roomId, an itemId, "inventory", or "nowhere")`,
        );
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
    case "passageState":
      // Soft validation. passageId may be literal OR {fromArg} inside a
      // CustomTool handler. Cross-ref to passage existence is skipped —
      // passage ids aren't threaded into the validator's id sets.
      validatePassageIdRef(raw.passageId, `${path}.passageId`, err);
      if (typeof raw.key !== "string") err(`${path}.key`, "must be a string");
      if (!isAtom(raw.equals)) err(`${path}.equals`, "must be string, number, or boolean");
      return;
    case "passagePerceivable":
      validatePassageIdRef(raw.passageId, `${path}.passageId`, err);
      return;
    case "passageHasStateKey":
      validatePassageIdRef(raw.passageId, `${path}.passageId`, err);
      if (typeof raw.key !== "string" || raw.key === "") {
        err(`${path}.key`, "must be a non-empty string");
      }
      return;
    case "itemState":
      // Soft validation: itemId may be a literal string OR an IdRef
      // ({fromArg}) when used inside a CustomTool handler. Cross-ref skipped;
      // typos become "never true" at runtime.
      validateIdRef(raw.itemId, `${path}.itemId`, itemIds, err);
      if (typeof raw.key !== "string") err(`${path}.key`, "must be a string");
      if (!isAtom(raw.equals)) err(`${path}.equals`, "must be string, number, or boolean");
      return;
    case "roomState":
      if (typeof raw.roomId !== "string") err(`${path}.roomId`, "must be a string");
      else if (roomIds.size && !roomIds.has(raw.roomId)) err(`${path}.roomId`, `unknown room "${raw.roomId}"`);
      if (typeof raw.key !== "string") err(`${path}.key`, "must be a string");
      if (!isAtom(raw.equals)) err(`${path}.equals`, "must be string, number, or boolean");
      return;
    case "currentRoomState":
      if (typeof raw.key !== "string") err(`${path}.key`, "must be a string");
      if (!isAtom(raw.equals)) err(`${path}.equals`, "must be string, number, or boolean");
      return;
    case "anyPerceivableItemWith":
      if (typeof raw.key !== "string") err(`${path}.key`, "must be a string");
      if (!isAtom(raw.equals)) err(`${path}.equals`, "must be string, number, or boolean");
      return;
    case "anyAdjacentRoomItemWith":
      if (typeof raw.key !== "string") err(`${path}.key`, "must be a string");
      if (!isAtom(raw.equals)) err(`${path}.equals`, "must be string, number, or boolean");
      return;
    case "itemHasTag":
      if (typeof raw.itemId !== "string") err(`${path}.itemId`, "must be a string");
      else if (itemIds.size && !itemIds.has(raw.itemId)) err(`${path}.itemId`, `unknown item "${raw.itemId}"`);
      if (typeof raw.tag !== "string" || raw.tag.length === 0) err(`${path}.tag`, "must be a non-empty string");
      return;
    case "flagItemHasTag":
      // Soft validation: flagKey is a string; the actual itemId comes from
      // runtime flag lookup, so cross-reference isn't possible at validate time.
      if (typeof raw.flagKey !== "string") err(`${path}.flagKey`, "must be a string");
      if (typeof raw.tag !== "string" || raw.tag.length === 0) err(`${path}.tag`, "must be a non-empty string");
      return;
    case "inventoryHasTag":
      if (typeof raw.tag !== "string" || raw.tag.length === 0) err(`${path}.tag`, "must be a non-empty string");
      return;
    case "inVehicle":
      // itemId is optional (undefined = "any vehicle"); when present must be a known item id.
      if (raw.itemId !== undefined) {
        if (typeof raw.itemId !== "string") err(`${path}.itemId`, "must be a string if present");
        else if (itemIds.size && !itemIds.has(raw.itemId)) err(`${path}.itemId`, `unknown item "${raw.itemId}"`);
      }
      return;
    case "containerOpen":
      err(
        `${path}.type`,
        "containerOpen is deprecated — use { type: 'itemState', itemId, key: 'isOpen', equals: true }",
      );
      return;
    case "intentMatched":
      // Soft validation: signalId must be a string. Reference resolution is
      // skipped here (intent signals may be declared anywhere in the file
      // ordering), so unknown signalIds become "never matched" at runtime.
      if (typeof raw.signalId !== "string") err(`${path}.signalId`, "must be a string");
      return;
    case "intentArg":
      if (typeof raw.signalId !== "string") err(`${path}.signalId`, "must be a string");
      if (typeof raw.key !== "string") err(`${path}.key`, "must be a string");
      if (raw.equals === undefined) err(`${path}.equals`, "missing");
      return;
    case "itemAccessible":
      validateIdRef(raw.itemId, `${path}.itemId`, itemIds, err);
      return;
    case "itemHasStateKey":
      validateIdRef(raw.itemId, `${path}.itemId`, itemIds, err);
      if (typeof raw.key !== "string" || raw.key === "") {
        err(`${path}.key`, "must be a non-empty string");
      }
      return;
    case "compare": {
      const validOps = new Set(["==", "!=", "<", "<=", ">", ">="]);
      if (typeof raw.op !== "string" || !validOps.has(raw.op)) {
        err(`${path}.op`, `must be one of ${[...validOps].join(", ")}`);
      }
      validateNumericExpr(raw.left, `${path}.left`, err);
      validateNumericExpr(raw.right, `${path}.right`, err);
      return;
    }
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

// NumericExpr discriminator is `kind`. Each variant has its own field requirements.
function validateNumericExpr(
  raw: unknown,
  path: string,
  err: (p: string, m: string) => void,
) {
  if (!isObject(raw)) return err(path, "must be an object");
  const kind = raw.kind;
  switch (kind) {
    case "literal":
      if (typeof raw.value !== "number" || !Number.isFinite(raw.value)) {
        err(`${path}.value`, "must be a finite number");
      }
      return;
    case "flag":
      if (typeof raw.key !== "string") err(`${path}.key`, "must be a string");
      return;
    case "itemCountAt":
      if (typeof raw.location !== "string") err(`${path}.location`, "must be a string");
      return;
    case "passageState":
      if (typeof raw.passageId !== "string") err(`${path}.passageId`, "must be a string");
      if (typeof raw.key !== "string") err(`${path}.key`, "must be a string");
      return;
    case "itemState":
      if (typeof raw.itemId !== "string") err(`${path}.itemId`, "must be a string");
      if (typeof raw.key !== "string") err(`${path}.key`, "must be a string");
      return;
    case "roomState":
      if (typeof raw.roomId !== "string") err(`${path}.roomId`, "must be a string");
      if (typeof raw.key !== "string") err(`${path}.key`, "must be a string");
      return;
    case "inventoryCount":
    case "matchedIntentsCount":
    case "visitedCount":
      // No additional fields.
      return;
    default:
      err(`${path}.kind`, `unknown numeric expression kind "${String(kind)}"`);
  }
}

function validateEffect(
  raw: unknown,
  path: string,
  roomIds: Set<string>,
  itemIds: Set<string>,
  triggerIds: Set<string>,
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
      else if (
        !SPECIAL_LOCATIONS.has(raw.to) &&
        !roomIds.has(raw.to) &&
        !(itemIds.size > 0 && itemIds.has(raw.to))
      ) {
        err(
          `${path}.to`,
          `unknown destination "${raw.to}" (must be a roomId, an itemId, "inventory", or "nowhere")`,
        );
      } else if (
        typeof raw.itemId === "string" &&
        typeof raw.to === "string" &&
        raw.itemId === raw.to
      ) {
        err(`${path}.to`, "an item cannot be moved inside itself");
      }
      return;
    case "moveItemsFrom": {
      const validateLoc = (which: "from" | "to") => {
        const v = raw[which];
        if (typeof v !== "string") {
          err(`${path}.${which}`, "must be a string");
          return;
        }
        if (
          !SPECIAL_LOCATIONS.has(v) &&
          !roomIds.has(v) &&
          !(itemIds.size > 0 && itemIds.has(v))
        ) {
          err(
            `${path}.${which}`,
            `unknown location "${v}" (must be a roomId, an itemId, "inventory", or "nowhere")`,
          );
        }
      };
      validateLoc("from");
      validateLoc("to");
      if (
        typeof raw.from === "string" &&
        typeof raw.to === "string" &&
        raw.from === raw.to
      ) {
        err(`${path}.to`, "from and to are identical — no-op");
      }
      return;
    }
    case "setPassageState":
      // passageId may be literal OR {fromArg} inside a CustomTool handler.
      validatePassageIdRef(raw.passageId, `${path}.passageId`, err);
      if (typeof raw.key !== "string") err(`${path}.key`, "must be a string");
      if (!isAtom(raw.value)) err(`${path}.value`, "must be string, number, or boolean");
      return;
    case "setItemState":
      validateIdRef(raw.itemId, `${path}.itemId`, itemIds, err);
      if (typeof raw.key !== "string") err(`${path}.key`, "must be a string");
      if (!isAtom(raw.value)) err(`${path}.value`, "must be string, number, or boolean");
      return;
    case "setRoomState":
      if (typeof raw.roomId !== "string") err(`${path}.roomId`, "must be a string");
      else if (roomIds.size && !roomIds.has(raw.roomId)) err(`${path}.roomId`, `unknown room "${raw.roomId}"`);
      if (typeof raw.key !== "string") err(`${path}.key`, "must be a string");
      if (!isAtom(raw.value)) err(`${path}.value`, "must be string, number, or boolean");
      return;
    case "adjustFlag":
      if (typeof raw.key !== "string") err(`${path}.key`, "must be a string");
      if (typeof raw.by !== "number" || !Number.isFinite(raw.by)) {
        err(`${path}.by`, "must be a finite number");
      }
      return;
    case "adjustItemState":
      if (typeof raw.itemId !== "string") err(`${path}.itemId`, "must be a string");
      else if (itemIds.size && !itemIds.has(raw.itemId)) err(`${path}.itemId`, `unknown item "${raw.itemId}"`);
      if (typeof raw.key !== "string") err(`${path}.key`, "must be a string");
      if (typeof raw.by !== "number" || !Number.isFinite(raw.by)) {
        err(`${path}.by`, "must be a finite number");
      }
      return;
    case "removeMatchedIntent":
      if (typeof raw.signalId !== "string") err(`${path}.signalId`, "must be a string");
      return;
    case "setFlagRandom":
      if (typeof raw.key !== "string" || raw.key.length === 0) {
        err(`${path}.key`, "must be a non-empty string");
      }
      if (typeof raw.min !== "number" || !Number.isFinite(raw.min)) {
        err(`${path}.min`, "must be a finite number");
      }
      if (typeof raw.max !== "number" || !Number.isFinite(raw.max)) {
        err(`${path}.max`, "must be a finite number");
      }
      if (
        typeof raw.min === "number" &&
        typeof raw.max === "number" &&
        raw.min > raw.max
      ) {
        err(`${path}`, `min (${raw.min}) must be ≤ max (${raw.max})`);
      }
      return;
    case "narrate":
      if (typeof raw.text !== "string" || raw.text.length === 0) {
        err(`${path}.text`, "must be a non-empty string");
      }
      return;
    case "endGame":
      if (typeof raw.won !== "boolean") err(`${path}.won`, "must be boolean");
      if (typeof raw.message !== "string") err(`${path}.message`, "must be a string");
      return;
    case "if": {
      // Deterministic conditional: requires `if` Condition + `then` Effect[];
      // optional `else` Effect[].
      if (raw.if === undefined) {
        err(`${path}.if`, "missing condition");
      } else {
        validateCondition(raw.if, `${path}.if`, roomIds, itemIds, triggerIds, err);
      }
      if (!Array.isArray(raw.then)) {
        err(`${path}.then`, "must be an array of effects");
      } else {
        raw.then.forEach((e, i) =>
          validateEffect(e, `${path}.then[${i}]`, roomIds, itemIds, triggerIds, err),
        );
      }
      if (raw.else !== undefined) {
        if (!Array.isArray(raw.else)) {
          err(`${path}.else`, "must be an array of effects");
        } else {
          raw.else.forEach((e, i) =>
            validateEffect(e, `${path}.else[${i}]`, roomIds, itemIds, triggerIds, err),
          );
        }
      }
      return;
    }
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
