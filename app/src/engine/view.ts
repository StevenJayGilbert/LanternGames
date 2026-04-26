// WorldView: a structured snapshot of what the player can perceive right now.
// Built from current GameState + Story; carries everything the LLM (or dev
// renderer) needs to describe the scene without going back to the engine.
//
// Built by Engine.getView() and included in every EngineResult. The LLM
// receives event + view + cues each turn — so it always has fresh context
// regardless of which action was taken.

import type { Atom, GameState, Item, Passage, Story } from "../story/schema";
import {
  currentRoom,
  evaluateCondition,
  isContainerAccessible,
  itemById,
  itemsAccessibleHere,
  itemsInInventory,
  passagePresentation,
  passageSideHere,
  passagesHere,
  resolveRoomDescription,
  roomById,
  visibleExits,
} from "./state";

export interface ItemView {
  id: string;
  name: string;
  fixed?: boolean;          // true = scenery; not enumerated as "you see:"
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
  };
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
      passagesHere: [],
      exits: [],
      inventory: [],
      finished: state.finished,
    };
  }

  const description = resolveRoomDescription(room, state, story);
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

  return {
    room: { id: room.id, name: room.name, description },
    itemsHere,
    passagesHere: passages,
    exits,
    inventory,
    finished: state.finished,
  };
}

function toPassageView(passage: Passage, state: GameState, story: Story): PassageView {
  const presentation = passagePresentation(passage, state, story);
  // The other side of the passage — the room you'd reach by going through.
  const otherSide = passage.sides.find((s) => s.roomId !== state.playerLocation);
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

  // Glimpse: presence of an effective glimpse (side override > passage
  // default) declares that the passage is see-through. Its `when` condition
  // gates whether looking through is possible RIGHT NOW; if absent,
  // see-through is always available (windows, archways). For passages that
  // need state-based gating, authors set `when` explicitly. When satisfied,
  // the engine attaches the other room's name + description alongside any
  // author-provided text/prompt.
  const here = passageSideHere(passage, state);
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
