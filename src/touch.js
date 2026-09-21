// Phone controls: an on-screen stick (or an 8-way arrow pad in the same spot)
// for pitch and roll, a throttle slider, and buttons for gear, brake and nitro.
//
// This is an auxiliary input source — it feeds the same axes the keyboard
// does, so nothing here changes how the game plays on a desktop.

import { Save } from './save.js';

const DEAD = 0.12;             // fraction of stick travel ignored at centre
// How far off centre an arrow registers. sin(22.5 deg), so at full travel the
// pad splits into eight equal 45-degree sectors.
const ARROW_THRESHOLD = 0.383;

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/**
 * A phone or tablet — not merely a machine that happens to have a touchscreen.
 * A laptop with both a touch display and a mouse reports touch points but also
 * a fine pointer, and should keep the clean keyboard build.
 */
export const isTouchDevice = () => {
  if (typeof window === 'undefined') return false;
  if (matchMedia('(pointer: coarse)').matches) return true;
  return navigator.maxTouchPoints > 0 && !matchMedia('(pointer: fine)').matches;
};

/**
 * Converts a thumb's offset from the pad centre into pitch and roll.
 *
 * Screen y grows downward, and pulling down means nose up — like a stick, and
 * the same sense as the S key, so the pause menu's invert setting covers both.
 *
 * Exported so the mapping can be tested without a phone in hand.
 *
 * @param {number} dx pixels right of centre
 * @param {number} dy pixels below centre
 * @param {number} radius pixels of travel for full deflection
 * @param {'stick'|'arrows'} mode analogue, or snapped to -1/0/+1 like keys
 */
export function padToAxes(dx, dy, radius, mode) {
  let x = dx / radius;
  let y = dy / radius;
  const mag = Math.hypot(x, y);
  if (mag > 1) { x /= mag; y /= mag; }   // past the rim is just the rim

  if (mode === 'arrows') {
    const snap = (v) => (Math.abs(v) >= ARROW_THRESHOLD ? Math.sign(v) : 0);
    return { roll: snap(x), pitch: snap(y) };
  }

  const m = Math.min(1, mag);
  if (m <= DEAD) return { roll: 0, pitch: 0 };
  // Rescale so output starts from zero at the edge of the deadzone instead of
  // jumping straight to 12%. That jump is what makes small corrections twitchy.
  const k = (m - DEAD) / (1 - DEAD) / m;
  return { roll: x * k, pitch: y * k };
}

export function initTouch() {
  if (!isTouchDevice()) return null;
  document.body.classList.add('touch');

  // Older saves may say 'tilt', which no longer exists; they get the stick.
  let mode = Save.touch.mode === 'arrows' ? 'arrows' : 'stick';
  document.body.classList.toggle('arrows-mode', mode === 'arrows');

  let pitch = 0, roll = 0;
  let throttle = 0, throttleTouched = false;
  let braking = false;
  const taps = new Set();

  const root = $('touch');

  // ---- throttle slider ----------------------------------------------------
  const pad = $('thr-pad');
  const padKnob = $('thr-knob');

  function setThrottle(v) {
    throttle = clamp(v, 0, 1);
    throttleTouched = true;
    padKnob.style.bottom = `${throttle * 100}%`;
    pad.style.setProperty('--fill', `${throttle * 100}%`);
  }
  const throttleFrom = (e) => {
    const r = pad.getBoundingClientRect();
    setThrottle(1 - (e.clientY - r.top) / r.height);
  };
  pad.addEventListener('pointerdown', (e) => {
    pad.setPointerCapture(e.pointerId);
    throttleFrom(e);
    e.preventDefault();
  });
  pad.addEventListener('pointermove', (e) => {
    if (pad.hasPointerCapture(e.pointerId)) throttleFrom(e);
  });

  // ---- stick / arrow pad ----------------------------------------------------
  // One zone, one thumb. The offset is measured from the pad's centre, not from
  // wherever the thumb happened to land, so a given spot always means the same
  // thing — that is what lets you fly it without looking.
  const joy = $('joy');
  const joyKnob = $('joy-knob');
  let joyId = null;

  function joyFrom(e) {
    const r = joy.getBoundingClientRect();
    const radius = (r.width / 2) * 0.72;
    let dx = e.clientX - (r.left + r.width / 2);
    let dy = e.clientY - (r.top + r.height / 2);
    ({ roll, pitch } = padToAxes(dx, dy, radius, mode));

    const m = Math.hypot(dx, dy);
    if (m > radius) { dx *= radius / m; dy *= radius / m; }
    joyKnob.style.transform = `translate(${dx}px, ${dy}px)`;
    joy.classList.toggle('up', pitch < 0);
    joy.classList.toggle('down', pitch > 0);
    joy.classList.toggle('left', roll < 0);
    joy.classList.toggle('right', roll > 0);
  }

  function releaseJoy() {
    joyId = null;
    pitch = 0;
    roll = 0;
    joyKnob.style.transform = '';
    joy.classList.remove('up', 'down', 'left', 'right');
  }

  joy.addEventListener('pointerdown', (e) => {
    joyId = e.pointerId;
    joy.setPointerCapture(e.pointerId);
    joyFrom(e);
    e.preventDefault();
  });
  joy.addEventListener('pointermove', (e) => { if (e.pointerId === joyId) joyFrom(e); });
  const joyUp = (e) => { if (e.pointerId === joyId) releaseJoy(); };
  joy.addEventListener('pointerup', joyUp);
  joy.addEventListener('pointercancel', joyUp);

  // ---- buttons --------------------------------------------------------------
  const tapButton = (id, code) => {
    const el = $(id);
    el.addEventListener('pointerdown', (e) => {
      taps.add(code);
      el.classList.add('down');
      e.preventDefault();
    });
    const up = () => el.classList.remove('down');
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  tapButton('t-gear', 'KeyG');
  tapButton('t-nitro', 'KeyN');
  tapButton('t-pause', 'Escape');
  tapButton('t-camera', 'KeyC');

  const brakeBtn = $('t-brake');
  brakeBtn.addEventListener('pointerdown', (e) => {
    braking = true;
    brakeBtn.classList.add('down');
    e.preventDefault();
  });
  const brakeUp = () => { braking = false; brakeBtn.classList.remove('down'); };
  brakeBtn.addEventListener('pointerup', brakeUp);
  brakeBtn.addEventListener('pointercancel', brakeUp);
  brakeBtn.addEventListener('pointerleave', brakeUp);

  return {
    // --- axes, read by input.js ---
    pitch: () => pitch,
    roll: () => roll,
    yaw: () => 0,
    throttle: () => 0,
    throttleAbs: () => (throttleTouched ? throttle : null),
    brake: () => braking,
    tapped: (code) => taps.has(code),
    endFrame: () => taps.clear(),

    // --- lifecycle ---
    enable() { root.classList.remove('hidden'); },
    disable() {
      root.classList.add('hidden');
      braking = false;
      taps.clear();
      releaseJoy();
    },
    get mode() { return mode; },
    setMode(next) {
      mode = next;
      releaseJoy();
      document.body.classList.toggle('arrows-mode', mode === 'arrows');
      Save.setTouch({ mode });
    },
    resetThrottle() { setThrottle(0); throttleTouched = false; },
  };
}
