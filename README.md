# Skyrings

A small low-poly arcade flight game that runs in the browser. Take off from the
runway, fly the gates in order, come back and land. Four missions, your best
time saved for each.

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
| `B` | Wheel brakes on the ground, airbrake in the air (`Space` also works) |
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

The title and mission screens are not a static backdrop: an autopilot is
flying the loaded mission behind them, under the same physics and the same
landing rules as a player. It is scored by nothing and recorded nowhere, and
restarts on a crash, a completed landing, or 25 seconds without reaching a
gate.

It leans on a guarantee the route generator already provides — that the
straight line between consecutive gates clears the ground — so it does no path
planning and no terrain avoidance. What it does:

- **Aims at a point on the current leg, a lookahead ahead, clamped at the next
  gate.** The clamp is what makes it fly *through* rings rather than past them:
  letting the lookahead spill onto the next leg cuts the corner by about 39
  units, against rings of 34–46.
- **Banks for the curvature the geometry needs**, `2·sin(bearing)/range`,
  inverted through the model's own turn relation. A gain proportional to
  bearing error looks reasonable and does not work: a 13° error asks for 24° of
  bank, which turns too slowly to ever close it.
- **Brakes for the corner.** Turn radius goes with the *square* of speed, so
  arriving too fast is not something steering can rescue. Each gate has a
  target speed derived from the corner that follows it.
- **Pitch holds the flight path and nothing else**, aimed at the gate's own
  height rather than the lookahead point's. Every attempt to borrow pitch for
  turning — a bank-proportional pull, or climbing through corners — turned
  faster and ballooned 87 units over the gates, which is a miss just the same.

**It does not yet complete a mission.** It flies about half of Green Valley
cleanly, most gates dead centre, then loses one and goes around. See the TODO.

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
src/scenery.js  sky, lighting, clouds, instanced city with collision
src/autopilot.js path-following autopilot; flies the attract-mode demo
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
- **Roll is a rate, with no ceiling.** Hold `A`/`D` and the aeroplane keeps
  rolling, straight through inverted — about 0.7 s to go over at cruise. Hands
  off, the wings wash back to level slowly enough (≈10 s from 40°) that you can
  set a bank and fly a turn on it.
- **Turning comes from lift, not from bank.** Lift acts out of the top of the
  wing; whatever part of it ends up horizontal drags the nose round. Banking
  alone is barely a turn — 45° of bank gives about 8° of heading in two
  seconds. Pulling is what bends the flight path: the same bank with full
  back-pressure gives about 175°. Deriving this from the lift vector rather
  than from a bank angle keeps it correct inverted and at 90° of bank, where
  an `asin(bank)` formula folds back on itself.
- **Back-pressure costs speed.** Pull sets a load factor of 1–4 g, rising with
  the *square* of the input so easing the nose up is nearly free, and induced
  drag is charged on `n² − 1`. A gentle turn holds speed; a hard one at 50° of
  bank drops you from 120 kt to about 92 kt in two seconds.
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

On City Towers the buildings are placed *after* the route and any tower within
170 m of a route leg is skipped, so there is always a lane to fly.

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
- **Brakes, gear and nitro** — braking stops a 100 kt roll inside the runway
  and beats coasting; the gear is faster up, is refused on the ground, and does
  not count as down mid-travel; a gear-up arrival slides instead of landing;
  nitro surges, cannot be re-armed mid-burn, expires on time, recharges on
  time, and does not run into its own speed ceiling — if the cap swallowed the
  boost, every multiplier would feel the same and the gear would stop mattering
  during a burn.
- **Solid ground** — diving into terrain at top speed, planting it on the
  runway from 500 units up, and descending onto the runway before ever having
  climbed away all leave the aeroplane on the surface, never inside it.
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
- [ ] The autopilot stalls out around gate 9 of 18 on Green Valley and gate 3
      of 30 on City Towers, at the same gates whatever the speed — so it is not
      a turn-radius limit but something structural about chained short legs in
      the crosswind arc. Cross-track control along the leg, instead of pure
      pursuit to the gate, is the next thing to try
- [ ] Once it completes a mission, retire the weak flight probe in the test
      suite and assert route completability with the real autopilot instead
- [ ] Gamepad support via the Gamepad API
- [ ] Phone: a rudder control (yaw is currently keyboard-only)
- [ ] Phone: pick stick or arrows as the default once both have been flown
- [ ] Phone: a left-handed layout that swaps stick and throttle
- [ ] More missions, and a seed field so you can generate your own
- [ ] A second canyon level, or a seed for the gorge shape
- [ ] Canyon walls could use strata banding rather than one flat rock colour
- [ ] The canyon's repositioning sweep is long; a second, lower gorge running
      back towards the field would be a better way home than flying round
- [ ] Engine audio is a bit coarse — the drone could use a second detuned
      oscillator and a proper doppler on the gate chime
