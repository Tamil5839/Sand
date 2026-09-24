// Hilbert curve helpers. Used both to stratify sampling (sampler) and as the
// cheap matching fallback (matcher).

/** Index along a Hilbert curve covering a 2^order square, for integer (x, y). */
export function hilbertIndex(order: number, x: number, y: number): number {
  let d = 0;
  for (let s = 1 << (order - 1); s > 0; s >>>= 1) {
    const rx = (x & s) > 0 ? 1 : 0;
    const ry = (y & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) {
        x = s - 1 - x;
        y = s - 1 - y;
      }
      const t = x;
      x = y;
      y = t;
    }
  }
  return d;
}

const orderCache = new Map<string, Uint32Array>();

/**
 * Pixel indices (y * width + x) of a width x height grid, visited in Hilbert
 * order. Cached per size since the sampler reuses the same frame size.
 */
export function hilbertPixelOrder(width: number, height: number): Uint32Array {
  const key = `${width}x${height}`;
  const cached = orderCache.get(key);
  if (cached) return cached;

  let side = 1;
  while (side < width || side < height) side <<= 1;
  const out = new Uint32Array(width * height);
  let k = 0;
  const total = side * side;
  for (let d = 0; d < total; d++) {
    // d -> (x, y), standard iterative inverse.
    let t = d;
    let x = 0;
    let y = 0;
    for (let s = 1; s < side; s <<= 1) {
      const rx = 1 & (t >>> 1);
      const ry = 1 & (t ^ rx);
      if (ry === 0) {
        if (rx === 1) {
          x = s - 1 - x;
          y = s - 1 - y;
        }
        const tmp = x;
        x = y;
        y = tmp;
      }
      x += s * rx;
      y += s * ry;
      t >>>= 2;
    }
    if (x < width && y < height) out[k++] = y * width + x;
  }
  if (orderCache.size > 8) orderCache.clear();
  orderCache.set(key, out);
  return out;
}
