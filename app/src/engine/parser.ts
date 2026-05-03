// Pre-LLM command parser. Translates a free-text player command into an
// ActionRequest the engine can execute, or returns an error message if the
// command can't be understood.
//
// In Phase 4 the LLM replaces this — it's much better at messy input,
// pronouns, and disambiguation. This parser only needs to be good enough to
// drive end-to-end testing of the engine through the actual UI.

import type { Story } from "../story/schema";
import type { ActionRequest } from "./actions";

export type ParseResult = ActionRequest | { error: string };

const DIRECTIONS = new Set([
  "north", "south", "east", "west",
  "northeast", "northwest", "southeast", "southwest",
  "up", "down", "in", "out", "enter", "exit",
]);

const DIRECTION_SHORT: Record<string, string> = {
  n: "north", s: "south", e: "east", w: "west",
  ne: "northeast", nw: "northwest", se: "southeast", sw: "southwest",
  u: "up", d: "down",
};

export function parseCommand(input: string, story: Story): ParseResult {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return { error: "Type a command." };

  const tokens = trimmed.split(/\s+/);
  const verb = tokens[0];
  const rest = tokens.slice(1).join(" ");

  // Bare directions: "east", "n", etc.
  if (DIRECTIONS.has(verb) && tokens.length === 1) return { type: "go", direction: verb };
  if (DIRECTION_SHORT[verb] && tokens.length === 1) return { type: "go", direction: DIRECTION_SHORT[verb] };

  // Verb-based dispatch
  switch (verb) {
    case "look":
    case "l":
      return parseLook(tokens.slice(1), story);

    case "examine":
    case "x":
    case "inspect":
      return needItem("examine", rest, story);

    case "take":
    case "get":
    case "grab":
    case "pick": {
      // Allow "pick up X"
      const target = tokens[1] === "up" ? tokens.slice(2).join(" ") : rest;
      return needItem("take", target, story);
    }

    case "drop":
    case "discard":
      return needItem("drop", rest, story);

    case "inventory":
    case "i":
    case "inv":
      return { type: "inventory" };

    case "go":
    case "move":
    case "walk":
    case "head": {
      if (!rest) return { error: "Go where?" };
      const dir = DIRECTION_SHORT[rest] ?? rest;
      return { type: "go", direction: dir };
    }

  }

  return { error: `I don't understand "${input.trim()}".` };
}

// "look" / "look around" -> look at room.
// "look at X" / "look X" -> examine X.
function parseLook(rest: string[], story: Story): ParseResult {
  if (rest.length === 0) return { type: "look" };
  if (rest.length === 1 && rest[0] === "around") return { type: "look" };
  const target = rest[0] === "at" ? rest.slice(1).join(" ") : rest.join(" ");
  if (!target) return { type: "look" };
  return needItem("examine", target, story);
}

function needItem(
  verb: "examine" | "take" | "drop",
  query: string,
  story: Story,
): ParseResult {
  if (!query) return { error: capitalize(verb) + " what?" };
  const itemId = findItemId(query, story);
  if (!itemId) return { error: `I don't recognize "${query}".` };
  return { type: verb, itemId };
}

function findItemId(query: string, story: Story): string | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  // Exact id or name match first.
  for (const item of story.items) {
    if (item.id.toLowerCase() === q) return item.id;
    if (item.name.toLowerCase() === q) return item.id;
  }
  // Fall back to last-token match (e.g. "small brass key" matches name "key").
  const lastWord = q.split(/\s+/).pop()!;
  for (const item of story.items) {
    if (item.name.toLowerCase().split(/\s+/).pop() === lastWord) return item.id;
  }
  return null;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
