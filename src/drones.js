// The drone shows on the night mission: the flock module, a dragon formation
// coiled round a run of gates (one off the runway, one over the lake), and
// the aeroplane as the threat they all dodge. One of these per dragon.
//
// Game-side glue with no three.js, so the harness can fly through it too.
// Rendering is in flockview.js.

import { createFlock } from './flock/flock.js';
import { createDragon } from './flock/dragon.js';
import { createTextFormation } from './flock/text.js';

/**
 * A coarse height grid over a box, bilinear in between: the flock asks for
 * the ground under every drone and the real terrain function is far too
 * slow for that. Outside the box it falls back to the real thing.
 */
export function cacheHeights(heightAt, x0, z0, x1, z1, cell = 20) {
  const nx = Math.ceil((x1 - x0) / cell) + 1, nz = Math.ceil((z1 - z0) / cell) + 1;
  const h = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) h[j * nx + i] = heightAt(x0 + i * cell, z0 + j * cell);
  return (x, z) => {
    const fx = (x - x0) / cell, fz = (z - z0) / cell;
    if (fx < 0 || fz < 0 || fx >= nx - 1 || fz >= nz - 1) return heightAt(x, z);
    const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
    const a = h[j * nx + i], b = h[j * nx + i + 1], c = h[(j + 1) * nx + i], d = h[(j + 1) * nx + i + 1];
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  };
}

/**
 * The gates a dragon coils round, in order: a fixed run of gates if the spec
 * names one ({ gates: [first, last] }), otherwise those over the lake.
 */
export function dragonAxis(cfg, spec, gates) {
  if (spec.gates) {
    const [a, b] = spec.gates;
    return Array.from({ length: b - a + 1 }, (_, k) => a + k);
  }
  const L = cfg.alps.lake;
  const k = spec.lakeFraction ?? 0.92;
  const over = [];
  // Never the final gate, and only gates high enough over the water for
  // the coil to pass beneath them.
  gates.forEach((g, i) => {
    if (i === gates.length - 1) return;
    const q = Math.hypot((g.position.x - L.x) / L.rx, (g.position.z - L.z) / L.rz);
    if (q < k && g.position.y > spec.minClearance) over.push(i);
  });
  return over;
}

/**
 * Where a text show hangs: up the runway axis, `distance` from the start,
 * high enough to clear the ground under it, facing the start.
 */
export function placeText(spec, text, airport, heightAt) {
  const st = airport.start, ax = airport.axis;
  const x = st.x + ax.x * spec.distance, z = st.z + ax.z * spec.distance;
  const half = text.width / 2 + 20;
  let top = -Infinity;
  for (let k = -1; k <= 1; k += 0.1) {
    for (const d of [-40, 0, 40]) top = Math.max(top, heightAt(x - ax.z * half * k + ax.x * d, z + ax.x * half * k + ax.z * d));
  }
  const y = Math.max(spec.altitude, top + spec.minAGL + text.height / 2);
  return { center: [x, y, z], facing: [st.x, st.z] };
}

/**
 * @param {object} cfg       level config
 * @param {object} spec      one entry of its `dragons` list: a dragon round a
 *                           run of gates, or `{ text }` for a text show
 * @param {Array} gates      the route
 * @param {Function} heightAt
 * @param {object} [o]       { phone: true } for fewer drones; `airport` for text
 */
export function createDrones(cfg, spec, gates, heightAt, o = {}) {
  const salt = spec.seed ?? 0;
  // Phones get the base shape with fewer drones; a PC gets `desktop` on top.
  const look = { ...(spec.shape ?? {}), ...(o.phone ? {} : spec.desktop ?? {}) };
  const sparse = o.phone ? 1.6 : 1;
  let formation, idx = [], box;

  if (spec.text) {
    const opts = { text: spec.text, seed: cfg.seed ^ salt, ...look, spacing: (look.spacing ?? 3.2) * sparse };
    // Built once to measure it, then again where it belongs.
    const probe = createTextFormation({ ...opts, center: [0, 0, 0], facing: [0, 1] });
    const at = placeText(spec, probe, o.airport, heightAt);
    formation = createTextFormation({ ...opts, ...at });
    const r = formation.width / 2 + 100;
    box = [at.center[0] - r, at.center[2] - r, at.center[0] + r, at.center[2] + r];
  } else {
    idx = dragonAxis(cfg, spec, gates);
    const axis = idx.map((i) => [gates[i].position.x, gates[i].position.y, gates[i].position.z]);
    formation = createDragon({
      ...look,
      axis,
      seed: cfg.seed ^ 0xd2a6 ^ salt,
      spacing: (look.spacing ?? 5.2) * sparse,
    });
    const pad = 400;
    box = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, , z] of axis) {
      box = [Math.min(box[0], x - pad), Math.min(box[1], z - pad), Math.max(box[2], x + pad), Math.max(box[3], z + pad)];
    }
  }
  // Separation scaled to the show's own spacing: a dense show would
  // otherwise have every drone pushing at slots it was built to sit in.
  const spacing = (look.spacing ?? (spec.text ? 3.2 : 5.2)) * sparse;
  const rules = { separationDist: Math.min(2.6, spacing * (spec.text ? 0.55 : 0.4)), ...(spec.rules ?? {}) };
  const flock = createFlock({ count: formation.count, seed: cfg.seed ^ 0xf10c ^ salt, rules });
  flock.setFormation(formation);
  flock.settle();

  // Ground cache over the show and some way round it.
  const ground = cacheHeights(heightAt, ...box);

  // The aeroplane as a threat: velocity and acceleration from its own
  // motion, so the dodge follows a turn rather than its tangent.
  const threat = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, ax: 0, ay: 0, az: 0, radius: spec.planeRadius ?? 8 };
  let have = false;
  const env = { threats: [threat], ground };

  return {
    flock, formation, dragon: spec.text ? null : formation, axisGates: idx, ground,
    /** Forget the aeroplane's last position (after a reset or a teleport). */
    resetThreat() { have = false; },
    /**
     * Advances the show by `dt` of real time with the aeroplane at
     * `position` moving at `velocity` (anything with x, y, z).
     */
    update(dt, position, velocity) {
      if (position) {
        if (have && dt > 0) {
          const k = 1 - Math.exp(-dt * 6);   // smoothed: a finite difference is noisy
          threat.ax += ((velocity.x - threat.vx) / dt - threat.ax) * k;
          threat.ay += ((velocity.y - threat.vy) / dt - threat.ay) * k;
          threat.az += ((velocity.z - threat.vz) / dt - threat.az) * k;
        } else {
          threat.ax = threat.ay = threat.az = 0;
        }
        threat.x = position.x; threat.y = position.y; threat.z = position.z;
        threat.vx = velocity.x; threat.vy = velocity.y; threat.vz = velocity.z;
        have = true;
        env.threats = [threat];
      } else {
        env.threats = [];
      }
      return flock.advance(dt, env);
    },
  };
}
