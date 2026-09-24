// Main-thread client for the matcher worker. Requests are cached by a key
// that captures the whole chain (where the grains start + which scene +
// settings), so prefetched flows are reused when the timeline gets there.
//
// The worker runs one job at a time. Jobs you are waiting for jump the
// queue; a speculative prefetch is dropped when a newer prefetch replaces it,
// so tweaking settings never leaves a backlog of stale work.

import type { MatchRequest, WorkerResponse } from './types';

type RequestBody = Omit<MatchRequest, 'type' | 'id'>;

interface Job {
  id: number;
  key: string;
  build: () => RequestBody;
  prefetch: boolean;
  resolve: (targets: Float32Array) => void;
  reject: (err: Error) => void;
}

const MAX_CACHE = 40;

export class FlowClient {
  /** Called when the worker becomes busy/idle or reports progress. */
  onStatus: (busy: boolean, progress: number) => void = () => {};
  /** Stats of the last finished flow. */
  lastMs = 0;
  lastCost = 0;

  private readonly worker: Worker;
  private nextId = 1;
  private readonly cache = new Map<string, Promise<Float32Array>>();
  private queue: Job[] = [];
  private running: Job | null = null;
  private progress = 0;

  constructor() {
    this.worker = new Worker(new URL('./matcher.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => this.handle(ev.data);
    this.worker.onerror = (ev) => {
      const err = new Error(ev.message || 'Flow worker crashed');
      this.running?.reject(err);
      this.running = null;
      this.pump();
    };
  }

  get busy(): boolean {
    return this.running !== null || this.queue.length > 0;
  }

  private emit(): void {
    this.onStatus(this.busy, this.progress);
  }

  private handle(msg: WorkerResponse): void {
    const job = this.running;
    if (!job || msg.id !== job.id) return;
    if (msg.type === 'progress') {
      this.progress = msg.value;
      this.emit();
      return;
    }
    this.running = null;
    this.progress = 0;
    if (msg.type === 'result') {
      this.lastMs = msg.ms;
      this.lastCost = msg.cost;
      job.resolve(msg.targets);
    } else {
      job.reject(new Error(msg.message));
    }
    this.pump();
  }

  private pump(): void {
    if (!this.running) {
      const job = this.queue.shift();
      if (job) {
        this.running = job;
        try {
          // Build lazily: scene pixels are rendered just before sending.
          const msg: MatchRequest = { type: 'match', id: job.id, ...job.build() };
          this.worker.postMessage(msg);
        } catch (err) {
          this.running = null;
          job.reject(err instanceof Error ? err : new Error(String(err)));
          this.pump();
          return;
        }
      }
    }
    this.emit();
  }

  /**
   * Returns the cached flow for `key`, or queues it. `build` only runs when the
   * job is sent to the worker. Prefetches yield to everything else, and a new
   * prefetch replaces older queued ones.
   */
  request(key: string, build: () => RequestBody, prefetch = false): Promise<Float32Array> {
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      if (!prefetch) this.promote(key);
      return hit;
    }

    let resolve!: (t: Float32Array) => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<Float32Array>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const job: Job = { id: this.nextId++, key, build, prefetch, resolve, reject };
    this.cache.set(key, promise);
    promise.catch(() => {
      if (this.cache.get(key) === promise) this.cache.delete(key);
    });

    if (prefetch) {
      this.dropQueued((j) => j.prefetch);
      this.queue.push(job);
    } else {
      const firstPrefetch = this.queue.findIndex((j) => j.prefetch);
      this.queue.splice(firstPrefetch < 0 ? this.queue.length : firstPrefetch, 0, job);
    }
    while (this.cache.size > MAX_CACHE) {
      const oldest = this.cache.keys().next().value as string;
      if (this.queue.some((j) => j.key === oldest) || this.running?.key === oldest) break;
      this.cache.delete(oldest);
    }
    this.pump();
    return promise;
  }

  /** Someone is now waiting on a queued prefetch: make it a real job. */
  private promote(key: string): void {
    const i = this.queue.findIndex((j) => j.key === key);
    if (i < 0 || !this.queue[i].prefetch) return;
    const [job] = this.queue.splice(i, 1);
    job.prefetch = false;
    const firstPrefetch = this.queue.findIndex((j) => j.prefetch);
    this.queue.splice(firstPrefetch < 0 ? this.queue.length : firstPrefetch, 0, job);
  }

  private dropQueued(match: (j: Job) => boolean): void {
    const keep: Job[] = [];
    for (const j of this.queue) {
      if (match(j)) j.reject(new Error('superseded'));
      else keep.push(j);
    }
    this.queue = keep;
  }

  /** Forget cached flows and queued work (the running job finishes but is ignored). */
  clear(): void {
    this.dropQueued(() => true);
    this.cache.clear();
    this.emit();
  }
}
