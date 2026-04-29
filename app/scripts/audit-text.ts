// One-shot audit: compares each room's CURRENT description in zork-1.json
// against the CANONICAL text parsed from walkthrough2.txt. Emits
// docs/text-audit.md with a per-room verdict.
//
// Throwaway. Run after parse-walkthrough.ts.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORY = resolve(__dirname, "../src/stories/zork-1.json");
const WALKTHROUGH = resolve(__dirname, "../../docs/walkthrough2.txt");
const OUT = resolve(__dirname, "../../docs/text-audit.md");

interface Room {
  id: string;
  name: string;
  description: string;
}

const story = JSON.parse(readFileSync(STORY, "utf8")) as { rooms: Room[] };

// Re-parse walkthrough2 for room → canonical desc mapping (mirror of
// parse-walkthrough.ts logic — kept self-contained so this script is independent).
const raw = readFileSync(WALKTHROUGH, "utf8");
const lines = raw.split(/\r?\n/);

function isRoomHeader(line: string): boolean {
  if (!/^[A-Z][A-Za-z' -]+$/.test(line)) return false;
  if (line.length < 3 || line.length > 40) return false;
  if (/^(A|An) /.test(line)) return false;
  return true;
}
function isPresenceSentence(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  return (
    /^There (is|are) .* here\.?$/.test(t) ||
    /^Sitting on .*[.:]?$/.test(t) ||
    /^On the .*[.:]?$/.test(t) ||
    /^The .* contains:$/.test(t) ||
    /^A .* is here\.?$/.test(t) ||
    /^An .* is here\.?$/.test(t) ||
    /^[A-Z][a-z].*is (sitting|lying|standing|hanging|resting) (on|in|here|nearby|above|below)/.test(t) ||
    /^Above the .* hangs/.test(t) ||
    /^A battery-powered/.test(t) ||
    /^A bottle is sitting/.test(t) ||
    /^Loosely attached to/.test(t) ||
    /^A large coil/.test(t) ||
    /^A piece of/.test(t) ||
    /^Your sword has begun/.test(t)
  );
}

const canonByName = new Map<string, string>();
let i = 0;
while (i < lines.length) {
  if (!isRoomHeader(lines[i].trim())) { i++; continue; }
  const name = lines[i].trim();
  i++;
  while (i < lines.length && lines[i].trim() === "") i++;
  const parts: string[] = [];
  while (i < lines.length) {
    const t = lines[i].trim();
    if (t.startsWith(">")) break;
    if (isRoomHeader(t)) break;
    if (t === "") { i++; continue; }
    if (isPresenceSentence(lines[i])) { i++; continue; }
    parts.push(t);
    i++;
  }
  const desc = parts.join(" ").replace(/\s+/g, " ").trim();
  if (desc && !canonByName.has(name)) canonByName.set(name, desc);
}

// Compare-string normalizer: lowercase, collapse whitespace, strip trailing
// punctuation. Used only for the Match/Differs verdict — display still uses
// the original text.
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[.,;:!?]+\s*$/g, "")
    .trim();
}

interface AuditRow {
  id: string;
  name: string;
  canonical: string | null;
  current: string;
  verdict: "identical" | "equivalent" | "partial" | "wrong" | "missing-canonical";
  note: string;
}

const rows: AuditRow[] = [];

for (const room of story.rooms) {
  const canon = canonByName.get(room.name) ?? null;
  if (!canon) {
    rows.push({
      id: room.id,
      name: room.name,
      canonical: null,
      current: room.description,
      verdict: "missing-canonical",
      note: "Room not visited in walkthrough2.txt — fall back to ZIL or keep extracted text.",
    });
    continue;
  }
  const a = norm(canon);
  const b = norm(room.description);
  if (a === b) {
    rows.push({ id: room.id, name: room.name, canonical: canon, current: room.description, verdict: "identical", note: "" });
  } else if (b.includes(a) || a.includes(b)) {
    // One is a strict substring of the other; one paragraph adds material.
    if (b.length > a.length) {
      rows.push({ id: room.id, name: room.name, canonical: canon, current: room.description, verdict: "equivalent", note: "Current adds extra prose; canonical is a substring." });
    } else {
      rows.push({ id: room.id, name: room.name, canonical: canon, current: room.description, verdict: "partial", note: "Canonical contains additional sentence(s) missing from current." });
    }
  } else {
    // Word-overlap heuristic
    const wordsA = new Set(a.split(/\s+/));
    const wordsB = new Set(b.split(/\s+/));
    let overlap = 0;
    for (const w of wordsA) if (wordsB.has(w)) overlap++;
    const ratio = overlap / Math.max(wordsA.size, 1);
    if (ratio > 0.7) {
      rows.push({ id: room.id, name: room.name, canonical: canon, current: room.description, verdict: "equivalent", note: `Word-overlap ${(ratio * 100).toFixed(0)}% — same meaning, different phrasing.` });
    } else if (ratio > 0.4) {
      rows.push({ id: room.id, name: room.name, canonical: canon, current: room.description, verdict: "partial", note: `Word-overlap ${(ratio * 100).toFixed(0)}% — significant text differences.` });
    } else {
      rows.push({ id: room.id, name: room.name, canonical: canon, current: room.description, verdict: "wrong", note: `Word-overlap only ${(ratio * 100).toFixed(0)}% — current diverges substantially from canonical.` });
    }
  }
}

// Counts
const counts = rows.reduce<Record<string, number>>((acc, r) => { acc[r.verdict] = (acc[r.verdict] ?? 0) + 1; return acc; }, {});

// Emit
const out: string[] = [];
out.push("# Room description audit — current vs. canonical Zork I\n");
out.push("Comparing each room's `description` in [app/src/stories/zork-1.json](../app/src/stories/zork-1.json) against the canonical text parsed from [docs/walkthrough2.txt](walkthrough2.txt).\n");
out.push(`**Total rooms:** ${story.rooms.length}\n`);
out.push(`**Verdict counts:**\n`);
for (const v of ["identical", "equivalent", "partial", "wrong", "missing-canonical"]) {
  out.push(`- **${v}**: ${counts[v] ?? 0}`);
}
out.push("");
out.push(`**Action by verdict:**\n`);
out.push(`- **identical** → no change`);
out.push(`- **equivalent** → no change (current carries the same hint, just phrased differently)`);
out.push(`- **partial** → augment current text with the missing canonical sentence(s)`);
out.push(`- **wrong** → replace with canonical text`);
out.push(`- **missing-canonical** → leave current; ZIL/manual review only if a puzzle-relevant room`);
out.push("");
out.push("---\n");

// Sort: wrong first, then partial, then equivalent, then identical, then missing-canonical
const order = { wrong: 0, partial: 1, equivalent: 2, identical: 3, "missing-canonical": 4 };
rows.sort((a, b) => order[a.verdict] - order[b.verdict] || a.id.localeCompare(b.id));

for (const r of rows) {
  out.push(`## ${r.name} (\`${r.id}\`) — **${r.verdict}**\n`);
  if (r.note) out.push(`*${r.note}*\n`);
  if (r.canonical) {
    out.push(`**Canonical:**\n> ${r.canonical}\n`);
  } else {
    out.push(`**Canonical:** _(not in walkthrough2.txt)_\n`);
  }
  out.push(`**Current:**\n> ${r.current}\n`);
  out.push("---\n");
}

writeFileSync(OUT, out.join("\n"));
console.log(`Wrote ${OUT}`);
console.log(`Verdicts:`, counts);
