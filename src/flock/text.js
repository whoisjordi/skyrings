// Text as a formation: letters drawn in drones, like a drone show writing a
// name in the sky. A small stroke font (lines and elliptical arcs), sampled
// into dots along each stroke and a few rows across it. The text hangs in a
// vertical plane facing a point, breathes slowly, twinkles, and a bright
// sweep runs across it every few seconds.
//
// Only the glyphs needed so far are in the font; adding one is a list of
// strokes in a 7-high box.

const TAU = Math.PI * 2;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Strokes: ['l', x0, y0, x1, y1] or ['a', cx, cy, rx, ry, from, to] (radians,
// counter-clockwise from +x). Capitals are 7 high; lower case 4.5, with a
// 7-high ascender on the d.
const FONT = {
  N: { w: 4.4, s: [['l', 0, 0, 0, 7], ['l', 0, 7, 4.4, 0], ['l', 4.4, 0, 4.4, 7]] },
  X: { w: 4.6, s: [['l', 0, 0, 4.6, 7], ['l', 0, 7, 4.6, 0]] },
  T: { w: 4.6, s: [['l', 0, 7, 4.6, 7], ['l', 2.3, 7, 2.3, 0]] },
  d: { w: 3.8, s: [['a', 1.75, 2.25, 1.75, 2.25, 0, TAU], ['l', 3.5, 0, 3.5, 7]] },
  e: { w: 3.8, s: [['l', 0.05, 2.25, 3.5, 2.25], ['a', 1.75, 2.25, 1.75, 2.25, 0, TAU - 0.75]] },
  v: { w: 3.8, s: [['l', 0, 4.5, 1.9, 0], ['l', 1.9, 0, 3.8, 4.5]] },
  '.': { w: 1.2, s: [['a', 0.6, 0.6, 0.6, 0.6, 0, TAU]] },
  ' ': { w: 2.5, s: [] },
};
const GAP = 1.5;

/** Dots in glyph units: [x, y, nx, ny] along every stroke of the text. */
function strokeDots(text, step) {
  const out = [];
  let pen = 0;
  for (const ch of text) {
    const g = FONT[ch];
    if (!g) throw new Error(`no glyph for "${ch}"`);
    for (const st of g.s) {
      if (st[0] === 'l') {
        const [, x0, y0, x1, y1] = st;
        const len = Math.hypot(x1 - x0, y1 - y0);
        const nx = -(y1 - y0) / len, ny = (x1 - x0) / len;
        const m = Math.max(1, Math.round(len / step));
        for (let k = 0; k <= m; k++) out.push([pen + x0 + ((x1 - x0) * k) / m, y0 + ((y1 - y0) * k) / m, nx, ny]);
      } else {
        const [, cx, cy, rx, ry, a0, a1] = st;
        const len = Math.abs(a1 - a0) * (rx + ry) / 2;
        const m = Math.max(3, Math.round(len / step));
        for (let k = 0; k <= m; k++) {
          const a = a0 + ((a1 - a0) * k) / m;
          const c = Math.cos(a), s = Math.sin(a);
          const nl = Math.hypot(c * ry, s * rx) || 1;
          out.push([pen + cx + c * rx, cy + s * ry, (c * ry) / nl, (s * rx) / nl]);
        }
      }
    }
    pen += g.w + GAP;
  }
  return { dots: out, width: pen - GAP };
}

/**
 * @param {object} o
 * @param {string} o.text
 * @param {number[]} o.center   [x, y, z] of the middle of the text
 * @param {number[]} o.facing   [x, z]: the point the text faces (horizontal)
 * @param {number} [o.height]   capital height, world units
 * @param {number} [o.stroke]   stroke width, world units
 * @param {number} [o.spacing]  between drones
 * @param {number[][]} [o.colors] left and right colour of the gradient, rgb 0-1
 * @param {number} [o.seed]
 */
export function createTextFormation(o) {
  const H = o.height ?? 120;
  const unit = H / 7;
  const spacing = o.spacing ?? 3.2;
  const stroke = o.stroke ?? H * 0.11;
  const rnd = mulberry32(o.seed ?? 3);
  const [c0, c1] = o.colors ?? [[0.23, 0.51, 0.96], [0.55, 0.78, 1.0]];   // #3b82f6 to light blue

  // Dots across the stroke, then de-duplicated where strokes meet.
  const { dots, width } = strokeDots(o.text, spacing / unit);
  const rows = Math.max(1, Math.round(stroke / spacing));
  const raw = [];
  for (const [x, y, nx, ny] of dots) {
    for (let r = 0; r < rows; r++) {
      const off = rows === 1 ? 0 : ((r / (rows - 1)) - 0.5) * stroke;
      raw.push([x * unit + nx * off, y * unit + ny * off]);
    }
  }
  const min = spacing * 0.6;
  const cell = new Map();
  const slots = [];
  for (const [x, y] of raw) {
    const gx = Math.floor(x / min), gy = Math.floor(y / min);
    let clash = false;
    for (let a = -1; a <= 1 && !clash; a++) {
      for (let b = -1; b <= 1 && !clash; b++) {
        for (const q of cell.get(`${gx + a},${gy + b}`) ?? []) {
          if (Math.hypot(q[0] - x, q[1] - y) < min) { clash = true; break; }
        }
      }
    }
    if (clash) continue;
    const key = `${gx},${gy}`;
    if (!cell.has(key)) cell.set(key, []);
    const sl = [x, y, rnd() * TAU, 1.5 + rnd() * 2.5];
    cell.get(key).push(sl);
    slots.push(sl);
  }

  // The plane of the text: facing the given point, upright.
  const W = width * unit;
  const [cx, cy, cz] = o.center;
  let fx = o.facing[0] - cx, fz = o.facing[1] - cz;
  const fl = Math.hypot(fx, fz) || 1;
  fx /= fl; fz /= fl;
  // Seen from the facing point, +x of the text runs to the viewer's right:
  // the viewer looks along -f, and right is (-f) x up = (fz, 0, -fx).
  const rx = fz, rz = -fx;

  const n = slots.length;
  const pos = new Float32Array(n * 3), vel = new Float32Array(n * 3), col = new Float32Array(n * 3);
  const prev = new Float32Array(n * 3);
  let lastTime = null;

  function update(time) {
    const h = lastTime === null ? 0 : time - lastTime;
    prev.set(pos);
    const cyc = time % 9;
    const sweep = cyc < 2.5 ? (cyc / 2.5) * (W + 160) - 80 : -1e9;
    for (let i = 0; i < n; i++) {
      const [x, y, ph, sp] = slots[i];
      const lx = x - W / 2;
      // A slow breath: the text sways a little in and out, as a wave.
      const depth = Math.sin(time * 0.7 + lx * 0.012) * 6;
      const bob = Math.sin(time * 0.5 + lx * 0.006) * 4;
      const o3 = i * 3;
      pos[o3] = cx + rx * lx + fx * depth;
      pos[o3 + 1] = cy + (y - H / 2) + bob;
      pos[o3 + 2] = cz + rz * lx + fz * depth;
      for (let c = 0; c < 3; c++) vel[o3 + c] = h > 0 && h < 0.5 ? (pos[o3 + c] - prev[o3 + c]) / h : 0;
      const t = W > 0 ? x / W : 0;
      let b = 0.85 + 0.15 * Math.sin(ph + time * sp);
      b += 0.8 * Math.exp(-(((x - sweep) / 30) ** 2));
      col[o3] = Math.min(1, (c0[0] + (c1[0] - c0[0]) * t) * b);
      col[o3 + 1] = Math.min(1, (c0[1] + (c1[1] - c0[1]) * t) * b);
      col[o3 + 2] = Math.min(1, (c0[2] + (c1[2] - c0[2]) * t) * b);
    }
    lastTime = time;
  }
  update(0);

  return { count: n, pos, vel, col, update, width: W, height: H };
}
