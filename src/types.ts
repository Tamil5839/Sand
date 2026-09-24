// Shared types between the main thread and the flow worker.

export type SweepMode =
  | 'left-right'
  | 'right-left'
  | 'top-bottom'
  | 'bottom-top'
  | 'center-out'
  | 'edges-in'
  | 'click-radial'
  | 'diagonal'
  | 'random';

export const SWEEP_MODES: SweepMode[] = [
  'left-right',
  'right-left',
  'top-bottom',
  'bottom-top',
  'center-out',
  'edges-in',
  'click-radial',
  'diagonal',
  'random',
];

export type MatchMethod = 'sot' | 'hilbert';

/** Per-image tone controls that decide where sand goes. */
export interface SampleParams {
  /** Darkness below this (0..1) gets no sand. */
  threshold: number;
  /** Contrast around mid-grey; 1 = unchanged. */
  contrast: number;
  /** Exponent applied to darkness; >1 thins mid-tones, <1 fills them. */
  gamma: number;
  /** Treat light pixels as sand instead of dark ones. */
  invert: boolean;
  /** Fraction of grains dusted evenly over the whole glass (0..0.5). */
  dust: number;
  /** Unsharp-mask amount on luminance; helps faces read at sand resolution. */
  sharpen: number;
  /** Stretch luminance to the 2%..98% percentiles before mapping. */
  autoLevels: boolean;
}

/** Raw RGBA pixels, same layout as ImageData. */
export interface PixelImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface MatchRequest {
  type: 'match';
  id: number;
  /** Current rest positions of every grain, xy interleaved (length 2n). */
  source: Float32Array;
  /** Scene pixels already fitted to the frame (same aspect as the frame). */
  image: PixelImage;
  sample: SampleParams;
  /** Frame aspect (width / height). World space is x in [-aspect, aspect], y in [-1, 1]. */
  aspect: number;
  n: number;
  method: MatchMethod;
  iterations: number;
  seed: number;
}

export type WorkerRequest = MatchRequest;

export type WorkerResponse =
  | { type: 'progress'; id: number; value: number }
  | { type: 'result'; id: number; targets: Float32Array; ms: number; cost: number }
  | { type: 'error'; id: number; message: string };
