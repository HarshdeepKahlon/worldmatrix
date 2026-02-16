# @worldmatrix/wmx-three-streaming

Streaming refine-tree runtime for WMX manifests in Three.js scenes.

## Install

```bash
npm install @worldmatrix/wmx-three-streaming @worldmatrix/wmx-three three meshoptimizer
```

## Usage

Use this when your WMX manifest includes `manifest.streaming`.

```ts
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { WMXLoader } from '@worldmatrix/wmx-three';
import { WMXStreamManager, WMXStreamedTileset } from '@worldmatrix/wmx-three-streaming';

const renderer = new THREE.WebGLRenderer({ antialias: true });
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);

const wmxLoader = new WMXLoader(new GLTFLoader());
const tileset = await WMXStreamedTileset.fromManifestUrl('/wmx/my-asset/asset.wmx.json');
scene.add(tileset);

const manager = new WMXStreamManager({
  wmxLoader,
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
