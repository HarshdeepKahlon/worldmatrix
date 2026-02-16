## React Three Fiber integration

Use this when your app already has a `Canvas` and custom scene graph.

### Install

```bash
npm install three @react-three/fiber @worldmatrix/wmx-r3f
```

### Static WMX model in your scene

```tsx
import React, { Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { WMXModel } from '@worldmatrix/wmx-r3f';

export function Scene() {
  return (
    <Canvas camera={{ position: [2, 1.5, 2], fov: 50 }}>
      <ambientLight intensity={0.7} />
      <directionalLight position={[3, 5, 2]} intensity={1.1} />
      <Suspense fallback={null}>
        <WMXModel manifestUrl="/wmx/my-asset/asset.wmx.json" quality="medium" />
      </Suspense>
      <OrbitControls makeDefault />
    </Canvas>
  );
}
```

### Streaming tileset in your scene

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

### Decoder path override

If you need self-hosted decoder assets, create a runtime via `useWMXRuntime()` options and pass it into components.

```tsx
import { WMXModel, useWMXRuntime } from '@worldmatrix/wmx-r3f';

function Content() {
  const runtime = useWMXRuntime({
    decoders: {
      basisTranscoderPath: '/basis/',
      dracoDecoderPath: '/draco/'
    }
  });
  return <WMXModel runtime={runtime} manifestUrl="/wmx/my-asset/asset.wmx.json" quality="high" />;
}
```
