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
  turnG: 20,           // coordinated turn: omega = turnG * tan(bank) / speed
  bankLimit: 1.26,     // 72deg — holding aileron settles here instead of rolling
  maxTurnRate: 1.0,    // rad/s ceiling, so a slow tight turn can't spin
  autoLevel: 1.3,      // wings return to level when you let go
  throttleRate: 0.55,  // full travel in ~1.8s
  rotateSpeed: 55,     // runway speed at which the nose will lift
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

// Nitro. The multiplier is on THRUST, not on speed: tripling the speed
// outright would put the aeroplane at ~390kt, far too fast to thread a gate or
// to stop before the end of the runway. Tripling the push gives a hard, very
// visible surge to roughly 1.7x cruise, which is the part that feels good.
export const NITRO = {
  thrustMult: 3,
  speedCapMult: 1.45,  // the ordinary ceiling would otherwise swallow the boost
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
    this.throttle = clamp(this.throttle + ctrl.throttle * TUNE.throttleRate * dt, 0, 1);

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

    const accel = thrust * this.throttle
      - drag * this.speed * this.speed
      - TUNE.gravity * fwdY
      - (ctrl.brake ? TUNE.airbrake : 0);

    // The boost needs headroom above the ordinary ceiling to be worth anything.
    const cap = TUNE.maxSpeed * (1 + this.nitroBlend * (NITRO.speedCapMult - 1));
    this.speed = clamp(this.speed + accel * dt, 0, cap);

    // Controls go soft as the airflow dies, which is what makes a stall read.
    const authority = clamp((this.speed - 10) / 48, 0.12, 1);

    this._rotateLocal(AX.x, ctrl.pitch * TUNE.pitchRate * authority * dt);
    this._rotateLocal(AX.y, -ctrl.yaw * TUNE.yawRate * authority * dt);

    const upright = this.up.y > 0;
    const phi = Math.asin(clamp(this.bank, -1, 1)); // bank angle, + is left wing up

    // Aileron sets a bank angle rather than spinning the aeroplane. Resistance
    // builds as the bank approaches the limit, so holding the key settles into
    // a steady carving turn — the single biggest thing that makes this feel
    // like flying rather than fighting. Inverted, the limiter lets go so you
    // can always roll back upright.
    let rollRate = -ctrl.roll * TUNE.rollRate * authority;
    if (upright && rollRate !== 0 && Math.sign(rollRate) === Math.sign(phi)) {
      const t = Math.min(1, Math.abs(phi) / TUNE.bankLimit);
      rollRate *= 1 - t * t * t;
    }
    this._rotateLocal(AX.z, rollRate * dt);

    // Wings self-centre when the player lets go — but never while inverted,
    // so a deliberate roll isn't fought by the autopilot.
    if (ctrl.roll === 0 && upright) {
      this._rotateLocal(AX.z, -this.bank * TUNE.autoLevel * dt);
    }

    // Coordinated turn: banking tips the lift vector sideways and the nose
    // follows. Tightens as you slow down, exactly as it should.
    if (upright) {
      const turn = clamp(
        (TUNE.turnG * Math.tan(phi)) / Math.max(this.speed, 30),
        -TUNE.maxTurnRate, TUNE.maxTurnRate,
      );
      this.quaternion.premultiply(Q.a.setFromAxisAngle(AX.y, turn * dt));
    }

    // Too slow: the nose drops hard and you sink until the speed comes back.
    // The pitch-down has to beat the player's own back-pressure, otherwise the
    // aeroplane can hang nose-up at zero speed and never recover.
    let sink = 0;
    if (this.speed < TUNE.stall) {
      const deficit = 1 - this.speed / TUNE.stall;
      sink = deficit * 45;
      this._rotateLocal(AX.x, -deficit * 2.5 * dt);
    }

    this.velocity.copy(this.forward).multiplyScalar(this.speed);
    this.velocity.y -= sink;
    this._prevPos.copy(this.position);
    this.position.addScaledVector(this.velocity, dt);

    return this._checkContact(world);
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
