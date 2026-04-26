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

// ---------- Numeric expressions ----------
//
// A NumericExpr produces a number from current GameState. Used as the left/
// right operands of `compare` conditions. Adding new "sources" of integers
// (inventory weight, score, container fullness, etc.) just means adding a
// new variant here — the comparison logic doesn't change.
//
// Discriminator is `kind` (not `type`) to keep these visually distinct from
// Condition types when conditions and exprs nest.
export type NumericExpr =
  | { kind: "literal"; value: number }
  | { kind: "flag"; key: string }                  // value of a numeric flag (0 if unset / not numeric)
  | { kind: "passageState"; passageId: string; key: string }  // numeric value from a passage's state map (0 if unset)
  | { kind: "itemState"; itemId: string; key: string }        // numeric value from an item's state map (0 if unset)
  | { kind: "roomState"; roomId: string; key: string }        // numeric value from a room's state map (0 if unset)
  | { kind: "inventoryCount" }                     // items currently in inventory
  | { kind: "itemCountAt"; location: string }      // items whose location matches (roomId | itemId | "nowhere")
  | { kind: "matchedIntentsCount" }                // how many intent signals have been matched
  | { kind: "visitedCount" };                      // how many distinct rooms have been visited

// Future additions when weight/size land:
//   | { kind: "inventoryWeight" }
//   | { kind: "inventorySize" }
//   | { kind: "itemWeight"; itemId: string }
//   | { kind: "containerFullness"; itemId: string }

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
  | { type: "passageState"; passageId: string; key: string; equals: Atom } // per-passage typed state equality
  | { type: "itemState"; itemId: string; key: string; equals: Atom }       // per-item typed state equality
  | { type: "roomState"; roomId: string; key: string; equals: Atom }       // per-room typed state equality
  | { type: "currentRoomState"; key: string; equals: Atom }                // shortcut: roomState on the player's current room
  | { type: "anyPerceivableItemWith"; key: string; equals: Atom }          // any item perceivable to the player has state[key] === equals
  | { type: "intentMatched"; signalId: string }            // LLM has matched this intent at least once
  | {                                                      // numeric comparison: left <op> right
      type: "compare";
      left: NumericExpr;
      op: "==" | "!=" | "<" | "<=" | ">" | ">=";
      right: NumericExpr;
    }
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
  | { type: "setPassageState"; passageId: string; key: string; value: Atom }  // mutate passage state
  | { type: "setItemState"; itemId: string; key: string; value: Atom }        // mutate item state
  | { type: "setRoomState"; roomId: string; key: string; value: Atom }        // mutate room state
  | { type: "adjustFlag"; key: string; by: number }                           // signed delta on a numeric flag (treats unset as 0)
  | { type: "adjustItemState"; itemId: string; key: string; by: number }      // signed delta on a numeric item-state value (treats unset as 0)
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
  // If set, this exit is filtered from the view when the condition is false.
  // Composes with Story.defaultVisibility (both must hold for the exit to
  // appear). Default: visible. Used for darkness, fog, blindness, etc. —
  // generic perception gating that doesn't bake any specific concept into
  // the engine.
  visibleWhen?: Condition;
  // If set, the engine evaluates the referenced passage's traversableWhen
  // (per-side; falls back to passage-level) when the player tries to use this
  // exit. False -> reject with the passage's traverseBlockedMessage.
  passage?: string;
}

export interface Room {
  id: string;
  name: string;                 // short label, e.g. "West of House"
  description: string;          // canonical description, shown by default
  variants?: TextVariant[];     // alternate descriptions, evaluated in order; first match wins, else `description`
  exits?: Record<string, Exit>; // direction (lowercase, e.g. "north", "up", "in") -> exit
  // Per-room typed state. Same model as Item.state and Passage.state —
  // authors choose key names and value types. Triggers mutate via
  // setRoomState; conditions reference via Condition.roomState /
  // Condition.currentRoomState / NumericExpr.roomState. Common pattern:
  // { dark: true } for unlit rooms.
  state?: Record<string, Atom>;
}

// ---------- Items ----------

export interface Item {
  id: string;
  name: string;                 // canonical display name shown in inventory and narration
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
  // If set, this item is filtered from the view (and from accessibility
  // checks) when the condition is false. Composes with Story.defaultVisibility
  // (both must hold). Default: visible. Used for darkness, fog, blindness,
  // etc. — generic perception gating with no specific concept baked in.
  visibleWhen?: Condition;
  // Per-item typed state. Same model as Passage.state — authors choose key
  // names and value types. Triggers mutate via setItemState; conditions
  // reference via Condition.itemState / NumericExpr.itemState. Common
  // patterns: { isOpen: false } for openable containers, { broken: false }
  // for breakable items.
  state?: Record<string, Atom>;
  // Optional extra gates on the auto-generated open/close intents. The
  // extractor's auto-gen builds an `active` clause for each open/close
  // intent; if openWhen/closeWhen is set on the item, it's AND'd into that
  // clause. Use cases:
  //   - Locked chest: openWhen: itemState(self, isLocked, false)
  //   - Egg requires bird: openWhen: not(always)  (suppresses auto-open
  //     entirely; author writes a custom give-to-bird intent + trigger)
  //   - Asymmetric: closeWhen: not(always)  (slam-shut once, can't reopen)
  // Only consumed by the auto-gen pass — engine ignores them at runtime.
  openWhen?: Condition;
  closeWhen?: Condition;
  container?: {
    capacity?: number;          // max items it can hold (omit for unlimited)
    // If set, contents are accessible (visible, takeable, putable) only when
    // this Condition is true. If omitted, contents are always accessible
    // (e.g. an open basket). Typical openable container:
    //   { type: "itemState", itemId: <self id>, key: "isOpen", equals: true }
    accessibleWhen?: Condition;
    accessBlockedMessage?: string;  // shown when put fails accessibility
  };
  // Marker capability: presence indicates "this item can emit light." The lit
  // state itself lives in `state.isLit` (parallel to other openable/breakable
  // patterns). The new `anyPerceivableItemWith({ key: "isLit", equals: true })`
  // Condition finds lit lamps without any light-specific engine code.
  // Field shape kept open for future per-source metadata (radius, color, etc.).
  lightSource?: Record<string, never>;
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
  // If true, this trigger fires after EVERY action (not just when state
  // transitions during the regular fixed-point loop). Combine with
  // `once: false` for true tick behavior — the trigger re-evaluates each turn
  // and fires whenever its `when` is true. Used for lantern battery drain,
  // grue checks, NPC wandering, dam timer, etc.
  afterAction?: boolean;
}

// ---------- Doors ----------
//
// A door is a passage between exactly two rooms. Examineable from either
// side. An Exit references a door by id; the engine refuses traversal when
// the door is closed.
//
// Doors live in their own top-level array and share an id namespace with
// items (the validator enforces no collisions). The `examine` tool dispatches
// over either kind. Container open/close still applies to items only; for
// passages the player's intent to "open" is matched via IntentSignals and
// applied via Triggers (no built-in passage open/close action).
//
// `Passage` is a discriminated union on `kind` so future variants (magic
// passages with per-side state, secret passages, etc.) can be added without
// disturbing v1 stories. v1 supports only `kind: "simple"`, which is the
// default and may be omitted in JSON.
export type Passage = SimplePassage;
// Future: | MagicPassage | SecretPassage | ...

// Glimpse: a declaration that the player can see through the passage, plus
// the content shown when they do. Presence of `glimpse` enables see-through;
// absence means the passage is opaque.
//
// Gating is independent of any open/closed state — they're separate concerns.
// A window is see-through whether it's open or closed; an oak door isn't
// see-through at all; a hatch is see-through only when open.
//
// `when` defaults to "always available" — i.e. omitted means always see-
// through, suitable for windows / glass / archways. For passages that should
// only be see-through under specific conditions, set `when` explicitly:
//   { type: "passageState", passageId: "<self id>", key: "isOpen", equals: true }
//
// Content: provide `description` (canonical authored text the LLM should use
// as-is), or `prompt` (guidance for the LLM, e.g. "describe briefly,
// emphasize the warmth"), or neither (engine still passes the other room's
// name + description so the LLM can improvise).
export interface PassageGlimpse {
  when?: Condition;         // default: always available (omit for windows; set explicitly for doors)
  description?: string;     // static text shown when looking through
  prompt?: string;          // LLM guidance for how to describe the other side
}

// Per-side metadata. Both sides share the passage's typed state, but each
// side may present a different name, description, glimpse, and traversal
// gating — e.g. "the back door" outside vs. "the kitchen door" inside, or a
// chimney that's traversable from one room but not the other.
export interface PassageSide {
  roomId: string;
  name?: string;            // overrides passage.name when on this side
  description?: string;     // overrides passage.description when on this side
  variants?: TextVariant[]; // per-side state-conditional description overrides
  glimpse?: PassageGlimpse; // overrides passage.glimpse when set
  // Per-side traversal gating. Evaluated when the player is leaving FROM
  // this side. Overrides the passage-level traversableWhen when set.
  traversableWhen?: Condition;
  traverseBlockedMessage?: string;
  // Per-side visibility (e.g. "passage seen from the west only"). Composes
  // with passage.visibleWhen and Story.defaultVisibility; all must hold.
  visibleWhen?: Condition;
}

// A simple passage: typed state + per-side presentation + traversal rules.
// Covers ~95% of named connectors between rooms (door, window, gate, hatch,
// archway, chimney, narrow gap, magic portal).
export interface SimplePassage {
  kind?: "simple";          // optional in v1; default "simple"
  id: string;
  name: string;             // default name (used when a side doesn't override)
  description: string;      // default description
  variants?: TextVariant[]; // state-conditional description overrides
                            // (same shape as Room.variants; first match wins)
  sides: [PassageSide, PassageSide];
  glimpse?: PassageGlimpse; // passage-level default; per-side glimpse overrides this
  // Per-passage typed state. Authors choose key names and value types
  // (strings, numbers, booleans). Triggers mutate state via setPassageState.
  // Conditions reference state via Condition.passageState (equality) and
  // NumericExpr.passageState (numeric extraction for use with `compare`).
  // Common pattern: { isOpen: false } for openable passages.
  state?: Record<string, Atom>;
  // Optional extra gates on the auto-generated open/close intents. Same
  // semantics as Item.openWhen/closeWhen — AND'd into the auto-gen `active`
  // clause when set. Use for locked passages, ritual-only passages, etc.
  openWhen?: Condition;
  closeWhen?: Condition;
  // Passage-level visibility. Composes with PassageSide.visibleWhen and
  // Story.defaultVisibility; all must hold for the passage to appear in view.
  visibleWhen?: Condition;
  // Default traversal gate (per-side overrides take precedence). When the
  // player tries to traverse an exit referencing this passage, the engine
  // evaluates the FROM-side's traversableWhen if set, else this. False ->
  // reject with traverseBlockedMessage (per-side > passage-level > generic).
  // If unset entirely (and no per-side gate either), traversal is allowed.
  traversableWhen?: Condition;
  traverseBlockedMessage?: string;
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
  passages?: Passage[];
  triggers?: Trigger[];
  npcs?: NPC[];
  intentSignals?: IntentSignal[];
  winConditions?: EndCondition[];
  loseConditions?: EndCondition[];
  // Optional default applied to every item, passage, and exit lacking its own
  // `visibleWhen`. The engine evaluates per-object: explicit visibleWhen (if
  // set) AND defaultVisibility (if set). Both must hold for the object to
  // appear in view AND to be accessible to actions. Used for darkness, fog,
  // blindness — generic perception gating with no specific concept baked in.
  defaultVisibility?: Condition;
  // Optional TextVariants applied to EVERY room's description, in addition to
  // that room's own variants. The room's own variants are checked first; if
  // none match, sharedVariants are checked. Used for story-wide overrides
  // like "pitch black" applied to all dark rooms without copying the variant
  // onto every one.
  sharedVariants?: TextVariant[];
}

// ---------- Runtime game state (lives in localStorage / Supabase later) ----------

export interface GameState {
  storyId: string;
  schemaVersion: string;
  playerLocation: string;
  flags: Record<string, Atom>;
  itemLocations: Record<string, string>; // itemId -> roomId | "inventory" | "nowhere"
  // Per-passage typed state. Outer key is passageId; inner map is the
  // passage's state variables (initialized from passage.state).
  passageStates: Record<string, Record<string, Atom>>;
  // Per-item typed state. Outer key is itemId; inner map is the item's
  // state variables (initialized from item.state). Same shape as passageStates.
  itemStates: Record<string, Record<string, Atom>>;
  // Per-room typed state. Outer key is roomId; inner map is the room's state
  // variables (initialized from room.state).
  roomStates: Record<string, Record<string, Atom>>;
  matchedIntents: string[];              // intent signal ids the LLM has matched (persistent)
  visitedRooms: string[];
  examinedItems: string[];
  firedTriggers: string[];
  finished?: { won: boolean; message: string };
}
