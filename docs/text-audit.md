# Room description audit — current vs. canonical Zork I

Comparing each room's `description` in [app/src/stories/zork-1.json](../app/src/stories/zork-1.json) against the canonical text parsed from [docs/walkthrough2.txt](walkthrough2.txt).

**Total rooms:** 110

**Verdict counts:**

- **identical**: 50
- **equivalent**: 14
- **partial**: 24
- **wrong**: 5
- **missing-canonical**: 17

**Action by verdict:**

- **identical** → no change
- **equivalent** → no change (current carries the same hint, just phrased differently)
- **partial** → augment current text with the missing canonical sentence(s)
- **wrong** → replace with canonical text
- **missing-canonical** → leave current; ZIL/manual review only if a puzzle-relevant room

---

## Clearing (`grating-clearing`) — **wrong**

*Word-overlap only 35% — current diverges substantially from canonical.*

**Canonical:**
> You are in a small clearing in a well marked forest path that extends to the east and west.

**Current:**
> You are in a clearing, with a forest surrounding you on all sides. A path leads south.

---

## Living Room (`living-room`) — **wrong**

*Word-overlap only 36% — current diverges substantially from canonical.*

**Canonical:**
> You are in the living room. There is a doorway to the east, a wooden door with strange gothic lettering to the west, which appears to be nailed shut, a trophy case, and a large oriental rug in the center of the room.

**Current:**
> You are in the living room. There is a doorway to the easta trophy case,

---

## Forest (`mountains`) — **wrong**

*Word-overlap only 6% — current diverges substantially from canonical.*

**Canonical:**
> This is a forest, with trees in all directions. To the east, there appears to be sunlight.

**Current:**
> The forest thins out, revealing impassable mountains.

---

## Reservoir (`reservoir`) — **wrong**

*Word-overlap only 38% — current diverges substantially from canonical.*

**Canonical:**
> You are on what used to be a large lake, but which is now a large mud pile. There are "shores" to the north and south. Lying half buried in the mud is an old trunk, bulging with jewels.

**Current:**
> You are in a vast underground chamber, half-filled with cold dark water. The reservoir stretches north and south, fed from the north and drained by the dam to the south. Boats might cross when the water is high; at low tide, mud and silt stretch where the water once stood.

---

## Sandy Beach (`sandy-beach`) — **wrong**

*Word-overlap only 33% — current diverges substantially from canonical.*

**Canonical:**
> A tan label

**Current:**
> You are on a large sandy beach on the east shore of the river, which is flowing quickly by. A path runs beside the river to the south here, and a passage is partially buried in sand to the northeast.

[DEV NOTE: dig-with-shovel scarab puzzle is unwired. The scarab is currently visible without digging — canonical Zork required four DIG WITH SHOVEL actions to unbury it.]

---

## Aragain Falls (`aragain-falls`) — **partial**

*Canonical contains additional sentence(s) missing from current.*

**Canonical:**
> You are at the top of Aragain Falls, an enormous waterfall with a drop of about 450 feet. The only path here is on the north end. A solid rainbow spans the falls.

**Current:**
> You are at the top of Aragain Falls, an enormous waterfall with a drop of about 450 feet. The only path here is on the north end.

---

## Attic (`attic`) — **partial**

*Canonical contains additional sentence(s) missing from current.*

**Canonical:**
> This is the attic. The only exit is a stairway leading down. On a table is a nasty-looking knife.

**Current:**
> This is the attic. The only exit is a stairway leading down.

---

## Bat Room (`bat-room`) — **partial**

*Canonical contains additional sentence(s) missing from current.*

**Canonical:**
> You are in a small room which has doors only to the east and south. In the corner of the room on the ceiling is a large vampire bat who is obviously deranged and holding his nose.

**Current:**
> You are in a small room which has doors only to the east and south.

---

## Cyclops Room (`cyclops-room`) — **partial**

*Canonical contains additional sentence(s) missing from current.*

**Canonical:**
> This room has an exit on the northwest, and a staircase leading up. A cyclops, who looks prepared to eat horses (much less mere adventurers), blocks the staircase. From his state of health, and the bloodstains on the walls, you gather that he is not very friendly, though he likes people.

**Current:**
> This room has an exit on the northwest, and a staircase leading up.

---

## Dam Base (`dam-base`) — **partial**

*Canonical contains additional sentence(s) missing from current.*

**Canonical:**
> You are at the base of Flood Control Dam #3, which looms above you and to the north. The river Frigid is flowing by here. Along the river are the White Cliffs which seem to form giant walls stretching from north to south along the shores of the river as it winds its way downstream. There is a folded pile of plastic here which has a small valve attached.

**Current:**
> You are at the base of Flood Control Dam #3, which looms above you and to the north. The river Frigid is flowing by here. Along the river are the White Cliffs which seem to form giant walls stretching from north to south along the shores of the river as it winds its way downstream.

---

## Dam Lobby (`dam-lobby`) — **partial**

*Canonical contains additional sentence(s) missing from current.*

**Canonical:**
> This room appears to have been the waiting room for groups touring the dam. There are open doorways here to the north and east marked "Private", and there is a path leading south over the top of the dam. Some guidebooks entitled "Flood Control Dam #3" are on the reception desk.

**Current:**
> This room appears to have been the waiting room for groups touring the dam. There are open doorways here to the north and east marked "Private", and there is a path leading south over the top of the dam.

---

## Deep Canyon (`deep-canyon`) — **partial**

*Canonical contains additional sentence(s) missing from current.*

**Canonical:**
> You are on the south edge of a deep canyon. Passages lead off to the east, northwest and southwest. A stairway leads down. You can hear a loud roaring sound, like that of rushing water, from below.

**Current:**
> You are on the south edge of a deep canyon. Passages lead off to the east, northwest and southwest. A stairway leads down.

---

## Behind House (`east-of-house`) — **partial**

*Canonical contains additional sentence(s) missing from current.*

**Canonical:**
> You are behind the white house. A path leads into the forest to the east. In one corner of the house there is a small window which is slightly ajar.

**Current:**
> You are behind the white house. A path leads into the forest to the east. In one corner of the house there is a small window which is

---

## Egyptian Room (`egypt-room`) — **partial**

*Canonical contains additional sentence(s) missing from current.*

**Canonical:**
> This is a room which looks like an Egyptian tomb. There is an ascending staircase to the west. The solid-gold coffin used for the burial of Ramses II is here.

**Current:**
> This is a room which looks like an Egyptian tomb. There is an ascending staircase to the west.

---

## Forest (`forest-2`) — **partial**

*Word-overlap 44% — significant text differences.*

**Canonical:**
> This is a forest, with trees in all directions. To the east, there appears to be sunlight.

**Current:**
> This is a dimly lit forest, with large trees all around.

---

## Forest (`forest-3`) — **partial**

*Word-overlap 44% — significant text differences.*

**Canonical:**
> This is a forest, with trees in all directions. To the east, there appears to be sunlight.

**Current:**
> This is a dimly lit forest, with large trees all around.

---

## Gallery (`gallery`) — **partial**

*Canonical contains additional sentence(s) missing from current.*

**Canonical:**
> This is an art gallery. Most of the paintings have been stolen by vandals with exceptional taste. The vandals left through either the north or west exits. Fortunately, there is still one chance for you to be a vandal, for on the far wall is a painting of unparalleled beauty.

**Current:**
> This is an art gallery. Most of the paintings have been stolen by vandals with exceptional taste. The vandals left through either the north or west exits.

---

## Grating Room (`grating-room`) — **partial**

*Canonical contains additional sentence(s) missing from current.*

**Canonical:**
> You are in a small room near the maze. There are twisty passages in the immediate vicinity. Above you is a grating locked with a skull-and-crossbones lock.

**Current:**
> You are in a small room near the maze. There are twisty passages in the immediate vicinity.

---

## Kitchen (`kitchen`) — **partial**

*Canonical contains additional sentence(s) missing from current.*

**Canonical:**
> You are in the kitchen of the white house. A table seems to have been used recently for the preparation of food. A passage leads to the west and a dark staircase can be seen leading upward. A dark chimney leads down and to the east is a small window which is open. A quantity of water

**Current:**
> You are in the kitchen of the white house. A table seems to have been used recently for the preparation of food. A passage leads to the west and a dark staircase can be seen leading upward. A dark chimney leads down and to the east is a small window which is

---

## Land of the Dead (`land-of-living-dead`) — **partial**

*Canonical contains additional sentence(s) missing from current.*

**Canonical:**
> You have entered the Land of the Living Dead. Thousands of lost souls can be heard weeping and moaning. In the corner are stacked the remains of dozens of previous adventurers less fortunate than yourself. A passage exits to the north. Lying in one corner of the room is a beautifully carved crystal skull. It appears to be grinning at you rather nastily.

**Current:**
> You have entered the Land of the Living Dead. Thousands of lost souls can be heard weeping and moaning. In the corner are stacked the remains of dozens of previous adventurers less fortunate than yourself. A passage exits to the north.

---

## Loud Room (`loud-room`) — **partial**

*Word-overlap 66% — significant text differences.*

**Canonical:**
> This is a large room with a ceiling which cannot be detected from the ground. There is a narrow passage from east to west and a stone stairway leading upward. The room is deafeningly loud with an undetermined rushing sound. The sound seems to reverberate from all of the walls, making it difficult even to think. It is unbearably loud here, with an ear-splitting roar seeming to come from all around you. There is a pounding in your head which won't stop. With a tremendous effort, you scramble out of the room.

**Current:**
> This is a large room with a ceiling which cannot be detected from the ground. There is a narrow passage from east to west and a stone stairway leading upward. The room is deafeningly loud with an undetermined rushing sound. The sound seems to be reverberating from all of the walls, making it difficult even to think.

---

## Drafty Room (`lower-shaft`) — **partial**

*Canonical contains additional sentence(s) missing from current.*

**Canonical:**
> This is a small drafty room in which is the bottom of a long shaft. To the south is a passageway and to the east a very narrow passage. In the shaft can be seen a heavy iron chain. At the end of the chain is a basket. A small pile of coal A screwdriver A torch (providing light)

**Current:**
> This is a small drafty room in which is the bottom of a long shaft. To the south is a passageway and to the east a very narrow passage. In the shaft can be seen a heavy iron chain.

---

## Machine Room (`machine-room`) — **partial**

*Canonical contains additional sentence(s) missing from current.*

**Canonical:**
> This is a large, cold room whose sole exit is to the north. In one corner there is a machine which is reminiscent of a clothes dryer. On its face is a switch which is labelled "START". The switch does not appear to be manipulable by any human hand (unless the fingers are about 1/16 by 1/4 inch). On the front of the machine is a large lid, which is closed.

**Current:**
> This is a large, cold room whose sole exit is to the north. In one corner there is a machine which is reminiscent of a clothes dryer. On its face is a switch which is labelled "START". The switch does not appear to be manipulable by any human hand (unless the fingers are about 1/16 by 1/4 inch). On the front of the machine is a large lid, which is

---

## Reservoir North (`reservoir-north`) — **partial**

*Canonical contains additional sentence(s) missing from current.*

**Canonical:**
> You are in a large cavernous room, the south of which was formerly a lake. However, with the water level lowered, there is merely a wide stream running through there. There is a slimy stairway leaving the room to the north.

**Current:**
> There is a slimy stairway leaving the room to the north.

---

## Reservoir South (`reservoir-south`) — **partial**

*Canonical contains additional sentence(s) missing from current.*

**Canonical:**
> You are in a long room on the south shore of a large lake, far too deep and wide for crossing. There is a path along the stream to the east or west, a steep pathway climbing southwest along the edge of a chasm, and a path leading into a canyon to the southeast.

**Current:**
> There is a path along the stream to the east or west, a steep pathway climbing southwest along the edge of a chasm, and a path leading into a canyon to the southeast.

---

## Shaft Room (`shaft-room`) — **partial**

*Canonical contains additional sentence(s) missing from current.*

**Canonical:**
> This is a large room, in the middle of which is a small shaft descending through the floor into darkness below. To the west and the north are exits from this room. Constructed over the top of the shaft is a metal framework to which a heavy iron chain is attached. At the end of the chain is a basket.

**Current:**
> This is a large room, in the middle of which is a small shaft descending through the floor into darkness below. To the west and the north are exits from this room. Constructed over the top of the shaft is a metal framework to which a heavy iron chain is attached.

---

## Treasure Room (`treasure-room`) — **partial**

*Canonical contains additional sentence(s) missing from current.*

**Canonical:**
> This is a large room, whose east wall is solid granite. A number of discarded bags, which crumble at your touch, are scattered about on the floor. There is an exit down a staircase. There is a suspicious-looking individual, holding a large bag, leaning against one wall. He is armed with a deadly stiletto. The thief attacks, and you fall back desperately.

**Current:**
> This is a large room, whose east wall is solid granite. A number of discarded bags, which crumble at your touch, are scattered about on the floor. There is an exit down a staircase.

---

## The Troll Room (`troll-room`) — **partial**

*Canonical contains additional sentence(s) missing from current.*

**Canonical:**
> This is a small room with passages to the east and south and a forbidding hole leading west. Bloodstains and deep scratches (perhaps made by an axe) mar the walls. A nasty-looking troll, brandishing a bloody axe, blocks all passages out of the room. The troll's mighty blow drops you to your knees.

**Current:**
> This is a small room with passages to the east and south and a forbidding hole leading west. Bloodstains and deep scratches (perhaps made by an axe) mar the walls.

---

## Up a Tree (`up-a-tree`) — **partial**

*Canonical contains additional sentence(s) missing from current.*

**Canonical:**
> You are about 10 feet above the ground nestled among some large branches. The nearest branch above you is above your reach. Beside you on the branch is a small bird's nest. In the bird's nest is a large egg encrusted with precious jewels, apparently scavenged by a childless songbird. The egg is covered with fine gold inlay, and ornamented in lapis lazuli and mother-of-pearl. Unlike most eggs, this one is hinged and closed with a delicate looking clasp. The egg appears extremely fragile.

**Current:**
> You are about 10 feet above the ground nestled among some large branches. The nearest branch above you is above your reach.

---

## Dam (`dam-room`) — **equivalent**

*Word-overlap 71% — same meaning, different phrasing.*

**Canonical:**
> You are standing on the top of the Flood Control Dam #3, which was quite a tourist attraction in times far distant. There are paths to the north, south, and west, and a scramble down. The sluice gates on the dam are closed. Behind the dam, there can be seen a wide reservoir. Water is pouring over the top of the now abandoned dam. There is a control panel here, on which a large metal bolt is mounted. Directly above the bolt is a small green plastic bubble.

**Current:**
> You are standing on the top of the Flood Control Dam #3, which was quite a tourist attraction in times far distant. There are paths to the north, south, and west, and a scramble down.There is a control panel here, on which a large metal bolt is mounted. Directly above the bolt is a small green plastic bubble.

---

## Dead End (`dead-end-1`) — **equivalent**

*Word-overlap 90% — same meaning, different phrasing.*

**Canonical:**
> You have come to a dead end in the mine.

**Current:**
> You have come to a dead end in the maze.

---

## Dead End (`dead-end-2`) — **equivalent**

*Word-overlap 90% — same meaning, different phrasing.*

**Canonical:**
> You have come to a dead end in the mine.

**Current:**
> You have come to a dead end in the maze.

---

## Dead End (`dead-end-3`) — **equivalent**

*Word-overlap 90% — same meaning, different phrasing.*

**Canonical:**
> You have come to a dead end in the mine.

**Current:**
> You have come to a dead end in the maze.

---

## Dead End (`dead-end-4`) — **equivalent**

*Word-overlap 90% — same meaning, different phrasing.*

**Canonical:**
> You have come to a dead end in the mine.

**Current:**
> You have come to a dead end in the maze.

---

## Entrance to Hades (`entrance-to-hades`) — **equivalent**

*Word-overlap 74% — same meaning, different phrasing.*

**Canonical:**
> You are outside a large gateway, on which is inscribed Abandon every hope all ye who enter here! The gate is open; through it you can see a desolation, with a pile of mangled bodies in one corner. Thousands of voices, lamenting some hideous fate, can be heard. The way through the gate is barred by evil spirits, who jeer at your attempts to pass.

**Current:**
> You are outside a large gateway, on which is inscribed|| Abandon every hope all ye who enter here!|| The gate is open; through it you can see a desolation, with a pile of mangled bodies in one corner. Thousands of voices, lamenting some hideous fate, can be heard.

---

## Maze (`maze-5`) — **equivalent**

*Current adds extra prose; canonical is a substring.*

**Canonical:**
> This is part of a maze of twisty little passages, all alike.

**Current:**
> This is part of a maze of twisty little passages, all alike. A skeleton, probably the remains of a luckless adventurer, lies here.

---

## Coal Mine (`mine-1`) — **equivalent**

*Word-overlap 88% — same meaning, different phrasing.*

**Canonical:**
> This is a non-descript part of a coal mine.

**Current:**
> This is a nondescript part of a coal mine.

---

## Coal Mine (`mine-2`) — **equivalent**

*Word-overlap 88% — same meaning, different phrasing.*

**Canonical:**
> This is a non-descript part of a coal mine.

**Current:**
> This is a nondescript part of a coal mine.

---

## Coal Mine (`mine-3`) — **equivalent**

*Word-overlap 88% — same meaning, different phrasing.*

**Canonical:**
> This is a non-descript part of a coal mine.

**Current:**
> This is a nondescript part of a coal mine.

---

## Coal Mine (`mine-4`) — **equivalent**

*Word-overlap 88% — same meaning, different phrasing.*

**Canonical:**
> This is a non-descript part of a coal mine.

**Current:**
> This is a nondescript part of a coal mine.

---

## Sandy Cave (`sandy-cave`) — **equivalent**

*Current adds extra prose; canonical is a substring.*

**Canonical:**
> This is a sand-filled cave whose exit is to the southwest.

**Current:**
> This is a sand-filled cave whose exit is to the southwest.

[DEV NOTE: dig-with-shovel scarab puzzle is unwired. The scarab is currently visible here without digging — canonical Zork required four DIG WITH SHOVEL actions to unbury it.]

---

## Cave (`small-cave`) — **equivalent**

*Word-overlap 87% — same meaning, different phrasing.*

**Canonical:**
> This is a tiny cave with entrances west and north, and a dark, forbidding staircase leading down.

**Current:**
> This is a tiny cave with entrances west and north, and a staircase leading down.

---

## Smelly Room (`smelly-room`) — **equivalent**

*Word-overlap 95% — same meaning, different phrasing.*

**Canonical:**
> This is a small non-descript room. However, from the direction of a small descending staircase a foul odor can be detected. To the south is a narrow tunnel.

**Current:**
> This is a small nondescript room. However, from the direction of a small descending staircase a foul odor can be detected. To the south is a narrow tunnel.

---

## Atlantis Room (`atlantis-room`) — **identical**

**Canonical:**
> This is an ancient room, long under water. There is an exit to the south and a staircase leading up.

**Current:**
> This is an ancient room, long under water. There is an exit to the south and a staircase leading up.

---

## Canyon Bottom (`canyon-bottom`) — **identical**

**Canonical:**
> You are beneath the walls of the river canyon which may be climbable here. The lesser part of the runoff of Aragain Falls flows by below. To the north is a narrow path.

**Current:**
> You are beneath the walls of the river canyon which may be climbable here. The lesser part of the runoff of Aragain Falls flows by below. To the north is a narrow path.

---

## Canyon View (`canyon-view`) — **identical**

**Canonical:**
> You are at the top of the Great Canyon on its west wall. From here there is a marvelous view of the canyon and parts of the Frigid River upstream. Across the canyon, the walls of the White Cliffs join the mighty ramparts of the Flathead Mountains to the east. Following the Canyon upstream to the north, Aragain Falls may be seen, complete with rainbow. The mighty Frigid River flows out from a great dark cavern. To the west and south can be seen an immense forest, stretching for miles around. A path leads northwest. It is possible to climb down into the canyon from here.

**Current:**
> You are at the top of the Great Canyon on its west wall. From here there is a marvelous view of the canyon and parts of the Frigid River upstream. Across the canyon, the walls of the White Cliffs join the mighty ramparts of the Flathead Mountains to the east. Following the Canyon upstream to the north, Aragain Falls may be seen, complete with rainbow. The mighty Frigid River flows out from a great dark cavern. To the west and south can be seen an immense forest, stretching for miles around. A path leads northwest. It is possible to climb down into the canyon from here.

---

## Cellar (`cellar`) — **identical**

**Canonical:**
> You are in a dark and damp cellar with a narrow passageway leading north, and a crawlway to the south. On the west is the bottom of a steep metal ramp which is unclimbable.

**Current:**
> You are in a dark and damp cellar with a narrow passageway leading north, and a crawlway to the south. On the west is the bottom of a steep metal ramp which is unclimbable.

---

## Chasm (`chasm-room`) — **identical**

**Canonical:**
> A chasm runs southwest to northeast and the path follows it. You are on the south side of the chasm, where a crack opens into a passage.

**Current:**
> A chasm runs southwest to northeast and the path follows it. You are on the south side of the chasm, where a crack opens into a passage.

---

## Clearing (`clearing`) — **identical**

**Canonical:**
> You are in a small clearing in a well marked forest path that extends to the east and west.

**Current:**
> You are in a small clearing in a well marked forest path that extends to the east and west.

---

## Rocky Ledge (`cliff-middle`) — **identical**

**Canonical:**
> You are on a ledge about halfway up the wall of the river canyon. You can see from here that the main flow from Aragain Falls twists along a passage which it is impossible for you to enter. Below you is the canyon bottom. Above you is more cliff, which appears climbable.

**Current:**
> You are on a ledge about halfway up the wall of the river canyon. You can see from here that the main flow from Aragain Falls twists along a passage which it is impossible for you to enter. Below you is the canyon bottom. Above you is more cliff, which appears climbable.

---

## Cold Passage (`cold-passage`) — **identical**

**Canonical:**
> This is a cold and damp corridor where a long east-west passageway turns into a southward path.

**Current:**
> This is a cold and damp corridor where a long east-west passageway turns into a southward path.

---

## Dead End (`dead-end-5`) — **identical**

**Canonical:**
> You have come to a dead end in the mine.

**Current:**
> You have come to a dead end in the mine.

---

## Dome Room (`dome-room`) — **identical**

**Canonical:**
> You are at the periphery of a large dome, which forms the ceiling of another room below. Protecting you from a precipitous drop is a wooden railing which circles the dome.

**Current:**
> You are at the periphery of a large dome, which forms the ceiling of another room below. Protecting you from a precipitous drop is a wooden railing which circles the dome.

---

## East of Chasm (`east-of-chasm`) — **identical**

**Canonical:**
> You are on the east edge of a chasm, the bottom of which cannot be seen. A narrow passage goes north, and the path you are on continues to the east.

**Current:**
> You are on the east edge of a chasm, the bottom of which cannot be seen. A narrow passage goes north, and the path you are on continues to the east.

---

## End of Rainbow (`end-of-rainbow`) — **identical**

**Canonical:**
> You are on a small, rocky beach on the continuation of the Frigid River past the Falls. The beach is narrow due to the presence of the White Cliffs. The river canyon opens here and sunlight shines in from above. A rainbow crosses over the falls to the east and a narrow path continues to the southwest.

**Current:**
> You are on a small, rocky beach on the continuation of the Frigid River past the Falls. The beach is narrow due to the presence of the White Cliffs. The river canyon opens here and sunlight shines in from above. A rainbow crosses over the falls to the east and a narrow path continues to the southwest.

---

## Engravings Cave (`engravings-cave`) — **identical**

**Canonical:**
> You have entered a low cave with passages leading northwest and east.

**Current:**
> You have entered a low cave with passages leading northwest and east.

---

## East-West Passage (`ew-passage`) — **identical**

**Canonical:**
> This is a narrow east-west passageway. There is a narrow stairway leading down at the north end of the room.

**Current:**
> This is a narrow east-west passageway. There is a narrow stairway leading down at the north end of the room.

---

## Forest (`forest-1`) — **identical**

**Canonical:**
> This is a forest, with trees in all directions. To the east, there appears to be sunlight.

**Current:**
> This is a forest, with trees in all directions. To the east, there appears to be sunlight.

---

## Gas Room (`gas-room`) — **identical**

**Canonical:**
> This is a small room which smells strongly of coal gas. There is a short climb up some stairs and a narrow tunnel leading east.

**Current:**
> This is a small room which smells strongly of coal gas. There is a short climb up some stairs and a narrow tunnel leading east.

---

## Ladder Bottom (`ladder-bottom`) — **identical**

**Canonical:**
> This is a rather wide room. On one side is the bottom of a narrow wooden ladder. To the west and the south are passages leaving the room.

**Current:**
> This is a rather wide room. On one side is the bottom of a narrow wooden ladder. To the west and the south are passages leaving the room.

---

## Ladder Top (`ladder-top`) — **identical**

**Canonical:**
> This is a very small room. In the corner is a rickety wooden ladder, leading downward. It might be safe to descend. There is also a staircase leading upward.

**Current:**
> This is a very small room. In the corner is a rickety wooden ladder, leading downward. It might be safe to descend. There is also a staircase leading upward.

---

## Maintenance Room (`maintenance-room`) — **identical**

**Canonical:**
> This is what appears to have been the maintenance room for Flood Control Dam #3. Apparently, this room has been ransacked recently, for most of the valuable equipment is gone. On the wall in front of you is a group of buttons colored blue, yellow, brown, and red. There are doorways to the west and south.

**Current:**
> This is what appears to have been the maintenance room for Flood Control Dam #3. Apparently, this room has been ransacked recently, for most of the valuable equipment is gone. On the wall in front of you is a group of buttons colored blue, yellow, brown, and red. There are doorways to the west and south.

---

## Maze (`maze-1`) — **identical**

**Canonical:**
> This is part of a maze of twisty little passages, all alike.

**Current:**
> This is part of a maze of twisty little passages, all alike.

---

## Maze (`maze-10`) — **identical**

**Canonical:**
> This is part of a maze of twisty little passages, all alike.

**Current:**
> This is part of a maze of twisty little passages, all alike.

---

## Maze (`maze-11`) — **identical**

**Canonical:**
> This is part of a maze of twisty little passages, all alike.

**Current:**
> This is part of a maze of twisty little passages, all alike.

---

## Maze (`maze-12`) — **identical**

**Canonical:**
> This is part of a maze of twisty little passages, all alike.

**Current:**
> This is part of a maze of twisty little passages, all alike.

---

## Maze (`maze-13`) — **identical**

**Canonical:**
> This is part of a maze of twisty little passages, all alike.

**Current:**
> This is part of a maze of twisty little passages, all alike.

---

## Maze (`maze-14`) — **identical**

**Canonical:**
> This is part of a maze of twisty little passages, all alike.

**Current:**
> This is part of a maze of twisty little passages, all alike.

---

## Maze (`maze-15`) — **identical**

**Canonical:**
> This is part of a maze of twisty little passages, all alike.

**Current:**
> This is part of a maze of twisty little passages, all alike.

---

## Maze (`maze-2`) — **identical**

**Canonical:**
> This is part of a maze of twisty little passages, all alike.

**Current:**
> This is part of a maze of twisty little passages, all alike.

---

## Maze (`maze-3`) — **identical**

**Canonical:**
> This is part of a maze of twisty little passages, all alike.

**Current:**
> This is part of a maze of twisty little passages, all alike.

---

## Maze (`maze-4`) — **identical**

**Canonical:**
> This is part of a maze of twisty little passages, all alike.

**Current:**
> This is part of a maze of twisty little passages, all alike.

---

## Maze (`maze-6`) — **identical**

**Canonical:**
> This is part of a maze of twisty little passages, all alike.

**Current:**
> This is part of a maze of twisty little passages, all alike.

---

## Maze (`maze-7`) — **identical**

**Canonical:**
> This is part of a maze of twisty little passages, all alike.

**Current:**
> This is part of a maze of twisty little passages, all alike.

---

## Maze (`maze-8`) — **identical**

**Canonical:**
> This is part of a maze of twisty little passages, all alike.

**Current:**
> This is part of a maze of twisty little passages, all alike.

---

## Maze (`maze-9`) — **identical**

**Canonical:**
> This is part of a maze of twisty little passages, all alike.

**Current:**
> This is part of a maze of twisty little passages, all alike.

---

## Mine Entrance (`mine-entrance`) — **identical**

**Canonical:**
> You are standing at the entrance of what might have been a coal mine. The shaft enters the west wall, and there is another exit on the south end of the room.

**Current:**
> You are standing at the entrance of what might have been a coal mine. The shaft enters the west wall, and there is another exit on the south end of the room.

---

## Mirror Room (`mirror-room-1`) — **identical**

**Canonical:**
> You are in a large square room with tall ceilings. On the south wall is an enormous mirror which fills the entire wall. There are exits on the other three sides of the room.

**Current:**
> You are in a large square room with tall ceilings. On the south wall is an enormous mirror which fills the entire wall. There are exits on the other three sides of the room.

---

## Mirror Room (`mirror-room-2`) — **identical**

**Canonical:**
> You are in a large square room with tall ceilings. On the south wall is an enormous mirror which fills the entire wall. There are exits on the other three sides of the room.

**Current:**
> You are in a large square room with tall ceilings. On the south wall is an enormous mirror which fills the entire wall. There are exits on the other three sides of the room.

---

## North of House (`north-of-house`) — **identical**

**Canonical:**
> You are facing the north side of a white house. There is no door here, and all the windows are boarded up. To the north a narrow path winds through the trees.

**Current:**
> You are facing the north side of a white house. There is no door here, and all the windows are boarded up. To the north a narrow path winds through the trees.

---

## Temple (`north-temple`) — **identical**

**Canonical:**
> This is the north end of a large temple. On the east wall is an ancient inscription, probably a prayer in a long-forgotten language. Below the prayer is a staircase leading down. The west wall is solid granite. The exit to the north end of the room is through huge marble pillars.

**Current:**
> This is the north end of a large temple. On the east wall is an ancient inscription, probably a prayer in a long-forgotten language. Below the prayer is a staircase leading down. The west wall is solid granite. The exit to the north end of the room is through huge marble pillars.

---

## Forest Path (`path`) — **identical**

**Canonical:**
> This is a path winding through a dimly lit forest. The path heads north-south here. One particularly large tree with some low branches stands at the edge of the path.

**Current:**
> This is a path winding through a dimly lit forest. The path heads north-south here. One particularly large tree with some low branches stands at the edge of the path.

---

## Round Room (`round-room`) — **identical**

**Canonical:**
> This is a circular stone room with passages in all directions. Several of them have unfortunately been blocked by cave-ins.

**Current:**
> This is a circular stone room with passages in all directions. Several of them have unfortunately been blocked by cave-ins.

---

## Shore (`shore`) — **identical**

**Canonical:**
> You are on the east shore of the river. The water here seems somewhat treacherous. A path travels from north to south here, the south end quickly turning around a sharp corner.

**Current:**
> You are on the east shore of the river. The water here seems somewhat treacherous. A path travels from north to south here, the south end quickly turning around a sharp corner.

---

## Slide Room (`slide-room`) — **identical**

**Canonical:**
> This is a small chamber, which appears to have been part of a coal mine. On the south wall of the chamber the letters "Granite Wall" are etched in the rock. To the east is a long passage, and there is a steep metal slide twisting downward. To the north is a small opening.

**Current:**
> This is a small chamber, which appears to have been part of a coal mine. On the south wall of the chamber the letters "Granite Wall" are etched in the rock. To the east is a long passage, and there is a steep metal slide twisting downward. To the north is a small opening.

---

## South of House (`south-of-house`) — **identical**

**Canonical:**
> You are facing the south side of a white house. There is no door here, and all the windows are boarded.

**Current:**
> You are facing the south side of a white house. There is no door here, and all the windows are boarded.

---

## Altar (`south-temple`) — **identical**

**Canonical:**
> This is the south end of a large temple. In front of you is what appears to be an altar. In one corner is a small hole in the floor which leads into darkness. You probably could not get back up it.

**Current:**
> This is the south end of a large temple. In front of you is what appears to be an altar. In one corner is a small hole in the floor which leads into darkness. You probably could not get back up it.

---

## Squeaky Room (`squeeky-room`) — **identical**

**Canonical:**
> You are in a small room. Strange squeaky sounds may be heard coming from the passage at the north end. You may also escape to the east.

**Current:**
> You are in a small room. Strange squeaky sounds may be heard coming from the passage at the north end. You may also escape to the east.

---

## Strange Passage (`strange-passage`) — **identical**

**Canonical:**
> This is a long passage. To the west is one entrance. On the east there is an old wooden door, with a large opening in it (about cyclops sized).

**Current:**
> This is a long passage. To the west is one entrance. On the east there is an old wooden door, with a large opening in it (about cyclops sized).

---

## Timber Room (`timber-room`) — **identical**

**Canonical:**
> This is a long and narrow passage, which is cluttered with broken timbers. A wide passage comes from the east and turns at the west end of the room into a very narrow passageway. From the west comes a strong draft.

**Current:**
> This is a long and narrow passage, which is cluttered with broken timbers. A wide passage comes from the east and turns at the west end of the room into a very narrow passageway. From the west comes a strong draft.

---

## Cave (`tiny-cave`) — **identical**

**Canonical:**
> This is a tiny cave with entrances west and north, and a dark, forbidding staircase leading down.

**Current:**
> This is a tiny cave with entrances west and north, and a dark, forbidding staircase leading down.

---

## Torch Room (`torch-room`) — **identical**

**Canonical:**
> This is a large room with a prominent doorway leading to a down staircase. Above you is a large dome. Up around the edge of the dome (20 feet up) is a wooden railing. In the center of the room sits a white marble pedestal.

**Current:**
> This is a large room with a prominent doorway leading to a down staircase. Above you is a large dome. Up around the edge of the dome (20 feet up) is a wooden railing. In the center of the room sits a white marble pedestal.

---

## West of House (`west-of-house`) — **identical**

**Canonical:**
> You are standing in an open field west of a white house, with a boarded front door.

**Current:**
> You are standing in an open field west of a white house, with a boarded front door.

---

## Damp Cave (`damp-cave`) — **missing-canonical**

*Room not visited in walkthrough2.txt — fall back to ZIL or keep extracted text.*

**Canonical:** _(not in walkthrough2.txt)_

**Current:**
> This cave has exits to the west and east, and narrows to a crack toward the south. The earth is particularly damp here.

---

## Stream (`in-stream`) — **missing-canonical**

*Room not visited in walkthrough2.txt — fall back to ZIL or keep extracted text.*

**Canonical:** _(not in walkthrough2.txt)_

**Current:**
> You are on the gently flowing stream. The upstream route is too narrow to navigate, and the downstream route is invisible due to twisting walls. There is a narrow beach to land on.

---

## Narrow Passage (`narrow-passage`) — **missing-canonical**

*Room not visited in walkthrough2.txt — fall back to ZIL or keep extracted text.*

**Canonical:** _(not in walkthrough2.txt)_

**Current:**
> This is a long and narrow corridor where a long north-south passageway briefly narrows even further.

---

## North-South Passage (`ns-passage`) — **missing-canonical**

*Room not visited in walkthrough2.txt — fall back to ZIL or keep extracted text.*

**Canonical:** _(not in walkthrough2.txt)_

**Current:**
> This is a high north-south passage, which forks to the northeast.

---

## On the Rainbow (`on-rainbow`) — **missing-canonical**

*Room not visited in walkthrough2.txt — fall back to ZIL or keep extracted text.*

**Canonical:** _(not in walkthrough2.txt)_

**Current:**
> You are on top of a rainbow (I bet you never thought you would walk on a rainbow), with a magnificent view of the Falls. The rainbow travels east-west here.

---

## Frigid River (`river-1`) — **missing-canonical**

*Room not visited in walkthrough2.txt — fall back to ZIL or keep extracted text.*

**Canonical:** _(not in walkthrough2.txt)_

**Current:**
> You are on the Frigid River in the vicinity of the Dam. The river flows quietly here. There is a landing on the west shore.

---

## Frigid River (`river-2`) — **missing-canonical**

*Room not visited in walkthrough2.txt — fall back to ZIL or keep extracted text.*

**Canonical:** _(not in walkthrough2.txt)_

**Current:**
> The river turns a corner here making it impossible to see the Dam. The White Cliffs loom on the east bank and large rocks prevent landing on the west.

---

## Frigid River (`river-3`) — **missing-canonical**

*Room not visited in walkthrough2.txt — fall back to ZIL or keep extracted text.*

**Canonical:** _(not in walkthrough2.txt)_

**Current:**
> The river descends here into a valley. There is a narrow beach on the west shore below the cliffs. In the distance a faint rumbling can be heard.

---

## Frigid River (`river-4`) — **missing-canonical**

*Room not visited in walkthrough2.txt — fall back to ZIL or keep extracted text.*

**Canonical:** _(not in walkthrough2.txt)_

**Current:**
> The river is running faster here and the sound ahead appears to be that of rushing water. On the east shore is a sandy beach. A small area of beach can also be seen below the cliffs on the west shore.

---

## Frigid River (`river-5`) — **missing-canonical**

*Room not visited in walkthrough2.txt — fall back to ZIL or keep extracted text.*

**Canonical:** _(not in walkthrough2.txt)_

**Current:**
> The sound of rushing water is nearly unbearable here. On the east shore is a large landing area.

---

## Stone Barrow (`stone-barrow`) — **missing-canonical**

*Room not visited in walkthrough2.txt — fall back to ZIL or keep extracted text.*

**Canonical:** _(not in walkthrough2.txt)_

**Current:**
> You are standing in front of a massive barrow of stone. In the east face is a huge stone door which is open. You cannot see into the dark of the tomb.

---

## Stream View (`stream-view`) — **missing-canonical**

*Room not visited in walkthrough2.txt — fall back to ZIL or keep extracted text.*

**Canonical:** _(not in walkthrough2.txt)_

**Current:**
> You are standing on a path beside a gently flowing stream. The path follows the stream, which flows from west to east.

---

## Studio (`studio`) — **missing-canonical**

*Room not visited in walkthrough2.txt — fall back to ZIL or keep extracted text.*

**Canonical:** _(not in walkthrough2.txt)_

**Current:**
> This appears to have been an artist's studio. The walls and floors are splattered with paints of 69 different colors. Strangely enough, nothing of value is hanging here. At the south end of the room is an open door (also covered with paint). A dark and narrow chimney leads up from a fireplace; although you might be able to get up it, it seems unlikely you could get back down.

---

## Twisting Passage (`twisting-passage`) — **missing-canonical**

*Room not visited in walkthrough2.txt — fall back to ZIL or keep extracted text.*

**Canonical:** _(not in walkthrough2.txt)_

**Current:**
> This is a winding passage. It seems that there are only exits on the east and north.

---

## White Cliffs Beach (`white-cliffs-north`) — **missing-canonical**

*Room not visited in walkthrough2.txt — fall back to ZIL or keep extracted text.*

**Canonical:** _(not in walkthrough2.txt)_

**Current:**
> You are on a narrow strip of beach which runs along the base of the White Cliffs. There is a narrow path heading south along the Cliffs and a tight passage leading west into the cliffs themselves.

---

## White Cliffs Beach (`white-cliffs-south`) — **missing-canonical**

*Room not visited in walkthrough2.txt — fall back to ZIL or keep extracted text.*

**Canonical:** _(not in walkthrough2.txt)_

**Current:**
> You are on a rocky, narrow strip of beach beside the Cliffs. A narrow path leads north along the shore.

---

## Winding Passage (`winding-passage`) — **missing-canonical**

*Room not visited in walkthrough2.txt — fall back to ZIL or keep extracted text.*

**Canonical:** _(not in walkthrough2.txt)_

**Current:**
> This is a winding passage. It seems that there are only exits on the east and north.

---
