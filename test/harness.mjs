// Headless checks for the parts of the game that have no pixels: the flight
// model, the generated worlds, and gate detection. Run with `npm test`.
//
// The flight probe at the end is a crude autopilot flown over each mission.
// It is reported, not asserted: it is a weak pilot (proportional control, no
// energy management) and cannot reliably thread a 40-unit hoop with a
// 250-unit turn radius, so its score is a smoke signal rather than a spec.
import * as THREE from 'three';
import { LEVELS } from '../src/levels.js';
import { createTerrain, airportYOf, WORLD_SIZE } from '../src/terrain.js';
import { createAirport } from '../src/airport.js';
import { buildRoute, buildCanyonRoute, RingSet } from '../src/rings.js';
import { createCanyon } from '../src/canyon.js';
import { createCity } from '../src/scenery.js';
import { Plane, TUNE, NITRO } from '../src/plane.js';

let failures = 0;
const ok = (cond, msg) => {
  if (!cond) { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${msg}`); }
  return cond;
};
const STEP = 1 / 120;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function build(cfg) {
  const canyon = createCanyon(cfg, airportYOf(cfg));
  const terrain = createTerrain(cfg, canyon);
  const airport = createAirport(cfg);
  const gates = canyon
    ? buildCanyonRoute(cfg, airport, canyon)
    : buildRoute(cfg, airport, terrain.heightAt);
  const rings = new RingSet(cfg, gates);
  const corridor = [airport.center, ...gates.map((g) => g.position), airport.center];
  const city = createCity(cfg, terrain.heightAt, corridor);
  const plane = new Plane(cfg.palette);
  plane.reset(airport.start.x, airport.start.y, airport.start.z, airport.start.heading);
  return { terrain, airport, canyon, gates, rings, city, plane };
}

// --- world -----------------------------------------------------------------
function checkWorld(cfg, w) {
  const { terrain, airport, gates } = w;

  let maxDev = 0;
  for (let a = 0; a < 8; a++) {
    for (const r of [0, 60, 140, 240]) {
      const x = cfg.airport.x + Math.cos(a) * r;
      const z = cfg.airport.z + Math.sin(a) * r;
      maxDev = Math.max(maxDev, Math.abs(terrain.heightAt(x, z) - airportYOf(cfg)));
    }
  }
  ok(maxDev < 0.5, `apron not flat (max deviation ${maxDev.toFixed(2)})`);
  ok(airport.contains(airport.start.x, airport.start.z), 'start point is off the runway');

  let minClear = Infinity, maxR = 0;
  for (const g of gates) {
    minClear = Math.min(minClear, g.position.y - terrain.heightAt(g.position.x, g.position.z));
    maxR = Math.max(maxR, Math.hypot(g.position.x, g.position.z));
  }
  ok(minClear > 25, `gate too close to terrain (${minClear.toFixed(1)})`);
  ok(maxR < WORLD_SIZE * 0.5, `gate outside the playable area (${maxR.toFixed(0)})`);

  let minGap = Infinity;
  for (let i = 1; i < gates.length; i++) {
    minGap = Math.min(minGap, gates[i].position.distanceTo(gates[i - 1].position));
  }
  ok(minGap > 150, `gates bunched together (${minGap.toFixed(0)})`);

  // Canyon levels trade this contract for a different one, checked separately:
  // the gates are deliberately below the rim, so a straight line from the
  // runway to the first of them is *supposed* to be blocked — you fly over the
  // edge and drop in.
  if (cfg.canyon) return { maxDev, minClear, minGap, maxR, worstSeg: NaN, worstAt: -1 };

  // The contract the route promises: fly straight from the runway to each gate
  // in turn and back, and you will not meet the ground on the way.
  const path = [airport.center.clone(), ...gates.map((g) => g.position), airport.center.clone()];
  let worstSeg = Infinity, worstAt = -1;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], b = path[i + 1];
    const steps = Math.ceil(a.distanceTo(b) / 40);
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
      // The ends of the departure and arrival legs are meant to touch down.
      if (Math.hypot(x - airport.center.x, z - airport.center.z) < 700) continue;
      const gap = (a.y + (b.y - a.y) * t) - terrain.heightAt(x, z);
      if (gap < worstSeg) { worstSeg = gap; worstAt = i; }
    }
  }
  ok(worstSeg > 30, `route leg ${worstAt} passes too close to terrain (${worstSeg.toFixed(0)})`);

  return { maxDev, minClear, minGap, maxR, worstSeg, worstAt };
}

// --- flight model ----------------------------------------------------------
function checkPhysics(cfg, w) {
  const { plane, terrain, airport } = w;
  const world = { heightAt: terrain.heightAt, airport };
  const hold = { pitch: 0, roll: 0, yaw: 0, throttle: 1, brake: false };

  let t = 0, airborne = false;
  const x0 = plane.position.x, z0 = plane.position.z;
  while (t < 60 && !airborne) {
    const ev = plane.update(STEP, { ...hold, pitch: plane.speed >= TUNE.rotateSpeed ? 1 : 0 }, world);
    if (ev && ev.type === 'crash') { ok(false, `crashed on takeoff roll: ${ev.reason}`); break; }
    if (ev && ev.type === 'takeoff') airborne = true;
    t += STEP;
  }
  const rollDist = Math.hypot(plane.position.x - x0, plane.position.z - z0);
  ok(airborne, 'never got airborne at full throttle');
  ok(t < 30, `takeoff took too long (${t.toFixed(1)}s)`);
  ok(rollDist < 850, `takeoff roll longer than the runway (${rollDist.toFixed(0)})`);

  const yAtRotate = plane.position.y;
  for (let i = 0; i < 480; i++) plane.update(STEP, { ...hold, pitch: 0.35 }, world);
  ok(plane.position.y > yAtRotate + 100, `does not climb (${(plane.position.y - yAtRotate).toFixed(0)})`);

  for (let i = 0; i < 1800; i++) {
    plane.update(STEP, { ...hold, pitch: clamp(-plane.forward.y * 3, -1, 1) }, world);
  }
  const cruise = plane.speed; // capture now: the later tests move the aeroplane
  ok(cruise > 100 && cruise < 175, `odd level cruise speed (${cruise.toFixed(0)})`);

  // ---- handling -----------------------------------------------------------
  // These four encode the handling brief: rolling inverted must be easy, bank
  // alone must barely turn, hard turns must cost speed, and slow flight must
  // be sluggish in every axis.
  const air = { heightAt: () => -5000, airport };
  const aloft = (speed) => {
    const p2 = new Plane(cfg.palette);
    p2.reset(0, 4000, 0, 0);
    p2.onGround = false; p2.clearedRunway = true; p2.airborneFor = 99;
    p2.speed = speed; p2.throttle = 1;
    return p2;
  };
  const heading = (p2) => Math.atan2(p2.forward.x, p2.forward.z);
  const headingDelta = (a, b) => {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return Math.abs(d) * (180 / Math.PI);
  };
  // Holds a bank and a level flight path; extraPull adds back-pressure.
  const flyBanked = (p2, targetBank, extraPull, lockSpeed) => {
    const fpa = Math.asin(clamp(p2.forward.y, -1, 1));
    const roll = clamp((p2.bankAngle + targetBank) * 3, -1, 1);
    const pitch = extraPull === null ? clamp(-fpa * 4, -0.35, 0.4) : extraPull;
    p2.update(STEP, { pitch, roll, yaw: 0, throttle: 1, brake: false }, air);
    if (lockSpeed) p2.speed = lockSpeed;
  };
  const turnIn2s = (speed, bankDeg, extraPull, lockSpeed = speed) => {
    const p2 = aloft(speed);
    const target = bankDeg / 57.3;
    for (let i = 0; i < 600; i++) {
      flyBanked(p2, target, null, lockSpeed);
      if (Math.abs(p2.bankAngle + target) < 0.05) break;
    }
    const h0 = heading(p2);
    for (let i = 0; i < 240; i++) flyBanked(p2, target, extraPull, lockSpeed);
    return { turned: headingDelta(h0, heading(p2)), speed: p2.speed };
  };

  // 1. Full aileron must roll all the way over, and reasonably quickly.
  for (const speed of [60, 120]) {
    const p2 = aloft(speed);
    let invertedAt = null;
    for (let i = 0; i < 900; i++) {
      p2.update(STEP, { pitch: 0, roll: 1, yaw: 0, throttle: 1, brake: false }, air);
      p2.speed = speed;
      if (p2.up.y < 0 && invertedAt === null) invertedAt = i / 120;
    }
    ok(invertedAt !== null && invertedAt < 2.5,
      `cannot roll inverted at ${speed}kt (${invertedAt === null ? 'never' : invertedAt.toFixed(1) + 's'})`);
  }

  // 2. Bank alone is not a turn — the back-pressure is.
  const lazy = turnIn2s(120, 45, null);
  const pulled = turnIn2s(120, 45, 1);
  ok(lazy.turned < 20, `banking alone turns too much (${lazy.turned.toFixed(0)} deg in 2s)`);
  ok(pulled.turned > lazy.turned * 4,
    `pulling barely tightens the turn (${pulled.turned.toFixed(0)} vs ${lazy.turned.toFixed(0)} deg)`);

  // 3. A hard turn costs speed; a gentle one is nearly free.
  const gentle = turnIn2s(120, 50, null, 0);
  const hard = turnIn2s(120, 50, 1, 0);
  ok(gentle.speed > 115, `a gentle turn bleeds too much speed (${gentle.speed.toFixed(0)}kt)`);
  ok(hard.speed < gentle.speed - 20,
    `a hard turn costs too little speed (${hard.speed.toFixed(0)} vs ${gentle.speed.toFixed(0)}kt)`);

  // 4. Slow flight is sluggish: it turns lazily and will not climb.
  const slowTurn = turnIn2s(60, 45, 1).turned;
  const fastTurn = turnIn2s(120, 45, 1).turned;
  ok(slowTurn < fastTurn * 0.6,
    `slow flight turns as well as fast (${slowTurn.toFixed(0)} vs ${fastTurn.toFixed(0)} deg)`);

  const climbFrom = (speed) => {
    const p2 = aloft(speed);
    p2.throttle = 1;
    const y0 = p2.position.y;
    for (let i = 0; i < 360; i++) {
      p2.update(STEP, { pitch: 1, roll: 0, yaw: 0, throttle: 0, brake: false }, air);
    }
    return p2.position.y - y0;
  };
  ok(climbFrom(45) < 0, `still climbs at 45kt (${climbFrom(45).toFixed(0)})`);
  ok(climbFrom(120) > 100, `will not climb at 120kt (${climbFrom(120).toFixed(0)})`);

  // 5. Hands off, a bank washes out slowly enough to fly a turn with.
  {
    const p2 = aloft(120);
    for (let i = 0; i < 600; i++) {
      flyBanked(p2, 40 / 57.3, null, 120);
      if (Math.abs(p2.bankAngle + 40 / 57.3) < 0.05) break;
    }
    let t = 0;
    while (t < 40 && Math.abs(p2.bankAngle) > 0.09) {
      p2.update(STEP, { pitch: 0, roll: 0, yaw: 0, throttle: 1, brake: false }, air);
      p2.speed = 120;
      t += STEP;
    }
    ok(t > 4, `wings snap level too fast to hold a turn (${t.toFixed(1)}s from 40 deg)`);
    ok(t < 30, `wings never return to level (${t.toFixed(1)}s from 40 deg)`);
  }

  // Wheel brakes must stop a landing roll well inside the runway.
  {
    const p2 = new Plane(cfg.palette);
    p2.reset(airport.start.x, airport.surfaceY, airport.start.z, airport.start.heading);
    p2.speed = 100;
    const x0 = p2.position.x, z0 = p2.position.z;
    let rolled = 0, stopped = false;
    for (let i = 0; i < 3600; i++) {
      p2.update(STEP, { pitch: 0, roll: 0, yaw: 0, throttle: -1, brake: true }, world);
      rolled = Math.hypot(p2.position.x - x0, p2.position.z - z0);
      if (p2.speed < 1) { stopped = true; break; }
    }
    ok(stopped && rolled < 420, `braking from 100kt took ${rolled.toFixed(0)} units`);

    // ...and they have to actually beat coasting.
    const p3 = new Plane(cfg.palette);
    p3.reset(airport.start.x, airport.surfaceY, airport.start.z, airport.start.heading);
    p3.speed = 100;
    for (let i = 0; i < 240; i++) {
      p3.update(STEP, { pitch: 0, roll: 0, yaw: 0, throttle: -1, brake: false }, world);
    }
    const p4 = new Plane(cfg.palette);
    p4.reset(airport.start.x, airport.surfaceY, airport.start.z, airport.start.heading);
    p4.speed = 100;
    for (let i = 0; i < 240; i++) {
      p4.update(STEP, { pitch: 0, roll: 0, yaw: 0, throttle: -1, brake: true }, world);
    }
    ok(p4.speed < p3.speed - 20, `brake barely helps (${p4.speed.toFixed(0)} vs ${p3.speed.toFixed(0)} coasting)`);
  }

  // Gear: retracting must be worth real speed, and only work in the air.
  {
    const cruise = (gearDown) => {
      const p2 = new Plane(cfg.palette);
      p2.reset(0, 900, 0, 0);
      p2.onGround = false; p2.clearedRunway = true; p2.airborneFor = 99;
      p2.speed = 120; p2.throttle = 1; p2.gearDown = gearDown; p2.gearPos = gearDown ? 1 : 0;
      for (let i = 0; i < 4800; i++) {
        p2.update(STEP, { pitch: clamp(-p2.forward.y * 3, -1, 1), roll: 0, yaw: 0, throttle: 1, brake: false },
          { heightAt: () => -1000, airport });
      }
      return p2.speed;
    };
    const down = cruise(true), up = cruise(false);
    ok(up > down + 8, `gear up is not faster (${up.toFixed(0)} vs ${down.toFixed(0)})`);

    const onGround = new Plane(cfg.palette);
    onGround.reset(airport.start.x, airport.surfaceY, airport.start.z, airport.start.heading);
    ok(!onGround.toggleGear(), 'gear can be retracted while sitting on the runway');
    ok(onGround.gearDown, 'gear state changed despite the request being refused');

    const flying = new Plane(cfg.palette);
    flying.reset(0, 900, 0, 0);
    flying.onGround = false;
    ok(flying.toggleGear() && !flying.gearDown, 'gear cannot be retracted in the air');
    // Mid-travel must not count as down: that is what makes it a real decision.
    for (let i = 0; i < 48; i++) {   // 0.4s of a 1.2s travel
      flying.update(STEP, { pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: false },
        { heightAt: () => -1000, airport });
    }
    ok(flying.gearPos > 0.05 && flying.gearPos < 0.9,
      `gear travel is not gradual (pos ${flying.gearPos.toFixed(2)} after 0.4s)`);
    ok(!flying.gearLocked, 'gear counts as locked while still travelling');
  }

  // A gear-up arrival slides instead of landing, and cannot complete a mission.
  {
    const p2 = new Plane(cfg.palette);
    p2.reset(airport.center.x, airport.surfaceY + 3, airport.center.z, cfg.runwayHeading ?? 0);
    p2.onGround = false; p2.clearedRunway = true; p2.airborneFor = 99;
    p2.speed = 80; p2.gearDown = false; p2.gearPos = 0;
    let ev = null;
    for (let i = 0; i < 400 && !ev; i++) {
      ev = p2.update(STEP, { pitch: -0.05, roll: 0, yaw: 0, throttle: 0, brake: false }, world);
    }
    ok(ev && ev.type === 'belly', `gear-up arrival gave ${ev ? ev.type : 'nothing'} instead of a belly slide`);
    ok(p2.bellySliding && p2.onGround, 'belly arrival did not leave the aeroplane sliding');

    const before = p2.speed;
    for (let i = 0; i < 120; i++) {
      p2.update(STEP, { pitch: 0, roll: 0, yaw: 0, throttle: 1, brake: false }, world);
    }
    ok(p2.speed < before, 'belly slide does not scrub off speed');
    ok(p2.position.y >= airport.bellyY - 0.01, 'belly slide sank into the runway');
  }

  // Nitro: a real surge, for exactly as long as advertised, then a cooldown.
  {
    const air = { heightAt: () => -1000, airport };
    const level = (p2) => ({ pitch: clamp(-p2.forward.y * 3, -1, 1), roll: 0, yaw: 0, throttle: 1, brake: false });
    const fly = (p2, seconds) => {
      for (let i = 0; i < seconds * 120; i++) p2.update(STEP, level(p2), air);
    };
    const make = () => {
      const p2 = new Plane(cfg.palette);
      p2.reset(0, 900, 0, 0);
      p2.onGround = false; p2.clearedRunway = true; p2.airborneFor = 99;
      p2.speed = 126; p2.throttle = 1;
      return p2;
    };

    const plain = make(); fly(plain, 5);
    const boosted = make();
    ok(boosted.fireNitro(), 'nitro refuses to fire when charged');
    fly(boosted, 5);
    ok(boosted.speed > plain.speed + 30,
      `nitro barely accelerates (${boosted.speed.toFixed(0)} vs ${plain.speed.toFixed(0)})`);

    // It must not be re-armed while burning, and must expire on schedule.
    ok(!boosted.fireNitro(), 'nitro can be re-fired while already burning');
    ok(!boosted.nitroActive, `nitro still burning after ${NITRO.duration}s`);
    ok(boosted.nitroCooldown > 0 && !boosted.nitroReady, 'nitro is ready again immediately after burning');

    // Still recharging one second short of the cooldown...
    fly(boosted, NITRO.cooldown - 1);
    ok(!boosted.nitroReady, 'nitro recharged early');
    // ...and ready once it has fully elapsed.
    fly(boosted, 1.2);
    ok(boosted.nitroReady, `nitro never recharged (${boosted.nitroCooldown.toFixed(1)}s left)`);
    ok(boosted.fireNitro(), 'recharged nitro will not fire');

    // The ramp is what makes it smooth rather than a step change.
    const ramping = make();
    ramping.fireNitro();
    ramping.update(STEP, level(ramping), air);
    ok(ramping.nitroBlend > 0 && ramping.nitroBlend < 0.2,
      `nitro snaps on instead of ramping (blend ${ramping.nitroBlend.toFixed(2)})`);
  }

  // Stall, then recovery.
  let minSpeed = Infinity, stalled = false;
  for (let i = 0; i < 2400; i++) {
    plane.update(STEP, { pitch: 1, roll: 0, yaw: 0, throttle: -1, brake: false }, world);
    minSpeed = Math.min(minSpeed, plane.speed);
    if (plane.speed < TUNE.stall) stalled = true;
  }
  ok(stalled, `never stalls with power off and nose up (min ${minSpeed.toFixed(0)})`);
  for (let i = 0; i < 1200; i++) {
    plane.update(STEP, { pitch: -0.3, roll: 0, yaw: 0, throttle: 1, brake: false }, world);
  }
  ok(plane.speed > TUNE.stall * 1.5, `cannot recover from a stall (${plane.speed.toFixed(0)})`);

  return {
    takeoffTime: t, rollDist, cruise, minSpeed,
    lazyTurn: lazy.turned, pulledTurn: pulled.turned,
    hardTurnSpeed: hard.speed, slowTurn, fastTurn,
  };
}

// --- canyon ----------------------------------------------------------------
// The canyon promises something different from the open routes: every gate but
// the last is inside the gorge, and consecutive gates are close enough that
// the straight line between them stays between the walls.
function checkCanyon(cfg, w) {
  const { canyon, gates, terrain, airport } = w;
  const spec = cfg.canyon;
  const canyonGates = gates.slice(0, -1);
  const finalGate = gates[gates.length - 1];

  ok(canyonGates.length >= 8, `canyon has only ${canyonGates.length} gates in it`);
  ok(canyon.length > 4000, `canyon is only ${canyon.length.toFixed(0)} units long`);

  let inside = 0, minBelowRim = Infinity;
  for (const g of canyonGates) {
    const p = g.position;
    if (canyon.contains(p.x, p.z, 0)) inside++;
    // Sample the rim square to the canyon, out past the far edge of the wall.
    const q = canyon.query(p.x, p.z);
    const d = canyon.dirAt(q.u);
    const out = spec.halfWidth + spec.rim + 90;
    const rim = Math.max(
      terrain.heightAt(p.x - d.y * out, p.z + d.x * out),
      terrain.heightAt(p.x + d.y * out, p.z - d.x * out),
    );
    minBelowRim = Math.min(minBelowRim, rim - p.y);
  }
  ok(inside === canyonGates.length,
    `${canyonGates.length - inside} canyon gates are outside the walls`);
  ok(minBelowRim > 60, `a canyon gate sits only ${minBelowRim.toFixed(0)} below the rim`);

  // The last gate is the one exception: out in the open, on final approach,
  // and clear of the carved zone entirely rather than just of the walls.
  const fq = canyon.query(finalGate.position.x, finalGate.position.z);
  ok(!fq || fq.dist > spec.halfWidth + spec.rim,
    `the final gate is ${fq ? fq.dist.toFixed(0) : '?'} from the canyon centreline,`
    + ` inside the carved zone (${spec.halfWidth + spec.rim})`);

  // Chords between consecutive gates must not cut through a wall.
  let worstChord = 0;
  for (let i = 0; i < canyonGates.length - 1; i++) {
    const a = canyonGates[i].position, b = canyonGates[i + 1].position;
    for (let s2 = 0; s2 <= 12; s2++) {
      const t = s2 / 12;
      const q = canyon.query(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
      worstChord = Math.max(worstChord, q ? q.dist : Infinity);
    }
  }
  ok(worstChord < spec.halfWidth,
    `a chord strays ${worstChord.toFixed(0)} from the centreline (walls at ${spec.halfWidth})`);

  // ...and the gorge must not eat the runway.
  let nearest = Infinity;
  for (let i = 0; i <= 200; i++) {
    const p = canyon.pointAt(i / 200);
    nearest = Math.min(nearest, Math.hypot(p.x - airport.center.x, p.y - airport.center.z));
  }
  ok(nearest > 700, `the canyon comes within ${nearest.toFixed(0)} of the runway`);

  return { count: canyonGates.length, length: canyon.length, worstChord, minBelowRim, nearest };
}

// --- ground is solid ------------------------------------------------------
// Whatever happens, the aeroplane must never come to rest inside the scenery.
function checkGround(cfg, w) {
  const { terrain, airport } = w;
  const world = { heightAt: terrain.heightAt, airport };

  const floorAt = (x, z) => (airport.contains(x, z)
    ? airport.surfaceY
    : Math.max(terrain.heightAt(x, z), 0));

  const dive = (label, opts) => {
    const plane = new Plane(cfg.palette);
    plane.reset(opts.x, opts.y, opts.z, opts.heading ?? 0);
    plane.onGround = false;
    plane.clearedRunway = true;
    plane.airborneFor = 99;
    plane.speed = opts.speed;
    plane.throttle = 1;

    let worst = Infinity;
    for (let i = 0; i < 4000; i++) {
      const ev = plane.update(STEP, { pitch: opts.pitch, roll: 0, yaw: 0, throttle: 0, brake: false }, world);
      const below = plane.position.y - floorAt(plane.position.x, plane.position.z);
      worst = Math.min(worst, below);
      if (ev && (ev.type === 'crash' || ev.type === 'touchdown')) break;
    }
    // A small tolerance: the origin sits above the wheels, so resting on the
    // surface reads as a positive gap, never a negative one.
    ok(worst > -0.5, `${label}: ended up ${(-worst).toFixed(1)} below the surface`);
    return worst;
  };

  // Steep dive into open terrain at high speed — the tunnelling case.
  dive('terrain dive', { x: 0, y: 900, z: 0, speed: TUNE.maxSpeed, pitch: -1 });

  // Straight down onto the runway.
  dive('runway plant', {
    x: airport.center.x, y: airport.center.y + 500, z: airport.center.z,
    heading: cfg.runwayHeading ?? 0, speed: 150, pitch: -1,
  });

  // Sinking onto the runway before ever having climbed away: the aeroplane
  // must be stopped by the tarmac even though this cannot count as a landing.
  const plane = new Plane(cfg.palette);
  plane.reset(airport.start.x, airport.surfaceY + 6, airport.start.z, airport.start.heading);
  plane.onGround = false;
  plane.clearedRunway = false;
  plane.airborneFor = 0;
  plane.speed = 60;
  let lowest = Infinity;
  for (let i = 0; i < 600; i++) {
    plane.update(STEP, { pitch: -0.2, roll: 0, yaw: 0, throttle: 0, brake: false }, world);
    lowest = Math.min(lowest, plane.position.y - airport.surfaceY);
  }
  ok(lowest > -0.5, `un-armed descent sank ${(-lowest).toFixed(1)} through the runway`);
}

// --- gate detection --------------------------------------------------------
function checkGates(cfg, w) {
  const { gates } = w;
  const fwd = new THREE.Vector3();
  const right = new THREE.Vector3();

  // Reuse the route the level was actually built with — rebuilding it here
  // would call the open-country builder even on a canyon level, which has no
  // config for it.
  const fly = (offsetFactor) => {
    const rings = new RingSet(cfg, gates);
    const g = rings.rings[0];
    fwd.set(0, 0, -1).applyQuaternion(g.quaternion);
    right.set(1, 0, 0).applyQuaternion(g.quaternion);
    const p = g.position.clone()
      .addScaledVector(fwd, -400)
      .addScaledVector(right, rings.radius * offsetFactor);
    for (let i = 0; i < 800; i++) {
      p.addScaledVector(fwd, 1);
      if (rings.update(STEP, p)) return true;
    }
    return false;
  };

  ok(fly(0), 'flying dead centre through a gate does not register');
  ok(fly(0.7), 'flying just inside the rim does not register');
  ok(!fly(1.8), 'passing well outside the rim still registers');

  // A single frame must not tunnel through the gate plane unnoticed.
  const rings = new RingSet(cfg, gates);
  const g = rings.rings[0];
  fwd.set(0, 0, -1).applyQuaternion(g.quaternion);
  const before = g.position.clone().addScaledVector(fwd, -90);
  const after = g.position.clone().addScaledVector(fwd, 90);
  rings.update(STEP, before);
  ok(rings.update(STEP, after), 'a fast pass tunnels straight through the gate');
}

// --- autopilot -------------------------------------------------------------
// Deliberately a mediocre pilot: proportional attitude control, look-ahead
// terrain avoidance, a shallow glideslope and a flare.
function flyMission(w) {
  const { plane, terrain, airport, rings, city } = w;
  const world = { heightAt: terrain.heightAt, airport };
  plane.reset(airport.start.x, airport.start.y, airport.start.z, airport.start.heading);

  const q = new THREE.Quaternion();
  const dir = new THREE.Vector3();
  const local = new THREE.Vector3();
  const gateFwd = new THREE.Vector3();
  const BACK = new THREE.Vector3(0, 0, -1);

  let t = 0, landed = false, crash = null, hitTower = false, worstAgl = Infinity;
  let committedTo = -1;   // gate we have decided to fly through, with hysteresis

  while (t < 420) {
    const info = airport.approachInfo(plane);
    let target, wantSpeed = 115;

    if (!rings.done) {
      // Line up on the gate's own axis rather than flying at the hoop itself,
      // otherwise you arrive across it and end up orbiting.
      const gate = rings.next;
      gateFwd.copy(BACK).applyQuaternion(gate.quaternion);
      const range = gate.position.distanceTo(plane.position);
      const aligned = plane.forward.dot(gateFwd);
      target = gate.position.clone();

      // Commit or break off, and STAY committed. Re-deciding every frame makes
      // the aim point jump a kilometre back and forth and the aeroplane just
      // orbits the gate.
      if (committedTo !== rings.index && range < 700 && aligned > 0.55) {
        committedTo = rings.index;
      } else if (committedTo === rings.index && range > 1200) {
        committedTo = -1;
      }

      if (committedTo === rings.index) target.addScaledVector(gateFwd, 200);
      else if (range < 1100) target.addScaledVector(gateFwd, -1100);
      else target.addScaledVector(gateFwd, -350);
    } else {
      const aimAlong = Math.max(-200, info.along - 700);
      target = airport.center.clone().addScaledVector(airport.axis, -aimAlong);
      target.y = airport.surfaceY + Math.max(0, aimAlong - 200) * 0.055;
      wantSpeed = info.along < 1600 ? 80 : 105;
    }

    dir.copy(target).sub(plane.position).normalize();
    q.copy(plane.quaternion).conjugate();
    local.copy(dir).applyQuaternion(q);

    // Steering works on ATTITUDE, not rate. The controls are rate commands, so
    // asking for "nose up" without a target angle simply loops the aeroplane.
    const hErr = Math.atan2(local.x, -local.z);            // + means target right
    const fpaNow = Math.asin(clamp(plane.forward.y, -1, 1));
    const bankNow = Math.asin(clamp(plane.bank, -1, 1));   // + means banked left

    let wantFpa = clamp(Math.asin(clamp(dir.y, -1, 1)), -0.45, 0.45);
    let wantBank = clamp(-hErr * 2.4, -1.2, 1.2);          // bank right to go right

    if (!plane.onGround) {
      const fx = plane.forward.x, fz = plane.forward.z;
      let rise = -Infinity;
      for (const d of [150, 300, 500, 750, 1000]) {
        rise = Math.max(rise, terrain.heightAt(plane.position.x + fx * d, plane.position.z + fz * d));
      }
      const agl = plane.position.y - terrain.heightAt(plane.position.x, plane.position.z);
      worstAgl = Math.min(worstAgl, agl);

      // Standard departure: climb straight ahead before turning.
      if (plane.airborneFor < 6 || info.height < 90) {
        wantBank = clamp(wantBank, -0.35, 0.35);
        wantFpa = Math.max(wantFpa, 0.22);
      }

      if (rise + 200 > plane.position.y || agl < 220) {
        wantFpa = Math.max(wantFpa, 0.3);
        // Pulling back in a steep bank turns you instead of lifting you.
        wantBank = clamp(wantBank, -0.4, 0.4);
      }
      // Speed is life: never hold a climb the wing cannot pay for.
      wantFpa = Math.min(wantFpa, clamp((plane.speed - TUNE.stall * 2) / 90, -0.45, 0.45));

      if (rings.done && info.height < 90) {
        wantFpa = Math.max(wantFpa, info.height < 25 ? -0.02 : -0.05); // flare
        wantBank = clamp(wantBank, -0.25, 0.25);
      }
    }

    // Bank no longer turns the aeroplane on its own, so the pilot has to pull
    // through a turn — roughly in proportion to how hard it is banked.
    const turnPull = Math.min(0.85, Math.abs(bankNow) * 0.9);
    let pitch = clamp((wantFpa - fpaNow) * 3.5 + (plane.onGround ? 0 : turnPull), -1, 1);
    let roll = clamp((bankNow - wantBank) * 2.5, -1, 1);
    let throttle = plane.speed < wantSpeed ? 1 : -1;
    let brake = false;

    if (plane.onGround) {
      if (!landed) { pitch = plane.speed >= TUNE.rotateSpeed ? 1 : 0; roll = 0; throttle = 1; }
      else { throttle = -1; brake = true; pitch = 0; roll = 0; }
    }

    const ev = plane.update(STEP, { pitch, roll, yaw: 0, throttle, brake }, world);
    rings.update(STEP, plane.position);

    if (ev) {
      if (ev.type === 'crash') { crash = ev.reason; break; }
      if (ev.type === 'touchdown' && rings.done) landed = true;
    }
    if (city && !plane.onGround
        && city.collides(plane.position.x, plane.position.y, plane.position.z)) {
      hitTower = true; break;
    }
    if (landed && plane.onGround && plane.speed < 4) break;
    t += STEP;
  }

  const where = plane.position.clone();
  return {
    t, gates: rings.index, total: rings.total, landed,
    stopped: landed && plane.speed < 4, crash, hitTower, worstAgl, where,
    speed: plane.speed,
    agl: where.y - terrain.heightAt(where.x, where.z),
    toTarget: rings.done ? -1 : rings.next.position.distanceTo(where),
  };
}

// --- run -------------------------------------------------------------------
console.log('');
for (const cfg of LEVELS) {
  console.log(`\x1b[1m${cfg.name}\x1b[0m`);
  const world = checkWorld(cfg, build(cfg));
  console.log(`  world   apron±${world.maxDev.toFixed(2)}  gate clearance ${world.minClear.toFixed(0)}`
    + `  min gap ${world.minGap.toFixed(0)}  tightest leg ${world.worstSeg.toFixed(0)} (leg ${world.worstAt})`);

  checkGates(cfg, build(cfg));
  checkGround(cfg, build(cfg));
  if (cfg.canyon) {
    const c = checkCanyon(cfg, build(cfg));
    console.log(`  canyon  ${c.length.toFixed(0)} units, ${c.count} gates inside`
      + `  chords stray ${c.worstChord.toFixed(0)}/${cfg.canyon.halfWidth}`
      + `  gates ${c.minBelowRim.toFixed(0)}+ below the rim`
      + `  runway clear by ${c.nearest.toFixed(0)}`);
  }
  const phys = checkPhysics(cfg, build(cfg));
  console.log(`  flight  rotate ${phys.takeoffTime.toFixed(1)}s / ${phys.rollDist.toFixed(0)}m`
    + `  cruise ${phys.cruise.toFixed(0)}  stall min ${phys.minSpeed.toFixed(0)}`);
  console.log(`  turns   45deg bank: ${phys.lazyTurn.toFixed(0)}deg/2s alone, `
    + `${phys.pulledTurn.toFixed(0)}deg/2s pulling  |  slow ${phys.slowTurn.toFixed(0)} vs fast ${phys.fastTurn.toFixed(0)}deg`
    + `  |  hard turn ends at ${phys.hardTurnSpeed.toFixed(0)}kt`);

  const m = flyMission(build(cfg));
  const verdict = m.crash ? `CRASH: ${m.crash}` : m.hitTower ? 'CRASH: tower'
    : m.stopped ? 'landed' : 'timed out';
  console.log(`  probe   ${m.gates}/${m.total} gates in ${m.t.toFixed(0)}s — ${verdict} (informational)`);
  if (m.crash || m.hitTower || !m.stopped) {
    console.log(`          at (${m.where.x.toFixed(0)}, ${m.where.y.toFixed(0)}, ${m.where.z.toFixed(0)})`
      + `  agl ${m.agl.toFixed(0)}  spd ${m.speed.toFixed(0)}`
      + `  ${m.toTarget >= 0 ? `${m.toTarget.toFixed(0)} from next gate` : 'on approach'}`);
  }
  console.log('');
}

console.log(failures ? `\x1b[31m${failures} check(s) failed\x1b[0m` : '\x1b[32mall checks passed\x1b[0m');
process.exit(failures ? 1 : 0);
