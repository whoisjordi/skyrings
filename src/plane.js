// Arcade flight model.
//
// Not a simulation. Speed is a single scalar along the nose, and the only
// aerodynamics are: climbing trades speed for height, diving trades it back,
// and banking turns you. That is enough to feel like flying and it never
// surprises the player.

import * as THREE from 'three';

// Tuned as one set — changing any of these in isolation will break the others.
// thrust/drag fix the top speed, thrust/groundDrag fix the takeoff roll, and
// gravity decides how steeply you can climb before the speed bleeds away.
export const TUNE = {
  thrust: 14,          // acceleration at full throttle (~1.4g, not a rocket)
  drag: 0.00082,       // quadratic; balances thrust at ~131 in level flight
  gravity: 16,         // speed bled per unit of climb; > thrust, so no hovering
  stall: 30,           // below this the wing stops holding you up
  maxSpeed: 190,
  pitchRate: 1.0,      // rad/s at full deflection
  rollRate: 2.2,
  yawRate: 0.5,
  turnBank: 22,        // lift coupling at 1g: how much a bank alone bends the path
  turnLoad: 9,         // extra coupling per g of back-pressure
  pullLoad: 3,         // back-pressure raises the load factor to 1..4g (as pull^2)
  turnDrag: 0.7,       // induced drag, paid on load^2 - this is what makes a
                       // hard turn expensive and a gentle one nearly free
  maxTurnRate: 1.2,    // rad/s ceiling, so nothing can spin on the spot
  autoLevel: 0.2,      // gentle drift back to wings-level, hands off only
  throttleRate: 0.55,  // full travel in ~1.8s
  rotateSpeed: 62,     // runway speed at which the nose will lift

  // Slow flight. The wing runs out of margin well before it actually stalls:
  // below mushSpeed the nose sags and you sink, and it gets worse all the way
  // down to the stall, where it lets go properly.
  mushSpeed: 70,
  mushSink: 11,
  mushPitchDown: 0.8,
  stallSink: 45,
  stallPitchDown: 2.5,
  groundSteer: 0.85,
  groundDrag: 2.5,
  brakeDecel: 34,      // wheel brakes: ~100kt to a standstill in about 3s
  airbrake: 5,
  clearance: 2.4,      // how close the belly gets before it counts as contact
  waterline: 0.5,      // sea level contact height
  gearDragFactor: 0.8,   // drag multiplier with the gear up -> ~153kt vs 131
  gearThrustBonus: 1.1,  // and a little more acceleration to go with it
  gearTravel: 1.2,       // seconds for the legs to swing
  gearLockedAt: 0.9,     // gearPos above this counts as down and locked
  bellyDrag: 26,         // scraping friction during a gear-up slide
  takeoffGrace: 1.0,   // seconds after rotation where the runway can't catch you
  clearedHeight: 15,   // height that counts as genuinely off the runway
};

// Nitro. The multiplier is on THRUST, not on speed. Six times the push gives a
// hard surge to roughly 300kt with the gear down and 320 with it up, against a
// 127kt cruise — fast enough that turns go very wide while it is lit, which is
// the trade that makes it a decision rather than a free button.
export const NITRO = {
  thrustMult: 6,
  // Headroom has to rise with the multiplier. At 6x thrust the aeroplane would
  // sit pinned against a 1.45 ceiling the whole burn, which makes every
  // multiplier above about 4x feel identical and stops the gear mattering
  // while the boost is lit.
  speedCapMult: 1.7,
  duration: 5,
  cooldown: 10,
  ramp: 0.45,          // seconds to blend in and out, so it never snaps on
};

const V = {
  fwd: new THREE.Vector3(),
  up: new THREE.Vector3(),
  right: new THREE.Vector3(),
  tmp: new THREE.Vector3(),
};
const Q = { a: new THREE.Quaternion(), b: new THREE.Quaternion() };
const AX = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class Plane {
  constructor(palette) {
    this.object = buildModel(palette);
    this.position = this.object.position;
    this.quaternion = this.object.quaternion;
    this.velocity = new THREE.Vector3();
    this._prevPos = new THREE.Vector3();
    this.speed = 0;
    this.throttle = 0;
    this.onGround = true;
    this.airborneFor = 0;
    this.clearedRunway = false;
    this.dead = false;
    this.propSpin = 0;
    // 1 = down and locked, 0 = fully retracted; it travels in between.
    this.gearDown = true;
    this.gearPos = 1;
    this.bellySliding = false;
    this.nitroTime = 0;       // seconds of boost left
    this.nitroCooldown = 0;   // seconds until it can be used again
    this.nitroBlend = 0;      // smoothed 0..1 actually applied
    this._prop = this.object.getObjectByName('prop');
    this._gear = this.object.getObjectByName('gear');
  }

  reset(x, y, z, heading) {
    this.position.set(x, y, z);
    this._prevPos.set(x, y, z);
    this.quaternion.setFromAxisAngle(AX.y, heading);
    this.velocity.set(0, 0, 0);
    this.speed = 0;
    this.throttle = 0;
    this.onGround = true;
    this.airborneFor = 0;
    this.clearedRunway = false;
    this.dead = false;
    this.gearDown = true;
    this.gearPos = 1;
    this.bellySliding = false;
    this.nitroTime = 0;
    this.nitroCooldown = 0;
    this.nitroBlend = 0;
    this._applyGearVisual();
  }

  // Unit vectors in world space, refreshed from the current orientation.
  get forward() { return V.fwd.set(0, 0, -1).applyQuaternion(this.quaternion); }
  get up() { return V.up.set(0, 1, 0).applyQuaternion(this.quaternion); }
  get right() { return V.right.set(1, 0, 0).applyQuaternion(this.quaternion); }

  get nitroActive() { return this.nitroTime > 0; }
  get nitroReady() { return this.nitroTime <= 0 && this.nitroCooldown <= 0; }

  /**
   * Fires the boost if it is charged.
   * @returns {boolean} whether it lit
   */
  fireNitro() {
    if (!this.nitroReady) return false;
    this.nitroTime = NITRO.duration;
    return true;
  }

  /** Thrust multiplier from the boost, ramped rather than switched. */
  get _boost() { return 1 + this.nitroBlend * (NITRO.thrustMult - 1); }

  /** Down AND locked. Mid-travel does not count — you cannot land on it. */
  get gearLocked() { return this.gearPos >= TUNE.gearLockedAt; }

  /**
   * Raises or lowers the gear. Refused on the ground: the legs are carrying
   * the aeroplane, so there is nothing sensible to do with the request.
   * @returns {boolean} whether the request was accepted
   */
  toggleGear() {
    if (this.onGround) return false;
    this.gearDown = !this.gearDown;
    return true;
  }

  /** sin(bank): 0 level, negative banked right. */
  get bank() { return this.right.y; }

  /**
   * Signed bank angle in radians, positive to the left, and correct all the
   * way round: asin(bank) folds back on itself past 90 degrees and cannot
   * tell a steep bank from an inverted one.
   */
  get bankAngle() { return Math.atan2(this.right.y, this.up.y); }
  /** True while the wing is not producing enough lift. */
  get stalling() { return !this.onGround && this.speed < TUNE.stall; }

  _rotateLocal(axis, angle) {
    if (!angle) return;
    this.quaternion.multiply(Q.a.setFromAxisAngle(axis, angle));
  }

  /**
   * @param {number} dt seconds
   * @param {{pitch:number,roll:number,yaw:number,throttle:number,brake:boolean}} ctrl
   * @param {{heightAt:Function, airport:object}} world
   * @returns {{type:string, reason?:string}|null} event for the caller to act on
   */
  update(dt, ctrl, world) {
    // A slider sets the throttle outright; keys nudge it. Touch controls need
    // the absolute form — you put the lever where you want it and let go.
    this.throttle = ctrl.throttleAbs != null
      ? clamp(ctrl.throttleAbs, 0, 1)
      : clamp(this.throttle + ctrl.throttle * TUNE.throttleRate * dt, 0, 1);

    const event = this.onGround
      ? this._updateGround(dt, ctrl, world)
      : this._updateAir(dt, ctrl, world);

    // Burn, then recharge. The cooldown only starts once the burn is spent.
    if (this.nitroTime > 0) {
      this.nitroTime = Math.max(0, this.nitroTime - dt);
      if (this.nitroTime === 0) this.nitroCooldown = NITRO.cooldown;
    } else if (this.nitroCooldown > 0) {
      this.nitroCooldown = Math.max(0, this.nitroCooldown - dt);
    }
    const wantBlend = this.nitroTime > 0 ? 1 : 0;
    this.nitroBlend += clamp(wantBlend - this.nitroBlend, -dt / NITRO.ramp, dt / NITRO.ramp);

    // Gear swings toward wherever the lever is.
    const want = this.gearDown ? 1 : 0;
    const travel = dt / TUNE.gearTravel;
    this.gearPos = want > this.gearPos
      ? Math.min(want, this.gearPos + travel)
      : Math.max(want, this.gearPos - travel);
    this._applyGearVisual();

    // Prop disc spins with power; idle still turns so it never looks frozen.
    this.propSpin += (2 + this.throttle * 46) * dt;
    if (this._prop) this._prop.rotation.z = this.propSpin;

    return event;
  }

  _updateGround(dt, ctrl, world) {
    // On the belly there is nothing to roll on and nothing to brake with:
    // the airframe simply scrubs off speed against the tarmac.
    const rolling = this.bellySliding
      ? -TUNE.bellyDrag - TUNE.drag * this.speed * this.speed
      : TUNE.thrust * this.throttle * this._boost
        - TUNE.drag * this.speed * this.speed
        - TUNE.groundDrag
        - (ctrl.brake ? TUNE.brakeDecel : 0);
    this.speed = Math.max(0, this.speed + rolling * dt);

    // Nosewheel steering: both the roll and rudder keys turn you on the ground.
    const steer = clamp(ctrl.roll + ctrl.yaw, -1, 1);
    const grip = clamp(this.speed / 45, 0, 1) * (this.bellySliding ? 0.25 : 1);
    this._rotateLocal(AX.y, -steer * TUNE.groundSteer * grip * dt);

    // Settle the airframe flat while it rolls, keeping only the heading.
    const heading = Math.atan2(-this.forward.x, -this.forward.z);
    Q.b.setFromAxisAngle(AX.y, heading);
    this.quaternion.slerp(Q.b, 1 - Math.exp(-7 * dt));

    const ap = world.airport;
    this.position.addScaledVector(this.forward, this.speed * dt);
    this.position.y = this.bellySliding ? ap.bellyY : ap.surfaceY;
    this._prevPos.copy(this.position);
    this.velocity.copy(this.forward).multiplyScalar(this.speed);

    if (!ap.contains(this.position.x, this.position.z)) {
      return { type: 'crash', reason: 'Ran off the runway' };
    }
    // Nothing to rotate on once you are sliding on the airframe.
    if (this.bellySliding) return null;

    // Rotate: enough speed plus back pressure and the wheels leave the ground.
    if (ctrl.pitch > 0 && this.speed >= TUNE.rotateSpeed) {
      this.onGround = false;
      this.airborneFor = 0;
      this.clearedRunway = false;
      return { type: 'takeoff' };
    }
    return null;
  }

  _updateAir(dt, ctrl, world) {
    this.airborneFor += dt;
    const fwdY = this.forward.y;

    // Tucking the legs away is worth both a cleaner airframe and a little
    // more push; the benefit fades in as the gear travels.
    const tuck = 1 - this.gearPos;
    const drag = TUNE.drag * (1 - tuck * (1 - TUNE.gearDragFactor));
    const thrust = TUNE.thrust * (1 + tuck * (TUNE.gearThrustBonus - 1)) * this._boost;

    // Back-pressure sets the load factor. This is the heart of the handling:
    // banking alone barely turns you, pulling is what bends the flight path,
    // and the induced drag below is what it costs.
    // Quadratic in back-pressure, so easing the nose up in a climb is nearly
    // free while a hard pull is genuinely expensive.
    const pull = clamp(ctrl.pitch, 0, 1);
    const load = 1 + TUNE.pullLoad * pull * pull;

    const accel = thrust * this.throttle
      - drag * this.speed * this.speed
      - TUNE.gravity * fwdY
      - TUNE.turnDrag * (load * load - 1)
      - (ctrl.brake ? TUNE.airbrake : 0);

    // The boost needs headroom above the ordinary ceiling to be worth anything.
    const cap = TUNE.maxSpeed * (1 + this.nitroBlend * (NITRO.speedCapMult - 1));
    this.speed = clamp(this.speed + accel * dt, 0, cap);

    // Everything the wing and tail can do scales with airspeed. Slow, and the
    // aeroplane goes vague long before it stalls.
    const authority = clamp((this.speed - 18) / 75, 0.1, 1);

    this._rotateLocal(AX.x, ctrl.pitch * TUNE.pitchRate * authority * dt);
    this._rotateLocal(AX.y, -ctrl.yaw * TUNE.yawRate * authority * dt);

    // Aileron commands a roll RATE, with no ceiling: hold it and the aeroplane
    // keeps rolling straight through inverted, which is what makes aerobatics
    // possible at all.
    this._rotateLocal(AX.z, -ctrl.roll * TUNE.rollRate * authority * dt);

    // Hands off, it drifts back towards wings-level — gently enough that a
    // bank can be held through a long turn, and never while inverted.
    if (ctrl.roll === 0 && this.up.y > 0) {
      this._rotateLocal(AX.z, -this.bank * TUNE.autoLevel * dt);
    }

    const turn = this._liftTurn(load, authority);
    if (turn) this.quaternion.premultiply(Q.a.setFromAxisAngle(AX.y, turn * dt));

    let sink = 0;
    const mush = clamp(
      1 - (this.speed - TUNE.stall) / (TUNE.mushSpeed - TUNE.stall), 0, 1,
    );
    if (mush > 0) {
      sink += mush * TUNE.mushSink;
      this._rotateLocal(AX.x, -mush * TUNE.mushPitchDown * dt);
    }
    // Below the stall the nose drops hard enough to beat the player's own
    // back-pressure, otherwise it can hang nose-up at zero speed for ever.
    if (this.speed < TUNE.stall) {
      const deficit = 1 - this.speed / TUNE.stall;
      sink += deficit * TUNE.stallSink;
      this._rotateLocal(AX.x, -deficit * TUNE.stallPitchDown * dt);
    }

    this.velocity.copy(this.forward).multiplyScalar(this.speed);
    this.velocity.y -= sink;
    this._prevPos.copy(this.position);
    this.position.addScaledVector(this.velocity, dt);

    return this._checkContact(world);
  }

  /**
   * Turn rate from lift.
   *
   * Lift acts out of the top of the wing; whatever part of it ends up
   * horizontal is what drags the nose round. Deriving it from the lift vector
   * rather than from a bank angle means it stays correct inverted and at 90
   * degrees of bank, where an asin(bank) formula falls apart.
   *
   * @returns {number} rad/s about world up, positive to the left
   */
  _liftTurn(load, authority) {
    const up = this.up;          // V.up
    const f = this.forward;      // V.fwd — a different scratch vector
    const hLen = Math.hypot(f.x, f.z);
    if (hLen < 0.05) return 0;   // pointing straight up or down: no heading

    const fhx = f.x / hLen, fhz = f.z / hLen;
    const lateral = up.x * fhz - up.z * fhx;   // horizontal lift, left positive

    // authority^2, so a slow aeroplane turns lazily as well as vaguely.
    // Split into a 1g term and a per-g term so the two can be tuned apart:
    // how much a bank alone turns you, and how much pulling adds to it.
    const coupling = TUNE.turnBank + TUNE.turnLoad * (load - 1);
    const rate = (coupling * lateral * authority * authority)
      / Math.max(this.speed, 30);
    return clamp(rate, -TUNE.maxTurnRate, TUNE.maxTurnRate);
  }

  /**
   * Resolves ground contact over the path travelled this step.
   *
   * Sweeping rather than testing the end point alone matters twice over: a
   * fast aeroplane can cross several units in a frame, and — whatever the
   * outcome — the aeroplane is snapped onto the surface rather than left
   * inside it. Nothing in here may exit leaving the aeroplane underground.
   */
  _checkContact(world) {
    const ap = world.airport;
    const from = this._prevPos;
    const to = this.position;

    const steps = Math.max(1, Math.ceil(from.distanceTo(to) / 2));
    let x = to.x, y = to.y, z = to.z;

    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      x = from.x + (to.x - from.x) * t;
      y = from.y + (to.y - from.y) * t;
      z = from.z + (to.z - from.z) * t;

      if (ap.contains(x, z)) {
        const gap = y - ap.surfaceY;
        if (gap > TUNE.clearedHeight) this.clearedRunway = true;
        if (gap > TUNE.clearance) continue;
        if (gap > 0 && this.velocity.y >= 0) continue; // low pass, still flying

        // The tarmac is solid whether or not this counts as a landing.
        if (gap <= 0) {
          this.position.set(x, ap.surfaceY, z);
          this.velocity.y = 0;
        }

        // You cannot land until you have actually left. Without this, the
        // frames just after rotation — wheels a hair off the tarmac, wing
        // coming up into the first turn — are judged as an arrival.
        if (!this.clearedRunway || this.airborneFor < TUNE.takeoffGrace) return null;
        return ap.evaluateTouchdown(this);
      }

      if (y <= TUNE.waterline) {
        this.position.set(x, TUNE.waterline, z);
        this.velocity.set(0, 0, 0);
        return { type: 'crash', reason: 'Ditched in the sea' };
      }

      const ground = world.heightAt(x, z);
      if (y - ground <= TUNE.clearance) {
        this.position.set(x, ground + TUNE.clearance, z);
        this.velocity.set(0, 0, 0);
        return { type: 'crash', reason: 'Flew into terrain' };
      }
    }
    return null;
  }

  /** Called by the airport once a touchdown has been accepted. */
  settleOnRunway(surfaceY) {
    this.onGround = true;
    this.bellySliding = false;
    this.position.y = surfaceY;
    this._prevPos.copy(this.position);
    this.velocity.y = 0;
  }

  /** Called by the airport when the aeroplane arrives with the gear up. */
  settleOnBelly(bellyY) {
    this.onGround = true;
    this.bellySliding = true;
    this.throttle = 0;
    this.position.y = bellyY;
    this._prevPos.copy(this.position);
    this.velocity.y = 0;
  }

  _applyGearVisual() {
    if (!this._gear) return;
    const p = this.gearPos;
    this._gear.visible = p > 0.02;
    this._gear.position.y = (1 - p) * 1.9;   // swings up into the wing root
    this._gear.scale.setScalar(0.15 + 0.85 * p);
  }
}

// ---------------------------------------------------------------------------
// Model: a handful of flat-shaded primitives. Nose points down -Z.
// ---------------------------------------------------------------------------
function buildModel(palette) {
  const g = new THREE.Group();
  const mat = (color, opts = {}) =>
    new THREE.MeshLambertMaterial({ color, flatShading: true, ...opts });

  const body = mat(palette.body);
  const accent = mat(palette.accent);
  const dark = mat(0x2b3138);

  // Fuselage — a six-sided tube reads as low-poly rather than as a cylinder.
  const fuselage = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.25, 8, 6), body);
  fuselage.rotation.x = Math.PI / 2;
  g.add(fuselage);

  const nose = new THREE.Mesh(new THREE.ConeGeometry(1.25, 2.6, 6), body);
  nose.rotation.x = -Math.PI / 2;
  nose.position.z = -5.3;
  g.add(nose);

  const spinner = new THREE.Mesh(new THREE.ConeGeometry(0.42, 1, 6), accent);
  spinner.rotation.x = -Math.PI / 2;
  spinner.position.z = -6.9;
  g.add(spinner);

  // Propeller: blades plus a faint disc, so it blurs the way a real one does.
  const prop = new THREE.Group();
  prop.name = 'prop';
  prop.position.z = -6.6;
  for (let i = 0; i < 2; i++) {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.28, 5.4, 0.12), dark);
    blade.rotation.z = i * Math.PI;
    prop.add(blade);
  }
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(2.7, 16),
    new THREE.MeshBasicMaterial({
      color: 0xdfe8ee, transparent: true, opacity: 0.12, side: THREE.DoubleSide,
    }),
  );
  prop.add(disc);
  g.add(prop);

  const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.95, 8, 6), mat(0x8fd8f2, {
    transparent: true, opacity: 0.55,
  }));
  canopy.scale.set(1, 0.8, 1.9);
  canopy.position.set(0, 0.85, -0.6);
  g.add(canopy);

  const wing = new THREE.Mesh(new THREE.BoxGeometry(17, 0.35, 3.1), body);
  wing.position.set(0, 0.25, 0.2);
  g.add(wing);

  const gear = new THREE.Group();
  gear.name = 'gear';
  for (const s of [-1, 1]) {
    const tip = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.34, 2.2), accent);
    tip.position.set(s * 8, 0.25, 0.2);
    g.add(tip);
    const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 1.6, 5), dark);
    strut.position.set(s * 3.2, -1.3, 0.4);
    gear.add(strut);
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.52, 0.52, 0.3, 8), dark);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(s * 3.2, -2.1, 0.4);
    gear.add(wheel);
  }
  g.add(gear);

  const tailplane = new THREE.Mesh(new THREE.BoxGeometry(6.4, 0.28, 1.7), body);
  tailplane.position.set(0, 0.5, 3.6);
  g.add(tailplane);

  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.3, 2.6, 2.1), accent);
  fin.position.set(0, 1.7, 3.7);
  g.add(fin);

  // The whole airframe sits so the wheels touch y = -2.4.
  g.traverse((o) => { o.castShadow = false; o.receiveShadow = false; });
  return g;
}
