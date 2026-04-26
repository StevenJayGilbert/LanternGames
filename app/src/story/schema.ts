// Story format v0.1
//
// A story is a static description of an interactive world. The engine reads it,
// builds runtime GameState from it, and an LLM narrates over both. This file is
// the contract — anything not defined here cannot be authored.
//
// Design intent: keep the schema small enough that a story is hand-writable JSON,
// and let the LLM cover the fuzzy parts (parsing player input, dialogue, creative
// adjudication, prose variation).

export const SCHEMA_VERSION = "0.1";
// Accept any string at the type level; the engine validates at load time.
// Lets us support "0.2" / "0.3" later via version migration without changing types.
export type SchemaVersion = string;

// Atomic value types allowed in flags and equality checks.
export type Atom = string | number | boolean;

// ---------- Conditions ----------

// A condition is a boolean expression over current GameState. Used in triggers,
// exit gating, text variants, and end conditions.
export type Condition =
  | { type: "flag"; key: string; equals: Atom }
  | { type: "hasItem"; itemId: string }                    // item currently in inventory
  | { type: "itemAt"; itemId: string; location: string }   // item at specific roomId | "inventory" | "nowhere"
  | { type: "playerAt"; roomId: string }
  | { type: "visited"; roomId: string }                    // player has entered room at least once
  | { type: "examined"; itemId: string }                   // player has examined item at least once
  | { type: "triggerFired"; triggerId: string }
  | { type: "doorOpen"; doorId: string }                   // door currently in the open state
  | { type: "containerOpen"; itemId: string }              // container item currently open
  | { type: "intentMatched"; signalId: string }            // LLM has matched this intent at least once
  | { type: "always" }                                     // unconditionally true; useful for default-on fields
  | { type: "and"; all: Condition[] }
  | { type: "or"; any: Condition[] }
  | { type: "not"; condition: Condition };

// ---------- Effects ----------

// Effects mutate GameState. Triggers fire effects when their `when` becomes true.
export type Effect =
  | { type: "setFlag"; key: string; value: Atom }
  | { type: "moveItem"; itemId: string; to: string }       // roomId | "inventory" | "nowhere"
  | { type: "movePlayer"; to: string }                     // teleport (rare; usually exits handle movement)
  | { type: "endGame"; won: boolean; message: string };

// ---------- Rooms ----------

export interface TextVariant {
  when: Condition;
  text: string;
}

export interface Exit {
  to: string;                   // target room id
  when?: Condition;             // if present, exit is usable only when condition is true
  blockedMessage?: string;      // shown when player tries to use the exit and `when` fails
  hidden?: boolean;             // if true, exit is not listed/described until `when` is true (default false)
  door?: string;                // door id; if set, exit is usable only when that door is open
}

export interface Room {
  id: string;
  name: string;                 // short label, e.g. "West of House"
  description: string;          // canonical description, shown by default
  variants?: TextVariant[];     // alternate descriptions, evaluated in order; first match wins, else `description`
  exits?: Record<string, Exit>; // direction (lowercase, e.g. "north", "up", "in") -> exit
}

// ---------- Items ----------

export interface Item {
  id: string;
  name: string;                 // canonical display name shown in inventory and narration
  synonyms?: string[];          // additional names the player can refer to it by
  adjectives?: string[];        // helpful for disambiguation (e.g. "small brass key")
  description: string;          // shown when examined
  // initial location: roomId | itemId (parent container) | "inventory" | "nowhere"
  location: string;
  // Additional rooms where the player perceives this item — used for shared
  // scenery that exists in multiple rooms (e.g. a window visible from both
  // sides of a wall). Only meaningful for fixed/scenery items; if an item
  // is takeable and gets moved to inventory, appearsIn is moot.
  appearsIn?: string[];
  takeable?: boolean;           // can the player pick it up (default false)
  fixed?: boolean;              // scenery; never moves, narrative-only (default false)
  readable?: { text: string };  // if present, "read X" shows this text
  container?: {
    openable?: boolean;
    isOpen?: boolean;           // initial state; engine tracks current state via flag
    capacity?: number;          // max items it can hold (omit for unlimited)
  };
  lightSource?: {
    isLit?: boolean;            // initial lit state
  };
}

// ---------- Triggers ----------

// A trigger watches GameState and fires its effects when `when` becomes true.
// Re-evaluated after every player action.
export interface Trigger {
  id: string;
  when: Condition;
  once?: boolean;               // if true (default), fire at most once
  effects?: Effect[];
  narration?: string;           // injected into the LLM's next narration as a state-change cue
}

// ---------- Doors ----------
//
// A door is a passage between exactly two rooms. Examineable from either
// side. An Exit references a door by id; the engine refuses traversal when
// the door is closed.
//
// Doors live in their own top-level array and share an id namespace with
// items (the validator enforces no collisions). Action tools (open/close/
// examine) work polymorphically over both kinds.
//
// `Door` is a discriminated union on `kind` so future door variants (magic
// doors with per-side state, secret doors, etc.) can be added without
// disturbing v1 stories. v1 supports only `kind: "simple"`, which is the
// default and may be omitted in JSON.
export type Door = SimpleDoor;
// Future: | MagicDoor | SecretDoor | ...

// Glimpse: a declaration that the player can see through the door, plus the
// content shown when they do. Presence of `glimpse` enables see-through;
// absence means the door is opaque.
//
// Gating is independent of open/closed state — they're separate concerns.
// A window is see-through whether it's open or closed; a wooden door isn't
// see-through at all; a hatch door is see-through only when open.
//
// `when` defaults to "always available" — i.e. omitted means always see-
// through, suitable for windows / glass / archways. For doors that should
// only be see-through when physically open, set `when` explicitly:
//   { type: "doorOpen", doorId: "<self id>" }
//
// Content: provide `description` (canonical authored text the LLM should use
// as-is), or `prompt` (guidance for the LLM, e.g. "describe briefly,
// emphasize the warmth"), or neither (engine still passes the other room's
// name + description so the LLM can improvise).
export interface DoorGlimpse {
  when?: Condition;         // default: always available (omit for windows; set explicitly for doors)
  description?: string;     // static text shown when looking through
  prompt?: string;          // LLM guidance for how to describe the other side
}

// Per-side metadata. Both sides share the door's physical open/closed state,
// but each side may present a different name, description, glimpse, and
// (eventually) capabilities — for example, "the back door" outside vs. "the
// kitchen door" inside, with different views through the window depending on
// which way you're facing.
export interface DoorSide {
  roomId: string;
  name?: string;            // overrides door.name when on this side
  description?: string;     // overrides door.description when on this side
  variants?: TextVariant[]; // per-side state-conditional description overrides
  glimpse?: DoorGlimpse;    // overrides door.glimpse when set
  // Per-side gating for opening (e.g. only from inside, or only with a key
  // from one side). Overrides the door-level openableWhen when set.
  openableWhen?: Condition;
  openBlockedMessage?: string;
  // Future per-side fields: hidden, etc.
}

// A simple door: shared open/closed state, optional per-side presentation.
// Covers ~95% of doors (front door, gate, hatch, window, archway).
export interface SimpleDoor {
  kind?: "simple";          // optional in v1; default "simple"
  id: string;
  name: string;             // default name (used when a side doesn't override)
  description: string;      // default description
  variants?: TextVariant[]; // state-conditional description overrides
                            // (same shape as Room.variants; first match wins)
  isOpen?: boolean;         // initial physical state, default closed
  sides: [DoorSide, DoorSide];
  glimpse?: DoorGlimpse;    // door-level default; per-side glimpse overrides this
  // Gating for opening (close is always allowed). When `openableWhen` is set
  // and evaluates false, the engine refuses `open` and surfaces
  // `openBlockedMessage` (or a generic refusal). Per-side openableWhen
  // overrides this door-level default. Examples:
  //   { type: "hasItem", itemId: "crowbar" }                  — needs an item
  //   { type: "flag", key: "lever-pulled", equals: true }     — needs prior puzzle
  //   { type: "and", all: [<roomCheck>, <itemCheck>] }        — multi-condition
  // If unset, the door opens freely.
  openableWhen?: Condition;
  openBlockedMessage?: string;
  // Future: isLocked, keyId
}

// ---------- Intent signals ----------
//
// Intent signals let authors gate state on fuzzy player-intent rather than
// strict engine state. Each signal is a named natural-language description
// of something the player might try. The narrator passes active signals to
// the LLM each turn; if the player's input semantically matches a signal,
// the LLM calls `recordIntent(signalId)` and the engine sets the matched
// flag (persistently). Conditions reference signals via `intentMatched`.
//
// Use sparingly — each active signal costs prompt tokens. The `active`
// gate ensures a signal is only watched when it's relevant (e.g. only watch
// "slip leaflet under door" once the player has the leaflet).
export interface IntentSignal {
  id: string;          // unique; referenced by intentMatched conditions
  prompt: string;      // natural-language description for the LLM to match
  active?: Condition;  // optional: only watch when this is true (saves tokens)
}

// ---------- NPCs (placeholder; expanded in a later schema version) ----------

export interface NPC {
  id: string;
  name: string;
  location: string;
  personality: string;          // a paragraph the LLM uses to drive dialogue
  // Dialogue, scripted reactions, and inventory deferred to v0.2+
}

// ---------- End conditions ----------

export interface EndCondition {
  when: Condition;
  message: string;              // shown to the player when game ends
}

// ---------- Story (top-level) ----------

export interface Story {
  schemaVersion: string;
  id: string;                   // unique slug, used for save segregation
  title: string;
  author: string;
  description?: string;         // shown in the story picker
  intro?: string;               // shown when the player starts a new game
  systemPromptOverride?: string; // appended to the engine's narrator system prompt
  startRoom: string;            // room id where the player begins
  startState?: Record<string, Atom>; // initial flag values
  rooms: Room[];
  items: Item[];
  doors?: Door[];
  triggers?: Trigger[];
  npcs?: NPC[];
  intentSignals?: IntentSignal[];
  winConditions?: EndCondition[];
  loseConditions?: EndCondition[];
}

// ---------- Runtime game state (lives in localStorage / Supabase later) ----------

export interface GameState {
  storyId: string;
  schemaVersion: string;
  playerLocation: string;
  flags: Record<string, Atom>;
  itemLocations: Record<string, string>; // itemId -> roomId | "inventory" | "nowhere"
  containerOpen: Record<string, boolean>;
  lightSourcesLit: Record<string, boolean>;
  doorOpen: Record<string, boolean>;     // doorId -> currently open?
  matchedIntents: string[];              // intent signal ids the LLM has matched (persistent)
  visitedRooms: string[];
  examinedItems: string[];
  firedTriggers: string[];
  finished?: { won: boolean; message: string };
}
