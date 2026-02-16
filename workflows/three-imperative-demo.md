## Three.js imperative demo site

This repo includes a demo using **plain Three.js** + `@worldmatrix/wmx-runtime`.

From repo root:

```bash
npm install
npm run build
npm run dev -w examples/three-imperative-demo
```

Then open the Vite URL (default port `5175`).

### What it demonstrates

- Static WMX loading via `runtime.loadStatic()`
- Streaming WMX loading via `runtime.loadStreamingTileset()` + `runtime.createStreamManager()`
- Runtime mode switching (`auto` / `static` / `streaming`)
- Streaming retention switching (`cache` / `dispose`)
- Bundled-manifest fallback to an embedded tiny demo asset on fresh clones

### Load a real local WMX output folder (no bundling)

Run with `WMX_ASSETS_DIR`:

```bash
WMX_ASSETS_DIR="/Users/harshdeep/Documents/GitHub/worldmatrix/dist/setup-assets-20260201-134057" \
  npm run dev -w examples/three-imperative-demo
```

Then open:
- `http://localhost:5175/?asset=stream-deck`
- optional mode forcing: `http://localhost:5175/?asset=stream-deck&mode=streaming`

### Notes

- Decoder assets default to CDN paths derived from your installed `three` version (via `@worldmatrix/wmx-runtime`).
- Runtime debug state is exposed on `window.__WMX_IMPERATIVE_DEMO__`.
