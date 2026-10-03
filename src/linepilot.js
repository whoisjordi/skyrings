// A racing-line pilot. Flies the attract-mode demo on the levels where the
// path-following autopilot cannot finish — the mountains and the city, where
// the straight line between two gates is not enough to keep you off things.
//
// The line is a centripetal Catmull-Rom from the runway, through every gate,
// down onto the threshold. The pilot steers bank-to-turn, the way you would:
// roll until the lift points at where the line is going, then pull. It
// emits the same controls a player does and touches nothing else.
//
// The headless tests fly the same controller (test/harness.mjs, flyLine), so
// "the demo can fly it" and "a player can fly it" are checked by one law.

import * as THREE from 'three';
import { TUNE } from './plane.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const SAMPLES = 5000;
const STUCK_AFTER = 20;   // seconds without progress along the line
const CRUISE = 100;
const APPROACH = 84;

/**
 * Bank-to-turn steering towards a point. Shared with the tests.
 * @returns {{pitch:number, roll:number}}
 */
export function steerTowards(plane, target) {
  const fwd = plane.forward.clone(), up = plane.up.clone(), right = plane.right.clone();
  const dir = target.clone().sub(plane.position).normalize();
  // Where the lift should point: at the line, with a little up to hold height.
  const lift = dir.clone().addScaledVector(fwd, -dir.dot(fwd)).multiplyScalar(2)
    .add(new THREE.Vector3(0, 0.25, 0));
  lift.addScaledVector(fwd, -lift.dot(fwd));
  const roll = Math.atan2(lift.dot(right), lift.dot(up));
  const pitch = Math.atan2(dir.dot(up), dir.dot(fwd));
  return { pitch: clamp(pitch * 15, -1, 1), roll: clamp(roll * 3, -1, 1) };
}

/**
 * @param {{airport:object, gates:{position:THREE.Vector3}[]}} level
 */
export function createLinePilot(level) {
  const { airport, gates } = level;
  const axis = airport.axis;
  const ground = airport.surfaceY;

  // Runway -> climb-out -> gates -> final -> threshold -> rollout.
  const start = new THREE.Vector3(airport.start.x, ground, airport.start.z);
  const liftoff = start.clone().addScaledVector(axis, 420);
  liftoff.y = ground + 12;
  const climb = start.clone().addScaledVector(axis, 650);
  climb.y = ground + 45;
  // Cross the threshold a little high and hold it; the flare puts it down.
  const short = airport.center.clone().addScaledVector(axis, -700);
  short.y = ground + 22;
  const threshold = airport.center.clone().addScaledVector(axis, -440);
  threshold.y = ground + 10;
  const touchdown = airport.center.clone().addScaledVector(axis, -150);
  touchdown.y = ground + 4;
  const rollout = airport.center.clone().addScaledVector(axis, 300);
  rollout.y = ground;

  const pts = [start, liftoff, climb, ...gates.map((g) => g.position.clone()), short, threshold, touchdown, rollout];
  const line = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  const samples = line.getSpacedPoints(SAMPLES);
  const step = line.getLength() / SAMPLES;

  let at = 0, best = 0, sinceProgress = 0;

  return {
    get stuck() { return sinceProgress > STUCK_AFTER; },

    reset() { at = 0; best = 0; sinceProgress = 0; },

    update(dt, plane, rings) {
      // Progress: the nearest sample a little way ahead of the last one.
      let d2 = Infinity;
      for (let i = at; i < Math.min(SAMPLES, at + 250); i++) {
        const d = samples[i].distanceToSquared(plane.position);
        if (d < d2) { d2 = d; at = i; }
      }
      if (at > best + 2) { best = at; sinceProgress = 0; } else sinceProgress += dt;

      const info = airport.approachInfo(plane);
      const home = rings.done;

      if (plane.onGround) {
        if (!home) {
          // Takeoff roll: full power, rotate at speed.
          return { pitch: plane.speed >= TUNE.rotateSpeed ? 1 : 0, roll: 0, yaw: 0, throttle: 1, brake: false };
        }
        return { pitch: 0, roll: 0, yaw: 0, throttle: -1, brake: true };
      }

      const want = home ? APPROACH : CRUISE;
      const target = samples[Math.min(SAMPLES, at + Math.round((plane.speed * 0.6) / step))];
      const { pitch, roll } = steerTowards(plane, target);
      const ctrl = {
        pitch, roll, yaw: 0,
        throttle: plane.speed < want ? 1 : -1,
        brake: plane.speed > want + 12,
      };

      // Over the runway: wings level, power to idle, and hold a gentle sink
      // until the wheels find the tarmac.
      if (home && airport.contains(plane.position.x, plane.position.z) && info.height < 14) {
        ctrl.roll = clamp(plane.bankAngle * 3, -1, 1);
        const sink = -plane.velocity.y;
        ctrl.pitch = clamp((sink - 2.5) * 0.3 - plane.forward.y * 4, -0.4, 1);
        ctrl.throttle = -1;
        ctrl.brake = false;
      }
      return ctrl;
    },
  };
}
