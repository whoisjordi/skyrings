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
  sun.position.set(...(P.sunPos ?? [-1200, 1800, 900]));

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

/**
 * A clear night sky: stars on a dome and a moon with a halo. The group is
 * meant to follow the camera (position only), so the sky never comes closer.
 */
export function createNightSky(cfg) {
  const P = cfg.palette;
  const group = new THREE.Group();
  if (!P.stars) return null;
  const rnd = mulberry32(cfg.seed ^ 0x57a5);
  const R = 7000;

  // Stars: denser and brighter towards the zenith, none below the horizon
  // (the mountains and the fog hide that anyway).
  const n = P.stars;
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const y = Math.pow(rnd(), 0.7) * 0.98 + 0.02;
    const a = rnd() * Math.PI * 2, r = Math.sqrt(1 - y * y);
    pos.set([Math.cos(a) * r * R, y * R, Math.sin(a) * r * R], i * 3);
    const warm = rnd();
    const b = 0.35 + Math.pow(rnd(), 3) * 0.65;
    col.set([b * (0.85 + warm * 0.15), b * 0.9, b * (1.05 - warm * 0.2)], i * 3);
    size[i] = 1.2 + Math.pow(rnd(), 4) * 2.3;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('tint', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('size', new THREE.BufferAttribute(size, 1));
  const stars = new THREE.Points(geo, new THREE.ShaderMaterial({
    vertexShader: `
      attribute vec3 tint; attribute float size; varying vec3 vT;
      void main() { vT = tint; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_PointSize = size; }`,
    fragmentShader: `
      varying vec3 vT;
      void main() { float d = length(gl_PointCoord - 0.5) * 2.0; gl_FragColor = vec4(vT * smoothstep(1.0, 0.2, d), 1.0); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  stars.frustumCulled = false;
  stars.renderOrder = -2;
  group.add(stars);

  // The moon: a disc with a soft halo, drawn by one shader on one quad.
  const M = P.moon;
  if (M) {
    const dir = new THREE.Vector3(...M.dir).normalize();
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(M.size * 8, M.size * 8), new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(M.color) } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `
        uniform vec3 uColor; varying vec2 vUv;
        void main() {
          float d = length(vUv - 0.5) * 8.0;            // 1.0 = the moon's edge
          float disc = smoothstep(1.0, 0.94, d);
          // A few darker maria, so it reads as the moon and not a lamp.
          vec2 p = (vUv - 0.5) * 8.0;
          float maria = smoothstep(0.42, 0.2, length(p - vec2(-0.25, 0.2)))
            + smoothstep(0.3, 0.1, length(p - vec2(0.3, -0.15))) * 0.8
            + smoothstep(0.25, 0.05, length(p - vec2(0.05, -0.45))) * 0.6;
          vec3 face = uColor * (1.0 - 0.18 * maria);
          float halo = exp(-max(0.0, d - 1.0) * 1.6) * 0.32 + exp(-max(0.0, d - 1.0) * 0.45) * 0.08;
          halo *= 1.0 - smoothstep(2.4, 3.9, d);        // gone before the quad's edge
          gl_FragColor = vec4(face * disc + uColor * vec3(0.7, 0.8, 1.0) * halo * (1.0 - disc), 1.0);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    quad.position.copy(dir).multiplyScalar(R * 0.9);
    quad.lookAt(0, 0, 0);
    quad.renderOrder = -1;
    group.add(quad);
  }
  // Fog must not touch the sky: ShaderMaterials ignore it unless asked.
  return group;
}
