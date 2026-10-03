# Skyrings

A small low-poly arcade flight game that runs in the browser. Take off from the
runway, fly the gates in order, come back and land. Four missions — Alpine
Valley, Canyon Run, City Towers and Dragon Night — your best time saved for each.

**Play:** https://whoisjordi.github.io/skyrings/

---

## Goal

Make something genuinely fun to fly in a few hundred lines, with no build step,
no engine, no art assets and no dependencies beyond three.js from a CDN.

The design brief was deliberately narrow:

- **Arcade, not simulation.** Simple approximations everywhere. You should be
  flying well within thirty seconds of loading the page.
- **A real goal, not a sandbox.** Take off → gates → land. A timer on the
  whole thing, and a personal best worth beating.
- **Simple graphics that still look good.** Flat-shaded low-poly, no textures,
  no shadow maps, fog on the horizon. Cheap to render and hard to make ugly.
- **Free and frictionless.** Open a URL and play. Nothing to install.

## Controls

| | |
|---|---|
| `W` / `S` | Pitch down / up (invertible in the pause menu) |
| `A` / `D` | Roll left / right |
| `Q` / `E` | Rudder |
| `Shift` / `Ctrl` | Throttle up / down |
| `B` | Wheel brakes on the ground, airbrake in the air (`Space` also works). The airbrake fades out near approach speed, so it cannot slow you into a sink |
| `G` | Landing gear up / down |
| `N` | Nitro boost |
| `C` | Chase / cockpit camera |
| `Esc` | Pause (restart lives here, not on a key) |

Hold `Shift` to full power, wait for about 55 knots, then pull back on `S`.
The blue gate is the next one; the arrow at the edge of the screen points to it
when it is off-screen. Clear them all and the arrow points home.

Bank with `A`/`D`, then **pull back on `S`** to make the turn bite — banking on
its own will barely change your heading, and the harder you pull the more speed
you lose. Keep the speed above about 70 kt or the nose will start to sag.

**Gear** takes 1.2 s to travel and only counts as down above 90 % of it. Up, the
airframe is cleaner — top speed goes from about 131 kt to 153 kt — but you
cannot land on it: you will belly in, slide, and the run ends there. The chip
at the bottom left is green when it is safe to land.

**Nitro** applies six times thrust for 5 s and then recharges for 10 s. It is a
thrust multiplier rather than a speed multiplier: 129 → 298 kt with the gear
down, 143 → 323 kt with it up. Turns go noticeably wider while it is lit, which
is the trade that makes it a decision rather than a free button.

## On a phone

Open the same URL. The game detects a coarse pointer and switches controls:

- **Throttle** — slider, bottom left. It stays where you put it.
- **Stick** — bottom right. Pull down to climb and push up to dive, the same
  sense as `S` and `W`. It is analogue, and that matters here: how tight a turn
  gets depends on the *square* of how hard you pull, so easing into a turn is
  something keys cannot do.
- **G / B / N** — the row just above the stick. They also show state: G is
  green, amber or red for gear down, travelling or up; N counts down its
  recharge.
- **Arrows instead of the stick** — switch in Pause. Same spot, same thumb, but
  snapped to −1/0/+1 like keys, with diagonals across eight 45° sectors.

The bottom HUD boxes are hidden on a phone, since the slider and the buttons
now carry that information, and the controls respect the notch safe areas.

An earlier build steered by tilting the phone. It did not fly well and was
removed; it is in the history at `bef6f2f`.

The desktop build is untouched: phone controls are an auxiliary input source
that *adds* to the keyboard axes rather than replacing them, and a touchscreen
laptop with a mouse keeps the keyboard layout.

## The demo

The title and mission screens are not a static backdrop: a pilot is flying the
loaded mission behind them, under the same physics and the same landing rules
as a player. It is scored by nothing and recorded nowhere, and restarts on a
crash, a completed landing, or a spell without progress.

On Alpine Valley, City Towers and Dragon Night that is the **racing-line pilot**
(`src/linepilot.js`), and it flies the whole mission: takeoff, every gate, and a
landing the runway accepts. The tests check exactly that on each of the three.

- **The line** is a centripetal Catmull-Rom from the runway, up through a
  climb-out point, through every gate, and down onto the threshold. Centripetal
  matters: the uniform kind overshoots between unevenly spaced points, and in
  a city street an overshoot is a wall.
- **Bank to turn.** Roll until the lift points at where the line is going —
  a point 0.6 s ahead along it — then pull. This is how the aeroplane actually
  turns: banking alone barely does, and the pull is what bends the path. A
  small upward bias in where the lift should point keeps it from sagging.
- **The landing** follows the line to 22 above the ground 700 out and 10 at the
  threshold. Over the tarmac it levels the wings, cuts the power and holds a
  sink of about 2.5 until the wheels touch.

On Canyon Run the line cuts the gorge's bends too fine and meets the wall, so
the older **path-following autopilot** (`src/autopilot.js`) flies that demo. It
aims at a point on the current leg clamped at the next gate, banks for the
curvature the geometry needs, and brakes for corners. It does not complete
a mission.

## Version

The title screen shows the version in small letters at the bottom (`v1.3`).
It is set by `VERSION` in `src/main.js`, not in the page, so it reports the
code the browser is actually running — if it shows an older number after a
deploy, the browser is still on cached scripts and needs a hard refresh.
Bump it with every release.

## Running it locally

ES modules will not load from `file://`, so serve the folder over HTTP:

```sh
python3 -m http.server 8000     # or: npm start
```

Then open <http://localhost:8000>. That is the whole toolchain — there is no
build, no bundler and no install step for the game itself.

## Technical description

Plain ES modules, `three` r186 pulled from a CDN through an import map in
`index.html`. No bundler, no transpiler, no framework.

```
index.html      import map, HUD markup, menu screens, all CSS
src/main.js     game loop, state machine, level lifecycle, menu wiring
src/plane.js    arcade flight model and the aeroplane mesh
src/terrain.js  seeded Perlin terrain, airport apron, departure corridor
src/airport.js  runway geometry, touchdown judging, approach info
src/rings.js    route generation, terrain clearance, gate crossing detection
src/canyon.js   the carved gorge: centreline, depth profile, distance queries
src/scenery.js  sky, lighting, clouds, and the night sky: stars and moon
src/city.js     City Towers: streets, buildings, shader windows, traffic, colliders
src/autopilot.js path-following autopilot; flies the canyon's demo
src/linepilot.js racing-line pilot; flies every other demo, takeoff to landing
src/alps.js     Alpine Valley: mountains, valleys, rivers, lake, forests, summit flags
src/flock/      the flock engine: bird rules + formations, no three.js (see below)
src/drones.js   Dragon Night's drone show: dragon round the lake gates, plane as threat
src/flockview.js draws a flock as glowing additive points, one draw call
src/camera.js   chase and cockpit cameras
src/hud.js      DOM HUD, off-screen target arrow
src/audio.js    synthesised engine, chimes and crash noise (no audio files)
src/input.js    keyboard state, plus an optional auxiliary source
src/touch.js    phone controls: stick or arrow pad, throttle slider, buttons
src/save.js     localStorage best times and unlocks
src/levels.js   the four missions as data
test/harness.mjs headless checks — see "Tests"
```

> **Testing note:** every mission is currently selectable regardless of
> progress. Set `UNLOCK_ALL` to `false` in `src/save.js` to restore
> unlock-as-you-go; progress is recorded either way.

### The flight model

Not a simulation. Speed is a single scalar along the nose and there is no lift
vector. The whole of the aerodynamics is:

- **Energy.** `speed += (thrust·throttle − drag·v² − gravity·forward.y)·dt`.
  Climbing bleeds speed, diving gains it. `gravity > thrust`, so you cannot
  climb vertically for ever.
- **Roll is a rate, with no ceiling.** Hold `A`/`D` (or the arrow keys) and the
  aeroplane keeps rolling, straight through inverted: about 0.8 s from level to
  upside down at cruise. Hands
  off, the wings wash back to level slowly enough (≈10 s from 40°) that you can
  set a bank and fly a turn on it.
- **Turning comes from lift, not from bank.** Lift acts out of the top of the
  wing; whatever part of it ends up horizontal drags the nose round. Banking
  alone is barely a turn — 45° of bank gives about 8° of heading in two
  seconds. Pulling is what bends the flight path: the same bank with full
  back-pressure gives about 175°. Deriving this from the lift vector rather
  than from a bank angle keeps it correct inverted and at 90° of bank, where
  an `asin(bank)` formula folds back on itself.
- **Lift only holds you up while it points up.** Up to about 50° of bank
  nothing changes. Beyond that gravity starts to win: on a knife edge (90°)
  the nose falls about 18° in two seconds and the aeroplane sinks, and upside
  down the wing pushes you toward the ground, so you lose about 60 units of
  height in two seconds even with the nose on the horizon.
- **Rudder wags the tail.** Holding `Q`/`E` yaws the nose and adds a quick
  side-to-side wag (about ±5°, 2.4 times a second), like a snake.
- **Back-pressure costs speed.** Pull sets a load factor of 1–4 g, rising with
  the *square* of the input so easing the nose up is nearly free, and induced
  drag is charged on `n² − 1`. A gentle turn holds speed; a hard one at 50° of
  bank drops you from 120 kt to about 92 kt in two seconds.
- **The airbrake fades out** between 92 and 74 kt. It is the obvious thing to
  press to slow down for a landing, and at full strength it dragged the
  aeroplane below the speed where the nose sags — a stable approach turned into
  a 55 units/s dive against a touchdown limit of 15.
- **Slow flight goes vague.** Control authority fades with airspeed and the
  turn rate falls with its *square*, so a 60 kt turn is a third of a 120 kt
  one. Below 70 kt the wing runs out of margin: the nose sags and you sink,
  getting worse all the way down. At 45 kt you cannot climb at all. Below
  30 kt it stalls properly and the nose drops hard enough to beat your own
  back-pressure.
- **Gear and nitro** both act on the same two numbers — drag and thrust — so
  they compose with everything above rather than being special-cased.

Ground contact is swept along the path travelled each step rather than tested
at the end point alone, so a fast aeroplane cannot cross the surface between
frames. Every outcome — landing, crash, or contact that is neither — snaps the
aeroplane onto the surface; nothing may leave it underground.

Physics runs on a fixed 1/120 s step with an accumulator, so a recorded time
means the same thing on a 60 Hz laptop and a 144 Hz monitor.

### Generated worlds

Each mission is a seed plus a handful of numbers in `src/levels.js`. Terrain is
fbm Perlin with a ridged component for mountains and a radial falloff into
ocean. The mesh is de-indexed so every triangle gets one flat normal and one
flat colour, which is what produces the faceted look without any texture.

Two constraints keep a generated world playable:

- **The airport corridor.** The apron is a stadium shape around the runway, and
  terrain along the extended centreline is capped to a gentle 8° ramp for
  2.2 km. Climbing out and coming back down the centreline is therefore always
  possible — otherwise a mountain can sit across the only way out of the field.
- **The route contract.** Gates are sampled off a Catmull-Rom curve, then an
  iterative pass lifts them until *the straight line between consecutive gates*
  clears the ground. Players fly straight at the next gate, so it is the legs
  that have to be clear, not just the gates. The runway ends are pinned and
  their clearance requirement ramps in over 800 m, since the aeroplane is
  supposed to be near the ground there.
- **Line of sight.** The next gate should be something you can see, not
  something you hunt for with the HUD arrow. Gates are not spaced evenly:
  the sampler walks the curve and drops one whenever the path has turned 30°
  *or* run a set distance, so a long bend comes out with several gates through
  it, each rotated a little further round. Across all four missions no gate now
  turns more than 64° to reach the next, and the first is 5–8° off the runway
  centreline.

### Why the route is a circuit

Getting "the next gate is in front of you" is mostly a geometry problem at the
two ends, and both took a real construction rather than a tuned constant.

Leaving the runway, you are flying radially away from the field; joining a
circuit means flying tangentially around it. That is a 90° turn no matter what,
and the only question is over what distance. Left to a spiral it came out with
a radius near 250 — the whole 90° packed between two gates, which is exactly
the case extra gates cannot fix. The departure is now an explicit arc of known
radius, so the turn is spread over ~1100 m and three or four gates sit in it.

Coming back, the circuit has to finish *further out* than the approach gate so
the last leg runs inbound. Finishing inside it leaves a 180° reversal, and a
reversal never reads as "ahead of you" however many gates are in it.

City Towers is the exception to all of this: there the streets come first and
the route is threaded down them — see the next section.

### The canyon

Canyon Run swaps both of those constraints for a different one. The level sits
on a 470 m plateau, and a single 6.1 km gorge is cut into it: a long sweeping
loop around the airfield with S-bends laid over the top, so it curves at two
scales instead of reading as a circle with a wobble. It is 300 m wide at the
floor, 370 m deep, and shallow at both ends — it starts and finishes at plateau
level — so you can descend in and climb out without meeting a wall head-on.

One object owns the gorge. The terrain asks it *how deep is the ground here*
and the route asks it *where does the next gate go*, so the canyon you see and
the canyon you fly cannot drift apart. The carve only ever lowers ground, which
means it can be applied after the apron and the corridor and nothing can fill
it back in. A uniform grid indexes the 900-segment centreline, because
`heightAt` runs ~31 k times just to build the mesh and several more times per
frame.

Every gate in the gorge is on the centreline, 80 m off the floor and 130–314 m
below the rim. Two are outside it: one off the departure end, so the canyon
mouth is something you are aimed at rather than something you go looking for,
and the last on final approach, clear of the carved zone.

The gorge finishes abeam the field pointing the wrong way for the runway, and
there is no room on this map for a procedure turn outside the canyon ring. The
route therefore keeps turning the way it already was, sweeping round the field
and widening out to the approach side — longer than a reversal, but it never
asks you to fly at a gate behind your shoulder. The clearance pass that lifts the open routes is deliberately
*not* run here — it would haul the gates straight out of the gorge. What keeps
it flyable instead is spacing: gates every 430 m, close enough that the
straight line between consecutive ones never strays more than 60 m from the
centreline, against walls at 150 m.

### The mountains

Alpine Valley replaces the island relief with a range of its own, and like the
canyon and the city one object (`src/alps.js`) owns the shape: the terrain asks
it how high the ground is, the route asks it where the valleys are.

- **The range** is ridged noise — inverted, squared, four octaves — on a base
  of 380, with peaks to about 1,650. It rises further towards the edge of the
  map, in ridges, so the horizon is mountains rather than the end of the mesh.
- **Two valleys**, each a smoothed centreline with a floor height, a floor
  width and a river line written as tables along its length. They are carved
  glacial-style: a flat floor, a curved toe, then steep walls. The walls are
  ribbed and the edge of the floor wanders with noise; without that they come
  out as smooth planes. The main valley is wide and level where the airfield
  is and climbs to 450 at its head; the side valley comes down from 470.
- **The lake** at the bottom takes both rivers. It is just the sea plane showing
  through a basin, so it needs no mesh of its own.
- **The summit** stands between the two valley heads: a cone 700 high with a
  small flat top, ridged on its flanks, restored after the valleys are carved
  so their heads cannot bite into it. Two poles stand on top, either side of
  the gate, with flags that flutter.
- **Colour** follows the way mountains look: meadow on the valley floors,
  dark forest up to the tree line at 540, pasture above it, bare rock on
  anything steep or high, and snow above a ragged snow line — on gentle ground
  first, and on steeper faces the higher it gets. The summit always has its cap.
- **Props**: rivers as ribbons on the valley floors, about 3,400 pines in
  patches below the tree line, chalets beside the runway and on the lake shore,
  and a church. Trees, chalets and the poles are all solid.

There is no climb-out corridor on this level. Capping a straight trench across
the range would cut through the mountains, and the runway points up the main
valley, so the valley is the way out and the lake is the way in.

The route: off the runway up the main valley, following the river, climbing
as the valley does; over the summit between the flags, with the bottom of the
ring 10 above the snow; down the side valley along its river; out over the lake
and round onto final. 22 gates, 16 of them over a valley floor.

### Dragon Night and the flock

Level 4 is a clear night in the mountains: Alpine Valley's layout mirrored and
cut to about half the height (peaks to ~860 instead of ~1,700), lit by a low
moon over the lake, with 1,600 stars. Over the lake about **1,500 drones** fly
in the shape of a **Chinese dragon** that coils round the gates crossing the
water — and gets out of your way when you fly into it. Phones get about 640.
The full design is in [`docs/flock.md`](docs/flock.md).

**The flock engine** (`src/flock/`) is written to be lifted into another game
— a bird-flock game where you are one of the birds — so it has no three.js in
it, only typed arrays, and runs headless. It has two layers:

- **Pattern 1, the bird rules**, in priority order: dodge threats, keep off
  the ground, separation, alignment, cohesion. Neighbours are **topological** —
  the 7 nearest, whatever their distance, as starlings do — found through a
  hashed spatial grid rebuilt every tick, with each agent's list refreshed
  every third tick.
- **Pattern 2, a formation**: a slot for each agent, which it is drawn
  towards. Only an attractor: the rules spend from a **fixed acceleration
  budget** in priority order (Reynolds' prioritised allocation), and the slot
  gets what the bird rules leave. A panicking drone forgets its slot until it
  calms down. The slot's velocity and acceleration are fed forward, so calm
  drones sit within ~0.2 of their slots while the dragon swims.
- **Reaction delay**: a ring buffer keeps the last ticks of every agent's
  state, and each agent sees its neighbours as they were `reactionDelay ±
  reactionJitter` ago (default 80 ± 30 ms). Separation and dodging read the
  present; alignment, cohesion and startle read the past. A startle therefore
  runs through the flock as a wave whose speed the delay sets.
- **The dodge** predicts the aeroplane's path 1.5 s ahead as a short parabola
  (so it follows a turn), and each drone near it picks the sideways speed that
  gets it 26 units clear of the path by the time the aeroplane arrives, with a
  margin. A tunnel opens around you; further out drones only flinch, and their
  panic spreads to their neighbours.
- **Roles** for the bird game: `PLAYER` agents are moved by their owner and
  count as neighbours to the rest; `PREDATOR` agents chase the nearest bird and
  are dodged like the aeroplane.

**The dragon** (`src/flock/dragon.js`) is a formation. Its head swims a closed
path that coils round the lake gates — radius 60 ± 8, so its inside hugs the
rings — out to the far gate and back, so the dragon is always wrapped round
that stretch of the route. The body follows the head's own path like a snake,
with a slow up-and-down wave; its back faces out and its belly faces the
gates. Slots are laid out as a tapering tube of staggered rings (red scales, a
gold spine line, a pale belly) with spikes, a head with an open jaw, eyes and
antler horns, an orange mane, long waving whiskers, four legs with gold claws,
a tail tuft, and a pearl tumbling ahead of the mouth. Each drone twinkles at
its own phase, and every 20 s a bright wave runs from head to tail.

**Cost**: about 1.3 ms per 30 Hz tick for 1,500 drones (≈4 % of a core), with
render interpolation in between. The ground under the drones comes from a
cached height grid, since the real terrain function is far too slow to call
for every drone. `?debug&tune` adds live sliders for the main rules.

### The city

City Towers is flown *in* the streets, not over the roofs. Like the canyon, the
geometry comes first and the route is laid along it, and one config in
`src/levels.js` describes both.

- **The grid.** North–south and east–west streets, each a centre line and a
  facade-to-facade width. Boulevards are 120 wide — the narrowest gap a 32-unit
  ring and a 90-unit turn fit into with room to spare — and the side streets
  are 60, which you cannot fly down. The blocks are whatever the streets leave.
  The terrain under the city is levelled to the airfield's height and blends
  back into the country, and out into the sea on the south side.
- **Roads.** Every street has a two-lane road with edge lines, a dashed centre
  line broken at junctions, and zebra crossings. Boulevards add parked cars
  along both kerbs and a row of plane trees. About 500 cars drive on the right
  and wrap round at the end of their street. East–west roads stop at the
  esplanade and run under it, as they do at La Défense.
- **Buildings.** Three districts. Round the axis, glass towers of 230–640:
  straight, stepped back in tiers, or round on a podium, with plant rooms and
  masts. Along every street the route uses, offices of 110–280, so each one is
  a canyon. Everywhere else, Paris: limestone perimeter blocks round courtyards,
  six floors, balconies on the second and fifth, slate mansards and chimneys.
- **Windows** are drawn by the fragment shader from the position on the facade —
  no textures, no extra geometry, one draw call for every building. The grid is
  computed in each instance's own scaled space, so it lines up with the
  building's edges and its floor height; far away it fades to its average
  colour instead of shimmering. Per-building values are `flat` varyings: an
  interpolated constant is not quite constant, and the per-window hash turned
  that last-bit noise into stripes.
- **Landmarks.** La Grande Arche closes the axis: a hollow cube 220 wide and
  220 tall on a podium, with a 120-wide opening. Two skybridges, one between
  twin towers across the esplanade and one across a boulevard, and three
  coloured sculptures on the esplanade.

The route: off the runway and round to the right, down the east side of the
field and into the first boulevard. Eight corners through the grid,
under the first skybridge, then onto the esplanade — a slalom past the
sculptures, under the second bridge, through the Arche, and the runway is
straight ahead of you. 32 gates, all but one of the 25 in the city below the
surrounding rooftops.

At a corner the gate goes where a turn of radius 100 would put you — about 41
inside the corner of the two centre lines — and the straights are filled so no
gate is more than 280 from the next. Gates are deliberately kept out of the
junctions the route crosses twice, or you fly through an old ring on the way
past.

Everything solid is a collider, trees included, in an 80-unit grid. The
rings' straight legs clear every building by 26 or more.

### Gate detection

Each gate stores a fixed world→gate matrix. A crossing is a sign change of the
plane's local `z` between frames, and the radius test is done at the
*interpolated* crossing point, so a fast pass cannot tunnel through.

The matrix is deliberately not derived from `matrixWorld`: the active gate
pulses, and a scaled local space would silently shrink the hit radius with it.

## Tests

```sh
npm install     # only three.js, only for the tests
npm test
```

The game itself needs none of this — it is only so the headless checks can
import `three`. The suite builds every level and asserts:

- **Flight model** — takeoff roll fits on the runway, it climbs, level cruise
  settles in a sane band, power-off nose-up stalls, and the stall recovers.
- **Handling** — full aileron rolls inverted inside 2.5 s at 60 and 120 kt;
  banking alone turns less than 20° in two seconds while pulling turns over
  four times as far; a gentle turn holds speed and a hard one sheds 20 kt+; a
  60 kt turn is under 60 % of a 120 kt one and a 45 kt climb loses height; and
  hands-off wings take between 4 s and 30 s to level.
- **Brakes, gear and nitro** — braking on a stable approach neither drags the
  aeroplane into the sagging band nor builds a descent that would break the
  touchdown limit, while still rescuing an arrival that is too fast; braking
  stops a 100 kt roll inside the runway and beats coasting; the gear is faster up, is refused on the ground, and does
  not count as down mid-travel; a gear-up arrival slides instead of landing;
  nitro surges, cannot be re-armed mid-burn, expires on time, recharges on
  time, and does not run into its own speed ceiling — if the cap swallowed the
  boost, every multiplier would feel the same and the gear would stop mattering
  during a burn.
- **Solid ground** — diving into terrain at top speed, planting it on the
  runway from 500 units up, and descending onto the runway before ever having
  climbed away all leave the aeroplane on the surface, never inside it; and a
  shallow climb-out followed by a low, flat final still lands, rather than
  leaving the aeroplane held on the tarmac in flight mode.
- **Worlds** — the apron is flat, the start point is on the runway, gates clear
  the terrain and sit inside the map, and every route leg clears the ground.
- **The canyon** — it is long, the gates in the gorge are one unbroken run
  inside the walls and below the rim, the chords between them stay between the
  walls, the departure and approach gates are outside it, and the gorge keeps
  well clear of the runway.
- **Phone stick** — pull-down climbs and push-up dives for both the stick and
  the arrows, matching the keyboard; the stick has a deadzone with no jump at
  its edge, rises monotonically and never leaves the unit circle; the arrows
  only ever produce key-like −1/0/+1, with real diagonals, and register in
  every direction at 90% travel.
- **The mountains** — at least 14 gates follow the valleys; the summit is
  where it should be, the summit gate's lowest point is a little above the
  top, there is a pole either side of it and nothing solid inside it. Then
  the line pilot flies the route from the departure gate at 100 and 115 kt and
  must take every gate without touching the ground or a tree.
- **The flock** — on a test dragon: calm drones hold their slots to under 0.6
  on average and never sit on top of each other; a threat flown through the
  head, the middle and the tail at 127 kt, and through the body at 300, touches
  no drone, gets no closer than 12, and the dragon heals within 8 s each time;
  the same seed and inputs give the same flock; with a longer reaction delay
  a startle takes over 2.5× as long to cross a line of 120 agents; a free
  flock with a predator and a player-steered bird stays near home, finite, and
  leaves the player where its owner put it; and a tick fits its CPU budget.
- **The dragon** — on Dragon Night it coils round at least three lake gates,
  its path keeps 40+ above ground and water, and the demo pilot flies the
  whole mission through it, landing included, without touching a drone.
- **The demo** — on every level but the canyon, the racing-line pilot takes off,
  flies every gate and lands, under the same rules as a player.
- **The city** — the city gates are below the surrounding rooftops, every leg
  between them clears every building by at least 12, the last gate fits
  inside the Arche's opening, and each skybridge has a gate under it that the
  ring does not touch. Then a line-following pilot flies the street run under
  the real flight model, at 100 and at 120 kt, and has to clear every gate
  without touching anything. It follows a Catmull-Rom racing line through the
  gates and steers bank-to-turn: roll the lift onto the line, then pull.
- **Line of sight** — on every mission the first gate is within 35° of the
  runway centreline, no gate turns more than 70° to reach the next, no leg is
  longer than the fog, and the last gate is far enough out and low enough to
  land from.
- **Gate detection** — dead centre registers, just inside the rim registers,
  well outside does not, and a 180 m single-frame jump does not tunnel.

It then flies a crude autopilot round each mission and prints how far it got.
That part is **reported, not asserted** — it is a weak pilot and its score is a
smoke signal, not a specification.

## TODO

- [ ] Turn `UNLOCK_ALL` back off once mission testing is done
- [ ] The flight probe cannot thread gates reliably; it needs proper pursuit
      guidance before its score could become a real assertion
- [ ] Landing is the hardest part to learn — add a vertical-speed readout and
      an approach hint ("too fast", "too steep") once the gates are cleared
- [ ] Gear-up belly slide could throw sparks and leave a scrape on the runway
- [ ] Nitro deserves a visual: exhaust flare and a bit of screen distortion
- [ ] Ghost replay of your best run
- [ ] The racing-line pilot meets the wall on Canyon Run's bends; a line that
      keeps to the gorge's centreline between gates, instead of a spline through
      them, should let it fly the canyon demo too and retire the old autopilot
- [ ] Retire the weak flight probe in the test suite; the line pilot already
      asserts what it only reports
- [ ] Gamepad support via the Gamepad API
- [ ] Phone: a rudder control (yaw is currently keyboard-only)
- [ ] Phone: pick stick or arrows as the default once both have been flown
- [ ] Phone: a left-handed layout that swaps stick and throttle
- [ ] More missions, and a seed field so you can generate your own
- [ ] A second canyon level, or a seed for the gorge shape
- [ ] Canyon walls could use strata banding rather than one flat rock colour
- [ ] The canyon's repositioning sweep is long; a second, lower gorge running
      back towards the field would be a better way home than flying round
- [ ] City Towers: an Eiffel Tower. It wants its own lattice mesh and a
      collider that lets you fly under the arches between the legs — a gate
      there would be the obvious finale before the Arche
- [ ] City Towers at dusk: the window shader already has lit windows; at night
      they would carry the whole look
- [ ] A bird-flock game on `src/flock/` (its own repo when it starts): you
      are one of the birds (`ROLE.PLAYER`), with hawks (`ROLE.PREDATOR`)
- [ ] Dragon Night: slot swapping, so a drone flung far trades places with
      one nearer its slot and the dragon heals faster
- [ ] Dragon Night: lit chalet windows and a moon glint on the lake
- [ ] Dragon Night: the drones as a reflection in the lake (a second, dimmer
      draw of the same points mirrored in the water plane)
- [ ] Alpine Valley: waterfalls off the valley walls, and something moving —
      a cable car up to the summit, or birds circling below it
- [ ] Alpine Valley: rivers are flat ribbons; a little white water where the
      valley floor steepens would sell the slope
- [ ] Cars pass through each other at junctions; traffic lights, or at least a
      pause at the crossing, would fix it
- [ ] Engine audio is a bit coarse — the drone could use a second detuned
      oscillator and a proper doppler on the gate chime
