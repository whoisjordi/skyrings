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

/** -1 / 0 / +1 from a pair of key groups. */
function axis(neg, pos) {
  return (down(...pos) ? 1 : 0) - (down(...neg) ? 1 : 0);
}

export const Input = {
  /** Nose up is +1, so it reads like pulling back on a stick. */
  pitch: () => axis(['KeyW', 'ArrowUp'], ['KeyS', 'ArrowDown']),
  roll: () => axis(['KeyA', 'ArrowLeft'], ['KeyD', 'ArrowRight']),
  yaw: () => axis(['KeyQ'], ['KeyE']),
  throttle: () => axis(['ControlLeft', 'ControlRight'], ['ShiftLeft', 'ShiftRight']),
  brake: () => down('Space'),
  /** True only on the frame the key went down. */
  tapped: (code) => fresh.has(code),
  endFrame: () => fresh.clear(),
};
