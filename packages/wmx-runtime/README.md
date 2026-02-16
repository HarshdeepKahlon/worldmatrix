# @worldmatrix/wmx-runtime

Runtime helpers for loading WMX assets with decoder wiring and streaming support.

## Install

```bash
npm install @worldmatrix/wmx-runtime three meshoptimizer
```

## Usage

```ts
import * as THREE from 'three';
import { createWMXRuntime } from '@worldmatrix/wmx-runtime';

const renderer = new THREE.WebGLRenderer({ antialias: true });
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);

const runtime = createWMXRuntime({ renderer });

// Static
const gltf = await runtime.loadStatic('/wmx/my-asset/asset.wmx.json', { quality: 'medium' });
scene.add((gltf as any).scene);

// Streaming (if manifest has `manifest.streaming`)
const tileset = await runtime.loadStreamingTileset('/wmx/my-asset/asset.wmx.json');
scene.add(tileset);
const manager = runtime.createStreamManager({
  viewportHeightPx: renderer.domElement.clientHeight,
  retention: 'cache',
  disposeOutOfFrustumFrames: 30
});
manager.add(tileset);

function tick() {
  camera.updateMatrixWorld(true);
  tileset.updateMatrixWorld(true);
  manager.update(camera);
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
tick();
```
