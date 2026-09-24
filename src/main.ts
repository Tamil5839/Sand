import './style.css';
import { FlowClient } from './flow';
import { downloadBlob, Recorder, type RecordFormat } from './recorder';
import { LightboxRenderer, type LookParams } from './render';
import { DEFAULT_MOTION, type MotionParams, SandSim } from './sim';
import {
  builtinScenes,
  type FontChoice,
  makeThumbnail,
  renderScene,
  type Scene,
  sampleParamsOf,
  sceneFromFile,
  textScene,
  Webcam,
  webcamScene,
} from './sources';
import { type FlowState, Timeline, type TimelineHost } from './timeline';
import type { MatchMethod } from './types';
import { buildUI } from './ui';
import { hashString, scatterPositions } from './util';

export type AspectPreset = '16:9' | '9:16' | '1:1' | 'window';

export interface Settings {
  grains: number;
  method: MatchMethod;
  iterations: number;
  aspect: AspectPreset;
  /** Preview render scale (recording always renders at full size). */
  previewScale: number;
  format: RecordFormat;
  mbps: number;
  fps: number;
  /** "Record full sequence" starts from poured sand instead of the first image. */
  intro: boolean;
}

type AppEvent = 'scenes' | 'state' | 'status' | 'selection' | 'webcam';

const PRESET_SIZE: Record<Exclude<AspectPreset, 'window'>, [number, number]> = {
  '16:9': [1920, 1080],
  '9:16': [1080, 1920],
  '1:1': [1080, 1080],
};

function readParams(): Partial<Settings> & { clean?: boolean } {
  const q = new URLSearchParams(location.search);
  const out: Partial<Settings> & { clean?: boolean } = {};
  const g = Number(q.get('grains'));
  if (g > 1000) out.grains = Math.min(1_000_000, g);
  const a = q.get('aspect');
  if (a === '16:9' || a === '9:16' || a === '1:1' || a === 'window') out.aspect = a;
  if (q.get('clean') === '1') out.clean = true;
  return out;
}

export class App {
  readonly canvas: HTMLCanvasElement;
  readonly lightbox: LightboxRenderer;
  readonly flow = new FlowClient();
  readonly recorder = new Recorder();
  readonly webcam = new Webcam();
  readonly motion: MotionParams = { ...DEFAULT_MOTION };
  readonly settings: Settings = {
    grains: 250_000,
    method: 'sot',
    iterations: 40,
    aspect: '16:9',
    previewScale: 1,
    format: 'auto',
    mbps: 24,
    fps: 60,
    intro: true,
  };
  readonly timeline: Timeline;
  sim: SandSim;
  aspect = 16 / 9;
  selected: Scene | null = null;
  uiHidden = false;
  clean = false;
  /** Status line text for the indicator ("computing flow…" etc). */
  status = '';
  statusProgress = 0;
  /** Measured frames per second (updated twice a second). */
  fps = 0;

  private epoch = 0;
  private transitions = 0;
  private preparing = '';
  private readonly listeners = new Map<AppEvent, Set<() => void>>();
  private readonly clickPoint = { x: 0, y: 0 };
  private readonly pointer = { down: false, x: 0, y: 0, px: 0, py: 0, id: -1 };
  private retargetTimer = 0;
  private resizeTimer = 0;
  private time = 0;
  private last = 0;
  private fpsFrames = 0;
  private fpsTime = 0;
  private recordingFull = false;
  private fullRes = false;
  private appliedPreset: AspectPreset = '16:9';
  private uiHiddenBeforeRecording = false;
  private loopBeforeSequence = true;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const params = readParams();
    Object.assign(this.settings, params);

    this.lightbox = new LightboxRenderer(canvas);
    const reason = LightboxRenderer.unsupportedReason(this.lightbox.renderer);
    if (reason) throw new Error(reason);

    this.appliedPreset = this.settings.aspect;
    const [w, h] = this.bufferSize();
    this.aspect = w / h;
    this.lightbox.setSize(w, h);
    this.sim = this.createSim();

    const host: TimelineHost = {
      flow: (from, scene, prefetch) => this.requestFlow(from, scene, prefetch),
      begin: (targets, scene, duration, sweep) => {
        this.sim.beginTransition(targets, {
          duration,
          sweep,
          origin: this.clickPoint,
          seed: ++this.transitions + scene.id * 13,
        });
      },
      changed: () => this.emit('state'),
      ended: () => this.onSequenceEnd(),
    };
    const scatter = this.scatterState();
    this.sim.reset(scatter.targets);
    this.timeline = new Timeline(host, scatter);
    this.timeline.scenes = builtinScenes();
    this.timeline.scenes.forEach((s) => this.refreshThumb(s));
    this.selected = this.timeline.scenes[0] ?? null;

    this.flow.onStatus = (busy, progress) => {
      this.statusProgress = progress;
      this.setStatus(this.preparing || (busy ? 'computing flow…' : ''));
    };

    this.attachPointer();
    this.layout();
    window.addEventListener('resize', () => this.onResize());
    if (params.clean) this.setClean(true);
  }

  // -------------------------------------------------------------------------
  // Events

  on(ev: AppEvent, fn: () => void): void {
    let set = this.listeners.get(ev);
    if (!set) this.listeners.set(ev, (set = new Set()));
    set.add(fn);
  }

  emit(ev: AppEvent): void {
    this.listeners.get(ev)?.forEach((fn) => fn());
  }

  private setStatus(text: string): void {
    this.status = text;
    this.emit('status');
  }

  toast(message: string): void {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(Number(el.dataset.timer));
    el.dataset.timer = String(window.setTimeout(() => el.classList.remove('show'), 2600));
  }

  // -------------------------------------------------------------------------
  // Sim + flows

  get look(): LookParams {
    return this.lightbox.look;
  }

  private createSim(): SandSim {
    const sim = new SandSim(this.lightbox.renderer, this.settings.grains, this.aspect);
    sim.motion = this.motion;
    this.lightbox.setGrainCount(sim.side);
    return sim;
  }

  private scatterState(tag = 'scatter'): FlowState {
    const seed = hashString(`${tag}:${this.epoch}`);
    return {
      key: `${tag}:${this.epoch}:${seed}`,
      targets: scatterPositions(this.sim.count, this.aspect, seed),
    };
  }

  private flowKey(fromKey: string, scene: Scene): string {
    const s = this.settings;
    const sig = `${fromKey}>${scene.id}.${scene.version}|${this.epoch}|${s.method}|${s.iterations}`;
    return `${hashString(sig).toString(36)}${hashString(sig + '#').toString(36)}`;
  }

  private requestFlow(
    from: FlowState,
    scene: Scene,
    prefetch = false,
  ): { key: string; promise: Promise<Float32Array> } {
    const key = this.flowKey(from.key, scene);
    const aspect = this.aspect;
    const n = this.sim.count;
    const promise = this.flow.request(key, () => ({
      source: from.targets,
      image: renderScene(scene, aspect),
      sample: sampleParamsOf(scene),
      aspect,
      n,
      method: this.settings.method,
      iterations: this.settings.iterations,
      seed: hashString(`${scene.id}:${scene.version}`),
    }), prefetch);
    return { key, promise };
  }

  // -------------------------------------------------------------------------
  // Playback

  togglePlay(): void {
    const t = this.timeline;
    if (t.playing) {
      t.playing = false;
    } else {
      t.playing = true;
      const atEnd = t.phase === 'hold' && !t.loop && t.index >= t.scenes.length - 1;
      if (atEnd) t.goTo(0);
    }
    this.emit('state');
  }

  /** Pour the sand back out and start the timeline from the first scene. */
  restart(): void {
    const scatter = this.scatterState(`pour${Date.now()}`);
    this.sim.reset(scatter.targets);
    this.timeline.reset(scatter);
    this.timeline.playing = true;
  }

  morphTo(scene: Scene): void {
    const i = this.timeline.scenes.indexOf(scene);
    if (i >= 0) this.timeline.goTo(i);
  }

  // -------------------------------------------------------------------------
  // Scenes

  select(scene: Scene | null): void {
    this.selected = scene;
    this.emit('selection');
    this.emit('scenes');
  }

  private refreshThumb(scene: Scene): void {
    scene.thumb = makeThumbnail(scene, this.aspect);
  }

  addScenes(list: Scene[], at = this.timeline.scenes.length): void {
    if (list.length === 0) return;
    const t = this.timeline;
    const current = t.currentScene;
    list.forEach((s) => this.refreshThumb(s));
    t.scenes.splice(at, 0, ...list);
    t.scenesChanged(current);
    this.select(list[list.length - 1]);
  }

  async addFiles(files: FileList | File[]): Promise<void> {
    const images = Array.from(files).filter((f) => f.type.startsWith('image/'));
    const scenes: Scene[] = [];
    for (const f of images) {
      try {
        scenes.push(await sceneFromFile(f));
      } catch (err) {
        console.error(err);
        this.toast(`Could not read ${f.name}`);
      }
    }
    this.addScenes(scenes);
    if (scenes.length) this.toast(`Added ${scenes.length} image${scenes.length > 1 ? 's' : ''}`);
  }

  addText(text: string, font: FontChoice): void {
    if (!text.trim()) return;
    this.addScenes([textScene(text, font)]);
  }

  async toggleWebcam(): Promise<void> {
    if (this.webcam.active) {
      this.webcam.stop();
    } else {
      try {
        await this.webcam.start();
      } catch (err) {
        console.error(err);
        this.toast('Webcam unavailable (permission denied or no camera)');
      }
    }
    this.emit('webcam');
  }

  /** Captures the webcam and inserts it as the next scene. */
  async snapshot(): Promise<void> {
    if (!this.webcam.active) {
      await this.toggleWebcam();
      if (!this.webcam.active) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    const scene = webcamScene(this.webcam.snapshot());
    const t = this.timeline;
    this.addScenes([scene], t.index >= 0 ? t.index + 1 : t.scenes.length);
    this.toast('Snapshot added as the next scene');
  }

  removeScene(scene: Scene): void {
    const t = this.timeline;
    const i = t.scenes.indexOf(scene);
    if (i < 0) return;
    const current = t.currentScene;
    t.scenes.splice(i, 1);
    if (current === scene) {
      // Keep the sand where it is; the scene that followed plays next.
      t.index = i - 1;
      t.scenesChanged(t.scenes[i - 1] ?? null);
      if (i === 0) t.index = -1;
    } else {
      t.scenesChanged(current);
    }
    if (this.selected === scene) this.select(t.scenes[Math.min(i, t.scenes.length - 1)] ?? null);
    else this.emit('scenes');
  }

  moveScene(from: number, to: number): void {
    const t = this.timeline;
    if (from === to || from < 0 || from >= t.scenes.length) return;
    const current = t.currentScene;
    const [s] = t.scenes.splice(from, 1);
    t.scenes.splice(Math.min(to, t.scenes.length), 0, s);
    t.scenesChanged(current);
    this.emit('scenes');
  }

  /**
   * A scene's settings changed. Sampling changes bump its version; if it is on
   * the glass right now, the sand re-flows into the new shape.
   */
  sceneEdited(scene: Scene, resample: boolean): void {
    if (!resample) {
      this.emit('scenes');
      return;
    }
    scene.version++;
    clearTimeout(this.retargetTimer);
    this.retargetTimer = window.setTimeout(() => {
      this.refreshThumb(scene);
      this.emit('scenes');
      const t = this.timeline;
      if (t.currentScene === scene && t.phase !== 'idle') t.goTo(t.index, { duration: 1.4, sweep: 'random' });
      else if (t.phase !== 'idle') t.prefetch();
    }, 250);
  }

  flowSettingsChanged(): void {
    this.timeline.prefetch();
  }

  // -------------------------------------------------------------------------
  // Grain count / frame

  setGrains(count: number): void {
    const t = this.timeline;
    const index = t.index;
    this.sim.dispose();
    this.settings.grains = count;
    this.epoch++;
    this.flow.clear();
    this.sim = this.createSim();
    const scatter = this.scatterState();
    this.sim.reset(scatter.targets);
    t.reset(scatter);
    if (t.scenes.length) t.goTo(Math.max(0, index), { duration: 3 });
    this.toast(`${this.sim.count.toLocaleString()} grains`);
  }

  private bufferSize(): [number, number] {
    const s = this.settings;
    const scale = this.fullRes ? 1 : s.previewScale;
    if (s.aspect === 'window') {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      return [
        Math.max(2, Math.round(window.innerWidth * dpr * scale)),
        Math.max(2, Math.round(window.innerHeight * dpr * scale)),
      ];
    }
    const [w, h] = PRESET_SIZE[s.aspect];
    return [Math.round(w * scale), Math.round(h * scale)];
  }

  /** Re-applies canvas resolution; if the frame shape changed, sand re-flows to fit. */
  applyResolution(): void {
    this.appliedPreset = this.settings.aspect;
    const [w, h] = this.bufferSize();
    const aspect = w / h;
    this.lightbox.setSize(w, h);
    this.layout();
    if (Math.abs(aspect - this.aspect) < 1e-3) return;
    this.aspect = aspect;
    this.sim.setAspect(aspect);
    this.epoch++;
    this.flow.clear();
    const t = this.timeline;
    t.scenes.forEach((s) => this.refreshThumb(s));
    this.emit('scenes');
    t.current = { key: `reframe:${this.epoch}`, targets: t.current.targets };
    if (t.index >= 0) t.goTo(t.index, { duration: 1.6, sweep: 'center-out' });
  }

  setAspect(preset: AspectPreset): void {
    if (this.recorder.recording) {
      this.settings.aspect = this.appliedPreset;
      this.toast('Stop recording to change the frame');
      return;
    }
    this.settings.aspect = preset;
    this.applyResolution();
  }

  private onResize(): void {
    this.layout();
    if (this.settings.aspect !== 'window' || this.recorder.recording) return;
    clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => this.applyResolution(), 300);
  }

  /** Letterboxes the canvas into the window. */
  layout(): void {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const s = Math.min(window.innerWidth / w, window.innerHeight / h);
    this.canvas.style.width = `${Math.floor(w * s)}px`;
    this.canvas.style.height = `${Math.floor(h * s)}px`;
  }

  // -------------------------------------------------------------------------
  // UI visibility

  setUIHidden(hidden: boolean): void {
    this.uiHidden = hidden;
    document.body.classList.toggle('ui-hidden', hidden);
    this.emit('state');
  }

  setClean(on: boolean): void {
    this.clean = on;
    document.body.classList.toggle('clean', on);
    this.setUIHidden(on);
    if (on) this.toast('Clean mode: press C or Esc to exit');
  }

  // -------------------------------------------------------------------------
  // Recording

  async toggleRecord(): Promise<void> {
    if (this.recorder.recording) await this.stopRecording();
    else this.startRecording();
  }

  private startRecording(): boolean {
    if (this.recorder.recording) return false;
    this.uiHiddenBeforeRecording = this.uiHidden;
    // Recording always renders at full resolution.
    this.fullRes = true;
    this.applyResolution();
    try {
      const { fps, mbps, format } = this.settings;
      this.recorder.start(this.canvas, { fps, mbps, format });
    } catch (err) {
      this.fullRes = false;
      this.applyResolution();
      this.toast(err instanceof Error ? err.message : String(err));
      return false;
    }
    this.setUIHidden(true);
    this.emit('state');
    return true;
  }

  async stopRecording(): Promise<void> {
    if (!this.recorder.recording) return;
    if (this.timeline.inSequence) this.timeline.cancelSequence();
    const blob = await this.recorder.stop();
    this.fullRes = false;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    downloadBlob(blob, `sandglass-${stamp}.${this.recorder.extension}`);
    if (this.recordingFull) {
      this.recordingFull = false;
      this.timeline.loop = this.loopBeforeSequence;
    }
    this.applyResolution();
    this.setUIHidden(this.clean || this.uiHiddenBeforeRecording);
    this.toast(`Saved ${(blob.size / 1e6).toFixed(1)} MB ${this.recorder.label}`);
    this.emit('state');
  }

  /** Plays the whole timeline once from the start, recording it, then stops. */
  async recordSequence(): Promise<void> {
    const t = this.timeline;
    if (this.recorder.recording || this.preparing || t.scenes.length === 0) return;
    t.playing = false;
    const scatter = this.scatterState(`seq${Date.now()}`);
    const chain: FlowState[] = [];
    let from = scatter;
    try {
      for (let i = 0; i < t.scenes.length; i++) {
        this.preparing = `preparing flows ${i + 1}/${t.scenes.length}…`;
        this.setStatus(this.preparing);
        const { key, promise } = this.requestFlow(from, t.scenes[i]);
        from = { key, targets: await promise };
        chain.push(from);
      }
    } catch (err) {
      this.toast(`Flow failed: ${err instanceof Error ? err.message : err}`);
      return;
    } finally {
      this.preparing = '';
      this.setStatus(this.flow.busy ? 'computing flow…' : '');
    }

    this.loopBeforeSequence = t.loop;
    t.loop = false;
    this.recordingFull = true;
    if (this.settings.intro) {
      this.sim.reset(scatter.targets);
      t.reset(scatter);
    } else {
      this.sim.reset(chain[0].targets);
      t.holdAt(0, chain[0]);
    }
    if (!this.startRecording()) {
      this.recordingFull = false;
      t.loop = this.loopBeforeSequence;
      return;
    }
    t.startSequence(this.settings.intro ? 0 : null);
  }

  private onSequenceEnd(): void {
    // A beat of stillness at the end, then stop.
    window.setTimeout(() => void this.stopRecording(), 400);
  }

  // -------------------------------------------------------------------------
  // Finger

  private toWorld(clientX: number, clientY: number): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    const nx = (clientX - r.left) / r.width;
    const ny = (clientY - r.top) / r.height;
    return [(nx * 2 - 1) * this.aspect, 1 - ny * 2];
  }

  private attachPointer(): void {
    const c = this.canvas;
    const p = this.pointer;
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      c.setPointerCapture(e.pointerId);
      const [x, y] = this.toWorld(e.clientX, e.clientY);
      p.down = true;
      p.id = e.pointerId;
      p.x = p.px = x;
      p.y = p.py = y;
      this.clickPoint.x = x;
      this.clickPoint.y = y;
    });
    c.addEventListener('pointermove', (e) => {
      if (!p.down || e.pointerId !== p.id) return;
      const [x, y] = this.toWorld(e.clientX, e.clientY);
      p.x = x;
      p.y = y;
    });
    const up = (e: PointerEvent) => {
      if (e.pointerId !== p.id) return;
      p.down = false;
      p.id = -1;
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
  }

  private updateFinger(dt: number): void {
    const p = this.pointer;
    const f = this.sim.finger;
    f.on = p.down;
    f.ax = p.px;
    f.ay = p.py;
    f.bx = p.x;
    f.by = p.y;
    f.speed = dt > 0 ? Math.hypot(p.x - p.px, p.y - p.py) / dt : 0;
    f.releaseAge = p.down ? 0 : f.releaseAge + dt;
    p.px = p.x;
    p.py = p.y;
  }

  // -------------------------------------------------------------------------
  // Frame loop

  /** Runs the simulation forward without waiting for real time (for testing/tuning). */
  debugAdvance(seconds: number, step = 1 / 30): void {
    for (let t = 0; t < seconds; t += step) {
      this.time += step;
      this.updateFinger(step);
      this.timeline.update(step);
      this.sim.step(step, this.time);
    }
    this.lightbox.render(this.sim.positions, step);
  }

  start(): void {
    this.last = performance.now();
    const frame = (now: number) => {
      requestAnimationFrame(frame);
      const real = Math.max((now - this.last) / 1000, 0);
      const dt = Math.min(real, 1 / 20);
      this.last = now;
      this.fpsFrames++;
      this.fpsTime += real;
      if (this.fpsTime >= 0.5) {
        this.fps = this.fpsFrames / this.fpsTime;
        this.fpsFrames = 0;
        this.fpsTime = 0;
      }
      this.time += dt;
      this.updateFinger(dt);
      this.timeline.update(dt);
      this.sim.step(dt, this.time);
      this.lightbox.render(this.sim.positions, dt);
    };
    requestAnimationFrame(frame);
  }
}

function boot(): void {
  const canvas = document.getElementById('lightbox') as HTMLCanvasElement;
  try {
    const app = new App(canvas);
    buildUI(app);
    app.start();
    (window as unknown as { sandglass: App }).sandglass = app;
  } catch (err) {
    console.error(err);
    const el = document.getElementById('fatal');
    if (el) {
      el.textContent = `Sandglass can't run here: ${err instanceof Error ? err.message : err}`;
      el.hidden = false;
    }
  }
}

boot();
