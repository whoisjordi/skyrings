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
| `Space` | Brakes on the ground, airbrake in the air |
| `C` | Chase / cockpit camera |
| `R` | Restart mission |
| `Esc` | Pause |

Hold `Shift` to full power, wait for about 55 knots, then pull back on `S`.
The blue gate is the next one; the arrow at the edge of the screen points to it
when it is off-screen. Clear them all and the arrow points home.

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

### The flight model

Not a simulation. Speed is a single scalar along the nose and there is no lift
vector. The whole of the aerodynamics is:

- **Energy.** `speed += (thrust·throttle − drag·v² − gravity·forward.y)·dt`.
  Climbing bleeds speed, diving gains it. `gravity > thrust`, so you cannot
  climb vertically for ever.
- **Bank-limited roll.** The aileron sets a *bank angle*, not a roll rate:
  resistance builds as the bank approaches 72°, so holding `D` settles into a
  steady banked turn instead of barrel-rolling. Releasing it levels the wings.
  Inverted, the limiter switches off so you can always roll upright.
- **Coordinated turn.** `ω = turnG · tan(bank) / speed`. Banking turns the
  nose, and the turn tightens as you slow down — which is both correct and the
  thing that makes the gates feel threadable.
- **Stall.** Below 30 knots control authority fades, the nose drops hard and
  you sink until the speed comes back.

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
  settles in a sane band, full aileron turns and *settles at 72°* rather than
  rolling over, power-off nose-up stalls, and the stall recovers.
- **Worlds** — the apron is flat, the start point is on the runway, gates clear
  the terrain and sit inside the map, and every route leg clears the ground.
- **Gate detection** — dead centre registers, just inside the rim registers,
  well outside does not, and a 180 m single-frame jump does not tunnel.

It then flies a crude autopilot round each mission and prints how far it got.
That part is **reported, not asserted** — it is a weak pilot and its score is a
smoke signal, not a specification.

## TODO

- [ ] The flight probe cannot thread gates reliably; it needs proper pursuit
      guidance before its score could become a real assertion
- [ ] Landing is the hardest part to learn — add a vertical-speed readout and
      an approach hint ("too fast", "too steep") once the gates are cleared
- [ ] Ghost replay of your best run
- [ ] Optional aerobatic mode that removes the bank limiter
- [ ] Gamepad support via the Gamepad API
- [ ] Mobile: touch controls and a smaller terrain mesh
- [ ] More missions, and a seed field so you can generate your own
- [ ] Engine audio is a bit coarse — the drone could use a second detuned
      oscillator and a proper doppler on the gate chime
