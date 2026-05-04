// Structured events emitted by actions. The engine returns one of these per
// turn instead of a formatted string. The LLM (or the dev-only renderer in
// render.ts) is responsible for turning events into player-facing prose.
//
// Why structured: it lets the LLM narrate freely without being constrained to
// rephrase a pre-baked string, and keeps the engine's output unambiguous —
// "the player took the key" is a fact, "Taken." is a presentation.

export type ActionEvent =
  | { type: "looked" }
  | { type: "examined"; itemId: string; description: string }
  | { type: "took"; itemId: string }
  | { type: "dropped"; itemId: string }
  | { type: "put"; itemId: string; targetId: string }
  | { type: "inventoried" }
  | { type: "moved"; from: string; to: string; direction: string }
  | { type: "waited" }
  | { type: "attacked"; itemId: string; targetId: string; mode: string }
  | { type: "intent-recorded"; signalId: string }
  | { type: "boarded"; itemId: string }      // player entered a vehicle
  | { type: "disembarked"; itemId: string }  // player left a vehicle (itemId = the vehicle they exited)
  | {
      type: "rejected";
      reason: RejectionReason;
      itemId?: string;       // the primary item the action targets
      targetId?: string;     // the secondary item (e.g. "put X in Y" → Y)
      direction?: string;
      message?: string;      // optional story-authored or context-specific message
    };

export type RejectionReason =
  | "unknown-item"        // the requested itemId doesn't exist in the story
  | "not-accessible"      // item exists but isn't in the room or inventory
  | "not-in-room"         // for take: item exists but isn't in the player's room
  | "already-carrying"
  | "not-carrying"        // for drop / put
  | "fixed-item"          // can't take scenery
  | "not-takeable"
  | "take-blocked"        // for take: item's takeableWhen condition is false (e.g. inventory weight cap)
  | "no-such-direction"   // current room has no exit in this direction
  | "exit-blocked"        // exit exists but its `when` condition is false
  | "broken-exit-target"  // exit points to a nonexistent room (validator should catch)
  | "traverse-blocked"    // for passages: traversableWhen condition failed
  | "unknown-intent"      // recordIntent called with a signalId that doesn't exist
  | "not-container"       // for put: target item isn't a container
  | "container-inaccessible" // for put: target container's accessibleWhen is false
  | "container-full"      // for put: target container at capacity
  | "self-containment"    // for put: can't put X into X
  | "no-current-room"     // engine bug: player is in a nonexistent room
  | "not-enterable"       // for board: target is not a vehicle (no `vehicle` field)
  | "vehicle-blocked"     // for board: vehicle.enterableWhen is false (e.g. boat not yet inflated)
  | "vehicle-stationary"  // for go: player is in a !mobile vehicle and tried to move
  | "not-in-vehicle"      // for disembark: player isn't currently in any vehicle
  | "game-over";          // action attempted after the game ended
