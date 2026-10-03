# Flock and the Night Dragon — design

Status: **built** on 2026-10-03 (branch `night-dragon`). The section "As
built" at the end lists where the build departs from this design and why.

Level 4 becomes a clear night over low mountains. A flock of about 1500 lit
drones coils around part of the gate route in the shape of a Chinese dragon.
The flock logic is a self-contained module so a later bird-flock game can reuse
it. It stays in this repo for now.

## Decisions (from the interview, 2026-10-03)

| Question | Decision |
|---|---|
| Weather | Clear night: moon, stars, no storm. The level is renamed (working title *Dragon Night*) |
| Terrain | Mountains like Alpine Valley, but lower: peaks ~450–500 instead of ~1230 |
| Dragon and gates | The dragon's fixed loop winds a helix around a stretch of the route, so those gates are always inside its coils |
| Dragon motion | A fixed loop. The dragon shape ignores the player; only the individual drones react |
| Hitting a drone | Nothing happens. Drones are tuned to always dodge. If one is touched anyway it bounces off and dims briefly |
| Drone count | ~1500 on desktop, ~600 on phones |
| Colours | Classic red-gold: red scales, gold mane and spikes, pale belly, white eyes, a glowing pearl ahead of the mouth, an occasional colour wave down the body |
| Dodge style | Early and smooth: ~1.5 s look-ahead, a tunnel opens well before the nose |
| Reuse | Player-as-flock-member and predators are supported in the module from the start |
| Priority | Pattern 1 (bird rules) always beats pattern 2 (dragon). The dragon is only an attractor |
| Reaction delay | Configurable delay before a drone registers a neighbour's movement |

## Module layout

```
src/flock/
  flock.js       createFlock(): state, step(), the rules, the priority budget
  grid.js        spatial hash (flat typed arrays, no per-frame allocation)
  history.js     ring buffer of past positions/velocities (reaction delay)
  formation.js   generic "slot" attractor: give each agent a target point + colour
  dragon.js      the Chinese-dragon formation: spine trail, body slots, colours
src/flockview.js three.js adapter: THREE.Points, sprite, interpolation (game side)
```

The `src/flock/` files never import three.js. They work on plain numbers and
`Float32Array`s, so the harness can run them headless and the bird game can
take them as they are.

## API sketch

```js
const flock = createFlock({
  count: 1500,
  seed: 777001,
  rules: { ...DEFAULT_RULES, reactionDelay: 0.08, reactionJitter: 0.03 },
});

flock.setRole(i, 'player' | 'predator' | 'flock');   // default 'flock'
flock.setFormation(dragon);                          // optional attractor

flock.step(dt, {
  threats: [{ x, y, z, vx, vy, vz, radius }],        // the plane, predators
  ground: (x, z) => height,                          // terrain avoidance
  steer: (i, out) => { ... },                        // external agents (player)
});

flock.pos, flock.vel, flock.col     // Float32Array, 3 per agent
flock.prevPos                        // for render interpolation
```

## Pattern 1 — bird rules

Every 30 Hz tick, each agent of role `flock` builds a steering acceleration
from these rules, highest priority first:

1. **Avoid threats.** Predict each threat's position over the look-ahead window
   (default 1.5 s) as a segment. If the agent is within `threatRadius` of that
   segment, steer **sideways, away from the segment**, not straight back. This
   opens a tunnel instead of a bow wave. Panic strength scales with closeness
   and with time to impact.
2. **Avoid the ground.** Look ahead along the velocity. Below `groundClearance`
   steer up. Also apply a soft ceiling.
3. **Separation** from the k nearest neighbours, falling off as 1/d.
4. **Alignment** with the k nearest neighbours' (delayed) velocities.
5. **Cohesion** towards the k nearest neighbours' (delayed) centre.
6. **Formation attractor** (pattern 2): seek the agent's slot, with arrival
   slowing.

### The priority budget

This uses Reynolds' prioritised acceleration allocation, not a weighted sum.
Each agent has `maxAccel` per tick. The rules are applied in order. Each one
takes what it asks for, up to the budget left, and the rest goes to the next
rule. A panicking drone therefore spends its whole budget on rule 1 and
ignores its slot. As the threat passes it gets its budget back and drifts home.
**The dragon can never pull a drone into the plane.**

Panic raises the budget to `panicAccel` for that agent. Calm agents use
`maxAccel`.

### Topological neighbours

Agents use their **k = 7 nearest neighbours**, not everyone within a radius.
Field studies of starlings (Ballerini et al., 2008) found this rule, and it keeps
the flock cohesive while its density changes. It is what makes a murmuration
stretch and squeeze without breaking up.

### Reaction delay

`history.js` keeps the last `K` ticks of `pos`/`vel` in a ring buffer.
`K = ceil((reactionDelay + reactionJitter) * hz) + 1`. Each tick costs one
`Float32Array.set()` per array.

Each agent gets its own delay, `reactionDelay ± reactionJitter`, drawn once
from the seed and stored in ticks. When agent *i* reads neighbour *j* for
alignment and cohesion, it reads *j*'s state from `delay_i` ticks ago, which is
an index lookup with no extra maths.

- Memory: 1500 agents × 6 floats × 4 B ≈ 36 KB per tick. A 0.5 s ceiling at
  30 Hz is ~0.5 MB.
- **The startle wave follows from this.** It spreads at about neighbour
  spacing ÷ delay, so `reactionDelay` directly sets how fast a ripple runs down
  the dragon. Default 80 ms, close to measured starling latency.
- Separation and threat avoidance read **current** state, not delayed state.
  Collisions are the one thing a drone must not be late for.
- Only multiples of the tick (33 ms at 30 Hz) are possible. Finer delays would
  need interpolation between two history slots. That is cheap, but it is left
  out unless the steps prove visible.

### Startle propagation

Each agent carries a `panic` scalar in [0, 1]. Threat avoidance sets it.
Every tick an agent takes `max(own, startleGain × max neighbour panic)` from
its (delayed) neighbours, then decays it. A drone that panics is visibly
followed by its neighbours, a fraction of a second later, even if they never
saw the threat.

### Roles

- `flock`: everything above.
- `player`: steered from outside through `steer(i, out)`. Others count it as a
  normal neighbour, so they align and cohere with it. This is the bird game.
- `predator`: pursues the nearest flock agent, which is a simple rule to
  replace later. Flock agents treat it as a threat, exactly like the plane.

## Pattern 2 — the dragon

### Spine

The head follows a closed path (`dragon.path`). The body follows the head's
own recent trail, like a snake. A ring buffer of head positions is sampled by
arc length, so the body's curves are always ones the head really flew.

The path, built from the level's gates:

- a helix around a stretch of 4–6 consecutive gates: radius ~110 m (gate
  radius is 38), pitch ~250 m, speed ~15 m/s
- then a climb and a high, sweeping return over the ridges back to the start
  of the helix
- smoothed into one closed Catmull-Rom curve

The body is ~600 m long, about two and a half coils, so that stretch of the
route is always inside coils whatever the run's timing. The level config
chooses which gates the helix wraps.

### Body slots

Each agent has a fixed slot `(s, u, v)`: arc distance from the head, and an
offset in the spine's local frame (parallel-transported, so it does not twist).
The radius tapers from ~14 m behind the head to ~3 m at the tail.

| Part | Share of drones | Notes |
|---|---|---|
| Body tube | ~60 % | rings of slots, a denser ring every ~6 m reads as scales |
| Head | ~12 % | snout, open jaw, brow, eyes |
| Mane, horns, whiskers | ~8 % | whiskers are long trailing curves from the snout |
| Back spikes | ~6 % | a row of small triangles along the top |
| Legs and claws | ~8 % | four short legs, three claws each |
| Tail tuft | ~3 % | |
| Pearl | ~3 % | a tight pulsing ball ~25 m ahead of the jaw, not attached to the body |

**The colour belongs to the slot, not the drone.** This leaves room for slot
swapping later: a drone close to a better slot can trade with its owner so the
dragon heals faster. Swapping is **not in v1**; fixed slots first.

### Colour

Red scales, gold for the mane, spikes and claws, a pale-gold belly, white-hot
eyes and a warm white pearl. Every ~20 s a brightness wave runs from head to
tail. Each drone twinkles at its own random phase, as show LEDs do.

## Rendering (`flockview.js`)

- A single `THREE.Points` with a position and colour attribute, so one draw
  call.
- The sprite is a soft round dot generated in a canvas, with additive blending.
  Its size has a floor so distant drones never vanish, and close ones grow up
  to a limit.
- Positions are interpolated between the last two sim ticks every frame.
- No post-processing bloom in v1 (too much for phones). The additive sprite
  carries the glow. Bloom could come later as a desktop-only option.

## Terrain and sky

- The terrain reuses `createAlpineShape` with a lower spec: base ~180, peaks
  ~300, a rim lift that closes the horizon, a snow line only on the highest
  ridges, and wider valleys so the helix has room. This is to be confirmed
  while building. If valleys are the wrong fit, it becomes a ridged-noise
  variant with the same shape object.
- The sky is a deep blue-black, with a moon (one emissive disc plus a halo
  sprite) and ~1500 stars as a separate `THREE.Points` on a sky dome.
- Moonlight is a cool directional light, and the terrain stays readable as
  silhouettes. The fog is thin and only on the far rim.

## Performance budget

The target is **< 1.5 ms per sim tick for 1500 agents on desktop**, run at
30 Hz. That is about 45 ms of CPU per second, or ~5 % of one core.

- **Fixed 30 Hz step** with render interpolation, so cost does not grow with
  the frame rate.
- **The spatial hash** has a cell size of about the neighbour radius and lives
  in flat `Int32Array`s (cell start and count, after a counting sort). It is
  rebuilt every tick, which is O(n).
- **Neighbour lists are refreshed every 3 ticks**, a third of the agents each
  tick. In between, the rules reuse the cached k indices, reading current or
  delayed state through them.
- **Threat broadphase.** Each threat's look-ahead segment is turned into a
  range of grid cells, and only agents in those cells run rule 1. Usually
  that is a few dozen.
- **No allocation in `step()`.** Everything is preallocated typed arrays, and
  the rules use scalar locals rather than vector objects.
- **On phones** the count drops to ~600 (40 %).
- A Web Worker is possible later, since the state is already plain buffers. It
  is not planned.

## Tests (`test/harness.mjs`, headless)

- **Separation:** after settling, no two drones are closer than `minDist`.
- **Formation:** after N s with no threats, the mean slot error is < x m.
- **Fly-through:** the line pilot flies the level, and no drone ever comes
  within the plane's radius.
- **Healing:** after the fly-through, the mean slot error is back under the
  threshold within N s.
- **Reaction delay:** startling one agent produces a panic front whose speed
  matches spacing ÷ delay within a tolerance.
- **Benchmark:** the mean `step()` time for 1500 agents is under budget. It is
  reported, and asserted with slack.
- **Determinism:** the same seed and inputs give the same positions.

## Parameters (defaults, all tunable from the level config)

| Name | Default | |
|---|---|---|
| `hz` | 30 | sim rate |
| `k` | 7 | topological neighbours |
| `minSpeed` / `maxSpeed` | 4 / 22 m/s | |
| `maxAccel` / `panicAccel` | 12 / 60 m/s² | |
| `separationDist` | 4 m | |
| `lookAhead` | 1.5 s | threat prediction window |
| `threatRadius` | 35 m | around the predicted segment |
| `reactionDelay` / `reactionJitter` | 0.08 / 0.03 s | |
| `startleGain` / `panicDecay` | 0.7 / 1.5 per s | |
| `groundClearance` | 25 m | |
| `slotArrive` | 20 m | slow-down radius for the attractor |

In `?debug` mode the main ones get live sliders, so the look can be tuned
while flying.

## Build order

1. `src/flock/` with grid, history and rules, plus headless tests and the
   benchmark
2. A free-murmuration debug view in the game (no dragon), to tune pattern 1 by
   eye
3. `dragon.js`: spine, slots, colours, then the tests for formation and healing
4. Level 4 terrain, sky, moon and stars, the helix path from the gates, and
   the rename
5. Fly-through tests with the line pilot, phone count, screenshots, README

## As built — where it differs from the draft

- **Units.** The game's unit is about one knot of the HUD: the aeroplane
  cruises at ~127 units/s, not 65. Speeds and accelerations are scaled to that
  (`maxSpeed` 65, `maxAccel` 45, `panicAccel` 140, dragon head 26 units/s).
- **The coil** goes out *and back* along the lake gates (gates 16–20 of 22),
  not out and then home high over the ridges. The draft's version would have
  wrapped only one stretch at a time; out-and-back keeps the dragon round the
  route whatever the timing. The coil radius is 60 ± 8, not 110, so its inside
  hugs the 42-unit rings and anyone flying the gates pushes into it.
- **The dodge** is a velocity target, not a push. The first build pushed every
  drone within reach of the predicted path at a fixed acceleration: no drone
  was hit, but a third of the dragon was flung 100+ units and took 20 s to
  come back. Now each drone picks the sideways speed that gets it
  `clearance` (26) off the path by the time the threat arrives, times a
  margin, and steers to that. Outside the tunnel there is only a small flinch.
  Healing is 3.5–5.5 s.
- **Cohesion with delay** compares the neighbours' delayed positions with the
  agent's own position *at the same moment*. Against its present position,
  everything delayed sits behind it and a moving flock drags itself backwards.
- **The formation** feeds the slot's velocity *and acceleration* forward and
  takes the error against the start of the tick. The slot pull's closing speed
  is limited by what the agent could brake from, so a drone flung far comes
  back fast without overshooting. Calm error went from 5 units to ~0.2.
- **Threat broadphase** is a box test per agent per threat, not a range of
  grid cells: 1,500 comparisons is cheaper than walking the cells.
- **Players** are moved by their owner (it writes their `pos`/`vel` before the
  tick) rather than through a `steer` callback.
- **Overlapping slots** are dropped at build time, features first: an eye that
  clashes with the skull keeps its place.
- **Ground** comes from a cached height grid over the lake area
  (`cacheHeights` in `src/drones.js`); the alpine height function is too slow
  to call for every drone.
- **Measured**: 1,486 drones (640 on phones), ~1.3 ms per 30 Hz tick, calm slot
  error 0.17, tunnel 34 from the aeroplane's centre, startle front 2.7 s across
  480 units at 34 ms delay vs 9.3 s at 200 ms.
