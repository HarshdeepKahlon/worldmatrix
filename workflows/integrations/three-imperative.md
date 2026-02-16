## Three.js imperative integration

Use this when your app manages its own renderer/scene/camera loop.

### Install

```bash
npm install three @worldmatrix/wmx-runtime
```

### Static model loading

```ts
import * as THREE from 'three';
import { createWMXRuntime } from '@worldmatrix/wmx-runtime';

const renderer = new THREE.WebGLRenderer({ antialias: true });
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);

const runtime = createWMXRuntime({ renderer });

const gltf = await runtime.loadStatic('/wmx/my-asset/asset.wmx.json', { quality: 'medium' });
scene.add((gltf as any).scene);
```

By default this uses CDN decoder paths based on your installed `three` revision.

### Streaming tiles

```ts
import { createWMXRuntime } from '@worldmatrix/wmx-runtime';

const runtime = createWMXRuntime({ renderer });
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

### Override decoder paths (self-hosted)

```ts
const runtime = createWMXRuntime({
  renderer,
  decoders: {
    basisTranscoderPath: '/basis/',
    dracoDecoderPath: '/draco/'
  }
});
```

### Optional preload of decoder assets

```ts
await runtime.preloadDecoders();
```

This helps fail fast when CSP/network setup blocks WASM/decoder files.
