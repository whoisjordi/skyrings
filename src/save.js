// Progress in localStorage. Every access is guarded: private windows and
// blocked site-data make these throw, and the game must still be playable.

const KEY = 'skyrings.v1';
// Ghosts are tens of kilobytes each, so they live under their own keys: a
// full quota then loses a ghost, never the progress.
const GHOST_KEY = 'skyrings.ghost.';

// TEMPORARY, for testing: every mission is selectable regardless of progress.
// Set back to false to restore unlock-as-you-go. Progress is still recorded
// either way, so flipping this does not throw away anyone's unlocks.
const UNLOCK_ALL = true;
const EMPTY = { best: {}, unlocked: 1, invertPitch: false, ghost: true, touch: {} };

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

  isUnlocked: (index) => UNLOCK_ALL || index < state.unlocked,

  /** How far the player has genuinely got, ignoring the testing unlock. */
  reachedCount: () => state.unlocked,

  unlockThrough(index) {
    if (index + 1 > state.unlocked) {
      state.unlocked = index + 1;
      flush();
    }
  },

  get invertPitch() { return state.invertPitch; },
  set invertPitch(v) { state.invertPitch = !!v; flush(); },

  /** Whether the ghost of your best run flies alongside. */
  get ghostOn() { return state.ghost !== false; },
  set ghostOn(v) { state.ghost = !!v; flush(); },

  ghost(id) {
    try {
      const raw = localStorage.getItem(GHOST_KEY + id);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  },

  /** Stores a ghost; returns false when storage refused it. */
  setGhost(id, ghost) {
    try {
      localStorage.setItem(GHOST_KEY + id, JSON.stringify(ghost));
      return true;
    } catch { return false; }
  },

  /** Phone control preferences: currently just stick or arrows. */
  get touch() { return state.touch ?? {}; },
  setTouch(patch) {
    state.touch = { ...(state.touch ?? {}), ...patch };
    flush();
  },
};
