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
// lastExamineShown) for the per-turn item-description diff system.
// v8: Both caches removed — narration-staleness now handled by the
// Narrator's view-string fingerprint (in-memory, not persisted).
// examinedItems (which already existed) is now the sole gate for whether
// ItemView.description is included.
// v9: Backfills new state fields added to story data after v8 shipped:
//   - itemStates.match: matchesRemaining (default 5), isLit (false; was matchBurning pre-v10)
//   - itemStates.bell: rangAtHades (false)
//   - flags["match-burn-countdown"] (default 0)
// Old saves without these fields had the LLD ritual immediately broken
// ("matchbook is empty" on the first light-match attempt because missing
// numeric state evaluates as 0). Migration is purely additive — saved
// values win where present; missing keys get the defaults.
// v10: Harmonizes lit-state key names so the new generic light/extinguish
// customTools can target match, candles, lamp, and torch uniformly:
//   - itemStates.match.matchBurning → itemStates.match.isLit (rename, value preserved)
//   - itemStates.torch.isLit defaults to true (canonical: torch starts lit)
// v11: Adds the canonical candle burn-time mechanic (mirrors the lamp's
// battery model). New tick triggers drain candles each turn while lit.
//   - itemStates.candles.burnTurnsRemaining defaults to 230 (canonical Zork CANDLES-FUSE)
// v12: Inventory weight mechanic.
//   - flags["max-carry-weight"] defaults to 100 (canonical Zork I LOAD-MAX)
//   - itemStates[id].weight backfilled per Zork I SIZE values for each
//     takeable item.
// v13: Adds the canonical "tan label" item (attached to the magic boat's
// valve). The item exists in story-data with location "nowhere"; the
// boat-inflates trigger moves it onto the boat on first inflation. Old
// saves had no entry for it under itemLocations, so the trigger's
// itemAt(tan-label, "nowhere") guard never fired.
//   - itemLocations["tan-label"] defaults to "nowhere"
// v14: Tan-label refactored to live inside the boat from game-start. Boat
// gains a container.accessibleWhen gate so the label is hidden when
// deflated and visible when inflated. The boat-inflates trigger no longer
// moves the label. Old saves with the label at "nowhere" (never inflated
// the boat) get the label seeded to "inflatable-boat"; saves where the
// player already inflated the boat have the label at "inflatable-boat"
// already and nothing changes.
//   - itemLocations["tan-label"]: "nowhere" → "inflatable-boat" (only when
//     currently "nowhere"; preserves any other placement)
// v15: Canonical Zork 3-life soft-death mechanic. Three new flags drive
// the central process-death trigger; previously-fatal triggers no longer
// hard-end on first hit but instead drop items, respawn at forest-1, and
// hard-end only on the third death.
//   - flags.deaths defaults to 0
//   - flags.just-died defaults to false
//   - flags.death-message defaults to ""
// v16: Egg-puzzle flavor pass — egg + canary gain a state.broken key so
// the new force/break triggers (which gate on itemState(broken, equals:
// false)) fire correctly. Also seals the broken egg's contents (gated
// access via container.accessibleWhen now requires not-broken).
//   - itemStates.egg.broken defaults to false
//   - itemStates.canary.broken defaults to false
// v17: Reasserts the v16 egg/canary broken backfill for v16 saves that
// were written from fresh-game state (where initialState() didn't seed
// the broken key — the egg/canary item.state blocks omitted it). The
// backfill function (applyV16Backfill) is idempotent: it spreads
// existing state over { broken: false }, so v16 saves that already had
// broken set are unaffected; saves missing the key get it seeded.
// Pairs with: egg + canary item.state now declare broken: false in
// zork-1.overrides.json, fixing fresh games structurally; trigger
// gates moved from itemState(broken, equals: false) to
// not(itemState(broken, equals: true)) for undefined-tolerance.
const SAVE_VERSION = 17;
const LEGACY_SAVE_VERSION = 5;
const V6_SAVE_VERSION = 6;
const V7_SAVE_VERSION = 7;
const V8_SAVE_VERSION = 8;
const V9_SAVE_VERSION = 9;
const V10_SAVE_VERSION = 10;
const V11_SAVE_VERSION = 11;
const V12_SAVE_VERSION = 12;
const V13_SAVE_VERSION = 13;
const V14_SAVE_VERSION = 14;
const V15_SAVE_VERSION = 15;
const V16_SAVE_VERSION = 16;
const PREFIX = "lanterngames_save_v" + SAVE_VERSION + "_";
const LEGACY_PREFIX = "lanterngames_save_v" + LEGACY_SAVE_VERSION + "_";
const V6_PREFIX = "lanterngames_save_v" + V6_SAVE_VERSION + "_";
const V7_PREFIX = "lanterngames_save_v" + V7_SAVE_VERSION + "_";
const V8_PREFIX = "lanterngames_save_v" + V8_SAVE_VERSION + "_";
const V9_PREFIX = "lanterngames_save_v" + V9_SAVE_VERSION + "_";
const V10_PREFIX = "lanterngames_save_v" + V10_SAVE_VERSION + "_";
const V11_PREFIX = "lanterngames_save_v" + V11_SAVE_VERSION + "_";
const V12_PREFIX = "lanterngames_save_v" + V12_SAVE_VERSION + "_";
const V13_PREFIX = "lanterngames_save_v" + V13_SAVE_VERSION + "_";
const V14_PREFIX = "lanterngames_save_v" + V14_SAVE_VERSION + "_";
const V15_PREFIX = "lanterngames_save_v" + V15_SAVE_VERSION + "_";
const V16_PREFIX = "lanterngames_save_v" + V16_SAVE_VERSION + "_";

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
    // v16 fallback: try the v16 key. v16→v17 reasserts the egg/canary
    // broken backfill for saves written from fresh-game state where the
    // broken key was never seeded (initialState() only mirrored item.state,
    // and the egg/canary state blocks omitted broken until v17). Idempotent
    // for saves that already have broken set.
    const v16Raw = localStorage.getItem(v16KeyForSlot(storyId, slot));
    if (v16Raw) {
      const migrated = migrateV16Session(JSON.parse(v16Raw) as unknown, storyId);
      if (migrated) {
        try {
          localStorage.setItem(key(storyId, slot), JSON.stringify(migrated));
          localStorage.removeItem(v16KeyForSlot(storyId, slot));
        } catch {
          // ignore write failures — migration retries next load
        }
        return migrated;
      }
    }
    // v15 fallback: try the v15 key. v15→v17 seeds itemStates.egg.broken
    // and itemStates.canary.broken so the egg-puzzle force/break triggers
    // fire on previously-saved games.
    const v15Raw = localStorage.getItem(v15KeyForSlot(storyId, slot));
    if (v15Raw) {
      const migrated = migrateV15Session(JSON.parse(v15Raw) as unknown, storyId);
      if (migrated) {
        try {
          localStorage.setItem(key(storyId, slot), JSON.stringify(migrated));
          localStorage.removeItem(v15KeyForSlot(storyId, slot));
        } catch {
          // ignore write failures — migration retries next load
        }
        return migrated;
      }
    }
    // v14 fallback: try the v14 key. v14→v16 seeds the three death-mechanic
    // flags + the v16 egg/canary broken backfill (cumulative).
    const v14Raw = localStorage.getItem(v14KeyForSlot(storyId, slot));
    if (v14Raw) {
      const migrated = migrateV14Session(JSON.parse(v14Raw) as unknown, storyId);
      if (migrated) {
        try {
          localStorage.setItem(key(storyId, slot), JSON.stringify(migrated));
          localStorage.removeItem(v14KeyForSlot(storyId, slot));
        } catch {
          // ignore write failures — migration retries next load
        }
        return migrated;
      }
    }
    // v13 fallback: try the v13 key. v13→v15 reseats the tan-label inside
    // the boat (boat now exposes contents via container.accessibleWhen
    // gated on inflation, replacing the v13 first-inflation move trigger)
    // and seeds the v15 death-mechanic flags.
    const v13Raw = localStorage.getItem(v13KeyForSlot(storyId, slot));
    if (v13Raw) {
      const migrated = migrateV13Session(JSON.parse(v13Raw) as unknown, storyId);
      if (migrated) {
        try {
          localStorage.setItem(key(storyId, slot), JSON.stringify(migrated));
          localStorage.removeItem(v13KeyForSlot(storyId, slot));
        } catch {
          // ignore write failures — migration retries next load
        }
        return migrated;
      }
    }
    // v12 fallback: try the v12 key. v12→v14 backfills tan-label inside
    // the boat for the new container-gated label perception.
    const v12Raw = localStorage.getItem(v12KeyForSlot(storyId, slot));
    if (v12Raw) {
      const migrated = migrateV12Session(JSON.parse(v12Raw) as unknown, storyId);
      if (migrated) {
        try {
          localStorage.setItem(key(storyId, slot), JSON.stringify(migrated));
          localStorage.removeItem(v12KeyForSlot(storyId, slot));
        } catch {
          // ignore write failures — migration retries next load
        }
        return migrated;
      }
    }
    // v11 fallback: try the v11 key. v11→v13 backfills max-carry-weight=100,
    // per-item state.weight, and the tan-label location.
    const v11Raw = localStorage.getItem(v11KeyForSlot(storyId, slot));
    if (v11Raw) {
      const migrated = migrateV11Session(JSON.parse(v11Raw) as unknown, storyId);
      if (migrated) {
        try {
          localStorage.setItem(key(storyId, slot), JSON.stringify(migrated));
          localStorage.removeItem(v11KeyForSlot(storyId, slot));
        } catch {
          // ignore write failures — migration retries next load
        }
        return migrated;
      }
    }
    // v10 fallback: try the v10 key. v10→v11 adds candles.burnTurnsRemaining=230
    // for the canonical candle burn-time mechanic.
    const v10Raw = localStorage.getItem(v10KeyForSlot(storyId, slot));
    if (v10Raw) {
      const migrated = migrateV10Session(JSON.parse(v10Raw) as unknown, storyId);
      if (migrated) {
        try {
          localStorage.setItem(key(storyId, slot), JSON.stringify(migrated));
          localStorage.removeItem(v10KeyForSlot(storyId, slot));
        } catch {
          // ignore write failures — migration retries next load
        }
        return migrated;
      }
    }
    // v9 fallback: try the v9 key. v9→v11 renames match.matchBurning →
    // match.isLit, adds torch.isLit=true, and adds candles.burnTurnsRemaining.
    const v9Raw = localStorage.getItem(v9KeyForSlot(storyId, slot));
    if (v9Raw) {
      const migrated = migrateV9Session(JSON.parse(v9Raw) as unknown, storyId);
      if (migrated) {
        try {
          localStorage.setItem(key(storyId, slot), JSON.stringify(migrated));
          localStorage.removeItem(v9KeyForSlot(storyId, slot));
        } catch {
          // ignore write failures — migration retries next load
        }
        return migrated;
      }
    }
    // v8 fallback: try the v8 key. v8→v11 backfills the new match/bell state
    // fields, the match-burn-countdown flag, the lit-state harmonization,
    // and the torch.isLit init (gameplay state untouched beyond defaults).
    const v8Raw = localStorage.getItem(v8KeyForSlot(storyId, slot));
    if (v8Raw) {
      const migrated = migrateV8Session(JSON.parse(v8Raw) as unknown, storyId);
      if (migrated) {
        try {
          localStorage.setItem(key(storyId, slot), JSON.stringify(migrated));
          localStorage.removeItem(v8KeyForSlot(storyId, slot));
        } catch {
          // ignore write failures — migration retries next load
        }
        return migrated;
      }
    }
    // v7 fallback: try the v7 key. v7→v9 strips the two now-removed narration
    // caches AND applies the v8→v9 backfill so v7 saves land at v9 directly.
    const v7Raw = localStorage.getItem(v7KeyForSlot(storyId, slot));
    if (v7Raw) {
      const migrated = migrateV7Session(JSON.parse(v7Raw) as unknown, storyId);
      if (migrated) {
        try {
          localStorage.setItem(key(storyId, slot), JSON.stringify(migrated));
          localStorage.removeItem(v7KeyForSlot(storyId, slot));
        } catch {
          // ignore write failures — migration retries next load
        }
        return migrated;
      }
    }
    // v6 fallback: try the v6 key. v6→v8 is purely additive on gameplay
    // state — just upgrade the version stamp; no field changes needed.
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

// Cumulative v8 → v14 backfill. Applies all state-shape changes accumulated
// after v8 shipped, so any earlier-version migration can chain through this
// to land at the current SAVE_VERSION.
//
// v9 additions (kept here to avoid splitting backfills):
//   - itemStates.match.matchesRemaining (5)
//   - itemStates.bell.rangAtHades (false)
//   - flags["match-burn-countdown"] (0)
//
// v10 additions:
//   - itemStates.match.isLit (renamed from matchBurning; value preserved)
//   - itemStates.torch.isLit (default true — canonical: torch starts lit)
//
// v11 additions:
//   - itemStates.candles.burnTurnsRemaining (default 230 — canonical CANDLES-FUSE)
//
// v12 additions:
//   - flags["max-carry-weight"] (default 100 — canonical Zork I LOAD-MAX)
//   - itemStates[id].weight for each takeable item (per zork-1.overrides
//     state.weight values; matches the canonical Zork I SIZE properties)
//
// v13 additions:
//   - itemLocations["tan-label"] (default "nowhere" — boat-inflates trigger
//     moves it onto the boat on first inflation)
//
// v14 additions:
//   - itemLocations["tan-label"]: "nowhere" → "inflatable-boat" — the label
//     now lives inside the boat from game-start; the boat's container
//     accessibleWhen gate keeps it hidden until inflation. Saves where the
//     label was already moved to "inflatable-boat" (player inflated on v13)
//     are preserved; only the default-"nowhere" case gets reseated.
//
// v15 additions:
//   - flags.deaths (default 0)
//   - flags.just-died (default false)
//   - flags.death-message (default "")
// Drives the central process-death trigger introduced this version; old
// saves get the three flags seeded so any subsequent fatal event triggers
// the soft-death flow instead of dangling on undefined state.
//
// v16 additions:
//   - itemStates.egg.broken (default false)
//   - itemStates.canary.broken (default false)
// The egg-puzzle flavor pass added force/break triggers that gate on
// itemState(broken, equals: false). Without the backfill, old saves
// (which lack the broken key) silently fail the gate (undefined !== false)
// and the triggers never fire.
//
// Saved values win where present; missing keys get the defaults.
function applyV16Backfill(es: Record<string, unknown>): Record<string, unknown> {
  const itemStates = (es.itemStates as Record<string, Record<string, unknown>> | undefined) ?? {};
  const flags = (es.flags as Record<string, unknown> | undefined) ?? {};
  const itemLocations = (es.itemLocations as Record<string, unknown> | undefined) ?? {};
  const migratedItemStates: Record<string, Record<string, unknown>> = { ...itemStates };

  const matchPrev = itemStates["match"] ?? {};
  const inheritedIsLit = "isLit" in matchPrev
    ? matchPrev["isLit"]
    : ("matchBurning" in matchPrev ? matchPrev["matchBurning"] : false);
  const matchNext: Record<string, unknown> = {
    matchesRemaining: 5,
    ...matchPrev,
    isLit: inheritedIsLit,
  };
  delete matchNext["matchBurning"];
  migratedItemStates["match"] = matchNext;

  migratedItemStates["bell"] = {
    rangAtHades: false,
    ...itemStates["bell"],
  };
  migratedItemStates["torch"] = {
    isLit: true,
    ...itemStates["torch"],
  };
  migratedItemStates["candles"] = {
    burnTurnsRemaining: 230,
    ...itemStates["candles"],
  };
  // v16: egg + canary gain state.broken so the egg-puzzle force/break
  // triggers fire on old saves.
  migratedItemStates["egg"] = {
    broken: false,
    ...itemStates["egg"],
  };
  migratedItemStates["canary"] = {
    broken: false,
    ...itemStates["canary"],
  };

  // v12: per-item weight backfill (Zork I canonical SIZE values).
  // Applied only to items that don't already have a weight set, so saved
  // adjustments survive. Items not listed here weren't takeable as of v12;
  // adding new items in future versions should bump the migration ladder.
  const ZORK_WEIGHTS: Record<string, number> = {
    lamp: 15, "burned-out-lantern": 20, match: 1, candles: 5, torch: 25,
    screwdriver: 5, wrench: 10, pump: 10, shovel: 15, rope: 10, timbers: 50,
    "inflatable-boat": 20, tube: 4, putty: 6, leaves: 25,
    sword: 30, axe: 25, knife: 10, "rusty-knife": 10, stiletto: 10,
    bottle: 9, water: 4, "bag-of-coins": 15, "sandwich-bag": 9, lunch: 9,
    garlic: 4, nest: 4, book: 10, map: 5, guide: 5, advertisement: 2,
    "owners-manual": 5, coal: 15, keys: 10,
    bell: 10, chalice: 10, coffin: 55, emerald: 6, bracelet: 5, jade: 10,
    skull: 10, bar: 20, "pot-of-gold": 15, painting: 15, sceptre: 3,
    trident: 12, trunk: 35, scarab: 7, egg: 6, buoy: 8, diamond: 25,
    canary: 3, bauble: 8,
  };
  for (const [id, weight] of Object.entries(ZORK_WEIGHTS)) {
    const prev = migratedItemStates[id] ?? {};
    if (prev.weight === undefined) {
      migratedItemStates[id] = { ...prev, weight };
    }
  }

  const migratedFlags: Record<string, unknown> = {
    "match-burn-countdown": 0,
    "max-carry-weight": 100,
    "deaths": 0,
    "just-died": false,
    "death-message": "",
    ...flags,
  };

  // v14: tan-label lives inside the boat from game-start. Old saves either
  // (a) never had the label seeded — set it to inflatable-boat so the
  // container.accessibleWhen gate reveals it on inflation; or (b) had the
  // label at "nowhere" because the v13 boat-inflates trigger never fired —
  // also seat it inside the boat. Saves where the player already inflated
  // (label at "inflatable-boat") or moved it elsewhere are preserved.
  const existingLabelLoc = itemLocations["tan-label"];
  const migratedItemLocations: Record<string, unknown> = {
    ...itemLocations,
    "tan-label":
      existingLabelLoc === undefined || existingLabelLoc === "nowhere"
        ? "inflatable-boat"
        : existingLabelLoc,
  };
  return {
    ...es,
    itemStates: migratedItemStates,
    flags: migratedFlags,
    itemLocations: migratedItemLocations,
  };
}

// v16 → v17 migration. Reseats itemStates.egg.broken and
// itemStates.canary.broken for v16 saves written from fresh-game state
// (where the broken key was never seeded — the egg/canary item.state
// blocks omitted it). applyV16Backfill is idempotent on the broken
// fields: existing values win via spread; missing keys get false.
function migrateV16Session(v: unknown, storyId: string): SavedSession | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (r.version !== V16_SAVE_VERSION) return null;
  if (r.storyId !== storyId) return null;
  if (!r.engineState || typeof r.engineState !== "object") return null;
  const es = r.engineState as Record<string, unknown>;
  return {
    version: SAVE_VERSION,
    storyId,
    engineState: applyV16Backfill(es) as unknown as GameState,
    narratorHistory: Array.isArray(r.narratorHistory) ? (r.narratorHistory as Message[]) : [],
    transcript: Array.isArray(r.transcript) ? (r.transcript as TranscriptEntry[]) : [],
    inputHistory: Array.isArray(r.inputHistory) ? (r.inputHistory as string[]) : [],
    savedAt: typeof r.savedAt === "number" ? r.savedAt : Date.now(),
  };
}

// v15 → v17 migration. Seeds itemStates.egg.broken=false +
// itemStates.canary.broken=false so the egg-puzzle force/break triggers
// fire on loaded v15 saves.
function migrateV15Session(v: unknown, storyId: string): SavedSession | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (r.version !== V15_SAVE_VERSION) return null;
  if (r.storyId !== storyId) return null;
  if (!r.engineState || typeof r.engineState !== "object") return null;
  const es = r.engineState as Record<string, unknown>;
  return {
    version: SAVE_VERSION,
    storyId,
    engineState: applyV16Backfill(es) as unknown as GameState,
    narratorHistory: Array.isArray(r.narratorHistory) ? (r.narratorHistory as Message[]) : [],
    transcript: Array.isArray(r.transcript) ? (r.transcript as TranscriptEntry[]) : [],
    inputHistory: Array.isArray(r.inputHistory) ? (r.inputHistory as string[]) : [],
    savedAt: typeof r.savedAt === "number" ? r.savedAt : Date.now(),
  };
}

// v14 → v16 migration. Seeds the three death-mechanic flags
// (deaths=0, just-died=false, death-message="") plus the v16 egg/canary
// broken backfill via applyV16Backfill (cumulative).
function migrateV14Session(v: unknown, storyId: string): SavedSession | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (r.version !== V14_SAVE_VERSION) return null;
  if (r.storyId !== storyId) return null;
  if (!r.engineState || typeof r.engineState !== "object") return null;
  const es = r.engineState as Record<string, unknown>;
  return {
    version: SAVE_VERSION,
    storyId,
    engineState: applyV16Backfill(es) as unknown as GameState,
    narratorHistory: Array.isArray(r.narratorHistory) ? (r.narratorHistory as Message[]) : [],
    transcript: Array.isArray(r.transcript) ? (r.transcript as TranscriptEntry[]) : [],
    inputHistory: Array.isArray(r.inputHistory) ? (r.inputHistory as string[]) : [],
    savedAt: typeof r.savedAt === "number" ? r.savedAt : Date.now(),
  };
}

// v13 → v15 migration. Reseats the tan-label inside the boat for the new
// container-gated label perception, plus the v15 death-mechanic flags.
function migrateV13Session(v: unknown, storyId: string): SavedSession | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (r.version !== V13_SAVE_VERSION) return null;
  if (r.storyId !== storyId) return null;
  if (!r.engineState || typeof r.engineState !== "object") return null;
  const es = r.engineState as Record<string, unknown>;
  return {
    version: SAVE_VERSION,
    storyId,
    engineState: applyV16Backfill(es) as unknown as GameState,
    narratorHistory: Array.isArray(r.narratorHistory) ? (r.narratorHistory as Message[]) : [],
    transcript: Array.isArray(r.transcript) ? (r.transcript as TranscriptEntry[]) : [],
    inputHistory: Array.isArray(r.inputHistory) ? (r.inputHistory as string[]) : [],
    savedAt: typeof r.savedAt === "number" ? r.savedAt : Date.now(),
  };
}

// v12 → v14 migration. Same as the v13 migration plus the v13 backfill —
// applyV16Backfill chains all prior backfills.
function migrateV12Session(v: unknown, storyId: string): SavedSession | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (r.version !== V12_SAVE_VERSION) return null;
  if (r.storyId !== storyId) return null;
  if (!r.engineState || typeof r.engineState !== "object") return null;
  const es = r.engineState as Record<string, unknown>;
  return {
    version: SAVE_VERSION,
    storyId,
    engineState: applyV16Backfill(es) as unknown as GameState,
    narratorHistory: Array.isArray(r.narratorHistory) ? (r.narratorHistory as Message[]) : [],
    transcript: Array.isArray(r.transcript) ? (r.transcript as TranscriptEntry[]) : [],
    inputHistory: Array.isArray(r.inputHistory) ? (r.inputHistory as string[]) : [],
    savedAt: typeof r.savedAt === "number" ? r.savedAt : Date.now(),
  };
}

// v11 → v13 migration. Backfills max-carry-weight=100 + per-item state.weight
// for the inventory weight mechanic, plus the v13 tan-label location.
function migrateV11Session(v: unknown, storyId: string): SavedSession | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (r.version !== V11_SAVE_VERSION) return null;
  if (r.storyId !== storyId) return null;
  if (!r.engineState || typeof r.engineState !== "object") return null;
  const es = r.engineState as Record<string, unknown>;
  return {
    version: SAVE_VERSION,
    storyId,
    engineState: applyV16Backfill(es) as unknown as GameState,
    narratorHistory: Array.isArray(r.narratorHistory) ? (r.narratorHistory as Message[]) : [],
    transcript: Array.isArray(r.transcript) ? (r.transcript as TranscriptEntry[]) : [],
    inputHistory: Array.isArray(r.inputHistory) ? (r.inputHistory as string[]) : [],
    savedAt: typeof r.savedAt === "number" ? r.savedAt : Date.now(),
  };
}

// v10 → v11 migration. Backfills candles.burnTurnsRemaining=230 for the
// canonical candle burn-time mechanic.
function migrateV10Session(v: unknown, storyId: string): SavedSession | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (r.version !== V10_SAVE_VERSION) return null;
  if (r.storyId !== storyId) return null;
  if (!r.engineState || typeof r.engineState !== "object") return null;
  const es = r.engineState as Record<string, unknown>;
  return {
    version: SAVE_VERSION,
    storyId,
    engineState: applyV16Backfill(es) as unknown as GameState,
    narratorHistory: Array.isArray(r.narratorHistory) ? (r.narratorHistory as Message[]) : [],
    transcript: Array.isArray(r.transcript) ? (r.transcript as TranscriptEntry[]) : [],
    inputHistory: Array.isArray(r.inputHistory) ? (r.inputHistory as string[]) : [],
    savedAt: typeof r.savedAt === "number" ? r.savedAt : Date.now(),
  };
}

// v9 → v11 migration. Renames match.matchBurning → match.isLit (preserving
// the bool value), seeds torch.isLit=true and candles.burnTurnsRemaining=230.
function migrateV9Session(v: unknown, storyId: string): SavedSession | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (r.version !== V9_SAVE_VERSION) return null;
  if (r.storyId !== storyId) return null;
  if (!r.engineState || typeof r.engineState !== "object") return null;
  const es = r.engineState as Record<string, unknown>;
  return {
    version: SAVE_VERSION,
    storyId,
    engineState: applyV16Backfill(es) as unknown as GameState,
    narratorHistory: Array.isArray(r.narratorHistory) ? (r.narratorHistory as Message[]) : [],
    transcript: Array.isArray(r.transcript) ? (r.transcript as TranscriptEntry[]) : [],
    inputHistory: Array.isArray(r.inputHistory) ? (r.inputHistory as string[]) : [],
    savedAt: typeof r.savedAt === "number" ? r.savedAt : Date.now(),
  };
}

// v8 → v10 migration. Backfills the new state fields per applyV16Backfill.
function migrateV8Session(v: unknown, storyId: string): SavedSession | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (r.version !== V8_SAVE_VERSION) return null;
  if (r.storyId !== storyId) return null;
  if (!r.engineState || typeof r.engineState !== "object") return null;
  const es = r.engineState as Record<string, unknown>;
  return {
    version: SAVE_VERSION,
    storyId,
    engineState: applyV16Backfill(es) as unknown as GameState,
    narratorHistory: Array.isArray(r.narratorHistory) ? (r.narratorHistory as Message[]) : [],
    transcript: Array.isArray(r.transcript) ? (r.transcript as TranscriptEntry[]) : [],
    inputHistory: Array.isArray(r.inputHistory) ? (r.inputHistory as string[]) : [],
    savedAt: typeof r.savedAt === "number" ? r.savedAt : Date.now(),
  };
}

// v7 → v9 migration. Strips the two now-removed narration caches AND applies
// the v8→v9 backfill so v7 saves land at v9 in one step.
function migrateV7Session(v: unknown, storyId: string): SavedSession | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (r.version !== V7_SAVE_VERSION) return null;
  if (r.storyId !== storyId) return null;
  if (!r.engineState || typeof r.engineState !== "object") return null;
  const es = r.engineState as Record<string, unknown>;
  const { lastAppearanceShown: _la, lastExamineShown: _le, ...stripped } = es;
  return {
    version: SAVE_VERSION,
    storyId,
    engineState: applyV16Backfill(stripped) as unknown as GameState,
    narratorHistory: Array.isArray(r.narratorHistory) ? (r.narratorHistory as Message[]) : [],
    transcript: Array.isArray(r.transcript) ? (r.transcript as TranscriptEntry[]) : [],
    inputHistory: Array.isArray(r.inputHistory) ? (r.inputHistory as string[]) : [],
    savedAt: typeof r.savedAt === "number" ? r.savedAt : Date.now(),
  };
}

// v6 → v9 migration. Applies the v8→v9 backfill (v6 already had no narration
// caches; just need to add the new state fields and bump the version stamp).
function migrateV6Session(v: unknown, storyId: string): SavedSession | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (r.version !== V6_SAVE_VERSION) return null;
  if (r.storyId !== storyId) return null;
  if (!r.engineState || typeof r.engineState !== "object") return null;
  return {
    version: SAVE_VERSION,
    storyId,
    engineState: applyV16Backfill(r.engineState as Record<string, unknown>) as unknown as GameState,
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
  // Strip player* fields and the v7-era narration caches (gone in v8).
  // v5 saves jump straight to v9 in one migration step (v5→v6→v8→v9).
  const {
    playerLocation: _pl,
    playerVehicle: _pv,
    itemLocations: _il,
    lastAppearanceShown: _la,
    lastExamineShown: _le,
    ...rest
  } = es;
  const migratedEngineState = applyV16Backfill({
    ...rest,
    itemLocations: nextItemLocations,
  }) as unknown as GameState;
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

function v7KeyForSlot(storyId: string, slot: SaveSlot): string {
  return V7_PREFIX + storyId + "_" + (slot === "quick" ? "quick" : "slot" + slot);
}

function v8KeyForSlot(storyId: string, slot: SaveSlot): string {
  return V8_PREFIX + storyId + "_" + (slot === "quick" ? "quick" : "slot" + slot);
}

function v9KeyForSlot(storyId: string, slot: SaveSlot): string {
  return V9_PREFIX + storyId + "_" + (slot === "quick" ? "quick" : "slot" + slot);
}

function v10KeyForSlot(storyId: string, slot: SaveSlot): string {
  return V10_PREFIX + storyId + "_" + (slot === "quick" ? "quick" : "slot" + slot);
}

function v11KeyForSlot(storyId: string, slot: SaveSlot): string {
  return V11_PREFIX + storyId + "_" + (slot === "quick" ? "quick" : "slot" + slot);
}

function v12KeyForSlot(storyId: string, slot: SaveSlot): string {
  return V12_PREFIX + storyId + "_" + (slot === "quick" ? "quick" : "slot" + slot);
}

function v13KeyForSlot(storyId: string, slot: SaveSlot): string {
  return V13_PREFIX + storyId + "_" + (slot === "quick" ? "quick" : "slot" + slot);
}

function v14KeyForSlot(storyId: string, slot: SaveSlot): string {
  return V14_PREFIX + storyId + "_" + (slot === "quick" ? "quick" : "slot" + slot);
}

function v15KeyForSlot(storyId: string, slot: SaveSlot): string {
  return V15_PREFIX + storyId + "_" + (slot === "quick" ? "quick" : "slot" + slot);
}

function v16KeyForSlot(storyId: string, slot: SaveSlot): string {
  return V16_PREFIX + storyId + "_" + (slot === "quick" ? "quick" : "slot" + slot);
}

export function clearSession(storyId: string, slot: SaveSlot): void {
  try {
    localStorage.removeItem(key(storyId, slot));
    // Defensive: remove all older-version keys for this slot too. If any
    // lingered, loadSession would migrate-and-restore them on the next read,
    // and the user would see the slot "uncleared" / the LLM would resurrect
    // old narration history after a "new game".
    localStorage.removeItem(v16KeyForSlot(storyId, slot));
    localStorage.removeItem(v15KeyForSlot(storyId, slot));
    localStorage.removeItem(v14KeyForSlot(storyId, slot));
    localStorage.removeItem(v13KeyForSlot(storyId, slot));
    localStorage.removeItem(v12KeyForSlot(storyId, slot));
    localStorage.removeItem(v11KeyForSlot(storyId, slot));
    localStorage.removeItem(v10KeyForSlot(storyId, slot));
    localStorage.removeItem(v9KeyForSlot(storyId, slot));
    localStorage.removeItem(v8KeyForSlot(storyId, slot));
    localStorage.removeItem(v7KeyForSlot(storyId, slot));
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
