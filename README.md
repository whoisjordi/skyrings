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
| `R` | Restart mission |
| `Esc` | Pause |

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

**Nitro** triples thrust for 5 s and then recharges for 10 s. It is a thrust
multiplier rather than a speed multiplier: 129 → 205 kt with the gear down,
143 → 232 kt with it up. Tripling the *speed* outright would be near 390 kt,
which is too fast to thread a gate or stop before the end of the runway.

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
src/scenery.js  sky, lighting, clouds, instanced city with collision
src/camera.js   chase and cockpit cameras
src/hud.js      DOM HUD, off-screen target arrow
src/audio.js    synthesised engine, chimes and crash noise (no audio files)
src/input.js    keyboard state
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

On City Towers the buildings are placed *after* the route and any tower within
170 m of a route leg is skipped, so there is always a lane to fly.

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
  nitro surges, cannot be re-armed mid-burn, expires on time and recharges on
  time.
- **Solid ground** — diving into terrain at top speed, planting it on the
  runway from 500 units up, and descending onto the runway before ever having
  climbed away all leave the aeroplane on the surface, never inside it.
- **Worlds** — the apron is flat, the start point is on the runway, gates clear
  the terrain and sit inside the map, and every route leg clears the ground.
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
- [ ] The flight probe was written for the old bank-turns-you model and cannot
      thread gates under the current one even after learning to pull in turns
- [ ] Gamepad support via the Gamepad API
- [ ] Mobile: touch controls and a smaller terrain mesh
- [ ] More missions, and a seed field so you can generate your own
- [ ] Engine audio is a bit coarse — the drone could use a second detuned
      oscillator and a proper doppler on the gate chime
