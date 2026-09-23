// Autopilot. Used for the attract-mode demo behind the menus.
//
// It emits the same controls a player does and touches nothing else, so it
// flies under the same physics and is judged by the same landing rules. If it
// gets round, the route is genuinely flyable.
//
// The design leans on something the game already guarantees: the route
// generator proves that the straight line between consecutive gates clears the
// ground, that no gate turns far to reach the next, and that the last gate is
// low and far enough out to land from. So there is no path planning and no
// terrain avoidance here — only "stay on a line that is already known good".
//
// The aim point slides forward along that line rather than sitting on a gate.
// That is the whole trick: a fixed target goes behind you the moment you
// overshoot, and chasing it turns into a circle. A sliding one never does.

import * as THREE from 'three';
import { TUNE } from './plane.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const GAIN = {
  maxBank: 1.25,
  roll: 2.6,        // bank error -> aileron
  pitch: 3.2,       // flight-path error -> elevator
  throttle: 0.05,
};

const CRUISE = 100;
const MIN_SPEED = 78;
const CORNER_MARGIN = 0.75;   // of the theoretical limit, so it is never marginal
const APPROACH = 86;
const GLIDE = 0.09;          // height lost per unit along the final
const STUCK_AFTER = 25;     // no progress for this long: the caller restarts it

/**
 * @param {{airport:object, gates:{position:THREE.Vector3}[]}} level
 */
export function createAutopilot(level) {
  const { airport, gates } = level;

  // Speed to be doing at each gate, from the corner that follows it.
  //
  // Turn radius goes with the SQUARE of speed, so arriving too fast is not
  // something steering can rescue: at 109kt the tightest corner on Green
  // Valley needs a 450-unit radius and the aeroplane can only bend to 479, and
  // it sails past however hard it banks. Slowing to 84 makes the same corner
  // easy. This is the racing-line trick — brake for the corner, not in it.
  const cornerSpeed = gates.map((g, i) => {
    const next = gates[i + 1];
    if (!next) return CRUISE;
    // Fresh vectors: this runs once at build time, not per frame.
    const inDir = new THREE.Vector3()
      .subVectors(g.position, i === 0 ? airport.center : gates[i - 1].position)
      .setY(0).normalize();
    const outDir = new THREE.Vector3().subVectors(next.position, g.position).setY(0);
    const legOut = outDir.length();
    if (legOut < 1) return CRUISE;
    outDir.divideScalar(legOut);
    const turn = Math.acos(clamp(inDir.dot(outDir), -1, 1));
    if (turn < 0.02) return CRUISE;
    // Radius the next leg demands, then the speed that can bend to it.
    const needed = legOut / (2 * Math.sin(turn));
    const able = needed * TUNE.turnBank * Math.sin(GAIN.maxBank) * CORNER_MARGIN;
    return clamp(Math.sqrt(able), MIN_SPEED, CRUISE);
  });

  const aim = new THREE.Vector3();
  const regainTo = new THREE.Vector3();
  const BACK = new THREE.Vector3(0, 0, -1);
  const dir = new THREE.Vector3();
  const local = new THREE.Vector3();
  const segFrom = new THREE.Vector3();
  const segDir = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const q = new THREE.Quaternion();

  let phase = 'takeoff';
  let gearUp = false;
  let regainIndex = -1;
  let lastIndex = -1;
  let sinceProgress = 0;

  /**
   * A point on the current leg, one lookahead ahead of where the aeroplane
   * sits along it — and never past the gate at the end of that leg.
   *
   * The clamp is what makes it fly THROUGH the rings. Letting the lookahead
   * spill onto the next leg gives smoother anticipation, but it also cuts the
   * corner by roughly the lookahead times sin(half the turn) — about 39 units
   * on these routes, against rings of 34 to 46. It sails past the gate it was
   * supposed to take. The steering law below is what pays for the clamp: it
   * can make the turn late, so the anticipation is not needed.
   */
  function aimPoint(plane, index) {
    const i = Math.min(index, gates.length - 1);
    const to = gates[i].position;
    segFrom.copy(i === 0 ? airport.center : gates[i - 1].position);
    segDir.subVectors(to, segFrom);
    const len = segDir.length();
    if (len < 1) return aim.copy(to);
    segDir.divideScalar(len);

    const at = clamp(tmp.subVectors(plane.position, segFrom).dot(segDir), 0, len);
    const look = clamp(plane.speed * 2.2, 180, 380);
    return aim.copy(segFrom).addScaledVector(segDir, Math.min(len, at + look));
  }

  /** Point the aeroplane at a target: bank to turn, pitch to hold the path. */
  function steer(plane, target, opts = {}) {
    dir.subVectors(target, plane.position).normalize();
    q.copy(plane.quaternion).conjugate();
    local.copy(dir).applyQuaternion(q);

    const bearing = Math.atan2(local.x, -local.z);   // + means target to the right
    const fpaNow = Math.asin(clamp(plane.forward.y, -1, 1));
    const bankNow = plane.bankAngle;

    // Lateral steering leads the aeroplane by a lookahead, but height is aimed
    // at the gate itself. Tracking the lookahead point's altitude means
    // arriving at the gate already at the height of somewhere past it — and a
    // gate missed high is missed exactly as thoroughly as one missed wide.
    const climbTo = opts.altTarget ?? target;
    const reach = Math.max(40, Math.hypot(
      climbTo.x - plane.position.x, climbTo.z - plane.position.z,
    ));
    let wantFpa = clamp(
      Math.atan2(climbTo.y - plane.position.y, reach), -0.45, opts.maxClimb ?? 0.45,
    );

    // Speed is life: never hold a climb the wing cannot pay for.
    wantFpa = Math.min(wantFpa, clamp((plane.speed - 78) / 80, -0.45, 0.45));
    if (opts.minFpa != null) wantFpa = Math.max(wantFpa, opts.minFpa);

    // Bank for the curvature that actually reaches the aim point, rather than
    // in proportion to how far off it is.
    //
    // A linear gain looks reasonable and does not work: a 13-degree error asks
    // for 24 degrees of bank, which turns too slowly to ever close it, so the
    // aeroplane arcs wide and arrives past the gate. Pure pursuit's own law —
    // curvature = 2 sin(bearing) / distance — asks for whatever bank the
    // geometry needs, which is 70-odd degrees when the aim point is close.
    const range = Math.max(60, target.distanceTo(plane.position));
    const turnRate = ((2 * Math.sin(bearing)) / range) * plane.speed;
    // Invert the model's level-turn relation, omega = turnBank * sin(bank) / v.
    const sinBank = clamp((turnRate * plane.speed) / TUNE.turnBank, -1, 1);
    const limit = opts.maxBank ?? GAIN.maxBank;
    const wantBank = clamp(-Math.asin(sinBank), -limit, limit);

    // Pitch does one job: hold the flight path on the line. It deliberately
    // carries no extra back-pressure for the turn. Adding any — a bank-
    // proportional pull, or asking to climb through corners — turns the
    // aeroplane faster but balloons it over the gates, which is a miss just
    // the same. Turning is the bank's job here, and the bank law above is
    // strong enough to do it alone.
    return {
      bearing,
      roll: clamp((bankNow - wantBank) * GAIN.roll, -1, 1),
      pitch: clamp((wantFpa - fpaNow) * GAIN.pitch, -1, 1),
    };
  }

  const power = (target, speed) => clamp(0.62 + (target - speed) * GAIN.throttle, 0, 1);

  return {
    get phase() { return phase; },
    /** True when it has sat on the same gate long enough to be lost. */
    get stuck() { return sinceProgress > STUCK_AFTER; },

    reset() {
      phase = 'takeoff';
      gearUp = false;
      regainIndex = -1;
      lastIndex = -1;
      sinceProgress = 0;
    },

    /**
     * @returns {{pitch:number,roll:number,yaw:number,throttle:number,
     *            throttleAbs:number,brake:boolean}}
     */
    update(dt, plane, rings) {
      const ctrl = {
        pitch: 0, roll: 0, yaw: 0, throttle: 0, throttleAbs: 1, brake: false,
      };
      const info = airport.approachInfo(plane);

      if (rings.index !== lastIndex) {
        lastIndex = rings.index;
        sinceProgress = 0;
      } else {
        sinceProgress += dt;
      }

      // ---- roll, rotate, climb away ----------------------------------------
      if (phase === 'takeoff') {
        if (plane.onGround) {
          ctrl.roll = clamp(-info.lateral * 0.012, -0.5, 0.5);   // hold the centreline
          ctrl.pitch = plane.speed >= TUNE.rotateSpeed ? 1 : 0;
          return ctrl;
        }
        const c = steer(plane, aimPoint(plane, rings.index), {
          maxClimb: 0.3,
          maxBank: 0.5,
          altTarget: gates[Math.min(rings.index, gates.length - 1)].position,
        });
        ctrl.pitch = c.pitch;
        ctrl.roll = c.roll;
        // Hand over early. This phase holds the wings nearly level, and the
        // first gate can sit lower than a tall threshold — staying in it
        // through that first turn means flying it on a 1200-unit radius.
        if (info.height > 80 || rings.index > 0) phase = 'pursue';
        return ctrl;
      }

      if (rings.done) phase = 'land';

      // ---- down the centreline and onto the runway --------------------------
      if (phase === 'land') {
        if (!plane.gearDown) plane.toggleGear();

        if (plane.onGround) {
          ctrl.throttleAbs = 0;
          ctrl.brake = true;
          ctrl.roll = clamp(-info.lateral * 0.01, -0.4, 0.4);
          return ctrl;
        }

        const look = clamp(plane.speed * 2.2, 180, 380);
        const along = Math.max(-200, info.along - look);
        aim.copy(airport.center).addScaledVector(airport.axis, -along);
        aim.y = airport.surfaceY + Math.max(0, along - 260) * GLIDE;

        const low = info.height < 90;
        const c = steer(plane, aim, {
          // Wings near level close in, or the touchdown is a wing strike.
          maxBank: low ? 0.3 : 0.8,
          minFpa: info.height < 26 ? -0.02 : (low ? -0.06 : null),
        });
        ctrl.pitch = c.pitch;
        ctrl.roll = c.roll;
        ctrl.throttleAbs = power(APPROACH, plane.speed);
        return ctrl;
      }

      // ---- gone past one: set up and come back ------------------------------
      // Without this a miss is terminal. The aim point can only ever sit on
      // the gate ahead, so once a gate is behind, steering at it just flies a
      // circle round it for ever. Backing off to its approach axis turns a
      // dead end into another attempt.
      const gate = gates[Math.min(rings.index, gates.length - 1)];
      if (phase === 'regain') {
        if (regainIndex !== rings.index) {
          phase = 'pursue';                      // it went in; carry on
        } else {
          const reached = plane.position.distanceTo(regainTo) < 220;
          const c2 = steer(plane, regainTo, { altTarget: regainTo });
          ctrl.pitch = c2.pitch;
          ctrl.roll = c2.roll;
          ctrl.throttleAbs = power(MIN_SPEED + 8, plane.speed);
          if (reached) phase = 'pursue';
          return ctrl;
        }
      } else {
        dir.subVectors(gate.position, plane.position);
        const range = dir.length();
        q.copy(plane.quaternion).conjugate();
        local.copy(dir).normalize().applyQuaternion(q);
        if (range > 220 && -local.z < -0.35) {   // well past it and going away
          phase = 'regain';
          regainIndex = rings.index;
          sinceProgress = 0;
          regainTo.copy(BACK).applyQuaternion(gate.quaternion)
            .multiplyScalar(-700).add(gate.position);
          return ctrl;
        }
      }

      // ---- the gates --------------------------------------------------------
      // Tuck the legs away once, and only once: a per-frame condition around a
      // threshold would sit there cycling the gear.
      if (!gearUp && info.height > 240 && !plane.onGround && plane.toggleGear()) {
        gearUp = true;
      }

      const i = Math.min(rings.index, gates.length - 1);
      const c = steer(plane, aimPoint(plane, rings.index), { altTarget: gate.position });
      ctrl.pitch = c.pitch;
      ctrl.roll = c.roll;

      const target = cornerSpeed[i];
      ctrl.throttleAbs = power(target, plane.speed);
      // Closing the throttle alone sheds speed slowly; the airbrake makes the
      // corner speed something it can actually arrive at.
      ctrl.brake = plane.speed > target + 12;
      return ctrl;
    },
  };
}
