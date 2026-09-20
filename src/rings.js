// The route: a smooth circuit of gates that always starts off the departure
// end of the runway and finishes lined up to come home.

import * as THREE from 'three';
import { WORLD_SIZE } from './terrain.js';

const TUBE = 2.6;
const MIN_CLEARANCE = 80;   // never place a gate inside a hill
const ONE = new THREE.Vector3(1, 1, 1);

const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

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
// Height lost per unit travelled on final. The touchdown limit is 15 units/s
// at roughly 95kt, so anything past this arrives as a crash.
const MAX_APPROACH_GRADIENT = 0.135;

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

/**
 * Walks a curve and drops a gate whenever the path has either turned enough or
 * run far enough since the last one.
 *
 * Turning is what triggers most of them: a long bend comes out with several
 * gates through it, each rotated a little further round, so the next gate is
 * always in view from the one before instead of hiding off the side of the
 * screen behind you.
 *
 * @param {THREE.Curve} curve
 * @param {{maxTurn:number, maxSpacing:number, minSpacing:number}} opts degrees/units
 * @returns {THREE.Vector3[]}
 */
function sampleAdaptive(curve, { maxTurn, maxSpacing, minSpacing }) {
  const N = 600;
  const pts = [];
  for (let i = 0; i <= N; i++) pts.push(curve.getPointAt(i / N));

  const tangent = (i) => new THREE.Vector3()
    .subVectors(pts[Math.min(N, i + 1)], pts[Math.max(0, i - 1)])
    .normalize();

  const cosMax = Math.cos((maxTurn * Math.PI) / 180);
  const out = [pts[0]];
  let last = 0;

  for (let i = 1; i < N; i++) {
    const gap = pts[i].distanceTo(pts[last]);
    if (gap < minSpacing) continue;          // never bunch gates on a tight corner
    if (gap >= maxSpacing || tangent(last).dot(tangent(i)) < cosMax) {
      out.push(pts[i]);
      last = i;
    }
  }
  out.push(pts[N]);

  // A runt final leg reads as a mistake; fold it into the one before.
  if (out.length > 2
      && out[out.length - 1].distanceTo(out[out.length - 2]) < minSpacing) {
    out.splice(out.length - 2, 1);
  }
  return out;
}

/** Faces each gate along the path, using its neighbours on either side. */
function orient(positions, entryDir, exitDir) {
  const up = new THREE.Vector3(0, 1, 0);
  const m = new THREE.Matrix4();
  const dir = new THREE.Vector3();
  return positions.map((position, i) => {
    if (i === 0 && entryDir) dir.copy(entryDir);
    else if (i === positions.length - 1 && exitDir) dir.copy(exitDir);
    else {
      const a = positions[Math.max(0, i - 1)];
      const b = positions[Math.min(positions.length - 1, i + 1)];
      dir.subVectors(b, a);
    }
    dir.normalize();
    m.lookAt(position, dir.clone().add(position), up);
    return { position, quaternion: new THREE.Quaternion().setFromRotationMatrix(m) };
  });
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
 * Lays out an open-country route: straight off the departure end, a loop over
 * the island, then back onto final approach.
 *
 * The first gate is deliberately placed on the runway centreline rather than
 * sampled off the curve — otherwise it can end up almost abeam the field, and
 * you climb away with nothing in front of you.
 *
 * @returns {{position:THREE.Vector3, quaternion:THREE.Quaternion}[]}
 */
export function buildRoute(cfg, airport, heightAt) {
  const rnd = mulberry32((cfg.seed ^ 0x9e3779b9) >>> 0);
  const { count, radius, altitude, spread, spacing, maxTurn } = cfg.route;
  const limit = WORLD_SIZE * 0.42;
  const base = airport.center;
  const axis = airport.axis;

  // Keep control points on the island; the map runs out before the mesh does.
  const inMap = (p) => {
    const d = Math.hypot(p.x, p.z);
    if (d > limit) { p.x *= limit / d; p.z *= limit / d; }
    return p;
  };

  const dirSign = rnd() < 0.5 ? 1 : -1;
  const perp = new THREE.Vector3(-axis.z, 0, axis.x).multiplyScalar(dirSign);

  const departAt = cfg.route.departAt ?? 900;
  const joinR = cfg.route.joinRadius ?? 700;

  // Straight off the departure end.
  const depart = base.clone().addScaledVector(axis, departAt);
  depart.y = base.y + altitude * 0.45;
  const pts = [depart];

  // Crosswind turn, as an explicit arc.
  //
  // You cannot leave the runway radially and join a circuit tangentially
  // without turning through ninety degrees somewhere; the only question is
  // over what distance. Left to a spiral the turn comes out with a radius
  // around 250, which packs the whole ninety degrees between two gates. An
  // arc of a known radius spreads it over ~1100 units instead, so the sampler
  // can lay three or four gates through it, each rotated a little further.
  const JOIN_STEPS = 5;
  for (let k = 1; k <= JOIN_STEPS; k++) {
    const a = (Math.PI / 2) * (k / JOIN_STEPS);
    const p = depart.clone()
      .addScaledVector(perp, joinR * (1 - Math.cos(a)))
      .addScaledVector(axis, joinR * Math.sin(a));
    p.y = base.y + altitude * (0.45 + 0.12 * (k / JOIN_STEPS));
    pts.push(inMap(p));
  }

  // The circuit picks up where the turn left off, so its radius and start
  // angle are read off the join rather than guessed.
  const joinEnd = pts[pts.length - 1];
  const r0 = Math.hypot(joinEnd.x - base.x, joinEnd.z - base.z);
  const ang0 = Math.atan2(joinEnd.z - base.z, joinEnd.x - base.x);
  const startAngle = Math.atan2(axis.z, axis.x);

  const finalAt = cfg.route.finalAt ?? 1300;
  // The circuit finishes further out than the approach gate, so the last leg
  // runs inbound. Ending inside it leaves a 180 to fly, and no amount of extra
  // gates makes a reversal read as "the next one is ahead of you".
  const approachR = finalAt + 550;

  // Sweep the rest of the way round to the approach side.
  const swept = dirSign * (ang0 - startAngle);
  const remaining = Math.PI + Math.PI * 2 * (cfg.route.loops ?? 0) - swept;

  for (let i = 1; i <= count; i++) {
    const t = i / count;
    const ang = ang0 + dirSign * remaining * t;
    const wobble = radius * (0.9 + 0.2 * rnd()) * (0.94 + 0.12 * Math.sin(t * Math.PI));
    let r = lerp(r0, wobble, smoothstep(0, 0.25, t));
    r = lerp(r, approachR, smoothstep(0.78, 0.95, t));
    pts.push(inMap(new THREE.Vector3(
      base.x + Math.cos(ang) * r,
      base.y + altitude * (0.5 + rnd() * spread),
      base.z + Math.sin(ang) * r,
    )));
  }

  // Shallow enough that the descent from the last gate to the threshold stays
  // inside the touchdown limit: roughly 15 units/s at approach speed.
  const finalHeight = Math.min(altitude * 0.4, (finalAt - 450) * 0.12);

  // Carry the circuit's heading a little further before bending onto the base
  // leg, so the curve rolls out of the turn instead of cornering out of it.
  const cEnd = pts[pts.length - 1];
  const tangent = cEnd.clone().sub(pts[pts.length - 2]).setY(0).normalize();
  const carry = cEnd.clone().addScaledVector(tangent, 520);
  carry.y = cEnd.y;
  pts.push(inMap(carry));

  // Base leg, on whichever side the circuit is actually coming from — read
  // off the tangent rather than derived, because getting that sign wrong
  // turns the join onto final into a 180.
  const side = Math.sign(tangent.dot(perp)) || 1;
  const onBase = base.clone()
    .addScaledVector(axis, -(finalAt + 340))
    .addScaledVector(perp, side * 560);
  onBase.y = base.y + finalHeight + altitude * 0.14;

  const final = base.clone().addScaledVector(axis, -finalAt);
  final.y = base.y + finalHeight;

  pts.push(inMap(onBase), final);

  for (const p of pts) p.y = Math.max(p.y, heightAt(p.x, p.z) + MIN_CLEARANCE);

  const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5);
  const positions = sampleAdaptive(curve, {
    maxTurn,
    maxSpacing: spacing,
    // Tight enough to break a real corner into several gates. A hard turn at
    // cruise has a radius under 100, so gates this close are still flyable.
    minSpacing: cfg.route.minSpacing ?? 170,
  });

  // The path the player actually flies is runway -> every gate -> runway, so
  // that is what has to be clear. The runway ends are pinned to the ground.
  const field = base.clone();
  raiseForClearance([field, ...positions, field.clone()], heightAt, MIN_CLEARANCE);

  // The clearance pass can lift the last gate for terrain, which quietly makes
  // the approach too steep to land from. Push it further out until the descent
  // to the threshold is inside the touchdown limit again.
  const last = positions[positions.length - 1];
  for (let pass = 0; pass < 3; pass++) {
    const out = Math.hypot(last.x - base.x, last.z - base.z);
    const needed = 450 + (last.y - base.y) / MAX_APPROACH_GRADIENT;
    if (out >= needed) break;

    // Keep the height. copy(base) would take the runway's y with it and drop
    // the gate to the ground, which leaves the approach skimming the terrain
    // on the way in — the descent looks fine and the leg is lethal.
    const keepY = last.y;
    last.copy(base).addScaledVector(axis, -needed);
    last.y = Math.max(keepY, heightAt(last.x, last.z) + MIN_CLEARANCE);
  }

  return orient(positions, axis, axis);
}

/**
 * Threads the route down a canyon instead of looping over open country.
 *
 * Every gate sits on the centreline below the rim except the last, which is
 * outside on final approach. The clearance pass used by the open routes is
 * deliberately NOT applied here: it would lift the gates straight out of the
 * gorge. What keeps this flyable instead is the spacing — gates are placed
 * close enough together that the straight line between consecutive ones stays
 * between the walls.
 *
 * @returns {{position:THREE.Vector3, quaternion:THREE.Quaternion}[]}
 */
export function buildCanyonRoute(cfg, airport, canyon, heightAt) {
  const spec = cfg.canyon;
  const axis = airport.axis;
  const nodes = [];   // {position, dir} — dir null means "face your neighbours"

  // A gate straight off the departure end, so the canyon mouth is something
  // you are aimed at rather than something you go looking for.
  const depart = airport.center.clone().addScaledVector(axis, spec.departGate);
  depart.y = airport.center.y + spec.departHeight;
  nodes.push({ position: depart, dir: axis.clone() });

  // Skip the very ends, where the canyon is still only a dip in the plateau.
  const startArc = canyon.length * spec.entryRamp * 0.55;
  const endArc = canyon.length * (1 - spec.exitRamp * 0.55);
  const span = endArc - startArc;
  const count = Math.max(2, Math.round(span / spec.spacing));

  let exitU = 0;
  for (let i = 0; i <= count; i++) {
    const u = canyon.uAtArc(startArc + (span * i) / count);
    const p = canyon.pointAt(u);
    const d = canyon.dirAt(u);
    // Gates face down the gorge. Taking their facing from their neighbours
    // instead would skew the first one towards the departure gate out on the
    // plateau, and the route would read as a sharp turn that is not there.
    nodes.push({
      position: new THREE.Vector3(p.x, canyon.floorAt(u) + spec.gateHeight, p.y),
      dir: new THREE.Vector3(d.x, 0, d.y),
    });
    exitU = u;
  }

  // Climbing out of the gorge leaves you abeam the field pointing the wrong
  // way, and there is no room on this map for a procedure turn outside the
  // canyon ring. So the route keeps turning the way it already was, sweeping
  // round the field and widening out to the approach side. Continuing the
  // existing turn costs distance but never asks for a reversal.
  const exit = nodes[nodes.length - 1].position;
  const ap = airport.center;
  const exitAng = Math.atan2(exit.z - ap.z, exit.x - ap.x);
  const exitR = Math.hypot(exit.x - ap.x, exit.z - ap.z);

  // Which way the canyon was turning, read off the last two gates.
  const a1 = Math.atan2(
    nodes[nodes.length - 2].position.z - ap.z,
    nodes[nodes.length - 2].position.x - ap.x,
  );
  let step = exitAng - a1;
  while (step > Math.PI) step -= Math.PI * 2;
  while (step < -Math.PI) step += Math.PI * 2;
  const turnSign = Math.sign(step) || 1;

  const approachAng = Math.atan2(-axis.z, -axis.x);   // the approach side
  const approachR = spec.finalGate + (spec.approachPad ?? 350);

  // Go the way we are already turning, however far round that is.
  let sweep = turnSign * (approachAng - exitAng);
  while (sweep < 0) sweep += Math.PI * 2;

  const tail = [exit.clone()];
  const STEPS = 10;
  for (let i = 1; i <= STEPS; i++) {
    const t = i / STEPS;
    const ang = exitAng + turnSign * sweep * t;
    const r = lerp(exitR, approachR, smoothstep(0, 0.85, t));
    tail.push(new THREE.Vector3(
      ap.x + Math.cos(ang) * r,
      lerp(exit.y, ap.y + spec.finalHeight + 240, t),
      ap.z + Math.sin(ang) * r,
    ));
  }

  const final = ap.clone().addScaledVector(axis, -spec.finalGate);
  final.y = ap.y + spec.finalHeight;

  // Base leg on whichever side the sweep arrives from, then final.
  const perp = new THREE.Vector3(-axis.z, 0, axis.x).multiplyScalar(-turnSign);
  // Well inside where the sweep finishes, so the base leg moves inbound as
  // well as sideways. Level with it and the join becomes a pure sidestep,
  // which corners hard however many gates are thrown at it.
  const onBase = ap.clone()
    .addScaledVector(axis, -(spec.finalGate + 180))
    .addScaledVector(perp, 540);
  onBase.y = final.y + 150;
  tail.push(onBase, final);

  const link = new THREE.CatmullRomCurve3(tail, false, 'catmullrom', 0.5);
  const linkPts = sampleAdaptive(link, {
    maxTurn: spec.maxTurn, maxSpacing: spec.linkSpacing, minSpacing: 170,
  });

  // Drop the duplicated exit, and keep the link clear of the plateau.
  for (let i = 1; i < linkPts.length - 1; i++) {
    const p = linkPts[i];
    p.y = Math.max(p.y, heightAt(p.x, p.z) + 130);
    nodes.push({ position: p, dir: null });
  }
  nodes.push({ position: final, dir: axis.clone() });

  const up = new THREE.Vector3(0, 1, 0);
  const m = new THREE.Matrix4();
  const d = new THREE.Vector3();
  return nodes.map((node, i) => {
    if (node.dir) d.copy(node.dir);
    else {
      d.subVectors(
        nodes[Math.min(nodes.length - 1, i + 1)].position,
        nodes[Math.max(0, i - 1)].position,
      );
    }
    d.normalize();
    m.lookAt(node.position, d.clone().add(node.position), up);
    return {
      position: node.position,
      quaternion: new THREE.Quaternion().setFromRotationMatrix(m),
    };
  });
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
