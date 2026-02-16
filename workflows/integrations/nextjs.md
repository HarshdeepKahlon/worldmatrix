## Next.js (App Router) integration

For Next.js App Router, keep WMX rendering on the client.

### Install

```bash
npm install three @react-three/fiber @worldmatrix/wmx-r3f
```

### Client component pattern (`use client`)

```tsx
'use client';

import React, { Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import { WMXModel } from '@worldmatrix/wmx-r3f';

export function ModelCanvas() {
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

### Dynamic import pattern (`ssr: false`)

```tsx
import dynamic from 'next/dynamic';

const ModelCanvas = dynamic(() => import('./ModelCanvas').then((m) => m.ModelCanvas), {
  ssr: false
});

export default function Page() {
  return <ModelCanvas />;
}
```

### Streaming usage

```tsx
'use client';

import { Canvas } from '@react-three/fiber';
import { WMXStreamingTileset } from '@worldmatrix/wmx-r3f';

export function StreamingCanvas() {
  return (
    <Canvas camera={{ position: [4, 3, 4], fov: 50 }}>
      <WMXStreamingTileset
        manifestUrl="/wmx/my-asset/asset.wmx.json"
        retention="cache"
        disposeOutOfFrustumFrames={30}
      />
    </Canvas>
  );
}
```

### Decoder/CSP notes

- Default decoder assets are loaded from unpkg based on your installed `three` revision.
- If CSP blocks external CDN assets, override paths to self-hosted files:

```tsx
const runtime = useWMXRuntime({
  decoders: {
    basisTranscoderPath: '/basis/',
    dracoDecoderPath: '/draco/'
  }
});
```
