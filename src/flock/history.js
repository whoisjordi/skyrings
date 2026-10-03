// Ring buffer of past flock states, so an agent can see its neighbours as
// they were a few ticks ago: the reaction delay. One typed-array copy per
// array per tick; reading a delayed state is just an offset.

export function createHistory(n, frames) {
  const pos = new Float32Array(frames * n * 3);
  const vel = new Float32Array(frames * n * 3);
  const panic = new Float32Array(frames * n);
  let head = -1;
  let filled = 0;

  return {
    frames,
    pos, vel, panic,
    /** Stores the current state as the newest frame. */
    push(p, v, pn) {
      head = (head + 1) % frames;
      pos.set(p.subarray(0, n * 3), head * n * 3);
      vel.set(v.subarray(0, n * 3), head * n * 3);
      panic.set(pn.subarray(0, n), head * n);
      if (filled < frames) filled++;
    },
    /**
     * Frame index for a delay in ticks (0 = newest). Until the buffer has
     * filled, the oldest frame there is stands in.
     */
    frame(delay) {
      const d = delay < filled ? delay : filled - 1;
      return (head - d + frames) % frames;
    },
    /** Offset of agent 0 in the vector arrays for a frame. */
    vecBase: (f) => f * n * 3,
    scalarBase: (f) => f * n,
  };
}
