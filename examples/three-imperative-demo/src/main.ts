import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createWMXRuntime, type WMXRuntime } from '@worldmatrix/wmx-runtime';

import { makeDemoManifestDataUrl } from './demoAsset';

type LoadMode = 'auto' | 'static' | 'streaming';
type Retention = 'cache' | 'dispose';
type Quality = 'low' | 'medium' | 'high';

const state = {
  quality: ((getSearchParam('quality') as Quality | null) ?? 'medium') as Quality,
  mode: ((getSearchParam('mode') as LoadMode | null) ?? 'auto') as LoadMode,
  retention: ((getSearchParam('retention') as Retention | null) ?? 'cache') as Retention,
  assetName: getSearchParam('asset') ?? '',
  sample: getSearchParam('sample') ?? '',
  streamingForced: getSearchParam('streaming') === '1'
};

const app = document.createElement('div');
app.style.cssText =
  'position:fixed; inset:0; background:#0b1220; color:#eaf0ff; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;';
document.body.appendChild(app);

const canvasWrap = document.createElement('div');
canvasWrap.style.cssText = 'position:absolute; inset:0 420px 0 0;';
app.appendChild(canvasWrap);

const sidebar = document.createElement('div');
sidebar.style.cssText =
  'position:absolute; top:0; right:0; bottom:0; width:420px; overflow:auto; border-left:1px solid rgba(255,255,255,0.12); background:rgba(255,255,255,0.04); padding:14px;';
app.appendChild(sidebar);

// Use logarithmic depth to support very large assets without far-clip / z-fighting.
const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(canvasWrap.clientWidth, canvasWrap.clientHeight);
canvasWrap.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 100000);
camera.position.set(1.6, 1.6, 1.6);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

scene.add(new THREE.AmbientLight(0xffffff, 0.7));
const dir = new THREE.DirectionalLight(0xffffff, 1.2);
dir.position.set(2, 3, 4);
scene.add(dir);
scene.add(new THREE.GridHelper(10, 10));
scene.add(new THREE.AxesHelper(2));

const runtime = createWMXRuntime({ renderer });

let contentRoot: THREE.Object3D | null = null;
let streamManager: any | null = null;
let streamTileset: any | null = null;
let sampleAssets: Array<{ id: string; name: string; manifestUrl: string }> = [];
let status = 'idle';
let triangles = 0;
let usedHeapBytes: number | null = null;
let residentTileCount = 0;
let residentBytes = 0;
let lastDebugAt = 0;

function setStatus(next: string) {
  status = next;
  renderSidebar();
}

function activeManifestUrl(): string {
  if (state.assetName.trim()) return `/wmx/${encodeURIComponent(state.assetName.trim())}/asset.wmx.json`;
  if (state.sample) return `/wmx-samples/${encodeURIComponent(state.sample)}/asset.wmx.json`;
  return '/wmx-bundled/asset.wmx.json';
}

async function fetchSampleAssets() {
  try {
    const res = await fetch('/wmx-samples/index.json', { headers: { Accept: 'application/json' } });
    if (!res.ok) return;
    const json = (await res.json()) as { assets?: Array<{ id: string; name: string; manifestUrl: string }> };
    sampleAssets = Array.isArray(json.assets) ? json.assets : [];
    if (!state.assetName && !state.sample && sampleAssets[0]) {
      state.sample = sampleAssets[0].id;
      setSearchParam('sample', state.sample);
    }
  } catch {
    // ignore
  } finally {
    renderSidebar();
  }
}

async function shouldUseStreaming(manifestUrl: string): Promise<boolean> {
  if (state.streamingForced) return true;
  if (state.mode === 'streaming') return true;
  if (state.mode === 'static') return false;
  try {
    const res = await fetch(manifestUrl, { headers: { Accept: 'application/json' } });
    if (!res.ok) return false;
    const json = (await res.json()) as any;
    return (
      json?.streaming?.schema === 'wmx-streaming-refine-tree@1' ||
      json?.extras?.streaming?.schema === 'wmx-streaming-refine-tree@1'
    );
  } catch {
    return false;
  }
}

function clearCurrentContent() {
  if (streamManager && streamTileset) {
    streamManager.remove(streamTileset);
  }
  if (streamTileset) {
    scene.remove(streamTileset);
  }
  streamManager = null;
  streamTileset = null;
  if (contentRoot) scene.remove(contentRoot);
  contentRoot = null;
  triangles = 0;
  usedHeapBytes = null;
  residentTileCount = 0;
  residentBytes = 0;
}

async function loadCurrent() {
  clearCurrentContent();
  const desiredUrl = activeManifestUrl();
  let manifestUrl = desiredUrl;
  setStatus(`loading: ${manifestUrl}`);

  const useStreaming = await shouldUseStreaming(manifestUrl);
  try {
    if (useStreaming) {
      streamTileset = await runtime.loadStreamingTileset(manifestUrl);
      streamManager = runtime.createStreamManager({
        viewportHeightPx: Math.max(1, canvasWrap.clientHeight),
        retention: state.retention,
        disposeOutOfFrustumFrames: 30
      });
      streamManager.add(streamTileset);
      scene.add(streamTileset);
      fitCameraToObject(streamTileset);
      setStatus(`ready (streaming): ${manifestUrl}`);
      (window as any).__WMX_IMPERATIVE_DEMO__ = { mode: 'streaming', manifestUrl, status };
      return;
    }

    const loaded = (await runtime.loadStatic(manifestUrl, { quality: state.quality })) as any;
    contentRoot = loaded?.scene ?? null;
    if (!contentRoot) throw new Error('Loaded GLTF has no scene');
    scene.add(contentRoot);
    fitCameraToObject(contentRoot);
    setStatus(`ready (${state.quality}): ${manifestUrl}`);
    (window as any).__WMX_IMPERATIVE_DEMO__ = { mode: 'static', manifestUrl, status, quality: state.quality };
  } catch (e) {
    if (manifestUrl.startsWith('/wmx-bundled/')) {
      try {
        manifestUrl = makeDemoManifestDataUrl();
        const loaded = (await runtime.loadStatic(manifestUrl, { quality: state.quality })) as any;
        contentRoot = loaded?.scene ?? null;
        if (!contentRoot) throw new Error('Loaded fallback GLTF has no scene');
        scene.add(contentRoot);
        fitCameraToObject(contentRoot);
        setStatus(`fallback embedded (${state.quality})`);
        (window as any).__WMX_IMPERATIVE_DEMO__ = { mode: 'static', manifestUrl, status, quality: state.quality };
      } catch (e2) {
        setStatus(`error: ${(e2 as Error)?.message ?? String(e2)}`);
      }
      return;
    }
    setStatus(`error: ${(e as Error)?.message ?? String(e)}`);
  }
}

function fitCameraToObject(obj: THREE.Object3D) {
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(0.001, size.length() * 0.5);
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const dist = radius / Math.sin(fov / 2);
  const dirVec = new THREE.Vector3(1, 0.6, 1).normalize();
  camera.position.copy(center).addScaledVector(dirVec, dist);
  // Keep near/far robust for massive assets.
  camera.near = Math.max(0.001, dist / 20000);
  camera.far = Math.min(1e9, Math.max(camera.far, dist * 2000));
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
}

function updateCameraClipForObject(obj: THREE.Object3D) {
  const box = new THREE.Box3().setFromObject(obj);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(0.001, size.length() * 0.5);
  const d = camera.position.distanceTo(center);
  const near = Math.max(0.001, d - radius * 6);
  const far = Math.min(1e9, d + radius * 6);
  // Only expand far / lower near when needed to avoid constant projection updates.
  const needs = near < camera.near || far > camera.far;
  if (!needs) return;
  camera.near = Math.min(camera.near, near);
  camera.far = Math.max(camera.far, far);
  camera.updateProjectionMatrix();
}

function renderSidebar() {
  sidebar.innerHTML = '';
  const makeHeading = (text: string) => {
    const h = document.createElement('div');
    h.textContent = text;
    h.style.cssText = 'font-size:12px; text-transform:uppercase; opacity:.85; margin:12px 0 8px; font-weight:800;';
    sidebar.appendChild(h);
  };
  const makeText = (text: string) => {
    const p = document.createElement('div');
    p.textContent = text;
    p.style.cssText = 'font-size:12px; opacity:.9; margin-bottom:8px; line-height:1.5;';
    sidebar.appendChild(p);
  };

  const title = document.createElement('div');
  title.textContent = 'WorldMatrix + Three.js imperative demo';
  title.style.cssText = 'font-size:18px; font-weight:900; margin-bottom:4px;';
  sidebar.appendChild(title);
  makeText('Uses @worldmatrix/wmx-runtime for static and streaming modes.');

  makeHeading('Status');
  makeText(status);
  makeText(`Manifest URL: ${activeManifestUrl()}`);
  makeText(
    `Triangles: ${
      Number.isFinite(triangles) ? triangles.toLocaleString() : 'n/a'
    }`
  );
  makeText(
    `Used JS heap: ${
      typeof usedHeapBytes === 'number' ? `${(usedHeapBytes / (1024 * 1024)).toFixed(1)} MB` : 'n/a (browser unsupported)'
    }`
  );
  makeHeading('Streaming debug');
  makeText(`resident tiles: ${residentTileCount.toLocaleString()}`);
  makeText(`resident bytes: ${(residentBytes / (1024 * 1024)).toFixed(2)} MB`);

  makeHeading('Sample asset');
  if (sampleAssets.length) {
    const sel = document.createElement('select');
    sel.style.cssText = inputStyle();
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = '(none)';
    sel.appendChild(empty);
    for (const a of sampleAssets) {
      const o = document.createElement('option');
      o.value = a.id;
      o.textContent = a.name;
      sel.appendChild(o);
    }
    sel.value = state.sample;
    sel.onchange = () => {
      state.sample = sel.value;
      setSearchParam('sample', state.sample || null);
      if (state.sample) {
        state.assetName = '';
        setSearchParam('asset', null);
      }
      void loadCurrent();
    };
    sidebar.appendChild(sel);
  } else {
    makeText('No /wmx-samples/index.json found. Using bundled/fallback.');
  }

  makeHeading('Local asset');
  const localInput = document.createElement('input');
  localInput.placeholder = 'asset folder name (e.g. stream-deck)';
  localInput.value = state.assetName;
  localInput.style.cssText = inputStyle();
  sidebar.appendChild(localInput);
  const loadBtn = document.createElement('button');
  loadBtn.textContent = 'Load asset';
  loadBtn.style.cssText = buttonStyle();
  loadBtn.onclick = () => {
    state.assetName = localInput.value.trim();
    setSearchParam('asset', state.assetName || null);
    if (state.assetName) {
      state.sample = '';
      setSearchParam('sample', null);
    }
    void loadCurrent();
  };
  sidebar.appendChild(loadBtn);
  makeText(`WMX_ASSETS_DIR: ${__WMX_ASSETS_DIR__ || '(not set)'}`);

  makeHeading('Mode');
  const modeSelect = document.createElement('select');
  modeSelect.style.cssText = inputStyle();
  for (const v of ['auto', 'static', 'streaming'] as const) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = v;
    modeSelect.appendChild(o);
  }
  modeSelect.value = state.streamingForced ? 'streaming' : state.mode;
  modeSelect.onchange = () => {
    state.mode = modeSelect.value as LoadMode;
    state.streamingForced = state.mode === 'streaming';
    setSearchParam('mode', state.mode);
    setSearchParam('streaming', state.streamingForced ? '1' : null);
    void loadCurrent();
  };
  sidebar.appendChild(modeSelect);

  makeHeading('Quality (static)');
  const qSelect = document.createElement('select');
  qSelect.style.cssText = inputStyle();
  for (const v of ['low', 'medium', 'high'] as const) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = v;
    qSelect.appendChild(o);
  }
  qSelect.value = state.quality;
  qSelect.onchange = () => {
    state.quality = qSelect.value as Quality;
    setSearchParam('quality', state.quality);
    void loadCurrent();
  };
  sidebar.appendChild(qSelect);

  makeHeading('Retention (streaming)');
  const rSelect = document.createElement('select');
  rSelect.style.cssText = inputStyle();
  for (const v of ['cache', 'dispose'] as const) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = v;
    rSelect.appendChild(o);
  }
  rSelect.value = state.retention;
  rSelect.onchange = () => {
    state.retention = rSelect.value as Retention;
    setSearchParam('retention', state.retention);
    void loadCurrent();
  };
  sidebar.appendChild(rSelect);
}

function buttonStyle() {
  return 'display:block;width:100%;margin-top:8px;border-radius:10px;padding:10px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);color:#eaf0ff;cursor:pointer;font-weight:800;';
}

function inputStyle() {
  return 'display:block;width:100%;margin-top:8px;border-radius:10px;padding:10px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);color:#eaf0ff;outline:none;';
}

function onResize() {
  renderer.setSize(canvasWrap.clientWidth, canvasWrap.clientHeight);
  camera.aspect = Math.max(1, canvasWrap.clientWidth) / Math.max(1, canvasWrap.clientHeight);
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', onResize);
onResize();

function animate() {
  controls.update();
  if (streamManager && streamTileset) {
    streamTileset.updateMatrixWorld(true);
    streamManager.update(camera);
  }
  // Keep clip planes wide enough for huge assets as content refines.
  const clipRoot = streamTileset ?? contentRoot;
  if (clipRoot) updateCameraClipForObject(clipRoot);
  const now = performance.now();
  if (now - lastDebugAt > 350) {
    const root = streamTileset ?? contentRoot;
    triangles = root ? countTriangles(root) : 0;
    const mem = (performance as any)?.memory;
    usedHeapBytes = typeof mem?.usedJSHeapSize === 'number' ? mem.usedJSHeapSize : null;
    if (streamManager && streamTileset && typeof streamManager.getResidentDebugInfo === 'function') {
      const info = streamManager.getResidentDebugInfo(streamTileset) as Array<{ bytes?: number }>;
      residentTileCount = info.length;
      residentBytes = info.reduce((sum, r) => sum + (typeof r.bytes === 'number' ? r.bytes : 0), 0);
    } else {
      residentTileCount = 0;
      residentBytes = 0;
    }
    lastDebugAt = now;
    renderSidebar();
    (window as any).__WMX_IMPERATIVE_DEMO__ = {
      ...(window as any).__WMX_IMPERATIVE_DEMO__,
      debug: { triangles, usedHeapBytes, residentTileCount, residentBytes }
    };
  }
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

void fetchSampleAssets();
renderSidebar();
void loadCurrent();
animate();

function getSearchParam(name: string): string | null {
  try {
    const u = new URL(window.location.href);
    return u.searchParams.get(name);
  } catch {
    return null;
  }
}

function setSearchParam(name: string, value: string | null) {
  try {
    const u = new URL(window.location.href);
    if (value === null || value === '') u.searchParams.delete(name);
    else u.searchParams.set(name, value);
    window.history.replaceState({}, '', u.toString());
  } catch {
    // ignore
  }
}

function countTriangles(root: THREE.Object3D): number {
  let tris = 0;
  root.traverse((o: any) => {
    if (!o.isMesh && !o.isSkinnedMesh && !o.isInstancedMesh) return;
    const g = o.geometry as THREE.BufferGeometry | undefined;
    if (!g) return;
    const idx = g.getIndex?.();
    const pos = g.getAttribute?.('position');
    const base = idx ? Math.floor(idx.count / 3) : pos ? Math.floor(pos.count / 3) : 0;
    const instances = o.isInstancedMesh ? Math.max(1, o.count ?? o.instanceCount ?? 1) : 1;
    tris += base * instances;
  });
  return tris;
}

declare const __WMX_ASSETS_DIR__: string;
