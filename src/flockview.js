// Draws a flock as glowing points: one THREE.Points, one draw call, a soft
// round dot drawn in the shader, added onto the night rather than painted
// over it. Positions are interpolated between simulation ticks.

import * as THREE from 'three';

const VERT = /* glsl */`
  attribute vec3 tint;
  uniform float uScale;
  uniform float uSize;
  varying vec3 vTint;
  varying float vFade;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float px = uSize * uScale / max(1.0, -mv.z);
    // A floor on the size, so far drones stay visible as single dots; they
    // get dimmer instead of smaller.
    vFade = clamp(px / 2.5, 0.25, 1.0);
    gl_PointSize = clamp(px, 2.5, 26.0);
    vTint = tint;
  }
`;

const FRAG = /* glsl */`
  varying vec3 vTint;
  varying float vFade;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    float core = smoothstep(0.45, 0.0, d);
    float glow = exp(-d * d * 5.0);
    vec3 c = vTint * glow * 0.9 + vec3(core) * 0.45 * (vTint + 0.3);
    gl_FragColor = vec4(c * vFade, 1.0);
  }
`;

export function createFlockView(flock, { size = 3.2 } = {}) {
  const n = flock.count;
  const geo = new THREE.BufferGeometry();
  const pos = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
  const tint = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
  pos.setUsage(THREE.DynamicDrawUsage);
  tint.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', pos);
  geo.setAttribute('tint', tint);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uScale: { value: 400 }, uSize: { value: size } },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;     // the bounds move every frame
  points.renderOrder = 2;

  return {
    object: points,
    /** Copies the interpolated flock into the buffers. */
    update(camera, viewportHeight) {
      const a = flock.alpha, p = flock.pos, q = flock.prevPos, c = flock.col, b = flock.bright;
      const P = pos.array, T = tint.array;
      for (let i = 0; i < n * 3; i++) P[i] = q[i] + (p[i] - q[i]) * a;
      for (let i = 0; i < n; i++) {
        const k = b[i];
        T[i * 3] = c[i * 3] * k; T[i * 3 + 1] = c[i * 3 + 1] * k; T[i * 3 + 2] = c[i * 3 + 2] * k;
      }
      pos.needsUpdate = true;
      tint.needsUpdate = true;
      // Pixels per unit at distance 1: keeps dot size right as the FOV moves.
      mat.uniforms.uScale.value = viewportHeight / (2 * Math.tan((camera.fov * Math.PI) / 360));
    },
  };
}
