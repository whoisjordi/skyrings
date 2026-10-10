// Replay cameras: behind (the game's own), side, above, and a TV-style flyby
// that cuts between fixed spots the aeroplane flies past.
//
// The flyby spots are not placed by hand. A hand-placed spot only works for
// the line its author had in mind, and a replay is whatever route you flew.
// Instead each shot is planned from the recording itself: for the stretch of
// path the shot covers, a ring of candidate spots beside and ahead of it is
// tried, and each is scored by how much of that stretch it can actually see —
// sight lines tested against the terrain's height field and against the
// level's solid props (buildings, trees). A tower may hide the aeroplane for a
// moment; a spot that loses it for most of the shot is never chosen.

import * as THREE from 'three';
import { sample } from './replay.js';

export const REPLAY_VIEWS = ['chase', 'side', 'above', 'flyby'];
export const VIEW_LABEL = { chase: 'Behind', side: 'Side', above: 'Above', flyby: 'Flyby' };

export const SHOT = 4;          // seconds per flyby shot
const PROBES = 10;              // aeroplane positions checked per shot
const SIGHT_STEP = 5;           // metres between points on a sight line
const NEAR_PLANE = 8;           // the last metres before the aeroplane are its own
const ALONG = [0.5, 0.7];       // where beside the stretch the camera stands
const SIDE = [45, 80, 130];     // how far off the path
const RISE = [3, 18, 45];       // and how far above it
const GOOD_ENOUGH = 0.95;       // stop searching once a spot sees this much

const _p = { x: 0, y: 0, z: 0 }, _q = { x: 0, y: 0, z: 0, w: 1 };

/**
 * True when nothing solid lies on the straight line from a to b. The last few
 * metres are skipped: that is where the aeroplane itself is, and on the
 * runway it sits on the ground the line ends in.
 */
export function sightClear(world, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const len = Math.hypot(dx, dy, dz);
  const end = len - NEAR_PLANE;
  for (let s = 2; s < end; s += SIGHT_STEP) {
    const k = s / len;
    const x = a.x + dx * k, y = a.y + dy * k, z = a.z + dz * k;
    if (y < world.heightAt(x, z) + 0.5) return false;
    if (world.props && world.props.collides(x, y, z, 0)) return false;
  }
  return true;
}

/**
 * Plans flyby shots lazily, one per SHOT seconds of the recording, and keeps
 * them: seeking back finds the same spot again.
 */
export function createFlybyPlanner(track, world) {
  const shots = [];
  const count = Math.max(1, Math.ceil(track.time / SHOT));

  function plan(i) {
    const t0 = i * SHOT, t1 = Math.min(track.time, t0 + SHOT);
    const probes = [];
    for (let k = 0; k <= PROBES; k++) {
      sample(track, t0 + (t1 - t0) * k / PROBES, _p, _q);
      probes.push({ x: _p.x, y: _p.y, z: _p.z });
    }
    // Direction of travel over the stretch, flattened. A stopped aeroplane has
    // none, so fall back to where its nose points.
    let fx = probes[PROBES].x - probes[0].x, fz = probes[PROBES].z - probes[0].z;
    if (Math.hypot(fx, fz) < 5) {
      sample(track, t0, _p, _q);
      const v = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion(_q.x, _q.y, _q.z, _q.w));
      fx = v.x; fz = v.z;
    }
    const fl = Math.hypot(fx, fz) || 1;
    fx /= fl; fz /= fl;

    // Alternate sides from shot to shot when it costs nothing: crossing the
    // line every cut is what makes a flyby feel like television.
    const prevSide = i > 0 && shots[i - 1] ? shots[i - 1].side : 0;

    let best = null;
    search:
    for (const along of ALONG) {
      const anchor = probes[Math.round(along * PROBES)];
      for (const side of SIDE) {
        for (const sgn of prevSide > 0 ? [-1, 1] : [1, -1]) {
          for (const rise of RISE) {
            const x = anchor.x - fz * side * sgn + fx * side * 0.35;
            const z = anchor.z + fx * side * sgn + fz * side * 0.35;
            const ground = world.heightAt(x, z);
            const y = Math.max(anchor.y + rise, ground + 3);
            const cam = { x, y, z };
            if (world.props && world.props.collides(x, y, z, 4)) continue;
            let seen = 0;
            for (const p of probes) if (sightClear(world, cam, p)) seen++;
            const vis = seen / probes.length;
            // Visibility first; then a slight pull towards the near, low spots,
            // which look fast, and towards switching sides.
            const score = vis - side / 2000 - rise / 1500 + (sgn !== prevSide ? 0.02 : 0);
            if (!best || score > best.score) best = { t0, t1, x, y, z, vis, side: sgn, score };
            if (vis >= GOOD_ENOUGH && sgn !== prevSide) break search;
          }
        }
      }
    }
    return best;
  }

  return {
    count,
    /** The shot covering time t, planned on first use. */
    at(t) {
      const i = Math.max(0, Math.min(count - 1, Math.floor(t / SHOT)));
      for (let j = 0; j <= i; j++) if (!shots[j]) shots[j] = plan(j);
      return shots[i];
    },
  };
}

/**
 * Drives the scene camera through a replay in one of REPLAY_VIEWS. 'chase'
 * hands over to the game's ChaseCamera so it looks exactly like flying.
 */
export class ReplayCamera {
  constructor(camera, chase, track, world) {
    this.camera = camera;
    this.chase = chase;
    this.world = world;
    this.flyby = createFlybyPlanner(track, world);
    this.view = 'chase';
    this._pos = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._want = new THREE.Vector3();
    this._offset = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._side = 1;
    this._shot = null;
    this._started = false;
  }

  setView(view) {
    this.view = view;
    this.snap();
  }

  /** Jump rather than glide, after a seek or a change of view. */
  snap() {
    this._started = false;
    this._shot = null;
    this.chase.snap();
  }

  update(dt, plane, t, speedRatio) {
    const cam = this.camera;
    if (this.view === 'chase') {
      this.chase.update(dt, plane, speedRatio, 0);
      return;
    }

    // Heading only: the side and top cameras stay level however the
    // aeroplane banks.
    const f = this._fwd.set(0, 0, -1).applyQuaternion(plane.quaternion);
    f.y = 0;
    if (f.lengthSq() < 1e-6) f.set(0, 0, -1);
    f.normalize();
    const p = plane.position;
    let fov = 60;

    if (this.view === 'flyby') {
      const shot = this.flyby.at(t);
      if (shot !== this._shot) { this._shot = shot; this._started = false; }
      this._pos.set(shot.x, shot.y, shot.z);
      // Zoom like a camera operator: keep the aeroplane about the same size
      // on screen however far it is.
      fov = THREE.MathUtils.clamp(2 * Math.atan(16 / this._pos.distanceTo(p)) * 180 / Math.PI, 10, 65);
    } else {
      // The seat is an offset from the aeroplane, and only the offset is
      // smoothed. Easing the position itself would leave the camera trailing
      // a dozen metres behind at full speed.
      const want = this._want;
      if (this.view === 'side') {
        // Off the wingtip and a touch ahead. If a wall is in the way and the
        // other side is clear, cross over.
        const seat = (s) => want.set(-f.z * 40 * s + f.x * 5, 3, f.x * 40 * s + f.z * 5);
        seat(this._side);
        if (!this._clear(this._tmp.copy(p).add(want), p)) {
          seat(-this._side);
          if (this._clear(this._tmp.copy(p).add(want), p)) { this._side = -this._side; this._started = false; }
          else seat(this._side);
        }
        fov = 50;
      } else {
        // High and well behind, looking down the route ahead: the aeroplane
        // with the gates and streets it is heading into.
        want.set(-f.x * 150, 110, -f.z * 150);
        fov = 55;
      }
      if (this._started) this._offset.lerp(want, 1 - Math.exp(-4 * dt));
      else this._offset.copy(want);
      this._pos.copy(p).add(this._offset);
    }

    // Never under the ground.
    const floor = this.world.heightAt(this._pos.x, this._pos.z) + 2;
    if (this._pos.y < floor) this._pos.y = floor;

    if (!this._started) {
      cam.fov = fov;
      this._started = true;
    }
    cam.position.copy(this._pos);
    cam.fov += (fov - cam.fov) * (1 - Math.exp(-5 * dt));
    cam.up.set(0, 1, 0);
    cam.lookAt(p);
    cam.updateProjectionMatrix();
  }

  _clear(a, b) { return sightClear(this.world, a, b); }
}
