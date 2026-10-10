// Replays: records a run as the aeroplane's pose over time. Played back as a
// see-through ghost flying alongside the next attempt, or as the aeroplane
// itself when you watch a run back.
//
// It records what happened, not the controls. Re-simulating stored inputs
// would be smaller, but it breaks the moment the flight model is retuned, and
// Math.sin and friends are allowed to differ between browsers, so a replay
// could drift off the route on someone else's machine. A recorded pose plays
// back the same everywhere.
//
// The recorder and the codec only read x/y/z/w fields, so the headless tests
// drive them with the real flight model; only createGhost builds anything.

import { Plane } from './plane.js';

// Bump when the stored layout changes; older ghosts are then ignored.
export const GHOST_FORMAT = 1;

// One sample every few physics steps: 30 Hz is plenty for a smooth path, at
// a quarter of the storage. Interpolation fills the frames in between.
export const SAMPLE_EVERY = 4;

// Channels per sample, and the scale each is rounded to before storing.
// Positions to a centimetre, the quaternion to 1e-4, gear and throttle to 1 %.
const SCALES = [100, 100, 100, 1e4, 1e4, 1e4, 1e4, 100, 100];
const CH = SCALES.length;

export class Recorder {
  constructor(step) {
    this.step = step;
    this.reset();
  }

  reset() {
    this.samples = [];
    this.ticks = 0;
  }

  /** Call once at the start pose, and then after every physics step. */
  tick(plane) {
    if (this.ticks++ % SAMPLE_EVERY) return;
    const p = plane.position, q = plane.quaternion;
    this.samples.push(p.x, p.y, p.z, q.x, q.y, q.z, q.w, plane.gearPos, plane.throttle);
  }

  /** The run so far as a compact, JSON-safe ghost. */
  finish(time) {
    return encode({ time, dt: this.step * SAMPLE_EVERY, samples: this.samples });
  }
}

// Rounded integers, stored as differences from the previous sample: the
// aeroplane moves a little each 1/30 s, so most numbers are short.
export function encode({ time, dt, samples }) {
  const out = new Array(samples.length);
  const prev = new Array(CH).fill(0);
  for (let i = 0; i < samples.length; i++) {
    const c = i % CH;
    const v = Math.round(samples[i] * SCALES[c]);
    out[i] = v - prev[c];
    prev[c] = v;
  }
  return { v: GHOST_FORMAT, time, dt, d: out };
}

/** Returns null for anything that is not a ghost this version can play. */
export function decode(ghost) {
  if (!ghost || ghost.v !== GHOST_FORMAT || !Array.isArray(ghost.d)
      || ghost.d.length < CH * 2 || ghost.d.length % CH || !(ghost.dt > 0)) return null;
  const samples = new Float32Array(ghost.d.length);
  const acc = new Array(CH).fill(0);
  for (let i = 0; i < ghost.d.length; i++) {
    const c = i % CH;
    acc[c] += ghost.d[i];
    samples[i] = acc[c] / SCALES[c];
  }
  return { time: ghost.time, dt: ghost.dt, samples, count: samples.length / CH };
}

/**
 * Pose at time t: position and quaternion written into the given objects
 * (anything with x/y/z and x/y/z/w), gear and throttle returned. Holds the
 * last pose once the recording ends — the ghost waits on the runway.
 */
export function sample(track, t, pos, quat) {
  const { samples, count, dt } = track;
  const f = Math.max(0, Math.min(count - 1, t / dt));
  const i = Math.min(count - 2, Math.floor(f));
  const k = f - i;
  const a = i * CH, b = a + CH;
  // Position on a Catmull-Rom curve through the neighbouring samples: a
  // straight line between them cuts a fast turn's corner by a metre or two.
  // Samples are evenly spaced in time, so the uniform kind is the right one.
  const a0 = Math.max(0, i - 1) * CH, b1 = Math.min(count - 1, i + 2) * CH;
  const k2 = k * k, k3 = k2 * k;
  const w0 = -0.5 * k3 + k2 - 0.5 * k, w1 = 1.5 * k3 - 2.5 * k2 + 1;
  const w2 = -1.5 * k3 + 2 * k2 + 0.5 * k, w3 = 0.5 * k3 - 0.5 * k2;
  pos.x = w0 * samples[a0] + w1 * samples[a] + w2 * samples[b] + w3 * samples[b1];
  pos.y = w0 * samples[a0 + 1] + w1 * samples[a + 1] + w2 * samples[b + 1] + w3 * samples[b1 + 1];
  pos.z = w0 * samples[a0 + 2] + w1 * samples[a + 2] + w2 * samples[b + 2] + w3 * samples[b1 + 2];
  // Normalised lerp, taking the short way round. At 30 Hz the two ends are
  // close enough that this is indistinguishable from a slerp.
  const dot = samples[a + 3] * samples[b + 3] + samples[a + 4] * samples[b + 4]
    + samples[a + 5] * samples[b + 5] + samples[a + 6] * samples[b + 6];
  const s = dot < 0 ? -1 : 1;
  let x = samples[a + 3] + (s * samples[b + 3] - samples[a + 3]) * k;
  let y = samples[a + 4] + (s * samples[b + 4] - samples[a + 4]) * k;
  let z = samples[a + 5] + (s * samples[b + 5] - samples[a + 5]) * k;
  let w = samples[a + 6] + (s * samples[b + 6] - samples[a + 6]) * k;
  const n = Math.hypot(x, y, z, w) || 1;
  quat.x = x / n; quat.y = y / n; quat.z = z / n; quat.w = w / n;
  return {
    gear: samples[a + 7] + (samples[b + 7] - samples[a + 7]) * k,
    throttle: samples[a + 8] + (samples[b + 8] - samples[a + 8]) * k,
  };
}

const _a = { x: 0, y: 0, z: 0 }, _b = { x: 0, y: 0, z: 0 }, _q = { x: 0, y: 0, z: 0, w: 1 };

/**
 * Puts a Plane into the recorded pose at t: position, attitude, gear and
 * propeller, with velocity and speed taken from the path so the camera and
 * the drones see it moving as it did.
 */
export function poseAt(track, t, plane, dt) {
  const { gear, throttle } = sample(track, t, plane.position, _q);
  plane.quaternion.set(_q.x, _q.y, _q.z, _q.w);
  const t0 = Math.max(0, t - track.dt), t1 = Math.min(track.time, t + track.dt);
  sample(track, t1, _a, _q);
  sample(track, t0, _b, _q);
  const span = t1 - t0 || 1;
  plane.velocity.set((_a.x - _b.x) / span, (_a.y - _b.y) / span, (_a.z - _b.z) / span);
  plane.speed = plane.velocity.length();
  plane.throttle = throttle;
  plane.gearPos = gear;
  plane._applyGearVisual();
  plane.propSpin += (2 + throttle * 46) * dt;
  if (plane._prop) plane._prop.rotation.z = plane.propSpin;
}

// ---------------------------------------------------------------------------
// The visible ghost: the same airframe, pale and see-through.
// ---------------------------------------------------------------------------
const GHOST_PALETTE = { body: 0xdff4ff, accent: 0x8fd8ff };

export function createGhost(ghostData) {
  const track = decode(ghostData);
  if (!track) return null;

  const model = new Plane(GHOST_PALETTE);
  model.object.traverse((o) => {
    if (!o.material) return;
    o.material = o.material.clone();
    o.material.transparent = true;
    o.material.opacity *= 0.38;
    o.material.depthWrite = false;
  });
  model.object.renderOrder = 2;   // after the world, so it blends over it
  model.object.visible = false;

  return {
    object: model.object,
    time: track.time,
    update(t, dt, show) {
      model.object.visible = show;
      if (!show) return;
      poseAt(track, t, model, dt);
    },
  };
}
