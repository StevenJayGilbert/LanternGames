// Extract Zork I from the pre-converted zil-to-json data into our story
// schema. First-cut scope: rooms + items + exits, no puzzles, no triggers,
// no descriptions for routine-described rooms.
//
// Run: `npm run extract:zork` from app/.
//
// Output: app/src/stories/zork-1.json
//
// Known limitations of this first cut (each is a Phase 4 follow-up):
//   - 22 rooms have descriptions in routines, not LDESC. We fall back to the
//     short DESC for those. Room descriptions for those will be wrong/short.
//   - NEXIT (always-blocked exits with authored refusal text) are skipped.
//     Players get a generic refusal instead of "The door is boarded…".
//   - CEXIT conditions reference flag names that nothing yet sets, so those
//     exits are unreachable until we add triggers.
//   - LOCAL-GLOBALS / GLOBAL-OBJECTS items (scenery shared across rooms) are
//     skipped entirely. Only items with a concrete room location are included.
//   - No puzzles, NPCs, score, or treasure tracking.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Atom,
  Condition,
  Door,
  Exit,
  Item,
  Room,
  Story,
} from "../src/story/schema";
import { SCHEMA_VERSION } from "../src/story/schema";
import { validateStory } from "../src/story/validate";

// ---------- paths ----------

const __dirname = dirname(fileURLToPath(import.meta.url));
const ZORK_DATA = resolve(__dirname, "../../zil-to-json/data/zork1");
const OUT_PATH = resolve(__dirname, "../src/stories/zork-1.json");

// ---------- narrator voice ----------
//
// Appended to the engine's standard system prompt for the Zork story only.
// Tunes Claude toward Infocom's original prose voice without over-prescribing.

const ZORK_NARRATOR_PROMPT = `This is Zork I, the original 1980 Infocom underground adventure. Narrate in the spirit of the canonical Infocom prose:

Voice
- Terse, dry, slightly archaic. Direct without flourish.
- Atmospheric for dark caves, ancient ruins, and moments of dread; matter-of-fact for routine actions.
- Occasionally wry, never breaking the fourth wall.

Style
- Short concrete sentences. Two or three is usually enough; a single sentence is often better.
- Second person, present tense ("You see…"). Never "I" or "we".
- Plain language. No modern slang, no emoji, no exclamation marks except for genuine peril or surprise.
- The player is "you," sometimes "the adventurer."

Echoes of the original
- Don't paraphrase canonical text — when the engine returns the canonical room or item description, prefer it as-is unless the situation demands flourish.
- Routine action confirmations should be brief and flat: "Taken." / "Dropped." / "The lamp is now on." Don't pad them.
- The world is the Great Underground Empire. Treasures, trolls, thieves, and grues live here. If the player wanders into total darkness without a light source, channel the famous warning: it is pitch black; you are likely to be eaten by a grue.

Discipline
- Never invent items, rooms, exits, or events the engine hasn't surfaced.
- If the engine rejects an action, refuse in character — don't pretend it succeeded.
- Treat trademarked references gently: this port runs on the MIT-licensed source; the "ZORK" brand isn't ours, so don't lean on the trademark in narration.`;

// ---------- raw shapes from zil-to-json ----------

interface ZilRoom {
  Name: string;
  Exits?: Record<string, ZilExit>;
  Properties?: Record<string, unknown>;
}

interface ZilExit {
  TYPE: "UEXIT" | "CEXIT" | "NEXIT" | "FEXIT" | "DOOR" | string;
  TO?: string;
  COND?: string;
  MESSAGE?: string;
}

interface ZilObject {
  Name: string;
  IsRoom: boolean;
  Properties?: Record<string, unknown>;
}

interface ZilRoutine {
  Name: string;
  ArgSpec?: string;
  Body?: ZilNode[];
}

// A ZIL routine body is a tree of "function calls" and atoms. We use these
// loose shapes only where we walk the tree (description extraction).
type ZilNode = ZilCall | ZilAtom | string | number | ZilNode[];
interface ZilCall { F: ZilNode[]; }
interface ZilAtom { A: string; }

// ---------- helpers ----------

function id(zilName: string): string {
  return zilName.toLowerCase();
}

function firstString(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const first = value[0];
    if (typeof first === "string") return first;
  }
  if (typeof value === "string") return value;
  return undefined;
}

function arrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((s): s is string => typeof s === "string");
}

function cleanWhitespace(s: string): string {
  // ZIL strings often contain \r\n at the end of every wrap line; normalize
  // them to single spaces for narration purposes.
  return s.replace(/\r?\n/g, " ").replace(/\s{2,}/g, " ").trim();
}

function arrayOfStringsLower(value: unknown): string[] {
  return arrayOfStrings(value).map((s) => s.toLowerCase());
}

// Direction-key normalization. ZIL uses NE/SW/etc.; map to common spellings.
const DIRECTION_MAP: Record<string, string> = {
  NORTH: "north",
  SOUTH: "south",
  EAST: "east",
  WEST: "west",
  NE: "northeast",
  NW: "northwest",
  SE: "southeast",
  SW: "southwest",
  UP: "up",
  DOWN: "down",
  IN: "in",
  OUT: "out",
  LAND: "land",
};

function direction(zilDir: string): string {
  return DIRECTION_MAP[zilDir.toUpperCase()] ?? zilDir.toLowerCase();
}

// ---------- room extraction ----------

function extractRooms(
  rawRooms: ZilRoom[],
  roomIds: Set<string>,
  doorIds: Set<string>,
  routinesByName: Map<string, ZilRoutine>,
): Room[] {
  const rooms: Room[] = [];
  for (const raw of rawRooms) {
    const props = raw.Properties ?? {};
    const name = firstString(props.DESC) ?? raw.Name;

    const ldescRaw = firstString(props.LDESC);
    let description: string;
    if (ldescRaw) {
      description = cleanWhitespace(ldescRaw);
    } else {
      // Routine-described room: walk its ACTION routine for the M-LOOK branch.
      const routineName = firstAtomName(props.ACTION);
      const routine = routineName ? routinesByName.get(routineName) : undefined;
      const fromRoutine = routine ? extractLookDescription(routine) : undefined;
      description = fromRoutine ? cleanWhitespace(fromRoutine) : `(${name})`;
    }

    const exits: Record<string, Exit> = {};
    for (const [zilDir, exit] of Object.entries(raw.Exits ?? {})) {
      const dir = direction(zilDir);
      const built = buildExit(exit, roomIds, doorIds);
      if (built) exits[dir] = built;
    }

    const room: Room = {
      id: id(raw.Name),
      name,
      description,
      ...(Object.keys(exits).length > 0 && { exits }),
    };
    rooms.push(room);
  }
  return rooms;
}

// ACTION property is shaped like [{A: "WEST-HOUSE"}] — pull the routine name.
function firstAtomName(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const first = value[0];
  if (first && typeof first === "object" && "A" in first && typeof (first as ZilAtom).A === "string") {
    return (first as ZilAtom).A;
  }
  return undefined;
}

// ---------- routine walker (room descriptions) ----------
//
// Zork rooms with custom routines describe themselves like:
//   (COND ((EQUAL? .RARG ,M-LOOK)  <- "the player just looked"
//          (TELL "You are in a small kitchen…")
//          (COND (,WINDOW-OPEN (TELL " The window is open."))
//                (T            (TELL " The window is slightly ajar.")))
//          (CRLF)))
// We grab all top-level TELL strings inside the M-LOOK branch and concatenate
// them. State-conditional sub-CONDs are ignored for now (the engine + LLM can
// improvise variant text from the canonical description).

function extractLookDescription(routine: ZilRoutine): string | undefined {
  for (const stmt of routine.Body ?? []) {
    const found = walkForLookBranch(stmt);
    if (found) return found;
  }
  return undefined;
}

function walkForLookBranch(node: ZilNode): string | undefined {
  if (!isCall(node, "COND")) return undefined;
  const branches = node.F.slice(1);
  for (const branch of branches) {
    if (!Array.isArray(branch) || branch.length < 1) continue;
    const predicate = branch[0];
    if (!mentionsAtom(predicate, "M-LOOK")) continue;
    const tells: string[] = [];
    for (let j = 1; j < branch.length; j++) {
      const text = topLevelTellString(branch[j]);
      if (text) tells.push(text);
    }
    if (tells.length > 0) return tells.join("");
  }
  return undefined;
}

function isCall(node: ZilNode | undefined, fname: string): node is ZilCall {
  if (!node || typeof node !== "object" || !("F" in node)) return false;
  const first = (node as ZilCall).F[0];
  return !!first && typeof first === "object" && "A" in first && (first as ZilAtom).A === fname;
}

function mentionsAtom(node: ZilNode, atomName: string): boolean {
  // Cheap traversal — looks for `{A: atomName}` anywhere in the subtree.
  if (!node) return false;
  if (typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some((n) => mentionsAtom(n, atomName));
  if ("A" in node) return (node as ZilAtom).A === atomName;
  if ("F" in node) return (node as ZilCall).F.some((n) => mentionsAtom(n, atomName));
  return false;
}

function topLevelTellString(node: ZilNode): string | undefined {
  if (!isCall(node, "TELL")) return undefined;
  for (let i = 1; i < node.F.length; i++) {
    const arg = node.F[i];
    if (typeof arg === "string") return arg;
  }
  return undefined;
}

function buildExit(
  zilExit: ZilExit,
  roomIds: Set<string>,
  doorIds: Set<string>,
): Exit | null {
  switch (zilExit.TYPE) {
    case "UEXIT": {
      if (!zilExit.TO) return null;
      const target = id(zilExit.TO);
      if (!roomIds.has(target)) return null;
      return { to: target };
    }
    case "CEXIT": {
      if (!zilExit.TO || !zilExit.COND) return null;
      const target = id(zilExit.TO);
      if (!roomIds.has(target)) return null;
      const exit: Exit = {
        to: target,
        when: { type: "flag", key: id(zilExit.COND), equals: true } as Condition,
      };
      return exit;
    }
    case "DEXIT": {
      // Door exit: traversal requires the named door to be open.
      if (!zilExit.TO) return null;
      const target = id(zilExit.TO);
      if (!roomIds.has(target)) return null;
      const doorName = (zilExit as ZilExit).DOOR;
      if (typeof doorName === "string" && doorIds.has(id(doorName))) {
        return { to: target, door: id(doorName) };
      }
      // Door wasn't promoted to a Door entity (didn't resolve to 2 rooms).
      // Degrade to an unconditional exit so the player isn't stuck.
      return { to: target };
    }
    case "NEXIT":
      // Skip always-blocked exits for first cut. Schema can't yet express
      // "exit with no target, just a blocked message."
      return null;
    case "FEXIT":
    case "DOOR":
      // FEXIT runs a function to decide; legacy "DOOR" exit type unused in
      // this dataset. Both need engine work to support. Skip for now.
      return null;
    default:
      return null;
  }
}

// ---------- door extraction ----------
//
// In ZIL, a door is an object with the DOORBIT flag. The same physical door
// may be referenced from two rooms (kitchen-window connects east-of-house and
// kitchen). We derive the two connecting rooms by combining three signals:
//   1. DEXIT exits — `{TO: "X", DOOR: "DOOR-NAME", TYPE: "DEXIT"}` — both the
//      from-room and to-room are connected by the named door.
//   2. LOCAL-GLOBALS membership — for shared-scenery doors, room.GLOBAL lists
//      which doors each room sees.
//   3. The door's #IN room — for room-local doors (e.g. trap-door inside
//      Living Room) that link to a target via DEXIT from the other side.
//
// If the union of these signals yields exactly two distinct rooms, we emit
// the object as a Door. Otherwise we leave it for the item extractor (which
// will treat DOORBIT as openable container — the interim path).

interface DoorExtractionResult {
  doors: Door[];
  doorIds: Set<string>;            // lowercase door ids that became Doors
  skippedDoorObjects: Set<string>; // ZIL names of objects emitted as doors
                                   // (item extractor must skip these)
  doorRoomsByZilName: Map<string, string[]>; // for diagnostics
}

function extractDoors(
  rawObjects: ZilObject[],
  rawRooms: ZilRoom[],
  routinesByName: Map<string, ZilRoutine>,
  roomIds: Set<string>,
  sharedSceneryRooms: Map<string, string[]>,
): DoorExtractionResult {
  // Index DEXITs by door name -> set of rooms.
  const dexitRoomsByDoorName = new Map<string, Set<string>>();
  for (const room of rawRooms) {
    const fromRoom = id(room.Name);
    for (const exit of Object.values(room.Exits ?? {})) {
      if (exit.TYPE !== "DEXIT" || typeof (exit as ZilExit).DOOR !== "string") continue;
      const doorName = (exit as ZilExit).DOOR as string;
      const set = dexitRoomsByDoorName.get(doorName) ?? new Set();
      set.add(fromRoom);
      if (typeof exit.TO === "string") {
        const toLower = exit.TO.toLowerCase();
        if (roomIds.has(toLower)) set.add(toLower);
      }
      dexitRoomsByDoorName.set(doorName, set);
    }
  }

  const doors: Door[] = [];
  const doorIds = new Set<string>();
  const skippedDoorObjects = new Set<string>();
  const doorRoomsByZilName = new Map<string, string[]>();

  for (const raw of rawObjects) {
    if (raw.IsRoom) continue;
    const props = raw.Properties ?? {};
    const flags = arrayOfStrings(props.FLAGS).map((f) => f.toUpperCase());
    if (!flags.includes("DOORBIT")) continue;

    // Union all known room references for this door.
    const rooms = new Set<string>();
    const dexitRooms = dexitRoomsByDoorName.get(raw.Name);
    if (dexitRooms) for (const r of dexitRooms) rooms.add(r);
    const sharedRooms = sharedSceneryRooms.get(raw.Name);
    if (sharedRooms) for (const r of sharedRooms) rooms.add(r);
    const inLocation = typeof props["#IN"] === "string" ? (props["#IN"] as string) : "";
    if (inLocation && roomIds.has(inLocation.toLowerCase())) rooms.add(inLocation.toLowerCase());

    doorRoomsByZilName.set(raw.Name, [...rooms]);

    // Need exactly two rooms to make a Door. Otherwise fall through to items.
    if (rooms.size !== 2) continue;

    const [a, b] = [...rooms];
    const itemId = id(raw.Name);
    const name = firstString(props.DESC) ?? raw.Name.toLowerCase();
    const description = resolveDoorDescription(props, name, routinesByName);

    const door: Door = {
      kind: "simple",
      id: itemId,
      name,
      description,
      sides: [{ roomId: a }, { roomId: b }],
      ...(flags.includes("OPENBIT") && { isOpen: true }),
    };
    doors.push(door);
    doorIds.add(itemId);
    skippedDoorObjects.add(raw.Name);
  }

  return { doors, doorIds, skippedDoorObjects, doorRoomsByZilName };
}

function resolveDoorDescription(
  props: Record<string, unknown>,
  fallbackName: string,
  routinesByName: Map<string, ZilRoutine>,
): string {
  const fdesc = firstString(props.FDESC);
  const ldesc = firstString(props.LDESC);
  if (fdesc) return cleanWhitespace(fdesc);
  if (ldesc) return cleanWhitespace(ldesc);
  // Walk the door's ACTION routine. Try room-style M-LOOK first, then item-
  // style VERB? EXAMINE. Item routines structure description text under
  // (COND ((VERB? EXAMINE) (TELL "...")) ...) branches.
  const routineName = firstAtomName(props.ACTION);
  const routine = routineName ? routinesByName.get(routineName) : undefined;
  if (routine) {
    const fromLook = extractLookDescription(routine);
    if (fromLook) return cleanWhitespace(fromLook);
    const fromExamine = extractExamineDescription(routine);
    if (fromExamine) return cleanWhitespace(fromExamine);
  }
  return `(${fallbackName})`;
}

// Walk an item routine for the (VERB? EXAMINE) branch and concatenate its
// top-level TELL strings. Mirrors `extractLookDescription` but matches a
// different predicate.
function extractExamineDescription(routine: ZilRoutine): string | undefined {
  for (const stmt of routine.Body ?? []) {
    const found = walkForExamineBranch(stmt);
    if (found) return found;
  }
  return undefined;
}

function walkForExamineBranch(node: ZilNode): string | undefined {
  if (!isCall(node, "COND")) return undefined;
  const branches = node.F.slice(1);
  for (const branch of branches) {
    if (!Array.isArray(branch) || branch.length < 1) continue;
    const predicate = branch[0];
    // (VERB? EXAMINE) — predicate mentions both VERB? and EXAMINE atoms.
    if (!mentionsAtom(predicate, "VERB?") || !mentionsAtom(predicate, "EXAMINE")) {
      continue;
    }
    const tells: string[] = [];
    for (let j = 1; j < branch.length; j++) {
      const text = topLevelTellString(branch[j]);
      if (text) tells.push(text);
    }
    if (tells.length > 0) return tells.join("");
  }
  return undefined;
}

// ---------- item extraction ----------

const SKIP_LOCATIONS = new Set(["ROOMS", "GLOBAL-OBJECTS"]);
const LOCAL_GLOBALS = "LOCAL-GLOBALS";

// Build a map of LOCAL-GLOBAL ZIL name → rooms that reference it via their
// GLOBAL property. Shared scenery (rivers, doors, walls visible from many
// rooms) lives in LOCAL-GLOBALS; this map tells us which rooms each one is
// perceptible from.
function buildSharedSceneryMap(rawRooms: ZilRoom[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const room of rawRooms) {
    const globals = room.Properties?.GLOBAL;
    if (!Array.isArray(globals)) continue;
    const roomId = id(room.Name);
    for (const entry of globals) {
      const name = entry && typeof entry === "object" && "A" in (entry as ZilAtom)
        ? (entry as ZilAtom).A
        : null;
      if (!name) continue;
      const existing = map.get(name) ?? [];
      existing.push(roomId);
      map.set(name, existing);
    }
  }
  return map;
}

function extractItems(
  rawObjects: ZilObject[],
  roomIds: Set<string>,
  skippedDoorObjects: Set<string>,
  sharedSceneryRooms: Map<string, string[]>,
): Item[] {
  // ---- Step 1: iteratively determine which non-room objects to include.
  // Containers can hold items, so we do a fixpoint: an object is in if its #IN
  // is a room, an already-included object, or it's a referenced LOCAL-GLOBAL.
  const candidates = rawObjects.filter((o) => {
    if (o.IsRoom) return false;
    if (skippedDoorObjects.has(o.Name)) return false; // emitted as a Door instead
    const inLoc = typeof o.Properties?.["#IN"] === "string" ? (o.Properties!["#IN"] as string) : "";
    if (!inLoc) return false;
    if (SKIP_LOCATIONS.has(inLoc)) return false;
    if (inLoc === LOCAL_GLOBALS) {
      // Only include local-globals that are actually referenced by some room.
      return sharedSceneryRooms.has(o.Name);
    }
    return true;
  });

  const accepted = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const raw of candidates) {
      const itemId = id(raw.Name);
      if (accepted.has(itemId)) continue;
      const inLoc = (raw.Properties!["#IN"] as string);
      if (inLoc === LOCAL_GLOBALS) {
        accepted.add(itemId);
        changed = true;
        continue;
      }
      const inLocLower = inLoc.toLowerCase();
      if (roomIds.has(inLocLower) || accepted.has(inLocLower)) {
        accepted.add(itemId);
        changed = true;
      }
    }
  }

  const items: Item[] = [];
  const seenIds = new Set<string>();

  for (const raw of rawObjects) {
    if (raw.IsRoom) continue;
    if (skippedDoorObjects.has(raw.Name)) continue; // emitted as a Door
    const props = raw.Properties ?? {};
    const inLocation = typeof props["#IN"] === "string" ? (props["#IN"] as string) : "";
    if (!inLocation || SKIP_LOCATIONS.has(inLocation)) continue;

    let primaryLocation: string;
    let appearsIn: string[] | undefined;

    if (inLocation === LOCAL_GLOBALS) {
      // Shared scenery: assemble appearsIn from the rooms that referenced it.
      const rooms = sharedSceneryRooms.get(raw.Name) ?? [];
      if (rooms.length === 0) continue;
      primaryLocation = rooms[0];
      if (rooms.length > 1) appearsIn = rooms.slice(1);
    } else {
      const inLocLower = inLocation.toLowerCase();
      if (!roomIds.has(inLocLower) && !accepted.has(inLocLower)) continue;
      primaryLocation = inLocLower;
    }

    const itemId = id(raw.Name);
    if (seenIds.has(itemId)) continue;
    seenIds.add(itemId);

    const name = firstString(props.DESC) ?? raw.Name.toLowerCase();
    const fdesc = firstString(props.FDESC);
    const ldesc = firstString(props.LDESC);
    const description = fdesc
      ? cleanWhitespace(fdesc)
      : ldesc
      ? cleanWhitespace(ldesc)
      : `(${name})`;

    const flags = arrayOfStrings(props.FLAGS).map((f) => f.toUpperCase());
    const synonyms = uniqueLower(arrayOfStrings(props.SYNONYM), name);
    const adjectives = arrayOfStringsLower(props.ADJECTIVE);

    const item: Item = {
      id: itemId,
      name,
      description,
      location: primaryLocation,
      ...(appearsIn && { appearsIn }),
      ...(synonyms.length > 0 && { synonyms }),
      ...(adjectives.length > 0 && { adjectives }),
      ...(flags.includes("TAKEBIT") && { takeable: true }),
      ...(!flags.includes("TAKEBIT") && flags.includes("NDESCBIT") && { fixed: true }),
    };

    // Openable items — Zork convention:
    //   CONTBIT  = container (holds things, openable, has capacity)
    //   DOORBIT  = door / window / hatch (openable, but doesn't hold things)
    //   OPENBIT  = currently in the open state
    // We model both as `container: { openable: true }`. Doors get no capacity;
    // containers do. (Naming stretch noted in TASKS.md — long-term we may
    // separate `openable` from `container`.)
    const isOpenable = flags.includes("CONTBIT") || flags.includes("DOORBIT");
    if (isOpenable) {
      const capacity = flags.includes("CONTBIT") ? firstNumber(props.CAPACITY) : undefined;
      item.container = {
        openable: true,
        ...(flags.includes("OPENBIT") && { isOpen: true }),
        ...(capacity !== undefined && { capacity }),
      };
    }

    // Light sources
    if (flags.includes("LIGHTBIT") || flags.includes("FLAMEBIT")) {
      item.lightSource = {
        ...(flags.includes("ONBIT") && { isLit: true }),
      };
    }

    // Readable content
    const readableText = firstString(props.TEXT) ?? firstString(props.READBIT);
    if (readableText && flags.includes("READBIT")) {
      item.readable = { text: cleanWhitespace(readableText) };
    } else if (firstString(props.TEXT)) {
      item.readable = { text: cleanWhitespace(firstString(props.TEXT)!) };
    }

    items.push(item);
  }
  return items;
}

function firstNumber(value: unknown): number | undefined {
  if (Array.isArray(value)) {
    const first = value[0];
    if (typeof first === "number") return first;
  }
  if (typeof value === "number") return value;
  return undefined;
}

function uniqueLower(arr: string[], excludeName: string): string[] {
  const exclude = excludeName.toLowerCase();
  const out = new Set<string>();
  for (const s of arr) {
    const lower = s.toLowerCase();
    if (lower !== exclude) out.add(lower);
  }
  return [...out];
}

// ---------- post-extraction enrichments ----------
//
// The mechanical extraction pulls structure (rooms/exits/items/doors) from
// the ZIL data, but some objects need hand-tuned content the source doesn't
// expose cleanly — per-side glimpses, state-conditional descriptions,
// see-through gating. We patch those in here.
//
// Each entry overrides or extends the extracted Door by id. Keep entries
// surgical; this isn't a place to rewrite Zork's prose, only to fill in
// what mechanical extraction can't.

type DoorEnrichment = (door: Door) => Door;

const DOOR_ENRICHMENTS: Record<string, DoorEnrichment> = {
  "kitchen-window": (door) => ({
    ...door,
    description: "A small kitchen window. It appears to be slightly ajar.",
    variants: [
      {
        when: { type: "doorOpen", doorId: "kitchen-window" },
        text: "The kitchen window is open wide enough to climb through.",
      },
    ],
    sides: [
      {
        ...door.sides[0],
        glimpse: {
          // when omitted -> defaults to "door is open"
          prompt:
            "Through the window, describe the kitchen briefly — emphasize warmth and signs of recent cooking. Keep it to a sentence.",
        },
      },
      {
        ...door.sides[1],
        glimpse: {
          prompt:
            "Through the window, describe the area behind the house briefly — open ground sloping toward forest. Keep it to a sentence.",
        },
      },
    ],
  }),
};

function applyDoorEnrichments(doors: Door[]): Door[] {
  return doors.map((d) => {
    const fn = DOOR_ENRICHMENTS[d.id];
    return fn ? fn(d) : d;
  });
}

// ---------- main ----------

function main() {
  const rawRooms: ZilRoom[] = JSON.parse(
    readFileSync(resolve(ZORK_DATA, "zork1.rooms.json"), "utf8"),
  );
  const rawObjects: ZilObject[] = JSON.parse(
    readFileSync(resolve(ZORK_DATA, "zork1.objects.json"), "utf8"),
  );
  const rawRoutines: ZilRoutine[] = JSON.parse(
    readFileSync(resolve(ZORK_DATA, "zork1.routines.json"), "utf8"),
  );
  const routinesByName = new Map(
    rawRoutines.filter((r) => typeof r.Name === "string").map((r) => [r.Name, r]),
  );

  const roomIds = new Set(rawRooms.map((r) => id(r.Name)));
  const sharedSceneryRooms = buildSharedSceneryMap(rawRooms);

  // Doors first — produces the set of object names that the item extractor
  // must skip (so DOORBIT items aren't double-extracted).
  const doorResult = extractDoors(
    rawObjects,
    rawRooms,
    routinesByName,
    roomIds,
    sharedSceneryRooms,
  );

  const rooms = extractRooms(rawRooms, roomIds, doorResult.doorIds, routinesByName);
  const items = extractItems(rawObjects, roomIds, doorResult.skippedDoorObjects, sharedSceneryRooms);
  const doors = applyDoorEnrichments(doorResult.doors);

  const story: Story = {
    schemaVersion: SCHEMA_VERSION,
    id: "zork-1",
    title: "Zork I: The Great Underground Empire",
    author: "Marc Blanc, Dave Lebling, et al. (Infocom, 1980)",
    description:
      "The original underground adventure. Source code released under MIT by Microsoft (Nov 2025). This is an LLM-narrated port — the engine is ours, the world is Infocom's.",
    intro:
      "ZORK I: The Great Underground Empire\nInfocom interactive fiction — a fantasy story.\nCopyright (c) 1981 Infocom, Inc. Source code released under MIT license, Microsoft 2025.",
    systemPromptOverride: ZORK_NARRATOR_PROMPT,
    startRoom: "west-of-house",
    rooms,
    items,
    ...(doors.length > 0 && { doors }),
  };

  // Validate before writing.
  const result = validateStory(story);
  if (!result.ok) {
    console.error(`✗ extracted story failed validation (${result.errors.length} errors):`);
    for (const e of result.errors.slice(0, 20)) {
      console.error(`  ${e.path}: ${e.message}`);
    }
    if (result.errors.length > 20) {
      console.error(`  ...and ${result.errors.length - 20} more`);
    }
    process.exit(1);
  }

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(story, null, 2) + "\n", "utf8");

  // Report.
  const exitCount = rooms.reduce((n, r) => n + Object.keys(r.exits ?? {}).length, 0);
  const doorGatedExits = rooms.reduce(
    (n, r) => n + Object.values(r.exits ?? {}).filter((e) => e.door).length,
    0,
  );
  const ldescRooms = rooms.filter((r) => !r.description.startsWith("(")).length;
  console.log(`✓ wrote ${OUT_PATH}`);
  console.log(`  rooms: ${rooms.length} (${ldescRooms} with real descriptions, ${rooms.length - ldescRooms} placeholders)`);
  console.log(`  items: ${items.length}`);
  console.log(`  doors: ${doorResult.doors.length}`);
  console.log(`  exits: ${exitCount} (${doorGatedExits} gated by doors)`);
  console.log(`  takeable items: ${items.filter((i) => i.takeable).length}`);
  console.log(`  containers:     ${items.filter((i) => i.container).length}`);
  console.log(`  light sources:  ${items.filter((i) => i.lightSource).length}`);
}

main();
