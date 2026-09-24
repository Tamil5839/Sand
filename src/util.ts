/** Small seeded PRNG (mulberry32). Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a string hash, as an unsigned 32-bit int. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Grain counts are square so that every texel of the sim textures is a grain. */
export function textureSideFor(count: number): number {
  return Math.max(2, Math.round(Math.sqrt(count)));
}

/** Uniformly scattered grains across the glass, used as the "poured sand" start state. */
export function scatterPositions(n: number, aspect: number, seed: number): Float32Array {
  const rnd = mulberry32(seed);
  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    out[2 * i] = (rnd() * 2 - 1) * aspect * 0.985;
    out[2 * i + 1] = (rnd() * 2 - 1) * 0.985;
  }
  return out;
}
