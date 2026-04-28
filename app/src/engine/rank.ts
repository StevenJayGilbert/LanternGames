// Score-rank tier table. Canonical Zork I (8 tiers). Stories that don't use
// the score system never trigger this — RANKS only applies when the story's
// startState defines `score` and `max-score`.
//
// Single source of truth for both the WorldView builder (so the LLM sees
// the rank) and the handler/trigger narration template renderer (so
// `{rank}` interpolates the same value in narration cues).

interface RankTier {
  min: number;
  name: string;
}

const RANKS: ReadonlyArray<RankTier> = [
  { min: 350, name: "Master Adventurer" },
  { min: 330, name: "Wizard" },
  { min: 250, name: "Adventurer" },
  { min: 180, name: "Junior Adventurer" },
  { min: 100, name: "Novice Adventurer" },
  { min: 20,  name: "Amateur Adventurer" },
  { min: 0,   name: "Beginner" },
];

export function computeRank(score: number): string {
  for (const tier of RANKS) {
    if (score >= tier.min) return tier.name;
  }
  return "Beginner";
}
