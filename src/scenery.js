// Sky, lighting and clouds — the set dressing that makes a level feel like a
// place rather than a height field. The city has a module of its own.

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
      // Levels on a plateau need their weather lifted with them.
      (cfg.cloudBase ?? 420) + rnd() * 560,
      Math.sin(ang) * dist,
    );
    puff.scale.setScalar(0.7 + rnd() * 1.2);
    group.add(puff);
  }
  return group;
}
