// Phone controls: tilt for pitch and roll, a throttle slider, and buttons for
// gear, brake and nitro.
//
// This is an auxiliary input source — it feeds the same axes the keyboard
// does, so nothing here changes how the game plays on a desktop.
//
// Two things make tilt awkward and are handled up front rather than hoped
// away. iOS will not deliver orientation events at all until you ask for
// permission from inside a user gesture. And every phone is held at a
// different angle, so the tilt is measured against a zero point captured when
// you start flying rather than against gravity.

import { Save } from './save.js';

const TILT_RANGE = 26;    // degrees of tilt for full deflection
const TILT_DEAD = 2.5;    // degrees ignored around the zero point
const STICK_RANGE = 90;   // pixels of drag for full deflection, fallback mode

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
 * Rotates the device's tilt axes into screen axes, so the controls mean the
 * same thing whichever way up the phone is held.
 *
 * Exported so the mapping can be checked without a phone in hand: it is the
 * part most likely to be wrong, and the symptom on a device is just "the
 * controls feel weird".
 *
 * @param {number} beta  front-to-back tilt, degrees
 * @param {number} gamma left-to-right tilt, degrees
 * @param {number} angle screen.orientation.angle, degrees
 */
export function tiltToScreen(beta, gamma, angle) {
  const rad = (angle * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  return {
    pitch: beta * cos + gamma * sin,
    roll: gamma * cos - beta * sin,
  };
}

/**
 * Deadzone, then a squared response so small corrections stay fine while the
 * edges of travel still give full deflection.
 * @param {number} deltaDeg degrees away from the calibrated zero
 */
export function shapeTilt(deltaDeg) {
  const mag = Math.abs(deltaDeg);
  if (mag <= TILT_DEAD) return 0;
  const t = clamp((mag - TILT_DEAD) / (TILT_RANGE - TILT_DEAD), 0, 1);
  return Math.sign(deltaDeg) * t * t;
}

export function initTouch() {
  if (!isTouchDevice()) return null;
  document.body.classList.add('touch');

  const prefs = Save.touch;
  let mode = prefs.mode ?? 'tilt';           // 'tilt' | 'stick'
  let invertPitch = prefs.invertPitch ?? false;
  let invertRoll = prefs.invertRoll ?? false;
  let zeroPitch = prefs.zeroPitch ?? null;
  let zeroRoll = prefs.zeroRoll ?? null;

  let tiltPitch = 0, tiltRoll = 0;           // -1..1 after calibration
  let stickPitch = 0, stickRoll = 0;
  let sawOrientation = false;
  let listening = false;

  let throttle = 0;
  let throttleTouched = false;
  let braking = false;
  const taps = new Set();

  // ---- tilt ---------------------------------------------------------------
  let rawPitch = 0, rawRoll = 0;

  function onOrientation(e) {
    if (e.beta == null || e.gamma == null) return;
    sawOrientation = true;

    const angle = (screen.orientation && screen.orientation.angle)
      ?? window.orientation ?? 0;
    const screenTilt = tiltToScreen(e.beta, e.gamma, angle);
    rawPitch = screenTilt.pitch;
    rawRoll = screenTilt.roll;

    if (zeroPitch == null) recentre();

    const p = shapeTilt(rawPitch - zeroPitch);
    const r = shapeTilt(rawRoll - zeroRoll);
    tiltPitch = invertPitch ? -p : p;
    tiltRoll = invertRoll ? -r : r;
  }

  function recentre() {
    zeroPitch = rawPitch;
    zeroRoll = rawRoll;
    tiltPitch = 0;
    tiltRoll = 0;
    Save.setTouch({ zeroPitch, zeroRoll });
  }

  function listen() {
    if (listening) return;
    listening = true;
    addEventListener('deviceorientation', onOrientation, true);
  }

  /**
   * iOS needs this called from inside a tap. Resolves to whether tilt is
   * actually going to work, so the caller can fall back to the stick.
   */
  async function requestTilt() {
    const DOE = window.DeviceOrientationEvent;
    if (!DOE) return false;
    try {
      if (typeof DOE.requestPermission === 'function') {
        const granted = await DOE.requestPermission();
        if (granted !== 'granted') return false;
      }
    } catch {
      return false;
    }
    listen();
    return true;
  }

  // ---- on-screen controls -------------------------------------------------
  const root = $('touch');
  const pad = $('thr-pad');
  const knob = $('thr-knob');
  const stickZone = $('stick-zone');

  function setThrottle(v) {
    throttle = clamp(v, 0, 1);
    throttleTouched = true;
    knob.style.bottom = `${throttle * 100}%`;
    pad.style.setProperty('--fill', `${throttle * 100}%`);
  }

  function throttleFromEvent(e) {
    const r = pad.getBoundingClientRect();
    setThrottle(1 - (e.clientY - r.top) / r.height);
  }

  pad.addEventListener('pointerdown', (e) => {
    pad.setPointerCapture(e.pointerId);
    throttleFromEvent(e);
    e.preventDefault();
  });
  pad.addEventListener('pointermove', (e) => {
    if (pad.hasPointerCapture(e.pointerId)) throttleFromEvent(e);
  });

  // Fallback stick: drag anywhere in the open area on the left.
  let stickId = null, stickX = 0, stickY = 0;
  stickZone.addEventListener('pointerdown', (e) => {
    if (mode !== 'stick') return;
    stickId = e.pointerId;
    stickX = e.clientX;
    stickY = e.clientY;
    stickZone.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  stickZone.addEventListener('pointermove', (e) => {
    if (e.pointerId !== stickId) return;
    stickRoll = clamp((e.clientX - stickX) / STICK_RANGE, -1, 1);
    // Drag down to pull back, like a stick.
    stickPitch = clamp((e.clientY - stickY) / STICK_RANGE, -1, 1);
  });
  const dropStick = (e) => {
    if (e.pointerId !== stickId) return;
    stickId = null;
    stickPitch = 0;
    stickRoll = 0;
  };
  stickZone.addEventListener('pointerup', dropStick);
  stickZone.addEventListener('pointercancel', dropStick);

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

  $('t-center').addEventListener('pointerdown', (e) => { recentre(); e.preventDefault(); });

  return {
    // --- axes, read by input.js ---
    pitch: () => (mode === 'tilt' ? tiltPitch : stickPitch),
    roll: () => (mode === 'tilt' ? tiltRoll : stickRoll),
    yaw: () => 0,
    throttle: () => 0,
    throttleAbs: () => (throttleTouched ? throttle : null),
    brake: () => braking,
    tapped: (code) => taps.has(code),
    endFrame: () => taps.clear(),

    // --- lifecycle ---
    async enable() {
      root.classList.remove('hidden');
      const ok = await requestTilt();
      if (!ok) setMode('stick');
      return ok;
    },
    disable() {
      root.classList.add('hidden');
      braking = false;
      taps.clear();
    },
    /** True once the sensor has actually produced a reading. */
    get live() { return sawOrientation; },
    get mode() { return mode; },
    recentre,
    setMode,
    setInvert(which, value) {
      if (which === 'pitch') invertPitch = value; else invertRoll = value;
      Save.setTouch({ invertPitch, invertRoll });
    },
    get inverted() { return { pitch: invertPitch, roll: invertRoll }; },
    resetThrottle() { setThrottle(0); throttleTouched = false; },
  };

  function setMode(next) {
    mode = next;
    stickPitch = 0;
    stickRoll = 0;
    document.body.classList.toggle('stick-mode', mode === 'stick');
    Save.setTouch({ mode });
  }
}
