// Chase and cockpit cameras.
//
// The chase camera only partly inherits the aeroplane's roll. Fully following
// it spins the horizon and makes people ill; ignoring it entirely makes banked
// turns feel weightless. Somewhere near a third is the sweet spot.

import * as THREE from 'three';

const CHASE_OFFSET = new THREE.Vector3(0, 4.2, 19);
const COCKPIT_OFFSET = new THREE.Vector3(0, 1.5, -1.2);
const ROLL_FOLLOW = 0.35;
const LOOK_AHEAD = 26;

const BASE_FOV = 66;
const MAX_FOV = 82;   // creeps up with speed so fast feels fast

export class ChaseCamera {
  constructor(camera) {
    this.camera = camera;
    this.mode = 'chase';
    this._pos = new THREE.Vector3();
    this._look = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this._tmp = new THREE.Vector3();
    this._shake = 0;
    this._started = false;
  }

  toggle() {
    this.mode = this.mode === 'chase' ? 'cockpit' : 'chase';
    this._started = false; // snap rather than sweep across the swap
  }

  /** Kick the camera on impact. */
  shake(amount = 1) { this._shake = Math.max(this._shake, amount); }

  snap() { this._started = false; }

  update(dt, plane, speedRatio) {
    const cam = this.camera;
    const q = plane.quaternion;

    if (this.mode === 'cockpit') {
      this._pos.copy(COCKPIT_OFFSET).applyQuaternion(q).add(plane.position);
      cam.position.copy(this._pos);
      cam.quaternion.copy(q);
    } else {
      // Desired seat: behind and above, in the aeroplane's frame.
      this._pos.copy(CHASE_OFFSET).applyQuaternion(q).add(plane.position);

      // Frame-rate independent smoothing.
      const k = 1 - Math.exp(-7 * dt);
      if (!this._started) {
        cam.position.copy(this._pos);
        this._started = true;
      } else {
        cam.position.lerp(this._pos, k);
      }

      // Look at a point ahead of the nose, not at the aeroplane itself.
      this._look.copy(plane.forward).multiplyScalar(LOOK_AHEAD).add(plane.position);

      // Blend the aeroplane's up-vector toward world up.
      this._tmp.set(0, 1, 0).applyQuaternion(q);
      this._up.set(0, 1, 0).lerp(this._tmp, ROLL_FOLLOW).normalize();
      cam.up.copy(this._up);
      cam.lookAt(this._look);
    }

    if (this._shake > 0.001) {
      const s = this._shake * 2.4;
      cam.position.x += (Math.random() - 0.5) * s;
      cam.position.y += (Math.random() - 0.5) * s;
      cam.position.z += (Math.random() - 0.5) * s;
      this._shake *= Math.exp(-4 * dt);
    }

    const wantFov = BASE_FOV + (MAX_FOV - BASE_FOV) * Math.min(1, speedRatio);
    cam.fov += (wantFov - cam.fov) * (1 - Math.exp(-3 * dt));
    cam.updateProjectionMatrix();
  }
}
