// Spatial hash for neighbour queries: cells of a fixed size, hashed into a
// table of buckets, sorted by counting sort into flat arrays. Rebuilt from
// scratch every tick in O(n) with no allocation.
//
// Distinct cells can share a bucket; that only adds candidates, which the
// caller filters by distance anyway. It can also make one bucket appear twice
// among the 27 around a point, so callers must tolerate a repeated index.

const P1 = 73856093, P2 = 19349663, P3 = 83492791;

export function createGrid(capacity, cellSize, tableBits = 14) {
  const size = 1 << tableBits;
  const mask = size - 1;
  const inv = 1 / cellSize;
  const start = new Int32Array(size + 1);
  const fill = new Int32Array(size);
  const items = new Int32Array(capacity);
  const bucketOf = new Int32Array(capacity);

  const hash = (cx, cy, cz) => (Math.imul(cx, P1) ^ Math.imul(cy, P2) ^ Math.imul(cz, P3)) & mask;

  /** Sorts agents [0, n) into buckets; `skip(i)` leaves an agent out. */
  function build(pos, n, skip) {
    start.fill(0);
    for (let i = 0; i < n; i++) {
      if (skip && skip(i)) { bucketOf[i] = -1; continue; }
      const b = hash(Math.floor(pos[i * 3] * inv), Math.floor(pos[i * 3 + 1] * inv), Math.floor(pos[i * 3 + 2] * inv));
      bucketOf[i] = b;
      start[b + 1]++;
    }
    for (let b = 0; b < size; b++) start[b + 1] += start[b];
    fill.set(start.subarray(0, size));
    for (let i = 0; i < n; i++) {
      const b = bucketOf[i];
      if (b >= 0) items[fill[b]++] = i;
    }
  }

  /**
   * Writes the indices in the 27 cells around (x, y, z) into `out` and
   * returns how many there are (at most out.length).
   */
  function gather(x, y, z, out) {
    const cx = Math.floor(x * inv), cy = Math.floor(y * inv), cz = Math.floor(z * inv);
    let m = 0;
    const cap = out.length;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const b = hash(cx + dx, cy + dy, cz + dz);
          for (let j = start[b], e = start[b + 1]; j < e && m < cap; j++) out[m++] = items[j];
        }
      }
    }
    return m;
  }

  return { build, gather, cellSize };
}
