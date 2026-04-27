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

const SAVE_VERSION = 5;
const PREFIX = "lanterngames_save_v" + SAVE_VERSION + "_";

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
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!isValidSession(parsed, storyId)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearSession(storyId: string, slot: SaveSlot): void {
  try {
    localStorage.removeItem(key(storyId, slot));
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
  const roomId = session.engineState.playerLocation;
  const room = story.rooms.find((r) => r.id === roomId);
  const turnRaw = session.engineState.flags["global-turn-count"];
  const turnCount = typeof turnRaw === "number" ? turnRaw : 0;
  return {
    slot,
    savedAt: session.savedAt,
    roomName: room?.name ?? roomId,
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
