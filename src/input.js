// Keyboard input: held keys + one-shot presses, drained once per frame.

const held = new Set();
const fresh = new Set();

// Keys the browser would otherwise scroll/activate with.
const SWALLOW = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space',
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'Tab',
]);

export function initInput() {
  addEventListener('keydown', (e) => {
    if (SWALLOW.has(e.code)) e.preventDefault();
    if (e.repeat) return;
    if (!held.has(e.code)) fresh.add(e.code);
    held.add(e.code);
  });
  addEventListener('keyup', (e) => held.delete(e.code));
  // Losing focus mid-flight would otherwise leave keys stuck down.
  addEventListener('blur', () => held.clear());
}

const down = (...codes) => codes.some((c) => held.has(c));

// An auxiliary source (the on-screen/tilt controls) ADDS to the keyboard
// rather than replacing it, so a machine with both keeps both and the desktop
// path is byte-for-byte what it was.
let aux = null;
export function setAuxInput(source) { aux = source; }
const from = (name) => (aux && aux[name] ? aux[name]() : 0);
const clamp1 = (v) => Math.max(-1, Math.min(1, v));

/** -1 / 0 / +1 from a pair of key groups. */
function axis(neg, pos) {
  return (down(...pos) ? 1 : 0) - (down(...neg) ? 1 : 0);
}

export const Input = {
  /** Nose up is +1, so it reads like pulling back on a stick. */
  pitch: () => clamp1(axis(['KeyW', 'ArrowUp'], ['KeyS', 'ArrowDown']) + from('pitch')),
  roll: () => clamp1(axis(['KeyA', 'ArrowLeft'], ['KeyD', 'ArrowRight']) + from('roll')),
  yaw: () => clamp1(axis(['KeyQ'], ['KeyE']) + from('yaw')),
  throttle: () => clamp1(axis(['ControlLeft', 'ControlRight'], ['ShiftLeft', 'ShiftRight'])
    + from('throttle')),
  /** Absolute throttle from a slider, or null when nothing has set one. */
  throttleAbs: () => (aux && aux.throttleAbs ? aux.throttleAbs() : null),
  /** Wheel brake on the ground, airbrake in the air. */
  brake: () => down('KeyB', 'Space') || !!(aux && aux.brake && aux.brake()),
  /** True only on the frame the key went down. */
  tapped: (code) => fresh.has(code) || !!(aux && aux.tapped && aux.tapped(code)),
  endFrame: () => {
    fresh.clear();
    if (aux && aux.endFrame) aux.endFrame();
  },
};
