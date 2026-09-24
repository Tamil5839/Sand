// Backlit sand rendering.
//
// Grains are never drawn as coloured dots. Each grain adds a tiny soft splat
// of "optical depth" into a float density buffer; a full-screen pass then
// shines the lightbox through it: transmitted = light * exp(-absorption * density).
// Thin sand glows amber, piles go deep brown to black, like the real thing.

import {
  Sphere,
  Vector3,
  BufferAttribute,
  BufferGeometry,
  Color,
  CustomBlending,
  HalfFloatType,
  LinearFilter,
  NoToneMapping,
  OneFactor,
  OrthographicCamera,
  Points,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  SRGBColorSpace,
  type Texture,
  Vector2,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { HASH_GLSL } from './glsl';

export interface LookParams {
  /** Optical depth per unit of grain coverage. */
  absorption: number;
  lightColor: string;
  /** Colour of room light bouncing off thick sand (keeps piles brown, not flat black). */
  sandColor: string;
  topLight: number;
  exposure: number;
  vignette: number;
  glass: number;
  /** Warm fringe inside dense edges. */
  chroma: number;
  /** Grain radius in pixels at 1080p. */
  grainSize: number;
  grainOpacity: number;
  bloom: boolean;
  bloomStrength: number;
  filmGrain: boolean;
  grainAmount: number;
}

export const DEFAULT_LOOK: LookParams = {
  absorption: 6,
  lightColor: '#ffd59a',
  sandColor: '#3a2412',
  topLight: 0.5,
  exposure: 1.0,
  vignette: 0.42,
  glass: 1.0,
  chroma: 0.6,
  grainSize: 1.25,
  grainOpacity: 0.42,
  bloom: true,
  bloomStrength: 0.15,
  filmGrain: true,
  grainAmount: 0.035,
};

const DENSITY_VERT = /* glsl */ `
uniform sampler2D tPos;
uniform int uSide;
uniform vec2 uRes;
uniform float uSize;
uniform float uOpacity;
varying vec2 vCenter;
varying float vR;
varying float vA;

${HASH_GLSL}

void main() {
  ivec2 tc = ivec2(gl_VertexID % uSide, gl_VertexID / uSide);
  vec4 p = texelFetch(tPos, tc, 0);
  vec4 rnd = grainRandom(tc + ivec2(7919, 1031));
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(p.xy, 0.0, 1.0);
  gl_Position = clip;
  vCenter = (clip.xy / clip.w * 0.5 + 0.5) * uRes;
  // Mostly fine grains, a few coarse ones.
  float r = uSize * (0.6 + 0.95 * rnd.x * rnd.x);
  // Keep tiny grains at least ~1.5px wide so they never fall between pixel
  // centres, and conserve their mass by lowering opacity instead.
  float R = max(r, 0.75);
  vR = R;
  vA = uOpacity * (0.45 + 0.55 * rnd.y) * (r * r) / (R * R);
  gl_PointSize = 2.0 * ceil(R) + 1.0;
}
`;

const DENSITY_FRAG = /* glsl */ `
varying vec2 vCenter;
varying float vR;
varying float vA;
void main() {
  // Analytic splat around the exact sub-pixel centre: grains glide smoothly
  // instead of snapping from pixel to pixel.
  float d = length(gl_FragCoord.xy - vCenter) / vR;
  if (d >= 1.0) discard;
  float k = 1.0 - d * d;
  // (1 - d^2)^2 integrates to pi R^2 / 3, so the factor 3 gives unit coverage.
  gl_FragColor = vec4(3.0 * vA * k * k, 0.0, 0.0, 1.0);
}
`;

const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SHADE_FRAG = /* glsl */ `
uniform sampler2D tDensity;
uniform vec2 uRes;
uniform float uAspect;
uniform vec3 uLight;
uniform vec3 uSand;
uniform float uAbsorb;
uniform float uTopLight;
uniform float uExposure;
uniform float uVignette;
uniform float uGlass;
uniform float uChroma;
varying vec2 vUv;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main() {
  vec2 px = 1.0 / uRes;
  float d = texture2D(tDensity, vUv).r;
  float db = 0.25 * (
    texture2D(tDensity, vUv + px * vec2(1.5, 0.5)).r +
    texture2D(tDensity, vUv + px * vec2(-0.5, 1.5)).r +
    texture2D(tDensity, vUv + px * vec2(-1.5, -0.5)).r +
    texture2D(tDensity, vUv + px * vec2(0.5, -1.5)).r);
  // Light bleeds a little into the edges of dense sand, and red bleeds most.
  float soft = min(d, db);
  vec3 D = vec3(mix(d, soft, uChroma), mix(d, soft, uChroma * 0.45), d);

  // Sand absorbs blue more than red: thin layers glow amber, piles go brown-black.
  vec3 T = exp(-uAbsorb * vec3(0.74, 1.0, 1.5) * D);

  // Lightbox: brighter in the middle, faint diffuser/glass texture.
  vec2 q = (vUv - 0.5) * vec2(uAspect, 1.0);
  float r2 = dot(q, q) / (0.25 * (uAspect * uAspect + 1.0));
  float vig = 1.0 - uVignette * pow(r2, 1.15);
  vec2 g = q * 2.0;
  float glass = 0.05 * (vnoise(g * 2.5 + 7.0) - 0.5)
              + 0.03 * (vnoise(g * 11.0) - 0.5)
              + 0.018 * (vnoise(vec2(g.x * 1.5 + g.y * 0.4, g.y * 90.0 - g.x * 25.0)) - 0.5)
              + 0.014 * (hash12(floor(g * 540.0)) - 0.5);
  vec3 light = uLight * uExposure * vig * (1.0 + uGlass * glass);

  vec3 col = light * T;
  // Room light scattered off the top of the sand.
  col += uSand * uTopLight * (1.0 - exp(-2.0 * d)) * (0.6 + 0.4 * vig);
  gl_FragColor = vec4(col, 1.0);
}
`;

const GRAIN_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform float uFrame;
uniform float uAmount;
varying vec2 vUv;

float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  vec3 s = vec3(gl_FragCoord.xy, uFrame);
  float n = hash13(s) + hash13(s + vec3(17.1, 5.3, 3.7)) - 1.0;
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  c += n * uAmount * (0.35 + 2.6 * l * (1.0 - l));
  gl_FragColor = vec4(c, 1.0);
}
`;

export class LightboxRenderer {
  readonly renderer: WebGLRenderer;
  readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  readonly look: LookParams = { ...DEFAULT_LOOK };

  private readonly pointScene = new Scene();
  private readonly densityRT: WebGLRenderTarget;
  private readonly densityMat: ShaderMaterial;
  private readonly shadeMat: ShaderMaterial;
  private readonly composer: EffectComposer;
  private readonly bloomPass: UnrealBloomPass;
  private readonly grainPass: ShaderPass;
  private points: Points | null = null;
  private width = 1;
  private height = 1;
  private frame = 0;
  private lightHex = '';
  private sandHex = '';

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    const r = this.renderer;
    r.setPixelRatio(1);
    r.outputColorSpace = SRGBColorSpace;
    r.toneMapping = NoToneMapping;
    r.setClearColor(0x000000, 0);

    this.camera.position.set(0, 0, 5);
    this.camera.lookAt(0, 0, 0);

    this.densityRT = new WebGLRenderTarget(1, 1, {
      type: HalfFloatType,
      format: RGBAFormat,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: false,
    });

    this.densityMat = new ShaderMaterial({
      name: 'SandDensity',
      uniforms: {
        tPos: { value: null },
        uSide: { value: 1 },
        uRes: { value: new Vector2(1, 1) },
        uSize: { value: 1 },
        uOpacity: { value: 1 },
      },
      vertexShader: DENSITY_VERT,
      fragmentShader: DENSITY_FRAG,
      blending: CustomBlending,
      blendSrc: OneFactor,
      blendDst: OneFactor,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });

    this.shadeMat = new ShaderMaterial({
      name: 'Lightbox',
      uniforms: {
        tDensity: { value: this.densityRT.texture },
        uRes: { value: new Vector2(1, 1) },
        uAspect: { value: 1 },
        uLight: { value: new Color() },
        uSand: { value: new Color() },
        uAbsorb: { value: 1 },
        uTopLight: { value: 0 },
        uExposure: { value: 1 },
        uVignette: { value: 0 },
        uGlass: { value: 0 },
        uChroma: { value: 0 },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: SHADE_FRAG,
    });

    this.composer = new EffectComposer(r);
    this.composer.setPixelRatio(1);
    this.composer.addPass(new ShaderPass(this.shadeMat));
    // A tight glow that hugs the brightest glass instead of fogging the sand:
    // soft threshold, weights biased to the small mip levels.
    this.bloomPass = new UnrealBloomPass(new Vector2(256, 256), 0.15, 0, 0.5);
    (this.bloomPass.highPassUniforms as Record<string, { value: number }>).smoothWidth.value = 0.4;
    this.bloomPass.compositeMaterial.uniforms.bloomFactors.value = [0.6, 0.3, 0.1, 0.03, 0.0];
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());
    this.grainPass = new ShaderPass(
      new ShaderMaterial({
        name: 'FilmGrain',
        uniforms: { tDiffuse: { value: null }, uFrame: { value: 0 }, uAmount: { value: 0.03 } },
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: GRAIN_FRAG,
      }),
    );
    this.composer.addPass(this.grainPass);
  }

  /** Checks the float render target support we rely on. */
  static unsupportedReason(r: WebGLRenderer): string | null {
    if (!r.capabilities.isWebGL2) return 'WebGL2 is required.';
    if (!r.extensions.has('EXT_color_buffer_float')) return 'EXT_color_buffer_float is not supported.';
    if (r.capabilities.maxVertexTextures === 0) return 'Vertex texture fetch is not supported.';
    return null;
  }

  setGrainCount(side: number): void {
    if (this.points) {
      this.pointScene.remove(this.points);
      this.points.geometry.dispose();
    }
    const count = side * side;
    const geo = new BufferGeometry();
    // Only the vertex count matters; the shader reads positions by gl_VertexID.
    geo.setAttribute('position', new BufferAttribute(new Float32Array(count), 1));
    // Avoid three computing bounds from the placeholder attribute.
    geo.boundingSphere = new Sphere(new Vector3(), 1e3);
    this.points = new Points(geo, this.densityMat);
    this.points.frustumCulled = false;
    this.pointScene.add(this.points);
    this.densityMat.uniforms.uSide.value = side;
  }

  setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    const aspect = width / height;
    this.renderer.setSize(width, height, false);
    this.densityRT.setSize(width, height);
    this.composer.setSize(width, height);
    this.camera.left = -aspect;
    this.camera.right = aspect;
    this.camera.top = 1;
    this.camera.bottom = -1;
    this.camera.updateProjectionMatrix();
    this.densityMat.uniforms.uRes.value.set(width, height);
    this.shadeMat.uniforms.uRes.value.set(width, height);
    this.shadeMat.uniforms.uAspect.value = aspect;
  }

  render(positions: Texture, dt: number): void {
    const L = this.look;
    // Grain size is defined at 1080p; scale with pixel count so density (and
    // so the look) is the same at any output resolution.
    const pxScale = Math.sqrt((this.width * this.height) / (1920 * 1080));
    const dm = this.densityMat.uniforms;
    dm.tPos.value = positions;
    dm.uSize.value = L.grainSize * pxScale;
    dm.uOpacity.value = L.grainOpacity;

    const su = this.shadeMat.uniforms;
    if (L.lightColor !== this.lightHex) su.uLight.value.set((this.lightHex = L.lightColor));
    if (L.sandColor !== this.sandHex) su.uSand.value.set((this.sandHex = L.sandColor));
    su.uAbsorb.value = L.absorption;
    su.uTopLight.value = L.topLight;
    su.uExposure.value = L.exposure;
    su.uVignette.value = L.vignette;
    su.uGlass.value = L.glass;
    su.uChroma.value = L.chroma;

    this.bloomPass.enabled = L.bloom;
    this.bloomPass.strength = L.bloomStrength;
    this.grainPass.enabled = L.filmGrain;
    this.grainPass.uniforms.uAmount.value = L.grainAmount;
    this.grainPass.uniforms.uFrame.value = this.frame++ % 997;

    const r = this.renderer;
    r.setRenderTarget(this.densityRT);
    r.clear(true, false, false);
    r.render(this.pointScene, this.camera);
    r.setRenderTarget(null);
    this.composer.render(dt);
  }
}
