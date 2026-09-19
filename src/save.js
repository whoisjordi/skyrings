// Progress in localStorage. Every access is guarded: private windows and
// blocked site-data make these throw, and the game must still be playable.

const KEY = 'skyrings.v1';
const EMPTY = { best: {}, unlocked: 1, invertPitch: false };

let state = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...EMPTY, ...JSON.parse(raw) };
  } catch { /* unavailable — fall through to defaults */ }
  return { ...EMPTY };
}

function flush() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch { /* nothing to do; the run still counts for this session */ }
}

export const Save = {
  bestTime: (id) => state.best[id] ?? null,

  /** Records a finished run. Returns true when it beat the stored time. */
  recordTime(id, seconds) {
    const prev = state.best[id];
    const isBest = prev == null || seconds < prev;
    if (isBest) state.best[id] = seconds;
    flush();
    return isBest;
  },

  isUnlocked: (index) => index < state.unlocked,

  unlockThrough(index) {
    if (index + 1 > state.unlocked) {
      state.unlocked = index + 1;
      flush();
    }
  },

  get invertPitch() { return state.invertPitch; },
  set invertPitch(v) { state.invertPitch = !!v; flush(); },
};
