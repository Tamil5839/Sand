import { describe, expect, it } from 'vitest';
import { hilbertIndex, hilbertPixelOrder } from '../src/hilbert';
import { assignNearest, matchPoints, meanCost } from '../src/matcher';
import { computeWeights, DEFAULT_SAMPLE, samplePoints } from '../src/sampler';
import { RadixSorter } from '../src/sort';
import type { PixelImage } from '../src/types';
import { mulberry32, scatterPositions } from '../src/util';

function makeImage(w: number, h: number, dark: (x: number, y: number) => number, alpha = 255): PixelImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = Math.round(255 * (1 - dark(x, y)));
      const o = (y * w + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = v;
      data[o + 3] = alpha;
    }
  }
  return { data, width: w, height: h };
}

function isPermutation(assign: Int32Array): boolean {
  const seen = new Uint8Array(assign.length);
  for (const t of assign) {
    if (t < 0 || t >= assign.length || seen[t]) return false;
    seen[t] = 1;
  }
  return true;
}

describe('RadixSorter', () => {
  it('argsorts floats including negatives', () => {
    const rnd = mulberry32(1);
    const n = 5000;
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) v[i] = (rnd() - 0.5) * 1000;
    const idx = new RadixSorter().argsort(v, n);
    for (let r = 1; r < n; r++) expect(v[idx[r - 1]]).toBeLessThanOrEqual(v[idx[r]]);
  });

  it('sorts float values', () => {
    const rnd = mulberry32(2);
    const n = 3000;
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) v[i] = (rnd() - 0.3) * 7;
    const out = new Float32Array(n);
    new RadixSorter().sortFloats(v, n, out);
    const ref = v.slice().sort();
    expect(Array.from(out)).toEqual(Array.from(ref));
  });
});

describe('hilbert', () => {
  it('visits every pixel exactly once', () => {
    const order = hilbertPixelOrder(37, 20);
    const seen = new Uint8Array(37 * 20);
    for (const p of order) seen[p]++;
    expect(seen.every((c) => c === 1)).toBe(true);
  });

  it('is a bijection on a small grid', () => {
    const s = new Set<number>();
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) s.add(hilbertIndex(4, x, y));
    expect(s.size).toBe(256);
  });
});

describe('sampler', () => {
  it('returns exactly n points inside the frame, denser where darker', () => {
    const w = 160;
    const h = 90;
    const aspect = w / h;
    // Left half black, right half 25% grey.
    const img = makeImage(w, h, (x) => (x < w / 2 ? 1 : 0.25));
    const n = 20000;
    const pts = samplePoints(img, { ...DEFAULT_SAMPLE, threshold: 0, contrast: 1 }, n, aspect, 7);
    expect(pts.length).toBe(n * 2);
    let left = 0;
    for (let i = 0; i < n; i++) {
      const x = pts[2 * i];
      const y = pts[2 * i + 1];
      expect(Math.abs(x)).toBeLessThanOrEqual(aspect + 0.05);
      expect(Math.abs(y)).toBeLessThanOrEqual(1.05);
      if (x < 0) left++;
    }
    expect(left / n).toBeGreaterThan(0.77);
    expect(left / n).toBeLessThan(0.83);
  });

  it('treats transparent pixels as lit glass: no sand, or full sand when inverted', () => {
    const img = makeImage(10, 10, () => 1, 0);
    expect(computeWeights(img, DEFAULT_SAMPLE).every((v) => v === 0)).toBe(true);
    expect(computeWeights(img, { ...DEFAULT_SAMPLE, invert: true }).every((v) => v === 1)).toBe(true);
  });

  it('is deterministic for a seed', () => {
    const img = makeImage(64, 64, (x, y) => ((x - 32) ** 2 + (y - 32) ** 2 < 400 ? 1 : 0));
    const a = samplePoints(img, DEFAULT_SAMPLE, 1000, 1, 3);
    const b = samplePoints(img, DEFAULT_SAMPLE, 1000, 1, 3);
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});

describe('matcher', () => {
  const n = 20000;
  const aspect = 16 / 9;
  // Source: a ring on the left. Target: a filled square on the right.
  const ring = makeImage(160, 90, (x, y) => {
    const d = Math.hypot(x - 45, y - 45);
    return d > 25 && d < 35 ? 1 : 0;
  });
  const square = makeImage(160, 90, (x, y) => (x > 90 && x < 140 && y > 20 && y < 70 ? 1 : 0));
  const src = samplePoints(ring, DEFAULT_SAMPLE, n, aspect, 1);
  const tgt = samplePoints(square, DEFAULT_SAMPLE, n, aspect, 2);

  function randomAssign(): Int32Array {
    const rnd = mulberry32(9);
    const random = new Int32Array(n);
    for (let i = 0; i < n; i++) random[i] = i;
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [random[i], random[j]] = [random[j], random[i]];
    }
    return random;
  }

  function sqCost(a: Float32Array, b: Float32Array, assign: Int32Array): number {
    let sum = 0;
    for (let i = 0; i < assign.length; i++) {
      const t = assign[i];
      sum += (b[2 * t] - a[2 * i]) ** 2 + (b[2 * t + 1] - a[2 * i + 1]) ** 2;
    }
    return sum / assign.length;
  }

  it('sliced OT gives a bijection with lower transport cost than Hilbert or random', () => {
    const sot = matchPoints(src, tgt, n, { method: 'sot', iterations: 40, seed: 5 });
    const hil = matchPoints(src, tgt, n, { method: 'hilbert', iterations: 0, seed: 5 });
    expect(isPermutation(sot)).toBe(true);
    expect(isPermutation(hil)).toBe(true);
    const random = randomAssign();
    expect(sqCost(src, tgt, sot)).toBeLessThan(sqCost(src, tgt, hil));
    expect(sqCost(src, tgt, sot)).toBeLessThan(sqCost(src, tgt, random));
  });

  it('on overlapping shapes: sliced OT < Hilbert < random', () => {
    const disc = samplePoints(
      makeImage(160, 90, (x, y) => (Math.hypot(x - 80, y - 45) < 38 ? 1 : 0)),
      DEFAULT_SAMPLE, n, aspect, 3,
    );
    const box = samplePoints(
      makeImage(160, 90, (x, y) => (x > 50 && x < 110 && y > 15 && y < 75 ? 1 : 0)),
      DEFAULT_SAMPLE, n, aspect, 4,
    );
    const sot = matchPoints(disc, box, n, { method: 'sot', iterations: 40, seed: 5 });
    const hil = matchPoints(disc, box, n, { method: 'hilbert', iterations: 0, seed: 5 });
    const cSot = meanCost(disc, box, sot);
    const cHil = meanCost(disc, box, hil);
    const cRnd = meanCost(disc, box, randomAssign());
    expect(cSot).toBeLessThan(cHil);
    expect(cHil).toBeLessThan(cRnd);
  });

  it('matching a set to itself is (nearly) the identity', () => {
    const pts = scatterPositions(n, aspect, 4);
    const assign = assignNearest(pts, pts, n, 1);
    expect(isPermutation(assign)).toBe(true);
    expect(meanCost(pts, pts, assign)).toBeLessThan(0.002);
    const sot = matchPoints(pts, pts, n, { method: 'sot', iterations: 30, seed: 1 });
    expect(meanCost(pts, pts, sot)).toBeLessThan(0.01);
  });
});
