// Scene sources: uploaded images, typed text, webcam snapshots and a few
// built-in drawings. Everything is rendered to a frame-shaped canvas whose
// pixels go to the sampler (dark = sand).

import { computeWeights, DEFAULT_SAMPLE } from './sampler';
import type { PixelImage, SampleParams, SweepMode } from './types';
import { mulberry32 } from './util';

export type SceneKind = 'image' | 'text' | 'webcam' | 'builtin';
export type FontChoice = 'sans' | 'serif' | 'mono' | 'script';

export interface Scene extends SampleParams {
  id: number;
  name: string;
  kind: SceneKind;
  /** Bumped whenever anything that changes the sampled targets changes. */
  version: number;
  image: CanvasImageSource | null;
  imageWidth: number;
  imageHeight: number;
  text: string;
  font: FontChoice;
  /** Size inside the frame (1 = fit). */
  scale: number;
  hold: number;
  transition: number;
  sweep: SweepMode;
  /** Preview data URL for the scene strip. */
  thumb: string;
}

let nextId = 1;

export function createScene(init: Partial<Scene> & Pick<Scene, 'name' | 'kind'>): Scene {
  return {
    ...DEFAULT_SAMPLE,
    id: nextId++,
    version: 0,
    image: null,
    imageWidth: 0,
    imageHeight: 0,
    text: '',
    font: 'sans',
    scale: 0.9,
    hold: 2,
    transition: 3.5,
    sweep: 'left-right',
    thumb: '',
    ...init,
  };
}

export function sampleParamsOf(s: Scene): SampleParams {
  return {
    threshold: s.threshold,
    contrast: s.contrast,
    gamma: s.gamma,
    invert: s.invert,
    dust: s.dust,
    sharpen: s.sharpen,
    autoLevels: s.autoLevels,
  };
}

const FONTS: Record<FontChoice, (px: number) => string> = {
  sans: (px) => `900 ${px}px "Arial Black", "Helvetica Neue", Helvetica, Arial, sans-serif`,
  serif: (px) => `bold ${px}px Georgia, "Times New Roman", Times, serif`,
  mono: (px) => `bold ${px}px "SFMono-Regular", Menlo, Consolas, "Courier New", monospace`,
  script: (px) => `italic bold ${px}px "Snell Roundhand", "Brush Script MT", "Segoe Script", cursive`,
};

function drawText(ctx: CanvasRenderingContext2D, w: number, h: number, scene: Scene): void {
  const lines = scene.text.split(/\n|\\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return;
  const base = 100;
  ctx.font = FONTS[scene.font](base);
  let widest = 1;
  for (const l of lines) widest = Math.max(widest, ctx.measureText(l).width);
  const lineH = 1.08;
  const size = Math.min(
    (w * scene.scale * 0.92 * base) / widest,
    (h * scene.scale * 0.82) / (lines.length * lineH),
  );
  ctx.font = FONTS[scene.font](size);
  ctx.fillStyle = '#000';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const top = h / 2 - ((lines.length - 1) * size * lineH) / 2;
  lines.forEach((l, i) => ctx.fillText(l, w / 2, top + i * size * lineH));
}

let frameCanvas: HTMLCanvasElement | null = null;

/** Frame-sized pixel size for a given aspect and long side. */
export function frameSize(aspect: number, longSide: number): [number, number] {
  return aspect >= 1
    ? [longSide, Math.max(1, Math.round(longSide / aspect))]
    : [Math.max(1, Math.round(longSide * aspect)), longSide];
}

/**
 * Draws the scene into a frame-shaped canvas (transparent = no sand) and
 * returns its pixels.
 */
export function renderScene(scene: Scene, aspect: number, longSide = 1024): PixelImage {
  const [w, h] = frameSize(aspect, longSide);
  if (!frameCanvas) frameCanvas = document.createElement('canvas');
  frameCanvas.width = w;
  frameCanvas.height = h;
  const ctx = frameCanvas.getContext('2d', { willReadFrequently: true })!;
  ctx.clearRect(0, 0, w, h);
  if (scene.kind === 'text') {
    drawText(ctx, w, h, scene);
  } else if (scene.image && scene.imageWidth > 0) {
    const s = Math.min(w / scene.imageWidth, h / scene.imageHeight) * scene.scale;
    const dw = scene.imageWidth * s;
    const dh = scene.imageHeight * s;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(scene.image, (w - dw) / 2, (h - dh) / 2, dw, dh);
  }
  const img = ctx.getImageData(0, 0, w, h);
  return { data: img.data, width: w, height: h };
}

/** Small preview of where the sand will go, tinted like the lightbox. */
export function makeThumbnail(scene: Scene, aspect: number): string {
  const img = renderScene(scene, aspect, 144);
  const weights = computeWeights(img, sampleParamsOf(scene));
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d')!;
  const out = ctx.createImageData(img.width, img.height);
  for (let i = 0; i < weights.length; i++) {
    const t = Math.exp(-3.2 * weights[i]);
    out.data[4 * i] = 255 * t + 40 * (1 - t);
    out.data[4 * i + 1] = 213 * t * t + 24 * (1 - t);
    out.data[4 * i + 2] = 154 * t * t * t + 14 * (1 - t);
    out.data[4 * i + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
  return c.toDataURL('image/png');
}

export async function sceneFromFile(file: File): Promise<Scene> {
  const bitmap = await createImageBitmap(file);
  const name = file.name.replace(/\.[^.]+$/, '');
  const isPhoto = /jpe?g|webp|heic/i.test(file.type);
  return createScene({
    name,
    kind: 'image',
    image: bitmap,
    imageWidth: bitmap.width,
    imageHeight: bitmap.height,
    // Photos need a little help to read as sand; flat logos don't.
    ...(isPhoto ? { autoLevels: true, sharpen: 0.8, threshold: 0.12, contrast: 1.25, gamma: 1.1 } : {}),
  });
}

export function textScene(text: string, font: FontChoice = 'sans'): Scene {
  return createScene({
    name: text.replace(/\\n|\s+/g, ' ').slice(0, 24) || 'Text',
    kind: 'text',
    // Line breaks are stored as a literal "\n" so the one-line text field can edit them.
    text: text.replace(/\r?\n/g, '\\n'),
    font,
    scale: 0.85,
    threshold: 0.05,
    contrast: 1,
  });
}

// ---------------------------------------------------------------------------
// Webcam

export class Webcam {
  readonly video: HTMLVideoElement;
  private stream: MediaStream | null = null;

  constructor() {
    this.video = document.createElement('video');
    this.video.playsInline = true;
    this.video.muted = true;
  }

  get active(): boolean {
    return this.stream !== null;
  }

  async start(): Promise<void> {
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();
    // Wait for real frames; some cameras report 0x0 for a moment.
    for (let i = 0; i < 50 && this.video.videoWidth === 0; i++) {
      await new Promise((r) => setTimeout(r, 40));
    }
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  /** Mirrored snapshot, so it matches what you see in the preview. */
  snapshot(): HTMLCanvasElement {
    const w = this.video.videoWidth || 1280;
    const h = this.video.videoHeight || 720;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d')!;
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(this.video, 0, 0, w, h);
    return c;
  }
}

let snapCount = 0;

export function webcamScene(canvas: HTMLCanvasElement): Scene {
  snapCount++;
  return createScene({
    name: `Snapshot ${snapCount}`,
    kind: 'webcam',
    image: canvas,
    imageWidth: canvas.width,
    imageHeight: canvas.height,
    scale: 1,
    autoLevels: true,
    sharpen: 1.0,
    threshold: 0.15,
    contrast: 1.3,
    gamma: 1.15,
    sweep: 'center-out',
  });
}

// ---------------------------------------------------------------------------
// Built-in drawings, so the app has something to morph on first load.

function canvas2d(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

/** Hourglass mark: the app's logo. */
function drawHourglass(): HTMLCanvasElement {
  const [c, ctx] = canvas2d(1000, 1000);
  ctx.fillStyle = '#000';
  ctx.strokeStyle = '#000';
  ctx.beginPath();
  ctx.roundRect(250, 80, 500, 60, 24);
  ctx.roundRect(250, 860, 500, 60, 24);
  ctx.fill();
  ctx.fillRect(282, 140, 26, 720);
  ctx.fillRect(692, 140, 26, 720);

  const glass = new Path2D();
  glass.moveTo(345, 140);
  glass.bezierCurveTo(345, 330, 478, 420, 486, 500);
  glass.bezierCurveTo(478, 580, 345, 670, 345, 860);
  glass.lineTo(655, 860);
  glass.bezierCurveTo(655, 670, 522, 580, 514, 500);
  glass.bezierCurveTo(522, 420, 655, 330, 655, 140);
  glass.closePath();
  ctx.lineWidth = 18;
  ctx.stroke(glass);

  ctx.save();
  ctx.clip(glass);
  // Sand left in the top bulb, with a dip where it drains.
  ctx.beginPath();
  ctx.moveTo(300, 330);
  ctx.quadraticCurveTo(500, 400, 700, 330);
  ctx.lineTo(700, 520);
  ctx.lineTo(300, 520);
  ctx.fill();
  // The falling stream and the pile below.
  ctx.fillRect(494, 500, 12, 250);
  ctx.beginPath();
  ctx.moveTo(300, 870);
  ctx.bezierCurveTo(420, 860, 450, 720, 500, 715);
  ctx.bezierCurveTo(550, 720, 580, 860, 700, 870);
  ctx.fill();
  ctx.restore();
  return c;
}

/** A face in profile with a bun and flowing strands. */
function drawProfile(): HTMLCanvasElement {
  const [c, ctx] = canvas2d(1000, 1000);
  ctx.fillStyle = '#000';
  ctx.strokeStyle = '#000';
  ctx.lineCap = 'round';

  const pts: [number, number][] = [
    [420, 1000], [440, 860], [410, 720], [330, 610], [290, 470], [320, 320], [420, 205],
    [560, 175], [650, 225], [695, 310], [704, 385], [690, 425], [702, 455], [742, 510],
    [772, 548], [742, 566], [722, 578], [736, 604], [716, 622], [728, 646], [712, 668],
    [704, 690], [718, 732], [690, 768], [640, 786], [605, 808], [612, 900], [640, 1000],
  ];
  // Catmull-Rom through the points for a smooth silhouette.
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    ctx.bezierCurveTo(
      p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6,
      p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6,
      p2[0], p2[1],
    );
  }
  ctx.closePath();
  ctx.fill();

  // Bun.
  ctx.beginPath();
  ctx.ellipse(300, 300, 125, 115, -0.4, 0, Math.PI * 2);
  ctx.fill();

  // Loose strands blowing back.
  const rnd = mulberry32(11);
  for (let i = 0; i < 26; i++) {
    const y0 = 240 + i * 16 + rnd() * 10;
    ctx.lineWidth = 3 + rnd() * 7;
    ctx.beginPath();
    ctx.moveTo(330 + rnd() * 40, y0);
    ctx.bezierCurveTo(200 - rnd() * 60, y0 + 40, 180 - rnd() * 80, y0 + 140, 60 + rnd() * 120, y0 + 220 + rnd() * 80);
    ctx.stroke();
  }

  // Eye and lashes cut out of the silhouette so the face reads.
  ctx.globalCompositeOperation = 'destination-out';
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.moveTo(640, 432);
  ctx.quadraticCurveTo(662, 418, 682, 434);
  ctx.stroke();
  ctx.lineWidth = 4;
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.moveTo(648 + i * 12, 426 - i);
    ctx.lineTo(642 + i * 11, 410 - i * 2);
    ctx.stroke();
  }
  // Ear line.
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(470, 470, 34, -1.2, 1.9);
  ctx.stroke();
  return c;
}

/** A bare tree on a small hill. */
function drawTree(): HTMLCanvasElement {
  const [c, ctx] = canvas2d(1200, 1000);
  ctx.fillStyle = '#000';
  ctx.strokeStyle = '#000';
  ctx.lineCap = 'round';
  const rnd = mulberry32(5);
  const branch = (x: number, y: number, len: number, ang: number, width: number, depth: number) => {
    const x2 = x + Math.cos(ang) * len;
    const y2 = y + Math.sin(ang) * len;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(
      (x + x2) / 2 + (rnd() - 0.5) * len * 0.25,
      (y + y2) / 2 + (rnd() - 0.5) * len * 0.25,
      x2,
      y2,
    );
    ctx.stroke();
    if (depth === 0) return;
    const kids = rnd() < 0.3 ? 3 : 2;
    for (let k = 0; k < kids; k++) {
      const spread = 0.35 + rnd() * 0.3;
      const a = ang + (k - (kids - 1) / 2) * spread * 1.4 + (rnd() - 0.5) * 0.2;
      branch(x2, y2, len * (0.7 + rnd() * 0.12), a, width * 0.68, depth - 1);
    }
  };
  branch(600, 880, 200, -Math.PI / 2, 46, 9);
  ctx.beginPath();
  ctx.ellipse(600, 1000, 560, 150, 0, Math.PI, Math.PI * 2);
  ctx.fill();
  return c;
}

export function builtinScenes(): Scene[] {
  const fromCanvas = (name: string, c: HTMLCanvasElement, extra: Partial<Scene> = {}) =>
    createScene({
      name,
      kind: 'builtin',
      image: c,
      imageWidth: c.width,
      imageHeight: c.height,
      threshold: 0.05,
      contrast: 1,
      ...extra,
    });
  return [
    fromCanvas('Hourglass', drawHourglass(), { sweep: 'center-out' }),
    fromCanvas('Profile', drawProfile(), { sweep: 'left-right', dust: 0.04 }),
    { ...textScene('made of\nsand', 'serif'), sweep: 'top-bottom' },
    fromCanvas('Tree', drawTree(), { sweep: 'bottom-top', scale: 0.95 }),
  ];
}
