// The Chinese dragon: a formation for the flock, i.e. a slot and a colour for
// every agent, moving with time.
//
// The head swims a closed path that coils round an axis — a stretch of the
// gate route — out to the far end and back again, so the dragon is always
// wrapped round that stretch. The body follows the head's own path, like a
// snake: a slot at distance s behind the head is wherever the head was s
// units of path ago. Its back faces out, its belly faces the axis.
//
// Slots are (s, u, v): distance behind the head tip, offset to the side, and
// offset up its back. Colours are per slot, not per agent.

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const DRAGON_DEFAULTS = {
  length: 560,           // head tip to tail tip
  speed: 26,             // the head, along its path
  radius: 60,            // of the coil round the axis: its inside hugs the gates
  radiusSwing: 8,        // wider going out, tighter coming back
  pitch: 170,            // axial distance per turn
  spacing: 5.2,          // between body drones; larger = fewer drones
  undulation: 7,         // up-and-down wave along the body
  waveLength: 140,
  colors: {
    scale: [0.86, 0.09, 0.06],
    scaleDark: [0.55, 0.04, 0.05],
    belly: [1.0, 0.82, 0.45],
    gold: [1.0, 0.72, 0.12],
    mane: [1.0, 0.45, 0.08],
    eye: [1.0, 1.0, 1.0],
    pearl: [1.0, 0.95, 0.8],
    whisker: [1.0, 0.85, 0.4],
  },
};

// ---------------------------------------------------------------------------
// The axis: a smooth curve through the given points, with a twist-free frame
// ---------------------------------------------------------------------------
function catmull(points, samples) {
  const out = [];
  const P = points;
  const n = P.length;
  for (let k = 0; k <= samples; k++) {
    const t = (k / samples) * (n - 1);
    const i = Math.min(n - 2, Math.floor(t));
    const f = t - i;
    const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(n - 1, i + 2)];
    const f2 = f * f, f3 = f2 * f;
    const pt = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      pt[c] = 0.5 * ((2 * p1[c]) + (-p0[c] + p2[c]) * f
        + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * f2
        + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * f3);
    }
    out.push(pt);
  }
  return out;
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const m = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / m, a[1] / m, a[2] / m]; };

/** Arc-length table of a polyline, resampled every `ds`, with frames. */
function buildAxis(points, ds) {
  const raw = catmull(points, (points.length - 1) * 200);
  const arc = [0];
  for (let i = 1; i < raw.length; i++) arc.push(arc[i - 1] + Math.hypot(...sub(raw[i], raw[i - 1])));
  const L = arc[arc.length - 1];
  const m = Math.max(2, Math.ceil(L / ds));
  const P = [], T = [];
  let j = 0;
  for (let k = 0; k <= m; k++) {
    const s = (k / m) * L;
    while (j < raw.length - 2 && arc[j + 1] < s) j++;
    const f = (s - arc[j]) / ((arc[j + 1] - arc[j]) || 1);
    P.push([0, 1, 2].map((c) => raw[j][c] + (raw[j + 1][c] - raw[j][c]) * f));
  }
  for (let k = 0; k <= m; k++) T.push(norm(sub(P[Math.min(m, k + 1)], P[Math.max(0, k - 1)])));
  // Rotation-minimising frame, started with "up" as the normal so the coil
  // starts from the top.
  const N = [], B = [];
  let n0 = norm(sub([0, 1, 0], T[0].map((t) => t * T[0][1])));
  for (let k = 0; k <= m; k++) {
    if (k > 0) {
      // Double reflection (Wang et al. 2008).
      const v1 = sub(P[k], P[k - 1]);
      const c1 = dot(v1, v1) || 1;
      const rL = sub(n0, v1.map((x) => (x * 2 * dot(v1, n0)) / c1));
      const tL = sub(T[k - 1], v1.map((x) => (x * 2 * dot(v1, T[k - 1])) / c1));
      const v2 = sub(T[k], tL);
      const c2 = dot(v2, v2) || 1;
      n0 = norm(sub(rL, v2.map((x) => (x * 2 * dot(v2, rL)) / c2)));
    }
    N.push(n0);
    B.push(cross(T[k], n0));
  }
  return { L, m, ds: L / m, P, T, N, B };
}

// ---------------------------------------------------------------------------
// The slots
// ---------------------------------------------------------------------------
/** Body radius by distance behind the head tip. */
function bodyRadius(s, L) {
  if (s < 30) return 0;
  if (s < 60) return 8 + (s - 30) * 0.15;               // the neck
  return 12.5 * (1 - smoothstep(110, L, s)) + 2.2 * smoothstep(110, L, s);
}

function makeSlots(o, rnd) {
  const L = o.length, C = o.colors;
  const slots = [];   // {s, u, v, c:[r,g,b], tw (twinkle phase), part}
  const add = (s, u, v, c, part) => slots.push({ s, u, v, c, part, tw: rnd() * TAU, tws: 1.5 + rnd() * 2.5 });

  // Body tube: rings of slots, spaced by circumference, offset every other
  // ring so the dots stagger like scales.
  let ring = 0;
  for (let s = 32; s < L - 6; s += o.spacing * 0.9, ring++) {
    const r = bodyRadius(s, L);
    const k = Math.max(4, Math.round((TAU * r) / o.spacing));
    for (let q = 0; q < k; q++) {
      const a = ((q + (ring & 1) * 0.5) / k) * TAU;        // 0 = top of the back
      const u = Math.sin(a) * r, v = Math.cos(a) * r;
      let c;
      if (Math.cos(a) < -0.55) c = C.belly;
      else if (Math.cos(a) > 0.9) c = C.gold;               // a gold line down the spine
      else c = (ring % 3 === 0) ? C.scaleDark : C.scale;
      add(s, u, v, c, 'body');
    }
  }

  // Spikes down the back: small triangles pointing up and back.
  for (let s = 45; s < L - 40; s += o.spacing * 2.2) {
    const r = bodyRadius(s, L);
    const h = 3 + r * 0.45;
    add(s + 1.5, 0, r + h * 0.5, C.gold, 'spike');
    add(s + 3, 0, r + h, C.gold, 'spike');
  }

  // Head: snout, skull, an open jaw. The head tip is s = 0.
  for (let s = 0; s <= 30; s += 2.6) {
    const w = 3 + s * 0.18, top = 3 + s * 0.2;
    for (const u of [-w, -w / 3, w / 3, w]) add(s, u, top, C.scale, 'head');
    // Upper lip and the lower jaw, dropping open towards the front.
    const open = (1 - s / 30) * 8;
    for (const u of [-w * 0.8, 0, w * 0.8]) {
      add(s, u, -1, C.scale, 'head');
      if (s > 2) add(s + 1, u, -4 - open, C.belly, 'jaw');
    }
  }
  // Eyes, bright, with a brow above each.
  for (const sd of [-1, 1]) {
    add(14, sd * 7, 6, C.eye, 'eye');
    add(15, sd * 7.5, 7, C.eye, 'eye');
    add(13, sd * 7, 9, C.gold, 'brow');
  }
  // Horns: back and up from the skull, antler-like.
  for (const sd of [-1, 1]) {
    for (let t = 0; t <= 1; t += 0.12) {
      add(24 + t * 22, sd * (5 + t * 7), 9 + t * 14 - t * t * 4, C.gold, 'horn');
    }
    add(36, sd * 10, 18, C.gold, 'horn');
    add(38, sd * 12, 21, C.gold, 'horn');
  }
  // Mane: a ruff of orange behind the head.
  for (let s = 26; s < 52; s += 2.4) {
    for (const a of [-1.2, -0.6, 0, 0.6, 1.2]) {
      const r = bodyRadius(Math.max(32, s), L) + 4 + rnd() * 3;
      add(s, Math.sin(a) * r, Math.cos(a) * r, C.mane, 'mane');
    }
  }
  // Whiskers: long trailing barbels from the snout. They wave (see update).
  for (const sd of [-1, 1]) {
    for (let t = 0; t <= 1.0001; t += 1 / 14) {
      add(3 + t * 60, sd * (5 + t * 26), -2 - t * 6, C.whisker, 'whisker');
    }
  }
  // Legs: a front and a hind pair, three claws each.
  for (const s0 of [95, L * 0.62]) {
    for (const sd of [-1, 1]) {
      const r = bodyRadius(s0, L);
      for (let t = 0; t <= 1; t += 0.2) add(s0 + t * 8, sd * (r + t * 9), -r * 0.4 - t * 10, C.scale, 'leg');
      for (const spread of [-4, 0, 4]) {
        add(s0 + 8 + spread, sd * (r + 12), -r * 0.4 - 13, C.gold, 'claw');
        add(s0 + 8 + spread * 1.4, sd * (r + 14), -r * 0.4 - 15, C.gold, 'claw');
      }
    }
  }
  // Tail tuft: a flame-shaped fan of gold and orange.
  for (let q = 0; q < 34; q++) {
    const t = rnd(), a = (rnd() - 0.5) * 2.2;
    const len = 6 + t * 26;
    add(L - 8 + t * 22, Math.sin(a) * len * 0.6, Math.cos(a) * len * 0.5, t > 0.5 ? C.mane : C.gold, 'tail');
  }
  // The flaming pearl ahead of the mouth.
  for (let q = 0; q < 34; q++) {
    let x, y, z;
    do { x = rnd() * 2 - 1; y = rnd() * 2 - 1; z = rnd() * 2 - 1; } while (x * x + y * y + z * z > 1);
    add(-32 + x * 5, y * 5, z * 5, C.pearl, 'pearl');
  }
  return slots;
}

/**
 * Drops slots that sit almost on top of an earlier one (in the straight,
 * resting pose): features overlap where they join the head, and two drones
 * told to share a point would just push each other about.
 */
const PRIORITY = { eye: 0, pearl: 1, whisker: 2, horn: 3, brow: 4, claw: 5, jaw: 6, spike: 7 };

function dedupe(slots, min) {
  // Features win over plain body: an eye that clashes with the skull keeps
  // its place and the skull loses a dot.
  slots = slots.map((sl, i) => [PRIORITY[sl.part] ?? 9, i, sl]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((x) => x[2]);
  const keep = [];
  const cell = new Map();
  const key = (a, b, c) => `${a},${b},${c}`;
  for (const sl of slots) {
    const gx = Math.floor(sl.s / min), gy = Math.floor(sl.u / min), gz = Math.floor(sl.v / min);
    let clash = false;
    for (let a = -1; a <= 1 && !clash; a++) {
      for (let b = -1; b <= 1 && !clash; b++) {
        for (let c = -1; c <= 1 && !clash; c++) {
          for (const o of cell.get(key(gx + a, gy + b, gz + c)) ?? []) {
            if (Math.hypot(o.s - sl.s, o.u - sl.u, o.v - sl.v) < min) { clash = true; break; }
          }
        }
      }
    }
    if (clash) continue;
    keep.push(sl);
    const k = key(gx, gy, gz);
    if (!cell.has(k)) cell.set(k, []);
    cell.get(k).push(sl);
  }
  return keep;
}

// ---------------------------------------------------------------------------
// The formation
// ---------------------------------------------------------------------------
/**
 * @param {object} o
 * @param {number[][]} o.axis   points [x,y,z] the dragon coils round
 * @param {number} [o.seed]
 * plus any of DRAGON_DEFAULTS
 */
export function createDragon(o) {
  const opt = { ...DRAGON_DEFAULTS, ...o, colors: { ...DRAGON_DEFAULTS.colors, ...(o.colors ?? {}) } };
  const rnd = mulberry32(opt.seed ?? 8);
  const axis = buildAxis(opt.axis, 2);

  // The head's closed path: out along the axis and back, coiling all the
  // while. u goes 0 -> La -> 0 with a cosine, so it eases into each end.
  const La = axis.L;
  const turns = Math.max(2, Math.round((2 * La) / opt.pitch));
  const M = 24000;
  const raw = new Float64Array((M + 1) * 3), rad = new Float64Array((M + 1) * 3);
  for (let k = 0; k <= M; k++) {
    const tau = k / M;
    const u = La * (1 - Math.cos(TAU * tau)) / 2;
    const th = TAU * turns * tau;
    const r = opt.radius + opt.radiusSwing * Math.sin(TAU * tau);
    const f = Math.min(axis.m, u / axis.ds);
    const i = Math.min(axis.m - 1, Math.floor(f)), w = f - i;
    for (let c = 0; c < 3; c++) {
      const A = axis.P[i][c] + (axis.P[i + 1][c] - axis.P[i][c]) * w;
      const Nn = axis.N[i][c] + (axis.N[i + 1][c] - axis.N[i][c]) * w;
      const Bn = axis.B[i][c] + (axis.B[i + 1][c] - axis.B[i][c]) * w;
      const radial = Math.cos(th) * Nn + Math.sin(th) * Bn;
      rad[k * 3 + c] = radial;
      raw[k * 3 + c] = A + r * radial;
    }
  }
  // Resample the path by arc length, every unit, with a frame per sample:
  // tangent, "up" (out from the axis) and "side".
  const arc = new Float64Array(M + 1);
  for (let k = 1; k <= M; k++) {
    arc[k] = arc[k - 1] + Math.hypot(raw[k * 3] - raw[k * 3 - 3], raw[k * 3 + 1] - raw[k * 3 - 2], raw[k * 3 + 2] - raw[k * 3 - 1]);
  }
  const loop = arc[M];
  const S = Math.ceil(loop);
  const PP = new Float32Array(S * 3), TT = new Float32Array(S * 3), UP = new Float32Array(S * 3), SD = new Float32Array(S * 3);
  let j = 0;
  for (let k = 0; k < S; k++) {
    const s = (k / S) * loop;
    while (j < M - 1 && arc[j + 1] < s) j++;
    const f = (s - arc[j]) / ((arc[j + 1] - arc[j]) || 1);
    for (let c = 0; c < 3; c++) {
      PP[k * 3 + c] = raw[j * 3 + c] + (raw[j * 3 + 3 + c] - raw[j * 3 + c]) * f;
      UP[k * 3 + c] = rad[j * 3 + c] + (rad[j * 3 + 3 + c] - rad[j * 3 + c]) * f;
    }
  }
  for (let k = 0; k < S; k++) {
    const a = ((k + 1) % S) * 3, b = ((k - 1 + S) % S) * 3;
    const t = norm([PP[a] - PP[b], PP[a + 1] - PP[b + 1], PP[a + 2] - PP[b + 2]]);
    let up = [UP[k * 3], UP[k * 3 + 1], UP[k * 3 + 2]];
    const d = dot(up, t);
    up = norm([up[0] - t[0] * d, up[1] - t[1] * d, up[2] - t[2] * d]);
    const sd = cross(t, up);
    TT.set(t, k * 3); UP.set(up, k * 3); SD.set(sd, k * 3);
  }

  const slots = dedupe(makeSlots(opt, rnd), opt.spacing * 0.45);
  const n = slots.length;
  const pos = new Float32Array(n * 3), vel = new Float32Array(n * 3), col = new Float32Array(n * 3);
  const L = opt.length;

  // Smoothly interpolated frame at a path distance (wraps round the loop).
  const fr = new Float64Array(12);
  function frame(a) {
    a = ((a % loop) + loop) % loop * (S / loop);
    const i = Math.floor(a) % S, i2 = (i + 1) % S, w = a - Math.floor(a);
    for (let c = 0; c < 3; c++) {
      fr[c] = PP[i * 3 + c] + (PP[i2 * 3 + c] - PP[i * 3 + c]) * w;
      fr[3 + c] = TT[i * 3 + c] + (TT[i2 * 3 + c] - TT[i * 3 + c]) * w;
      fr[6 + c] = UP[i * 3 + c] + (UP[i2 * 3 + c] - UP[i * 3 + c]) * w;
      fr[9 + c] = SD[i * 3 + c] + (SD[i2 * 3 + c] - SD[i * 3 + c]) * w;
    }
    return fr;
  }

  let headAt = 0;
  let lastTime = null;
  const prev = new Float32Array(n * 3);
  const prevVel = new Float32Array(n * 3);
  const acc = new Float32Array(n * 3);
  function update(time) {
    headAt = time * opt.speed;
    // Slot velocity from the slot's own motion, so the wave and the whiskers
    // are fed forward too, not only the swim along the path.
    const h = lastTime === null ? 0 : time - lastTime;
    prev.set(pos);
    prevVel.set(vel);
    // A brightness wave down the body every 20s, taking 4s to run its length.
    const cyc = time % 20;
    const waveS = cyc < 4 ? (cyc / 4) * (L + 80) - 40 : -1e9;
    const pearlPulse = 0.8 + 0.2 * Math.sin(time * 5);
    for (let k = 0; k < n; k++) {
      const sl = slots[k];
      let s = sl.s, u = sl.u, v = sl.v;
      if (sl.part === 'whisker') {
        const t = (s - 3) / 60;
        v += Math.sin(time * 2.2 - t * 5) * 7 * t;
        u += Math.sin(time * 1.7 - t * 4) * 4 * t * Math.sign(u);
      } else if (sl.part === 'pearl') {
        // The pearl tumbles.
        const a = time * 1.3, cu = Math.cos(a), su = Math.sin(a);
        const du = s + 32;
        s = -32 + du * cu - v * su; v = du * su + v * cu;
      }
      // Up-and-down wave along the body; the head stays steadier.
      const und = opt.undulation * smoothstep(20, 120, s)
        * Math.sin((TAU * s) / opt.waveLength - time * 1.6);
      const F = frame(headAt - s);
      const vv = v + und;
      const o3 = k * 3;
      for (let c = 0; c < 3; c++) {
        pos[o3 + c] = F[c] + F[9 + c] * u + F[6 + c] * vv;
        vel[o3 + c] = h > 0 && h < 0.5 ? (pos[o3 + c] - prev[o3 + c]) / h : F[3 + c] * opt.speed;
        acc[o3 + c] = h > 0 && h < 0.5 && lastTime > 0 ? (vel[o3 + c] - prevVel[o3 + c]) / h : 0;
      }
      let b = 0.86 + 0.14 * Math.sin(sl.tw + time * sl.tws);
      if (sl.part === 'pearl') b *= pearlPulse * 1.2;
      if (sl.part === 'eye') b = 1.2;
      b += 0.7 * Math.exp(-(((s - waveS) / 26) ** 2));
      col[o3] = Math.min(1, sl.c[0] * b);
      col[o3 + 1] = Math.min(1, sl.c[1] * b);
      col[o3 + 2] = Math.min(1, sl.c[2] * b);
    }
    lastTime = time;
  }
  update(0);

  return {
    count: n,
    pos, vel, acc, col,
    slots,
    update,
    loopLength: loop,
    turns,
    /** The head's position on its path, for tests and debugging. */
    head(time) { const F = frame(time * opt.speed); return [F[0], F[1], F[2]]; },
    /** Lowest point of the path below each sample's axis, for checks. */
    pathPoint(a) { const F = frame(a); return [F[0], F[1], F[2]]; },
    parts() {
      const out = {};
      for (const s of slots) out[s.part] = (out[s.part] ?? 0) + 1;
      return out;
    },
  };
}
