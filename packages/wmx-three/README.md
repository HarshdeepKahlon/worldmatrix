# @worldmatrix/wmx-three

Three.js loader wrapper for loading WorldMatrix manifests and variants.

## Install

```bash
npm install @worldmatrix/wmx-three three
```

## Usage

```ts
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { WMXLoader } from '@worldmatrix/wmx-three';

const loader = new WMXLoader(new GLTFLoader());

const gltf = await loader.load('/wmx/my-asset/asset.wmx.json', { quality: 'medium' });
```
