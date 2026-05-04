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
  | { kind: "passageState"; passageId: IdRef; key: string }   // numeric value from a passage's state map (0 if unset)
  | { kind: "itemState"; itemId: IdRef; key: string }         // numeric value from an item's state map (0 if unset)
  | { kind: "roomState"; roomId: string; key: string }        // numeric value from a room's state map (0 if unset)
  | { kind: "inventoryCount" }                     // items currently in inventory
  | { kind: "itemCountAt"; location: string }      // items whose location matches (roomId | itemId | "nowhere")
  | { kind: "matchedIntentsCount" }                // how many intent signals have been matched
  | { kind: "visitedCount" }                       // how many distinct rooms have been visited
  | { kind: "inventoryWeight" }                    // sum of state.weight across all items currently in player's inventory (items without a numeric state.weight contribute 0). Useful for inventory-weight gates: takeableWhen: compare(add(inventoryWeight, itemState({fromArg:"self"}, "weight")), <=, flag(max-carry-weight)).
  | { kind: "add"; left: NumericExpr; right: NumericExpr }    // sum of two NumericExprs
  | { kind: "negate"; of: NumericExpr };                       // arithmetic negation (multiply by -1)

// Future additions when weight/size land:
//   | { kind: "inventoryWeight" }
//   | { kind: "inventorySize" }
//   | { kind: "itemWeight"; itemId: string }
//   | { kind: "containerFullness"; itemId: string }

// ---------- Arg references (templated values inside tool handlers) ----------

// A handler's preconditions/effects can reference the call's args via
// { fromArg: "<argName>" } in place of a literal string. The runtime
// substitutes args eagerly before evaluation, so by the time a Condition
// or Effect reaches an evaluator the IdRef has been resolved to a string.
// Outside handlers, all id fields should be plain strings.
export type IdRef = string | { fromArg: string };

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
  | { type: "passageState"; passageId: IdRef; key: string; equals: Atom }  // per-passage typed state equality (passageId may be {fromArg: "..."} inside a tool handler)
  | { type: "passagePerceivable"; passageId: IdRef }                       // passage is currently visible/reachable to the player (analog of itemAccessible for passages)
  | { type: "passageHasStateKey"; passageId: IdRef; key: string }          // the named passage has a defined state[key] (handler precondition for "this verb doesn't apply here")
  | { type: "itemState"; itemId: IdRef; key: string; equals: Atom }        // per-item typed state equality (itemId may be {fromArg: "..."} inside a tool handler)
  | { type: "roomState"; roomId: string; key: string; equals: Atom }       // per-room typed state equality
  | { type: "currentRoomState"; key: string; equals: Atom }                // shortcut: roomState on the player's current room
  | { type: "anyPerceivableItemWith"; key: string; equals: Atom }          // any item perceivable to the player has state[key] === equals
  | { type: "anyAdjacentRoomItemWith"; key: string; equals: Atom }         // any item directly located in a room reachable via the current room's exits has state[key] === equals (walks all exits regardless of visibleWhen / traversableWhen — matches canonical Zork "danger one room away" sword-glow detection through closed doors)
  | { type: "itemHasTag"; itemId: string; tag: string }                    // does the named item carry this tag?
  | { type: "flagItemHasTag"; flagKey: string; tag: string }               // look up itemId from a flag, then check its tags — load-bearing for class-based combat
  | { type: "intentMatched"; signalId: string }            // an intent has been matched at least once. signalId can be a customTool id OR a built-in action name (look, examine, take, drop, put, inventory, go, wait, attack, board, disembark) — both are recorded into matchedIntents uniformly. NOTE: triggers gating on a built-in intent should call removeMatchedIntent to consume it; otherwise the matched flag persists and the trigger may re-fire on later turns when its other gates align. ENTER-ROOM PATTERN: gate a trigger on `intentMatched("go") + playerAt(roomId) + <state>` to fire on every successful entry into roomId. Pair with `removeMatchedIntent("go")` so it doesn't bleed into the next turn. Use `once: false` for re-fire on every entry; for first-entry-only use `Condition.visited` (the inverse: gate on !visited before the move, or just `once: true`).
  | { type: "intentArg"; signalId: string; key: string; equals: Atom }     // matched intent's args[key] === equals. Same signalId namespace as intentMatched. Examples: customTool open(itemId="mailbox") → intentArg("open", "itemId", "mailbox"); built-in go(direction="west") → intentArg("go", "direction", "west"); take(itemId="bell") → intentArg("take", "itemId", "bell"). Built-in args mirror the action's input fields verbatim.
  | { type: "itemAccessible"; itemId: IdRef }                              // item is currently perceivable to the player (in their room, inventory, or open container they can reach). itemId may be {fromArg: "..."} inside a tool handler.
  | { type: "itemHasStateKey"; itemId: IdRef; key: string }                // the named item has a defined state[key] (used by handlers to fail gracefully on items that don't support a verb)
  | { type: "itemReadable"; itemId: IdRef }                                // the named item has a defined `readable.text` field (used by the read customTool's preconditions to gate readability without per-item triggers)
  | { type: "inventoryHasTag"; tag: string }               // any item currently in the player's inventory carries this tag (no per-id enumeration)
  | { type: "inVehicle"; itemId?: string }                 // player is currently inside a vehicle. If itemId given, must be that specific vehicle; otherwise any vehicle.
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
  | { type: "moveItem"; itemId: string; to: string }       // roomId | itemId | "player" | "inventory" (legacy alias for "player") | "nowhere". Moving the "player" item updates currentRoom; if the destination is a room, visitedRooms is updated.
  | { type: "moveItemsFrom"; from: string; to: string }    // bulk: every item currently at `from` moves to `to`. Generic primitive for "container empties": NPC dies and drops everything; trophy case shatters; bag torn open. `from`/`to` are roomId | itemId | "player" | "inventory" | "nowhere".
  | { type: "setPassageState"; passageId: IdRef; key: string; value: Atom }  // mutate passage state (passageId may be {fromArg: "..."} inside a tool handler)
  | { type: "setItemState"; itemId: IdRef; key: string; value: Atom }         // mutate item state (itemId may be {fromArg: "..."} inside a tool handler)
  | { type: "setRoomState"; roomId: string; key: string; value: Atom }        // mutate room state
  | { type: "adjustFlag"; key: string; by: number | NumericExpr }                  // signed delta on a numeric flag (treats unset as 0). `by` may be a literal or a NumericExpr evaluated against current state at effect-application time.
  | { type: "adjustItemState"; itemId: IdRef; key: string; by: number | NumericExpr }  // signed delta on a numeric item-state value (treats unset as 0). itemId may be {fromArg} inside a tool handler; `by` may be a literal or a NumericExpr.
  | { type: "removeMatchedIntent"; signalId: string }                          // un-match an intent so its triggers don't re-fire forever
  | {
      // Roll a uniform random integer in [min, max] inclusive and write it
      // to state.flags[key] as a number. Atomic primitive — combine with
      // `if`/`then`/`else` (or `compare` Conditions) to branch on the rolled
      // value. Foot-gun avoidance: NumericExpr deliberately has NO `random`
      // kind because NumericExpr is evaluated lazily (re-rolling on every
      // condition eval); this Effect materializes the roll into a flag once.
      type: "setFlagRandom";
      key: string;
      min: number;            // inclusive lower bound
      max: number;            // inclusive upper bound (must be ≥ min)
    }
  | {
      // Append text to narrationCues. No state mutation. Used inside
      // `if`/`then`/`else` branches so a decomposed conditional can emit
      // branch-specific prose (analogous to trigger.narration but per-branch).
      // Goes through renderNarration so {flag.X} template substitution works.
      type: "narrate";
      text: string;
    }
  | {
      // Deterministic conditional. Evaluates `if`; runs `then` if true, else
      // `else` (or no-op if `else` is absent). Use `setFlagRandom` first to
      // roll a value, then chain `if`/`then`/`else` to branch on the flag.
      type: "if";
      if: Condition;
      then: Effect[];
      else?: Effect[];
    }
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
  // Engine-side narration guidance for the LLM. NOT flavor — see Item.narratorNote.
  narratorNote?: string;
}

// ---------- Items ----------

export interface Item {
  id: string;
  name: string;                 // canonical display name shown in inventory and narration
  // Short room-presence line — one sentence describing what the player would
  // notice glancing at the room. Surfaced in ItemView.appearance every turn the
  // item is in the current room. Optional; without it, items don't get a
  // room-presence line (LLM falls back to inventing prose from name + state).
  // For state-aware glance prose, use `appearanceVariants` (parallel to
  // `variants` for the examine description).
  appearance?: string;
  // State-conditional overrides for `appearance`. Same shape as `variants`;
  // first match wins, else falls back to `appearance`.
  appearanceVariants?: TextVariant[];
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
  // Optional list of author-chosen classification labels. Each item can carry
  // zero or more tags; a multi-class membership system. Engine matches tags
  // by string equality in `itemHasTag` / `flagItemHasTag` Conditions.
  // Examples: ["weapon", "sword", "bladed"], ["enemy", "troll"], ["treasure"].
  tags?: string[];
  // Optional LLM-facing voice/manner. The engine ignores this field; the view
  // surfaces it so the LLM can speak / narrate this entity in character.
  // Useful for NPCs that talk, react, or have distinct personality.
  personality?: string;
  // Engine-side narration guidance for the LLM. NOT flavor — the LLM follows
  // it silently and never quotes it to the player. Distinct from
  // `personality` (NPC voice) and `description` (canonical prose). Used to
  // tell the narrator HOW to handle the entity — e.g. "treat anything 'in'
  // this as resting on the surface", "describe in past tense", etc.
  narratorNote?: string;
  // Build-time template inheritance: name a Story.templates entry whose
  // fields are deep-merged into this item (item fields win, arrays union).
  // Resolved by the extractor; stripped from the final story JSON before
  // engine load. Engine never sees this field.
  fromTemplate?: string;
  // State-conditional alternate descriptions, evaluated in order; first match
  // wins, else `description`. Parallel to Room.variants and Passage.variants.
  // Used by `examine` to pick the description text. Common pattern: sword
  // glowing when a hostile NPC is perceivable.
  variants?: TextVariant[];
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
  // Optional gate on the built-in `take` action for this item. Modeled on
  // Exit.when: evaluated AFTER the existing take checks (item exists, is
  // accessible, not fixed, takeable). When false, take is rejected with
  // `takeBlockedMessage` (or a generic refusal if not set). The condition
  // evaluates with `{ self: <this item id> }` injected as args, so authors
  // can use `{fromArg: "self"}` IdRefs inside the condition to reference
  // the item's own state — useful for templated rules like inventory weight
  // ("carry-weight + self.weight <= max-carry-weight").
  takeableWhen?: Condition;
  takeBlockedMessage?: string;
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
  // Vehicle capability: presence makes the item enterable. The player can
  // BOARD it, sit DISEMBARK from it, and (if `mobile`) the vehicle travels
  // with them on `go(direction)`. Combined with the new Condition.inVehicle
  // and Effect.setPlayerVehicle, lets authors model boats, carts, mounts,
  // magic carpets, etc. without baking vehicle semantics into specific items.
  // Engine state: `GameState.playerVehicle` tracks which vehicle the player
  // is currently inside (or null on foot).
  vehicle?: {
    mobile?: boolean;            // false = enterable but stationary (booth, throne); true = travels with player on go() (default false)
    enterableWhen?: Condition;   // gate on conditions (e.g. boat must be inflated). If absent, always enterable when accessible.
    enterBlockedMessage?: string; // shown on board attempt when enterableWhen is false
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
  // If true, this trigger fires after EVERY action (not just when state
  // transitions during the regular fixed-point loop). Combine with
  // `once: false` for true tick behavior — the trigger re-evaluates each turn
  // and fires whenever its `when` is true. Used for lantern battery drain,
  // grue checks, NPC wandering, dam timer, etc.
  afterAction?: boolean;
  // Sort order within a single trigger pass. Higher fires first; default 0.
  // Used to make specific triggers (status-aware overrides, specific-id
  // matches) win over class-based or catchall triggers — combine with the
  // consume-the-flag convention so lower-priority triggers see a cleared
  // flag and short-circuit. Recommended bands:
  //   100+ status-aware overrides; 50-99 specific-id; 10-49 class-based;
  //   0 default; -100 catchall cleanup.
  priority?: number;
}

// ---------- Doors ----------
//
// A door is a passage between exactly two rooms. Examineable from either
// side. An Exit references a door by id; the engine refuses traversal when
// the door is closed.
//
// Doors live in their own top-level array and share an id namespace with
// items (the validator enforces no collisions). The `examine` tool dispatches
// over either kind. Open/close are author-declared CustomTools whose
// handlers operate on either an item OR a passage with state.isOpen, so
// "open the kitchen window" and "open the mailbox" go through the same path.
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
  // Engine-side narration guidance for the LLM. NOT flavor — see Item.narratorNote.
  narratorNote?: string;
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
// ---------- Custom tools (the intent system) ----------
//
// A CustomTool is an author-declared LLM tool — story-defined verbs that
// the LLM calls by name, alongside the engine's built-in verbs.
//   - the tool's name is its id; description is the LLM tool description
//   - args declare the tool's input_schema (parameters with types)
//   - alwaysAvailable: author opts the tool in to the cache-stable tool tier
//   - handler: optional declarative response — runs synchronously when the
//     tool is called, before the trigger pipeline. Lets one tool (e.g. open)
//     handle dozens of items generically without per-item triggers.
//
// Triggers still exist for per-puzzle special cases. They reference a tool
// call via Condition.intentMatched + Condition.intentArg, just like before.

export interface CustomTool {
  id: string;
  description: string;
  args?: ToolArgsSchema;
  alwaysAvailable?: boolean;
  handler?: ToolHandler;
}

export interface ToolArgsSchema {
  type: "object";
  properties: Record<string, ToolArgProp>;
  required?: string[];
}

export interface ToolArgProp {
  type: "string" | "number" | "boolean";
  description?: string;
  enum?: (string | number)[];
}

// A handler runs synchronously when the tool is called, BEFORE the trigger
// pipeline. Preconditions evaluate top-down; the first failure short-circuits
// and emits its failedNarration as a cue (no effects applied). If all
// preconditions pass, effects apply in order and successNarration is emitted.
export interface ToolHandler {
  preconditions?: ToolPrecondition[];
  effects?: Effect[];                  // may contain {fromArg} substitutions in id fields
  successNarration?: string;           // template; supports {arg.<argName>.name|id}
}

export interface ToolPrecondition {
  when: Condition;                     // may contain {fromArg} substitutions in id fields
  failedNarration: string;             // template; same substitution rules
}

// ---------- NPCs (placeholder; expanded in a later schema version) ----------

export interface NPC {
  id: string;
  name: string;
  location: string;
  personality: string;          // a paragraph the LLM uses to drive dialogue
  // Dialogue, scripted reactions, and inventory deferred to v0.2+
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
  customTools?: CustomTool[];
  // Build-time templates that items can inherit from via Item.fromTemplate.
  // The extractor merges template fields into items (item fields win, arrays
  // union) and strips fromTemplate before emitting the final JSON. Engine
  // never sees this field — by the time a story loads, all items are flat.
  templates?: Record<string, Partial<Item>>;
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
  flags: Record<string, Atom>;
  // itemId -> location. The player is also tracked here under id "player".
  // location can be: roomId | itemId (parent container) | "player" (in inventory)
  // | "nowhere". The legacy magic string "inventory" is normalized to "player"
  // by initialState; engine code should never compare against "inventory"
  // directly — use the resolveLocation helper or compare to "player".
  itemLocations: Record<string, string>;
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
  matchedIntentArgs: Record<string, Record<string, Atom>>;  // args of the most-recent match per signalId; cleared on removeMatchedIntent
  visitedRooms: string[];
  // Items the player has examined at least once. Gates inclusion of
  // `ItemView.description` in the view (so unexamined items remain
  // appearance-only and the LLM can't spoil puzzle text). The narrator's
  // per-turn view-fingerprint handles change detection — when the resolved
  // description text changes, the fingerprint differs and the view re-pushes.
  examinedItems: string[];
  firedTriggers: string[];
  finished?: { won: boolean; message: string };
}
