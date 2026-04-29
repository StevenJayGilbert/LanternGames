// WorldView: a structured snapshot of what the player can perceive right now.
// Built from current GameState + Story; carries everything the LLM (or dev
// renderer) needs to describe the scene without going back to the engine.
//
// Built by Engine.getView() and included in every EngineResult. The LLM
// receives event + view + cues each turn — so it always has fresh context
// regardless of which action was taken.

import type { Atom, GameState, Item, Passage, Story } from "../story/schema";
import { computeRank } from "./rank";
import {
  currentRoom,
  currentRoomId,
  evaluateCondition,
  isContainerAccessible,
  itemById,
  itemsAccessibleHere,
  itemsInInventory,
  passagePresentation,
  passageSideHere,
  passagesHere,
  PLAYER_ITEM_ID,
  playerVehicleId,
  resolveRoomDescription,
  roomById,
  visibleExits,
} from "./state";

export interface ItemView {
  id: string;
  name: string;
  fixed?: boolean;          // true = scenery; not enumerated as "you see:"
  // Author-defined classification labels carried through from Item.tags.
  // Surfaced so the LLM can describe the item in context (e.g. recognize
  // weapons, treasures, NPCs, food, light sources).
  tags?: string[];
  // LLM-facing voice/manner for NPCs and other speakable entities. Surfaced
  // so the LLM can voice dialogue / narrate this entity in character.
  personality?: string;
  // Engine-side narration guidance for the LLM. NOT flavor — never spoken
  // to the player. STYLE_INSTRUCTIONS calls this out explicitly.
  narratorNote?: string;
  // Current item state (e.g. { isOpen: true, broken: false }). Empty if the
  // item declares no state. The LLM uses this to narrate accurately and to
  // decide which intent signals to consider.
  state?: Record<string, Atom>;
  // Containment relation: if this item is inside another item, the parent's
  // id + name. Currently only "in" relation; "on" (surfaces) deferred to v0.2.
  containedIn?: { id: string; name: string; relation: "in" };
  // For container items: whether the inside is reachable right now (via
  // accessibleWhen). The LLM checks this before calling `put`.
  container?: {
    capacity?: number;
    accessible: boolean;
    accessBlockedMessage?: string;
  };
}

export interface ExitView {
  direction: string;
  targetRoomId: string;
  targetRoomName: string;
  blocked?: boolean;
  blockedMessage?: string;
  passageId?: string;       // if set, the exit traverses a passage
}

export interface PassageView {
  id: string;
  name: string;             // resolved from current side + variants
  description: string;      // resolved from current side + variants
  // Engine-side narration guidance — see ItemView.narratorNote.
  narratorNote?: string;
  // Current passage state (e.g. { isOpen: true }). Empty if the passage
  // declares no state. The LLM uses this to narrate accurately ("the door is
  // already open").
  state: Record<string, Atom>;
  // The other room the passage connects to, by id and name. Useful for
  // narration ("the door to the kitchen").
  connectsTo: { id: string; name: string };
  // Populated only when the effective glimpse's `when` condition holds (the
  // passage is "see-through right now"). The LLM uses `otherRoom` (engine
  // facts) plus optional `description` (canonical authored text) and
  // `prompt` (author-provided LLM guidance) to narrate the view through.
  glimpse?: {
    otherRoom: { id: string; name: string; description: string };
    description?: string;
    prompt?: string;
  };
}

export interface WorldView {
  room: {
    id: string;
    name: string;
    description: string;
    narratorNote?: string;     // engine-side narration guidance — see ItemView.narratorNote
  };
  // Scoring snapshot. Present only when the story declares `max-score` in its
  // startState (opt-in per story). Authors who use the scoring convention
  // (`score`, `max-score`, `global-turn-count` flags) get a tier name +
  // numbers the LLM can read for the canonical SCORE response.
  score?: { current: number; max: number; moves: number; rank: string };
  // All items the player can perceive — directly in the room AND inside any
  // open containers in the room. Items inside closed containers are omitted.
  // Each ItemView includes `containedIn` if it's nested inside another item,
  // so the LLM can narrate "the leaflet (inside the open mailbox)".
  itemsHere: ItemView[];
  // Passages visible from the current room (one of their two sides faces
  // here). Names/descriptions are pre-resolved to the player's side.
  passagesHere: PassageView[];
  exits: ExitView[];
  inventory: ItemView[];
  // Vehicle the player is currently inside (if any). Surfaces the LLM-facing
  // signal "you're not on foot, you're inside this thing" — vehicle.id is the
  // engine identifier, vehicle.name is the player-facing label. Items
  // contained AT the vehicle (location === vehicle.id) appear in itemsHere
  // with `containedIn` referencing the vehicle, so the LLM can narrate
  // "in the boat with you: a tan label".
  vehicle?: {
    id: string;
    name: string;
    description: string;
    mobile: boolean;
    state?: Record<string, Atom>;
  };
  finished?: { won: boolean; message: string };
}

export function buildView(state: GameState, story: Story): WorldView {
  const room = currentRoom(state, story);
  const vehicleId = playerVehicleId(state, story);
  if (!room) {
    return {
      room: {
        id: "(unknown)",
        name: "(unknown)",
        description: "(no such room)",
      },
      itemsHere: [],
      passagesHere: [],
      exits: [],
      inventory: [],
      finished: state.finished,
    };
  }

  const description = resolveRoomDescription(room, state, story);
  // Items accessible from the room (room floor + open containers there).
  const baseItemsHere = itemsAccessibleHere(state, story).map((i) =>
    toItemView(i, state, story),
  );
  // If the player is in a vehicle, items located AT the vehicle are also
  // perceivable — the LLM should see what's "in the boat with you".
  const vehicleContents =
    vehicleId !== null
      ? story.items
          .filter((i) => i.id !== PLAYER_ITEM_ID && state.itemLocations[i.id] === vehicleId)
          .map((i) => toItemView(i, state, story))
      : [];
  const itemsHere = [...baseItemsHere, ...vehicleContents];
  const exits = visibleExits(room, state, story).map(([direction, info]) => {
    const target = roomById(story, info.to);
    const view: ExitView = {
      direction,
      targetRoomId: info.to,
      targetRoomName: target?.name ?? "(unknown)",
    };
    if (info.blocked) view.blocked = true;
    if (info.blockedMessage !== undefined) view.blockedMessage = info.blockedMessage;
    if (info.passageId !== undefined) view.passageId = info.passageId;
    return view;
  });
  // passagesHere already applies the visibility filter (visibleWhen +
  // Story.defaultVisibility, both passage-level and per-side), so the same
  // hidden-passage rule applies to view AND examine.
  const passages = passagesHere(state, story).map((p) => toPassageView(p, state, story));
  const inventory = itemsInInventory(state, story).map((i) =>
    toItemView(i, state, story),
  );

  // Populate the vehicle field if player is currently inside one. The vehicle
  // item itself is at some room (state.itemLocations[vehicleId]) — usually the
  // current room since mobile vehicles travel with go(), but we don't enforce.
  let vehicleView: WorldView["vehicle"];
  if (vehicleId !== null) {
    const v = itemById(story, vehicleId);
    if (v?.vehicle) {
      vehicleView = {
        id: v.id,
        name: v.name,
        description: v.description,
        mobile: v.vehicle.mobile === true,
        ...(state.itemStates[v.id] && Object.keys(state.itemStates[v.id]).length > 0 && {
          state: { ...state.itemStates[v.id] },
        }),
      };
    }
  }

  // Score snapshot (opt-in: only present when the story declares max-score).
  let scoreView: WorldView["score"];
  const maxScore = state.flags["max-score"];
  if (typeof maxScore === "number") {
    const current = typeof state.flags["score"] === "number" ? (state.flags["score"] as number) : 0;
    const moves = typeof state.flags["global-turn-count"] === "number"
      ? (state.flags["global-turn-count"] as number)
      : 0;
    scoreView = { current, max: maxScore, moves, rank: computeRank(current) };
  }

  return {
    room: {
      id: room.id,
      name: room.name,
      description,
      ...(room.narratorNote && { narratorNote: room.narratorNote }),
    },
    itemsHere,
    passagesHere: passages,
    exits,
    inventory,
    ...(vehicleView && { vehicle: vehicleView }),
    ...(scoreView && { score: scoreView }),
    finished: state.finished,
  };
}

function toPassageView(passage: Passage, state: GameState, story: Story): PassageView {
  const presentation = passagePresentation(passage, state, story);
  // The other side of the passage — the room you'd reach by going through.
  const playerRoomId = currentRoomId(state, story);
  const otherSide = passage.sides.find((s) => s.roomId !== playerRoomId);
  const otherRoom = otherSide ? roomById(story, otherSide.roomId) : undefined;
  const view: PassageView = {
    id: passage.id,
    name: presentation.name,
    description: presentation.description,
    state: { ...(state.passageStates[passage.id] ?? {}) },
    connectsTo: {
      id: otherSide?.roomId ?? "(unknown)",
      name: otherRoom?.name ?? "(unknown)",
    },
  };
  if (passage.narratorNote) view.narratorNote = passage.narratorNote;

  // Glimpse: presence of an effective glimpse (side override > passage
  // default) declares that the passage is see-through. Its `when` condition
  // gates whether looking through is possible RIGHT NOW; if absent,
  // see-through is always available (windows, archways). For passages that
  // need state-based gating, authors set `when` explicitly. When satisfied,
  // the engine attaches the other room's name + description alongside any
  // author-provided text/prompt.
  const here = passageSideHere(passage, state, story);
  const effectiveGlimpse = here?.glimpse ?? passage.glimpse;
  if (effectiveGlimpse && otherRoom) {
    const available = effectiveGlimpse.when
      ? evaluateCondition(effectiveGlimpse.when, state, story)
      : true;
    if (available) {
      view.glimpse = {
        otherRoom: {
          id: otherRoom.id,
          name: otherRoom.name,
          description: resolveRoomDescription(otherRoom, state, story),
        },
        ...(effectiveGlimpse.description && { description: effectiveGlimpse.description }),
        ...(effectiveGlimpse.prompt && { prompt: effectiveGlimpse.prompt }),
      };
    }
  }

  return view;
}

function toItemView(item: Item, state: GameState, story: Story): ItemView {
  const view: ItemView = { id: item.id, name: item.name };
  if (item.fixed) view.fixed = true;
  if (item.tags && item.tags.length > 0) view.tags = item.tags;
  if (item.personality) view.personality = item.personality;
  if (item.narratorNote) view.narratorNote = item.narratorNote;

  const itemState = state.itemStates[item.id];
  if (itemState && Object.keys(itemState).length > 0) {
    view.state = { ...itemState };
  }

  if (item.container) {
    view.container = {
      ...(item.container.capacity !== undefined && { capacity: item.container.capacity }),
      accessible: isContainerAccessible(item, state, story),
      ...(item.container.accessBlockedMessage && {
        accessBlockedMessage: item.container.accessBlockedMessage,
      }),
    };
  }

  // Containment: if this item lives inside another item (parent in story.items)
  const loc = state.itemLocations[item.id];
  const parent = itemById(story, loc);
  if (parent) {
    view.containedIn = { id: parent.id, name: parent.name, relation: "in" };
  }

  return view;
}
