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
import { buildRoute, buildCanyonRoute, buildCityRoute, buildAlpineRoute, RingSet } from '../src/rings.js';
import { createCanyon } from '../src/canyon.js';
import { padToAxes } from '../src/touch.js';
import { createCity } from '../src/city.js';
import { createAlpineShape, createAlpineProps } from '../src/alps.js';
import { Plane, TUNE, NITRO } from '../src/plane.js';
import { createLinePilot, steerTowards } from '../src/linepilot.js';
import { createFlock, ROLE } from '../src/flock/flock.js';
import { createDragon } from '../src/flock/dragon.js';
import { createDrones } from '../src/drones.js';
import { Recorder, decode, sample, poseAt, SAMPLE_EVERY } from '../src/replay.js';
import { createFlybyPlanner, sightClear } from '../src/replaycam.js';

let failures = 0;
const ok = (cond, msg) => {
  if (!cond) { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${msg}`); }
  return cond;
};
const STEP = 1 / 120;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function build(cfg) {
  const canyon = createCanyon(cfg, airportYOf(cfg));
  const alps = createAlpineShape(cfg);
  const terrain = createTerrain(cfg, canyon, alps);
  const airport = createAirport(cfg);
  const city = createCity(cfg);
  let gates;
  if (canyon) gates = buildCanyonRoute(cfg, airport, canyon, terrain.heightAt);
  else if (city) gates = buildCityRoute(cfg, airport, terrain.heightAt);
  else if (alps) gates = buildAlpineRoute(cfg, airport, alps, terrain.heightAt);
  else gates = buildRoute(cfg, airport, terrain.heightAt);
  const rings = new RingSet(cfg, gates);
  const props = city
    ?? (alps ? createAlpineProps(cfg, alps, terrain.heightAt, gates[gates.summit]) : null);
  const plane = new Plane(cfg.palette);
  plane.reset(airport.start.x, airport.start.y, airport.start.z, airport.start.heading);
  return { terrain, airport, canyon, alps, gates, rings, city, props, plane };
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

    const plain = make(); fly(plain, NITRO.duration);
    const boosted = make();
    ok(boosted.fireNitro(), 'nitro refuses to fire when charged');
    fly(boosted, NITRO.duration);
    ok(boosted.speed > plain.speed + 120,
      `nitro barely accelerates (${boosted.speed.toFixed(0)} vs ${plain.speed.toFixed(0)})`);

    // The speed ceiling must stay above what the thrust can reach, or it
    // swallows the boost: every multiplier feels the same and the gear stops
    // making any difference while the burn is lit.
    const boostedGearUp = make();
    boostedGearUp.gearDown = false; boostedGearUp.gearPos = 0;
    boostedGearUp.fireNitro();
    fly(boostedGearUp, NITRO.duration);
    ok(boostedGearUp.speed > boosted.speed + 10,
      `gear makes no difference under nitro (${boostedGearUp.speed.toFixed(0)} vs ${boosted.speed.toFixed(0)}kt)`
      + ' — the speed cap is swallowing the boost');

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

  // Braking on approach must not fly the aeroplane into the ground.
  //
  // The airbrake is the obvious thing to press to slow down for a landing, and
  // it used to drag the aeroplane below the speed where the nose sags and it
  // sinks whatever the elevator asks — a stable approach turned into an 11
  // units/s descent and a hard arrival. The elevator here is deliberately
  // gentle, like someone trimmed for the approach rather than fighting it.
  {
    const p2 = aloft(95);
    p2.throttle = 0.35;
    let worstDescent = 0;
    for (let i = 0; i < 25 * 120; i++) {
      const fpa = Math.asin(clamp(p2.forward.y, -1, 1));
      p2.update(STEP, {
        pitch: clamp((-0.06 - fpa) * 3.5, -1, 1),
        roll: 0, yaw: 0, throttle: 0, throttleAbs: 0.35, brake: true,
      }, air);
      worstDescent = Math.max(worstDescent, -p2.velocity.y);
    }
    ok(p2.speed >= TUNE.mushSpeed,
      `the airbrake drags the aeroplane into the mush band (${p2.speed.toFixed(0)}kt,`
      + ` sagging starts at ${TUNE.mushSpeed})`);
    ok(worstDescent < 8,
      `braking on a stable approach builds ${worstDescent.toFixed(1)} units/s of descent`
      + ' (touchdown limit is 15)');

    // ...but it must still be able to rescue an arrival that is too fast.
    const p3 = aloft(135);
    for (let i = 0; i < 12 * 120; i++) {
      const fpa = Math.asin(clamp(p3.forward.y, -1, 1));
      p3.update(STEP, {
        pitch: clamp((-0.06 - fpa) * 3.5, -1, 1),
        roll: 0, yaw: 0, throttle: 0, throttleAbs: 0, brake: true,
      }, air);
    }
    ok(p3.speed < 100, `the airbrake no longer slows a fast arrival (${p3.speed.toFixed(0)}kt)`);
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

  // Which gates are actually in the gorge — the departure gate and the whole
  // repositioning sweep are outside it by design, so this cannot be an index.
  const rimAt = (p) => {
    const q = canyon.query(p.x, p.z);
    if (!q) return -Infinity;
    const d = canyon.dirAt(q.u);
    const out = spec.halfWidth + spec.rim + 90;
    return Math.max(
      terrain.heightAt(p.x - d.y * out, p.z + d.x * out),
      terrain.heightAt(p.x + d.y * out, p.z - d.x * out),
    );
  };
  const inGorge = gates
    .map((g, i) => ({ i, p: g.position }))
    .filter(({ p }) => canyon.contains(p.x, p.z, 0) && p.y < rimAt(p));

  ok(inGorge.length >= 8, `only ${inGorge.length} gates are down in the gorge`);
  ok(canyon.length > 4000, `canyon is only ${canyon.length.toFixed(0)} units long`);

  // They have to be one unbroken run: in, round, and out once.
  const contiguous = inGorge.every((g, k) => k === 0 || g.i === inGorge[k - 1].i + 1);
  ok(contiguous, 'the gates in the gorge are not one continuous run');

  let minBelowRim = Infinity;
  for (const { p } of inGorge) minBelowRim = Math.min(minBelowRim, rimAt(p) - p.y);
  ok(minBelowRim > 60, `a gate sits only ${minBelowRim.toFixed(0)} below the rim`);

  // First and last gates are the exceptions: out in the open.
  const first = gates[0].position;
  const last = gates[gates.length - 1].position;
  ok(!canyon.contains(first.x, first.z, 0), 'the departure gate is inside the canyon');
  const fq = canyon.query(last.x, last.z);
  ok(!fq || fq.dist > spec.halfWidth + spec.rim,
    `the final gate is ${fq ? fq.dist.toFixed(0) : '?'} from the centreline, inside the carved zone`);

  // Chords between gates in the gorge must not cut through a wall.
  let worstChord = 0;
  for (let k = 0; k < inGorge.length - 1; k++) {
    const a2 = inGorge[k].p, b2 = inGorge[k + 1].p;
    for (let s2 = 0; s2 <= 12; s2++) {
      const t = s2 / 12;
      const q = canyon.query(a2.x + (b2.x - a2.x) * t, a2.z + (b2.z - a2.z) * t);
      worstChord = Math.max(worstChord, q ? q.dist : Infinity);
    }
  }
  ok(worstChord < spec.halfWidth,
    `a chord strays ${worstChord.toFixed(0)} from the centreline (walls at ${spec.halfWidth})`);

  let nearest = Infinity;
  for (let i = 0; i <= 200; i++) {
    const p = canyon.pointAt(i / 200);
    nearest = Math.min(nearest, Math.hypot(p.x - airport.center.x, p.y - airport.center.z));
  }
  ok(nearest > 700, `the canyon comes within ${nearest.toFixed(0)} of the runway`);

  return { count: inGorge.length, length: canyon.length, worstChord, minBelowRim, nearest };
}

// --- the city --------------------------------------------------------------
// City Towers promises that the route is flown *in* the streets: the gates sit
// below the rooftops, the legs between them are clear of every building, and
// the special gates really are under the bridges and inside the Arche. Then a
// line-following pilot flies the street run under the real flight model, which
// is the proof that it can be done rather than an argument that it should be.
function checkCity(cfg, w) {
  const { city, gates } = w;
  const spec = cfg.city;
  const b = spec.bounds;
  const r = cfg.route.ringRadius;

  // The street run starts at the first gate on the city's edge.
  const first = gates.findIndex((g) => g.position.z > b.z0 - 200
    && Math.abs(g.position.x) < b.x1 && g.position.y - spec.ground < 120);
  ok(first > 0, 'no gate found at the city entrance');
  const run = gates.slice(first);

  // Among the buildings, not above them.
  const below = run.filter((g) => city.skylineNear(g.position.x, g.position.z, 110) > g.position.y + 40);
  ok(below.length >= run.length * 0.6,
    `only ${below.length}/${run.length} city gates are below the surrounding rooftops`);

  // Every leg is clear of every building, with room for the wings.
  let tightest = Infinity, tightAt = -1;
  for (let i = first; i < gates.length - 1; i++) {
    const a = gates[i].position, c = gates[i + 1].position;
    const n = Math.ceil(a.distanceTo(c) / 3);
    for (let k = 0; k <= n; k++) {
      const p = a.clone().lerp(c, k / n);
      let m = 0;
      while (m < 40 && !city.collides(p.x, p.y, p.z, m)) m += 2;
      if (m < tightest) { tightest = m; tightAt = i; }
    }
  }
  ok(tightest >= 12, `leg ${tightAt} passes within ${tightest} of a building`);

  // The last gate is inside the Arche's opening, with room round the ring.
  const last = gates[gates.length - 1].position;
  const A = city.arch;
  ok(last.x - r > A.x0 && last.x + r < A.x1, 'the Arche gate does not fit between the pillars');
  ok(last.y - r > A.y0 && last.y + r < A.y1, 'the Arche gate does not fit under the roof');
  ok(Math.abs(last.z - A.z) < 5, 'the last gate is not in the Arche');

  // Each skybridge has a gate under it, and the ring clears the bridge.
  for (const br of spec.bridges) {
    const under = run.find((g) => g.position.x > br.x0 - 5 && g.position.x < br.x1 + 5
      && g.position.z > br.z0 - 5 && g.position.z < br.z1 + 5);
    ok(!!under, `no gate under the bridge at ${br.x0},${br.z0}`);
    if (under) {
      ok(under.position.y + r < spec.ground + br.y0 - 4,
        `the gate under the bridge at ${br.x0},${br.z0} touches it`);
    }
  }

  const fly = (speed) => flyLine(w, first - 1, speed);
  const slow = fly(100), fast = fly(120);
  for (const f of [slow, fast]) {
    ok(!f.crash && f.gates === gates.length,
      `line pilot at ${f.speed}kt: ${f.gates}/${gates.length} gates, ${f.crash ?? 'no crash'}`);
  }
  return { first, run: run.length, below: below.length, tightest, slow, fast, stats: city.stats };
}

/**
 * Flies the racing line through the gates under the real flight model.
 *
 * The line is a centripetal Catmull-Rom through the gates. The pilot steers
 * bank-to-turn: roll until the lift points at where the line is going, then
 * pull. It starts in the air at gate `from`, and anything solid in the
 * level's props counts as a crash, as does the ground.
 */
function flyLine(w, from, speed) {
  const { terrain, airport, gates, props } = w;
  const plane = new Plane(LEVELS[0].palette);
  const rings = new RingSet({ route: { ringRadius: w.rings.radius } }, gates);
  const world = { heightAt: terrain.heightAt, airport };

  const pts = gates.slice(from).map((g) => g.position.clone());
  const out = pts[pts.length - 1].clone().addScaledVector(airport.axis, 250);
  out.y -= 20;
  pts.push(out);
  const line = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  const N = 4000;
  const samples = line.getSpacedPoints(N);
  const step = line.getLength() / N;

  plane.reset(pts[0].x, pts[0].y, pts[0].z, 0);
  Object.assign(plane, {
    onGround: false, speed, throttle: 0.8, airborneFor: 10, clearedRunway: true,
    gearDown: false, gearPos: 0,
  });
  plane.quaternion.setFromRotationMatrix(
    new THREE.Matrix4().lookAt(pts[0], samples[5], new THREE.Vector3(0, 1, 0)));
  rings.index = from + 1;

  let at = 0, t = 0, crash = null, worst = 0;
  while (t < 240 && at < N - 5) {
    let best = Infinity;
    for (let i = at; i < Math.min(N, at + 200); i++) {
      const d = samples[i].distanceToSquared(plane.position);
      if (d < best) { best = d; at = i; }
    }
    worst = Math.max(worst, Math.sqrt(best));

    const target = samples[Math.min(N, at + Math.round((plane.speed * 0.6) / step))];
    const { pitch, roll } = steerTowards(plane, target);
    const ev = plane.update(STEP, {
      pitch, roll, yaw: 0,
      throttle: plane.speed < speed ? 1 : -1, brake: plane.speed > speed + 12,
    }, world);
    rings.update(STEP, plane.position);
    if (ev && ev.type === 'crash') { crash = ev.reason; break; }
    if (props && props.collides(plane.position.x, plane.position.y, plane.position.z)) { crash = 'hit an obstacle'; break; }
    t += STEP;
  }
  return { speed, gates: rings.index, crash, t, worst };
}

// --- the alps --------------------------------------------------------------
// Alpine Valley promises a route that follows the rivers up one valley and
// down the other, and crosses the summit between the two flag poles, just
// above the top. Then the line pilot flies the whole thing from the departure
// gate, climb to the summit included.
function checkAlps(cfg, w) {
  const { alps, gates, terrain } = w;
  const r = cfg.route.ringRadius;

  // Gates in a valley: over its floor, not over the ridges beside it.
  const inValley = gates.filter((g) => alps.valleys.some((v) => {
    const q = v.query(g.position.x, g.position.z);
    return q && q.dist < v.widthAt(q.s) * 0.6;
  }));
  ok(inValley.length >= 14, `only ${inValley.length} gates follow the valleys`);

  // The summit gate sits just above the top, between the poles.
  const sg = gates[gates.summit].position;
  const S = alps.summit;
  const top = terrain.heightAt(S.x, S.z);
  ok(Math.abs(top - S.top) < 3, `the summit is at ${top.toFixed(0)}, not ${S.top}`);
  ok(sg.y - r > top + 2 && sg.y - r < top + 40,
    `the summit gate's lowest point is ${(sg.y - r - top).toFixed(0)} above the top`);
  ok(Math.hypot(sg.x - S.x, sg.z - S.z) < 5, 'the summit gate is not over the summit');
  // Poles either side: something solid just outside the ring, nothing inside.
  const across = new THREE.Vector3(1, 0, 0).applyQuaternion(gates[gates.summit].quaternion);
  const probe = (d, y) => w.props.collides(sg.x + across.x * d, y, sg.z + across.z * d, 0);
  const poleD = r + S.poleGap;
  ok(probe(poleD, top + 40) && probe(-poleD, top + 40), 'no flag poles either side of the summit gate');
  ok(!probe(0, sg.y) && !probe(r * 0.8, sg.y) && !probe(-r * 0.8, sg.y), 'something solid inside the summit gate');

  const slow = flyLine(w, 0, 100), fast = flyLine(w, 0, 115);
  for (const f of [slow, fast]) {
    ok(!f.crash && f.gates === gates.length,
      `line pilot at ${f.speed}kt: ${f.gates}/${gates.length} gates, ${f.crash ?? 'no crash'}`);
  }
  return { inValley: inValley.length, total: gates.length, summitGap: sg.y - r - top, slow, fast, stats: w.props.stats };
}

// --- the demo ---------------------------------------------------------------
// Behind the menus the racing-line pilot flies the whole mission: takeoff,
// every gate, and a landing that the runway accepts. Checked on every level
// it flies, since an attract mode that crashes is worse than none.
function flyDemo(w, drones = null, onStep = null) {
  const { terrain, airport, gates, props } = w;
  const plane = new Plane(LEVELS[0].palette);
  const rings = new RingSet({ route: { ringRadius: w.rings.radius } }, gates);
  const world = { heightAt: terrain.heightAt, airport };
  plane.reset(airport.start.x, airport.start.y, airport.start.z, airport.start.heading);
  const pilot = createLinePilot({ airport, gates });
  let t = 0, why = 'timed out', landed = false;
  if (onStep) onStep(plane, 0);
  while (t < 420) {
    const ev = plane.update(STEP, pilot.update(STEP, plane, rings), world);
    if (onStep) onStep(plane, t + STEP);
    rings.update(STEP, plane.position);
    if (drones) drones.update(STEP, plane.position, plane.velocity);
    if (ev && (ev.type === 'crash' || ev.type === 'belly')) { why = ev.reason ?? ev.type; break; }
    if (ev && ev.type === 'touchdown' && rings.done) landed = true;
    if (!plane.onGround && props && props.collides(plane.position.x, plane.position.y, plane.position.z)) { why = 'hit an obstacle'; break; }
    if (pilot.stuck) { why = 'stuck'; break; }
    if (landed && plane.onGround && plane.speed < 4) { why = 'landed'; break; }
    t += STEP;
  }
  return { gates: rings.index, total: gates.length, why, t };
}

// --- ghost replay -----------------------------------------------------------
// Record the demo pilot's mission the way the game records a run, push it
// through JSON as localStorage would, and play it back: between samples the
// ghost must stay on the aeroplane's real path, at every physics step.
function checkReplay(w, cfg) {
  const rec = new Recorder(STEP);
  const truth = [];
  const d = flyDemo(w, null, (plane, t) => {
    rec.tick(plane);
    truth.push([t, plane.position.clone(), plane.quaternion.clone()]);
  });
  const json = JSON.stringify(rec.finish(d.t));
  const track = decode(JSON.parse(json));
  const pos = new THREE.Vector3(), q = new THREE.Quaternion();
  let worstPos = 0, worstAngle = 0, onSample = 0;
  // Touchdown sets the aeroplane onto the runway in a single step, a jump the
  // ghost smooths over one sample; the path either side of it is what counts.
  const snap = truth.map(([, p], i) => i > 0 && p.distanceTo(truth[i - 1][1]) > 1.5);
  const nearSnap = (i) => snap.slice(Math.max(0, i - 2 * SAMPLE_EVERY), i + 2 * SAMPLE_EVERY).includes(true);
  let snaps = 0;
  truth.forEach(([t, p, qq], i) => {
    sample(track, t, pos, q);
    if (i % SAMPLE_EVERY === 0) onSample = Math.max(onSample, pos.distanceTo(p));
    if (snap[i]) snaps++;
    if (nearSnap(i)) return;
    worstPos = Math.max(worstPos, pos.distanceTo(p));
    worstAngle = Math.max(worstAngle, q.angleTo(qq) * 180 / Math.PI);
  });
  ok(snaps <= 2, `replay: the run jumps at most at touchdown (${snaps} snaps)`);
  const end = sample(track, d.t + 30, pos, q) && pos.distanceTo(truth[truth.length - 1][1]);
  ok(track && track.time === d.t, 'replay: ghost decodes with its run time');
  ok(onSample < 0.02, `replay: on a sample the ghost is within 2 cm (${onSample.toFixed(3)})`);
  ok(worstPos < 0.5, `replay: between samples it stays within 0.5 m of the path (${worstPos.toFixed(2)})`);
  // The line pilot's attitude can buzz by a degree or so from one 1/120 s
  // step to the next; 30 Hz samples see through that, which is fine to watch.
  ok(worstAngle < 2.5, `replay: and within 2.5 deg of the attitude (${worstAngle.toFixed(2)})`);
  ok(end < 0.5, `replay: after the end it waits where the run stopped (${end.toFixed(2)})`);
  ok(decode({ ...JSON.parse(json), v: 0 }) === null && decode(null) === null && decode({ v: 1 }) === null,
    'replay: a ghost from another format, or junk, is refused');
  // Watching it back poses the real aeroplane, and gives it the speed it had,
  // which the chase camera's zoom and the drones' dodging read.
  const actor = new Plane(cfg.palette);
  let worstActor = 0, worstSpeed = 0;
  truth.forEach(([t, p], i) => {
    if (i % SAMPLE_EVERY || nearSnap(i)) return;
    poseAt(track, t, actor, STEP);
    worstActor = Math.max(worstActor, actor.position.distanceTo(p));
    if (i > 0) worstSpeed = Math.max(worstSpeed, Math.abs(actor.speed - p.distanceTo(truth[i - 1][1]) / STEP));
  });
  ok(worstActor < 0.5, `replay: the watched aeroplane follows the path (${worstActor.toFixed(2)} m)`);
  ok(worstSpeed < 5, `replay: and at the speed it flew (${worstSpeed.toFixed(2)} off)`);
  // Flyby: every shot's spot is clear of the ground and the props, and sees
  // the aeroplane for most of its stretch. Checked here at 4x the planner's
  // own probe density, so a spot that only works on its probes shows up.
  const world = { heightAt: w.terrain.heightAt, props: w.props };
  const t0 = performance.now();
  const flyby = createFlybyPlanner(track, world);
  const shots = [];
  for (let i = 0; i < flyby.count; i++) shots.push(flyby.at(i * 4 + 0.01));
  const planMs = (performance.now() - t0) / shots.length;
  let worstShot = 1, sumVis = 0, inside = 0, flips = 0;
  shots.forEach((sh, i) => {
    if (sh.y < w.terrain.heightAt(sh.x, sh.z) + 1 || (w.props && w.props.collides(sh.x, sh.y, sh.z, 0))) inside++;
    if (i && sh.side !== shots[i - 1].side) flips++;
    let seen = 0, n = 0;
    for (let t = sh.t0; t <= sh.t1; t += (sh.t1 - sh.t0) / 40 || 1) {
      sample(track, t, pos, q); n++;
      if (sightClear(world, sh, pos)) seen++;
    }
    worstShot = Math.min(worstShot, seen / n);
    sumVis += seen / n;
  });
  ok(inside === 0, `flyby: no camera spot inside the ground or a prop (${inside})`);
  ok(worstShot >= 0.6, `flyby: every shot sees the aeroplane at least 60% of the time (worst ${(worstShot * 100).toFixed(0)}%)`);
  ok(planMs < 50, `flyby: a shot plans in under 50 ms (${planMs.toFixed(1)})`);
  const fly = { shots: shots.length, mean: sumVis / shots.length, worst: worstShot, planMs, flips };
  ok(json.length < 400_000, `replay: a ${d.t.toFixed(0)} s run stores in ${(json.length / 1024).toFixed(0)} KB`);
  return { kb: json.length / 1024, t: d.t, worstPos, worstAngle, fly };
}

// The canyon has no pilot that can fly it in the tests, and its walls are the
// hardest place to find a flyby spot, so plan along a run through its gates
// at a steady 80 m/s instead.
function checkCanyonFlyby(w) {
  const pts = [w.airport.start, ...w.gates.map((g) => g.position)];
  const plane = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), gearPos: 0, throttle: 1 };
  const rec = new Recorder(STEP);
  let t = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = new THREE.Vector3(pts[i - 1].x, pts[i - 1].y, pts[i - 1].z), b = new THREE.Vector3(pts[i].x, pts[i].y, pts[i].z);
    const steps = Math.ceil(a.distanceTo(b) / 80 / STEP);
    for (let k = 0; k < steps; k++, t += STEP) { plane.position.lerpVectors(a, b, k / steps); rec.tick(plane); }
  }
  const track = decode(rec.finish(t));
  const world = { heightAt: w.terrain.heightAt, props: w.props };
  const flyby = createFlybyPlanner(track, world);
  const pos = new THREE.Vector3(), q = new THREE.Quaternion();
  let worst = 1, sum = 0, buried = 0;
  for (let i = 0; i < flyby.count; i++) {
    const sh = flyby.at(i * 4 + 0.01);
    let seen = 0, n = 0;
    for (let tt = sh.t0; tt <= sh.t1; tt += 0.1) {
      sample(track, tt, pos, q);
      if (pos.y < w.terrain.heightAt(pos.x, pos.z) + 5) { buried++; continue; }   // straight leg cut through rock
      n++; if (sightClear(world, sh, pos)) seen++;
    }
    if (!n) continue;
    worst = Math.min(worst, seen / n);
    sum += seen / n;
  }
  if (buried) console.log(`          ${buried} samples of the straight test path run through rock and are skipped`);
  ok(worst >= 0.6, `flyby in the canyon: every shot sees the aeroplane 60% of the time (worst ${(worst * 100).toFixed(0)}%)`);
  return { shots: flyby.count, mean: sum / flyby.count, worst };
}

// --- line of sight ----------------------------------------------------------
// The next gate has to be in front of you. Flying a route where it is off the
// side of the screen means navigating by the HUD arrow instead of by looking.
function checkSightlines(cfg, w) {
  const { gates, airport } = w;
  const BACK = new THREE.Vector3(0, 0, -1);
  const deg = (r) => (r * 180) / Math.PI;
  const angle = (a, b) => deg(Math.acos(clamp(a.dot(b), -1, 1)));

  // Off the runway, the first gate has to be ahead, not abeam.
  const start = new THREE.Vector3(airport.start.x, airport.surfaceY, airport.start.z);
  const toFirst = gates[0].position.clone().sub(start);
  const offAxis = angle(toFirst.clone().normalize(), airport.axis);
  ok(offAxis < 35, `first gate is ${offAxis.toFixed(0)} deg off the runway axis`);
  ok(toFirst.length() < 2400, `first gate is ${toFirst.length().toFixed(0)} away`);

  let worstTurn = 0, worstAt = -1, longest = 0;
  for (let i = 0; i < gates.length - 1; i++) {
    const facing = BACK.clone().applyQuaternion(gates[i].quaternion);
    const to = gates[i + 1].position.clone().sub(gates[i].position);
    longest = Math.max(longest, to.length());
    const t = angle(to.clone().normalize(), facing);
    if (t > worstTurn) { worstTurn = t; worstAt = i; }
  }
  ok(worstTurn < 70, `gate ${worstAt} turns ${worstTurn.toFixed(0)} deg to reach the next one`);
  ok(longest < cfg.palette.fogFar * 0.9,
    `a leg is ${longest.toFixed(0)} long but fog closes at ${cfg.palette.fogFar}`);

  // The last gate has to be low enough and far enough out to land from.
  const lastGate = gates[gates.length - 1].position;
  const run = Math.hypot(lastGate.x - airport.center.x, lastGate.z - airport.center.z) - 450;
  const descent = ((lastGate.y - airport.surfaceY) / Math.max(1, run)) * 95;
  ok(descent < 15, `final gate needs ${descent.toFixed(1)} units/s of descent (limit 15)`);

  return { offAxis, worstTurn, longest, descent, count: gates.length };
}

// --- ground is solid ---// --- ground is solid ------------------------------------------------------
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

  // A shallow climb-out followed by a low, flat final must still LAND.
  //
  // Landing used to arm only after climbing 15 units above the runway itself.
  // Leave the strip lower than that and the next arrival was never armed: the
  // aeroplane was held on the tarmac but kept flying, with no wheels and no
  // wheel brake, while slow-flight sag rotated the nose down as it rolled.
  {
    const p2 = new Plane(cfg.palette);
    p2.reset(airport.start.x, airport.start.y, airport.start.z, airport.start.heading);
    for (let i = 0; i < 120 * 30; i++) {
      const fpa = Math.asin(clamp(p2.forward.y, -1, 1));
      const pitch = p2.onGround ? (p2.speed >= TUNE.rotateSpeed ? 1 : 0)
        : clamp((0.02 - fpa) * 4, -1, 1);                     // barely climbing
      p2.update(STEP, { pitch, roll: 0, yaw: 0, throttle: 0, throttleAbs: 1, brake: false }, world);
      if (!p2.onGround && !airport.contains(p2.position.x, p2.position.z)) break;
    }

    const fin = airport.center.clone().addScaledVector(airport.axis, -900);
    p2.position.set(fin.x, airport.surfaceY + 10, fin.z);   // below the old 15
    p2._prevPos.copy(p2.position);
    p2.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), airport.start.heading);
    p2.speed = 80; p2.airborneFor = 99;

    let event = null, flyingOnTarmac = 0;
    for (let i = 0; i < 120 * 40 && !event; i++) {
      const fpa = Math.asin(clamp(p2.forward.y, -1, 1));
      const want = airport.approachInfo(p2).along > 450 ? 0 : -0.03;
      const onTarmac = airport.contains(p2.position.x, p2.position.z)
        && p2.position.y - airport.surfaceY < 0.5;
      event = p2.update(STEP, {
        pitch: clamp((want - fpa) * 4, -1, 1), roll: 0, yaw: 0, throttle: 0,
        throttleAbs: onTarmac ? 0 : 0.3, brake: onTarmac,
      }, world);
      if (onTarmac && !p2.onGround) flyingOnTarmac += STEP;
    }
    ok(event && event.type === 'touchdown',
      `low landing after a shallow climb-out gave ${event ? event.type + ' ' + (event.reason ?? '') : 'no event'}`);
    ok(flyingOnTarmac < 0.2,
      `aeroplane spent ${flyingOnTarmac.toFixed(1)}s on the tarmac still in flight mode`);
  }
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
  const { plane, terrain, airport, rings, props } = w;
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
    if (props && !plane.onGround
        && props.collides(plane.position.x, plane.position.y, plane.position.z)) {
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

// --- phone stick -------------------------------------------------------------
// The thumb-offset to pitch/roll mapping, for both the analogue stick and the
// 8-way arrow pad that share one spot on screen.
function checkPad() {
  const R = 100;
  const stick = (dx, dy) => padToAxes(dx, dy, R, 'stick');
  const arrows = (dx, dy) => padToAxes(dx, dy, R, 'arrows');
  const near = (a, b) => Math.abs(a - b) < 1e-9;

  // Sense matches the keyboard: up is W (nose down), down is S (nose up),
  // right is D. Getting this backwards is the classic phone-controls bug.
  for (const [name, f] of [['stick', stick], ['arrows', arrows]]) {
    ok(near(f(0, R).pitch, 1), `${name}: pulling down does not pitch the nose up`);
    ok(near(f(0, -R).pitch, -1), `${name}: pushing up does not pitch the nose down`);
    ok(near(f(R, 0).roll, 1), `${name}: right does not roll right`);
    ok(near(f(-R, 0).roll, -1), `${name}: left does not roll left`);
    const c = f(0, 0);
    ok(c.pitch === 0 && c.roll === 0, `${name}: centre is not neutral`);
  }

  // Stick: deadzone, smooth start, monotonic, and never beyond the rim.
  const small = stick(0.08 * R, 0);
  ok(small.roll === 0, 'stick: deadzone does not swallow a small offset');
  ok(stick(0.13 * R, 0).roll < 0.02, 'stick: output jumps at the edge of the deadzone');
  ok(stick(0.3 * R, 0).roll < stick(0.6 * R, 0).roll, 'stick: response is not increasing');
  ok(near(stick(5 * R, 0).roll, 1), 'stick: dragging past the rim does not hold full');
  const d = stick(3 * R, 3 * R);
  ok(Math.hypot(d.roll, d.pitch) <= 1 + 1e-9, 'stick: a diagonal escapes the unit circle');
  ok(d.roll > 0.6 && d.pitch > 0.6, 'stick: diagonals do not give both axes');

  // Arrows: behave like keys — only -1, 0 or +1, with real diagonals.
  const dg = arrows(R, R);
  ok(dg.roll === 1 && dg.pitch === 1, 'arrows: down-right diagonal does not press both');
  const dg2 = arrows(-R, -R);
  ok(dg2.roll === -1 && dg2.pitch === -1, 'arrows: up-left diagonal does not press both');
  ok(arrows(R, 0.2 * R).pitch === 0, 'arrows: a near-horizontal push leaks into pitch');
  ok(arrows(0.2 * R, 0).roll === 0, 'arrows: a small offset registers as a press');
  for (let a = 0; a < 360; a += 7) {
    const r = (a * Math.PI) / 180;
    const o = arrows(Math.cos(r) * R * 0.9, Math.sin(r) * R * 0.9);
    ok([-1, 0, 1].includes(o.roll) && [-1, 0, 1].includes(o.pitch),
      `arrows: ${a} deg gave a value that is not a key press`);
    ok(o.roll !== 0 || o.pitch !== 0, `arrows: ${a} deg at 90% travel registers nothing`);
  }
}

// --- the flock ---------------------------------------------------------------
// The flock module on its own, against a test dragon coiled round a straight-
// ish axis: it holds the shape, keeps its spacing, dodges a threat flown
// through it at cruise and at nitro speed without a single touch, heals
// afterwards, is deterministic, propagates a startle at a speed set by the
// reaction delay, and fits its CPU budget.
function checkFlock() {
  const axis = [[0, 200, 0], [400, 200, 100], [800, 200, 0], [1200, 220, -100]];
  const make = (rules = {}) => {
    const d = createDragon({ axis });
    const f = createFlock({ count: d.count, rules });
    f.setFormation(d);
    f.settle();
    return { d, f };
  };
  const slotErr = (f, d) => {
    let e = 0;
    for (let i = 0; i < f.count * 3; i += 3) e += Math.hypot(f.pos[i] - d.pos[i], f.pos[i + 1] - d.pos[i + 1], f.pos[i + 2] - d.pos[i + 2]);
    return e / f.count;
  };

  // Formation and spacing.
  const { d, f } = make();
  for (let k = 0; k < 150; k++) f.tick({});
  const err = slotErr(f, d);
  ok(err < 0.6, `the flock holds the dragon to ${err.toFixed(2)} on average`);
  let minD = Infinity;
  for (let i = 0; i < f.count; i++) {
    for (let j = i + 1; j < f.count; j++) {
      const dd = Math.hypot(f.pos[i * 3] - f.pos[j * 3], f.pos[i * 3 + 1] - f.pos[j * 3 + 1], f.pos[i * 3 + 2] - f.pos[j * 3 + 2]);
      if (dd < minD) minD = dd;
    }
  }
  ok(minD > 1.2, `two drones ${minD.toFixed(2)} apart`);

  // Pierce the body at four places and two speeds.
  const pierce = [];
  for (const [target, speed] of [[30, 127], [200, 127], [450, 127], [300, 300]]) {
    const { d: dd, f: ff } = make();
    for (let k = 0; k < 60; k++) ff.tick({});
    const s0 = ff.time * 26 + 1.5 * 26 - target;
    const aim = dd.pathPoint(s0), aim2 = dd.pathPoint(s0 + 5);
    const tl = Math.hypot(aim2[0] - aim[0], aim2[2] - aim[2]) || 1;
    let dir = [-(aim2[2] - aim[2]) / tl, 0.3, (aim2[0] - aim[0]) / tl];
    const dl = Math.hypot(...dir); dir = dir.map((x) => x / dl);
    let p = aim.map((a, i) => a - dir[i] * speed * 1.5);
    const v = dir.map((x) => x * speed);
    for (let k = 0; k < 90; k++) {
      // The test aeroplane moves in four sub-steps per tick, so the nearest
      // approach is not missed between ticks.
      for (let q = 0; q < 4; q++) {
        p = p.map((a, i) => a + v[i] / 120);
        if (q === 3) ff.tick({ threats: [{ x: p[0], y: p[1], z: p[2], vx: v[0], vy: v[1], vz: v[2], radius: 8 }] });
      }
    }
    let heal = 0;
    while (slotErr(ff, dd) > 0.6 && heal < 15) { ff.tick({}); heal += 1 / 30; }
    pierce.push({ target, speed, nearest: ff.stats.nearest, hits: ff.stats.hits, heal });
    ok(ff.stats.hits === 0 && ff.stats.nearest > 12,
      `pierced at s=${target}, ${speed}kt: ${ff.stats.hits} drones hit, nearest ${ff.stats.nearest.toFixed(1)}`);
    ok(heal < 8, `the dragon took ${heal.toFixed(1)}s to heal after the pass at s=${target}`);
  }

  // Determinism: same seed, same inputs, same flock.
  const a = make(), b = make();
  for (let k = 0; k < 60; k++) {
    const t = { threats: [{ x: 300, y: 200, z: 50 + k, vx: 0, vy: 0, vz: 127, radius: 8 }] };
    a.f.tick(t); b.f.tick(t);
  }
  let same = true;
  for (let i = 0; i < a.f.pos.length; i++) if (a.f.pos[i] !== b.f.pos[i]) { same = false; break; }
  ok(same, 'the flock is not deterministic');

  // Startle wave: a line of agents at rest, the first kept in panic. The
  // front should reach the far end later the longer the reaction delay.
  const front = (delay) => {
    const n = 120;
    const fl = createFlock({ count: n, rules: { reactionDelay: delay, reactionJitter: 0, startleGain: 0.98, panicDecay: 0.2, cohesionGain: 0, alignGain: 0 } });
    for (let i = 0; i < n; i++) { fl.pos.set([i * 4, 100, 0], i * 3); fl.vel.set([0, 0, 0], i * 3); }
    fl.prevPos.set(fl.pos);
    for (let k = 0; k < 600; k++) {
      fl.panic[0] = 1;
      fl.tick({});
      if (fl.panic[n - 1] > 0.3) return k / 30;
    }
    return Infinity;
  };
  const fast = front(0.034), slow = front(0.2);
  ok(slow > fast * 2.5 && isFinite(slow), `startle front: ${fast.toFixed(2)}s at 34ms vs ${slow.toFixed(2)}s at 200ms`);

  // Free flight, as the bird game will use it: no formation, a home to stay
  // near, one predator, and one agent steered from outside (the player).
  const birds = createFlock({ count: 300, seed: 5, center: [0, 300, 0], spread: 80,
    rules: { minSpeed: 14, maxSpeed: 30, home: { x: 0, y: 300, z: 0, radius: 150 }, wander: 20, cohesionGain: 0.6 } });
  birds.setRole(0, ROLE.PLAYER);
  birds.setRole(1, ROLE.PREDATOR);
  let finite = true, far = 0;
  for (let k = 0; k < 600; k++) {
    birds.pos.set([Math.cos(k / 60) * 100, 300, Math.sin(k / 60) * 100], 0);   // the player flies a circle
    birds.tick({});
    for (let i = 2; i < birds.count; i++) {
      const x = birds.pos[i * 3], y = birds.pos[i * 3 + 1], z = birds.pos[i * 3 + 2];
      if (!Number.isFinite(x + y + z)) finite = false;
      far = Math.max(far, Math.hypot(x, y - 300, z));
    }
  }
  const playerAt = Math.hypot(birds.pos[0] - Math.cos(599 / 60) * 100, birds.pos[2] - Math.sin(599 / 60) * 100);
  ok(finite, 'a free flock went to NaN');
  ok(far < 450, `a free bird strayed ${far.toFixed(0)} from home`);
  ok(playerAt < 1e-3, 'the flock moved the player-steered agent');

  // CPU: the mean tick with a threat in the middle of the dragon.
  const bench = make();
  for (let k = 0; k < 30; k++) bench.f.tick({});
  const t0 = performance.now();
  for (let k = 0; k < 300; k++) bench.f.tick({ threats: [{ x: 400, y: 200, z: 100, vx: 127, vy: 0, vz: 0, radius: 8 }] });
  const ms = (performance.now() - t0) / 300;
  ok(ms < 4, `a flock tick takes ${ms.toFixed(2)}ms (budget 1.5, asserted with slack)`);

  return { count: f.count, err, minD, pierce, fast, slow, ms, far, parts: d.parts() };
}

// --- the dragon over the lake ---------------------------------------------------
// The night mission's show: the dragon's path keeps clear of the ground and
// the water, the gates it coils round are the ones over the lake, and the demo
// pilot flies the whole mission through it with no drone ever touched.
function checkDragon(cfg, w) {
  const all = cfg.dragons.map((spec) => createDrones(cfg, spec, w.gates, w.terrain.heightAt, { airport: w.airport }));
  const ground = (x, z) => Math.max(0, w.terrain.heightAt(x, z));
  const out = all.map(({ dragon, flock, axisGates }) => {
    let low = Infinity, name;
    if (dragon) {
      name = `the dragon round gates ${axisGates[0]}-${axisGates.at(-1)}`;
      ok(axisGates.length >= 3, `a dragon coils round only ${axisGates.length} gates`);
      for (let a = 0; a < dragon.loopLength; a += 4) {
        const p = dragon.pathPoint(a);
        low = Math.min(low, p[1] - ground(p[0], p[2]));
      }
      ok(low > 40, `${name} comes within ${low.toFixed(0)} of the ground`);
    } else {
      name = 'the logo';
      const p = flock.pos;
      let sx = 0, sy = 0, sz = 0;
      for (let i = 0; i < flock.count; i++) {
        low = Math.min(low, p[i * 3 + 1] - ground(p[i * 3], p[i * 3 + 2]));
        sx += p[i * 3]; sy += p[i * 3 + 1]; sz += p[i * 3 + 2];
      }
      ok(low > 60, `the logo comes within ${low.toFixed(0)} of the ground`);
      // In view from the start of the runway: ahead, and nothing in between.
      const c = [sx / flock.count, sy / flock.count, sz / flock.count];
      const st = w.airport.start, eye = [st.x, w.airport.surfaceY + 4, st.z];
      const d = [c[0] - eye[0], c[1] - eye[1], c[2] - eye[2]];
      const dl = Math.hypot(...d);
      const off = (Math.acos((d[0] * w.airport.axis.x + d[2] * w.airport.axis.z) / Math.hypot(d[0], d[2])) * 180) / Math.PI;
      const up = (Math.asin(d[1] / dl) * 180) / Math.PI;
      let blocked = false;
      for (let t = 0.02; t < 1; t += 0.01) {
        if (eye[1] + d[1] * t < ground(eye[0] + d[0] * t, eye[2] + d[2] * t)) { blocked = true; break; }
      }
      ok(off < 15 && up < 25 && !blocked, `the logo from the runway: ${off.toFixed(0)} deg off the axis, ${up.toFixed(0)} deg up, ${blocked ? 'hidden' : 'in view'}`);
      name += ` (${off.toFixed(0)} deg off the runway axis, ${up.toFixed(0)} deg up, in view from the start)`;
    }
    return { count: flock.count, gates: axisGates, low, turns: dragon ? dragon.turns : 0, flock, name };
  });
  const d = flyDemo(w, { update: (...a) => all.forEach((x) => x.update(...a)) });
  ok(d.why === 'landed', `demo pilot through the shows: ${d.gates}/${d.total} gates, ${d.why}`);
  for (const o of out) {
    ok(o.flock.stats.hits === 0, `the demo pilot touched ${o.flock.stats.hits} drones of ${o.name}`);
    o.nearest = o.flock.stats.nearest;
  }
  return { dragons: out, demo: d };
}

// --- run -------------------------------------------------------------------
console.log('');
console.log('\x1b[1mPhone stick\x1b[0m');
checkPad();
console.log('  stick and arrow-pad mapping checked\n');

console.log('\x1b[1mFlock\x1b[0m');
{
  const fl = checkFlock();
  console.log(`  dragon  ${fl.count} drones  slot error ${fl.err.toFixed(2)}  closest pair ${fl.minD.toFixed(2)}`);
  console.log(`  pierce  ${fl.pierce.map((p) => `s=${p.target}@${p.speed}: nearest ${p.nearest.toFixed(0)}, heal ${p.heal.toFixed(1)}s`).join('  |  ')}`);
  console.log(`  startle front ${fl.fast.toFixed(2)}s (34ms delay) vs ${fl.slow.toFixed(2)}s (200ms)  |  tick ${fl.ms.toFixed(2)}ms`);
  console.log(`  free    300 birds, a predator and a player: farthest from home ${fl.far.toFixed(0)}\n`);
}

for (const cfg of LEVELS) {
  console.log(`\x1b[1m${cfg.name}\x1b[0m`);
  const world = checkWorld(cfg, build(cfg));
  console.log(`  world   apron±${world.maxDev.toFixed(2)}  gate clearance ${world.minClear.toFixed(0)}`
    + `  min gap ${world.minGap.toFixed(0)}  tightest leg ${world.worstSeg.toFixed(0)} (leg ${world.worstAt})`);

  checkGates(cfg, build(cfg));
  checkGround(cfg, build(cfg));
  const sight = checkSightlines(cfg, build(cfg));
  console.log(`  sight   ${sight.count} gates  first ${sight.offAxis.toFixed(0)}deg off the runway`
    + `  worst turn ${sight.worstTurn.toFixed(0)}deg  longest leg ${sight.longest.toFixed(0)}`
    + `  approach ${sight.descent.toFixed(1)}/15`);
  if (cfg.canyon) {
    const c = checkCanyon(cfg, build(cfg));
    console.log(`  canyon  ${c.length.toFixed(0)} units, ${c.count} gates inside`
      + `  chords stray ${c.worstChord.toFixed(0)}/${cfg.canyon.halfWidth}`
      + `  gates ${c.minBelowRim.toFixed(0)}+ below the rim`
      + `  runway clear by ${c.nearest.toFixed(0)}`);
  }
  if (cfg.alps) {
    const a = checkAlps(cfg, build(cfg));
    console.log(`  alps    ${a.inValley}/${a.total} gates in the valleys  summit gate clears the top by ${a.summitGap.toFixed(0)}`
      + `  ${a.stats.trees} trees, ${a.stats.houses} chalets`);
    console.log(`  line    ${a.slow.speed}kt ${a.slow.gates}/${a.total} in ${a.slow.t.toFixed(0)}s off-line ${a.slow.worst.toFixed(0)}`
      + `  |  ${a.fast.speed}kt ${a.fast.gates} in ${a.fast.t.toFixed(0)}s off-line ${a.fast.worst.toFixed(0)}`);
  }
  if (cfg.dragons) {
    const g = checkDragon(cfg, build(cfg));
    for (const o of g.dragons) {
      console.log(`  drones  ${o.count} in ${o.name}${o.turns ? `, ${o.turns} turns` : ''}, ${o.low.toFixed(0)}+ above ground`
        + `, nearest to the demo pilot ${o.nearest.toFixed(0)}`);
    }
    console.log(`          demo ${g.demo.why} after ${g.demo.t.toFixed(0)}s`);
  }
  if (cfg.city) {
    const c = checkCity(cfg, build(cfg));
    console.log(`  city    ${c.stats.buildings} buildings, ${c.stats.trees} trees, ${c.stats.cars}+${c.stats.parked} cars`
      + `  ${c.below}/${c.run} gates below the rooftops  legs clear by ${c.tightest}+`);
    console.log(`  line    ${c.slow.speed}kt ${c.slow.gates}/${build(cfg).gates.length} in ${c.slow.t.toFixed(0)}s off-line ${c.slow.worst.toFixed(0)}`
      + `  |  ${c.fast.speed}kt ${c.fast.gates} in ${c.fast.t.toFixed(0)}s off-line ${c.fast.worst.toFixed(0)}`);
  }
  if (cfg.canyon) {
    const f = checkCanyonFlyby(build(cfg));
    console.log(`  flyby   ${f.shots} shots along the gates, plane in view ${(f.mean * 100).toFixed(0)}% on average, worst shot ${(f.worst * 100).toFixed(0)}%`);
  }
  if (!cfg.canyon) {
    const d = flyDemo(build(cfg));
    ok(d.why === 'landed', `demo pilot: ${d.gates}/${d.total} gates, ${d.why}`);
    console.log(`  demo    ${d.gates}/${d.total} gates, ${d.why} after ${d.t.toFixed(0)}s`);
    const g = checkReplay(build(cfg), cfg);
    console.log(`  ghost   ${g.t.toFixed(0)}s run in ${g.kb.toFixed(0)} KB, off the path by ${g.worstPos.toFixed(2)} m / ${g.worstAngle.toFixed(2)} deg at worst`);
    console.log(`  flyby   ${g.fly.shots} shots, plane in view ${(g.fly.mean * 100).toFixed(0)}% on average, worst shot ${(g.fly.worst * 100).toFixed(0)}%, `
      + `${g.fly.flips} side swaps, ${g.fly.planMs.toFixed(1)} ms a shot`);
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
