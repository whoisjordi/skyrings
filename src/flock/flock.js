// A flock of agents in two layers.
//
// Pattern 1 is the bird rules: dodge threats, keep off the ground, keep
// apart, match your neighbours' heading, stay with them. Pattern 2 is an
// optional formation: each agent has a slot it is drawn towards. Pattern 1
// always wins. The rules are applied in priority order from a fixed
// acceleration budget, so the formation only gets what the bird rules leave,
// and a panicking agent forgets its slot altogether.
//
// Neighbours are topological, the k nearest whatever their distance, and they
// are seen with a delay: each agent reads the others from a few ticks ago, so
// a startle runs through the flock as a wave instead of everywhere at once.
//
// No three.js in here: plain numbers and typed arrays, so the module runs
// headless and can be lifted into another game as it is.

import { createGrid } from './grid.js';
import { createHistory } from './history.js';

export const ROLE = { FLOCK: 0, PLAYER: 1, PREDATOR: 2 };

export const DEFAULT_RULES = {
  hz: 30,                 // fixed simulation rate
  k: 7,                   // topological neighbours
  perception: 14,         // farthest a neighbour can be (also the grid cell)
  nbrRefresh: 3,          // rebuild an agent's neighbour list every N ticks

  minSpeed: 0,            // drones can hover; birds want this above zero
  maxSpeed: 65,
  panicSpeed: 80,         // speed cap at full panic
  maxAccel: 45,           // the calm budget, units/s²
  panicAccel: 140,        // the budget at full panic

  separationDist: 2.6,
  separationAccel: 60,
  alignGain: 1.5,         // 1/s: how hard to match the neighbours' velocity
  cohesionGain: 0.3,      // 1/s²: how hard to close on the neighbours' centre

  lookAhead: 1.5,         // s: how far ahead a threat's path is predicted
  threatRadius: 45,       // around that path: inside it, agents notice
  clearance: 26,          // added to the threat's radius: the tunnel they open
  dodgeMargin: 1.8,       // how much faster than the bare minimum they dodge
  dodgeResponse: 8,       // 1/s: how quickly they reach that speed
  flinchSpeed: 8,         // drift away from a passing threat outside the tunnel
  hitRadius: 2,           // added to the threat's own radius
  hitKick: 30,            // speed a touched agent is knocked away at

  reactionDelay: 0.08,    // s: how stale a neighbour's state is when read
  reactionJitter: 0.03,   // ± per agent
  maxReaction: 0.5,       // s: the longest delay the history is sized for
  startleGain: 0.7,       // share of a neighbour's panic that is caught
  panicDecay: 1.5,        // 1/s

  groundClearance: 25,
  groundRefresh: 8,       // re-sample the ground under an agent every N ticks
  floor: 0,               // water: never below this whatever the ground says

  slotGain: 2,            // 1/s: slot error -> desired velocity
  slotResponse: 4,        // 1/s: desired velocity -> acceleration
  idleCalm: 0.02,         // below this panic, and
  idleSnap: 1.0,          // this close to its slot, an agent just rides it
  idleRefresh: 8,         // and refreshes its neighbours this many times less often

  home: null,             // {x, y, z, radius}: soft bounds with no formation
  homeAccel: 12,
  wander: 0,              // random steering, units/s², for free flight

  predatorSpeed: 70,
  predatorAccel: 60,
  predatorRadius: 4,
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PATH_SEGS = 4;   // a threat's predicted path, as a polyline

/**
 * @param {object} o
 * @param {number} o.count
 * @param {number} [o.seed]
 * @param {object} [o.rules]   overrides for DEFAULT_RULES
 * @param {number[]} [o.center] where the agents start, scattered by `spread`
 */
export function createFlock({ count, seed = 1, rules = {}, center = [0, 0, 0], spread = 60 }) {
  const R = { ...DEFAULT_RULES, ...rules };
  const n = count;
  const K = R.k;
  const dt = 1 / R.hz;
  const rnd = mulberry32(seed);

  const pos = new Float32Array(n * 3);
  const vel = new Float32Array(n * 3);
  const prevPos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const bright = new Float32Array(n).fill(1);
  const panic = new Float32Array(n);
  const role = new Uint8Array(n);
  const delay = new Uint8Array(n);
  const jitter = new Float32Array(n);   // each agent's draw in [-1, 1]
  const idle = new Uint8Array(n);       // riding its slot on the fast path
  const nbr = new Int32Array(n * K);
  const nbrN = new Uint8Array(n);
  const groundY = new Float32Array(n).fill(-1e9);

  const maxDelay = Math.ceil(Math.max(R.maxReaction, R.reactionDelay + R.reactionJitter) * R.hz);
  const history = createHistory(n, maxDelay + 1);
  const grid = createGrid(n, R.perception);
  const cand = new Int32Array(1024);
  const bestD = new Float64Array(K);
  const bestI = new Int32Array(K);
  const acc = new Float64Array(4);   // ax, ay, az, budget left

  for (let i = 0; i < n; i++) {
    // Uniform in a ball, so the start does not show a cube.
    let x, y, z;
    do { x = rnd() * 2 - 1; y = rnd() * 2 - 1; z = rnd() * 2 - 1; } while (x * x + y * y + z * z > 1);
    pos[i * 3] = center[0] + x * spread;
    pos[i * 3 + 1] = center[1] + y * spread;
    pos[i * 3 + 2] = center[2] + z * spread;
    vel[i * 3] = (rnd() - 0.5) * 4;
    vel[i * 3 + 1] = (rnd() - 0.5) * 4;
    vel[i * 3 + 2] = (rnd() - 0.5) * 4;
    jitter[i] = rnd() * 2 - 1;
    // A hue each, until a formation paints them.
    const h = rnd() * 6, f = h - Math.floor(h), sx = Math.floor(h) % 6;
    const rgb = [[1, f, 0], [1 - f, 1, 0], [0, 1, f], [0, 1 - f, 1], [f, 0, 1], [1, 0, 1 - f]][sx];
    col.set(rgb, i * 3);
  }
  prevPos.set(pos);
  history.push(pos, vel, panic);

  /** Each agent's delay in ticks, from the rules and its own jitter draw. */
  function applyDelays() {
    for (let i = 0; i < n; i++) {
      const d = R.reactionDelay + jitter[i] * R.reactionJitter;
      delay[i] = Math.max(0, Math.min(maxDelay, Math.round(d * R.hz)));
    }
  }
  applyDelays();

  let formation = null;
  let tick = 0;
  let time = 0;
  let carry = 0;
  const threats = [];          // preallocated predicted paths
  const stats = { hits: 0, nearest: Infinity };

  function threatSlot(k) {
    while (threats.length <= k) {
      threats.push({ pts: new Float64Array((PATH_SEGS + 1) * 3), r: 0, x0: 0, x1: 0, y0: 0, y1: 0, z0: 0, z1: 0, px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0 });
    }
    return threats[k];
  }

  /**
   * Predicts where a threat goes over the look-ahead: a short parabola from
   * its velocity and acceleration, so a turning aeroplane is dodged along its
   * curve rather than along its tangent.
   */
  function predict(k, x, y, z, vx, vy, vz, ax, ay, az, radius) {
    const t = threatSlot(k);
    const am = Math.hypot(ax, ay, az), cap = 120;
    if (am > cap) { ax *= cap / am; ay *= cap / am; az *= cap / am; }
    const reach = R.threatRadius + radius;
    t.x0 = t.y0 = t.z0 = Infinity; t.x1 = t.y1 = t.z1 = -Infinity;
    for (let s = 0; s <= PATH_SEGS; s++) {
      const tt = (s / PATH_SEGS) * R.lookAhead;
      const px = x + vx * tt + 0.5 * ax * tt * tt;
      const py = y + vy * tt + 0.5 * ay * tt * tt;
      const pz = z + vz * tt + 0.5 * az * tt * tt;
      t.pts[s * 3] = px; t.pts[s * 3 + 1] = py; t.pts[s * 3 + 2] = pz;
      if (px < t.x0) t.x0 = px; if (px > t.x1) t.x1 = px;
      if (py < t.y0) t.y0 = py; if (py > t.y1) t.y1 = py;
      if (pz < t.z0) t.z0 = pz; if (pz > t.z1) t.z1 = pz;
    }
    t.x0 -= reach; t.y0 -= reach; t.z0 -= reach;
    t.x1 += reach; t.y1 += reach; t.z1 += reach;
    t.r = radius;
    t.px = x; t.py = y; t.pz = z; t.vx = vx; t.vy = vy; t.vz = vz;
  }

  /** Spends from the budget: all of the request if it fits, else what is left. */
  function take(x, y, z) {
    const m = Math.sqrt(x * x + y * y + z * z);
    if (m < 1e-9 || acc[3] <= 0) return;
    const s = m <= acc[3] ? 1 : acc[3] / m;
    acc[0] += x * s; acc[1] += y * s; acc[2] += z * s;
    acc[3] -= m * s;
  }

  function refreshNeighbours(i) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    const m = grid.gather(x, y, z, cand);
    const lim = R.perception * R.perception;
    let c = 0;
    for (let q = 0; q < m; q++) {
      const j = cand[q];
      if (j === i || role[j] === ROLE.PREDATOR) continue;
      const dx = pos[j * 3] - x, dy = pos[j * 3 + 1] - y, dz = pos[j * 3 + 2] - z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d > lim || (c === K && d >= bestD[K - 1])) continue;
      let dup = false;
      for (let r = 0; r < c; r++) if (bestI[r] === j) { dup = true; break; }
      if (dup) continue;
      // Insertion into the sorted k-best.
      let r = c < K ? c++ : K - 1;
      while (r > 0 && bestD[r - 1] > d) { bestD[r] = bestD[r - 1]; bestI[r] = bestI[r - 1]; r--; }
      bestD[r] = d; bestI[r] = j;
    }
    for (let r = 0; r < c; r++) nbr[i * K + r] = bestI[r];
    nbrN[i] = c;
  }

  function stepPredator(i, h) {
    const o = i * 3;
    const x = pos[o], y = pos[o + 1], z = pos[o + 2];
    // Nearest flock agent; a full scan, but there are few predators.
    let best = Infinity, bj = -1;
    for (let j = 0; j < n; j++) {
      if (role[j] !== ROLE.FLOCK) continue;
      const d = (pos[j * 3] - x) ** 2 + (pos[j * 3 + 1] - y) ** 2 + (pos[j * 3 + 2] - z) ** 2;
      if (d < best) { best = d; bj = j; }
    }
    if (bj < 0) return;
    let dx = pos[bj * 3] - x, dy = pos[bj * 3 + 1] - y, dz = pos[bj * 3 + 2] - z;
    const d = Math.hypot(dx, dy, dz) || 1;
    dx = (dx / d) * R.predatorSpeed - vel[o];
    dy = (dy / d) * R.predatorSpeed - vel[o + 1];
    dz = (dz / d) * R.predatorSpeed - vel[o + 2];
    const m = Math.hypot(dx, dy, dz) || 1;
    const a = Math.min(R.predatorAccel, m * 3);
    vel[o] += (dx / m) * a * h; vel[o + 1] += (dy / m) * a * h; vel[o + 2] += (dz / m) * a * h;
    pos[o] += vel[o] * h; pos[o + 1] += vel[o + 1] * h; pos[o + 2] += vel[o + 2] * h;
  }

  /** One fixed tick. */
  function tickOnce(env) {
    prevPos.set(pos);
    time += dt;
    if (formation) {
      formation.update(time);
      col.set(formation.col.subarray(0, n * 3));
    }

    // Threats: what the caller passes in, plus our own predators.
    let nt = 0;
    if (env.threats) {
      for (const t of env.threats) {
        predict(nt++, t.x, t.y, t.z, t.vx, t.vy, t.vz, t.ax ?? 0, t.ay ?? 0, t.az ?? 0, t.radius ?? 5);
      }
    }
    for (let i = 0; i < n; i++) {
      if (role[i] !== ROLE.PREDATOR) continue;
      const o = i * 3;
      predict(nt++, pos[o], pos[o + 1], pos[o + 2], vel[o], vel[o + 1], vel[o + 2], 0, 0, 0, R.predatorRadius);
    }

    grid.build(pos, n, (i) => role[i] === ROLE.PREDATOR);
    // Agents resting on their slots keep their neighbours far longer: in a
    // formation, who is next to whom hardly changes.
    const slow = R.nbrRefresh * R.idleRefresh;
    for (let i = 0; i < n; i++) {
      const every = idle[i] ? slow : R.nbrRefresh;
      if ((i + tick) % every === 0) refreshNeighbours(i);
    }
    if (tick === 0) for (let i = 0; i < n; i++) refreshNeighbours(i);

    const ground = env.ground;
    const decay = Math.exp(-R.panicDecay * dt);
    const fp = formation ? formation.pos : null;
    const fv = formation ? formation.vel : null;
    const reach2 = (R.threatRadius) ** 2;

    for (let i = 0; i < n; i++) {
      const rl = role[i];
      if (rl === ROLE.PLAYER) continue;          // moved by its owner
      if (rl === ROLE.PREDATOR) { stepPredator(i, dt); continue; }

      const o = i * 3;
      const x = pos[o], y = pos[o + 1], z = pos[o + 2];
      const vx = vel[o], vy = vel[o + 1], vz = vel[o + 2];
      let pn = panic[i] * decay;

      // ---- 1. threats ----------------------------------------------------
      let tx = 0, ty = 0, tz = 0, threatened = false;
      for (let k = 0; k < nt; k++) {
        const t = threats[k];
        if (x < t.x0 || x > t.x1 || y < t.y0 || y > t.y1 || z < t.z0 || z > t.z1) continue;
        // Closest point on the predicted path, and when the threat is there.
        let bd = Infinity, bx = 0, by = 0, bz = 0, bt = 0;
        for (let s = 0; s < PATH_SEGS; s++) {
          const a = s * 3;
          const ax = t.pts[a], ay = t.pts[a + 1], az = t.pts[a + 2];
          const sx = t.pts[a + 3] - ax, sy = t.pts[a + 4] - ay, sz = t.pts[a + 5] - az;
          const l2 = sx * sx + sy * sy + sz * sz;
          let u = l2 > 0 ? ((x - ax) * sx + (y - ay) * sy + (z - az) * sz) / l2 : 0;
          u = u < 0 ? 0 : u > 1 ? 1 : u;
          const qx = ax + sx * u, qy = ay + sy * u, qz = az + sz * u;
          const d = (x - qx) ** 2 + (y - qy) ** 2 + (z - qz) ** 2;
          if (d < bd) { bd = d; bx = qx; by = qy; bz = qz; bt = (s + u) / PATH_SEGS; }
        }
        const rr = R.threatRadius + t.r;
        if (bd > rr * rr) continue;
        threatened = true;
        const d = Math.sqrt(bd);
        let dx, dy, dz;
        if (d > 1e-3) { dx = (x - bx) / d; dy = (y - by) / d; dz = (z - bz) / d; } else {
          // Dead on the path: pick a side across it, alternating by agent.
          const sg = (i & 1) ? 1 : -1;
          dx = -t.vz * sg; dy = 0; dz = t.vx * sg;
          const m = Math.hypot(dx, dz) || 1; dx /= m; dz /= m;
        }
        // The minimum dodge. Each agent picks the speed away from the path
        // that gets it `clearance` off it by the time the threat arrives,
        // with a margin, and steers its velocity to that — no harder, so it
        // does not overshoot and leave the formation for good. Outside the
        // tunnel there is only a flinch: a small drift away. A tunnel opens
        // and the rest of the flock ripples.
        const behind = ((x - t.px) * t.vx + (y - t.py) * t.vy + (z - t.pz) * t.vz) < 0 && bt === 0;
        const clear = t.r + R.clearance;
        const need = clear > d ? clear - d : 0;
        const tc = Math.max(0.15, bt * R.lookAhead);
        const flinch = (1 - d / rr) * (behind ? 0.25 : 1);
        const want = (R.dodgeMargin * need) / tc + R.flinchSpeed * flinch;
        const away = vx * dx + vy * dy + vz * dz;
        const a = want > away ? Math.min(R.panicAccel, (want - away) * R.dodgeResponse) : 0;
        tx += dx * a; ty += dy * a; tz += dz * a;
        const u = Math.min(1, (need / clear) * 1.5 + 0.3 * flinch);
        if (u > pn) pn = u;

        // Touched anyway: knocked away and dimmed, and counted.
        const hx = x - t.px, hy = y - t.py, hz = z - t.pz;
        const hit = t.r + R.hitRadius;
        const h2 = hx * hx + hy * hy + hz * hz;
        if (h2 < stats.nearest * stats.nearest && k < (env.threats ? env.threats.length : 0)) stats.nearest = Math.sqrt(h2);
        if (h2 < hit * hit) {
          const hm = Math.sqrt(h2) || 1;
          vel[o] += (hx / hm) * R.hitKick; vel[o + 1] += (hy / hm) * R.hitKick; vel[o + 2] += (hz / hm) * R.hitKick;
          bright[i] = 0.15;
          stats.hits++;
        }
      }

      // ---- neighbours, as they were `delay` ticks ago ----------------------
      const f = history.frame(delay[i]);
      const hb = history.vecBase(f), sb = history.scalarBase(f);
      const hp = history.pos, hv = history.vel, hpn = history.panic;
      const c = nbrN[i];

      // Fast path: calm, nothing near, no neighbour startled or crowding it,
      // already on the slot. The bird rules would add next to nothing here, so the agent
      // simply rides its slot. This is most of a formation most of the time,
      // and it is what lets a big show stay cheap.
      if (fp && !threatened && pn < R.idleCalm) {
        // Not if a neighbour is too close: then separation has work to do.
        let qp = 0, crowd = false;
        const sep2 = R.separationDist * R.separationDist;
        for (let r = 0; r < c; r++) {
          const j = nbr[i * K + r];
          const pj = hpn[sb + j];
          if (pj > qp) qp = pj;
          const jo = j * 3;
          const dx = x - pos[jo], dy = y - pos[jo + 1], dz = z - pos[jo + 2];
          if (dx * dx + dy * dy + dz * dz < sep2) crowd = true;
        }
        const ex = fp[o] - fv[o] * dt - x, ey = fp[o + 1] - fv[o + 1] * dt - y, ez = fp[o + 2] - fv[o + 2] * dt - z;
        if (!crowd && qp * R.startleGain < R.idleCalm && ex * ex + ey * ey + ez * ez < R.idleSnap * R.idleSnap) {
          panic[i] = pn;
          pos[o] = fp[o]; pos[o + 1] = fp[o + 1]; pos[o + 2] = fp[o + 2];
          vel[o] = fv[o]; vel[o + 1] = fv[o + 1]; vel[o + 2] = fv[o + 2];
          if (bright[i] < 1) bright[i] = Math.min(1, bright[i] + dt * 0.8);
          idle[i] = 1;
          continue;
        }
      }
      idle[i] = 0;
      let sx = 0, sy = 0, sz = 0, axs = 0, ays = 0, azs = 0, cx = 0, cy = 0, cz = 0, np = 0;
      const sep = R.separationDist;
      for (let r = 0; r < c; r++) {
        const j = nbr[i * K + r];
        const jo = j * 3;
        // Separation uses where they are now: being late is not allowed here.
        const dx = x - pos[jo], dy = y - pos[jo + 1], dz = z - pos[jo + 2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < sep * sep) {
          const d = Math.sqrt(d2);
          if (d > 1e-4) {
            const w = ((sep - d) / sep) * R.separationAccel / d;
            sx += dx * w; sy += dy * w; sz += dz * w;
          } else {
            sx += (i < j ? 1 : -1) * R.separationAccel;
          }
        }
        axs += hv[hb + jo]; ays += hv[hb + jo + 1]; azs += hv[hb + jo + 2];
        cx += hp[hb + jo]; cy += hp[hb + jo + 1]; cz += hp[hb + jo + 2];
        const pj = hpn[sb + j];
        if (pj > np) np = pj;
      }
      // Startle: catch some of the neighbours' panic.
      if (np * R.startleGain > pn) pn = np * R.startleGain;
      panic[i] = pn;

      // ---- the budget ------------------------------------------------------
      acc[0] = acc[1] = acc[2] = 0;
      acc[3] = R.maxAccel + (R.panicAccel - R.maxAccel) * pn;

      take(tx, ty, tz);

      // ---- 2. ground -----------------------------------------------------
      if (ground && (tick === 0 || (i + tick) % R.groundRefresh === 0)) {
        const g = Math.max(ground(x, z), ground(x + vx * 0.8, z + vz * 0.8));
        groundY[i] = Math.max(g, R.floor);
      } else if (!ground) groundY[i] = R.floor;
      const clear = y - groundY[i];
      if (clear < R.groundClearance) {
        const w = 1 - clear / R.groundClearance;
        take(0, R.maxAccel * 3 * Math.min(2, w) - Math.min(0, vy) * 2, 0);
      }

      // ---- 3-5. separation, alignment, cohesion --------------------------
      take(sx, sy, sz);
      if (c > 0) {
        const ag = R.alignGain * (1 + pn * 2) / c;
        take((axs - vx * c) * ag, (ays - vy * c) * ag, (azs - vz * c) * ag);
        // Cohesion compares the neighbours with where this agent was at the
        // same moment: what it saw then was where they were relative to it.
        // Against its own present position, everything delayed would sit
        // behind it, and a moving flock would drag itself backwards.
        const cg = R.cohesionGain / c;
        const ox = hp[hb + o], oy = hp[hb + o + 1], oz = hp[hb + o + 2];
        take((cx - ox * c) * cg, (cy - oy * c) * cg, (cz - oz * c) * cg);
      }

      // ---- 6. the formation: an attractor, and only what is left -----------
      if (fp) {
        // The slot is given for the end of this tick; the error is taken
        // against where it was at the start, which is where this agent is.
        // The slot's own acceleration is fed forward, so curves and the
        // body wave do not lag.
        // Closing speed is linear in the error near the slot, and never more
        // than it can brake from in the distance left, so a drone flung far
        // away comes back fast without overshooting.
        const calm = 1 - pn;
        const ex = fp[o] - fv[o] * dt - x, ey = fp[o + 1] - fv[o + 1] * dt - y, ez = fp[o + 2] - fv[o + 2] * dt - z;
        const e = Math.sqrt(ex * ex + ey * ey + ez * ez);
        const close = e > 1e-6 ? Math.min(R.slotGain * e, Math.sqrt(R.maxAccel * e)) / e : 0;
        let dx = fv[o] + ex * close;
        let dy = fv[o + 1] + ey * close;
        let dz = fv[o + 2] + ez * close;
        const m = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (m > R.maxSpeed) { dx *= R.maxSpeed / m; dy *= R.maxSpeed / m; dz *= R.maxSpeed / m; }
        const g = R.slotResponse * calm;
        const fa = formation.acc;
        take(((dx - vx) * g + (fa ? fa[o] : 0) * calm),
          ((dy - vy) * g + (fa ? fa[o + 1] : 0) * calm),
          ((dz - vz) * g + (fa ? fa[o + 2] : 0) * calm));
      } else if (R.home) {
        const H = R.home;
        const hx = H.x - x, hy = H.y - y, hz = H.z - z;
        const hd = Math.sqrt(hx * hx + hy * hy + hz * hz);
        if (hd > H.radius) {
          const w = Math.min(1, (hd - H.radius) / H.radius) * R.homeAccel / hd;
          take(hx * w, hy * w, hz * w);
        }
      }
      if (R.wander) take((rnd() - 0.5) * R.wander, (rnd() - 0.5) * R.wander * 0.4, (rnd() - 0.5) * R.wander);

      // ---- integrate -------------------------------------------------------
      let nvx = vx + acc[0] * dt, nvy = vy + acc[1] * dt, nvz = vz + acc[2] * dt;
      const sp = Math.sqrt(nvx * nvx + nvy * nvy + nvz * nvz);
      const top = R.maxSpeed + (R.panicSpeed - R.maxSpeed) * pn;
      if (sp > top) { const s = top / sp; nvx *= s; nvy *= s; nvz *= s; } else if (sp < R.minSpeed && sp > 1e-6) {
        const s = R.minSpeed / sp; nvx *= s; nvy *= s; nvz *= s;
      }
      vel[o] = nvx; vel[o + 1] = nvy; vel[o + 2] = nvz;
      pos[o] = x + nvx * dt; pos[o + 1] = y + nvy * dt; pos[o + 2] = z + nvz * dt;
      if (bright[i] < 1) bright[i] = Math.min(1, bright[i] + dt * 0.8);
    }

    history.push(pos, vel, panic);
    tick++;
  }

  return {
    count: n,
    rules: R,
    pos, vel, prevPos, col, bright, panic, role,
    stats,
    /** Fraction of a tick past the last one, for render interpolation. */
    alpha: 0,
    get time() { return time; },
    setRole(i, r) { role[i] = r; },
    /** Changes rules on the fly (for tuning); delays are recomputed. */
    setRules(patch) {
      Object.assign(R, patch);
      if ('reactionDelay' in patch || 'reactionJitter' in patch) applyDelays();
    },
    /** Slots to be drawn towards: { pos, vel, col, update(time) }, or null. */
    setFormation(f) { formation = f; },
    get formation() { return formation; },
    /**
     * Advances by real time `dtReal` in fixed ticks.
     * env: { threats: [{x,y,z, vx,vy,vz, ax?,ay?,az?, radius}], ground(x,z) }
     */
    advance(dtReal, env = {}) {
      carry += dtReal;
      let steps = 0;
      while (carry >= dt && steps < 4) { tickOnce(env); carry -= dt; steps++; }
      if (carry > dt) carry = 0;         // fell behind: drop the debt
      this.alpha = carry / dt;
      return steps;
    },
    tick: tickOnce,
    /** Snaps every agent onto its slot (e.g. on a level load). */
    settle() {
      if (!formation) return;
      formation.update(time);
      pos.set(formation.pos.subarray(0, n * 3));
      vel.set(formation.vel.subarray(0, n * 3));
      prevPos.set(pos);
      col.set(formation.col.subarray(0, n * 3));
      for (let f = 0; f < history.frames; f++) history.push(pos, vel, panic);
    },
  };
}
