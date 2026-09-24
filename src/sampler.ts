// Image -> target points. Dark pixels block the backlight, so darkness is
// where sand goes. Every image yields exactly N points so every grain always
// has a destination.

import { hilbertPixelOrder } from './hilbert';
import type { PixelImage, SampleParams } from './types';
import { mulberry32 } from './util';

export const DEFAULT_SAMPLE: SampleParams = {
  threshold: 0.08,
  contrast: 1.1,
  gamma: 1.0,
  invert: false,
  dust: 0.0,
  sharpen: 0.0,
  autoLevels: false,
};

/** Separable box blur, run twice (close to a Gaussian). */
function blur(src: Float32Array, w: number, h: number, radius: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src);
  const r = Math.max(1, Math.round(radius));
  const norm = 1 / (2 * r + 1);
  for (let pass = 0; pass < 2; pass++) {
    // horizontal: out -> tmp
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += out[row + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = acc * norm;
        acc += out[row + Math.min(w - 1, x + r + 1)] - out[row + Math.max(0, x - r)];
      }
    }
    // vertical: tmp -> out
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = acc * norm;
        acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
      }
    }
  }
  return out;
}

/**
 * Per-pixel "sand density" weight in [0, 1]: luminance -> darkness with
 * levels, sharpening, contrast, threshold and gamma. Transparent pixels count
 * as lit glass (no sand), so logos with alpha work.
 */
export function computeWeights(img: PixelImage, p: SampleParams): Float32Array {
  const { data, width: w, height: h } = img;
  const count = w * h;
  let lum = new Float32Array(count);
  const alpha = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    lum[i] = (0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2]) / 255;
    alpha[i] = data[o + 3] / 255;
  }

  if (p.autoLevels) {
    const hist = new Uint32Array(256);
    let total = 0;
    for (let i = 0; i < count; i++) {
      if (alpha[i] > 0.5) {
        hist[Math.min(255, (lum[i] * 255) | 0)]++;
        total++;
      }
    }
    if (total > 0) {
      const loCount = total * 0.02;
      const hiCount = total * 0.98;
      let acc = 0;
      let lo = 0;
      let hi = 255;
      let foundLo = false;
      for (let b = 0; b < 256; b++) {
        acc += hist[b];
        if (!foundLo && acc >= loCount) {
          lo = b;
          foundLo = true;
        }
        if (acc >= hiCount) {
          hi = b;
          break;
        }
      }
      const span = Math.max(8, hi - lo) / 255;
      const base = lo / 255;
      for (let i = 0; i < count; i++) lum[i] = Math.min(1, Math.max(0, (lum[i] - base) / span));
    }
  }

  if (p.sharpen > 0) {
    const blurred = blur(lum, w, h, Math.max(w, h) / 220);
    const sharp = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      sharp[i] = Math.min(1, Math.max(0, lum[i] + p.sharpen * (lum[i] - blurred[i])));
    }
    lum = sharp;
  }

  const out = new Float32Array(count);
  const t = Math.min(0.99, Math.max(0, p.threshold));
  const invT = 1 / (1 - t);
  const gamma = Math.max(0.05, p.gamma);
  for (let i = 0; i < count; i++) {
    // Composite over white (the lit glass) first, so transparent areas are
    // empty normally and full of sand when inverted, which is what "negative"
    // means for a logo or a line of text.
    const a = alpha[i];
    const l = a * lum[i] + (1 - a);
    let d = p.invert ? l : 1 - l;
    d = (d - 0.5) * p.contrast + 0.5;
    d = (d - t) * invT;
    if (d <= 0) {
      out[i] = 0;
      continue;
    }
    out[i] = d >= 1 ? 1 : Math.pow(d, gamma);
  }
  return out;
}

/**
 * Importance-samples `n` points, with probability proportional to the
 * weights. Uses systematic sampling along a Hilbert curve through the pixels:
 * every pixel receives its expected share of grains (+-1), and the curve's
 * locality spreads them evenly in 2D with no raster striping. Each grain is
 * jittered with a tent kernel so pixel edges don't show.
 *
 * Returns world-space xy pairs (x in [-aspect, aspect], y in [-1, 1], y up).
 */
export function samplePoints(
  img: PixelImage,
  params: SampleParams,
  n: number,
  aspect: number,
  seed: number,
): Float32Array {
  const { width: w, height: h } = img;
  const weights = computeWeights(img, params);
  const count = w * h;

  let total = 0;
  for (let i = 0; i < count; i++) total += weights[i];

  const dust = Math.min(0.9, Math.max(0, params.dust));
  if (total <= 1e-6) {
    // Blank image: spread the sand thinly over the whole glass.
    weights.fill(1);
    total = count;
  } else if (dust > 0) {
    const floor = ((dust / (1 - dust)) * total) / count;
    for (let i = 0; i < count; i++) weights[i] += floor;
    total += floor * count;
  }

  const rnd = mulberry32(seed);
  const order = hilbertPixelOrder(w, h);
  const out = new Float32Array(n * 2);
  const step = total / n;
  let next = rnd() * step;
  let cum = 0;
  let k = 0;
  const sx = (2 * aspect) / w;
  const sy = 2 / h;
  let lastPix = order[0];

  for (let j = 0; j < order.length && k < n; j++) {
    const pix = order[j];
    const wt = weights[pix];
    if (wt <= 0) continue;
    lastPix = pix;
    cum += wt;
    if (cum <= next) continue;
    const px = pix % w;
    const py = (pix / w) | 0;
    while (cum > next && k < n) {
      const jx = rnd() + rnd() - 1;
      const jy = rnd() + rnd() - 1;
      out[2 * k] = (px + 0.5 + jx) * sx - aspect;
      out[2 * k + 1] = 1 - (py + 0.5 + jy) * sy;
      k++;
      next += step;
    }
  }

  // Floating point slack: place any remaining grains on the last sandy pixel.
  const lx = lastPix % w;
  const ly = (lastPix / w) | 0;
  while (k < n) {
    out[2 * k] = (lx + 0.5 + rnd() * 2 - 1) * sx - aspect;
    out[2 * k + 1] = 1 - (ly + 0.5 + rnd() * 2 - 1) * sy;
    k++;
  }
  return out;
}
