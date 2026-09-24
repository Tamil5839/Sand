// LSD radix sorts on 32-bit keys (11/11/10-bit passes). The matcher sorts
// hundreds of thousands of projections per iteration, so comparison sorts are
// far too slow; these run in a few ms for 400k items and reuse their buffers.

export class RadixSorter {
  private keysA = new Uint32Array(0);
  private keysB = new Uint32Array(0);
  private idxA = new Uint32Array(0);
  private idxB = new Uint32Array(0);
  private readonly counts = new Uint32Array(2048 * 3);

  private ensure(n: number): void {
    if (this.keysA.length >= n) return;
    this.keysA = new Uint32Array(n);
    this.keysB = new Uint32Array(n);
    this.idxA = new Uint32Array(n);
    this.idxB = new Uint32Array(n);
  }

  /** Converts float bits so that unsigned order matches numeric order. */
  private loadFloatKeys(values: Float32Array, n: number): void {
    const bits = new Uint32Array(values.buffer, values.byteOffset, n);
    const keys = this.keysA;
    for (let i = 0; i < n; i++) {
      const u = bits[i];
      keys[i] = u & 0x80000000 ? ~u : u | 0x80000000;
    }
  }

  private histogram(n: number): void {
    const c = this.counts;
    const keys = this.keysA;
    c.fill(0);
    for (let i = 0; i < n; i++) {
      const k = keys[i];
      c[k & 2047]++;
      c[2048 + ((k >>> 11) & 2047)]++;
      c[4096 + (k >>> 22)]++;
    }
    for (let p = 0; p < 3; p++) {
      const base = p * 2048;
      let sum = 0;
      for (let b = 0; b < 2048; b++) {
        const t = c[base + b];
        c[base + b] = sum;
        sum += t;
      }
    }
  }

  /** Indices sorting keysA ascending. Returned array is internal; use it before the next call. */
  private argsortLoaded(n: number): Uint32Array {
    this.histogram(n);
    const c = this.counts;
    const kA = this.keysA;
    const kB = this.keysB;
    const iA = this.idxA;
    const iB = this.idxB;
    for (let i = 0; i < n; i++) {
      const k = kA[i];
      const p = c[k & 2047]++;
      kB[p] = k;
      iB[p] = i;
    }
    for (let i = 0; i < n; i++) {
      const k = kB[i];
      const p = c[2048 + ((k >>> 11) & 2047)]++;
      kA[p] = k;
      iA[p] = iB[i];
    }
    for (let i = 0; i < n; i++) {
      const k = kA[i];
      const p = c[4096 + (k >>> 22)]++;
      kB[p] = k;
      iB[p] = iA[i];
    }
    return iB.subarray(0, n);
  }

  /** Indices that sort `values[0..n)` ascending. The result is reused by the next call. */
  argsort(values: Float32Array, n: number): Uint32Array {
    this.ensure(n);
    this.loadFloatKeys(values, n);
    return this.argsortLoaded(n);
  }

  /** Indices that sort unsigned integer keys ascending. The result is reused by the next call. */
  argsortU32(keys: ArrayLike<number>, n: number): Uint32Array {
    this.ensure(n);
    const k = this.keysA;
    for (let i = 0; i < n; i++) k[i] = keys[i];
    return this.argsortLoaded(n);
  }

  /** Writes `values[0..n)` sorted ascending into `out`. */
  sortFloats(values: Float32Array, n: number, out: Float32Array): void {
    this.ensure(n);
    this.loadFloatKeys(values, n);
    this.histogram(n);
    const c = this.counts;
    const kA = this.keysA;
    const kB = this.keysB;
    for (let i = 0; i < n; i++) {
      const k = kA[i];
      kB[c[k & 2047]++] = k;
    }
    for (let i = 0; i < n; i++) {
      const k = kB[i];
      kA[c[2048 + ((k >>> 11) & 2047)]++] = k;
    }
    for (let i = 0; i < n; i++) {
      const k = kA[i];
      kB[c[4096 + (k >>> 22)]++] = k;
    }
    const outBits = new Uint32Array(out.buffer, out.byteOffset, n);
    for (let i = 0; i < n; i++) {
      const k = kB[i];
      outBits[i] = k & 0x80000000 ? k ^ 0x80000000 : ~k;
    }
  }
}
