// The city on City Towers: a street grid with two-lane roads and traffic,
// buildings with windows, a business district of glass towers round a
// pedestrian axis, and La Grande Arche at the end of it to fly through.
//
// The layout is data in levels.js. The route is threaded down the streets the
// layout leaves open (see buildCityRoute in rings.js), so this module never
// needs to know where the gates are — only which streets the route uses, so
// it can line them with tall buildings.
//
// Everything solid is registered as a collider, including the trees: the
// whole point of the level is flying close to things.

import * as THREE from 'three';

const MARGIN = 8;   // roughly the plane's half-span at the fuselage
const CELL = 80;    // collision grid
const SLACK = 24;   // colliders are indexed this far beyond their footprint

const lerp = (a, b, t) => a + (b - a) * t;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Facade styles, read by the window shader.
const STYLE = { stone: 0, ribbon: 1, curtain: 2, grid: 3, haussmann: 4 };

const STONE = [0xddd2ba, 0xe4d9c3, 0xd2c6ab, 0xc9bea6, 0xd9cbb0, 0xe8e0cf];
const CONCRETE = [0xa9adb1, 0x9d9892, 0xb8b2a6, 0x8f969c, 0xc4c1b8, 0xb0a594];
const MULLION = [0x6f7c88, 0x56626e, 0x8a949c, 0x434d57, 0x9aa3aa, 0x5c5248];
const GLASS = [0x5d7f9e, 0x46667c, 0x6b8fae, 0x3f6170, 0x5f8f8a, 0x7b6f5d, 0x4a5f7a, 0x7d95a8];
const SLATE = [0x56606b, 0x4d5560, 0x5f6670, 0x4a525c];
const CARS = [0xc0392b, 0xecf0f1, 0x2c3e50, 0x7f8c8d, 0x2980b9, 0xf1c40f, 0x1c1c1c, 0x8e44ad,
  0xd35400, 0xbdc3c7, 0x16a085, 0x34495e];

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * Streets and blocks, from the level spec. Streets are [centre, width, kind]
 * where width is facade to facade — the gap you actually fly down.
 */
export function cityLayout(spec) {
  const b = spec.bounds;
  const mk = (list, along) => list.map(([at, width, kind]) => ({
    along, at, width, kind: kind ?? 'road',
  }));
  // streetsX are constant-x streets running north-south (along z), and so on.
  const ns = mk(spec.streetsX, 'z');
  const ew = mk(spec.streetsZ, 'x');

  const spans = (streets, lo, hi) => {
    const out = [];
    let start = lo;
    for (const s of [...streets].sort((p, q) => p.at - q.at)) {
      if (s.at - s.width / 2 > start + 1) out.push([start, s.at - s.width / 2]);
      start = s.at + s.width / 2;
    }
    if (hi > start + 1) out.push([start, hi]);
    return out;
  };

  const blocks = [];
  for (const [x0, x1] of spans(ns, b.x0, b.x1)) {
    for (const [z0, z1] of spans(ew, b.z0, b.z1)) blocks.push({ x0, x1, z0, z1 });
  }
  return { bounds: b, ns, ew, blocks };
}

/** Distance from a point to the segment ab, in the XZ plane. */
function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2)) : 0;
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

/** Distance from a rectangle to the polyline, sampled along the polyline. */
function rectToPath(r, path) {
  let best = Infinity;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], c = path[i + 1];
    const n = Math.max(2, Math.ceil(Math.hypot(c.x - a.x, c.z - a.z) / 15));
    for (let k = 0; k <= n; k++) {
      const x = lerp(a.x, c.x, k / n), z = lerp(a.z, c.z, k / n);
      const dx = Math.max(r.x0 - x, 0, x - r.x1);
      const dz = Math.max(r.z0 - z, 0, z - r.z1);
      best = Math.min(best, Math.hypot(dx, dz));
    }
  }
  return best;
}

const overlaps = (a, b, pad = 0) =>
  a.x0 < b.x1 + pad && a.x1 > b.x0 - pad && a.z0 < b.z1 + pad && a.z1 > b.z0 - pad;

// ---------------------------------------------------------------------------
// The window shader
// ---------------------------------------------------------------------------
//
// Windows are drawn in the fragment shader from the position on the facade,
// not from a texture and not from geometry: no assets, one draw call for every
// building, and the grid lines up with each building's own edges because it is
// computed in the instance's local space, scaled back to world units. Far away
// the grid fades to its average colour instead of shimmering.

// The per-building values are `flat`: interpolating a constant across a
// triangle does not quite give the constant back, and the window hash turns
// that last-bit noise into stripes.
const FACADE_VERT_PARS = /* glsl */`
attribute vec4 aStyle;   // style, floor height, bay width, seed
attribute vec3 aGlass;
varying vec3 vBox;       // local position in world units, y from the base
flat varying vec3 vBoxN;
flat varying vec3 vSize;
flat varying vec4 vStyle;
flat varying vec3 vGlass;
`;

const FACADE_VERT = /* glsl */`
vec3 boxSize = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
vSize = boxSize;
vBox = vec3(position.x * boxSize.x, (position.y + 0.5) * boxSize.y, position.z * boxSize.z);
vBoxN = normal;
vStyle = aStyle;
vGlass = aGlass;
`;

const FACADE_FRAG_PARS = /* glsl */`
varying vec3 vBox;
flat varying vec3 vBoxN;
flat varying vec3 vSize;
flat varying vec4 vStyle;
flat varying vec3 vGlass;
float facadeHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float band(float lo, float hi, float f, float w) {
  return smoothstep(lo - w, lo + w, f) * (1.0 - smoothstep(hi - w, hi + w, f));
}
`;

const FACADE_FRAG = /* glsl */`
vec3 facadeGlow = vec3(0.0);
if (abs(vBoxN.y) < 0.5) {
  int st = int(vStyle.x + 0.5);
  float fh = vStyle.y;
  float bw = vStyle.z;
  float seed = vStyle.w;
#ifdef FACADE_CYLINDER
  float fw = 3.14159265 * vSize.x;
  float u = atan(vBox.z, vBox.x) / 6.2831853 * fw;
  float side = 0.0;
#else
  bool xFace = abs(vBoxN.x) > 0.5;
  float fw = xFace ? vSize.z : vSize.x;
  float u = xFace ? vBox.z : vBox.x;
  float side = xFace ? (vBoxN.x > 0.0 ? 1.0 : 2.0) : (vBoxN.z > 0.0 ? 3.0 : 4.0);
#endif
  float bays = max(1.0, floor(fw / bw + 0.5));
  float bay = fw / bays;
  float groundH = fh * 1.45;
  vec2 cell = vec2((u + 0.5 * fw) / bay, (vBox.y - groundH) / fh);
  vec2 id = floor(cell);
  vec2 f = fract(cell);

  vec2 lo = vec2(0.3, 0.22), hi = vec2(0.7, 0.86);         // punched stone
  if (st == 1) { lo = vec2(-0.2, 0.36); hi = vec2(1.2, 0.86); }   // ribbon
  else if (st == 2) { lo = vec2(0.05, 0.1); hi = vec2(0.95, 0.95); } // curtain wall
  else if (st == 3) { lo = vec2(0.13, 0.13); hi = vec2(0.87, 0.87); } // square grid
  else if (st == 4) { lo = vec2(0.32, 0.12); hi = vec2(0.68, 0.9); }  // tall French windows

  vec2 w = fwidth(cell) * 0.75 + 1e-4;
  float mask = band(lo.x, hi.x, f.x, w.x) * band(lo.y, hi.y, f.y, w.y);
  float cover = clamp(min(hi.x, 1.0) - max(lo.x, 0.0), 0.0, 1.0) * (hi.y - lo.y);
  float far = smoothstep(0.22, 0.65, max(w.x, w.y));
  mask = mix(mask, cover, far);

  // Haussmann balconies: a dark wrought-iron line along the second and fifth floors.
  float rail = 0.0;
  if (st == 4 && (id.y == 1.0 || id.y == 4.0)) rail = band(0.04, 0.16, f.y, w.y) * (1.0 - far);

  // Ground floor is shopfronts, the parapet has no windows.
  float body = step(groundH, vBox.y) * step(vBox.y, vSize.y - fh * 0.55);
  float shopCell = fract((u + 0.5 * fw) / max(bay * 2.0, 8.0));
  float shop = step(1.4, vBox.y) * step(vBox.y, groundH - 1.2)
    * band(0.06, 0.94, shopCell, fwidth(shopCell) + 1e-4);
  if (st == 3) shop = 0.0;
  mask = mask * body + shop * (1.0 - step(groundH, vBox.y)) * 0.9;

  float r = facadeHash(id + vec2(seed * 17.0 + side * 131.0, seed * 3.1 + side * 7.0));
  vec3 glass = vGlass * (0.72 + 0.56 * r);
  // Higher floors see more sky.
  glass = mix(glass, vec3(0.66, 0.75, 0.84), 0.4 * smoothstep(0.0, 450.0, vBox.y) * (0.4 + 0.6 * r));

  vec3 wall = diffuseColor.rgb;
  diffuseColor.rgb = mix(wall, glass, mask);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.13, 0.14, 0.16), rail);

  float lit = step(0.972, facadeHash(id * 1.37 + vec2(seed + side * 5.0, 2.0))) * mask * body * (1.0 - far);
  facadeGlow = glass * 0.16 * mask + vec3(1.0, 0.84, 0.58) * lit * 0.3;

  // A soft contact shadow at the foot of every wall grounds the buildings.
  diffuseColor.rgb *= mix(0.55, 1.0, smoothstep(0.0, 18.0, vBox.y));
} else {
  diffuseColor.rgb *= 0.8;   // roofs: gravel and tar, a shade darker than the walls
}
`;

function facadeMaterial(cylinder) {
  const mat = new THREE.MeshLambertMaterial({ flatShading: true });
  if (cylinder) mat.defines = { FACADE_CYLINDER: '' };
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${FACADE_VERT_PARS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${FACADE_VERT}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FACADE_FRAG_PARS}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${FACADE_FRAG}`)
      .replace('#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\ntotalEmissiveRadiance += facadeGlow;');
  };
  // Both variants compile to different programs; keep them from sharing a cache key.
  mat.customProgramCacheKey = () => (cylinder ? 'facade-cyl' : 'facade-box');
  return mat;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** A mansard: steep slate sides rising to a flat top, base 1x1, height 1. */
function mansardGeometry() {
  const t = 0.34;   // half-size of the flat top
  const v = [
    [-0.5, 0, -0.5], [0.5, 0, -0.5], [0.5, 0, 0.5], [-0.5, 0, 0.5],
    [-t, 1, -t], [t, 1, -t], [t, 1, t], [-t, 1, t],
  ];
  const faces = [
    [0, 4, 5, 1], [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 4, 0], [4, 7, 6, 5],
  ];
  const pos = [];
  for (const [a, b, c, d] of faces) {
    for (const i of [a, b, c, a, c, d]) pos.push(...v[i]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** Collects flat, upward-facing coloured quads into one mesh. */
class FlatBatch {
  constructor() { this.pos = []; this.col = []; }

  rect(x0, z0, x1, z1, y, color) {
    const c = new THREE.Color(color);
    // Wound to face up.
    const quad = [[x0, z0], [x0, z1], [x1, z1], [x0, z0], [x1, z1], [x1, z0]];
    for (const [x, z] of quad) {
      this.pos.push(x, y, z);
      this.col.push(c.r, c.g, c.b);
    }
  }

  mesh(offset) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({
      vertexColors: true,
      // Layers of paint on tarmac on paving: offset rather than lifted, so
      // they do not separate when seen from a long way off.
      polygonOffset: true, polygonOffsetFactor: -offset, polygonOffsetUnits: -offset * 2,
    }));
    m.matrixAutoUpdate = false;
    return m;
  }
}

// ---------------------------------------------------------------------------
// The city
// ---------------------------------------------------------------------------

/**
 * @param {object} cfg level config with cfg.city
 * @returns {object|null}
 */
export function createCity(cfg) {
  const spec = cfg.city;
  if (!spec) return null;

  const rnd = mulberry32(cfg.seed ^ 0xc17a);
  const pick = (list) => list[(rnd() * list.length) | 0];
  const G = spec.ground;
  const layout = cityLayout(spec);
  const group = new THREE.Group();

  // ---- colliders ----------------------------------------------------------
  const colliders = [];
  const grid = new Map();
  const solid = (c) => {
    colliders.push(c);
    const x0 = Math.floor((c.x0 - SLACK) / CELL), x1 = Math.floor((c.x1 + SLACK) / CELL);
    const z0 = Math.floor((c.z0 - SLACK) / CELL), z1 = Math.floor((c.z1 + SLACK) / CELL);
    for (let gx = x0; gx <= x1; gx++) {
      for (let gz = z0; gz <= z1; gz++) {
        const k = `${gx},${gz}`;
        let list = grid.get(k);
        if (!list) grid.set(k, (list = []));
        list.push(c);
      }
    }
  };

  // ---- instance buffers ---------------------------------------------------
  const facades = [];     // box buildings with windows
  const cylinders = [];   // round towers with windows
  const plain = [];       // roof plant, podium steps, sculptures — no windows
  const mansards = [];
  const color = new THREE.Color();

  /**
   * A box with windows. y0 is the base, h the height; snapped to whole floors
   * so a stack of tiers keeps its floor lines.
   */
  function facadeBox(r, y0, h, s) {
    facades.push({ ...r, y0, h, ...s });
    solid({ x0: r.x0, x1: r.x1, z0: r.z0, z1: r.z1, y0, y1: y0 + h });
  }

  function cylinderTower(cx, cz, radius, y0, h, s) {
    cylinders.push({ cx, cz, radius, y0, h, ...s });
    solid({ x0: cx - radius, x1: cx + radius, z0: cz - radius, z1: cz + radius, y0, y1: y0 + h, round: true, cx, cz, radius });
  }

  function plainBox(r, y0, h, c) {
    plain.push({ ...r, y0, h, color: c });
    solid({ x0: r.x0, x1: r.x1, z0: r.z0, z1: r.z1, y0, y1: y0 + h });
  }

  const inset = (r, d) => ({ x0: r.x0 + d, x1: r.x1 - d, z0: r.z0 + d, z1: r.z1 - d });
  const floors = (h, fh) => Math.max(1, Math.round(h / fh)) * fh;

  // Reserved ground: landmarks are placed explicitly and nothing else may
  // build into them.
  const reserved = [];

  // ---- landmarks ----------------------------------------------------------

  // La Grande Arche: a hollow cube on a podium, flown straight through.
  const A = spec.arche;
  const arch = {
    x0: A.x - A.width / 2, x1: A.x + A.width / 2,
    z0: A.z - A.depth / 2, z1: A.z + A.depth / 2,
  };
  reserved.push(arch);
  {
    const marble = { style: STYLE.grid, fh: 7, bw: 7, wall: 0xf1f2ef, glass: 0x8ea3b4 };
    const pillar = (A.width - A.opening) / 2;
    const yb = G + A.base;
    const top = G + A.height;
    // The base slab is the floor of the opening; the steps lead up to it.
    plainBox(arch, G, A.base, 0xe4e1d8);
    facadeBox({ ...arch, x1: arch.x0 + pillar }, yb, top - yb, { ...marble, seed: 1 });
    facadeBox({ ...arch, x0: arch.x1 - pillar }, yb, top - yb, { ...marble, seed: 2 });
    facadeBox({ ...arch, x0: arch.x0 + pillar, x1: arch.x1 - pillar }, top - A.roof, A.roof, { ...marble, seed: 3 });
    // Steps up to the podium on the city side, wide and shallow.
    for (let k = 0; k < A.steps; k++) {
      const out = A.stepDepth * (A.steps - k);
      plainBox(
        { x0: arch.x0 + 6, x1: arch.x1 - 6, z0: arch.z1, z1: arch.z1 + out },
        G, (A.base * (k + 1)) / (A.steps + 1), 0xd9d5ca,
      );
    }
  }

  // Explicit towers: the pairs the skybridges hang between.
  for (const t of spec.towers ?? []) {
    reserved.push(t);
    const s = {
      style: t.style ?? STYLE.curtain, fh: 6, bw: 9,
      wall: t.wall ?? pick(MULLION), glass: t.glass ?? pick(GLASS), seed: rnd() * 100,
    };
    const h = floors(t.h, s.fh);
    facadeBox(t, G, h, s);
    roofPlant(t, G + h, s);
  }

  for (const b of spec.bridges ?? []) {
    facadeBox(b, G + b.y0, b.h, {
      style: STYLE.curtain, fh: b.h / 2, bw: 6, wall: 0x59646f, glass: 0x7f9fb8, seed: rnd() * 100,
    });
  }

  for (const m of spec.monoliths ?? []) {
    const r = { x0: m.x - m.w / 2, x1: m.x + m.w / 2, z0: m.z - m.w / 2, z1: m.z + m.w / 2 };
    plainBox(r, G, m.h, m.color);
    plainBox(inset(r, -3), G, 3, 0x8b8a86);   // plinth
  }

  // ---- ordinary blocks ----------------------------------------------------

  const routePath = spec.route.path.map(([x, z]) => ({ x, z }));
  const parks = (spec.parks ?? []).map(([x, z]) => ({ x, z }));
  const D = spec.district;   // the business district round the axis

  function roofPlant(r, top, s) {
    const w = r.x1 - r.x0, d = r.z1 - r.z0;
    // A plant room, maybe a water tank, maybe a mast — tall buildings get the mast.
    const pw = w * (0.3 + rnd() * 0.25), pd = d * (0.3 + rnd() * 0.25);
    const px = lerp(r.x0 + pw / 2 + 4, r.x1 - pw / 2 - 4, rnd());
    const pz = lerp(r.z0 + pd / 2 + 4, r.z1 - pd / 2 - 4, rnd());
    plainBox({ x0: px - pw / 2, x1: px + pw / 2, z0: pz - pd / 2, z1: pz + pd / 2 }, top, 5 + rnd() * 5, 0x8a8f94);
    if (top - G > 230 && rnd() < 0.55) {
      const mh = 25 + rnd() * 55;
      const mx = (r.x0 + r.x1) / 2, mz = (r.z0 + r.z1) / 2;
      plainBox({ x0: mx - 1.4, x1: mx + 1.4, z0: mz - 1.4, z1: mz + 1.4 }, top, mh, 0xd4d7da);
      plainBox({ x0: mx - 2, x1: mx + 2, z0: mz - 2, z1: mz + 2 }, top + mh, 3, 0xe23b2e);
    }
  }

  /** A glass tower: straight, stepped back in tiers, or round. */
  function tower(r, h) {
    const s = {
      style: rnd() < 0.8 ? STYLE.curtain : STYLE.ribbon,
      fh: 6, bw: 7 + rnd() * 5, wall: pick(MULLION), glass: pick(GLASS), seed: rnd() * 100,
    };
    const w = r.x1 - r.x0, d = r.z1 - r.z0;
    const kind = rnd();

    if (kind < 0.18 && Math.min(w, d) > 70) {
      // Round tower on a podium.
      const podium = floors(18 + rnd() * 12, 6);
      facadeBox(r, G, podium, { ...s, style: STYLE.stone, wall: pick(CONCRETE) });
      const rad = Math.min(w, d) / 2 - 6;
      cylinderTower((r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2, rad, G + podium, floors(h - podium, 6), s);
      return;
    }

    if (kind < 0.6) {
      // Setbacks: two or three tiers, each narrower.
      const tiers = 2 + (rnd() < 0.5 ? 1 : 0);
      let y = G, cur = r, left = floors(h, 6);
      for (let k = 0; k < tiers; k++) {
        const th = k === tiers - 1 ? left : floors(left * (0.45 + rnd() * 0.2), 6);
        facadeBox(cur, y, th, s);
        y += th;
        left -= th;
        const shrink = Math.min(cur.x1 - cur.x0, cur.z1 - cur.z0) * (0.1 + rnd() * 0.07);
        if (k < tiers - 1) cur = inset(cur, shrink);
      }
      roofPlant(cur, y, s);
      return;
    }

    const hh = floors(h, 6);
    facadeBox(r, G, hh, s);
    roofPlant(r, G + hh, s);
  }

  /** Offices and apartments: a mid-rise box, sometimes with a setback crown. */
  function office(r, h) {
    const kind = rnd();
    const s = kind < 0.4
      ? { style: STYLE.ribbon, fh: 5.5, bw: 8, wall: pick(CONCRETE), glass: pick(GLASS), seed: rnd() * 100 }
      : kind < 0.75
        ? { style: STYLE.stone, fh: 5.5, bw: 5 + rnd() * 2, wall: pick(rnd() < 0.5 ? STONE : CONCRETE), glass: 0x4e5d6a, seed: rnd() * 100 }
        : { style: STYLE.curtain, fh: 5.5, bw: 6 + rnd() * 4, wall: pick(MULLION), glass: pick(GLASS), seed: rnd() * 100 };
    const hh = floors(h, s.fh);
    if (hh > 120 && rnd() < 0.45) {
      const lower = floors(hh * 0.72, s.fh);
      facadeBox(r, G, lower, s);
      const crown = inset(r, Math.min(r.x1 - r.x0, r.z1 - r.z0) * 0.14);
      facadeBox(crown, G + lower, hh - lower, s);
      roofPlant(crown, G + hh, s);
    } else {
      facadeBox(r, G, hh, s);
      roofPlant(r, G + hh, s);
    }
  }

  /** Haussmann: limestone, six floors, a slate mansard and chimneys. */
  function haussmann(r, hBoost = 0) {
    const s = { style: STYLE.haussmann, fh: 5.2, bw: 6.5, wall: pick(STONE), glass: 0x3f4b57, seed: rnd() * 100 };
    const hh = floors(36 + rnd() * 6 + hBoost, s.fh) + 2.4;
    facadeBox(r, G, hh, s);
    const roofH = 8 + rnd() * 2;
    mansards.push({ ...r, y0: G + hh, h: roofH, color: pick(SLATE) });
    solid({ ...r, y0: G + hh, y1: G + hh + roofH });
    // Chimney stacks along the ridge.
    const along = (r.x1 - r.x0) > (r.z1 - r.z0);
    const n = Math.max(1, Math.floor(((along ? r.x1 - r.x0 : r.z1 - r.z0)) / 16));
    for (let k = 0; k < n; k++) {
      if (rnd() < 0.35) continue;
      const t = (k + 0.5) / n;
      const cx = along ? lerp(r.x0, r.x1, t) : (r.x0 + r.x1) / 2 + (rnd() - 0.5) * 4;
      const cz = along ? (r.z0 + r.z1) / 2 + (rnd() - 0.5) * 4 : lerp(r.z0, r.z1, t);
      plainBox({ x0: cx - 1.6, x1: cx + 1.6, z0: cz - 1.1, z1: cz + 1.1 }, G + hh, roofH + 3, 0xb7a58c);
    }
  }

  /** A perimeter block round a courtyard, split into separate buildings. */
  function perimeterBlock(r) {
    const w = r.x1 - r.x0, d = r.z1 - r.z0;
    const depth = 20;
    if (w < depth * 2 + 18 || d < depth * 2 + 18) {
      splitAlong(r, 26, 44).forEach((p) => haussmann(p));
      return;
    }
    const strips = [
      { x0: r.x0, x1: r.x1, z0: r.z0, z1: r.z0 + depth },
      { x0: r.x0, x1: r.x1, z0: r.z1 - depth, z1: r.z1 },
      { x0: r.x0, x1: r.x0 + depth, z0: r.z0 + depth, z1: r.z1 - depth },
      { x0: r.x1 - depth, x1: r.x1, z0: r.z0 + depth, z1: r.z1 - depth },
    ];
    for (const s of strips) splitAlong(s, 26, 44).forEach((p) => haussmann(p, rnd() < 0.15 ? 5 : 0));
  }

  /** Cuts a rectangle along its long side into pieces between min and max long. */
  function splitAlong(r, min, max) {
    const alongX = (r.x1 - r.x0) >= (r.z1 - r.z0);
    const len = alongX ? r.x1 - r.x0 : r.z1 - r.z0;
    const out = [];
    let at = 0;
    while (at < len - 1) {
      let piece = min + rnd() * (max - min);
      if (len - at - piece < min) piece = len - at;
      const a = at, c = Math.min(len, at + piece);
      out.push(alongX
        ? { x0: r.x0 + a, x1: r.x0 + c, z0: r.z0, z1: r.z1 }
        : { x0: r.x0, x1: r.x1, z0: r.z0 + a, z1: r.z0 + c });
      at = c;
    }
    return out;
  }

  /** Splits a block into n lots along its long side, with alleys between. */
  function lots(r, n, alley) {
    const alongX = (r.x1 - r.x0) >= (r.z1 - r.z0);
    const len = alongX ? r.x1 - r.x0 : r.z1 - r.z0;
    const each = (len - alley * (n - 1)) / n;
    const out = [];
    for (let k = 0; k < n; k++) {
      const a = k * (each + alley), c = a + each;
      out.push(alongX
        ? { x0: r.x0 + a, x1: r.x0 + c, z0: r.z0, z1: r.z1 }
        : { x0: r.x0, x1: r.x1, z0: r.z0 + a, z1: r.z0 + c });
    }
    return out;
  }

  const treeList = [];
  const parkRects = [];

  for (const block of layout.blocks) {
    const cx = (block.x0 + block.x1) / 2, cz = (block.z0 + block.z1) / 2;
    const w = block.x1 - block.x0, d = block.z1 - block.z0;
    // Facades stand back from the block edge; the gap is pavement.
    const lot = inset(block, 3);

    if (parks.some((p) => p.x > block.x0 && p.x < block.x1 && p.z > block.z0 && p.z < block.z1)) {
      park(block);
      continue;
    }

    const onRoute = rectToPath(block, routePath) < 75;
    const inDistrict = Math.abs(cx) < D.halfWidth && cz < D.zMax;

    // Keep clear of the landmarks: cut a lot back to whichever side of the
    // landmark leaves the most of it, or drop it if what is left is a sliver.
    const free = (r) => {
      let cur = r;
      for (const q of reserved) {
        if (!cur || !overlaps(cur, q, 14)) continue;
        const options = [
          { ...cur, x0: q.x1 + 14 }, { ...cur, x1: q.x0 - 14 },
          { ...cur, z0: q.z1 + 14 }, { ...cur, z1: q.z0 - 14 },
        ].filter((o) => o.x1 - o.x0 > 40 && o.z1 - o.z0 > 40);
        cur = options.sort((a, c) => (c.x1 - c.x0) * (c.z1 - c.z0) - (a.x1 - a.x0) * (a.z1 - a.z0))[0] ?? null;
      }
      return cur;
    };

    if (inDistrict) {
      // One or two towers per block, the tallest nearest the axis.
      const near = 1 - Math.min(1, Math.abs(cx) / D.halfWidth);
      const n = Math.max(w, d) > 150 ? 2 : 1;
      for (const lotR of lots(inset(block, 8), n, 18)) {
        const r = free(lotR);
        if (!r) continue;
        tower(r, lerp(D.minH, D.maxH, Math.min(1, near * 0.7 + rnd() * 0.5)));
      }
      continue;
    }

    if (onRoute) {
      // Streets the route uses are lined with tall buildings, so they read as
      // canyons and not as a road between bungalows.
      const n = Math.max(1, Math.round(Math.max(w, d) / 70));
      for (const lotR of lots(lot, n, 8)) {
        const r = free(lotR);
        if (!r) continue;
        const h = spec.routeMinH + rnd() * (spec.routeMaxH - spec.routeMinH);
        if (rnd() < 0.25 && h > 200) tower(r, h); else office(r, h);
      }
      continue;
    }

    // Everywhere else: Paris. Perimeter blocks, with the odd modern intruder.
    const open = free(lot);
    if (!open) continue;
    if (rnd() < 0.14) {
      const n = Math.max(1, Math.round(Math.max(w, d) / 75));
      for (const r of lots(open, n, 10)) office(r, 70 + rnd() * 90);
    } else {
      perimeterBlock(open);
    }
  }

  function park(block) {
    parkRects.push(block);
    for (let k = 0; k < (block.x1 - block.x0) * (block.z1 - block.z0) / 900; k++) {
      const x = lerp(block.x0 + 8, block.x1 - 8, rnd());
      const z = lerp(block.z0 + 8, block.z1 - 8, rnd());
      treeList.push({ x, z, r: 5 + rnd() * 3 });
    }
  }
  // ---- ground: paving, roads, markings -----------------------------------
  const paving = new FlatBatch();
  const roads = new FlatBatch();
  const paint = new FlatBatch();
  const b = layout.bounds;
  const yPave = G + 0.25, yRoad = G + 0.35, yPaint = G + 0.45;

  paving.rect(b.x0 - 30, b.z0 - 30, b.x1 + 30, b.z1 + 30, yPave, 0xa9a59c);
  for (const block of layout.blocks) paving.rect(block.x0, block.z0, block.x1, block.z1, yPave + 0.02, 0xbab5aa);
  for (const p of parkRects) paving.rect(p.x0 + 3, p.z0 + 3, p.x1 - 3, p.z1 - 3, yPave + 0.05, 0x6f9a55);

  const lanes = [];   // for the traffic
  const parkedSpots = [];
  const plazas = layout.ns.filter((s) => s.kind === 'plaza');
  const inPlaza = (x) => plazas.some((p) => Math.abs(x - p.at) < p.width / 2);

  // Intersections, so the dashes and the parked cars stop short of them.
  const crossings = (s) => (s.along === 'z' ? layout.ew : layout.ns)
    .map((o) => ({ at: o.at, half: o.width / 2, kind: o.kind }));

  for (const s of [...layout.ns, ...layout.ew]) {
    if (s.kind === 'plaza') continue;
    const lane = s.width >= 100 ? spec.laneWide : spec.laneNarrow;
    const half = lane;          // two lanes, one each way
    const lo = s.along === 'z' ? b.z0 : b.x0;
    const hi = s.along === 'z' ? b.z1 : b.x1;

    // East-west roads stop at the plaza and run under it, as at La Défense.
    let pieces = [[lo, hi]];
    if (s.along === 'x') {
      pieces = [];
      let start = lo;
      for (const p of plazas.sort((q, r2) => q.at - r2.at)) {
        pieces.push([start, p.at - p.width / 2]);
        start = p.at + p.width / 2;
      }
      pieces.push([start, hi]);
    }

    const R = (u0, v0, u1, v1, y, c, batch) => (s.along === 'z'
      ? batch.rect(s.at + v0, u0, s.at + v1, u1, y, c)
      : batch.rect(u0, s.at + v0, u1, s.at + v1, y, c));

    const cross = crossings(s);
    const nearCrossing = (u, pad) => cross.some((c) => Math.abs(u - c.at) < c.half + pad);

    for (const [u0, u1] of pieces) {
      R(u0, -half - 1.5, u1, half + 1.5, yRoad, 0x3c3f44, roads);
      // Edge lines.
      R(u0, -half - 0.2, u1, -half + 0.6, yPaint, 0xdedfd8, paint);
      R(u0, half - 0.6, u1, half + 0.2, yPaint, 0xdedfd8, paint);
      // Dashed centre line, broken at junctions.
      for (let u = u0 + 6; u < u1 - 6; u += 18) {
        if (nearCrossing(u + 5, 6)) continue;
        R(u, -0.45, u + 9, 0.45, yPaint, 0xf2f2ea, paint);
      }
      // Zebra crossings just outside every junction, and stop lines.
      for (const c of cross) {
        if (c.kind === 'plaza') continue;
        for (const side of [-1, 1]) {
          const edge = c.at + side * (c.half + 3);
          if (edge < u0 + 4 || edge > u1 - 4) continue;
          for (let v = -half + 1; v < half - 1; v += 3.4) {
            const a = side > 0 ? edge : edge - 7;
            R(a, v, a + 7, v + 1.7, yPaint, 0xf4f4ee, paint);
          }
        }
      }
      // Lanes for the traffic: drive on the right.
      const len = u1 - u0;
      lanes.push({ s, u0, u1, len, offset: lane / 2, dir: 1 });
      lanes.push({ s, u0, u1, len, offset: -lane / 2, dir: -1 });

      // Wide streets: parked cars along the kerb and a row of plane trees.
      if (s.width >= 100) {
        for (const side of [-1, 1]) {
          for (let u = u0 + 10; u < u1 - 10; u += 12) {
            if (nearCrossing(u, 14)) continue;
            if (rnd() < 0.72) parkedSpots.push({ s, u, v: side * (half + 4.2), dir: side });
          }
          const tv = side * (half + 13);
          for (let u = u0 + 8; u < u1 - 8; u += 17) {
            if (nearCrossing(u, 12)) continue;
            const p = s.along === 'z' ? { x: s.at + tv, z: u } : { x: u, z: s.at + tv };
            if (inPlaza(p.x)) continue;
            treeList.push({ ...p, r: 4.6 + rnd() * 1.6 });
          }
        }
      }
    }
  }

  // The axis: a paved esplanade with lawns, pools and two rows of trees.
  for (const p of plazas) {
    const x0 = p.at - p.width / 2, x1 = p.at + p.width / 2;
    paving.rect(x0, b.z0, x1, b.z1, yPave + 0.03, 0xd6d0c3);
    // Bands across the paving: on a plain slab there is nothing to tell you
    // how fast the ground is going by, or how close it is.
    // They stop at the lawns and the pools rather than painting over them.
    const pools = [];
    for (let z = b.z0 + 230; z < b.z1 - 60; z += 210) pools.push([z, z + 70]);
    const spans = [[x0 + 4, p.at - 85], [p.at - 67, p.at - 14], [p.at + 14, p.at + 67], [p.at + 85, x1 - 4]];
    for (let z = b.z0 + 6; z < b.z1 - 6; z += 22) {
      for (const [a, c] of spans) paint.rect(a, z, c, z + 7, yPaint - 0.05, 0xc4bcad);
      if (!pools.some(([z0, z1]) => z + 7 > z0 && z < z1)) {
        paint.rect(p.at - 14, z, p.at + 14, z + 7, yPaint - 0.05, 0xc4bcad);
      }
    }
    for (const side of [-1, 1]) {
      const lx = p.at + side * 76;
      roads.rect(lx - 9, b.z0 + 10, lx + 9, b.z1 - 10, yRoad, 0x6c9652);
      for (let z = b.z0 + 20; z < b.z1 - 20; z += 19) {
        if ((spec.monoliths ?? []).some((m) => Math.abs(m.z - z) < 30 && Math.sign(m.x) === side)) continue;
        treeList.push({ x: lx, z, r: 4.2 + rnd() * 1.2 });
      }
    }
    // Pools down the middle.
    for (const [z0, z1] of pools) roads.rect(p.at - 14, z0, p.at + 14, z1, yRoad, 0x4f8fb3);
  }

  const pave = paving.mesh(1);
  const roadMesh = roads.mesh(2);
  const paintMesh = paint.mesh(3);
  group.add(pave, roadMesh, paintMesh);

  // ---- instanced buildings -----------------------------------------------
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p3 = new THREE.Vector3();
  const s3 = new THREE.Vector3();

  function windowed(list, geo, cylinder) {
    if (!list.length) return;
    const mesh = new THREE.InstancedMesh(geo, facadeMaterial(cylinder), list.length);
    const style = new Float32Array(list.length * 4);
    const glass = new Float32Array(list.length * 3);
    list.forEach((f, i) => {
      if (cylinder) {
        p3.set(f.cx, f.y0 + f.h / 2, f.cz);
        s3.set(f.radius * 2, f.h, f.radius * 2);
      } else {
        p3.set((f.x0 + f.x1) / 2, f.y0 + f.h / 2, (f.z0 + f.z1) / 2);
        s3.set(f.x1 - f.x0, f.h, f.z1 - f.z0);
      }
      mesh.setMatrixAt(i, m4.compose(p3, q, s3));
      mesh.setColorAt(i, color.set(f.wall));
      style.set([f.style, f.fh, f.bw, Math.floor(f.seed ?? 0)], i * 4);
      color.set(f.glass);
      glass.set([color.r, color.g, color.b], i * 3);
    });
    geo.setAttribute('aStyle', new THREE.InstancedBufferAttribute(style, 4));
    geo.setAttribute('aGlass', new THREE.InstancedBufferAttribute(glass, 3));
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);
  }

  windowed(facades, new THREE.BoxGeometry(1, 1, 1), false);
  windowed(cylinders, new THREE.CylinderGeometry(0.5, 0.5, 1, 20), true);

  function simple(list, geo, base) {
    if (!list.length) return null;
    const mesh = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ flatShading: true }), list.length);
    list.forEach((f, i) => {
      p3.set((f.x0 + f.x1) / 2, base ? f.y0 : f.y0 + f.h / 2, (f.z0 + f.z1) / 2);
      s3.set(f.x1 - f.x0, f.h, f.z1 - f.z0);
      mesh.setMatrixAt(i, m4.compose(p3, q, s3));
      mesh.setColorAt(i, color.set(f.color));
    });
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);
    return mesh;
  }
  simple(plain, new THREE.BoxGeometry(1, 1, 1), false);
  simple(mansards, mansardGeometry(), true);

  // ---- trees --------------------------------------------------------------
  {
    const trunks = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.45, 0.6, 1, 5),
      new THREE.MeshLambertMaterial({ color: 0x6b5442, flatShading: true }),
      treeList.length,
    );
    const crowns = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(1, 0),
      new THREE.MeshLambertMaterial({ flatShading: true }),
      treeList.length,
    );
    treeList.forEach((t, i) => {
      const trunkH = 5 + t.r * 0.6;
      p3.set(t.x, G + trunkH / 2, t.z);
      s3.set(1, trunkH, 1);
      trunks.setMatrixAt(i, m4.compose(p3, q, s3));
      p3.set(t.x, G + trunkH + t.r * 0.7, t.z);
      s3.set(t.r, t.r * 1.15, t.r);
      crowns.setMatrixAt(i, m4.compose(p3, q, s3));
      color.setHSL(0.24 + rnd() * 0.08, 0.38 + rnd() * 0.15, 0.3 + rnd() * 0.1);
      crowns.setColorAt(i, color);
      const top = G + trunkH + t.r * 1.85;
      solid({ x0: t.x - t.r * 0.8, x1: t.x + t.r * 0.8, z0: t.z - t.r * 0.8, z1: t.z + t.r * 0.8, y0: G, y1: top });
    });
    trunks.instanceMatrix.needsUpdate = true;
    crowns.instanceMatrix.needsUpdate = true;
    group.add(trunks, crowns);
  }

  // ---- traffic ------------------------------------------------------------
  // Parked cars are placed once; moving cars run along their lane and wrap
  // round at the end, as if they had turned off.
  const carBody = new THREE.BoxGeometry(1, 1, 1);
  const carMat = new THREE.MeshLambertMaterial({ flatShading: true });
  const CAR = { len: 8.5, wid: 3.8, h: 2.2, cabLen: 4.6, cabWid: 3.3, cabH: 1.8 };

  const placeCar = (bodyMesh, cabMesh, i, x, z, alongZ) => {
    const sx = alongZ ? CAR.wid : CAR.len, sz = alongZ ? CAR.len : CAR.wid;
    p3.set(x, G + 0.4 + CAR.h / 2, z);
    s3.set(sx, CAR.h, sz);
    bodyMesh.setMatrixAt(i, m4.compose(p3, q, s3));
    p3.y = G + 0.4 + CAR.h + CAR.cabH / 2;
    s3.set(alongZ ? CAR.cabWid : CAR.cabLen, CAR.cabH, alongZ ? CAR.cabLen : CAR.cabWid);
    cabMesh.setMatrixAt(i, m4.compose(p3, q, s3));
  };

  const parkedBody = new THREE.InstancedMesh(carBody, carMat, Math.max(1, parkedSpots.length));
  const parkedCab = new THREE.InstancedMesh(carBody, carMat, Math.max(1, parkedSpots.length));
  parkedSpots.forEach((c, i) => {
    const alongZ = c.s.along === 'z';
    const x = alongZ ? c.s.at + c.v : c.u;
    const z = alongZ ? c.u : c.s.at + c.v;
    placeCar(parkedBody, parkedCab, i, x, z, alongZ);
    const col = pick(CARS);
    parkedBody.setColorAt(i, color.set(col));
    parkedCab.setColorAt(i, color.set(col).multiplyScalar(0.55));
  });
  parkedBody.count = parkedCab.count = parkedSpots.length;
  group.add(parkedBody, parkedCab);

  const cars = [];
  for (const lane of lanes) {
    const n = Math.floor(lane.len / spec.carGap);
    for (let k = 0; k < n; k++) {
      cars.push({ lane, t: (k + rnd() * 0.6) * spec.carGap, speed: 14 + rnd() * 10 });
    }
  }
  const movingBody = new THREE.InstancedMesh(carBody, carMat, Math.max(1, cars.length));
  const movingCab = new THREE.InstancedMesh(carBody, carMat, Math.max(1, cars.length));
  movingBody.count = movingCab.count = cars.length;
  cars.forEach((c, i) => {
    const col = pick(CARS);
    movingBody.setColorAt(i, color.set(col));
    movingCab.setColorAt(i, color.set(col).multiplyScalar(0.55));
  });
  // Frustum culling would use the bounds of the first frame's layout only.
  movingBody.frustumCulled = movingCab.frustumCulled = false;
  group.add(movingBody, movingCab);

  function moveCars(dt) {
    cars.forEach((c, i) => {
      const L = c.lane;
      c.t = (c.t + c.speed * dt) % L.len;
      const u = L.dir > 0 ? L.u0 + c.t : L.u1 - c.t;
      const alongZ = L.s.along === 'z';
      // Drive on the right: +u traffic keeps to the +v side on an x road,
      // and to the -v side on a z road (where +u points south).
      const v = alongZ ? -L.offset : L.offset;
      placeCar(movingBody, movingCab, i, alongZ ? L.s.at + v : u, alongZ ? u : L.s.at + v, alongZ);
    });
    movingBody.instanceMatrix.needsUpdate = true;
    movingCab.instanceMatrix.needsUpdate = true;
  }
  moveCars(0);

  // ---- queries ------------------------------------------------------------
  function collides(x, y, z, margin = MARGIN) {
    const list = grid.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`);
    if (!list) return false;
    for (const c of list) {
      if (y > c.y1 + margin || y < c.y0 - margin) continue;
      if (c.round) {
        if (Math.hypot(x - c.cx, z - c.cz) <= c.radius + margin) return true;
      } else if (x >= c.x0 - margin && x <= c.x1 + margin && z >= c.z0 - margin && z <= c.z1 + margin) {
        return true;
      }
    }
    return false;
  }

  /** Tallest roof within `reach` of the point — for tests and for tuning. */
  function skylineNear(x, z, reach) {
    let top = G;
    for (const c of colliders) {
      const dx = Math.max(c.x0 - x, 0, x - c.x1);
      const dz = Math.max(c.z0 - z, 0, z - c.z1);
      if (Math.hypot(dx, dz) <= reach) top = Math.max(top, c.y1);
    }
    return top;
  }

  return {
    group,
    layout,
    colliders,
    ground: G,
    arch: { ...A, y0: G + A.base, y1: G + A.height - A.roof, x0: A.x - A.opening / 2, x1: A.x + A.opening / 2 },
    collides,
    skylineNear,
    update: moveCars,
    stats: {
      buildings: facades.length + cylinders.length, trees: treeList.length,
      cars: cars.length, parked: parkedSpots.length, colliders: colliders.length,
    },
  };
}
