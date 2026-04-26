// WorldView: a structured snapshot of what the player can perceive right now.
// Built from current GameState + Story; carries everything the LLM (or dev
// renderer) needs to describe the scene without going back to the engine.
//
// Built by Engine.getView() and included in every EngineResult. The LLM
// receives event + view + cues each turn — so it always has fresh context
// regardless of which action was taken.

import type { Door, GameState, Item, Story } from "../story/schema";
import {
  currentRoom,
  doorPresentation,
  doorSideHere,
  doorsHere,
  evaluateCondition,
  itemById,
  itemsAccessibleHere,
  itemsInInventory,
  resolveRoomDescription,
  roomById,
  visibleExits,
} from "./state";

export interface ItemView {
  id: string;
  name: string;
  fixed?: boolean;          // true = scenery; not enumerated as "you see:"
  synonyms?: string[];      // helpful if the LLM needs to disambiguate
  adjectives?: string[];
  // Containment relation: if this item is inside another item, the parent's
  // id + name. Currently only "in" relation; "on" (surfaces) deferred to v0.2.
  containedIn?: { id: string; name: string; relation: "in" };
  // For container items, expose openable + current open state.
  container?: { openable: boolean; isOpen: boolean };
}

export interface ExitView {
  direction: string;
  targetRoomId: string;
  targetRoomName: string;
  blocked?: boolean;
  blockedMessage?: string;
  doorId?: string;          // if set, the exit traverses a door
}

export interface DoorView {
  id: string;
  name: string;             // resolved from current side + variants
  description: string;      // resolved from current side + variants
  isOpen: boolean;
  // The other room the door connects to, by id and name. Useful for narration
  // ("the door to the kitchen").
  connectsTo: { id: string; name: string };
  // Populated only when the effective glimpse's `when` condition holds (the
  // door is "see-through right now"). The LLM uses `otherRoom` (engine-
  // provided facts) plus optional `description` (canonical authored text) and
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
  };
  // All items the player can perceive — directly in the room AND inside any
  // open containers in the room. Items inside closed containers are omitted.
  // Each ItemView includes `containedIn` if it's nested inside another item,
  // so the LLM can narrate "the leaflet (inside the open mailbox)".
  itemsHere: ItemView[];
  // Doors visible from the current room (one of their two sides faces here).
  // Names/descriptions are pre-resolved to the player's side.
  doorsHere: DoorView[];
  exits: ExitView[];
  inventory: ItemView[];
  finished?: { won: boolean; message: string };
}

export function buildView(state: GameState, story: Story): WorldView {
  const room = currentRoom(state, story);
  if (!room) {
    return {
      room: {
        id: state.playerLocation,
        name: "(unknown)",
        description: "(no such room)",
      },
      itemsHere: [],
      doorsHere: [],
      exits: [],
      inventory: [],
      finished: state.finished,
    };
  }

  const description = resolveRoomDescription(room, state);
  const itemsHere = itemsAccessibleHere(state, story).map((i) =>
    toItemView(i, state, story),
  );
  const exits = visibleExits(room, state, story).map(([direction, info]) => {
    const target = roomById(story, info.to);
    const view: ExitView = {
      direction,
      targetRoomId: info.to,
      targetRoomName: target?.name ?? "(unknown)",
    };
    if (info.blocked) view.blocked = true;
    if (info.blockedMessage !== undefined) view.blockedMessage = info.blockedMessage;
    if (info.doorId !== undefined) view.doorId = info.doorId;
    return view;
  });
  const doors = doorsHere(state, story).map((d) => toDoorView(d, state, story));
  const inventory = itemsInInventory(state, story).map((i) =>
    toItemView(i, state, story),
  );

  return {
    room: { id: room.id, name: room.name, description },
    itemsHere,
    doorsHere: doors,
    exits,
    inventory,
    finished: state.finished,
  };
}

function toDoorView(door: Door, state: GameState, story: Story): DoorView {
  const presentation = doorPresentation(door, state);
  // The other side of the door — the room you'd reach by going through.
  const otherSide = door.sides.find((s) => s.roomId !== state.playerLocation);
  const otherRoom = otherSide ? roomById(story, otherSide.roomId) : undefined;
  const view: DoorView = {
    id: door.id,
    name: presentation.name,
    description: presentation.description,
    isOpen: state.doorOpen[door.id] ?? door.isOpen ?? false,
    connectsTo: {
      id: otherSide?.roomId ?? "(unknown)",
      name: otherRoom?.name ?? "(unknown)",
    },
  };

  // Glimpse: presence of an effective glimpse (side override > door default)
  // declares that the door is see-through. Its `when` condition gates whether
  // looking through is possible RIGHT NOW; if absent, see-through is always
  // available (windows, archways). For doors that need open-state gating,
  // authors set `when` explicitly. When satisfied, the engine attaches the
  // other room's name + description alongside any author-provided text/prompt.
  const here = doorSideHere(door, state);
  const effectiveGlimpse = here?.glimpse ?? door.glimpse;
  if (effectiveGlimpse && otherRoom) {
    const available = effectiveGlimpse.when
      ? evaluateCondition(effectiveGlimpse.when, state)
      : true;
    if (available) {
      view.glimpse = {
        otherRoom: {
          id: otherRoom.id,
          name: otherRoom.name,
          description: resolveRoomDescription(otherRoom, state),
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
  if (item.synonyms && item.synonyms.length > 0) view.synonyms = item.synonyms;
  if (item.adjectives && item.adjectives.length > 0) view.adjectives = item.adjectives;

  // Container state (if this item is itself a container)
  if (item.container) {
    const initialOpen = item.container.isOpen ?? false;
    view.container = {
      openable: item.container.openable ?? false,
      isOpen: state.containerOpen[item.id] ?? initialOpen,
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
