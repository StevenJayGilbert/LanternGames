import { useEffect, useState } from "react";
import {
  MANUAL_SLOTS,
  listSlotSummaries,
  type SaveSlot,
  type SlotSummary,
} from "./persistence/localSave";
import type { Story } from "./story/schema";

interface Props {
  story: Story;
  // Bumped by the parent after a save/load/clear so the dialog refreshes its
  // slot summaries without needing to know about persistence internals.
  refreshKey: number;
  onClose: () => void;
  onSaveSlot: (slot: SaveSlot) => void;
  onLoadSlot: (slot: SaveSlot) => void;
  onClearSlot: (slot: SaveSlot) => void;
  onNewGame: () => void;
}

// Inline confirm step for destructive actions. Avoids window.confirm so the
// modal stays self-contained and styled.
type Pending =
  | { kind: "save"; slot: SaveSlot }
  | { kind: "clear"; slot: SaveSlot }
  | { kind: "newgame" }
  | null;

export function SaveLoadDialog(props: Props) {
  const { story, refreshKey, onClose, onSaveSlot, onLoadSlot, onClearSlot, onNewGame } = props;
  const [summaries, setSummaries] = useState(() => listSlotSummaries(story));
  const [pending, setPending] = useState<Pending>(null);

  useEffect(() => {
    setSummaries(listSlotSummaries(story));
    setPending(null);
  }, [story, refreshKey]);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const requestSave = (slot: SaveSlot, summary: SlotSummary | null) => {
    if (summary) setPending({ kind: "save", slot });
    else onSaveSlot(slot);
  };

  const requestClear = (slot: SaveSlot) => setPending({ kind: "clear", slot });

  const requestNewGame = () => setPending({ kind: "newgame" });

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>Save / Load</h2>
          <button type="button" className="restart" onClick={onClose}>Close</button>
        </header>

        <div className="slot-list">
          <SlotRow
            label="Quick-save"
            sublabel="auto-updates each turn"
            summary={summaries.quick}
            pending={pending?.kind === "save" && pending.slot === "quick" ? "save" : null}
            onSave={null /* quick-save isn't manually saved */}
            onLoad={summaries.quick ? () => onLoadSlot("quick") : null}
            onClear={null /* quick-save isn't manually cleared — use New game */}
            onConfirm={() => {}}
            onCancel={() => setPending(null)}
          />

          {MANUAL_SLOTS.map((n, idx) => {
            const summary = summaries.manual[idx];
            const isPending =
              pending && "slot" in pending && pending.slot === n ? pending.kind : null;
            return (
              <SlotRow
                key={n}
                label={`Slot ${n}`}
                sublabel={null}
                summary={summary}
                pending={isPending}
                onSave={() => requestSave(n, summary)}
                onLoad={summary ? () => onLoadSlot(n) : null}
                onClear={summary ? () => requestClear(n) : null}
                onConfirm={() => {
                  if (isPending === "save") onSaveSlot(n);
                  else if (isPending === "clear") onClearSlot(n);
                }}
                onCancel={() => setPending(null)}
              />
            );
          })}
        </div>

        <footer className="modal-footer">
          {pending?.kind === "newgame" ? (
            <div className="confirm-row">
              <span>Discard the current game and start over?</span>
              <button type="button" className="restart" onClick={() => onNewGame()}>Yes, new game</button>
              <button type="button" className="restart" onClick={() => setPending(null)}>Cancel</button>
            </div>
          ) : (
            <button type="button" className="restart" onClick={requestNewGame}>New game</button>
          )}
        </footer>
      </div>
    </div>
  );
}

interface SlotRowProps {
  label: string;
  sublabel: string | null;
  summary: SlotSummary | null;
  pending: "save" | "clear" | null;
  onSave: (() => void) | null;
  onLoad: (() => void) | null;
  onClear: (() => void) | null;
  onConfirm: () => void;
  onCancel: () => void;
}

function SlotRow(p: SlotRowProps) {
  return (
    <div className="slot-row">
      <div className="slot-info">
        <div className="slot-label">{p.label}</div>
        {p.sublabel && <div className="slot-sublabel">{p.sublabel}</div>}
        <div className="slot-summary">
          {p.summary ? formatSummary(p.summary) : <span className="slot-empty">(empty)</span>}
        </div>
      </div>
      <div className="slot-actions">
        {p.pending === "save" && (
          <ConfirmInline message="Overwrite?" onConfirm={p.onConfirm} onCancel={p.onCancel} />
        )}
        {p.pending === "clear" && (
          <ConfirmInline message="Delete?" onConfirm={p.onConfirm} onCancel={p.onCancel} />
        )}
        {p.pending === null && (
          <>
            {p.onSave && <button type="button" className="restart" onClick={p.onSave}>Save</button>}
            {p.onLoad && <button type="button" className="restart" onClick={p.onLoad}>Load</button>}
            {p.onClear && <button type="button" className="restart" onClick={p.onClear}>Delete</button>}
          </>
        )}
      </div>
    </div>
  );
}

function ConfirmInline(props: { message: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <span className="confirm-inline">
      <span>{props.message}</span>
      <button type="button" className="restart" onClick={props.onConfirm}>Yes</button>
      <button type="button" className="restart" onClick={props.onCancel}>No</button>
    </span>
  );
}

function formatSummary(s: SlotSummary): string {
  return `${s.roomName} · turn ${s.turnCount} · ${formatRelative(s.savedAt)}`;
}

function formatRelative(savedAt: number): string {
  const diff = Date.now() - savedAt;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const d = new Date(savedAt);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
