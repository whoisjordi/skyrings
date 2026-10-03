// The drone shows on the night mission: the flock module, a dragon formation
// coiled round a run of gates (one off the runway, one over the lake), and
// the aeroplane as the threat they all dodge. One of these per dragon.
//
// Game-side glue with no three.js, so the harness can fly through it too.
// Rendering is in flockview.js.

import { createFlock } from './flock/flock.js';
import { createDragon } from './flock/dragon.js';

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
 * @param {object} cfg       level config
 * @param {object} spec      one entry of its `dragons` list
 * @param {Array} gates      the route
 * @param {Function} heightAt
 * @param {object} [o]       { phone: true } for fewer drones
 */
export function createDrones(cfg, spec, gates, heightAt, o = {}) {
  const idx = dragonAxis(cfg, spec, gates);
  const salt = spec.seed ?? 0;
  const axis = idx.map((i) => [gates[i].position.x, gates[i].position.y, gates[i].position.z]);
  const dragon = createDragon({
    ...spec.shape,
    axis,
    seed: cfg.seed ^ 0xd2a6 ^ salt,
    spacing: (spec.shape?.spacing ?? 5.2) * (o.phone ? 1.6 : 1),
  });
  const flock = createFlock({ count: dragon.count, seed: cfg.seed ^ 0xf10c ^ salt, rules: spec.rules ?? {} });
  flock.setFormation(dragon);
  flock.settle();

  // Ground cache over the coil and some way round it.
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, , z] of axis) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  const pad = 400;
  const ground = cacheHeights(heightAt, x0 - pad, z0 - pad, x1 + pad, z1 + pad);

  // The aeroplane as a threat: velocity and acceleration from its own
  // motion, so the dodge follows a turn rather than its tangent.
  const threat = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, ax: 0, ay: 0, az: 0, radius: spec.planeRadius ?? 8 };
  let have = false;
  const env = { threats: [threat], ground };

  return {
    flock, dragon, axisGates: idx, ground,
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
