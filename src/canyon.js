// A carved canyon: one winding channel that the terrain is cut down to and
// that the route is threaded along.
//
// The same object answers both questions — "how deep is the ground here" and
// "where should the next gate go" — so the gorge you see and the gorge you fly
// are guaranteed to be the same shape.

import * as THREE from 'three';

const SAMPLES = 900;   // polyline resolution of the centreline
const CELL = 160;      // spatial grid cell for the distance query

const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * @param {object} cfg level config; needs cfg.canyon and cfg.airport
 * @param {number} rimY ground level the canyon is cut down from
 * @returns {object|null}
 */
export function createCanyon(cfg, rimY) {
  const spec = cfg.canyon;
  if (!spec) return null;

  const cx = cfg.airport.x;
  const cz = cfg.airport.z;

  // Centreline: a long sweeping loop around the airfield with S-bends laid
  // over it, so it curves at two different scales rather than reading as a
  // circle with a wobble.
  const pts = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const u = i / SAMPLES;
    const ang = spec.startAngle + spec.sweep * u;
    const r = spec.radius + Math.sin(u * spec.waves * Math.PI * 2) * spec.wiggle;
    pts.push(new THREE.Vector2(cx + Math.cos(ang) * r, cz + Math.sin(ang) * r));
  }

  // Arc length, so gates can be spaced by distance rather than by parameter.
  const arc = [0];
  for (let i = 1; i <= SAMPLES; i++) arc.push(arc[i - 1] + pts[i].distanceTo(pts[i - 1]));
  const length = arc[SAMPLES];

  /** Parameter u for a distance along the canyon. */
  function uAtArc(d) {
    const target = Math.min(Math.max(d, 0), length);
    let lo = 0, hi = SAMPLES;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arc[mid] < target) lo = mid + 1; else hi = mid;
    }
    const i = Math.max(1, lo);
    const span = arc[i] - arc[i - 1] || 1;
    return (i - 1 + (target - arc[i - 1]) / span) / SAMPLES;
  }

  const pointAt = (u) => {
    const f = Math.min(Math.max(u, 0), 1) * SAMPLES;
    const i = Math.min(SAMPLES - 1, Math.floor(f));
    const t = f - i;
    return new THREE.Vector2(
      lerp(pts[i].x, pts[i + 1].x, t),
      lerp(pts[i].y, pts[i + 1].y, t),
    );
  };

  const dirAt = (u) => {
    const a = pointAt(Math.max(0, u - 0.004));
    const b = pointAt(Math.min(1, u + 0.004));
    return b.sub(a).normalize();
  };

  // Depth profile: the canyon starts and ends as a shallow valley and is
  // deepest in the middle. That is what makes the ends flyable — you can
  // descend in and climb out without meeting a wall.
  const depthAt = (u) =>
    smoothstep(0, spec.entryRamp, u) * (1 - smoothstep(1 - spec.exitRamp, 1, u));

  const floorAt = (u) => rimY - spec.depth * depthAt(u);

  // ---- spatial index ------------------------------------------------------
  // Without this, every heightAt() would scan 900 segments — and heightAt is
  // called ~17k times just to build the mesh, plus several times per frame.
  const reach = spec.halfWidth + spec.rim + 40;
  const grid = new Map();
  const key = (gx, gz) => `${gx},${gz}`;

  for (let i = 0; i < SAMPLES; i++) {
    const a = pts[i], b = pts[i + 1];
    const minX = Math.min(a.x, b.x) - reach, maxX = Math.max(a.x, b.x) + reach;
    const minZ = Math.min(a.y, b.y) - reach, maxZ = Math.max(a.y, b.y) + reach;
    for (let gx = Math.floor(minX / CELL); gx <= Math.floor(maxX / CELL); gx++) {
      for (let gz = Math.floor(minZ / CELL); gz <= Math.floor(maxZ / CELL); gz++) {
        const k = key(gx, gz);
        let list = grid.get(k);
        if (!list) grid.set(k, (list = []));
        list.push(i);
      }
    }
  }

  /**
   * Nearest point on the centreline.
   * @returns {{dist:number, u:number}|null} null when far outside the canyon
   */
  function query(x, z) {
    const list = grid.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!list) return null;

    let best = Infinity, bestI = 0, bestT = 0;
    for (const i of list) {
      const a = pts[i], b = pts[i + 1];
      const dx = b.x - a.x, dz = b.y - a.y;
      const len2 = dx * dx + dz * dz;
      const t = len2 ? Math.min(1, Math.max(0, ((x - a.x) * dx + (z - a.y) * dz) / len2)) : 0;
      const px = a.x + dx * t, pz = a.y + dz * t;
      const d2 = (x - px) ** 2 + (z - pz) ** 2;
      if (d2 < best) { best = d2; bestI = i; bestT = t; }
    }
    return { dist: Math.sqrt(best), u: (bestI + bestT) / SAMPLES };
  }

  return {
    spec,
    length,
    pointAt,
    dirAt,
    floorAt,
    depthAt,
    uAtArc,
    query,

    /** True when the point lies inside the channel walls. */
    contains(x, z, margin = 0) {
      const q = query(x, z);
      return !!q && q.dist <= spec.halfWidth - margin;
    },

    /**
     * Cuts the canyon into a height. Only ever lowers ground, so it can be
     * applied last and nothing else can fill the gorge back in.
     */
    carve(x, z, h) {
      const q = query(x, z);
      if (!q) return h;
      const blend = smoothstep(spec.halfWidth, spec.halfWidth + spec.rim, q.dist);
      if (blend >= 1) return h;
      return lerp(Math.min(floorAt(q.u), h), h, blend);
    },
  };
}
