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

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Atom,
  Condition,
  CustomTool,
  EndCondition,
  Exit,
  IntentSignal,
  Item,
  Passage,
  PassageSide,
  Room,
  SimplePassage,
  Story,
  TextVariant,
  Trigger,
} from "../src/story/schema";
import { SCHEMA_VERSION } from "../src/story/schema";
import { validateStory } from "../src/story/validate";

// ---------- paths ----------

const __dirname = dirname(fileURLToPath(import.meta.url));
const ZORK_DATA = resolve(__dirname, "../../zil-to-json/data/zork1");
const OUT_PATH = resolve(__dirname, "../src/stories/zork-1.json");
const OVERRIDES_PATH = resolve(__dirname, "../src/stories/zork-1.overrides.json");

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
  passageIds: Set<string>,
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
      const built = buildExit(exit, roomIds, passageIds);
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

// Item examines use TELLs that interleave strings with dynamic atoms like
// D ,PRSO ("describe parsed object") — extracting only the first string drops
// content. Concatenate every string arg; if the result contains an obvious
// fragment from a stripped interpolation (e.g. "like a ." or "the  here"),
// drop the whole TELL — the LLM will narrate around the placeholder
// description anyway.
function concatTellStrings(node: ZilNode): string | undefined {
  if (!isCall(node, "TELL")) return undefined;
  const parts: string[] = [];
  let hasInterpolation = false;
  for (let i = 1; i < node.F.length; i++) {
    const arg = node.F[i];
    if (typeof arg === "string") {
      parts.push(arg);
    } else if (arg && typeof arg === "object") {
      // Atom or call between strings — flag as interpolated; we'll filter
      // out the result if it looks like a sentence fragment.
      hasInterpolation = true;
    }
  }
  if (parts.length === 0) return undefined;
  const joined = parts.join("");
  if (hasInterpolation && looksLikeInterpolationFragment(joined)) return undefined;
  return joined;
}

// Heuristic: a string with adjacent " ." " ," " ;" or "  " (multi-space) was
// almost certainly built around a runtime object reference we can't fill.
function looksLikeInterpolationFragment(s: string): boolean {
  return / [.,;]/.test(s) || /  /.test(s);
}

function buildExit(
  zilExit: ZilExit,
  roomIds: Set<string>,
  passageIds: Set<string>,
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
      // Door (passage) exit: traversal gating is handled by the passage's
      // traversableWhen. Engine evaluates it when the player tries this exit.
      if (!zilExit.TO) return null;
      const target = id(zilExit.TO);
      if (!roomIds.has(target)) return null;
      const passageName = (zilExit as ZilExit).DOOR;
      if (typeof passageName === "string" && passageIds.has(id(passageName))) {
        return { to: target, passage: id(passageName) };
      }
      // Passage wasn't promoted (didn't resolve to 2 rooms). Degrade to an
      // unconditional exit so the player isn't stuck.
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

// ---------- passage extraction ----------
//
// In ZIL, a door is an object with the DOORBIT flag. The same physical
// door/window/passage may be referenced from two rooms (kitchen-window
// connects east-of-house and kitchen). We derive the two connecting rooms
// by combining three signals:
//   1. DEXIT exits — `{TO: "X", DOOR: "DOOR-NAME", TYPE: "DEXIT"}` — both the
//      from-room and to-room are connected by the named door.
//   2. LOCAL-GLOBALS membership — for shared-scenery doors, room.GLOBAL lists
//      which doors each room sees.
//   3. The door's #IN room — for room-local doors (e.g. trap-door inside
//      Living Room) that link to a target via DEXIT from the other side.
//
// If the union of these signals yields exactly two distinct rooms, we emit
// the object as a Passage. Otherwise we leave it for the item extractor
// (which will treat DOORBIT as openable container — the interim path).

interface PassageExtractionResult {
  passages: Passage[];
  passageIds: Set<string>;            // lowercase passage ids that became Passages
  skippedPassageObjects: Set<string>; // ZIL names of objects emitted as passages
                                      // (item extractor must skip these)
  passageRoomsByZilName: Map<string, string[]>; // for diagnostics
}

function extractPassages(
  rawObjects: ZilObject[],
  rawRooms: ZilRoom[],
  routinesByName: Map<string, ZilRoutine>,
  roomIds: Set<string>,
  sharedSceneryRooms: Map<string, string[]>,
): PassageExtractionResult {
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

  const passages: Passage[] = [];
  const passageIds = new Set<string>();
  const skippedPassageObjects = new Set<string>();
  const passageRoomsByZilName = new Map<string, string[]>();

  for (const raw of rawObjects) {
    if (raw.IsRoom) continue;
    const props = raw.Properties ?? {};
    const flags = arrayOfStrings(props.FLAGS).map((f) => f.toUpperCase());
    if (!flags.includes("DOORBIT")) continue;

    // Union all known room references for this passage.
    const rooms = new Set<string>();
    const dexitRooms = dexitRoomsByDoorName.get(raw.Name);
    if (dexitRooms) for (const r of dexitRooms) rooms.add(r);
    const sharedRooms = sharedSceneryRooms.get(raw.Name);
    if (sharedRooms) for (const r of sharedRooms) rooms.add(r);
    const inLocation = typeof props["#IN"] === "string" ? (props["#IN"] as string) : "";
    if (inLocation && roomIds.has(inLocation.toLowerCase())) rooms.add(inLocation.toLowerCase());

    passageRoomsByZilName.set(raw.Name, [...rooms]);

    // Need exactly two rooms to make a Passage. Otherwise fall through to items.
    if (rooms.size !== 2) continue;

    const [a, b] = [...rooms];
    const passageId = id(raw.Name);
    const name = firstString(props.DESC) ?? raw.Name.toLowerCase();
    const description = resolvePassageDescription(props, name, routinesByName);

    // Emit a passage with state.isOpen seeded from OPENBIT. The post-extract
    // enrichment pass (PASSAGE_ENRICHMENTS) wires up traversableWhen +
    // open/close intents/triggers as appropriate per passage.
    const passage: Passage = {
      kind: "simple",
      id: passageId,
      name,
      description,
      state: { isOpen: flags.includes("OPENBIT") },
      sides: [{ roomId: a }, { roomId: b }],
    };
    passages.push(passage);
    passageIds.add(passageId);
    skippedPassageObjects.add(raw.Name);
  }

  return { passages, passageIds, skippedPassageObjects, passageRoomsByZilName };
}

function resolvePassageDescription(
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

// Walk every (VERB? EXAMINE) branch in an item routine. Returns:
//   - description: text from the unconditional EXAMINE branch (predicate is
//     just a verb check, no state guards), if one exists
//   - variants: state-conditional EXAMINE branches whose guards we could
//     translate into the project's Condition schema
// Branches whose guards we can't translate are dropped — better to omit a
// variant than emit one with a wrong condition.
function extractItemExamines(
  routine: ZilRoutine,
  knownItemIds: Set<string>,
): { description?: string; variants: TextVariant[] } {
  const variants: TextVariant[] = [];
  let description: string | undefined;

  for (const stmt of routine.Body ?? []) {
    if (!isCall(stmt, "COND")) continue;
    const branches = stmt.F.slice(1);
    for (const branch of branches) {
      if (!Array.isArray(branch) || branch.length < 1) continue;
      const predicate = branch[0];
      if (!mentionsAtom(predicate, "VERB?") || !mentionsAtom(predicate, "EXAMINE")) continue;

      // Outer-branch state guards alongside the verb check.
      const outerGuards = extractNonVerbGuards(predicate);
      const outerConds: Condition[] = [];
      let outerTranslatable = true;
      for (const g of outerGuards) {
        const c = translateGuardToCondition(g, knownItemIds);
        if (!c) { outerTranslatable = false; break; }
        outerConds.push(c);
      }
      // If outer guards exist but don't translate, skip the whole branch —
      // emitting unconditional text for a conditional ZIL branch would lie.
      if (outerGuards.length > 0 && !outerTranslatable) continue;

      // Walk the branch body. Top-level TELLs build a "preface" that's
      // common to every sub-COND path. Sub-CONDs branch the description
      // by state (e.g. mirror's broken vs. intact text).
      const preface: string[] = [];
      const subCondTells: { guards: ZilNode[]; text: string; isElse: boolean }[] = [];

      for (let j = 1; j < branch.length; j++) {
        const node = branch[j];
        const tellText = concatTellStrings(node);
        if (tellText) { preface.push(tellText); continue; }
        if (isCall(node, "COND")) {
          for (let k = 1; k < node.F.length; k++) {
            const sub = node.F[k];
            if (!Array.isArray(sub) || sub.length < 1) continue;
            const subPred = sub[0];
            const subTells: string[] = [];
            for (let m = 1; m < sub.length; m++) {
              const t = concatTellStrings(sub[m]);
              if (t) subTells.push(t);
            }
            if (subTells.length === 0) continue;
            // (T) or (ELSE) is the else-branch — unconditional path.
            const isElse = isCall(subPred, "T") ||
              (subPred && typeof subPred === "object" && "A" in subPred &&
                ((subPred as ZilAtom).A === "T" || (subPred as ZilAtom).A === "ELSE"));
            subCondTells.push({
              guards: isElse ? [] : [subPred],
              text: subTells.join(""),
              isElse,
            });
          }
        }
      }

      const prefaceText = cleanWhitespace(preface.join(""));

      // Case A: no sub-COND, just top-level TELLs in the branch body.
      if (subCondTells.length === 0) {
        if (preface.length === 0) continue;
        emitBranch(prefaceText, outerConds);
        continue;
      }

      // Case B: sub-COND with branches. Each sub-branch combines preface +
      // its own text, gated by AND(outerConds, subGuards).
      for (const sb of subCondTells) {
        const combined = cleanWhitespace(prefaceText + (prefaceText && sb.text ? " " : "") + sb.text);
        if (sb.isElse) {
          emitBranch(combined, outerConds);
          continue;
        }
        const subConds: Condition[] = [];
        let subOk = true;
        for (const g of sb.guards) {
          const c = translateGuardToCondition(g, knownItemIds);
          if (!c) { subOk = false; break; }
          subConds.push(c);
        }
        if (!subOk) continue;
        emitBranch(combined, [...outerConds, ...subConds]);
      }
    }
  }

  function emitBranch(text: string, conds: Condition[]) {
    if (!text) return;
    if (conds.length === 0) {
      if (description === undefined) description = text;
      return;
    }
    const when: Condition = conds.length === 1 ? conds[0] : { type: "and", all: conds };
    variants.push({ when, text });
  }

  return { description, variants };
}

// Pull the state-guard sub-expressions out of an EXAMINE branch's predicate.
// Examples:
//   (VERB? EXAMINE)                              -> []                    (no guards)
//   (VERB? EXAMINE LOOK-INSIDE)                  -> []                    (verb-only)
//   (AND (VERB? EXAMINE) (GVAL FOO))             -> [(GVAL FOO)]
//   (AND (VERB? EXAMINE) (NOT (GVAL FOO)))       -> [(NOT (GVAL FOO))]
//   (AND (NOT (GVAL FLAG)) (VERB? EXAMINE))      -> [(NOT (GVAL FLAG))]
function extractNonVerbGuards(predicate: ZilNode): ZilNode[] {
  if (isCall(predicate, "VERB?")) return [];
  if (isCall(predicate, "AND")) {
    const guards: ZilNode[] = [];
    for (let i = 1; i < predicate.F.length; i++) {
      const sub = predicate.F[i];
      if (isCall(sub, "VERB?")) continue;
      guards.push(sub);
    }
    return guards;
  }
  // Unknown predicate shape — give up; caller will skip the variant.
  return [predicate];
}

// Translate a ZIL guard expression to the project's Condition schema.
// Handles the common shapes seen in Zork I item routines:
//   (GVAL FOO)              -> flag("foo", true)
//   (NOT (GVAL FOO))        -> flag("foo", false)
//   (FSET? OBJ OPENBIT)     -> itemState(obj, "isOpen", true)
//   (FSET? OBJ MUNGBIT)     -> itemState(obj, "broken", true)
//   (NOT (FSET? OBJ XBIT))  -> negation of the above
// Returns null for anything we don't recognize so the caller can drop the
// variant entirely.
const FLAG_BIT_TO_STATE_KEY: Record<string, string> = {
  OPENBIT: "isOpen",
  MUNGBIT: "broken",
};

function translateGuardToCondition(
  node: ZilNode,
  knownItemIds: Set<string>,
): Condition | null {
  if (isCall(node, "NOT")) {
    if (node.F.length < 2) return null;
    const inner = translateGuardToCondition(node.F[1], knownItemIds);
    if (!inner) return null;
    // Invert by flipping `equals` for atomic conditions; otherwise wrap in not.
    if (inner.type === "flag" || inner.type === "itemState") {
      return { ...inner, equals: !inner.equals } as Condition;
    }
    return { type: "not", condition: inner };
  }
  if (isCall(node, "GVAL")) {
    const flagName = firstAtomNameInArgs(node);
    if (!flagName) return null;
    return { type: "flag", key: id(flagName), equals: true };
  }
  if (isCall(node, "FSET?")) {
    const objName = firstAtomNameInArgs(node);
    const bitName = secondAtomNameInArgs(node);
    if (!objName || !bitName) return null;
    const itemId = id(objName);
    if (!knownItemIds.has(itemId)) return null;
    const stateKey = FLAG_BIT_TO_STATE_KEY[bitName];
    if (!stateKey) return null;
    return { type: "itemState", itemId, key: stateKey, equals: true };
  }
  return null;
}

function firstAtomNameInArgs(node: ZilCall): string | undefined {
  for (let i = 1; i < node.F.length; i++) {
    const arg = node.F[i];
    if (arg && typeof arg === "object" && "A" in arg) return (arg as ZilAtom).A;
  }
  return undefined;
}

function secondAtomNameInArgs(node: ZilCall): string | undefined {
  let count = 0;
  for (let i = 1; i < node.F.length; i++) {
    const arg = node.F[i];
    if (arg && typeof arg === "object" && "A" in arg) {
      count++;
      if (count === 2) return (arg as ZilAtom).A;
    }
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
  skippedPassageObjects: Set<string>,
  sharedSceneryRooms: Map<string, string[]>,
  routinesByName: Map<string, ZilRoutine>,
): Item[] {
  // ---- Step 1: iteratively determine which non-room objects to include.
  // Containers can hold items, so we do a fixpoint: an object is in if its #IN
  // is a room, an already-included object, or it's a referenced LOCAL-GLOBAL.
  const candidates = rawObjects.filter((o) => {
    if (o.IsRoom) return false;
    if (skippedPassageObjects.has(o.Name)) return false; // emitted as a Door instead
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
  const knownItemIds = new Set<string>();
  for (const raw of rawObjects) {
    if (raw.IsRoom) continue;
    knownItemIds.add(id(raw.Name));
  }

  for (const raw of rawObjects) {
    if (raw.IsRoom) continue;
    if (skippedPassageObjects.has(raw.Name)) continue; // emitted as a Door
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

    // ACTION-routine examines: walk the (VERB? EXAMINE) branches. Unconditional
    // text becomes the base description; state-conditional branches become
    // variants when their guards translate to our Condition schema.
    const routineName = firstAtomName(props.ACTION);
    const routine = routineName ? routinesByName.get(routineName) : undefined;
    const examines = routine ? extractItemExamines(routine, knownItemIds) : { variants: [] };

    const description = fdesc
      ? cleanWhitespace(fdesc)
      : ldesc
      ? cleanWhitespace(ldesc)
      : examines.description
      ? examines.description
      : `(${name})`;

    const flags = arrayOfStrings(props.FLAGS).map((f) => f.toUpperCase());

    const item: Item = {
      id: itemId,
      name,
      description,
      location: primaryLocation,
      ...(appearsIn && { appearsIn }),
      ...(examines.variants.length > 0 && { variants: examines.variants }),
      ...(flags.includes("TAKEBIT") && { takeable: true }),
      ...(!flags.includes("TAKEBIT") && flags.includes("NDESCBIT") && { fixed: true }),
    };

    // Containers — Zork convention:
    //   CONTBIT  = container (holds things, has capacity)
    //   OPENBIT  = currently in the open state
    // The new model: openness lives in item.state.isOpen and access is gated
    // by container.accessibleWhen referencing it. The auto-gen pass below
    // adds the open/close intents + triggers (parallel to passages).
    // DOORBIT items are extracted as Passages (separate path); skipped here.
    if (flags.includes("CONTBIT")) {
      const capacity = firstNumber(props.CAPACITY);
      item.state = { ...(item.state ?? {}), isOpen: flags.includes("OPENBIT") };
      item.container = {
        ...(capacity !== undefined && { capacity }),
        accessibleWhen: {
          type: "itemState",
          itemId: itemId,
          key: "isOpen",
          equals: true,
        },
        accessBlockedMessage: `The ${name} is closed.`,
      };
    }

    // Light sources: lightSource is now a marker capability ({}), and the lit
    // state lives in item.state.isLit (parallel to isOpen, broken patterns).
    // The new anyPerceivableItemWith({key: "isLit", equals: true}) Condition
    // finds lit lamps without any light-specific engine code.
    if (flags.includes("LIGHTBIT") || flags.includes("FLAMEBIT")) {
      item.lightSource = {};
      item.state = { ...(item.state ?? {}), isLit: flags.includes("ONBIT") };
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


// ---------- post-extraction enrichments ----------
//
// The mechanical extraction pulls structure (rooms/exits/items/passages) from
// the ZIL data, but some objects need hand-tuned content the source doesn't
// expose cleanly — per-side glimpses, state-conditional descriptions,
// see-through gating, traversal rules. We patch those in here.
//
// Each entry overrides or extends the extracted Passage by id. Keep entries
// surgical; this isn't a place to rewrite Zork's prose, only to fill in
// what mechanical extraction can't.

// Authored content (descriptions, glimpse prompts, manual passages, room exit
// patches, intent signals, triggers) lives in `zork-1.overrides.json`. The
// mechanical pass produces structure from ZIL; this load+merge layer applies
// the author's content on top. To add a new puzzle (rope, lamp battery, troll
// combat, ...), edit the overrides JSON — no code change needed.
//
// Merge rules:
//   - skipItemObjects: union into the item-extractor skip set
//   - passages: by id. Existing → deep merge (sides matched by roomId).
//                       New → appended as a complete passage.
//   - rooms:    by id. Existing → field override; exits shallow-merged.
//   - items:    by id. Existing → field override.
//   - intentSignals / triggers: appended.
//
// Stripped `$comment` fields (any nesting depth) are tolerated — JSON has no
// native comment syntax and authors lean on the convention.

interface OverrideStory {
  skipItemObjects?: string[];
  passages?: Array<Partial<SimplePassage> & { id: string }>;
  rooms?: Array<Partial<Room> & { id: string }>;
  items?: Array<Partial<Item> & { id: string; fromTemplate?: string }>;
  intentSignals?: IntentSignal[];
  customTools?: CustomTool[];
  triggers?: Trigger[];
  // Build-time named partial-Item templates. Items with `fromTemplate: "name"`
  // inherit fields from the matching template; resolved by resolveTemplates()
  // before merge. Stripped from the final story.
  templates?: Record<string, Partial<Item>>;
  // Pass-through Story-level fields. Authors declare these in JSON without
  // touching the extractor.
  winConditions?: EndCondition[];
  loseConditions?: EndCondition[];
  defaultVisibility?: Condition;
  sharedVariants?: TextVariant[];
  startState?: Record<string, Atom>;
}

function loadOverrides(path: string): OverrideStory {
  if (!existsSync(path)) {
    console.warn(`(no overrides file at ${path}; mechanical extraction only)`);
    return {};
  }
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return stripComments(raw) as OverrideStory;
}

// Recursively strip any `$comment` keys (and other `$`-prefixed metadata) from
// the parsed overrides. JSON has no native comment syntax; authors lean on a
// `$comment` convention. Stripping prevents the metadata from leaking into the
// final story JSON.
function stripComments(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripComments);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith("$")) continue;
      out[k] = stripComments(v);
    }
    return out;
  }
  return value;
}

// Resolve `Item.fromTemplate` references in the overrides. For each override
// item with `fromTemplate: "name"`, deep-merge the matching template's fields
// in (item fields win at the leaf level; arrays union; nested objects recurse).
// Strips `fromTemplate` from the resolved item and removes `templates` from
// the OverrideStory so the merged story never contains build-time fields.
//
// Errors out if `fromTemplate` references an unknown template — the author
// almost certainly mistyped the name, and silent fallthrough would produce a
// half-built item.
function resolveTemplates(overrides: OverrideStory): OverrideStory {
  if (!overrides.items || overrides.items.length === 0) {
    if (overrides.templates) {
      const { templates: _drop, ...rest } = overrides;
      return rest;
    }
    return overrides;
  }
  const templates = overrides.templates ?? {};
  const resolvedItems = overrides.items.map((rawItem) => {
    const tmplName = rawItem.fromTemplate;
    if (typeof tmplName !== "string" || tmplName.length === 0) return rawItem;
    const template = templates[tmplName];
    if (!template) {
      const known = Object.keys(templates).join(", ") || "(none defined)";
      throw new Error(
        `item "${rawItem.id}" references unknown template "${tmplName}". Known templates: ${known}`,
      );
    }
    const merged = deepMergeTemplate(template, rawItem) as Partial<Item> & { id: string; fromTemplate?: string };
    delete merged.fromTemplate;
    return merged;
  });
  const { templates: _drop, ...rest } = overrides;
  return { ...rest, items: resolvedItems };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Merge `b` onto `a`. Item fields (`b`) win at the leaf; nested objects merge
// recursively; arrays union (deduped by JSON-string equality, sufficient for
// our tag-shaped arrays). `undefined` in `b` is treated as "not specified" and
// keeps `a`'s value.
function deepMergeTemplate(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined) continue;
    const av = out[k];
    if (Array.isArray(av) && Array.isArray(v)) {
      const seen = new Set(av.map((x) => JSON.stringify(x)));
      const union = [...av];
      for (const entry of v) {
        const key = JSON.stringify(entry);
        if (!seen.has(key)) {
          seen.add(key);
          union.push(entry);
        }
      }
      out[k] = union;
    } else if (isPlainObject(av) && isPlainObject(v)) {
      out[k] = deepMergeTemplate(av, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function mergePassages(
  base: Passage[],
  overrides: OverrideStory["passages"],
): Passage[] {
  if (!overrides || overrides.length === 0) return base;
  const out = base.map((p) => p);
  for (const ov of overrides) {
    const idx = out.findIndex((p) => p.id === ov.id);
    if (idx >= 0) {
      out[idx] = mergePassage(out[idx], ov);
    } else {
      // New passage — must be complete (id, name, description, sides). The
      // schema validator will catch any missing required fields.
      out.push(ov as SimplePassage);
    }
  }
  return out;
}

function mergePassage(
  base: SimplePassage,
  ov: Partial<SimplePassage> & { id: string },
): SimplePassage {
  const merged: SimplePassage = { ...base };
  for (const [k, v] of Object.entries(ov)) {
    if (k === "id" || k === "sides" || v === undefined) continue;
    (merged as Record<string, unknown>)[k] = v;
  }
  if (ov.sides) {
    merged.sides = mergeSides(base.sides, ov.sides) as [PassageSide, PassageSide];
  }
  return merged;
}

function mergeSides(
  base: PassageSide[],
  overrides: Partial<PassageSide>[],
): PassageSide[] {
  const out = base.map((s) => ({ ...s }));
  for (const ov of overrides) {
    if (typeof ov.roomId !== "string") continue;
    const idx = out.findIndex((s) => s.roomId === ov.roomId);
    if (idx >= 0) out[idx] = { ...out[idx], ...ov };
  }
  return out;
}

function mergeRooms(
  base: Room[],
  overrides: OverrideStory["rooms"],
): Room[] {
  if (!overrides || overrides.length === 0) return base;
  return base.map((r) => {
    const ov = overrides.find((o) => o.id === r.id);
    if (!ov) return r;
    const exits =
      ov.exits !== undefined ? { ...(r.exits ?? {}), ...ov.exits } : r.exits;
    return { ...r, ...ov, exits };
  });
}

function mergeItems(
  base: Item[],
  overrides: OverrideStory["items"],
): Item[] {
  if (!overrides || overrides.length === 0) return base;
  const out = base.map((i) => {
    const ov = overrides.find((o) => o.id === i.id);
    return ov ? deepMergeTemplate(i as unknown as Record<string, unknown>, ov as Record<string, unknown>) as unknown as Item : i;
  });
  // Append override items whose ids don't exist in base (purely author-added
  // items like new combat NPCs). Authors must supply every required Item
  // field on a brand-new item; the validator catches missing fields.
  const baseIds = new Set(base.map((i) => i.id));
  for (const ov of overrides) {
    if (!baseIds.has(ov.id)) {
      out.push(ov as Item);
    }
  }
  return out;
}

// For every passage OR item that declares a boolean `isOpen` in its state,
// generate a pair of intent signals (open / close) and a pair of triggers
// that flip the state when the LLM matches the player's intent. This is how
// players "open the window" / "open the mailbox" without engine open/close
// verbs — one uniform mutation path for both kinds.
// Per-passage and per-item open/close intents and triggers are NO LONGER
// auto-generated. The author-declared `open` / `close` CustomTools in
// zork-1.overrides.json handle both via their polymorphic handlers — any
// item OR passage with state.isOpen gets toggled with the same handler,
// preconditions, and narration. Story-specific consequences (gain points
// on first open, reveal contents, etc.) become author-written triggers
// keyed on intentMatched("open") + intentArg("open", "itemId", "<id>").
//
// This stub stays so callers don't have to change shape; it just returns
// empty arrays. Delete once no other code path depends on it.
function generateOpenCloseScaffolding(
  passages: Passage[],
  items: Item[],
): {
  intentSignals: IntentSignal[];
  triggers: Trigger[];
} {
  void passages;
  void items;
  return { intentSignals: [], triggers: [] };
}

// For every item with a boolean `state.broken: false`, generate a break
// intent + trigger. Once broken stays broken (no "unbreak" symmetry by
// default). Authors can layer additional triggers (e.g. "broken egg spills
// contents") on top of this one.
function generateBreakScaffolding(items: Item[]): {
  intentSignals: IntentSignal[];
  triggers: Trigger[];
} {
  // Per-item break intents/triggers no longer auto-genned. The author-
  // declared `break` CustomTool handler does the generic state mutation.
  // Special-case "breaking the egg spills its contents" still needs an
  // author-written trigger that matches on intentMatched("break") +
  // intentArg("break", "itemId", "egg").
  void items;
  return { intentSignals: [], triggers: [] };
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
  const overrides = resolveTemplates(loadOverrides(OVERRIDES_PATH));

  // Passages first — produces the set of object names that the item
  // extractor must skip (so DOORBIT items aren't double-extracted).
  const passageResult = extractPassages(
    rawObjects,
    rawRooms,
    routinesByName,
    roomIds,
    sharedSceneryRooms,
  );

  // Override-declared passage ids feed into the room extractor so DEXIT
  // exits referencing manual passages (like the chimney) resolve correctly.
  // skipItemObjects unions into the item-extractor skip set so manual passages'
  // backing ZIL objects (CHIMNEY) aren't double-included as scenery.
  const allPassageIds = new Set(passageResult.passageIds);
  for (const p of overrides.passages ?? []) allPassageIds.add(p.id);
  const itemSkipSet = new Set(passageResult.skippedPassageObjects);
  for (const name of overrides.skipItemObjects ?? []) itemSkipSet.add(name);

  const extractedRooms = extractRooms(rawRooms, roomIds, allPassageIds, routinesByName);
  const rooms = mergeRooms(extractedRooms, overrides.rooms);
  const extractedItems = extractItems(rawObjects, roomIds, itemSkipSet, sharedSceneryRooms, routinesByName);
  const items = mergeItems(extractedItems, overrides.items);
  const passages = mergePassages(passageResult.passages, overrides.passages);

  // For every passage OR item with boolean state.isOpen, auto-generate
  // open/close intent signals + triggers so players can "open the window"
  // and "open the mailbox" via the same uniform mutation path.
  const openClose = generateOpenCloseScaffolding(passages, items);
  // For every item with boolean state.broken (initial false), auto-generate
  // a break intent + trigger.
  const breakable = generateBreakScaffolding(items);
  const intentSignals = [
    ...openClose.intentSignals,
    ...breakable.intentSignals,
    ...(overrides.intentSignals ?? []),
  ];
  const triggers = [
    ...openClose.triggers,
    ...breakable.triggers,
    ...(overrides.triggers ?? []),
  ];

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
    ...(passages.length > 0 && { passages }),
    ...(intentSignals.length > 0 && { intentSignals }),
    ...(overrides.customTools && overrides.customTools.length > 0 && { customTools: overrides.customTools }),
    ...(triggers.length > 0 && { triggers }),
    ...(overrides.defaultVisibility && {
      defaultVisibility: overrides.defaultVisibility,
    }),
    ...(overrides.sharedVariants && overrides.sharedVariants.length > 0 && {
      sharedVariants: overrides.sharedVariants,
    }),
    ...(overrides.startState && Object.keys(overrides.startState).length > 0 && {
      startState: overrides.startState,
    }),
    ...(overrides.winConditions && overrides.winConditions.length > 0 && {
      winConditions: overrides.winConditions,
    }),
    ...(overrides.loseConditions && overrides.loseConditions.length > 0 && {
      loseConditions: overrides.loseConditions,
    }),
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
  const passageGatedExits = rooms.reduce(
    (n, r) => n + Object.values(r.exits ?? {}).filter((e) => e.passage).length,
    0,
  );
  const ldescRooms = rooms.filter((r) => !r.description.startsWith("(")).length;
  console.log(`✓ wrote ${OUT_PATH}`);
  console.log(`  rooms: ${rooms.length} (${ldescRooms} with real descriptions, ${rooms.length - ldescRooms} placeholders)`);
  console.log(`  items: ${items.length}`);
  console.log(`  passages: ${passages.length}`);
  console.log(`  exits: ${exitCount} (${passageGatedExits} gated by passages)`);
  console.log(`  intent signals + triggers (auto-generated + overrides): ${intentSignals.length} + ${triggers.length}`);
  console.log(`  takeable items: ${items.filter((i) => i.takeable).length}`);
  console.log(`  containers:     ${items.filter((i) => i.container).length}`);
  console.log(`  light sources:  ${items.filter((i) => i.lightSource).length}`);
}

main();
