// Per-story save/restore via localStorage. Multi-slot:
//
//   "quick" slot   — auto-updated every successful turn. App auto-loads on
//                    boot. Closest analog to a console-game "auto-save."
//   slots 1..5     — manual snapshots. Only updated when the user clicks
//                    Save in the Save/Load dialog. Loading a manual slot
//                    forks play: quick-save tracks the new branch from the
//                    next turn onward; the manual slot stays pinned.
//
// Engine state and narrator conversation history are saved together —
// losing one without the other is jarring (you'd remember inventory but the
// LLM would have no memory of recent narration).
//
// localStorage is bounded (~5–10 MB per origin). Engine state is small (a few
// KB even for Zork I); narrator history grows linearly with turns. The
// Narrator already trims its own history, so save size stays bounded. Six
// slots × a couple stories ≈ 200 KB worst case.

import type { GameState, Story } from "../story/schema";
import type { Message } from "../llm/types";
import { currentRoomId, PLAYER_ITEM_ID } from "../engine/state";

// v6: GameState shape changed — playerLocation and playerVehicle removed,
// player tracked as a regular item under itemLocations["player"].
// v7: GameState gained two LLM-narration caches (lastAppearanceShown +
// lastExamineShown) for the per-turn item-description diff system. Purely
// additive — gameplay state is untouched. v6→v7 migration defaults both
// caches to {} on load.
const SAVE_VERSION = 7;
const LEGACY_SAVE_VERSION = 5;
const V6_SAVE_VERSION = 6;
const PREFIX = "lanterngames_save_v" + SAVE_VERSION + "_";
const LEGACY_PREFIX = "lanterngames_save_v" + LEGACY_SAVE_VERSION + "_";
const V6_PREFIX = "lanterngames_save_v" + V6_SAVE_VERSION + "_";

// Transcript entry types — shared between App.tsx (display) and localSave
// (persistence) so neither side has to redeclare or guess the shape.
export type EntryKind = "intro" | "player" | "narration" | "error" | "system";

export interface TranscriptEntry {
  kind: EntryKind;
  text: string;
}

export type SaveSlot = "quick" | 1 | 2 | 3 | 4 | 5;
export const MANUAL_SLOTS: ReadonlyArray<1 | 2 | 3 | 4 | 5> = [1, 2, 3, 4, 5];

interface SavedSession {
  version: number;
  storyId: string;
  engineState: GameState;
  narratorHistory: Message[];
  transcript: TranscriptEntry[];
  inputHistory: string[];
  savedAt: number;
}

function key(storyId: string, slot: SaveSlot): string {
  return PREFIX + storyId + "_" + (slot === "quick" ? "quick" : "slot" + slot);
}

// Pre-multi-slot key (single slot per story). Probed only by the migration
// helper; never written.
function legacyKey(storyId: string): string {
  return PREFIX + storyId;
}

export interface SaveOpts {
  storyId: string;
  slot: SaveSlot;
  engineState: GameState;
  narratorHistory: Message[];
  transcript: TranscriptEntry[];
  inputHistory: string[];
}

export function saveSession(opts: SaveOpts): void {
  try {
    const payload: SavedSession = {
      version: SAVE_VERSION,
      storyId: opts.storyId,
      engineState: opts.engineState,
      narratorHistory: opts.narratorHistory,
      transcript: opts.transcript,
      inputHistory: opts.inputHistory,
      savedAt: Date.now(),
    };
    localStorage.setItem(key(opts.storyId, opts.slot), JSON.stringify(payload));
  } catch {
    // Storage full / disabled — silently drop. Game continues to work.
  }
}

export function loadSession(storyId: string, slot: SaveSlot): SavedSession | null {
  try {
    const raw = localStorage.getItem(key(storyId, slot));
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (isValidSession(parsed, storyId)) return parsed;
    }
    // v6 fallback: try the v6 key. v6→v7 is purely additive (two new
    // narration caches) so the migration is just "fill in defaults."
    const v6Raw = localStorage.getItem(v6KeyForSlot(storyId, slot));
    if (v6Raw) {
      const migrated = migrateV6Session(JSON.parse(v6Raw) as unknown, storyId);
      if (migrated) {
        try {
          localStorage.setItem(key(storyId, slot), JSON.stringify(migrated));
          localStorage.removeItem(v6KeyForSlot(storyId, slot));
        } catch {
          // ignore write failures — migration retries next load
        }
        return migrated;
      }
    }
    // v5 fallback: try the legacy key. If found, migrate the shape on the
    // fly, then upgrade-in-place: write the migrated payload to the v7 key
    // and remove the v5 key so subsequent loads skip the migration step AND
    // a subsequent clearSession on the v7 key fully clears the slot. (Prior
    // versions left the v5 key behind, which made delete and "new game"
    // appear to do nothing — clearSession removed the current key but
    // loadSession would re-find and re-migrate the v5.)
    const legacyRaw = localStorage.getItem(legacyKeyForSlot(storyId, slot));
    if (legacyRaw) {
      const migrated = migrateV5Session(JSON.parse(legacyRaw) as unknown, storyId);
      if (migrated) {
        try {
          localStorage.setItem(key(storyId, slot), JSON.stringify(migrated));
          localStorage.removeItem(legacyKeyForSlot(storyId, slot));
        } catch {
          // If write fails (quota), still return the migrated session — the
          // game keeps working, the migration just retries next load.
        }
        return migrated;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// v6 → v7 migration. Purely additive: v7 introduced two new narration
// caches (lastAppearanceShown, lastExamineShown) on GameState. Defaulting
// both to {} on load is harmless — the LLM may briefly re-narrate items as
// "first seen," then converges within a turn or two.
function migrateV6Session(v: unknown, storyId: string): SavedSession | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (r.version !== V6_SAVE_VERSION) return null;
  if (r.storyId !== storyId) return null;
  if (!r.engineState || typeof r.engineState !== "object") return null;
  const es = r.engineState as Record<string, unknown>;
  const migratedEngineState = {
    ...es,
    lastAppearanceShown: (es.lastAppearanceShown as Record<string, string> | undefined) ?? {},
    lastExamineShown: (es.lastExamineShown as Record<string, string> | undefined) ?? {},
  } as GameState;
  return {
    version: SAVE_VERSION,
    storyId,
    engineState: migratedEngineState,
    narratorHistory: Array.isArray(r.narratorHistory) ? (r.narratorHistory as Message[]) : [],
    transcript: Array.isArray(r.transcript) ? (r.transcript as TranscriptEntry[]) : [],
    inputHistory: Array.isArray(r.inputHistory) ? (r.inputHistory as string[]) : [],
    savedAt: typeof r.savedAt === "number" ? r.savedAt : Date.now(),
  };
}

// v5 → v6 in-memory migration. Translates legacy GameState shape (with
// playerLocation + playerVehicle) into the new shape (player as item under
// itemLocations). Returns null if the input doesn't look like a v5 session.
function migrateV5Session(v: unknown, storyId: string): SavedSession | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (r.version !== LEGACY_SAVE_VERSION) return null;
  if (r.storyId !== storyId) return null;
  if (!r.engineState || typeof r.engineState !== "object") return null;
  const es = r.engineState as Record<string, unknown>;
  const playerLocation = typeof es.playerLocation === "string" ? es.playerLocation : null;
  const playerVehicle = typeof es.playerVehicle === "string" ? es.playerVehicle : null;
  const itemLocations = (es.itemLocations as Record<string, string> | undefined) ?? {};
  // Player is "in" the vehicle if one was set, else at the saved room.
  const playerLoc = playerVehicle ?? playerLocation;
  if (!playerLoc) return null;
  // Strip playerLocation/playerVehicle from the engineState; add the player
  // item to itemLocations. Old "inventory" magic strings are normalized at
  // engine load by initialState — but saves snapshot post-init state, so any
  // items at "inventory" need flipping to "player" too.
  const nextItemLocations: Record<string, string> = { ...itemLocations };
  for (const [id, loc] of Object.entries(nextItemLocations)) {
    if (loc === "inventory") nextItemLocations[id] = PLAYER_ITEM_ID;
  }
  nextItemLocations[PLAYER_ITEM_ID] = playerLoc;
  const { playerLocation: _pl, playerVehicle: _pv, itemLocations: _il, ...rest } = es;
  // Backfill the v7-era narration caches alongside the v5→v6 player-as-item
  // shape change. v5 saves jump straight to v7 in one migration step.
  const migratedEngineState = {
    ...rest,
    itemLocations: nextItemLocations,
    lastAppearanceShown: (rest.lastAppearanceShown as Record<string, string> | undefined) ?? {},
    lastExamineShown: (rest.lastExamineShown as Record<string, string> | undefined) ?? {},
  } as GameState;
  const out: SavedSession = {
    version: SAVE_VERSION,
    storyId,
    engineState: migratedEngineState,
    narratorHistory: Array.isArray(r.narratorHistory) ? (r.narratorHistory as Message[]) : [],
    transcript: Array.isArray(r.transcript) ? (r.transcript as TranscriptEntry[]) : [],
    inputHistory: Array.isArray(r.inputHistory) ? (r.inputHistory as string[]) : [],
    savedAt: typeof r.savedAt === "number" ? r.savedAt : Date.now(),
  };
  return out;
}

function legacyKeyForSlot(storyId: string, slot: SaveSlot): string {
  return LEGACY_PREFIX + storyId + "_" + (slot === "quick" ? "quick" : "slot" + slot);
}

function v6KeyForSlot(storyId: string, slot: SaveSlot): string {
  return V6_PREFIX + storyId + "_" + (slot === "quick" ? "quick" : "slot" + slot);
}

export function clearSession(storyId: string, slot: SaveSlot): void {
  try {
    localStorage.removeItem(key(storyId, slot));
    // Defensive: remove all older-version keys for this slot too. If any
    // lingered, loadSession would migrate-and-restore them on the next read,
    // and the user would see the slot "uncleared" / the LLM would resurrect
    // old narration history after a "new game".
    localStorage.removeItem(v6KeyForSlot(storyId, slot));
    localStorage.removeItem(legacyKeyForSlot(storyId, slot));
  } catch {
    // ignore
  }
}

function isValidSession(v: unknown, storyId: string): v is SavedSession {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    r.version === SAVE_VERSION &&
    r.storyId === storyId &&
    !!r.engineState &&
    typeof r.engineState === "object" &&
    Array.isArray(r.narratorHistory) &&
    Array.isArray(r.transcript) &&
    Array.isArray(r.inputHistory)
  );
}

// One-time migration from the pre-multi-slot key layout. If the legacy
// `lanterngames_save_v5_<storyId>` key exists, copy its payload into both
// the quick slot AND slot 1 (so existing players see their game on resume
// AND have it pinned as a milestone), then delete the legacy key.
//
// Idempotent: if the legacy key is absent, this is a no-op. Safe to call
// on every boot.
export function migrateLegacySaveToSlots(storyId: string): void {
  try {
    const raw = localStorage.getItem(legacyKey(storyId));
    if (!raw) return;
    // Only migrate if quick is currently empty (don't clobber newer play).
    const quickPresent = !!localStorage.getItem(key(storyId, "quick"));
    if (!quickPresent) localStorage.setItem(key(storyId, "quick"), raw);
    const slot1Present = !!localStorage.getItem(key(storyId, 1));
    if (!slot1Present) localStorage.setItem(key(storyId, 1), raw);
    localStorage.removeItem(legacyKey(storyId));
  } catch {
    // ignore
  }
}

// Per-slot summary for the Save/Load UI. Resolves the room name via the
// story so the UI doesn't have to know the engine internals.
export interface SlotSummary {
  slot: SaveSlot;
  savedAt: number;
  roomName: string;
  turnCount: number;
}

function summarize(session: SavedSession, slot: SaveSlot, story: Story): SlotSummary {
  const roomId = currentRoomId(session.engineState, story);
  const room = roomId ? story.rooms.find((r) => r.id === roomId) : undefined;
  const turnRaw = session.engineState.flags["global-turn-count"];
  const turnCount = typeof turnRaw === "number" ? turnRaw : 0;
  return {
    slot,
    savedAt: session.savedAt,
    roomName: room?.name ?? roomId ?? "(unknown)",
    turnCount,
  };
}

export function listSlotSummaries(story: Story): {
  quick: SlotSummary | null;
  manual: (SlotSummary | null)[];
} {
  const quickSession = loadSession(story.id, "quick");
  return {
    quick: quickSession ? summarize(quickSession, "quick", story) : null,
    manual: MANUAL_SLOTS.map((n) => {
      const s = loadSession(story.id, n);
      return s ? summarize(s, n, story) : null;
    }),
  };
}
