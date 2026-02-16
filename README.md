<p align="center">
  <img src="assets/worldmatrix-logo.jpg" alt="WorldMatrix" width="420" />
</p>

# worldmatrix

Open infrastructure for optimized 3D worlds. WorldMatrix builds fast, streamable asset outputs and provides runtime loaders/viewers for web apps.

## For developers

- Build once, serve everywhere: generate WMX manifests + optimized variants/tiles for web/mobile.
- Stable manifest contract: `asset.wmx.json` is the runtime source of truth.
- Three.js/R3F runtime support with KTX2/meshopt/draco wiring helpers.
- Debug tools: stats overlay, triangle counters, streaming debug signals.

## For artists

- Preserve artistic intent while producing lighter, faster runtime outputs.
- Review optimization tradeoffs via generated metrics (`stats.json`) and thumbnails.
- Predictable folder outputs for handoff, versioning, and asset management.

## Quickstart (local)

```bash
npm install
npm run build

# Build one WMX asset
node packages/wmx-cli/dist/cli.js build ./sample_assets/logitech_mouse.glb --out ./dist --name logitech-mouse

# Run dashboard in local mode
npm run dev -w dashboard
```

Open `http://localhost:5173`, switch to local mode if needed, and pick your output folder.

## Quickstart (Docker self-host)

```bash
npm install
./scripts/run-compose.sh
```

Then open:

- Dashboard: `http://localhost:3000`
- Asset server: `http://localhost:8080`

In dashboard server mode:

1. Upload one or more `.glb` files.
2. Build selected/all.
3. Inspect variants, stats, and streaming metadata.
4. Use Benchmark view for multi-asset testing (`?wmxDebug=1` for verbose streaming logs).

## WMX layout (v1)

Typical output:

```text
dist/<assetNameOrId>/
  asset.wmx.json
  variants/ultraLow.glb
  variants/low.glb
  variants/medium.glb
  variants/high.glb
  artifacts/stats.json
  artifacts/thumbnail.png   (optional)
  tiles/...                 (when streaming stage 2 is enabled)
```

## Streaming schema (canonical)

Streaming is first-class in v1 under:

- `manifest.streaming` (schema id: `wmx-streaming-refine-tree@1`)

Legacy fallback from `extras.streaming` is still supported by readers during transition, but producers should write `manifest.streaming`.

## Three.js integration (minimal)

```ts
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { WMXLoader } from '@worldmatrix/wmx-three';

const wmx = new WMXLoader(new GLTFLoader());
const gltf = await wmx.load('/wmx/my-asset/asset.wmx.json', { quality: 'medium' });
scene.add(gltf.scene);
```

For KTX2 output, configure `KTX2Loader` and pass it to `WMXLoader` (or use `@worldmatrix/wmx-viewer` helpers).

For batteries-included imperative setup, see:
- `workflows/integrations/three-imperative.md`

## R3F / React integration (minimal)

```tsx
import { WMXAutoViewer } from '@worldmatrix/wmx-viewer';

export function ModelCard() {
  return (
    <WMXAutoViewer
      manifestUrl="/wmx/my-asset/asset.wmx.json"
      renderer="webgpu"
      debug
      stats
      streaming={{ retention: 'cache', disposeOutOfFrustumFrames: 30 }}
    />
  );
}
```

For custom app integrations, see:
- `workflows/integrations/r3f.md`
- `workflows/integrations/nextjs.md`

## Benchmark/debug notes

- Add `?wmxDebug=1` to dashboard URL to enable verbose benchmark logs.
- Benchmark mode supports:
  - multi-asset scene
  - transform gizmo (translate/rotate/scale)
  - retention mode (`cache`/`dispose`)
  - dispose threshold (`disposeOutOfFrustumFrames`)

## Workflows

See [workflows/README.md](workflows/README.md) for copy/paste runbooks.

## Release/versioning

- User-facing changes are tracked in [CHANGELOG.md](CHANGELOG.md) under `Unreleased`.
- Streaming/culling behavior remains marked experimental where noted in docs.

## Stability policy (Milestone 1)

- **Stable now**:
  - `asset.wmx.json` core contract (`schemaVersion`, `assetId`, `variants`, `artifacts`, `streaming` field shape)
  - CLI build outputs and folder conventions
  - Basic Three.js/R3F loading path (`WMXLoader`, `WMXAutoViewer`)
- **Experimental**:
  - Advanced streaming runtime heuristics (dispose/culling edge behavior, occlusion tuning)
  - Benchmark-mode runtime controls used for diagnostics
