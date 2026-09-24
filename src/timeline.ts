// Scene sequencing: hold -> (flow ready?) -> transition -> hold -> ...
// The next flow is requested as soon as a transition starts, so it is
// usually computed long before the hold ends.

import type { Scene } from './sources';
import type { SweepMode } from './types';

/** Where the grains rest: the flow-chain key and the per-grain target positions. */
export interface FlowState {
  key: string;
  targets: Float32Array;
}

export interface TimelineHost {
  /** Flow from the current rest state to a scene (cached by key). */
  flow(from: FlowState, scene: Scene, prefetch?: boolean): { key: string; promise: Promise<Float32Array> };
  begin(targets: Float32Array, scene: Scene, duration: number, sweep: SweepMode): void;
  changed(): void;
  /** A sequence started with `startSequence` finished its last hold. */
  ended(): void;
}

export type Phase = 'idle' | 'transition' | 'hold';

export interface GoOptions {
  duration?: number;
  sweep?: SweepMode;
}

export class Timeline {
  scenes: Scene[] = [];
  playing = true;
  loop = true;
  /** Scene the grains are forming or holding (-1 = none yet). */
  index = -1;
  phase: Phase = 'idle';
  phaseTime = 0;
  transitionDuration = 0;
  /** Scene whose flow is being computed, if any. */
  waiting: Scene | null = null;
  current: FlowState;

  private token = 0;
  private sequence = false;

  constructor(private readonly host: TimelineHost, initial: FlowState) {
    this.current = initial;
  }

  get currentScene(): Scene | null {
    return this.scenes[this.index] ?? null;
  }

  /** Forget everything in flight; grains are at rest at `state`. */
  reset(state: FlowState): void {
    this.token++;
    this.current = state;
    this.index = -1;
    this.phase = 'idle';
    this.phaseTime = 0;
    this.waiting = null;
    this.sequence = false;
    this.host.changed();
  }

  /** Grains already sit on scene `index` (e.g. after a direct reset). */
  holdAt(index: number, state: FlowState): void {
    this.token++;
    this.current = state;
    this.index = index;
    this.phase = 'hold';
    this.phaseTime = 0;
    this.waiting = null;
    this.prefetch();
    this.host.changed();
  }

  goTo(i: number, opts: GoOptions = {}): void {
    const scene = this.scenes[i];
    if (!scene) return;
    const token = ++this.token;
    const { key, promise } = this.host.flow(this.current, scene);
    this.waiting = scene;
    this.host.changed();
    promise.then(
      (targets) => {
        if (token !== this.token) return;
        this.start(scene, { key, targets }, opts);
      },
      (err) => {
        if (token !== this.token) return;
        console.error('[sandglass] flow failed', err);
        this.waiting = null;
        // Don't retry every frame from the idle state.
        if (this.phase === 'idle') this.playing = false;
        this.host.changed();
      },
    );
  }

  next(): void {
    const n = this.nextIndex(true);
    if (n >= 0) this.goTo(n);
  }

  prev(): void {
    if (!this.scenes.length) return;
    const p = this.index <= 0 ? this.scenes.length - 1 : this.index - 1;
    this.goTo(p);
  }

  /**
   * Plays through to the last scene once, then calls host.ended() after its
   * hold. `fromIndex` = scene to morph to first, or null to continue from the
   * scene currently held.
   */
  startSequence(fromIndex: number | null): void {
    this.sequence = true;
    this.playing = true;
    if (fromIndex !== null && fromIndex < this.scenes.length) this.goTo(fromIndex);
  }

  get inSequence(): boolean {
    return this.sequence;
  }

  cancelSequence(): void {
    this.sequence = false;
  }

  private start(scene: Scene, state: FlowState, opts: GoOptions): void {
    this.index = this.scenes.indexOf(scene);
    this.current = state;
    this.phase = 'transition';
    this.phaseTime = 0;
    this.waiting = null;
    this.transitionDuration = opts.duration ?? scene.transition;
    this.host.begin(state.targets, scene, this.transitionDuration, opts.sweep ?? scene.sweep);
    this.prefetch();
    this.host.changed();
  }

  private nextIndex(wrap: boolean): number {
    const len = this.scenes.length;
    if (len === 0) return -1;
    const n = this.index + 1;
    if (n < len) return n;
    return wrap ? 0 : -1;
  }

  /** Start computing the flow to the scene after this one. */
  prefetch(): void {
    const n = this.nextIndex(this.loop && !this.sequence);
    if (n < 0) return;
    // Let this frame finish (texture upload etc.) before rendering pixels.
    const from = this.current;
    const scene = this.scenes[n];
    setTimeout(() => {
      if (this.current !== from) return;
      this.host.flow(from, scene, true).promise.catch(() => {});
    }, 30);
  }

  /** Call after scenes were added, removed or reordered. */
  scenesChanged(current: Scene | null): void {
    this.index = current ? this.scenes.indexOf(current) : Math.min(this.index, this.scenes.length - 1);
    if (this.phase !== 'idle') this.prefetch();
    this.host.changed();
  }

  update(dt: number): void {
    if (this.phase === 'transition') {
      this.phaseTime += dt;
      if (this.phaseTime >= this.transitionDuration) {
        this.phase = 'hold';
        this.phaseTime = 0;
        this.host.changed();
      }
      return;
    }
    if (this.phase === 'idle' && this.playing && !this.waiting && this.scenes.length > 0) {
      this.goTo(0);
      return;
    }
    if (this.phase !== 'hold' || !this.playing || this.waiting) return;
    this.phaseTime += dt;
    const hold = this.currentScene?.hold ?? 2;
    if (this.phaseTime < hold) return;
    const n = this.nextIndex(this.loop && !this.sequence);
    if (n >= 0) {
      this.goTo(n);
    } else if (this.sequence) {
      this.sequence = false;
      this.playing = false;
      this.host.ended();
    } else {
      this.playing = false;
      this.host.changed();
    }
  }
}
