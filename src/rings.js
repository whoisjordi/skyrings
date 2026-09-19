// The route: a smooth circuit of gates that always starts off the departure
// end of the runway and finishes lined up to come home.

import * as THREE from 'three';
import { WORLD_SIZE } from './terrain.js';

const TUBE = 2.6;
const MIN_CLEARANCE = 80;   // never place a gate inside a hill
const ONE = new THREE.Vector3(1, 1, 1);

/**
 * Lifts gates until the straight line between every consecutive pair clears
 * the ground. Placing gates above terrain is not enough on its own — players
 * fly straight at the next gate, so it is the legs between them that have to
 * be clear, or a level turns into an invisible wall.
 *
 * The first and last points are the runway itself and cannot move, so their
 * legs are fixed by lifting the gate at the other end instead.
 *
 * @param {THREE.Vector3[]} points path flown: runway, each gate, runway
 */
const CLEARANCE_RAMP = 800; // distance over which the runway legs earn height

function raiseForClearance(points, heightAt, clearance) {
  const last = points.length - 1;
  const pinned = (i) => i === 0 || i === last;

  for (let pass = 0; pass < 8; pass++) {
    let worstOverall = 0;

    for (let i = 0; i < last; i++) {
      const a = points[i], b = points[i + 1];
      if (pinned(i) && pinned(i + 1)) continue;

      const len = a.distanceTo(b);
      const steps = Math.max(8, Math.ceil(len / 60));
      const rampA = pinned(i), rampB = pinned(i + 1);

      let deficit = 0, at = 0.5;
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;

        // Next to the runway the aeroplane is *meant* to be near the ground,
        // so the requirement ramps in. Demanding full clearance at t=0 makes
        // every pass shove the far gate skyward — it never converges.
        let required = clearance;
        if (rampA) required = Math.min(required, clearance * Math.min(1, (t * len) / CLEARANCE_RAMP));
        if (rampB) required = Math.min(required, clearance * Math.min(1, ((1 - t) * len) / CLEARANCE_RAMP));

        const need = heightAt(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t)
          + required - (a.y + (b.y - a.y) * t);
        if (need > deficit) { deficit = need; at = t; }
      }
      if (deficit <= 0) continue;
      worstOverall = Math.max(worstOverall, deficit);

      // Raising one end only tilts the line, so the free end has to come up by
      // more than the shortfall — capped, so a violation near a pinned end
      // cannot run away.
      const boost = (f) => Math.min(deficit / Math.max(f, 0.35), deficit * 3);
      if (rampA) b.y += boost(at);
      else if (rampB) a.y += boost(1 - at);
      else { a.y += deficit; b.y += deficit; }
    }
    if (worstOverall < 1) break; // converged
  }
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Lays out gate positions as a curve looping away from the airport and back.
 * @returns {{position:THREE.Vector3, quaternion:THREE.Quaternion}[]}
 */
export function buildRoute(cfg, airport, heightAt) {
  const rnd = mulberry32((cfg.seed ^ 0x9e3779b9) >>> 0);
  const { count, radius, altitude, spread } = cfg.route;
  const limit = WORLD_SIZE * 0.42;

  // Control points: climb out along the runway heading, sweep a loop around
  // the island, then return to a downwind position abeam the field.
  const pts = [];
  const climbOut = airport.center.clone().addScaledVector(airport.axis, 900);
  climbOut.y = airport.center.y + altitude * 0.55;
  pts.push(climbOut);

  const turns = Math.PI * 2 * 1.15;
  const dir = rnd() < 0.5 ? 1 : -1;
  const startAngle = Math.atan2(climbOut.z, climbOut.x);

  for (let i = 0; i < count; i++) {
    const t = (i + 1) / (count + 1);
    const ang = startAngle + dir * turns * t;
    const r = radius * (0.7 + 0.6 * rnd()) * (0.85 + 0.3 * Math.sin(t * Math.PI));
    const p = new THREE.Vector3(
      Math.cos(ang) * Math.min(r, limit),
      airport.center.y + altitude * (0.5 + rnd() * spread),
      Math.sin(ang) * Math.min(r, limit),
    );
    pts.push(p);
  }

  // Finish on a long final so the last gate points at the runway.
  const final = airport.center.clone().addScaledVector(airport.axis, -1700);
  final.y = airport.center.y + altitude * 0.4;
  pts.push(final);

  for (const p of pts) {
    p.y = Math.max(p.y, heightAt(p.x, p.z) + MIN_CLEARANCE);
  }

  const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5);

  // Sample the gates off the curve, then treat the whole thing as the polyline
  // the player will actually fly: climb-out, every gate, then final approach.
  const positions = [];
  for (let i = 0; i < count; i++) {
    positions.push(curve.getPointAt((i + 1) / (count + 1)));
  }

  // The path the player actually flies is runway -> every gate -> runway, so
  // that is what has to be clear. The runway ends are pinned to the ground.
  const field = airport.center.clone();
  const path = [field, ...positions, field.clone()];
  raiseForClearance(path, heightAt, MIN_CLEARANCE);

  // Orient each gate along the corrected path, not the original curve, so the
  // hoop faces the way the player arrives after the clearance pass moved it.
  const gates = [];
  const up = new THREE.Vector3(0, 1, 0);
  const m = new THREE.Matrix4();
  const tangent = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    const position = path[i + 1];
    tangent.subVectors(path[i + 2], path[i]).normalize();
    m.lookAt(position, tangent.add(position), up);
    gates.push({ position, quaternion: new THREE.Quaternion().setFromRotationMatrix(m) });
  }
  return gates;
}

export class RingSet {
  constructor(cfg, gates) {
    this.group = new THREE.Group();
    this.radius = cfg.route.ringRadius;
    this.index = 0;
    this.total = gates.length;
    this.rings = [];
    this._prev = new THREE.Vector3();
    this._a = new THREE.Vector3();
    this._b = new THREE.Vector3();
    this._hasPrev = false;
    this._clock = 0;

    const geo = new THREE.TorusGeometry(this.radius, TUBE, 6, 20);
    const discGeo = new THREE.CircleGeometry(this.radius - TUBE, 20);

    for (const gate of gates) {
      const ring = new THREE.Group();
      ring.position.copy(gate.position);
      ring.quaternion.copy(gate.quaternion);

      const torus = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xffffff }));
      const disc = new THREE.Mesh(discGeo, new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.1, side: THREE.DoubleSide,
        depthWrite: false,
      }));
      ring.add(torus, disc);

      // Fixed world->gate transform for the crossing test. Deliberately NOT
      // derived from matrixWorld: the gate pulses, and a scaled local space
      // would quietly shrink the hit radius along with it.
      const inv = new THREE.Matrix4()
        .compose(gate.position, gate.quaternion, ONE)
        .invert();

      ring.userData = { torus, disc, inv };
      this.rings.push(ring);
      this.group.add(ring);
    }
    this._paint();
  }

  get done() { return this.index >= this.total; }
  get next() { return this.done ? null : this.rings[this.index]; }

  _paint() {
    this.rings.forEach((ring, i) => {
      const { torus, disc } = ring.userData;
      if (i !== this.index) torus.scale.setScalar(1); // clear any leftover pulse
      if (i < this.index) {
        torus.material.color.set(0x4caf6d);
        torus.material.opacity = 0.45;
        torus.material.transparent = true;
        disc.visible = false;
      } else if (i === this.index) {
        torus.material.color.set(0x5ad1ff);
        torus.material.transparent = false;
        torus.material.opacity = 1;
        disc.visible = true;
        disc.material.opacity = 0.14;
      } else {
        torus.material.color.set(0x9fb6c2);
        torus.material.transparent = true;
        torus.material.opacity = 0.32;
        disc.visible = false;
      }
    });
  }

  /**
   * @returns {boolean} true on the frame the active gate is flown through.
   */
  update(dt, planePos) {
    this._clock += dt;

    const active = this.next;
    if (active) {
      // Breathe the active gate so it reads at distance. Only the children
      // scale, so the gate's own transform stays clean.
      const pulse = Math.sin(this._clock * 3);
      const { torus, disc } = active.userData;
      torus.scale.setScalar(1 + pulse * 0.04);
      disc.material.opacity = 0.1 + pulse * 0.05;
    }

    if (!this._hasPrev) {
      this._prev.copy(planePos);
      this._hasPrev = true;
      return false;
    }

    let hit = false;
    if (active) {
      // Crossing test in gate-local space: the gate plane is local z = 0.
      const now = this._a.copy(planePos).applyMatrix4(active.userData.inv);
      const before = this._b.copy(this._prev).applyMatrix4(active.userData.inv);

      if (Math.sign(before.z) !== Math.sign(now.z)) {
        // Interpolate to the exact crossing point before the radius test, so
        // a fast pass can't tunnel through the plane between frames.
        const t = before.z / (before.z - now.z);
        const cx = before.x + (now.x - before.x) * t;
        const cy = before.y + (now.y - before.y) * t;
        if (Math.hypot(cx, cy) <= this.radius) {
          this.index++;
          this._paint();
          hit = true;
        }
      }
    }

    this._prev.copy(planePos);
    return hit;
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
  }
}
