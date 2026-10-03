// Alpine Valley: snow-capped mountains, two glacial valleys with a river in
// each, a lake they both run into, and a summit between the valley heads with
// a pair of flag poles on top.
//
// Like the canyon, one object owns the shape. The terrain asks it for the
// height of the ground and the route asks it where the valleys are, so the
// valleys you see and the valleys you fly are the same. The props — rivers,
// forests, the village and the flags — are built from it afterwards.

import * as THREE from 'three';

const SAMPLES = 700;   // centreline resolution per valley
const CELL = 160;      // spatial grid for the distance query
const MARGIN = 8;      // the plane's half-span, as in the city

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
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

/** Piecewise-linear lookup in [[x, y], ...], clamped at both ends. */
function table(points, x) {
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i];
    if (x <= x1) {
      const [x0, y0] = points[i - 1];
      return lerp(y0, y1, smoothstep(0, 1, (x - x0) / (x1 - x0)));
    }
  }
  return points[points.length - 1][1];
}

/**
 * One valley: a smoothed centreline from the mouth (s = 0) to the head, with
 * a floor height, a floor width and a river line, all as functions of the
 * distance s along it.
 */
function makeValley(spec) {
  const curve = new THREE.CatmullRomCurve3(
    spec.points.map(([x, z]) => new THREE.Vector3(x, 0, z)), false, 'centripetal',
  );
  const pts = curve.getSpacedPoints(SAMPLES).map((v) => new THREE.Vector2(v.x, v.z));
  const arc = [0];
  for (let i = 1; i <= SAMPLES; i++) arc.push(arc[i - 1] + pts[i].distanceTo(pts[i - 1]));
  const length = arc[SAMPLES];

  // Tables are written as fractions of the length, so the shape can be edited
  // without recomputing distances by hand.
  const scale = (t) => t.map(([f, v]) => [f * length, v]);
  const floorT = scale(spec.floor);
  const widthT = scale(spec.halfWidth);
  const riverT = scale(spec.riverOffset);

  const at = (s) => {
    const f = clamp(s / length, 0, 1) * SAMPLES;
    const i = Math.min(SAMPLES - 1, Math.floor(f));
    const t = f - i;
    return new THREE.Vector2(lerp(pts[i].x, pts[i + 1].x, t), lerp(pts[i].y, pts[i + 1].y, t));
  };
  const dirAt = (s) => at(Math.min(length, s + 4)).sub(at(Math.max(0, s - 4))).normalize();
  const floorAt = (s) => table(floorT, s);
  const widthAt = (s) => table(widthT, s);

  /** Where the river runs: the centreline pushed sideways. */
  const riverAt = (s) => {
    const p = at(s), d = dirAt(s);
    const off = table(riverT, s) + Math.sin(s / 260) * spec.meander;
    return new THREE.Vector2(p.x - d.y * off, p.y + d.x * off);
  };

  // Spatial index, as in the canyon: heightAt runs for every mesh vertex.
  const reach = 1400;
  const grid = new Map();
  const key = (gx, gz) => `${gx},${gz}`;
  for (let i = 0; i < SAMPLES; i++) {
    const a = pts[i], b = pts[i + 1];
    for (let gx = Math.floor((Math.min(a.x, b.x) - reach) / CELL); gx <= Math.floor((Math.max(a.x, b.x) + reach) / CELL); gx++) {
      for (let gz = Math.floor((Math.min(a.y, b.y) - reach) / CELL); gz <= Math.floor((Math.max(a.y, b.y) + reach) / CELL); gz++) {
        const k = key(gx, gz);
        let list = grid.get(k);
        if (!list) grid.set(k, (list = []));
        list.push(i);
      }
    }
  }

  /** Nearest point on the centreline: distance and how far along it is. */
  function query(x, z) {
    const list = grid.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!list) return null;
    let best = Infinity, bi = 0, bt = 0;
    for (const i of list) {
      const a = pts[i], b = pts[i + 1];
      const dx = b.x - a.x, dz = b.y - a.y;
      const len2 = dx * dx + dz * dz;
      const t = len2 ? clamp(((x - a.x) * dx + (z - a.y) * dz) / len2, 0, 1) : 0;
      const d2 = (x - a.x - dx * t) ** 2 + (z - a.y - dz * t) ** 2;
      if (d2 < best) { best = d2; bi = i; bt = t; }
    }
    return { dist: Math.sqrt(best), s: lerp(arc[bi], arc[bi + 1], bt) };
  }

  return { spec, length, at, dirAt, floorAt, widthAt, riverAt, query };
}

/**
 * The shape of the level: mountains, valleys, lake and summit, as a height
 * function the terrain samples.
 */
export function createAlpineShape(cfg) {
  const spec = cfg.alps;
  if (!spec) return null;

  const valleys = spec.valleys.map(makeValley);
  const S = spec.summit;
  const L = spec.lake;
  const noise = makeNoise(cfg.seed ^ 0xa1b5);

  const fbm = (x, z, octaves, freq) => {
    let sum = 0, amp = 1, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += noise(x * freq, z * freq) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2.03;
    }
    return sum / norm;
  };
  // Sharp ridges rather than rounded hills: inverted, squared noise.
  const ridged = (x, z) => {
    let sum = 0, amp = 1, norm = 0, freq = 0.00085;
    for (let o = 0; o < 4; o++) {
      const n = 1 - Math.abs(noise(x * freq + 31.7 * o, z * freq - 17.3 * o));
      sum += n * n * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2.1;
    }
    return sum / norm;
  };

  /** U-shaped glacial profile: a flat floor, a curved toe, then steep walls. */
  const wall = (e) => (e < 160 ? (0.55 * e * e) / 160 : 88 + 1.3 * (e - 160));

  function heightAt(x, z) {
    // The mountains themselves.
    let h = spec.base + ridged(x, z) * spec.peaks + fbm(x + 500, z - 300, 4, 0.0032) * 70;

    // Higher still towards the edge of the map, so the range closes the
    // horizon instead of stopping at the edge of the mesh — in ridges, not as
    // one smooth ramp.
    const r = Math.hypot(x, z);
    h += smoothstep(spec.rimFrom, spec.rimTo, r) * spec.rimLift * (0.4 + ridged(x * 1.7, z * 1.7));

    // The summit: a clean cone with a small flat top, standing between the
    // heads of the two valleys.
    const ds = Math.hypot(x - S.x, z - S.z);
    const cone = S.top - S.slope * Math.max(0, ds - S.flat)
      + ridged(x * 3, z * 3) * 60 * smoothstep(S.flat, S.flat + 120, ds);
    if (ds < S.blendTo) h = lerp(cone, h, smoothstep(S.blendFrom, S.blendTo, ds));

    // Carve the valleys. Only ever lowers ground. The walls are ribbed and
    // the edge of the floor wanders, or they come out as smooth planes.
    const rib = fbm(x * 1.9 + 77, z * 1.9 - 41, 3, 0.004);
    for (const v of valleys) {
      const q = v.query(x, z);
      if (!q) continue;
      const e = Math.max(0, q.dist - v.widthAt(q.s) + rib * 70);
      h = Math.min(h, v.floorAt(q.s) + wall(e) * (1 + rib * 0.35));
    }

    // The heads of the valleys come close to the summit, and carving them
    // would bite into it. Restore the top.
    if (ds < S.blendFrom) {
      h = lerp(Math.max(h, cone), h, smoothstep(S.blendFrom * 0.45, S.blendFrom, ds));
    }

    // The lake both valleys run into.
    const ql = Math.hypot((x - L.x) / L.rx, (z - L.z) / L.rz);
    if (ql < 1.15) h = lerp(L.bed, h, smoothstep(0.78, 1.12, ql));

    return h;
  }

  return { spec, valleys, summit: S, lake: L, heightAt };
}

// Same gradient noise as the terrain, with its own seed.
function makeNoise(seed) {
  const rnd = mulberry32(seed);
  const p = new Uint8Array(512);
  const base = [...Array(256).keys()];
  for (let i = 255; i > 0; i--) {
    const j = (rnd() * (i + 1)) | 0;
    [base[i], base[j]] = [base[j], base[i]];
  }
  for (let i = 0; i < 512; i++) p[i] = base[i & 255];
  const G = [[1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]];
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const X = xi & 255, Y = yi & 255;
    const xf = x - xi, yf = y - yi;
    const dot = (h, dx, dy) => G[h & 7][0] * dx + G[h & 7][1] * dy;
    const u = fade(xf), v = fade(yf);
    return lerp(
      lerp(dot(p[p[X] + Y], xf, yf), dot(p[p[X + 1] + Y], xf - 1, yf), u),
      lerp(dot(p[p[X] + Y + 1], xf, yf - 1), dot(p[p[X + 1] + Y + 1], xf - 1, yf - 1), u),
      v,
    );
  };
}

/**
 * Terrain colour for the alpine level: meadows on the valley floors, dark
 * forest up the slopes, pale alpine pasture above the trees, bare rock on
 * anything steep, and snow above a ragged snow line.
 */
export function alpineColor(shape, P, x, y, z, flatness, out) {
  const sp = shape.spec;
  const ragged = Math.sin(x * 0.011) * 28 + Math.sin(z * 0.0137 + x * 0.004) * 34;
  const snowLine = sp.snowLine + ragged;

  if (y < 4) return out.set(P.sand);
  // The summit wears a cap of snow whatever the snow line says.
  const S = shape.summit;
  if (Math.hypot(x - S.x, z - S.z) < S.flat + 90 && y > S.top - 75) return out.set(P.snow);
  // Snow lies where it can: on the gentler ground above the snow line, and on
  // all but the sheerest faces once it is well above it.
  if (y > snowLine && flatness > lerp(0.78, 0.36, smoothstep(snowLine, snowLine + 320, y))) {
    return out.set(P.snow);
  }
  // Bare rock on anything steep, and on everything above the pastures.
  if (flatness < 0.66 || y > sp.treeLine + 110 + ragged) {
    out.set(P.rock).multiplyScalar(lerp(1.06, 0.84, smoothstep(150, 1300, y)));
    // Streaks of old snow in the gullies high up.
    if (y > snowLine - 80) out.lerp(SNOW.set(P.snow), smoothstep(0.35, 0.7, flatness) * 0.45);
    return out;
  }
  if (y < sp.meadowTop) return out.set(P.grass);
  if (y < sp.treeLine) return out.set(P.forest);
  return out.set(P.pasture);
}
const SNOW = new THREE.Color();

// ---------------------------------------------------------------------------
// Props: rivers, forests, a village, and the flags on the summit
// ---------------------------------------------------------------------------

/**
 * @param {object} shape from createAlpineShape
 * @param {Function} heightAt the terrain's (apron included)
 * @param {{position:THREE.Vector3, quaternion:THREE.Quaternion}} summitGate
 */
export function createAlpineProps(cfg, shape, heightAt, summitGate) {
  const spec = cfg.alps;
  const rnd = mulberry32(cfg.seed ^ 0x7a1e);
  const group = new THREE.Group();
  const P = cfg.palette;

  // ---- colliders ----------------------------------------------------------
  const grid = new Map();
  const solid = (c) => {
    for (let gx = Math.floor((c.x0 - 20) / 80); gx <= Math.floor((c.x1 + 20) / 80); gx++) {
      for (let gz = Math.floor((c.z0 - 20) / 80); gz <= Math.floor((c.z1 + 20) / 80); gz++) {
        const k = `${gx},${gz}`;
        let list = grid.get(k);
        if (!list) grid.set(k, (list = []));
        list.push(c);
      }
    }
  };

  // ---- rivers ---------------------------------------------------------------
  // A ribbon down each valley at the height of the floor, from just below the
  // head to the lake.
  const riverMat = new THREE.MeshLambertMaterial({
    color: P.river, flatShading: true,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  });
  for (const v of shape.valleys) {
    const pos = [];
    const half = v.spec.riverWidth / 2;
    const step = 12;
    const start = v.length * 0.02, end = v.length * 0.97;
    let prev = null;
    for (let s = start; s <= end; s += step) {
      const c = v.riverAt(s);
      const n = v.riverAt(Math.min(end, s + step)).sub(v.riverAt(Math.max(start, s - step))).normalize();
      // Wider and slower in the flat lower reaches.
      const w = half * lerp(1.25, 0.75, s / v.length);
      const y = Math.max(0.6, heightAt(c.x, c.y) + 0.7);
      const l = [c.x - n.y * w, y, c.y + n.x * w];
      const r = [c.x + n.y * w, y, c.y - n.x * w];
      if (prev) pos.push(...prev.l, ...l, ...r, ...prev.l, ...r, ...prev.r);
      prev = { l, r };
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    group.add(new THREE.Mesh(g, riverMat));
  }

  // ---- forests ----------------------------------------------------------------
  // Pines on the slopes between the meadows and the tree line, in patches.
  const trees = [];
  const slopeAt = (x, z) => {
    const e = 6;
    return Math.hypot(heightAt(x + e, z) - heightAt(x - e, z), heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
  };
  const nearRiver = (x, z) => shape.valleys.some((v) => {
    const q = v.query(x, z);
    if (!q) return false;
    return v.riverAt(q.s).distanceTo(new THREE.Vector2(x, z)) < v.spec.riverWidth + 10;
  });
  const runway = cfg.airport;
  for (let k = 0; k < spec.treeAttempts; k++) {
    const x = (rnd() - 0.5) * 4600, z = (rnd() - 0.5) * 4600;
    const h = heightAt(x, z);
    if (h < 12 || h > spec.treeLine + (rnd() - 0.5) * 60) continue;
    // Patchy: forests, not an even fuzz.
    if (Math.sin(x * 0.006 + Math.sin(z * 0.004) * 2) + Math.sin(z * 0.0071 - x * 0.002) < -0.3) continue;
    if (slopeAt(x, z) > 0.95) continue;
    if (Math.abs(x - runway.x) < 160 && Math.abs(z - runway.z) < 900) continue;
    if (nearRiver(x, z)) continue;
    trees.push({ x, z, y: h, r: 5 + rnd() * 3.5, ht: 20 + rnd() * 16 });
  }
  if (trees.length) {
    const crowns = new THREE.InstancedMesh(
      new THREE.ConeGeometry(1, 1, 6),
      new THREE.MeshLambertMaterial({ flatShading: true }),
      trees.length,
    );
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion();
    const p3 = new THREE.Vector3(), s3 = new THREE.Vector3(), col = new THREE.Color();
    trees.forEach((t, i) => {
      p3.set(t.x, t.y + t.ht * 0.5 + 2, t.z);
      s3.set(t.r, t.ht, t.r);
      crowns.setMatrixAt(i, m4.compose(p3, q, s3));
      col.setHSL(0.31 + rnd() * 0.06, 0.35 + rnd() * 0.2, 0.17 + rnd() * 0.08);
      crowns.setColorAt(i, col);
      solid({ x0: t.x - t.r * 0.6, x1: t.x + t.r * 0.6, z0: t.z - t.r * 0.6, z1: t.z + t.r * 0.6, y0: t.y - 5, y1: t.y + t.ht + 2 });
    });
    crowns.instanceMatrix.needsUpdate = true;
    group.add(crowns);
  }

  // ---- village ------------------------------------------------------------------
  // Chalets beside the runway and along the lake shore, and a church.
  const houses = [];
  for (const [cx, cz, n, spread] of spec.villages) {
    for (let k = 0; k < n; k++) {
      const x = cx + (rnd() - 0.5) * spread, z = cz + (rnd() - 0.5) * spread;
      const y = heightAt(x, z);
      if (y < 3 || slopeAt(x, z) > 0.3 || nearRiver(x, z)) continue;
      if (Math.abs(x - runway.x) < 120 && Math.abs(z - runway.z) < 560) continue;
      if (houses.some((h) => Math.hypot(h.x - x, h.z - z) < 26)) continue;
      houses.push({ x, z, y, w: 12 + rnd() * 6, d: 14 + rnd() * 8, h: 8 + rnd() * 4, turn: rnd() < 0.5 });
    }
  }
  if (houses.length) {
    const walls = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshLambertMaterial({ flatShading: true }), houses.length);
    const roofGeo = new THREE.CylinderGeometry(0.71, 0.71, 1, 3, 1);
    roofGeo.rotateZ(Math.PI / 2);          // a triangular prism lying along x
    const roofs = new THREE.InstancedMesh(roofGeo,
      new THREE.MeshLambertMaterial({ flatShading: true }), houses.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion();
    const p3 = new THREE.Vector3(), s3 = new THREE.Vector3(), col = new THREE.Color();
    houses.forEach((hs, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), hs.turn ? Math.PI / 2 : 0);
      p3.set(hs.x, hs.y + hs.h / 2 - 1, hs.z);
      s3.set(hs.w, hs.h + 2, hs.d);
      walls.setMatrixAt(i, m4.compose(p3, q, s3));
      walls.setColorAt(i, col.set(rnd() < 0.6 ? 0xf1ebdf : 0x9a6b44));
      p3.set(hs.x, hs.y + hs.h + 3.2, hs.z);
      s3.set(hs.w * 1.2, 7, hs.d * 1.15);
      roofs.setMatrixAt(i, m4.compose(p3, q, s3));
      roofs.setColorAt(i, col.set(rnd() < 0.5 ? 0x5a3a2a : 0x6e4a33));
      const r = Math.max(hs.w, hs.d) * 0.62;
      solid({ x0: hs.x - r, x1: hs.x + r, z0: hs.z - r, z1: hs.z + r, y0: hs.y - 2, y1: hs.y + hs.h + 7 });
    });
    walls.instanceMatrix.needsUpdate = true;
    roofs.instanceMatrix.needsUpdate = true;
    group.add(walls, roofs);
  }
  if (spec.church) {
    const [cx, cz] = spec.church;
    const y = heightAt(cx, cz);
    const white = new THREE.MeshLambertMaterial({ color: 0xf3efe6, flatShading: true });
    const dark = new THREE.MeshLambertMaterial({ color: 0x4a3a30, flatShading: true });
    const nave = new THREE.Mesh(new THREE.BoxGeometry(16, 14, 30), white);
    nave.position.set(cx, y + 6, cz);
    const tower = new THREE.Mesh(new THREE.BoxGeometry(9, 30, 9), white);
    tower.position.set(cx, y + 14, cz - 18);
    const spire = new THREE.Mesh(new THREE.ConeGeometry(6.6, 18, 4), dark);
    spire.position.set(cx, y + 38, cz - 18);
    spire.rotation.y = Math.PI / 4;
    group.add(nave, tower, spire);
    solid({ x0: cx - 9, x1: cx + 9, z0: cz - 23, z1: cz + 16, y0: y - 2, y1: y + 47 });
  }

  // ---- the summit: two poles with flags, the gate between them ----------------
  const flags = [];
  if (summitGate) {
    const S = shape.summit;
    const across = new THREE.Vector3(1, 0, 0).applyQuaternion(summitGate.quaternion).setY(0).normalize();
    const ringR = cfg.route.ringRadius;
    const poleMat = new THREE.MeshLambertMaterial({ color: 0xdedad2, flatShading: true });
    const cairnMat = new THREE.MeshLambertMaterial({ color: 0x7c7a76, flatShading: true });
    const colours = spec.flagColors;
    [-1, 1].forEach((side, k) => {
      const x = summitGate.position.x + across.x * side * (ringR + S.poleGap);
      const z = summitGate.position.z + across.z * side * (ringR + S.poleGap);
      const y = heightAt(x, z);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.2, S.poleHeight, 6), poleMat);
      pole.position.set(x, y + S.poleHeight / 2, z);
      const cairn = new THREE.Mesh(new THREE.DodecahedronGeometry(5, 0), cairnMat);
      cairn.position.set(x, y + 1.5, z);
      cairn.scale.set(1, 0.6, 1);
      const ball = new THREE.Mesh(new THREE.SphereGeometry(1.8, 8, 6), new THREE.MeshLambertMaterial({ color: 0xf2c94c }));
      ball.position.set(x, y + S.poleHeight + 1.5, z);
      group.add(pole, cairn, ball);
      solid({ x0: x - 2, x1: x + 2, z0: z - 2, z1: z + 2, y0: y - 5, y1: y + S.poleHeight + 4 });

      // The flag: a strip of quads that flutters, hung off the top of the pole.
      const W = 26, H = 15, SEG = 8;
      const geo = new THREE.PlaneGeometry(W, H, SEG, 1);
      geo.translate(W / 2, 0, 0);
      const cols = [];
      const c1 = new THREE.Color(colours[k][0]), c2 = new THREE.Color(colours[k][1]);
      const posA = geo.attributes.position;
      for (let i = 0; i < posA.count; i++) {
        // Three horizontal bands, as most alpine flags have.
        const yy = posA.getY(i);
        const c = Math.abs(yy) < H / 6 + 0.01 ? c2 : c1;
        cols.push(c.r, c.g, c.b);
      }
      geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
      const flag = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
        vertexColors: true, side: THREE.DoubleSide, flatShading: true,
      }));
      flag.position.set(x, y + S.poleHeight - H / 2 - 1, z);
      // Fly the flags away from the gate, so they frame it rather than cross it.
      flag.rotation.y = Math.atan2(-across.z * side, across.x * side);
      group.add(flag);
      flags.push({ geo, base: Float32Array.from(posA.array), phase: k * 1.7 });
    });
  }
  let clock = 0;
  function update(dt) {
    clock += dt;
    for (const f of flags) {
      const a = f.geo.attributes.position;
      for (let i = 0; i < a.count; i++) {
        const x = f.base[i * 3];
        a.setZ(i, Math.sin(clock * 6 + f.phase - x * 0.32) * x * 0.09);
      }
      a.needsUpdate = true;
      f.geo.computeVertexNormals();
    }
  }

  function collides(x, y, z, margin = MARGIN) {
    const list = grid.get(`${Math.floor(x / 80)},${Math.floor(z / 80)}`);
    if (!list) return false;
    for (const c of list) {
      if (y > c.y1 + margin || y < c.y0 - margin) continue;
      if (x >= c.x0 - margin && x <= c.x1 + margin && z >= c.z0 - margin && z <= c.z1 + margin) return true;
    }
    return false;
  }

  return { group, collides, update, stats: { trees: trees.length, houses: houses.length } };
}
