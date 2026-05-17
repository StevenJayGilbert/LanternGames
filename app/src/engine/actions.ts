// Core player actions. Each action is a pure function:
//   (state, story, args) -> ActionResult
//
// Actions return structured ActionEvents — facts about what happened — rather
// than formatted prose. The Engine wraps these with trigger evaluation and
// view building; render.ts formats them for display.

import type { Atom, GameState, Story } from "../story/schema";
import {
  applyEffect,
  currentRoom,
  currentRoomId,
  evaluateCondition,
  isCarried,
  isContainerAccessible,
  isItemAccessible,
  itemById,
  itemsInContainer,
  passageById,
  passagePresentation,
  passagesHere,
  PLAYER_ITEM_ID,
  playerVehicleId,
  resolveItemDescription,
  roomById,
  visibleExits,
} from "./state";
import { substituteCondition, substituteEffect } from "./substituteArgs";
import { renderNarration } from "./renderNarration";
import type { ActionEvent } from "./events";

export type ActionRequest =
  | { type: "look" }
  | { type: "examine"; itemId: string }
  | { type: "take"; itemId: string }
  | { type: "drop"; itemId: string }
  | { type: "put"; itemId: string; targetId: string }
  | { type: "inventory" }
  | { type: "go"; direction: string }
  | { type: "wait" }
  | { type: "attack"; itemId: string; targetId: string; mode?: string }
  | { type: "recordIntent"; signalId: string; args?: Record<string, Atom> }
  | { type: "board"; itemId: string }
  | { type: "disembark" };

// signalIds reserved for built-in actions. Triggers can gate on these via
// Condition.intentMatched / intentArg just like custom-tool intents.
// The validator refuses customTool ids that collide with this set so authors
// can't accidentally shadow a built-in's intent recording.
export const BUILT_IN_INTENT_NAMES = [
  "look",
  "examine",
  "take",
  "drop",
  "put",
  "inventory",
  "go",
  "wait",
  "attack",
  "board",
  "disembark",
] as const;

export interface ActionResult {
  state: GameState;
  event: ActionEvent;
  ok: boolean;
  cues?: string[];   // narration cues emitted by the action itself (e.g. tool handler success/failure text)
}

// Map any ActionRequest to {signalId, args} for intent recording. Generic
// spread — no per-case switch. Recording happens regardless of action
// success or rejection so triggers can react to attempted-but-failed
// actions (e.g. "go west while loaded" thematic refusals). recordIntent is
// skipped because the custom-tool path records itself.
function actionToIntent(
  req: ActionRequest,
): { signalId: string; args: Record<string, Atom> } | null {
  if (req.type === "recordIntent") return null;
  const { type, ...rest } = req;
  return { signalId: type, args: rest as Record<string, Atom> };
}

// Single shared mutator — used by both performAction (built-ins) and
// recordIntent (custom tools) so the matchedIntents shape is identical
// across both paths.
function applyMatchedIntent(
  state: GameState,
  signalId: string,
  args: Record<string, Atom>,
): GameState {
  const nextMatched = state.matchedIntents.includes(signalId)
    ? state.matchedIntents
    : [...state.matchedIntents, signalId];
  const nextArgs = { ...state.matchedIntentArgs, [signalId]: args };
  return { ...state, matchedIntents: nextMatched, matchedIntentArgs: nextArgs };
}

export function performAction(
  state: GameState,
  story: Story,
  req: ActionRequest,
): ActionResult {
  const result = dispatchAction(state, story, req);
  // Record built-in actions as matched intents so triggers can gate on them
  // via Condition.intentMatched / intentArg. recordIntent is skipped (its
  // own code path already records). Recording is unconditional — failed
  // and successful actions both flag the intent, letting triggers react to
  // attempted-but-failed actions (e.g. "go west while loaded").
  const intent = actionToIntent(req);
  if (!intent) return result;
  return {
    ...result,
    state: applyMatchedIntent(result.state, intent.signalId, intent.args),
  };
}

function dispatchAction(
  state: GameState,
  story: Story,
  req: ActionRequest,
): ActionResult {
  switch (req.type) {
    case "look": return look(state, story);
    case "examine": return examine(state, story, req.itemId);
    case "take": return take(state, story, req.itemId);
    case "drop": return drop(state, story, req.itemId);
    case "put": return put(state, story, req.itemId, req.targetId);
    case "inventory": return inventory(state);
    case "go": return go(state, story, req.direction);
    case "wait": return { state, event: { type: "waited" }, ok: true };
    case "attack": return attack(state, story, req.itemId, req.targetId, req.mode);
    case "recordIntent": return recordIntent(state, story, req.signalId, req.args);
    case "board": return board(state, story, req.itemId);
    case "disembark": return disembark(state, story);
  }
}

// ---------- look ----------

function look(state: GameState, story: Story): ActionResult {
  const room = currentRoom(state, story);
  if (!room) {
    return { state, event: reject("no-current-room"), ok: false };
  }
  return { state, event: { type: "looked" }, ok: true };
}

// ---------- examine ----------

function examine(state: GameState, story: Story, id: string): ActionResult {
  // Polymorphic: id could be an item OR a door. Try item first, then door.
  const item = itemById(story, id);
  if (item) {
    if (!isItemAccessible(item, state, story)) {
      return { state, event: reject("not-accessible", { itemId: item.id }), ok: false };
    }
    const examined = state.examinedItems.includes(item.id)
      ? state.examinedItems
      : [...state.examinedItems, item.id];
    const description = resolveItemDescription(item, state, story);
    return {
      state: { ...state, examinedItems: examined },
      event: { type: "examined", itemId: item.id, description },
      ok: true,
    };
  }

  const passage = passageById(story, id);
  if (passage) {
    const visible = passagesHere(state, story).some((p) => p.id === passage.id);
    if (!visible) {
      return { state, event: reject("not-accessible", { itemId: passage.id }), ok: false };
    }
    const presentation = passagePresentation(passage, state, story);
    return {
      state,
      event: { type: "examined", itemId: passage.id, description: presentation.description },
      ok: true,
    };
  }

  return { state, event: reject("unknown-item", { itemId: id }), ok: false };
}

// ---------- take ----------

function take(state: GameState, story: Story, itemId: string): ActionResult {
  // The player can't pick themselves up. (`fixed: true` on the player item
  // would also block this via the fixed-item path below, but a clearer
  // rejection up front avoids the awkward "you can't pick up yourself".)
  if (itemId === PLAYER_ITEM_ID) {
    return { state, event: reject("not-takeable", { itemId }), ok: false };
  }
  const item = itemById(story, itemId);
  if (!item) {
    return { state, event: reject("unknown-item", { itemId }), ok: false };
  }
  if (state.itemLocations[item.id] === PLAYER_ITEM_ID) {
    return { state, event: reject("already-carrying", { itemId: item.id }), ok: false };
  }
  // Accessibility check covers items directly in the room AND items inside
  // open containers in the room.
  if (!isItemAccessible(item, state, story)) {
    return { state, event: reject("not-in-room", { itemId: item.id }), ok: false };
  }
  if (item.fixed) {
    return { state, event: reject("fixed-item", { itemId: item.id }), ok: false };
  }
  if (!item.takeable) {
    return { state, event: reject("not-takeable", { itemId: item.id }), ok: false };
  }
  // takeableWhen — declarative gate on this take action. Modeled on
  // Exit.when: condition checked BEFORE the state mutation. Inject `self`
  // as the item id so the condition can reference the item's own state via
  // `{fromArg: "self"}` IdRefs (used by templated rules like inventory weight).
  //
  // Skipped when the item is already in the player's possession (nested in a
  // carried container): taking it out of your own pack can't change carried
  // weight, so a weight gate must not block it. Canonical Zork I does the
  // same — gverbs.zil:1931, the load-check guarded by <NOT <IN? <LOC PRSO> WINNER>>.
  if (item.takeableWhen && !isCarried(item.id, state)) {
    const substituted = substituteCondition(item.takeableWhen, { self: item.id });
    if (substituted !== null && !evaluateCondition(substituted, state, story)) {
      return {
        state,
        event: reject("take-blocked", { itemId: item.id, message: item.takeBlockedMessage }),
        ok: false,
      };
    }
  }
  return {
    state: {
      ...state,
      itemLocations: { ...state.itemLocations, [item.id]: PLAYER_ITEM_ID },
    },
    event: { type: "took", itemId: item.id },
    ok: true,
  };
}

// ---------- put (X into container Y) ----------

function put(
  state: GameState,
  story: Story,
  itemId: string,
  targetId: string,
): ActionResult {
  const item = itemById(story, itemId);
  if (!item) {
    return { state, event: reject("unknown-item", { itemId, targetId }), ok: false };
  }
  // Must be carrying the item.
  if (state.itemLocations[item.id] !== PLAYER_ITEM_ID) {
    return { state, event: reject("not-carrying", { itemId: item.id, targetId }), ok: false };
  }

  // Resolve and validate the target container.
  const target = itemById(story, targetId);
  if (!target) {
    return { state, event: reject("unknown-item", { itemId: targetId, targetId }), ok: false };
  }
  if (item.id === target.id) {
    return { state, event: reject("self-containment", { itemId: item.id, targetId: target.id }), ok: false };
  }
  if (!isItemAccessible(target, state, story)) {
    return { state, event: reject("not-accessible", { itemId: target.id, targetId: target.id }), ok: false };
  }
  if (!target.container) {
    return { state, event: reject("not-container", { itemId: item.id, targetId: target.id }), ok: false };
  }
  // Containers may declare accessibleWhen — when false, contents can't be
  // reached. Surface the author's accessBlockedMessage if present.
  if (!isContainerAccessible(target, state, story)) {
    return {
      state,
      event: reject("container-inaccessible", {
        itemId: item.id,
        targetId: target.id,
        message: target.container.accessBlockedMessage,
      }),
      ok: false,
    };
  }
  if (target.container.capacity !== undefined) {
    const contents = itemsInContainer(state, story, target.id);
    if (contents.length >= target.container.capacity) {
      return { state, event: reject("container-full", { itemId: item.id, targetId: target.id }), ok: false };
    }
  }

  return {
    state: {
      ...state,
      itemLocations: { ...state.itemLocations, [item.id]: target.id },
    },
    event: { type: "put", itemId: item.id, targetId: target.id },
    ok: true,
  };
}

// ---------- drop ----------

function drop(state: GameState, story: Story, itemId: string): ActionResult {
  const item = itemById(story, itemId);
  if (!item) {
    return { state, event: reject("unknown-item", { itemId }), ok: false };
  }
  if (state.itemLocations[item.id] !== PLAYER_ITEM_ID) {
    return { state, event: reject("not-carrying", { itemId: item.id }), ok: false };
  }
  const playerRoomId = currentRoomId(state, story);
  if (!playerRoomId) {
    return { state, event: reject("no-current-room"), ok: false };
  }
  return {
    state: {
      ...state,
      itemLocations: { ...state.itemLocations, [item.id]: playerRoomId },
    },
    event: { type: "dropped", itemId: item.id },
    ok: true,
  };
}

// ---------- inventory ----------

function inventory(state: GameState): ActionResult {
  return { state, event: { type: "inventoried" }, ok: true };
}

// ---------- go ----------

function go(state: GameState, story: Story, direction: string): ActionResult {
  const dir = direction.toLowerCase();
  const room = currentRoom(state, story);
  if (!room) {
    return { state, event: reject("no-current-room"), ok: false };
  }
  const exit = room.exits?.[dir];
  if (!exit) {
    return { state, event: reject("no-such-direction", { direction: dir }), ok: false };
  }
  const visible = visibleExits(room, state, story).find(([d]) => d === dir);
  if (!visible) {
    return { state, event: reject("no-such-direction", { direction: dir }), ok: false };
  }
  if (visible[1].blocked) {
    return {
      state,
      event: reject("exit-blocked", { direction: dir, message: visible[1].blockedMessage }),
      ok: false,
    };
  }
  const target = roomById(story, exit.to);
  if (!target) {
    return {
      state,
      event: reject("broken-exit-target", { direction: dir, message: exit.to }),
      ok: false,
    };
  }
  // Vehicle handling: if the player is inside a mobile vehicle, move the
  // vehicle to the new room — the player rides along via item parentage
  // (player.location === vehicle.id; vehicle.location moves; currentRoom
  // walks the chain and finds the new room). Stationary vehicles refuse.
  // On foot, just move the player.
  const vehicleId = playerVehicleId(state, story);
  let nextItemLocations: Record<string, string>;
  if (vehicleId !== null) {
    const vehicle = itemById(story, vehicleId);
    if (vehicle?.vehicle && !vehicle.vehicle.mobile) {
      return {
        state,
        event: reject("vehicle-stationary", {
          direction: dir,
          itemId: vehicle.id,
          message: vehicle.vehicle.enterBlockedMessage,
        }),
        ok: false,
      };
    }
    nextItemLocations = {
      ...state.itemLocations,
      [vehicleId]: exit.to,
    };
  } else {
    nextItemLocations = {
      ...state.itemLocations,
      [PLAYER_ITEM_ID]: exit.to,
    };
  }
  const visited = state.visitedRooms.includes(exit.to)
    ? state.visitedRooms
    : [...state.visitedRooms, exit.to];
  return {
    state: {
      ...state,
      visitedRooms: visited,
      itemLocations: nextItemLocations,
    },
    event: { type: "moved", from: room.id, to: exit.to, direction: dir },
    ok: true,
  };
}

// ---------- attack ----------
//
// Generic combat verb: declare "I attack THAT with THIS." The engine sets
// transient flags on state.flags and emits an `attacked` event — that's the
// entire engine combat surface. Story triggers gate on those flags and decide
// what damage/outcomes happen. Engine knows nothing about HP, statuses,
// weapon types, or outcome distributions.
//
// `mode` is an author-defined string (swing/throw/stab/etc.) that lets the
// same weapon produce different outcomes via different triggers. Defaults to
// "default" if the LLM omits it.
//
// Convention: combat triggers self-clean by setting attack-this-turn=false at
// the end of their effects. A story-wide cleanup trigger handles the case
// where no specific trigger matched.
function attack(
  state: GameState,
  story: Story,
  weaponId: string,
  targetId: string,
  mode: string | undefined,
): ActionResult {
  const weapon = itemById(story, weaponId);
  if (!weapon) {
    return { state, event: reject("unknown-item", { itemId: weaponId }), ok: false };
  }
  if (
    state.itemLocations[weapon.id] !== PLAYER_ITEM_ID &&
    !isItemAccessible(weapon, state, story)
  ) {
    return { state, event: reject("not-accessible", { itemId: weapon.id }), ok: false };
  }
  const target = itemById(story, targetId);
  if (!target) {
    return {
      state,
      event: reject("unknown-item", { itemId: targetId, targetId }),
      ok: false,
    };
  }
  if (!isItemAccessible(target, state, story)) {
    return {
      state,
      event: reject("not-accessible", { itemId: target.id, targetId: target.id }),
      ok: false,
    };
  }
  const resolvedMode = mode ?? "default";
  return {
    state: {
      ...state,
      flags: {
        ...state.flags,
        "attack-weapon": weaponId,
        "attack-target": targetId,
        "attack-mode": resolvedMode,
        "attack-this-turn": true,
      },
    },
    event: { type: "attacked", itemId: weaponId, targetId, mode: resolvedMode },
    ok: true,
  };
}

// ---------- recordIntent ----------
//
// Called by the LLM when the player's input semantically matches an active
// IntentSignal's prompt. Persists the match in state.matchedIntents so any
// `intentMatched` condition referencing the signal evaluates true thereafter.
// No-op if the signal is already matched (idempotent).

function recordIntent(
  state: GameState,
  story: Story,
  signalId: string,
  args?: Record<string, Atom>,
): ActionResult {
  // Look up the customTool. Unknown signalIds are rejected — defensive
  // against the LLM hallucinating a tool name.
  const customTool = story.customTools?.find((t) => t.id === signalId);
  if (!customTool) {
    return { state, event: reject("unknown-intent", { itemId: signalId }), ok: false };
  }
  // Store the call args (even on a duplicate match — new args supersede).
  // Shared mutator with built-in action recording so the matchedIntents
  // shape is identical across both paths.
  let nextState = applyMatchedIntent(state, signalId, args ?? {});
  const cues: string[] = [];

  // Run the handler if the tool declares one.
  if (customTool?.handler) {
    const callArgs = args ?? {};
    const handlerResult = runHandler(nextState, story, customTool.handler, callArgs);
    nextState = handlerResult.state;
    cues.push(...handlerResult.cues);
    // Precondition failure: the LLM's intent was technically matched, but the
    // handler refused to execute it. Remove the matched intent so per-target
    // triggers don't cascade on a "rejected" action (e.g. dam-bolt-bare-hands
    // firing after a "you don't have the wrench" precondition refusal).
    if (handlerResult.precondFailed) {
      nextState = {
        ...nextState,
        matchedIntents: nextState.matchedIntents.filter((id) => id !== signalId),
      };
      const { [signalId]: _removed, ...restArgs } = nextState.matchedIntentArgs;
      nextState = { ...nextState, matchedIntentArgs: restArgs };
    }
  }

  return {
    state: nextState,
    event: { type: "intent-recorded", signalId },
    ok: true,
    cues,
  };
}

// Run a tool handler: evaluate preconditions in order (first failure
// short-circuits with its failedNarration), then apply effects in order
// emitting successNarration. All Conditions/Effects are substituted with
// the call's args before evaluation/application.
function runHandler(
  state: GameState,
  story: Story,
  handler: import("../story/schema").ToolHandler,
  args: Record<string, Atom>,
): { state: GameState; cues: string[]; precondFailed?: boolean } {
  for (const pre of handler.preconditions ?? []) {
    const sub = substituteCondition(pre.when, args);
    if (sub === null) {
      // Substitution failed (missing arg). Skip this precondition — defensive.
      continue;
    }
    if (!evaluateCondition(sub, state, story)) {
      // Failure narration reads pre-effect state (no effects applied yet).
      return {
        state,
        cues: [renderHandlerTemplate(pre.failedNarration, args, story, state)],
        precondFailed: true,
      };
    }
  }

  let nextState = state;
  for (const eff of handler.effects ?? []) {
    const sub = substituteEffect(eff, args);
    if (sub === null) continue;
    // Pass story so setItemState/setPassageState can defensively skip when
    // the resolved id doesn't reference an item/passage (the dual-effect
    // pattern handlers use to target either kind).
    nextState = applyEffect(nextState, sub, story);
  }

  const cues: string[] = [];
  if (handler.successNarration) {
    // Success narration reads post-effect state, so {flag.score} reflects
    // the change just applied (e.g. +N after adjustFlag).
    cues.push(renderHandlerTemplate(handler.successNarration, args, story, nextState));
  }
  return { state: nextState, cues };
}

// Replace {arg.<name>.<field>} in handler templates. Supported fields for
// item args: name, id. Falls back to the raw arg value if the lookup fails.
// Local wrapper kept for the recordIntent handler call site. Just delegates
// to the shared renderer.
function renderHandlerTemplate(
  template: string,
  args: Record<string, Atom>,
  story: Story,
  state: GameState,
): string {
  return renderNarration(template, args, story, state);
}

// ---------- board ----------
//
// Enter a vehicle. The vehicle item must be accessible AND have a `vehicle`
// field AND its `enterableWhen` must evaluate true (or be absent). On success,
// the player item's location is set to the vehicle's id — player is now
// "inside" the vehicle in the same way contents are inside a container, and
// currentRoom() walks player → vehicle → room transparently.
//
// Note: this engine action validates entry but does NOT prevent boarding with
// weapons or other story-specific concerns. Authors gate that via post-board
// triggers (e.g. inVehicle + inventoryHasTag(weapon) → puncture).

function board(state: GameState, story: Story, itemId: string): ActionResult {
  const item = itemById(story, itemId);
  if (!item) {
    return { state, event: reject("unknown-item", { itemId }), ok: false };
  }
  if (!isItemAccessible(item, state, story)) {
    return { state, event: reject("not-accessible", { itemId: item.id }), ok: false };
  }
  if (!item.vehicle) {
    return { state, event: reject("not-enterable", { itemId: item.id }), ok: false };
  }
  if (item.vehicle.enterableWhen && !evaluateCondition(item.vehicle.enterableWhen, state, story)) {
    return {
      state,
      event: reject("vehicle-blocked", {
        itemId: item.id,
        message: item.vehicle.enterBlockedMessage,
      }),
      ok: false,
    };
  }
  return {
    state: {
      ...state,
      itemLocations: { ...state.itemLocations, [PLAYER_ITEM_ID]: item.id },
    },
    event: { type: "boarded", itemId: item.id },
    ok: true,
  };
}

// ---------- disembark ----------
//
// Exit the current vehicle. The player item moves from the vehicle (its
// parent) to the vehicle's current room — same room they were already
// transitively in, just one less layer of parentage. The vehicle stays where
// it is.

function disembark(state: GameState, story: Story): ActionResult {
  const vehicleId = playerVehicleId(state, story);
  if (vehicleId === null) {
    return { state, event: reject("not-in-vehicle"), ok: false };
  }
  // The vehicle's location should be a roomId. If for some reason it isn't
  // (e.g. nested vehicles, vehicle-in-NPC, or "nowhere"), bail to the
  // current room derived via the chain.
  const vehicleLoc = state.itemLocations[vehicleId];
  const targetRoom = vehicleLoc && roomById(story, vehicleLoc)
    ? vehicleLoc
    : currentRoomId(state, story);
  if (!targetRoom) {
    return { state, event: reject("no-current-room"), ok: false };
  }
  return {
    state: {
      ...state,
      itemLocations: { ...state.itemLocations, [PLAYER_ITEM_ID]: targetRoom },
    },
    event: { type: "disembarked", itemId: vehicleId },
    ok: true,
  };
}

// ---------- helpers ----------

function reject(
  reason: import("./events").RejectionReason,
  extras: { itemId?: string; targetId?: string; direction?: string; message?: string } = {},
): ActionEvent {
  const event: ActionEvent = { type: "rejected", reason };
  if (extras.itemId !== undefined) event.itemId = extras.itemId;
  if (extras.targetId !== undefined) event.targetId = extras.targetId;
  if (extras.direction !== undefined) event.direction = extras.direction;
  if (extras.message !== undefined) event.message = extras.message;
  return event;
}
