# Sandglass

Sandglass is a browser app that renders 100k–400k grains of sand on a backlit glass lightbox and morphs them from one image to the next (logo → face → text → …), like a live sand-animation performance. It is built for recording short videos for X/Twitter, so the look is modelled on real backlit sand rather than glowing particles.

- **Grains flow, not teleport.** Each grain's destination in the next image is picked with sliced optimal transport, so sand travels short, coherent paths.
- **Sand, not dots.** Grains are splatted into a float density buffer. The lightbox then shines through it: `light × exp(−absorption × density)`. Thin sand glows amber, and piles go deep brown to black.
- **Hands-on.** Drag on the glass to push sand with a "finger". Pushed sand piles up at the edges and slides back after a delay.
- **Ready to post.** Presets for 16:9, 9:16 and 1:1 at 1080p, one-click "record full sequence", and a clean mode for OBS.

Built with Vite, vanilla TypeScript and Three.js. Grain positions and velocities live in float textures (`GPUComputationRenderer`). The per-image target computation runs in a Web Worker, so the UI never freezes.

## Setup

```bash
npm install
npm run dev        # http://localhost:5173
```

```bash
npm run build      # type-check + production build into dist/ (static files, host anywhere)
npm run preview    # serve the production build
npm test           # unit tests for the sampler, sorter and matcher
```

**Requirements:** a browser with WebGL2 and `EXT_color_buffer_float`, which covers current Chrome, Edge, Safari and Firefox on desktop. Use Chrome or Edge for recording, because they can write H.264 MP4 directly.

URL parameters, handy for bookmarks and OBS: `?grains=150000`, `?aspect=9:16` (`16:9`, `9:16`, `1:1` or `window`), and `?clean=1`.

## Controls

| Input | Action |
| --- | --- |
| Drag on the glass | Push sand with a finger. It returns after release, with a delay. |
| Click on the glass | Sets the origin for the "Radial from last click" sweep |
| `Space` | Play / pause (pause holds the current image) |
| `←` / `→` | Previous / next scene |
| `S` | Webcam snapshot, inserted as the next scene (starts the webcam if needed) |
| `R` | Start / stop recording |
| `C` | Clean mode: no UI, no cursor, for OBS window capture (`Esc` exits) |
| `F` | Fullscreen |
| `H` | Hide / show all controls |
| Drop image files anywhere | Add them as scenes |

**Scene strip** (bottom): click a scene to edit it, double-click to morph to it now, drag to reorder, `×` to remove, and `+` to upload. The playing scene has an orange ring. Each thumbnail previews where the sand will go.

**Panel** (right, lil-gui):

- **Playback:** play/pause, loop, previous/next, "Pour sand & restart", current state, and an FPS meter.
- **Selected scene:** name, hold time, transition time, and sweep direction (left→right, center outward, radial from your last click, and more). Tone controls decide where sand goes: size in frame, threshold, contrast, gamma, sharpen, auto levels, invert (light = sand), and dust layer. Changing a tone control on the scene currently shown re-flows the sand into the new shape.
- **Add scenes:** upload images, add text in a bold font (use `\n` for a new line), and the webcam.
- **Sand:** grain count (50k / 150k / 250k / 400k), matching method (sliced optimal transport or the Hilbert-curve fallback, so you can compare), OT iterations, absorption, grain size and opacity, turbulence, stream bend, sweep width, settle wobble, and idle shimmer.
- **Lightbox:** light color (default `#ffd59a`), sand top color and top light (which keep piles brown rather than flat black), exposure, vignette, glass texture, edge softening, bloom and film grain (each toggleable).
- **Finger:** radius and return delay.
- **Record:** frame preset, preview resolution, format, bitrate, frame rate, whether sequences start from poured sand, record, record full sequence, and clean mode.

## Recording for X/Twitter

1. Pick a frame under **Record → Frame**: `16:9 · 1920×1080`, `9:16 · 1080×1920` (Reels/Shorts style) or `1:1 · 1080×1080`. The canvas always renders at exactly that size while recording, and the UI hides itself.
2. Either press `R` to start and stop by hand, or click **Record full sequence**. That computes every flow up front, starts from poured sand (or from the first image, if you untick the option), plays each scene once, and stops and downloads the file after the last hold.
3. In Chrome/Edge the file is **MP4 (H.264)**, which X accepts as-is. Browsers that can't encode H.264 (Firefox, open-source Chromium) produce **WebM**. Convert WebM before uploading:

   ```bash
   ffmpeg -i sandglass.webm -c:v libx264 -pix_fmt yuv420p -crf 18 -preset slow -movflags +faststart sandglass.mp4
   ```

X accepts up to 1920×1200 (or 1200×1900) at 60 fps and up to 2:20 in length, so keep sequences under that. Film grain costs bitrate, so if X's re-encode looks mushy, raise the bitrate or lower the film grain amount.

**OBS instead of the built-in recorder:** open the app with `?clean=1` (or press `C`), set the frame to "Fit window" if you want to fill the window, and capture the browser window. Clean mode hides every overlay and the cursor.

## Choosing images that morph well

- **High contrast and simple silhouettes win.** Logos, bold shapes, profiles, hands and text read instantly. Busy photos turn into mush.
- **Keep the amount of dark area similar between consecutive images.** The grain count is fixed, so an image with little dark area gets thick, black piles, and one with lots of dark area gets a thin, pale layer. That mirrors real sand, and matched neighbours also produce the calmest flows. Use **Size in frame** and **Dust layer** to balance scenes.
- **Plain, light backgrounds.** Anything dark in the background takes sand away from your subject. Use **Threshold** to drop light-grey clutter.
- **Faces:** shoot or crop tight, light the face from the front against a light wall, then use **Auto levels**, some **Sharpen** (0.5–1.2) and **Contrast** 1.2–1.5. Webcam snapshots start with these settings. At 150k grains a face reads clearly; 250k–400k adds finer shading.
- **Transparent PNGs** work well: transparent pixels are empty glass. **Invert** turns an image into its negative, so sand covers the glass and the artwork is cleared out, like drawing by wiping sand away.
- **Match the sweep to the content.** Use left→right for text, center outward for a centred logo, and radial from a click point to "draw" from a spot you choose. Transitions of 3–5 s with 1.5–3 s holds read well on a phone.

## How it works

1. **Image → targets** (`sampler.ts`): the image is fitted into the frame and converted to luminance, and darkness becomes a sand weight (with levels, sharpening, contrast, threshold and gamma). Exactly N points are importance-sampled by walking a Hilbert curve through the pixels with systematic sampling. Every pixel gets its expected share of grains and the curve spreads them evenly without raster stripes. Each point is jittered inside its pixel.
2. **Matching** (`matcher.ts`, Web Worker): sliced optimal transport. For K iterations, both point sets are projected onto a pair of orthogonal directions, sorted with a radix sort, and each source point is nudged toward its rank-matched target. Each grain then claims the nearest free target (grid search, with a Hilbert-rank fallback for the last few). The Hilbert-curve rank matching is also available on its own as the fast method. At 250k grains, sliced OT takes about 1–1.5 s and runs during the previous transition and hold. A queue lets flows you are waiting on jump ahead of speculative prefetches.
3. **Motion** (`sim.ts`, GPU): each grain follows start → target with a sweep-based delay (and a ragged front), easeInOutCubic, per-grain speed variation, a slight coherent bend, curl-noise turbulence that peaks mid-flight and is zero at both ends, a decaying settle wobble on landing, and sub-pixel idle shimmer. The finger is a capsule between the last two pointer positions; grains inside are projected to its edge, get a little spray, and are held by friction until a staggered spring pulls them back.
4. **Rendering** (`render.ts`): grains are analytic sub-pixel splats (size and opacity vary per grain) added into a half-float density target. A full-screen pass computes per-channel Beer–Lambert transmission (blue is absorbed most, so thin sand turns amber), plus a radial vignette, faint glass/diffuser texture, and a warm softening inside dense edges. EffectComposer then adds a tight bloom on the brightest glass and animated film grain.

```
src/
  main.ts       app wiring, frame loop, finger input, recording flow
  sampler.ts    image -> N weighted target points
  matcher.ts    worker: sampling + sliced optimal transport / Hilbert matching
  flow.ts       worker client: job queue, priorities, cache of computed flows
  sim.ts        GPUComputationRenderer simulation (positions + velocities)
  render.ts     density splats, lightbox shading, bloom, film grain
  timeline.ts   scene sequencing, prefetching, full-sequence playback
  sources.ts    scenes: images, text, webcam, built-in drawings, thumbnails
  ui.ts         lil-gui panel, scene strip, keyboard, drag and drop
  recorder.ts   captureStream + MediaRecorder
  hilbert.ts, sort.ts, glsl.ts, util.ts, types.ts
```

## Performance notes

- The frame loop allocates nothing. It runs two simulation passes over the grain textures, one point pass into the density buffer, and a few full-screen passes.
- The target is 60 fps at 250k grains on an M1 MacBook Air or a mid-range laptop. The FPS meter in **Playback** shows what you're getting. If a machine struggles, lower **Preview resolution** (recording still renders at full size) or use 150k grains.
- Matching never runs on the main thread. While the worker is busy, a small "computing flow…" pill shows progress. If a flow isn't ready when a hold ends, the hold simply extends.
