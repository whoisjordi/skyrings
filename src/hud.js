// HUD: plain DOM over the canvas. Cheaper than drawing it in WebGL and it
// stays crisp on high-DPI screens.

import * as THREE from 'three';
import { formatTime } from './levels.js';

const $ = (id) => document.getElementById(id);

const el = {
  root: $('hud'),
  spd: $('spd-val'),
  alt: $('alt-val'),
  time: $('time-val'),
  rings: $('rings-val'),
  thrFill: $('thr-fill'),
  thrPct: $('thr-pct'),
  level: $('lvl-name'),
  gear: $('gear-chip'),
  nitro: $('nitro-chip'),
  // On-screen buttons on a phone double as the gear and nitro indicators.
  tGear: $('t-gear'),
  tNitro: $('t-nitro'),
  arrow: $('arrow'),
  banner: $('banner'),
  stall: $('stall'),
};

const v = new THREE.Vector3();
let bannerUntil = 0;

export const HUD = {
  show(on) { el.root.classList.toggle('on', on); },

  setLevel(name) { el.level.textContent = name; },

  /** @param {object} s speed, altitude, throttle, time, rings, total, target */
  update(s) {
    el.spd.innerHTML = `${Math.round(s.speed)}<small>kt</small>`;
    el.alt.innerHTML = `${Math.round(Math.max(0, s.altitude) * 3.28)}<small>ft</small>`;
    el.time.textContent = formatTime(s.time);
    el.time.classList.toggle('hot', s.target > 0 && s.time > s.target);
    el.rings.innerHTML = `${s.rings}<small>/${s.total}</small>`;
    el.rings.classList.toggle('done', s.rings >= s.total);

    const pct = Math.round(s.throttle * 100);
    el.thrFill.style.width = `${pct}%`;
    el.thrPct.textContent = `${pct}%`;

    // Gear: only "down and locked" is safe to land on, so mid-travel reads
    // as a warning rather than as down.
    const locked = s.gearPos >= 0.9;
    const retracted = s.gearPos <= 0.02;
    el.gear.textContent = locked ? 'GEAR DOWN' : retracted ? 'GEAR UP' : 'GEAR …';
    el.gear.className = `chip ${locked ? 'good' : retracted ? 'bad' : 'warn'}`;

    if (s.nitroActive) {
      el.nitro.textContent = `NITRO ${s.nitroTime.toFixed(1)}s`;
      el.nitro.className = 'chip bad';
    } else if (s.nitroCooldown > 0) {
      el.nitro.textContent = `NITRO ${Math.ceil(s.nitroCooldown)}s`;
      el.nitro.className = 'chip';
    } else {
      el.nitro.textContent = 'NITRO READY';
      el.nitro.className = 'chip good';
    }

    const g = el.tGear.classList;
    g.toggle('st-good', locked);
    g.toggle('st-warn', !locked && !retracted);
    g.toggle('st-bad', retracted);

    const cooling = !s.nitroActive && s.nitroCooldown > 0;
    const n = el.tNitro.classList;
    n.toggle('st-bad', !cooling);
    n.toggle('st-burn', !!s.nitroActive);
    n.toggle('st-cool', cooling);
    el.tNitro.textContent = cooling ? String(Math.ceil(s.nitroCooldown)) : 'N';

    // Amber before red: the aeroplane starts sagging well before it stalls,
    // and without a warning that just reads as the controls giving up.
    el.stall.classList.toggle('on', !!s.stalling || !!s.mushing);
    el.stall.classList.toggle('caution', !s.stalling && !!s.mushing);
  },

  /**
   * Points at the next objective when it is off-screen or behind you.
   * @param {THREE.Vector3|null} target world position
   */
  updateArrow(target, camera) {
    if (!target) { el.arrow.classList.remove('on'); return; }

    // Camera space first: projecting a point behind the camera mirrors it.
    v.copy(target).applyMatrix4(camera.matrixWorldInverse);
    const behind = v.z > 0;

    v.copy(target).project(camera);
    let x = v.x, y = v.y;
    if (behind) { x = -x; y = -y; }

    const onScreen = !behind && Math.abs(x) < 0.8 && Math.abs(y) < 0.8;
    if (onScreen) { el.arrow.classList.remove('on'); return; }

    const angle = Math.atan2(x, y);           // 0 = straight up
    const radius = Math.min(innerWidth, innerHeight) * 0.3;
    const dx = Math.sin(angle) * radius;
    const dy = -Math.cos(angle) * radius;

    el.arrow.style.transform =
      `translate(${dx}px, ${dy}px) rotate(${(angle * 180) / Math.PI}deg)`;
    el.arrow.classList.add('on');
  },

  /** @param {'good'|'warn'|'bad'|''} tone */
  banner(text, tone = '', seconds = 2) {
    el.banner.textContent = text;
    el.banner.className = `on ${tone}`;
    bannerUntil = performance.now() + seconds * 1000;
  },

  clearBanner() {
    el.banner.className = '';
    bannerUntil = 0;
  },

  tickBanner() {
    if (bannerUntil && performance.now() > bannerUntil) this.clearBanner();
  },
};
