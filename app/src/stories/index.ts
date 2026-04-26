// Registry of stories bundled with the app. Validated at module-load so a
// malformed story file fails loudly during dev rather than at runtime in
// the middle of play.

import type { Story } from "../story/schema";
import { assertValid } from "../story/validate";
import helloAdventure from "./hello-adventure.json";
import zork1 from "./zork-1.json";

export const STORIES: Story[] = [
  assertValid(helloAdventure, "hello-adventure"),
  assertValid(zork1, "zork-1"),
];

export const DEFAULT_STORY_ID = STORIES[0].id;

export function findStory(id: string | null | undefined): Story | undefined {
  if (!id) return undefined;
  return STORIES.find((s) => s.id === id);
}
