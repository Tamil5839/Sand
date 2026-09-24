// Controls: lil-gui panel, scene strip (drag to reorder), keyboard shortcuts,
// drag-and-drop images, status indicator and webcam preview. H hides it all.

import GUI from 'lil-gui';
import type { App, AspectPreset } from './main';
import type { FontChoice, Scene } from './sources';
import { SWEEP_MODES } from './types';

const SCENE_MIME = 'application/x-sandglass-scene';

const SWEEP_LABELS: Record<string, string> = {
  'left-right': 'Left → right',
  'right-left': 'Right → left',
  'top-bottom': 'Top → bottom',
  'bottom-top': 'Bottom → top',
  'center-out': 'Center outward',
  'edges-in': 'Edges inward',
  'click-radial': 'Radial from last click',
  diagonal: 'Diagonal',
  random: 'Everywhere at once',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function buildUI(app: App): void {
  const t = app.timeline;
  const gui = new GUI({ title: 'Sandglass  ·  H to hide' });
  gui.domElement.classList.add('ui');

  // --- Playback ------------------------------------------------------------
  const playback = gui.addFolder('Playback');
  const pb = {
    toggle: () => app.togglePlay(),
    prev: () => t.prev(),
    next: () => t.next(),
    restart: () => app.restart(),
    now: '',
  };
  const playBtn = playback.add(pb, 'toggle').name('Pause (Space)');
  playback.add(t, 'loop').name('Loop');
  playback.add(pb, 'prev').name('◀  Previous scene (←)');
  playback.add(pb, 'next').name('Next scene  ▶ (→)');
  playback.add(pb, 'restart').name('Pour sand & restart');
  const nowCtl = playback.add(pb, 'now').name('Now').disable();
  const perf = { fps: '' };
  const fpsCtl = playback.add(perf, 'fps').name('Performance').disable();
  window.setInterval(() => {
    const s = app.sim;
    perf.fps = `${app.fps.toFixed(0)} fps · ${Math.round(s.count / 1000)}k grains · ${app.canvas.width}×${app.canvas.height}`;
    fpsCtl.updateDisplay();
  }, 500);

  // --- Selected scene --------------------------------------------------------
  const sceneFolder = gui.addFolder('Selected scene');
  const sweepOptions: Record<string, string> = {};
  for (const m of SWEEP_MODES) sweepOptions[SWEEP_LABELS[m]] = m;

  const rebuildSceneFolder = () => {
    for (const c of [...sceneFolder.controllers]) c.destroy();
    const s = app.selected;
    sceneFolder.title(s ? `Selected scene: ${s.name}` : 'Selected scene');
    if (!s) return;
    const edited = (resample: boolean) => () => app.sceneEdited(s, resample);
    sceneFolder.add(s, 'name').name('Name').onFinishChange(edited(false));
    if (s.kind === 'text') {
      sceneFolder.add(s, 'text').name('Text (\\n = new line)').onFinishChange(edited(true));
      sceneFolder
        .add(s, 'font', { Sans: 'sans', Serif: 'serif', Mono: 'mono', Script: 'script' })
        .name('Font')
        .onChange(edited(true));
    }
    sceneFolder.add(s, 'hold', 0.2, 20, 0.1).name('Hold (s)');
    sceneFolder.add(s, 'transition', 0.5, 15, 0.1).name('Transition (s)');
    sceneFolder.add(s, 'sweep', sweepOptions).name('Sweep');
    sceneFolder.add(s, 'scale', 0.2, 1.5, 0.01).name('Size in frame').onChange(edited(true));
    sceneFolder.add(s, 'threshold', 0, 0.95, 0.01).name('Threshold').onChange(edited(true));
    sceneFolder.add(s, 'contrast', 0.2, 4, 0.01).name('Contrast').onChange(edited(true));
    sceneFolder.add(s, 'gamma', 0.2, 4, 0.01).name('Gamma').onChange(edited(true));
    sceneFolder.add(s, 'sharpen', 0, 3, 0.01).name('Sharpen').onChange(edited(true));
    sceneFolder.add(s, 'autoLevels').name('Auto levels').onChange(edited(true));
    sceneFolder.add(s, 'invert').name('Invert (light = sand)').onChange(edited(true));
    sceneFolder.add(s, 'dust', 0, 0.5, 0.01).name('Dust layer').onChange(edited(true));
    sceneFolder.add({ go: () => app.morphTo(s) }, 'go').name('Morph to this scene now');
    sceneFolder.add({ del: () => app.removeScene(s) }, 'del').name('Remove scene');
  };

  // --- Add -------------------------------------------------------------------
  const fileInput = el('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.multiple = true;
  fileInput.hidden = true;
  fileInput.addEventListener('change', () => {
    if (fileInput.files) void app.addFiles(fileInput.files);
    fileInput.value = '';
  });
  document.body.appendChild(fileInput);

  const addFolder = gui.addFolder('Add scenes');
  const add = {
    upload: () => fileInput.click(),
    text: 'SAND',
    font: 'sans' as FontChoice,
    addText: () => app.addText(add.text, add.font),
    webcam: () => void app.toggleWebcam(),
    snap: () => void app.snapshot(),
  };
  addFolder.add(add, 'upload').name('Upload images… (or drop files)');
  addFolder.add(add, 'text').name('Text (\\n = new line)');
  addFolder.add(add, 'font', { Sans: 'sans', Serif: 'serif', Mono: 'mono', Script: 'script' }).name('Font');
  addFolder.add(add, 'addText').name('Add text scene');
  const camBtn = addFolder.add(add, 'webcam').name('Start webcam');
  addFolder.add(add, 'snap').name('Webcam snapshot → next scene (S)');

  // --- Sand ------------------------------------------------------------------
  const sand = gui.addFolder('Sand');
  sand
    .add(app.settings, 'grains', { '50k': 50_000, '150k': 150_000, '250k': 250_000, '400k': 400_000 })
    .name('Grains')
    .onChange((v: number) => app.setGrains(v));
  sand
    .add(app.settings, 'method', { 'Sliced optimal transport': 'sot', 'Hilbert curve (fast)': 'hilbert' })
    .name('Matching')
    .onChange(() => app.flowSettingsChanged());
  sand.add(app.settings, 'iterations', 4, 100, 1).name('OT iterations').onFinishChange(() => app.flowSettingsChanged());
  sand.add(app.look, 'absorption', 0.3, 12, 0.05).name('Absorption');
  sand.add(app.look, 'grainSize', 0.3, 3, 0.01).name('Grain size (px)');
  sand.add(app.look, 'grainOpacity', 0.1, 1.5, 0.01).name('Grain opacity');
  sand.add(app.motion, 'turbulence', 0, 4, 0.01).name('Turbulence');
  sand.add(app.motion, 'bend', -0.4, 0.4, 0.01).name('Stream bend');
  sand.add(app.motion, 'spread', 0, 0.7, 0.01).name('Sweep width');
  sand.add(app.motion, 'settle', 0, 4, 0.01).name('Settle wobble');
  sand.add(app.motion, 'shimmer', 0, 5, 0.01).name('Idle shimmer');

  // --- Light -----------------------------------------------------------------
  const light = gui.addFolder('Lightbox');
  light.addColor(app.look, 'lightColor').name('Light color');
  light.addColor(app.look, 'sandColor').name('Sand top color');
  light.add(app.look, 'topLight', 0, 2, 0.01).name('Top light');
  light.add(app.look, 'exposure', 0.3, 2, 0.01).name('Exposure');
  light.add(app.look, 'vignette', 0, 1, 0.01).name('Vignette');
  light.add(app.look, 'glass', 0, 4, 0.01).name('Glass texture');
  light.add(app.look, 'chroma', 0, 1, 0.01).name('Edge softening');
  light.add(app.look, 'bloom').name('Bloom');
  light.add(app.look, 'bloomStrength', 0, 1.5, 0.01).name('Bloom strength');
  light.add(app.look, 'filmGrain').name('Film grain');
  light.add(app.look, 'grainAmount', 0, 0.15, 0.001).name('Film grain amount');

  // --- Finger ----------------------------------------------------------------
  const finger = gui.addFolder('Finger (drag on the glass)');
  finger.add(app.motion, 'fingerRadius', 0.01, 0.25, 0.001).name('Radius');
  finger.add(app.motion, 'returnDelay', 0, 8, 0.1).name('Return delay (s)');
  finger.close();

  // --- Record ----------------------------------------------------------------
  const rec = gui.addFolder('Record');
  const aspectCtl = rec
    .add(app.settings, 'aspect', { '16:9 · 1920×1080': '16:9', '9:16 · 1080×1920': '9:16', '1:1 · 1080×1080': '1:1', 'Fit window': 'window' })
    .name('Frame')
    .onChange((v: AspectPreset) => {
      app.setAspect(v);
      aspectCtl.updateDisplay();
    });
  rec
    .add(app.settings, 'previewScale', { Full: 1, '3/4': 0.75, Half: 0.5 })
    .name('Preview resolution')
    .onChange(() => app.applyResolution());
  rec
    .add(app.settings, 'format', { 'MP4 (H.264) if supported, else WebM': 'auto', 'MP4 (H.264) only': 'mp4', WebM: 'webm' })
    .name('Format');
  rec.add(app.settings, 'mbps', 4, 80, 1).name('Bitrate (Mbps)');
  rec.add(app.settings, 'fps', { '60 fps': 60, '30 fps': 30 }).name('Frame rate');
  rec.add(app.settings, 'intro').name('Sequence starts from poured sand');
  const recActions = {
    record: () => void app.toggleRecord(),
    sequence: () => void app.recordSequence(),
    clean: () => app.setClean(!app.clean),
  };
  const recBtn = rec.add(recActions, 'record').name('●  Record (R)');
  rec.add(recActions, 'sequence').name('Record full sequence');
  rec.add(recActions, 'clean').name('Clean mode for OBS (C)');

  if (window.innerHeight < 900) {
    light.close();
    rec.close();
  }

  // --- Scene strip -----------------------------------------------------------
  const strip = document.getElementById('strip')!;
  let dragFrom = -1;

  const renderStrip = () => {
    strip.replaceChildren();
    t.scenes.forEach((s: Scene, i: number) => {
      const tile = el('div', 'tile');
      if (i === t.index) tile.classList.add('playing');
      if (s === app.selected) tile.classList.add('selected');
      if (t.waiting === s) tile.classList.add('waiting');
      tile.draggable = true;
      tile.title = `${s.name}\nClick: edit · Double-click: morph now · Drag: reorder`;
      const img = el('img');
      img.src = s.thumb;
      img.alt = '';
      img.draggable = false;
      tile.append(img, el('span', 'num', String(i + 1)), el('span', 'name', s.name));
      const del = el('button', 'del', '×');
      del.title = 'Remove';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        app.removeScene(s);
      });
      tile.appendChild(del);
      tile.addEventListener('click', () => app.select(s));
      tile.addEventListener('dblclick', () => app.morphTo(s));
      tile.addEventListener('dragstart', (e) => {
        dragFrom = i;
        e.dataTransfer?.setData(SCENE_MIME, String(i));
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      });
      tile.addEventListener('dragover', (e) => {
        if (dragFrom < 0) return;
        e.preventDefault();
        tile.classList.add('drop');
      });
      tile.addEventListener('dragleave', () => tile.classList.remove('drop'));
      tile.addEventListener('drop', (e) => {
        if (dragFrom < 0) return;
        e.preventDefault();
        e.stopPropagation();
        app.moveScene(dragFrom, i);
        dragFrom = -1;
      });
      tile.addEventListener('dragend', () => {
        dragFrom = -1;
      });
      strip.appendChild(tile);
    });
    const addTile = el('button', 'tile add', '+');
    addTile.title = 'Add images';
    addTile.addEventListener('click', () => fileInput.click());
    strip.appendChild(addTile);
  };

  // --- Status / webcam preview ---------------------------------------------
  const status = document.getElementById('status')!;
  const statusText = status.querySelector('.text')!;
  const recBadge = document.getElementById('rec')!;
  const camBox = document.getElementById('webcam')!;
  camBox.prepend(app.webcam.video);

  const refreshStatus = () => {
    const text = app.status;
    status.hidden = !text;
    const pct = app.statusProgress > 0 && text === 'computing flow…' ? ` ${Math.round(app.statusProgress * 100)}%` : '';
    statusText.textContent = text + pct;
  };

  const refreshState = () => {
    const i = t.index;
    const scene = t.currentScene;
    const phase = t.waiting ? 'waiting for flow' : t.phase;
    pb.now = scene ? `${i + 1}/${t.scenes.length} ${scene.name} · ${phase}` : phase;
    nowCtl.updateDisplay();
    playBtn.name(t.playing ? 'Pause (Space)' : 'Play (Space)');
    recBtn.name(app.recorder.recording ? '■  Stop recording (R / Esc)' : '●  Record (R)');
    recBadge.hidden = !app.recorder.recording || app.clean;
    renderStrip();
  };

  // Recording timer.
  window.setInterval(() => {
    if (!app.recorder.recording) return;
    const s = Math.floor(app.recorder.elapsed);
    recBadge.textContent = `REC ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 250);

  app.on('scenes', renderStrip);
  app.on('state', refreshState);
  app.on('status', refreshStatus);
  app.on('selection', () => {
    rebuildSceneFolder();
    renderStrip();
  });
  app.on('webcam', () => {
    camBox.hidden = !app.webcam.active;
    camBtn.name(app.webcam.active ? 'Stop webcam' : 'Start webcam');
  });

  // --- Drag & drop files ------------------------------------------------------
  const drop = document.getElementById('dropzone')!;
  let dragDepth = 0;
  const isFileDrag = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!isFileDrag(e)) return;
    dragDepth++;
    drop.hidden = false;
  });
  window.addEventListener('dragleave', (e) => {
    if (!isFileDrag(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) drop.hidden = true;
  });
  window.addEventListener('dragover', (e) => {
    if (isFileDrag(e)) e.preventDefault();
  });
  window.addEventListener('drop', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth = 0;
    drop.hidden = true;
    if (e.dataTransfer?.files.length) void app.addFiles(e.dataTransfer.files);
  });

  // --- Keyboard -----------------------------------------------------------------
  window.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key.toLowerCase()) {
      case 'h':
        if (!app.clean) app.setUIHidden(!app.uiHidden);
        break;
      case 's':
        void app.snapshot();
        break;
      case ' ':
        e.preventDefault();
        app.togglePlay();
        break;
      case 'arrowright':
        t.next();
        break;
      case 'arrowleft':
        t.prev();
        break;
      case 'r':
        void app.toggleRecord();
        break;
      case 'c':
        app.setClean(!app.clean);
        break;
      case 'f':
        if (document.fullscreenElement) void document.exitFullscreen();
        else void document.documentElement.requestFullscreen?.();
        break;
      case 'escape':
        if (app.recorder.recording) void app.stopRecording();
        else if (app.clean) app.setClean(false);
        break;
      default:
        return;
    }
  });

  rebuildSceneFolder();
  refreshState();
  refreshStatus();
}
