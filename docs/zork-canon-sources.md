# Zork I canonical-behavior sources

When wiring or auditing Zork I content, these are the references used to verify canonical behavior. Walkthroughs sometimes disagree with each other and with the original ZIL source — when in doubt, prefer ZIL. The `zork1-source/` directory in this repo (extracted from the Microsoft-released MIT-licensed source, Nov 2025) is the ground truth.

## Primary sources

- **`zork1-source/`** (in this repo) — original ZIL source code from Infocom, MIT-licensed. Authoritative for routine logic, room/object definitions, and the FINISH / JIGS-UP death machinery. Read this first when a walkthrough's claim seems off.
- **[Zork Wiki — Fandom](https://zork.fandom.com/)** — community-curated, generally accurate item and puzzle descriptions. Good cross-check against ZIL.
  - [Jewel encrusted egg](https://zork.fandom.com/wiki/Jewel_encrusted_egg) — egg / canary / songbird / thief mechanics.

## Walkthroughs

These were spot-checked while wiring puzzles. None are perfectly canonical — each has occasional embellishment or simplification, and they often paraphrase responses.

- **[Eristic — Zork 1 walkthrough](http://www.eristic.net/games/infocom/zork1.html)** — clean step-by-step transcript-style walkthrough with the canonical optimal path.
- **[Zork hints — Computer History Wiki](https://gunkies.org/wiki/Zork_hints)** — terse hint-style breakdown; useful for "what's the trick?" lookups.
- **[Zork I: Commentary and Puzzle Breakdown — RetroGameDeconstructionZone](https://www.retrogamedeconstructionzone.com/2020/06/zork-i-commentary-and-puzzle-breakdown.html)** — design-level analysis of each puzzle; useful for understanding *why* a mechanic exists.

## Specific behaviors verified

| Mechanic | Source(s) | Notes |
|---|---|---|
| Gas-room explosion | ZIL `gas-room` + walkthroughs | Triggered by torch, candles, or lit match. Lantern (electric) safe. ZIL fires only in `gas-room` itself; some walkthroughs claim smelly-room too — they're wrong. |
| Egg drop in tree | Zork Wiki + ZIL | Drops from `up-a-tree` crack the shell in place. Egg becomes `broken`, canary becomes `broken` (silent — can't sing for the bauble). Reduced points vs. the thief-opens-egg path. |
| Endgame rank tiers | ZIL `RANKS` constant | 350 Master Adventurer, 330 Wizard, 250 Adventurer, 180 Junior, 100 Novice, 20 Amateur, 0 Beginner. |
| Stone barrow ending | ZIL `STONE-BARROW-FCN` | Walking into stone-barrow runs FINISH; prints rank-templated score message and ends the game. Zork I has no separate "endgame zone" with bonus rooms — that's Zork II/III content. |
| Wind canary → bauble | ZIL `CANARY-OBJECT` (1actions.zil:2970-2994) + [Brass bauble](https://zork.fandom.com/wiki/Brass_bauble) | Winding the canary in any forest room (`forest-1`, `forest-2`, `forest-3`, `path`, `up-a-tree`) once delivers the brass bauble to the player's room. Special case: at `up-a-tree`, the bauble lands at `path` (falls through branches). Subsequent winds: "chirps blithely". Broken canary: "grinding noise", no bauble. Outside forest: "chirps in vain". |
| Brush teeth with putty | ZIL 1actions.zil:53 | Mouth glues shut → respiratory failure. Requires putty in inventory. |
| Burn leaves while carrying | ZIL 1actions.zil:796 | "The leaves burn, and so do you." Requires lit flame source (torch or candles). |
| Attack with rusty knife | ZIL 1actions.zil:920 | Telekinetic possession; the blade slits the wielder's throat. ALWAYS fatal — there is no safe way to use the rusty-knife as a weapon (the canonical walkthrough's claim it can fight the thief is incorrect; use the attic knife instead). |
| Leap from up-a-tree | ZIL 1actions.zil:2915 | Fall from the branches → broken neck. |
| Leap from canyon-view / cliff-middle | ZIL 1dungeon.zil:2410 | Fatal jump from a high lookout. |
| Burn the black book | ZIL 1actions.zil:2203 | Guardian materializes, reduces player to ash. Requires book in inventory + lit flame. |
| Mung the bodies (entrance-to-hades) | ZIL 1actions.zil:2182 | Guardian materializes, decapitates player. |
| Throw object at self / suicide attack | ZIL gverbs.zil:239,1451 | Self-destruction. The engine rejects literal `attack(weapon, "player")` because the synthesized player isn't in `story.items`; we use customTool intents (`attack-self`, `throw-at-self`) instead. Engine follow-up: make `itemById` resolve the synthesized player so direct `attack(sword, "player")` works. |
| Beach hole collapses (4th dig) | ZIL 1actions.zil:2861 | Counter-based: 3 successful digs grow the hole; the 4th collapses it, smothering the player. Requires shovel. |
| Mung painting | ZIL 1actions.zil:2209 | Destroys treasure value (TVALUE → 0). We model via `painting.broken = true` flag; `score-credit-painting` gates on `not(broken)` so deposit awards 0 points. |
| Mung sceptre at rainbow | ZIL 1actions.zil:2614 | Rainbow collapses; player falls. Fatal at `end-of-rainbow` or `aragain-falls`. |
| Swim in Frigid River | ZIL 1actions.zil:2673 | Drown by currents. Triggers in any river-1 through river-5 room or adjoining banks. |

## Adding to this list

When researching a puzzle, drop the URLs and a one-line "what was verified" note here. Future audits then have a paper trail and don't have to re-search.
