// Seeded low-poly terrain.
//
// The mesh is only a rendering of heightAt(); collision and the airport apron
// both read the same function, so what you see is exactly what you hit.

import * as THREE from 'three';

export const WORLD_SIZE = 5000;
// Cell size is WORLD_SIZE / segments; a level with a carved canyon needs a
// finer grid or the walls come out as a handful of huge facets.
const SEGMENTS = 128;

// Height of the flat apron the airport sits on, and how far it reaches.
// Levels that sit on high ground override it.
export const AIRPORT_Y = 20;
export const airportYOf = (cfg) => cfg.airportY ?? AIRPORT_Y;
const APRON_HALF = 520;   // apron follows the runway rather than a circle
const APRON_R = 300;
const APRON_FADE = 450;

// A departure/approach corridor along the runway centreline. Terrain inside it
// is capped to a gentle ramp, so climbing out and coming back down the
// centreline is always possible — without this, a mountain can sit across the
// only route out of the field and the mission is unwinnable.
const CORRIDOR_HALF_W = 340;
const CORRIDOR_GRADIENT = 0.14;   // ~8 degrees, well inside the aeroplane's climb
const CORRIDOR_END = 2200;
const CORRIDOR_FADE = 700;

const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
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

const GRAD = [[1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]];
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/** Classic 2D gradient noise, roughly -1..1, deterministic per seed. */
function makePerlin(seed) {
  const rnd = mulberry32(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = (rnd() * (i + 1)) | 0;
    [p[i], p[j]] = [p[j], p[i]];
  }
  // Doubled so the +1 lookups below never wrap past the end.
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const X = xi & 255, Y = yi & 255;
    const xf = x - xi, yf = y - yi;
    const u = fade(xf), v = fade(yf);
    const dot = (h, dx, dy) => {
      const g = GRAD[h & 7];
      return g[0] * dx + g[1] * dy;
    };
    const aa = perm[perm[X] + Y], ab = perm[perm[X] + Y + 1];
    const ba = perm[perm[X + 1] + Y], bb = perm[perm[X + 1] + Y + 1];
    return lerp(
      lerp(dot(aa, xf, yf), dot(ba, xf - 1, yf), u),
      lerp(dot(ab, xf, yf - 1), dot(bb, xf - 1, yf - 1), u),
      v,
    );
  };
}

/**
 * Builds the terrain for one level.
 * @param {object} cfg  seed, amp, mountain, palette, airport {x,z}
 * @param {object|null} [canyon] carved into the terrain last, if present
 */
export function createTerrain(cfg, canyon = null) {
  const noise = makePerlin(cfg.seed);
  const airportY = airportYOf(cfg);

  const fbm = (x, z, octaves, freq) => {
    let sum = 0, amp = 1, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += noise(x * freq, z * freq) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2.03; // slightly off 2.0 so octaves don't line up into grid artefacts
    }
    return sum / norm;
  };

  // Ridged noise reads as mountain spines rather than rolling dunes.
  const ridged = (x, z) => {
    const n = 1 - Math.abs(fbm(x + 9000, z - 9000, 4, 0.00065));
    return n * n;
  };

  const half = WORLD_SIZE / 2;
  const lift = cfg.baseLift ?? 0;   // plateau the whole interior sits on
  const rh = cfg.runwayHeading ?? 0;
  const rcos = Math.cos(rh);
  const rsin = Math.sin(rh);

  function heightAt(x, z) {
    // Land fades into open ocean before the mesh edge, so no visible seam.
    const d = Math.hypot(x, z);
    const coast = fbm(x + 4000, z + 4000, 2, 0.0009) * 260;
    const falloff = 1 - smoothstep(half * 0.5, half * 0.94, d + coast);
    if (falloff <= 0) return -120;

    const base = fbm(x, z, 5, 0.00042) * 0.75;
    const hills = fbm(x, z, 4, 0.0018) * 0.3;
    const peaks = ridged(x, z) * cfg.mountain;

    // The plateau rides the same coastal falloff as the relief, so high ground
    // still runs out into the sea instead of ending at a cliff.
    let h = ((base + hills + peaks) * cfg.amp + lift) * falloff - cfg.amp * 0.16;

    // Airport-local coordinates: the runway lies along local z.
    const rdx = x - cfg.airport.x, rdz = z - cfg.airport.z;
    const lx = rdx * rcos - rdz * rsin;
    const lz = rdx * rsin + rdz * rcos;

    // Flatten an apron so the runway always has somewhere level to sit. The
    // apron is a stadium shape following the strip, not a circle.
    const ad = Math.hypot(lx, Math.max(0, Math.abs(lz) - APRON_HALF));
    h = lerp(airportY, h, smoothstep(APRON_R, APRON_R + APRON_FADE, ad));

    // Cap the terrain under the climb-out and the final approach.
    const along = Math.max(0, Math.abs(lz) - APRON_HALF);
    const influence = (1 - smoothstep(CORRIDOR_END, CORRIDOR_END + CORRIDOR_FADE, Math.abs(lz)))
      * (1 - smoothstep(CORRIDOR_HALF_W * 0.55, CORRIDOR_HALF_W, Math.abs(lx)));
    if (influence > 0) {
      const ceiling = airportY + along * CORRIDOR_GRADIENT;
      h = lerp(h, Math.min(h, ceiling), influence);
    }

    // Cut the gorge last. It only ever lowers ground, so neither the apron nor
    // the corridor above can fill it back in.
    if (canyon) h = canyon.carve(x, z, h);

    return h;
  }

  // ---- mesh -------------------------------------------------------------
  const segments = cfg.segments ?? SEGMENTS;
  let geo = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, segments, segments);
  geo.rotateX(-Math.PI / 2);

  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, heightAt(pos.getX(i), pos.getZ(i)));
  }

  // Unshared vertices give each triangle one flat colour and one flat normal.
  geo = geo.toNonIndexed();
  geo.computeVertexNormals();

  const P = cfg.palette;
  const sand = new THREE.Color(P.sand);
  const grass = new THREE.Color(P.grass);
  const rock = new THREE.Color(P.rock);
  const snow = new THREE.Color(P.snow);

  const vp = geo.attributes.position;
  const vn = geo.attributes.normal;
  const colors = new Float32Array(vp.count * 3);
  const c = new THREE.Color();
  const tintRnd = mulberry32(cfg.seed ^ 0x5eed);

  // Absolute heights, because a level on a plateau cannot derive them from
  // `amp` — everything would land above the snow line.
  const B = cfg.bands ?? {
    sand: 6, low: cfg.amp * 0.2, high: cfg.amp * 0.55, top: cfg.amp * 0.62,
  };

  for (let f = 0; f < vp.count; f += 3) {
    const y = (vp.getY(f) + vp.getY(f + 1) + vp.getY(f + 2)) / 3;
    const flatness = vn.getY(f); // 1 = level ground, 0 = cliff

    if (y < B.sand) c.copy(sand);
    else if (flatness < 0.62) c.copy(rock);     // any cliff or canyon wall
    else if (y > B.top) c.lerpColors(rock, snow, smoothstep(B.top, B.top * 1.5, y));
    else c.lerpColors(grass, rock, smoothstep(B.low, B.high, y));

    // A touch of per-facet variation keeps large slopes from looking plastic.
    const t = 0.92 + tintRnd() * 0.16;
    for (let k = 0; k < 3; k++) {
      colors[(f + k) * 3] = c.r * t;
      colors[(f + k) * 3 + 1] = c.g * t;
      colors[(f + k) * 3 + 2] = c.b * t;
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
  );
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();

  // ---- water ------------------------------------------------------------
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(WORLD_SIZE * 3, WORLD_SIZE * 3),
    new THREE.MeshLambertMaterial({
      color: P.water, transparent: true, opacity: 0.88, depthWrite: false,
    }),
  );
  water.rotation.x = -Math.PI / 2;
  water.renderOrder = -1;
  water.matrixAutoUpdate = false;
  water.updateMatrix();

  const group = new THREE.Group();
  group.add(mesh, water);

  return { group, heightAt };
}
