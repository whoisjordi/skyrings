// The runway: where every mission starts and the only place it can end well.

import * as THREE from 'three';
import { AIRPORT_Y } from './terrain.js';

const LENGTH = 900;
const WIDTH = 70;
const SLAB = 0.8;                 // runway thickness
const TOP_Y = AIRPORT_Y + SLAB / 2;
const WHEEL_DROP = 2.4;           // model centre sits this far above the wheels
const BELLY_DROP = 1.1;           // with the legs tucked away it sits lower
const SIDE_MARGIN = 14;           // grace before "ran off the runway"

// What counts as an acceptable arrival. Generous on purpose — the challenge
// is the route, not the landing.
const LIMITS = {
  descent: 15,     // units/s downward
  speed: 108,
  bank: 0.3,       // sin(bank)
  noseDown: -0.24, // forward.y
  align: 0.76,     // |dot| with the runway centreline
};

export function createAirport(cfg) {
  const { x: ax, z: az } = cfg.airport;
  const heading = cfg.runwayHeading ?? 0;
  const cos = Math.cos(heading);
  const sin = Math.sin(heading);

  // Runway centreline direction in world space (local -Z).
  const axis = new THREE.Vector3(-sin, 0, -cos);

  const toLocal = (x, z) => {
    const dx = x - ax, dz = z - az;
    return { lx: dx * cos - dz * sin, lz: dx * sin + dz * cos };
  };

  const group = new THREE.Group();
  group.position.set(ax, 0, az);
  group.rotation.y = heading;

  const P = cfg.palette;
  const flat = (color, opts) => new THREE.MeshLambertMaterial({ color, flatShading: true, ...opts });
  const glow = (color) => new THREE.MeshBasicMaterial({ color });

  const strip = new THREE.Mesh(new THREE.BoxGeometry(WIDTH, SLAB, LENGTH), flat(0x3a3f45));
  strip.position.y = AIRPORT_Y;
  group.add(strip);

  // Centreline dashes and threshold bars, floated just above the surface.
  const paint = flat(0xe9eef2);
  const markY = TOP_Y + 0.05;
  const dashGeo = new THREE.BoxGeometry(2.2, 0.1, 26);
  for (let z = -LENGTH / 2 + 60; z <= LENGTH / 2 - 60; z += 62) {
    const d = new THREE.Mesh(dashGeo, paint);
    d.position.set(0, markY, z);
    group.add(d);
  }
  const barGeo = new THREE.BoxGeometry(4, 0.1, 22);
  for (const end of [-1, 1]) {
    for (let i = -3; i <= 3; i++) {
      if (!i) continue;
      const b = new THREE.Mesh(barGeo, paint);
      b.position.set(i * 7, markY, end * (LENGTH / 2 - 26));
      group.add(b);
    }
  }

  // Edge lights — plain emissive blocks, brighter on the night mission.
  const lightMat = glow(P.runwayLights ?? 0xffd27a);
  const lightGeo = new THREE.BoxGeometry(1.4, 1.4, 1.4);
  for (let z = -LENGTH / 2; z <= LENGTH / 2; z += 50) {
    for (const s of [-1, 1]) {
      const l = new THREE.Mesh(lightGeo, lightMat);
      l.position.set(s * (WIDTH / 2 + 3), TOP_Y + 0.8, z);
      group.add(l);
    }
  }

  // Approach lights leading in to the landing threshold.
  const approach = glow(0xff8a5c);
  for (let i = 1; i <= 8; i++) {
    const l = new THREE.Mesh(new THREE.BoxGeometry(9, 0.9, 1.6), approach);
    l.position.set(0, TOP_Y + 0.6, LENGTH / 2 + i * 34);
    group.add(l);
  }

  // Tower, hangars and a windsock, purely so the place looks inhabited.
  const tower = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(4, 5.5, 26, 6), flat(0xb9c3c9));
  shaft.position.y = AIRPORT_Y + 13;
  const cab = new THREE.Mesh(new THREE.CylinderGeometry(8, 7, 8, 6), flat(0x5d6a73));
  cab.position.y = AIRPORT_Y + 29;
  const roof = new THREE.Mesh(new THREE.ConeGeometry(9, 5, 6), flat(P.accent));
  roof.position.y = AIRPORT_Y + 35;
  tower.add(shaft, cab, roof);
  tower.position.set(WIDTH / 2 + 60, 0, -120);
  group.add(tower);

  for (let i = 0; i < 3; i++) {
    const hangar = new THREE.Mesh(new THREE.CylinderGeometry(15, 15, 34, 8, 1, false, 0, Math.PI), flat(0x8d979e));
    hangar.rotation.z = Math.PI / 2;
    hangar.rotation.y = Math.PI / 2;
    hangar.position.set(WIDTH / 2 + 62, AIRPORT_Y, 20 + i * 44);
    group.add(hangar);
  }

  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 14, 5), flat(0xd8dee2));
  pole.position.set(-WIDTH / 2 - 22, AIRPORT_Y + 7, 0);
  const sock = new THREE.Mesh(new THREE.ConeGeometry(2.4, 8, 6), flat(0xff7043));
  sock.rotation.z = -Math.PI / 2;
  sock.position.set(-WIDTH / 2 - 17, AIRPORT_Y + 13, 0);
  group.add(pole, sock);

  const start = {
    x: ax + axis.x * -(LENGTH / 2 - 80),
    z: az + axis.z * -(LENGTH / 2 - 80),
    y: TOP_Y + WHEEL_DROP,
    heading,
  };

  return {
    group,
    axis,
    /** Height the plane's origin rests at while on the ground. */
    surfaceY: TOP_Y + WHEEL_DROP,
    /** ...and where it rests when sliding on the airframe instead. */
    bellyY: TOP_Y + BELLY_DROP,
    start,
    center: new THREE.Vector3(ax, TOP_Y, az),

    contains(x, z) {
      const { lx, lz } = toLocal(x, z);
      return Math.abs(lx) <= WIDTH / 2 + SIDE_MARGIN && Math.abs(lz) <= LENGTH / 2;
    },

    /** Distance along the runway from the landing threshold, for guidance. */
    approachInfo(plane) {
      const { lx, lz } = toLocal(plane.position.x, plane.position.z);
      return { lateral: lx, along: lz, height: plane.position.y - TOP_Y };
    },

    /**
     * Decides what a contact with the runway means. Returns a crash event with
     * a specific reason, or a touchdown — never a silent failure.
     */
    evaluateTouchdown(plane) {
      const descent = -plane.velocity.y;
      const align = Math.abs(plane.forward.dot(axis));

      if (descent > LIMITS.descent) return crash('Hit the runway too hard');
      if (plane.speed > LIMITS.speed) return crash('Touched down too fast');
      if (Math.abs(plane.bank) > LIMITS.bank) return crash('Wing strike on landing');
      if (plane.forward.y < LIMITS.noseDown) return crash('Nosed into the runway');
      if (align < LIMITS.align) return crash('Landed across the runway');

      // Arriving on the airframe is survivable but it is not a landing: you
      // slide, and the mission ends there. Gear mid-travel counts as up.
      if (!plane.gearLocked) {
        plane.settleOnBelly(TOP_Y + BELLY_DROP);
        return { type: 'belly' };
      }

      plane.settleOnRunway(TOP_Y + WHEEL_DROP);
      return { type: 'touchdown' };
    },
  };
}

const crash = (reason) => ({ type: 'crash', reason });
