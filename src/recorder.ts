// Canvas recording: canvas.captureStream + MediaRecorder -> file download.
// MP4 (H.264) is preferred when the browser can record it, since X/Twitter
// does not accept WebM uploads.

export type RecordFormat = 'auto' | 'mp4' | 'webm';

// H.264 only: a plain 'video/mp4' may be VP9-in-MP4 (open-source Chromium),
// which X/Twitter rejects, so WebM is the more honest fallback.
const MP4_TYPES = [
  'video/mp4;codecs=avc1.640033',
  'video/mp4;codecs=avc1.64002A',
  'video/mp4;codecs=avc1.640028',
  'video/mp4;codecs=avc1.4D402A',
  'video/mp4;codecs=avc1',
];
const WEBM_TYPES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];

export function pickMimeType(format: RecordFormat): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  const list =
    format === 'mp4' ? MP4_TYPES : format === 'webm' ? WEBM_TYPES : [...MP4_TYPES, ...WEBM_TYPES];
  return list.find((t) => MediaRecorder.isTypeSupported(t)) ?? null;
}

export interface RecordOptions {
  fps: number;
  /** Video bitrate in megabits per second. */
  mbps: number;
  format: RecordFormat;
}

export class Recorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;
  private startedAt = 0;
  mimeType = '';

  get recording(): boolean {
    return this.recorder !== null;
  }

  get elapsed(): number {
    return this.recorder ? (performance.now() - this.startedAt) / 1000 : 0;
  }

  get extension(): string {
    return this.mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
  }

  /** Human-readable codec, e.g. "MP4 (H.264)". */
  get label(): string {
    const codec = /avc1/.test(this.mimeType) ? 'H.264' : /vp9/.test(this.mimeType) ? 'VP9' : /vp8/.test(this.mimeType) ? 'VP8' : '';
    return `${this.extension.toUpperCase()}${codec ? ` (${codec})` : ''}`;
  }

  /** Throws if the browser can't record. */
  start(canvas: HTMLCanvasElement, opts: RecordOptions): void {
    if (this.recorder) return;
    const mime = pickMimeType(opts.format);
    if (!mime) {
      throw new Error(
        opts.format === 'mp4'
          ? 'This browser cannot record H.264 MP4. Choose "MP4 if supported" or WebM.'
          : 'This browser cannot record the canvas (MediaRecorder unsupported).',
      );
    }
    this.mimeType = mime;
    this.stream = canvas.captureStream(opts.fps);
    this.chunks = [];
    const rec = new MediaRecorder(this.stream, {
      mimeType: mime,
      videoBitsPerSecond: Math.round(opts.mbps * 1_000_000),
    });
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    rec.start(1000);
    this.recorder = rec;
    this.startedAt = performance.now();
  }

  stop(): Promise<Blob> {
    const rec = this.recorder;
    if (!rec) return Promise.reject(new Error('Not recording'));
    return new Promise((resolve) => {
      rec.onstop = () => {
        const blob = new Blob(this.chunks, { type: this.mimeType.split(';')[0] });
        this.chunks = [];
        this.stream?.getTracks().forEach((t) => t.stop());
        this.stream = null;
        this.recorder = null;
        resolve(blob);
      };
      rec.stop();
    });
  }
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
