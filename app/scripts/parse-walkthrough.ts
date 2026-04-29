// One-shot parser: reads docs/walkthrough2.txt (canonical Infocom Zork I
// transcript) and emits docs/zork-canonical-text.md — a structured per-room
// reference with the first-visit canonical LDESC and all "presence sentences"
// observed for items in that room.
//
// Throwaway script. Not part of the build. Run once: npx tsx scripts/parse-walkthrough.ts

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, "../../docs/walkthrough2.txt");
const OUT = resolve(__dirname, "../../docs/zork-canonical-text.md");

const raw = readFileSync(SRC, "utf8");

// Walkthrough format:
//   Room Header (title-case, on its own line)
//   <blank or non-breaking-space line>
//   <description paragraph(s)>
//   <blank>
//   <item-presence sentences> ("There is X here.", "Sitting on Y is Z.", ...)
//   <blank>
//   >command
//   <blank>
//   <action response>
//   ...
//
// We tokenize by lines, walk forward, and capture for each ROOM_HEADER its
// first-occurrence description block + the immediate item-presence sentences.

const lines = raw.split(/\r?\n/);

// Room header: line that starts with uppercase, contains only letters / spaces /
// hyphens / apostrophes, length 3..40 chars, and is followed (after blank lines)
// by a description paragraph (NOT another `>` command).
//
// Heuristic refinement: also exclude lines that are clearly mid-paragraph
// (preceded by a paragraph that didn't end with punctuation).
function isRoomHeader(line: string): boolean {
  if (!/^[A-Z][A-Za-z' -]+$/.test(line)) return false;
  if (line.length < 3 || line.length > 40) return false;
  // Item-name false positives: "A quantity of water", "A painting", "A pair of
  // candles", "An elongated brown sack". Room names never start with article.
  if (/^(A|An) /.test(line)) return false;
  return true;
}

// Sentences inserted by the engine (item presence, NPC presence, container
// reveal). Skip these when building the LDESC.
function isPresenceSentence(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  return (
    /^There is .* here\.?$/.test(trimmed) ||
    /^There are .* here\.?$/.test(trimmed) ||
    /^Sitting on .*[.:]?$/.test(trimmed) ||
    /^On the .*[.:]?$/.test(trimmed) ||
    /^The .* contains:$/.test(trimmed) ||
    /^A .*is here\.?$/.test(trimmed) ||
    /^An .*is here\.?$/.test(trimmed) ||
    /^[A-Z][a-z].*is (sitting|lying|standing|hanging|resting) (on|in|here|nearby|above|below)/.test(trimmed) ||
    /^Above the .* hangs/.test(trimmed) ||
    /^A battery-powered/.test(trimmed) ||
    /^A bottle is sitting/.test(trimmed) ||
    /^Loosely attached to/.test(trimmed) ||
    /^A large coil/.test(trimmed) ||
    /^A piece of/.test(trimmed) ||
    /^Your sword has begun/.test(trimmed)
  );
}

interface RoomEntry {
  name: string;
  description: string;       // first-visit LDESC, joined paragraphs
  presenceLines: string[];   // item presence sentences observed across visits (deduped)
  visits: number;
}

const rooms = new Map<string, RoomEntry>();

let i = 0;
while (i < lines.length) {
  const line = lines[i].trim();
  if (!isRoomHeader(line)) { i++; continue; }

  const name = line;
  i++;

  // Skip blank / non-breaking-space lines
  while (i < lines.length && lines[i].trim() === "") i++;

  // Capture paragraphs until we hit a `>` command line, a presence sentence,
  // or another likely room header. Description ends at the first blank-then-
  // presence-or-command transition.
  const descParts: string[] = [];
  const presence: string[] = [];

  while (i < lines.length) {
    const cur = lines[i];
    const t = cur.trim();

    if (t.startsWith(">")) break;                  // start of next command
    if (isRoomHeader(t)) break;                    // next room header
    if (t === "") { i++; continue; }               // blank line — keep scanning

    if (isPresenceSentence(cur)) {
      presence.push(t);
      i++;
      continue;
    }

    // Otherwise: part of LDESC
    descParts.push(t);
    i++;
  }

  const desc = descParts.join(" ").replace(/\s+/g, " ").trim();

  const existing = rooms.get(name);
  if (existing) {
    // Subsequent visit: only add new presence lines we haven't seen.
    for (const p of presence) {
      if (!existing.presenceLines.includes(p)) existing.presenceLines.push(p);
    }
    existing.visits++;
    // Keep first-visit description (don't overwrite with shorter revisit text).
  } else {
    rooms.set(name, {
      name,
      description: desc,
      presenceLines: presence,
      visits: 1,
    });
  }
}

// Drop entries where we never captured a description (these are likely
// non-LDESC rooms or false-positive item names that slipped past the heuristic).
for (const [name, r] of rooms) {
  if (!r.description) rooms.delete(name);
}

// Sort by first appearance order (insertion order in the Map).
const out: string[] = [];
out.push("# Canonical Zork I room and item text\n");
out.push(`Parsed from [docs/walkthrough2.txt](walkthrough2.txt) — canonical Infocom transcript.\n`);
out.push(`Each section is one room as it FIRST appears in the canonical solve. Subsequent-visit deltas are not shown.\n`);
out.push(`The "Items observed" list is every item-presence sentence the transcript surfaced across all visits to that room.\n`);
out.push(`Total rooms captured: **${rooms.size}**.\n`);
out.push("---\n");

for (const r of rooms.values()) {
  out.push(`## ${r.name}\n`);
  out.push(`*(${r.visits} visit${r.visits === 1 ? "" : "s"})*\n`);
  out.push(`**LDESC (first visit):**\n`);
  out.push(`> ${r.description || "(no description captured — likely a non-LDESC room or only revisited in this transcript)"}\n`);
  if (r.presenceLines.length > 0) {
    out.push(`**Items / NPCs observed:**\n`);
    for (const p of r.presenceLines) out.push(`- ${p}`);
    out.push("");
  }
  out.push("---\n");
}

writeFileSync(OUT, out.join("\n"));
console.log(`Wrote ${OUT} — ${rooms.size} rooms.`);
