# Navigation Game — Game Design Document

2026-10-15 · @Devan

## Overview

This is a mobile-first browser game where beginners learn land navigation by doing it in a blocky 3D forest. Every mission follows the real field flow: prepare, orient the map, find your position, then travel by navigasi terbuka (navter) or navigasi tertutup (navtup).

- **Audience:** beginners with no field experience.
- **Platform:** mobile browser first, also playable on desktop.
- **Style:** a Minecraft-like voxel world. Blocks make hills, valleys (lembahan) and ridges (punggungan) easy to read. The world and the map can also be generated from the same height data, so the map is always true to the ground.
- **Source of truth:** *Rangkuman Materi Navigasi Darat*, PPA Jamadagni. Anything the game adds beyond that material is marked as an addition (section "Additions beyond the material").
- **Core design rule:** the map is a real tool, not a minimap. There is no "you are here" dot. Players only know where they are after they work it out, exactly as in the field.

## Learning goals

Each concept from the material maps to something the player must actually do in the game, not just read.

| Concept (from material) | What the material says | How the game teaches it |
|---|---|---|
| Tools | Map, compass, plotting tools (ruler, 360° protractor, pencil, eraser, sharpener) | Packing checklist before each mission. A missing tool disables its action in the field. |
| Coordinates | Position on the map; written latitude first, then longitude (e.g. 37′40″ LS, 24′19″ BT); 1 minute = 60 seconds | Briefing gives the destination as coordinates. The player finds and marks it on the map. |
| Scale | Map distance × scale = real distance (3 cm at 1:25,000 = 750 m) | Ruler tool on the map. Distances must be converted to plan the route and the pace count. |
| Contours | Imaginary lines of equal height, 12.5 m interval | The map is drawn from the world's real heights, so contours match the hills the player sees. |
| Lembahan / punggungan | Valley: contours curve toward the peak. Ridge: contours curve away from it | Terrain-reading questions, and route choices that depend on them. |
| Karvak | Grid square bounded by two horizontal and two vertical lines | Map grid used to describe and find positions. |
| Titik ekstrem | Easy-to-recognize features: natural features, buildings, road bends, junctions | Landmarks in the world that also appear as symbols on the map. |
| Utarakan peta | Align the map with the terrain | Rotate the map until its north matches the compass. |
| Resection | Find your own position from at least two known, visible landmarks, using back azimuth | Sight two landmarks, compute back azimuths, draw lines, read the crossing point. |
| Back azimuth | Under 180°: +180°. Over 180°: −180°. Exactly 180°: 0° | The player types the value; the game checks it. |
| Intersection | Find an object's position from two known observation points, using azimuth | Locate a target (smoke, crash site, cabin) from two known points. |
| Navtup | Used when no titik ekstrem is visible, e.g. dense forest | Dense-forest zones where landmarks are hidden and resection is impossible. |
| Kunci kompas + roles | Compasman keeps the bearing; penerabas, sweeper and stringlineman support | The player leads a 4-person team on a locked bearing. |

## Core loop

A mission starts in navter (navbuk). When the route leads into woods where no landmark will be visible, the player stops at the last spot where landmarks can still be seen, does a final resection there, and continues in navtup on a locked bearing.

*[Diagram: mission flow · shared start, navter and navtup branches]*

Navter loops back to a position check at every crossroad (matching the junction to the map). Navtup has no such loop, because there is nothing to sight, so the team relies on the locked bearing and the pace count.

## World design

The world and the map come from one seeded heightmap, so every contour, ridge and valley on the map exists in the world at the same place.

**Proposed scale** (adjustable):

- 1 block = 2.5 m, horizontally and vertically.
- The 12.5 m contour interval = 5 blocks of height, easy to count while walking.
- Map scale 1:25,000, so 1 cm on the map = 250 m = 100 blocks.
- A world of 1.5 × 1.5 km = 600 × 600 blocks, loaded in chunks. (First built at 2 × 2 km; playtests showed a lesson must fit a 45-minute class, so the world was narrowed, walking made brisker than real life, and every open hilltop carries a triangulation pillar so each hill seen in the field is a titik ekstrem on the map.)

**Terrain features to include:**

- Peaks and saddles, lembahan and punggungan, rivers and river junctions.
- A trail and road network with bends and crossroads, used for navter routes.
- Titik ekstrem: peaks (puncak, including a named summit in the far corner from the forest), a radio tower, a hut, a bridge, road bends, junctions. Each one appears on the map with its own symbol. Trees are not titik ekstrem.
- Summit forest: a wedge of dense young forest on one flank of Puncak Pasir Malang, from just below its open summit down to the end of a dead-end footpath (level 5). The path end is chosen so two or three titik ekstrem are in view there for a resection, the summit is hidden behind the trees, and the straight line up is dry and climbable.
- Roads (jalan): the through-route from the west edge over both crossroads and the bridge to the south edge is a road, wider than a footpath, with a gravel surface in the world and a double line on the map. The branches stay footpaths (jalan setapak). The road gives a clear line to plan a navter route along.

**Visibility is the switch between the two navigation types:**

| Zone | Vegetation | View distance | What works |
|---|---|---|---|
| Open terrain (navter) | Grass, scattered trees, ridgelines | Far, light haze | Landmarks visible; resection and intersection work |
| Dense forest (navtup) | Thick trees and undergrowth blocks | Short, heavy fog under the canopy | No landmark can be sighted; only kunci kompas works |

The compass sighting checks real line of sight. A landmark can only be sighted if it is actually visible from where the player stands. This teaches *why* resection is impossible in navtup instead of just stating it.

## Player character

The player and every team member wear the PPA Jamadagni Bandung field outfit: a flannel shirt, denim jeans, and the organization scarf with its logo.

**Outfit:**

| Item | Look | Voxel detail |
|---|---|---|
| Flannel shirt | Long-sleeve plaid flannel | Checked pattern on the torso and arms; sleeve cuffs visible in first-person view |
| Denim jeans | Blue denim | Two-tone blue on the legs, darker seam line |
| Scarf | Bright blue triangle with a yellow border | Drapes over both shoulders; the point hangs down the back; the two ends are tied in one knot at the chest and hang down the front |
| Logo patch | Orange pentagon badge on the scarf's back point | Small pixel badge, readable in third-person view |

**Scarf, as worn in the reference photos:**

- Folded into a triangle and laid over the shoulders, with the wide side around the neck.
- The back point hangs between the shoulder blades, with the logo patch near the tip.
- The two front ends cross at the chest and are tied in a single loose knot below the collar, then hang down to about belt level.
- The yellow border is clearly visible on every edge, front and back.

**Logo: Perhimpunan Penjelajah Alam Jamadagni Bandung**

- Orange pentagon background.
- A red circle holding a ring of yellow petal shapes.
- A blue triangle in the centre with a white V mark.
- A white ring with the text "PERHIMPUNAN PENJELAJAH ALAM" around the top and "JAMADAGNI BANDUNG" around the bottom.

At voxel scale, the text cannot be read on the character. Use the full logo image on the title screen, the loading screen and the mission briefing. On the character, use a simplified pixel badge: orange pentagon, red-and-yellow ring, blue triangle.

**Approximate palette** (sampled by eye from the photos; adjust to the real fabric):

| Part | Colour |
|---|---|
| Scarf body | Bright blue, about #1E8FD5 |
| Scarf border | Yellow, about #F5D21E |
| Logo pentagon | Orange, about #EF8A1C |
| Logo ring background | Red, about #E0242B |
| Logo petals | Yellow, about #F7E61A |
| Logo centre triangle | Blue, about #2F8FD8 |
| Jeans | Mid denim blue, about #3E5F8A |

**Telling the team apart in navtup:** all four wear the same outfit, so roles are shown by what each carries. Penerabas holds a golok, sweeper a small rake or brush, compasman a raised compass, stringlineman a string spool. A different flannel colour per role is an option if they are still hard to tell apart on a small screen.

**Views:** the game is played in first person, so the player mostly sees flannel sleeves and hands holding the compass or map. A Kamera button switches the field view to third person (behind the player); raising the compass always returns to the eye. A turning character on the briefing and debrief screens shows the full outfit, the face, and the scarf from the back.

**Assets for Claude Code:** put the logo image in the project as `assets/logo-jamadagni.png` and the scarf photos in `docs/reference/`. Ask it to build the character as simple blocky body parts (like a Minecraft player model) with the textures above.

## Tools and UI

Every real tool from the preparation list is an in-game tool with one clear job. Nothing is done automatically for the player.

| Tool | In-game function | Phone interaction |
|---|---|---|
| Compass | Sight a landmark and read its azimuth; lock a bearing for navtup | Hold the compass button to raise it to eye level, aim the crosshair, release to record the reading |
| Map | Topographic map with contours, karvak grid, coordinates, landmark symbols, legend | Full-screen view; pinch to zoom, two-finger twist to rotate |
| Busur 360° (protractor) | Transfer an azimuth to the map and draw a line from a point | Drop it on a point, drag to the angle, tap to draw the line |
| Ruler | Measure map distance; convert with the scale | Drag between two points; shows cm, and the player converts to metres |
| Pencil + eraser | Mark points, draw routes and bearing lines; erase mistakes | Draw and erase modes on the map |
| Clipboard | Holds the map steady once it is oriented | "Lock orientation" toggle so the map stays aligned while walking |
| Pouch (zipper bag) | Inventory for all the tools | Packing screen before each mission |
| Field notebook (addition) | Logs recorded azimuths, pace counts and checkpoints | Auto-filled list the player can review |
| Golok tebas | Penerabas clears vegetation blocks in navtup | Used by the team NPC, or by the player when in that role |
| Stringline | Marks the path taken in navtup | Placed by the stringlineman; visible as a line in the world |

## Phase A: Preparation

Every mission starts at base camp with the same three preparation steps from the real flow.

1. **Pack the tools.** The player drags items into the pouch: compass, protractor, map, ruler, pen, pencil, eraser, clipboard. Forgetting an item is allowed, but that action is unavailable in the field (no ruler = no distance measurement). The mission debrief points out what was missing.
2. **Map knowledge check.** Short tasks before leaving, drawn from the material:
    - Read the coordinates of a marked point, latitude first, then longitude.
    - Convert a ruler measurement to metres using the scale.
    - Identify a lembahan or punggungan from the contour shape.
    - Name the karvak a point sits in.
3. **Set the destination.** The briefing gives the destination as coordinates (or as an object to locate). The player must find it on the map and mark it with the pencil before the mission starts.

In early levels these are guided tutorials. In later levels they are quick checks, so experienced players are not slowed down.

## Phase B1: Navigasi terbuka (navter)

In navter, landmarks are visible, so the player fixes their position by resection, follows a track, and checks their position at every crossroad to confirm they are on the right path.

**1. Utarakan peta.** Take a compass reading, then rotate the map until its north arrow matches compass north. The game shows how many degrees off the map is; it counts as oriented within a small tolerance.

**2. Orientasi medan.** Look around and match what is seen to the map. The player taps a landmark in the world, then taps its symbol on the map to pair them. Wrong pairs are allowed and lead to a wrong fix later, which is the lesson.

**3. Resection: find where I am.**

1. Pick at least two paired landmarks.
2. Sight each with the compass and record its azimuth.
3. Compute each back azimuth by hand. The game checks it against the rule from the material: add 180° if under 180°, subtract 180° if over 180°, and 0° if exactly 180°.
4. Place the protractor on each landmark's map symbol and draw a line along its back azimuth.
5. Where the lines cross is the player's position. Mark it.

The game then reveals the true position and the error in metres. A tip appears when the two landmarks are close together in direction, because lines crossing at a narrow angle give a weak fix.

**4. Plan the track.** Draw the route along trails from the fixed position to the destination, noting each crossroad on the way.

**5. Walk and check at every crossroad.** Each crossroad is a checkpoint. A junction is already on the map, so no resection is needed: the player stops, counts the branches, sights the branch directions, and marks on the map which junction this is (Cek persimpangan). The check is scored in the debrief by whether the right junction was marked. Checking a junction restarts the pace count. Skipping a check is allowed; a wrong branch is only discovered at the next check (see "Error recovery").

**5a. Arrive at the destination.** The destination is a physical post (pos). Where no feature marks the last stretch, the player measures the distance from the last crossroad on the map and paces it off, then reports arrival (Lapor tiba). Reporting away from the post is refused and costs points.

**6. Intersection missions: find where something is.** The briefing describes an object seen from the field, such as smoke from a fire, a crash site, or a hut.

1. From a first observation point with known coordinates, sight the object and record its azimuth.
2. Draw that azimuth (not the back azimuth) from the observation point on the map.
3. Walk to a second known observation point and repeat.
4. The crossing point is the object. Mark it and report its coordinates.

Resection = find myself. Intersection = find the object. The game repeats this contrast on the debrief screen.

## Phase B2: Navigasi tertutup (navtup)

In navtup, no landmark is visible, so resection is impossible. The team plots one straight line on the map, locks the compass on its bearing, and cuts straight through the forest to the target.

**Entering navtup.** Navtup does not start from scratch; it starts where navter ends. The player walks in navter toward the destination until the route leads into woods where no landmark will be visible. They stop at the last spot where landmarks can still be seen, do a final resection there, then plot and lock a bearing from that exact spot to the target and go straight. Inside the woods, the compass sighting finds nothing to aim at; the game shows why: "No titik ekstrem visible." Entering the woods without that final resection is allowed, but the bearing then starts from an unknown point, and the debrief shows how far off the team ended up.

**Steps (in the material's order):**

1. **Utarakan peta.**
2. **Orientasi medan:** note the direction of travel and what lies ahead.
3. **Analisis kontur:** read the slopes, valleys, ridges and rivers on the line. The player decides if the straight line is passable.
4. **Plotting:** draw a straight line from the final resection point to the target. Measure its azimuth with the protractor and its length with the ruler.
5. **Kunci kompas:** set the bearing on the compass. It stays locked for the whole leg.
6. **Atur posisi tim:** place the four team members.
7. **Mulai menerabas:** move forward on the bearing.

**The four roles:**

| Role | Job (from material) | In the game |
|---|---|---|
| Compasman | Locks the compass and keeps the penerabas moving straight on the bearing | Default player role. Watches the bearing gauge and directs the penerabas: "left", "right", "straight". |
| Penerabas | Cuts through trees and obstacles toward the target | NPC that clears vegetation blocks wherever the compasman points. A bad direction means a crooked path. |
| Sweeper | Clears leftover vegetation still blocking the path | NPC that widens the cut; a skipped sweep slows the team. |
| Stringlineman | Places stringline markers along the path | NPC that leaves a visible line. The player can follow it back if they need to retreat. |

**Level 5, the summit climb.** The team starts at the end of the footpath below Puncak Pasir Malang and must reach the summit, which the young forest hides. The flow is short: resection at the path end, kunci kompas on the summit, then move. The compasman cannot walk on his own: before each move the player sets a number of steps, and the team walks them on the locked bearing. The penerabas stops at every young tree on the line and fells it with the golok; the sweeper behind the compasman pushes the felled trees off the lane; the swept lane is left as bare earth back to the path, and the stringlineman's posts run along it. The player repeats moves until the team comes out on the summit.

Later levels let the player switch roles, so they understand what each person needs from the compasman. The leg ends when the paced distance is reached (see "Pacing" below); the player then checks they have arrived at the target.

## Additions beyond the material

These three topics are not in the PPA Jamadagni summary but cause common beginner mistakes. Level 5 was reworked into the summit climb (resection, kunci kompas, move), so it no longer runs the pace calibration, the declination exercise or the detour; pacing still matters there, because each move is a step count. Check each topic against your instructors' practice before teaching it.

### 1. Magnetic declination

The compass points to magnetic north, while the map's grid points to grid north. The angle between them is the declination, shown in the map legend.

- **Game rule:** every level currently uses 0° declination. The game still supports a non-zero value in the legend (every azimuth must then be corrected when moving between compass and map), for a future level.
- **Why it matters, shown in game:** after a 1 km leg, a 1° error puts the player about 17 m off target; a 5° error, about 87 m. The game draws the drift on the map after the leg.
- **Note for Indonesia:** real declination is small (around 1° or less in much of the country), so the practice level may use an exaggerated value to make the effect visible. Say so on screen.

### 2. Pacing (distance by step count)

In navtup there are no landmarks to confirm progress, so distance must be counted.

- **Calibration:** the player's pace count (steps per 100 m) defaults to 133, a 0.75 m stride on flat ground. A recorded calibration from an earlier version of the game is still used if present.
- **In navtup:** the player converts the plotted map distance to metres, then to a target pace count (in level 5, the step count of each move). A tally counter on screen tracks progress, like pace beads.
- **Terrain effect:** uphill slopes and thick vegetation shorten each step, so the same 100 m takes more steps. The game models this, and the debrief shows how far off the count was.

### 3. Error recovery

The game lets players make mistakes and teaches what to do next.

- **Navter, wrong branch at a crossroad:** the next junction doesn't match the plan (wrong number or direction of branches). The player stops, fixes their real position, then either returns to the last confirmed crossroad or re-plans from where they are.
- **Navtup, obstacle on the bearing** (cliff, river, swamp): the player detours around it while keeping the bearing. Turn 90°, pace a set distance; turn back to the bearing and pace past the obstacle; turn 90° the other way and pace the same distance back; resume the original bearing. Steps paced along the bearing still count toward the leg.
- **Navtup, nothing found at the end of the leg:** the player searches in a small pattern around the expected point, or follows the stringline back to the last confirmed position and tries again.

## Progression and levels

Six levels introduce the skills in field order and end with a combined navter-to-navtup mission. Missions that repeated an earlier one were merged so a full run fits a class: orienting is part of the resection level.

| Level | Focus | New mechanic | Pass condition |
|---|---|---|---|
| 1 | Base camp | Packing, coordinates, scale, contours, karvak | All map checks correct |
| 2 | Orienting and resection | Utarakan peta, orientasi medan, compass sighting, back azimuth, line drawing | Map oriented; position error under a set distance |
| 3 | Intersection | Azimuth from two known points | Object located within a set distance |
| 4 | Navter route | Track planning, crossroad checks | Report arrival at the post; every crossroad identified correctly |
| 5 | Navtup: the summit climb | Resection at the end of a footpath, kunci kompas on a hidden summit, moves by step count, penerabas felling trees, sweeper clearing the lane | Reach the summit; resection error under 100 m |
| 6 | Final mission | Open terrain to forest edge, then navtup to target | Full flow completed, with a final score |

**Scoring:** position error in metres, accuracy of each azimuth, and time. Checking position is never penalized, because frequent checking is the habit the game is teaching.

## Mobile controls and technical notes

The game must run smoothly on a mid-range Android phone in the browser, so the world stays small and the visuals stay simple.

**Controls (landscape):**

- Left thumb: virtual joystick to walk.
- Right thumb: drag to look around.
- Buttons: Compass, Map, Tools, Notebook. Holding Compass enters sighting mode with a crosshair and a live azimuth readout. The needle wobbles slightly, so the player learns to wait for it to settle.
- Map screen: full-screen 2D view with pinch zoom, two-finger rotate, and a tool palette (protractor, ruler, pencil, eraser).
- Optional: use the phone's real orientation sensor as the compass, so turning your body turns the in-game compass. Off by default.

**Technical direction for Claude Code:**

- Three.js, plain JavaScript or TypeScript, built with Vite.
- Seeded heightmap (noise) as the single source for both the voxel world and the map.
- Voxel chunks with greedy meshing; instanced trees; fog distance driven by zone (far in open terrain, short in forest).
- Map drawn on a 2D canvas: contour lines from the heightmap (marching squares) every 12.5 m, karvak grid, coordinate labels, landmark symbols, legend with scale and declination.
- Line-of-sight raycast for compass sighting.
- Progress saved in the browser's local storage.
- Target: 30 fps or better on a mid-range phone.
- UI language: Indonesian, using the material's terms (navigasi terbuka, navigasi tertutup, karvak, utarakan peta), with an English toggle later. On screen, navigasi terbuka and navigasi tertutup are always written out in full, never shortened to navter/navtup.

## MVP scope and build order for Claude Code

The MVP is one map with one navter mission (resection plus crossroad checks) and one navtup mission. Everything else comes after it works on a real phone.

**Build order:**

1. Seeded heightmap, voxel terrain, and walking with touch controls. Test on the phone over local Wi-Fi.
2. Topographic map generated from the same heightmap: contours, karvak grid, coordinates, landmarks.
3. Compass sighting with line of sight and azimuth readout.
4. Map tools: rotate to orient, protractor lines, ruler, pencil and eraser.
5. Resection mission with back-azimuth check and error in metres.
6. Trail network with crossroad checkpoints.
7. Intersection mission.
8. Dense-forest zone and navtup: plotting, kunci kompas, NPC team roles, stringline, pace counter.
9. Declination, obstacle detours, and the level progression.
10. Packing screen, scoring, debriefs, polish.

**How to hand this to Claude Code:**

- Export this doc as Markdown and save it in the project as `docs/GDD.md`.
- First prompt: ask it to read the GDD and build steps 1 and 2 only, then stop.
- Test each step on your phone before asking for the next one.

**Open questions:**

- [ ] Should the player always be the compasman in navtup, or choose a role from the start?
- [ ] Which declination convention do your instructors use when converting map and compass bearings?
- [ ] Is 1 block = 2.5 m the right scale, or should the world be smaller for weaker phones?
