// Sky, lighting, clouds and the optional city block — the set dressing that
// makes a level feel like a place rather than a height field.

import * as THREE from 'three';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function applySky(scene, P) {
  scene.background = new THREE.Color(P.sky);
  scene.fog = new THREE.Fog(P.fog, P.fogNear, P.fogFar);

  const hemi = new THREE.HemisphereLight(P.hemi, P.ground, P.hemiIntensity);

  const sun = new THREE.DirectionalLight(P.sun, P.sunIntensity);
  sun.position.set(-1200, 1800, 900);

  const group = new THREE.Group();
  group.add(hemi, sun);
  return group;
}

/** Scattered flat-shaded blobs at altitude. Cheap, and they sell the height. */
export function createClouds(cfg) {
  const P = cfg.palette;
  const rnd = mulberry32(cfg.seed ^ 0xc10d);
  const group = new THREE.Group();
  const geo = new THREE.IcosahedronGeometry(1, 0);
  const mat = new THREE.MeshLambertMaterial({
    color: P.cloud, flatShading: true, transparent: true, opacity: 0.9,
  });

  for (let i = 0; i < P.cloudCount; i++) {
    const puff = new THREE.Group();
    const lobes = 3 + ((rnd() * 4) | 0);
    for (let j = 0; j < lobes; j++) {
      const m = new THREE.Mesh(geo, mat);
      const r = 26 + rnd() * 34;
      m.position.set((rnd() - 0.5) * 90, (rnd() - 0.5) * 16, (rnd() - 0.5) * 60);
      m.scale.set(r, r * 0.55, r * 0.8);
      m.rotation.set(rnd() * 3, rnd() * 3, rnd() * 3);
      puff.add(m);
    }
    const ang = rnd() * Math.PI * 2;
    const dist = 300 + rnd() * 1900;
    puff.position.set(
      Math.cos(ang) * dist,
      420 + rnd() * 560,
      Math.sin(ang) * dist,
    );
    puff.scale.setScalar(0.7 + rnd() * 1.2);
    group.add(puff);
  }
  return group;
}

/**
 * A block of towers. Also answers collision queries, so the city is a real
 * obstacle rather than scenery you fly through.
 */
function nearCorridor(x, z, path, radius) {
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], b = path[i + 1];
    if (distToSegment2D(x, z, a.x, a.z, b.x, b.z) < radius) return true;
  }
  return false;
}

/** Shortest distance from (px,pz) to the segment ab, in the XZ plane. */
function distToSegment2D(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2)) : 0;
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

/**
 * @param {THREE.Vector3[]} [corridor] path to keep clear of buildings
 */
export function createCity(cfg, heightAt, corridor) {
  const spec = cfg.city;
  if (!spec) return null;

  const rnd = mulberry32(cfg.seed ^ 0xc17a);
  const boxes = [];
  const group = new THREE.Group();

  const geo = new THREE.BoxGeometry(1, 1, 1);
  // setColorAt allocates instanceColor on first use; per-instance tint needs
  // no vertexColors flag on the material.
  const mesh = new THREE.InstancedMesh(
    geo,
    new THREE.MeshLambertMaterial({ flatShading: true }),
    spec.count,
  );

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const color = new THREE.Color();

  let placed = 0;
  // Grid-ish layout with jitter reads as a city; pure random reads as rubble.
  const cols = Math.ceil(Math.sqrt(spec.count));
  const step = (spec.radius * 2) / cols;

  for (let gx = 0; gx < cols && placed < spec.count; gx++) {
    for (let gz = 0; gz < cols && placed < spec.count; gz++) {
      const x = spec.x - spec.radius + gx * step + (rnd() - 0.5) * step * 0.45;
      const z = spec.z - spec.radius + gz * step + (rnd() - 0.5) * step * 0.45;
      if (Math.hypot(x - spec.x, z - spec.z) > spec.radius) continue;

      const base = heightAt(x, z);
      if (base < 8) continue; // don't build in the sea

      // Leave a lane along the route. Without this, gates end up inside
      // towers and the mission is simply impossible.
      if (corridor && nearCorridor(x, z, corridor, spec.corridor ?? 150)) continue;

      const h = spec.minH + rnd() * (spec.maxH - spec.minH);
      const w = step * (0.34 + rnd() * 0.3);
      const d = step * (0.34 + rnd() * 0.3);

      pos.set(x, base + h / 2, z);
      scale.set(w, h, d);
      m.compose(pos, q, scale);
      mesh.setMatrixAt(placed, m);

      const shade = 0.52 + rnd() * 0.38;
      color.setRGB(shade * 0.82, shade * 0.86, shade * 0.95);
      mesh.setColorAt(placed, color);

      boxes.push({ x, z, top: base + h, hx: w / 2, hz: d / 2 });
      placed++;
    }
  }
  mesh.count = placed;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  group.add(mesh);

  const MARGIN = 8; // roughly the plane's half-span at the fuselage


  return {
    group,
    /** True when the point is inside any tower. */
    collides(x, y, z) {
      for (const b of boxes) {
        if (y > b.top + MARGIN) continue;
        if (Math.abs(x - b.x) <= b.hx + MARGIN && Math.abs(z - b.z) <= b.hz + MARGIN) {
          return true;
        }
      }
      return false;
    },
  };
}
