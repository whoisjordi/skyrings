// Headless checks for the parts of the game that have no pixels: the flight
// model, the generated worlds, and gate detection. Run with `npm test`.
//
// The flight probe at the end is a crude autopilot flown over each mission.
// It is reported, not asserted: it is a weak pilot (proportional control, no
// energy management) and cannot reliably thread a 40-unit hoop with a
// 250-unit turn radius, so its score is a smoke signal rather than a spec.
import * as THREE from 'three';
import { LEVELS } from '../src/levels.js';
import { createTerrain, AIRPORT_Y, WORLD_SIZE } from '../src/terrain.js';
import { createAirport } from '../src/airport.js';
import { buildRoute, RingSet } from '../src/rings.js';
import { createCity } from '../src/scenery.js';
import { Plane, TUNE } from '../src/plane.js';

let failures = 0;
const ok = (cond, msg) => {
  if (!cond) { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${msg}`); }
  return cond;
};
const STEP = 1 / 120;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function build(cfg) {
  const terrain = createTerrain(cfg);
  const airport = createAirport(cfg);
  const gates = buildRoute(cfg, airport, terrain.heightAt);
  const rings = new RingSet(cfg, gates);
  const corridor = [airport.center, ...gates.map((g) => g.position), airport.center];
  const city = createCity(cfg, terrain.heightAt, corridor);
  const plane = new Plane(cfg.palette);
  plane.reset(airport.start.x, airport.start.y, airport.start.z, airport.start.heading);
  return { terrain, airport, gates, rings, city, plane };
}

// --- world -----------------------------------------------------------------
function checkWorld(cfg, w) {
  const { terrain, airport, gates } = w;

  let maxDev = 0;
  for (let a = 0; a < 8; a++) {
    for (const r of [0, 60, 140, 240]) {
      const x = cfg.airport.x + Math.cos(a) * r;
      const z = cfg.airport.z + Math.sin(a) * r;
      maxDev = Math.max(maxDev, Math.abs(terrain.heightAt(x, z) - AIRPORT_Y));
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

  const h0 = Math.atan2(plane.forward.x, plane.forward.z);
  for (let i = 0; i < 240; i++) plane.update(STEP, { ...hold, roll: 1, pitch: 0.25 }, world);
  const h1 = Math.atan2(plane.forward.x, plane.forward.z);
  const turned = Math.abs(((h1 - h0 + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
  ok(turned > 0.5, `barely turns at full bank (${turned.toFixed(2)} rad in 2s)`);

  // Holding aileron must settle into a bank, not keep rolling over.
  for (let i = 0; i < 600; i++) plane.update(STEP, { ...hold, roll: 1 }, world);
  const heldBank = Math.abs(Math.asin(clamp(plane.bank, -1, 1)));
  ok(plane.up.y > 0 && heldBank > 0.8 && heldBank < 1.45,
    `holding aileron does not settle into a bank (${heldBank.toFixed(2)} rad, up.y ${plane.up.y.toFixed(2)})`);

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

  return { takeoffTime: t, rollDist, cruise, turned, minSpeed, heldBank };
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
  const { gates, airport, terrain } = w;
  const fwd = new THREE.Vector3();
  const right = new THREE.Vector3();

  const fly = (offsetFactor) => {
    const rings = new RingSet(cfg, buildRoute(cfg, airport, terrain.heightAt));
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
  const rings = new RingSet(cfg, buildRoute(cfg, airport, terrain.heightAt));
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

    let pitch = clamp((wantFpa - fpaNow) * 3.5, -1, 1);
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
  const phys = checkPhysics(cfg, build(cfg));
  console.log(`  flight  rotate ${phys.takeoffTime.toFixed(1)}s / ${phys.rollDist.toFixed(0)}m`
    + `  cruise ${phys.cruise.toFixed(0)}  2s turn ${phys.turned.toFixed(2)}rad`
    + `  held bank ${phys.heldBank.toFixed(2)}rad  stall min ${phys.minSpeed.toFixed(0)}`);

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
