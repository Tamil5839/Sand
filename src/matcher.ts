// Flow worker: samples the next image and decides which grain goes where.
//
// Matching grain i (current position) to a target point in the next image is
// what makes the morph read as sand being pushed instead of noise. Sliced
// optimal transport moves a copy of the current grain positions until they
// match the target distribution, one random 1D projection at a time. Grains
// then claim the nearest free target, so every grain travels a short,
// coherent path.

import { hilbertIndex } from './hilbert';
import { samplePoints } from './sampler';
import { RadixSorter } from './sort';
import type { MatchMethod, WorkerRequest, WorkerResponse } from './types';
import { mulberry32 } from './util';

export interface MatchOptions {
  method: MatchMethod;
  /** Sliced OT iterations (each uses an orthogonal pair of directions). */
  iterations: number;
  seed: number;
  onProgress?: (fraction: number) => void;
}

const sorter = new RadixSorter();

/**
 * Sliced optimal transport flow: for each random direction, project both
 * sets, sort, and move every source point along the direction by its
 * difference to the rank-matched target. An orthogonal pair of directions is
 * used per iteration (iterative distribution transfer), which converges in a
 * few dozen iterations in 2D.
 */
export function slicedTransport(
  source: Float32Array,
  target: Float32Array,
  n: number,
  iterations: number,
  seed: number,
  onProgress?: (fraction: number) => void,
): Float32Array {
  const rnd = mulberry32(seed ^ 0x9e3779b9);
  const y = source.slice(0, n * 2);
  const py = new Float32Array(n);
  const pt = new Float32Array(n);
  const ptSorted = new Float32Array(n);
  const disp = new Float32Array(n * 2);
  const phase = rnd();
  const golden = 0.6180339887498949;

  for (let it = 0; it < iterations; it++) {
    // Low-discrepancy angles cover the half circle evenly.
    const theta = ((phase + it * golden) % 1) * Math.PI * 0.5;
    disp.fill(0);
    for (let axis = 0; axis < 2; axis++) {
      const a = theta + axis * Math.PI * 0.5;
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      for (let i = 0; i < n; i++) {
        pt[i] = target[2 * i] * dx + target[2 * i + 1] * dy;
        py[i] = y[2 * i] * dx + y[2 * i + 1] * dy;
      }
      sorter.sortFloats(pt, n, ptSorted);
      const order = sorter.argsort(py, n);
      for (let r = 0; r < n; r++) {
        const i = order[r];
        const delta = ptSorted[r] - py[i];
        disp[2 * i] += delta * dx;
        disp[2 * i + 1] += delta * dy;
      }
    }
    for (let i = 0; i < n * 2; i++) y[i] += disp[i];
    if (onProgress && (it & 3) === 3) onProgress((it + 1) / iterations);
  }
  return y;
}

function bounds(a: Float32Array, idx: Uint32Array, count: number, out: number[]): void {
  for (let k = 0; k < count; k++) {
    const i = idx[k];
    const x = a[2 * i];
    const y = a[2 * i + 1];
    if (x < out[0]) out[0] = x;
    if (y < out[1]) out[1] = y;
    if (x > out[2]) out[2] = x;
    if (y > out[3]) out[3] = y;
  }
}

/**
 * Rank-matches two equally sized subsets by Hilbert curve index. Used as the
 * cheap matching method, and to finish off the few leftovers of the nearest
 * assignment.
 */
export function hilbertMatch(
  src: Float32Array,
  srcIdx: Uint32Array,
  tgt: Float32Array,
  tgtIdx: Uint32Array,
  count: number,
  assign: Int32Array,
): void {
  if (count === 0) return;
  const bb = [Infinity, Infinity, -Infinity, -Infinity];
  bounds(src, srcIdx, count, bb);
  bounds(tgt, tgtIdx, count, bb);
  const order = 16;
  const side = (1 << order) - 1;
  const span = Math.max(bb[2] - bb[0], bb[3] - bb[1], 1e-6);
  const keys = new Uint32Array(count);
  const key = (a: Float32Array, i: number) =>
    hilbertIndex(
      order,
      Math.round(((a[2 * i] - bb[0]) / span) * side),
      Math.round(((a[2 * i + 1] - bb[1]) / span) * side),
    );

  for (let k = 0; k < count; k++) keys[k] = key(tgt, tgtIdx[k]);
  const tOrder = sorter.argsortU32(keys, count).slice();
  for (let k = 0; k < count; k++) keys[k] = key(src, srcIdx[k]);
  const sOrder = sorter.argsortU32(keys, count);
  for (let r = 0; r < count; r++) assign[srcIdx[sOrder[r]]] = tgtIdx[tOrder[r]];
}

/**
 * Bijection from moved source points to targets: in random order, each point
 * claims the nearest unclaimed target within its 3x3 grid neighbourhood.
 * Points that find nothing are retried on a coarser grid built from the
 * remaining targets; the last few are Hilbert-matched.
 */
export function assignNearest(
  moved: Float32Array,
  target: Float32Array,
  n: number,
  seed: number,
): Int32Array {
  const rnd = mulberry32(seed ^ 0x51ed27);
  const assign = new Int32Array(n).fill(-1);
  const taken = new Uint8Array(n);

  let srcList = new Uint32Array(n);
  for (let i = 0; i < n; i++) srcList[i] = i;
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = srcList[i];
    srcList[i] = srcList[j];
    srcList[j] = t;
  }
  let srcCount = n;
  let tgtList = new Uint32Array(n);
  for (let i = 0; i < n; i++) tgtList[i] = i;
  let tgtCount = n;

  for (let round = 0; round < 6 && srcCount > 64; round++) {
    const bb = [Infinity, Infinity, -Infinity, -Infinity];
    bounds(target, tgtList, tgtCount, bb);
    const bw = Math.max(bb[2] - bb[0], 1e-6);
    const bh = Math.max(bb[3] - bb[1], 1e-6);
    // ~2 targets per cell on average.
    const cells = Math.max(1, tgtCount / 2);
    const gw = Math.max(1, Math.ceil(Math.sqrt((cells * bw) / bh)));
    const gh = Math.max(1, Math.ceil(cells / gw));
    const cx = gw / bw;
    const cy = gh / bh;

    const cellStart = new Uint32Array(gw * gh + 1);
    const cellOf = new Uint32Array(tgtCount);
    for (let k = 0; k < tgtCount; k++) {
      const t = tgtList[k];
      const gx = Math.min(gw - 1, ((target[2 * t] - bb[0]) * cx) | 0);
      const gy = Math.min(gh - 1, ((target[2 * t + 1] - bb[1]) * cy) | 0);
      const c = gy * gw + gx;
      cellOf[k] = c;
      cellStart[c + 1]++;
    }
    for (let c = 0; c < gw * gh; c++) cellStart[c + 1] += cellStart[c];
    const fill = cellStart.slice(0, gw * gh);
    const items = new Uint32Array(tgtCount);
    const itemX = new Float32Array(tgtCount);
    const itemY = new Float32Array(tgtCount);
    for (let k = 0; k < tgtCount; k++) {
      const t = tgtList[k];
      const p = fill[cellOf[k]]++;
      items[p] = t;
      itemX[p] = target[2 * t];
      itemY[p] = target[2 * t + 1];
    }

    const left = new Uint32Array(srcCount);
    let leftCount = 0;
    for (let k = 0; k < srcCount; k++) {
      const s = srcList[k];
      const x = moved[2 * s];
      const y = moved[2 * s + 1];
      let gx = ((x - bb[0]) * cx) | 0;
      let gy = ((y - bb[1]) * cy) | 0;
      gx = gx < 0 ? 0 : gx >= gw ? gw - 1 : gx;
      gy = gy < 0 ? 0 : gy >= gh ? gh - 1 : gy;
      let best = -1;
      let bestD = Infinity;
      const y0 = gy > 0 ? gy - 1 : 0;
      const y1 = gy < gh - 1 ? gy + 1 : gh - 1;
      const x0 = gx > 0 ? gx - 1 : 0;
      const x1 = gx < gw - 1 ? gx + 1 : gw - 1;
      for (let yy = y0; yy <= y1; yy++) {
        const row = yy * gw;
        const a = cellStart[row + x0];
        const b = cellStart[row + x1 + 1];
        for (let p = a; p < b; p++) {
          const t = items[p];
          if (taken[t]) continue;
          const ddx = itemX[p] - x;
          const ddy = itemY[p] - y;
          const d = ddx * ddx + ddy * ddy;
          if (d < bestD) {
            bestD = d;
            best = t;
          }
        }
      }
      if (best >= 0) {
        assign[s] = best;
        taken[best] = 1;
      } else {
        left[leftCount++] = s;
      }
    }

    srcList = left;
    srcCount = leftCount;
    const remaining = new Uint32Array(srcCount);
    let r = 0;
    for (let k = 0; k < tgtCount; k++) if (!taken[tgtList[k]]) remaining[r++] = tgtList[k];
    tgtList = remaining;
    tgtCount = r;
  }

  hilbertMatch(moved, srcList, target, tgtList, srcCount, assign);
  return assign;
}

/** Returns assign[i] = index of the target point for grain i. */
export function matchPoints(
  source: Float32Array,
  target: Float32Array,
  n: number,
  opts: MatchOptions,
): Int32Array {
  if (opts.method === 'hilbert') {
    const all = new Uint32Array(n);
    for (let i = 0; i < n; i++) all[i] = i;
    const assign = new Int32Array(n);
    hilbertMatch(source, all, target, all, n, assign);
    return assign;
  }
  const moved = slicedTransport(source, target, n, opts.iterations, opts.seed, opts.onProgress);
  return assignNearest(moved, target, n, opts.seed);
}

/** Mean travel distance of an assignment (used for stats and tests). */
export function meanCost(source: Float32Array, target: Float32Array, assign: Int32Array): number {
  const n = assign.length;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const t = assign[i];
    sum += Math.hypot(target[2 * t] - source[2 * i], target[2 * t + 1] - source[2 * i + 1]);
  }
  return sum / n;
}

// ---------------------------------------------------------------------------
// Worker entry. Guarded so tests can import the functions above in Node.

declare const WorkerGlobalScope: unknown;
const inWorker = typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined';

if (inWorker) {
  const post = (msg: WorkerResponse, transfer?: Transferable[]) =>
    (self as unknown as Worker).postMessage(msg, transfer ?? []);

  self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
    const req = ev.data;
    if (req.type !== 'match') return;
    try {
      const t0 = performance.now();
      const { n } = req;
      const points = samplePoints(req.image, req.sample, n, req.aspect, req.seed);
      let lastPost = 0;
      const assign = matchPoints(req.source, points, n, {
        method: req.method,
        iterations: req.iterations,
        seed: req.seed,
        onProgress: (f) => {
          const now = performance.now();
          if (now - lastPost > 80) {
            lastPost = now;
            post({ type: 'progress', id: req.id, value: f * 0.9 });
          }
        },
      });
      const targets = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        const t = assign[i];
        targets[2 * i] = points[2 * t];
        targets[2 * i + 1] = points[2 * t + 1];
      }
      const cost = meanCost(req.source, points, assign);
      post({ type: 'result', id: req.id, targets, ms: performance.now() - t0, cost }, [
        targets.buffer,
      ]);
    } catch (err) {
      post({ type: 'error', id: req.id, message: err instanceof Error ? err.message : String(err) });
    }
  };
}
