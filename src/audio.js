// Tiny synthesised soundtrack: no files to load, no licences to worry about.
// Everything is built from oscillators and one noise buffer.
//
// Browsers refuse to start audio before a gesture, so the context is created
// lazily on the first menu click and resumed defensively after that.

let ctx = null;
let master = null;
let engine = null;
let enabled = true;

function ensure() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) { enabled = false; return null; }
  try {
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.32;
    master.connect(ctx.destination);
  } catch {
    enabled = false;
  }
  return ctx;
}

export const Audio = {
  unlock() {
    const c = ensure();
    if (c && c.state === 'suspended') c.resume().catch(() => {});
  },

  get muted() { return !enabled; },

  setMuted(m) {
    enabled = !m;
    if (master) master.gain.value = enabled ? 0.32 : 0;
  },

  /** Starts the engine drone. Pitch and volume track throttle and speed. */
  startEngine() {
    const c = ensure();
    if (!c || engine) return;

    const osc = c.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 70;

    const sub = c.createOscillator();
    sub.type = 'square';
    sub.frequency.value = 35;

    const filter = c.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 620;
    filter.Q.value = 3;

    const gain = c.createGain();
    gain.gain.value = 0;

    osc.connect(filter);
    sub.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    osc.start();
    sub.start();

    engine = { osc, sub, filter, gain };
  },

  stopEngine() {
    if (!engine) return;
    try {
      engine.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.08);
      const e = engine;
      setTimeout(() => {
        try { e.osc.stop(); e.sub.stop(); } catch { /* already stopped */ }
      }, 400);
    } catch { /* context already gone */ }
    engine = null;
  },

  updateEngine(throttle, speedRatio) {
    if (!engine || !ctx) return;
    const t = ctx.currentTime;
    const base = 58 + throttle * 95 + speedRatio * 34;
    engine.osc.frequency.setTargetAtTime(base, t, 0.09);
    engine.sub.frequency.setTargetAtTime(base * 0.5, t, 0.09);
    engine.filter.frequency.setTargetAtTime(420 + throttle * 1100, t, 0.12);
    engine.gain.gain.setTargetAtTime(0.1 + throttle * 0.2, t, 0.1);
  },

  /** Bright two-note chime when a gate is cleared. */
  ring(step = 0) {
    const c = ensure();
    if (!c || !enabled) return;
    const t = c.currentTime;
    [880 + step * 40, 1320 + step * 60].forEach((f, i) => {
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = 'triangle';
      o.frequency.value = f;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.22, t + 0.01 + i * 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42 + i * 0.05);
      o.connect(g); g.connect(master);
      o.start(t + i * 0.05);
      o.stop(t + 0.6 + i * 0.05);
    });
  },

  /** Filtered noise burst for impacts. */
  crash() {
    const c = ensure();
    if (!c || !enabled) return;
    const t = c.currentTime;
    const len = Math.floor(c.sampleRate * 0.7);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
    }
    const src = c.createBufferSource();
    src.buffer = buf;
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(1800, t);
    f.frequency.exponentialRampToValueAtTime(140, t + 0.6);
    const g = c.createGain();
    g.gain.value = 0.55;
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t);
  },

  /** Boost: a swept noise whoosh under a rising tone. */
  nitro() {
    const c = ensure();
    if (!c || !enabled) return;
    const t = c.currentTime;

    const len = Math.floor(c.sampleRate * 1.1);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = c.createBufferSource();
    src.buffer = buf;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.4;
    bp.frequency.setValueAtTime(260, t);
    bp.frequency.exponentialRampToValueAtTime(2600, t + 0.85);
    const ng = c.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.42, t + 0.18);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 1.05);
    src.connect(bp); bp.connect(ng); ng.connect(master);
    src.start(t);

    const o = c.createOscillator();
    const og = c.createGain();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(420, t + 0.8);
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.16, t + 0.15);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 1);
    o.connect(og); og.connect(master);
    o.start(t);
    o.stop(t + 1.2);
  },

  /** Rising arpeggio on a completed mission. */
  fanfare() {
    const c = ensure();
    if (!c || !enabled) return;
    const t = c.currentTime;
    [523, 659, 784, 1047].forEach((f, i) => {
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = 'triangle';
      o.frequency.value = f;
      const at = t + i * 0.12;
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(0.26, at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.55);
      o.connect(g); g.connect(master);
      o.start(at);
      o.stop(at + 0.7);
    });
  },
};
