# @worldmatrix/wmx-r3f

React Three Fiber bindings for WorldMatrix viewers and streaming runtime components.

## Install

```bash
npm install @worldmatrix/wmx-r3f @react-three/fiber react three
```

## Usage

### Static model

```tsx
import React, { Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import { WMXModel } from '@worldmatrix/wmx-r3f';

export function Scene() {
  return (
    <Canvas camera={{ position: [2, 1.5, 2], fov: 50 }}>
      <ambientLight intensity={0.7} />
      <directionalLight position={[3, 5, 2]} intensity={1.1} />
      <Suspense fallback={null}>
        <WMXModel manifestUrl="/wmx/my-asset/asset.wmx.json" quality="medium" />
      </Suspense>
    </Canvas>
  );
}
```

### Streaming tileset

```tsx
import React from 'react';
import { Canvas } from '@react-three/fiber';
import { WMXStreamingTileset } from '@worldmatrix/wmx-r3f';

export function StreamingScene() {
  return (
    <Canvas camera={{ position: [4, 3, 4], fov: 50 }}>
      <ambientLight intensity={0.7} />
      <directionalLight position={[3, 5, 2]} intensity={1.1} />
      <WMXStreamingTileset
        manifestUrl="/wmx/my-asset/asset.wmx.json"
        retention="cache"
        disposeOutOfFrustumFrames={30}
      />
    </Canvas>
  );
}
```
