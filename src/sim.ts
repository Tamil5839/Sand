// GPU sand simulation. Two float textures (via GPUComputationRenderer):
//
//   position: xy = where the grain is drawn, z = flight progress, w = flight envelope
//   velocity: xy = velocity of the finger displacement, zw = displacement
//
// Grain motion during a transition is kinematic (start -> target with sweep
// delay, easing, curl turbulence and settle), which keeps landing exact. The
// finger displacement on top is simulated: pushed grains pile up at the edge
// of the finger and glide back after release.

import {
  ClampToEdgeWrapping,
  DataTexture,
  NearestFilter,
  Vector2,
  type ShaderMaterial,
  type Texture,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';
import { GPUComputationRenderer } from 'three/addons/misc/GPUComputationRenderer.js';
import { HASH_GLSL, SIMPLEX_GLSL } from './glsl';
import { SWEEP_MODES, type SweepMode } from './types';
import { textureSideFor } from './util';

export interface MotionParams {
  /** Curl-noise swirl strength mid-flight. */
  turbulence: number;
  /** Sideways arc of every stream, as a fraction of its travel. */
  bend: number;
  /** Wobble amplitude when grains land. */
  settle: number;
  /** Sub-pixel idle motion. */
  shimmer: number;
  /** Fraction of the transition taken by the sweep front (stagger). */
  spread: number;
  /** Finger radius in world units (frame height = 2). */
  fingerRadius: number;
  /** Seconds after release before pushed sand starts to return. */
  returnDelay: number;
}

export const DEFAULT_MOTION: MotionParams = {
  turbulence: 0.8,
  bend: 0.12,
  settle: 1.0,
  shimmer: 1.0,
  spread: 0.4,
  fingerRadius: 0.055,
  returnDelay: 1.2,
};

const POSITION_SHADER = /* glsl */ `
uniform sampler2D textureVelocity;
uniform sampler2D tFrom;
uniform sampler2D tTo;
uniform float uT;
uniform float uDuration;
uniform float uSpread;
uniform float uJitter;
uniform int uSweep;
uniform vec2 uSweepOrigin;
uniform float uAspect;
uniform float uTurb;
uniform float uBend;
uniform float uSettle;
uniform float uShimmer;
uniform float uTime;
uniform float uFlowSeed;

${HASH_GLSL}
${SIMPLEX_GLSL}

const float PI = 3.14159265;

float easeInOutCubic(float x) {
  return x < 0.5 ? 4.0 * x * x * x : 1.0 - pow(-2.0 * x + 2.0, 3.0) * 0.5;
}

// 0..1 along the sweep: when this grain starts moving.
float sweepCoord(vec2 p, float rnd) {
  vec2 q = vec2(p.x / uAspect, p.y);
  float diag = length(vec2(uAspect, 1.0));
  float c;
  if (uSweep == 0) c = q.x * 0.5 + 0.5;
  else if (uSweep == 1) c = 0.5 - q.x * 0.5;
  else if (uSweep == 2) c = 0.5 - q.y * 0.5;
  else if (uSweep == 3) c = q.y * 0.5 + 0.5;
  else if (uSweep == 4) c = length(p) / diag;
  else if (uSweep == 5) c = 1.0 - length(p) / diag;
  else if (uSweep == 6) {
    vec2 o = uSweepOrigin;
    float far = max(
      max(length(o - vec2(-uAspect, -1.0)), length(o - vec2(uAspect, -1.0))),
      max(length(o - vec2(-uAspect, 1.0)), length(o - vec2(uAspect, 1.0))));
    c = length(p - o) / far;
  }
  else if (uSweep == 7) c = (q.x - q.y) * 0.25 + 0.5;
  else return rnd;
  // A ragged front, like the edge of a hand rather than a ruler.
  c += 0.05 * snoise(vec3(p * 2.2, uFlowSeed));
  return clamp(c, 0.0, 1.0);
}

void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;
  vec4 rnd = grainRandom(ivec2(gl_FragCoord.xy));
  vec2 from = texture2D(tFrom, uv).xy;
  vec2 to = texture2D(tTo, uv).xy;
  vec2 off = texture2D(textureVelocity, uv).zw;

  float delay = sweepCoord(mix(from, to, 0.3), rnd.w) * uSpread + rnd.x * uJitter;
  float travel = max(1e-3, (1.0 - uSpread - uJitter) * mix(0.72, 1.0, rnd.y));
  float s = clamp((uT / uDuration - delay) / travel, 0.0, 1.0);
  vec2 d = to - from;
  float dist = length(d);
  vec2 p = mix(from, to, easeInOutCubic(s));

  float env = sin(PI * s);
  if (env > 0.0) {
    // Streams arc slightly to one side, like sand swept by a palm.
    p += vec2(-d.y, d.x) * (uBend * env * (0.75 + 0.5 * rnd.z));
    // Curl-noise turbulence: strongest mid-flight, zero at start and end.
    float amp = uTurb * env * env * (0.01 + 0.075 * min(dist, 2.5));
    float tt = uFlowSeed + uT * 0.22;
    vec2 c = curlNoise(p * 1.6 + uFlowSeed, tt) + 0.5 * curlNoise(p * 4.3 - uFlowSeed, tt * 1.7);
    p += c * amp;
  }

  // Grains tumble into place: a decaying wobble right after landing.
  float ta = uT - (delay + travel) * uDuration;
  if (ta > 0.0 && ta < 2.0) {
    float a = uSettle * exp(-ta * 5.5) * sin(ta * (22.0 + 14.0 * rnd.z)) * (0.25 + min(dist * 2.0, 1.0));
    float ang = rnd.w * 6.2831853;
    p += vec2(cos(ang), sin(ang)) * a * 0.004;
  }

  // Idle shimmer, well below a pixel: resting sand glints instead of freezing.
  p += uShimmer * 0.0006 * vec2(
    sin(uTime * (0.6 + rnd.x) + rnd.z * 6.2831853),
    sin(uTime * (0.5 + rnd.y) + rnd.w * 6.2831853));

  gl_FragColor = vec4(p + off, s, env);
}
`;

const VELOCITY_SHADER = /* glsl */ `
uniform sampler2D texturePosition;
uniform sampler2D textureVelocity;
uniform vec2 uFingerA;
uniform vec2 uFingerB;
uniform float uFingerR;
uniform float uFingerOn;
uniform float uFingerSpeed;
uniform float uReleaseAge;
uniform float uReturnDelay;
uniform float uDt;

${HASH_GLSL}

void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;
  vec4 rnd = grainRandom(ivec2(gl_FragCoord.xy) + ivec2(31, 17));
  vec4 v = texture2D(textureVelocity, uv);
  vec2 vel = v.xy;
  vec2 off = v.zw;
  vec2 p = texture2D(texturePosition, uv).xy;

  if (uFingerOn > 0.5) {
    // The finger is a capsule from last frame's position to this frame's,
    // so fast strokes leave a continuous cleared line.
    vec2 ab = uFingerB - uFingerA;
    float h = clamp(dot(p - uFingerA, ab) / max(dot(ab, ab), 1e-10), 0.0, 1.0);
    vec2 q = uFingerA + ab * h;
    vec2 dv = p - q;
    float dist = length(dv);
    float R = uFingerR * (0.88 + 0.24 * rnd.x);
    if (dist < R) {
      vec2 n = dist > 1e-6 ? dv / dist : vec2(cos(rnd.y * 6.2831853), sin(rnd.y * 6.2831853));
      off += n * (R - dist);
      vel = n * uFingerSpeed * (0.1 + 0.3 * rnd.z);
    }
  }

  // Staggered return after release.
  float back = uFingerOn > 0.5 ? 0.0 : smoothstep(0.0, 0.6, uReleaseAge - uReturnDelay - rnd.w * 0.9);
  // Sand on glass is all friction: pushed grains stop almost at once.
  vel *= exp(-9.0 * uDt * (1.0 - back));
  if (back > 0.0) {
    float k = 22.0 * back;
    vel += (-k * off - 2.0 * sqrt(k) * vel) * uDt;
  }
  off += vel * uDt;
  if (back >= 1.0 && dot(off, off) < 1e-11) {
    off = vec2(0.0);
    vel = vec2(0.0);
  }
  gl_FragColor = vec4(vel, off);
}
`;

export interface TransitionOptions {
  duration: number;
  sweep: SweepMode;
  origin: { x: number; y: number };
  seed: number;
}

export class SandSim {
  readonly side: number;
  readonly count: number;

  /** Seconds since the current transition started. */
  transitionTime = 1e6;
  duration = 1;
  /** Shared with the app so tweaks survive re-creating the sim. */
  motion: MotionParams = { ...DEFAULT_MOTION };

  /** Finger state, written by the UI each frame (world units). */
  readonly finger = { on: false, ax: 0, ay: 0, bx: 0, by: 0, speed: 0, releaseAge: 1e6 };

  private readonly gpu: GPUComputationRenderer;
  private readonly posRT: WebGLRenderTarget[];
  private readonly velRT: WebGLRenderTarget[];
  private readonly fromRT: WebGLRenderTarget;
  private readonly toTex: DataTexture;
  private readonly zeroTex: DataTexture;
  private readonly posMat: ShaderMaterial;
  private readonly velMat: ShaderMaterial;
  private cur = 0;

  constructor(renderer: WebGLRenderer, requestedCount: number, aspect: number) {
    this.side = textureSideFor(requestedCount);
    this.count = this.side * this.side;
    this.gpu = new GPUComputationRenderer(this.side, this.side, renderer);
    const gpu = this.gpu;

    const rt = () =>
      gpu.createRenderTarget(
        this.side,
        this.side,
        ClampToEdgeWrapping,
        ClampToEdgeWrapping,
        NearestFilter,
        NearestFilter,
      );
    this.posRT = [rt(), rt()];
    this.velRT = [rt(), rt()];
    this.fromRT = rt();
    this.toTex = gpu.createTexture();
    this.zeroTex = gpu.createTexture();

    this.posMat = gpu.createShaderMaterial(POSITION_SHADER, {
      textureVelocity: { value: null },
      tFrom: { value: this.fromRT.texture },
      tTo: { value: this.toTex },
      uT: { value: this.transitionTime },
      uDuration: { value: 1 },
      uSpread: { value: 0.4 },
      uJitter: { value: 0.1 },
      uSweep: { value: 0 },
      uSweepOrigin: { value: new Vector2() },
      uAspect: { value: aspect },
      uTurb: { value: 1 },
      uBend: { value: 0.1 },
      uSettle: { value: 1 },
      uShimmer: { value: 1 },
      uTime: { value: 0 },
      uFlowSeed: { value: 0 },
    });
    this.velMat = gpu.createShaderMaterial(VELOCITY_SHADER, {
      texturePosition: { value: null },
      textureVelocity: { value: null },
      uFingerA: { value: new Vector2() },
      uFingerB: { value: new Vector2() },
      uFingerR: { value: 0.05 },
      uFingerOn: { value: 0 },
      uFingerSpeed: { value: 0 },
      uReleaseAge: { value: 1e6 },
      uReturnDelay: { value: 1 },
      uDt: { value: 1 / 60 },
    });
  }

  setAspect(aspect: number): void {
    this.posMat.uniforms.uAspect.value = aspect;
  }

  /** Texture holding the current grain positions (xy). */
  get positions(): Texture {
    return this.posRT[this.cur].texture;
  }

  private uploadTargets(xy: Float32Array): void {
    const data = this.toTex.image.data as Float32Array;
    const n = this.count;
    for (let i = 0; i < n; i++) {
      data[4 * i] = xy[2 * i];
      data[4 * i + 1] = xy[2 * i + 1];
    }
    this.toTex.needsUpdate = true;
  }

  /** Puts every grain at rest at `xy` (length 2 * count). */
  reset(xy: Float32Array): void {
    this.uploadTargets(xy);
    this.gpu.renderTexture(this.toTex, this.fromRT);
    this.gpu.renderTexture(this.toTex, this.posRT[0]);
    this.gpu.renderTexture(this.toTex, this.posRT[1]);
    this.gpu.renderTexture(this.zeroTex, this.velRT[0]);
    this.gpu.renderTexture(this.zeroTex, this.velRT[1]);
    this.transitionTime = 1e6;
  }

  /**
   * Starts moving every grain from where it is now (including any finger
   * displacement or mid-flight swirl) to `targets`.
   */
  beginTransition(targets: Float32Array, opts: TransitionOptions): void {
    this.gpu.renderTexture(this.posRT[this.cur].texture, this.fromRT);
    this.gpu.renderTexture(this.zeroTex, this.velRT[this.cur]);
    this.uploadTargets(targets);
    this.transitionTime = 0;
    this.duration = Math.max(0.05, opts.duration);
    const u = this.posMat.uniforms;
    u.uSweep.value = Math.max(0, SWEEP_MODES.indexOf(opts.sweep));
    u.uSweepOrigin.value.x = opts.origin.x;
    u.uSweepOrigin.value.y = opts.origin.y;
    u.uFlowSeed.value = (opts.seed % 997) * 0.731;
  }

  get inFlight(): boolean {
    return this.transitionTime < this.duration;
  }

  step(dt: number, time: number): void {
    this.transitionTime += dt;
    const m = this.motion;
    const f = this.finger;

    const vu = this.velMat.uniforms;
    vu.uFingerA.value.x = f.ax;
    vu.uFingerA.value.y = f.ay;
    vu.uFingerB.value.x = f.bx;
    vu.uFingerB.value.y = f.by;
    vu.uFingerR.value = m.fingerRadius;
    vu.uFingerOn.value = f.on ? 1 : 0;
    vu.uFingerSpeed.value = f.speed;
    vu.uReleaseAge.value = f.releaseAge;
    vu.uReturnDelay.value = m.returnDelay;
    vu.uDt.value = dt;

    const pu = this.posMat.uniforms;
    pu.uT.value = this.transitionTime;
    pu.uDuration.value = this.duration;
    pu.uSpread.value = Math.min(0.7, Math.max(0, m.spread));
    pu.uJitter.value = 0.1;
    pu.uTurb.value = m.turbulence;
    pu.uBend.value = m.bend;
    pu.uSettle.value = m.settle;
    pu.uShimmer.value = m.shimmer;
    pu.uTime.value = time;

    // Velocity first (reads last frame's positions), then positions read the
    // fresh displacement, so a push shows up on the same frame.
    const next = 1 - this.cur;
    vu.texturePosition.value = this.posRT[this.cur].texture;
    vu.textureVelocity.value = this.velRT[this.cur].texture;
    this.gpu.doRenderTarget(this.velMat, this.velRT[next]);
    pu.textureVelocity.value = this.velRT[next].texture;
    this.gpu.doRenderTarget(this.posMat, this.posRT[next]);
    this.cur = next;
  }

  dispose(): void {
    for (const rt of [...this.posRT, ...this.velRT, this.fromRT]) rt.dispose();
    this.toTex.dispose();
    this.zeroTex.dispose();
    this.posMat.dispose();
    this.velMat.dispose();
    this.gpu.dispose();
  }
}
