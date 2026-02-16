## R3F demo site

Demo site using React Three Fiber + `@worldmatrix/wmx-r3f`.

From repo root:

```bash
npm install
npm run build
npm run dev -w examples/r3f-demo
```

Then open the Vite URL (default port `5174`).

Notes:
- The demo will try to load a **bundled** WMX asset at `/wmx-bundled/asset.wmx.json`.
  - If it isn’t present (fresh clone), it falls back to an embedded tiny demo asset.
- The demo supports `auto`/`static`/`streaming` modes from the UI.
- Query params:
  - `?mode=streaming` (force streaming)
  - `?mode=static` (force static)
  - `?mode=auto` (manifest detection; default)

### Bundle a real WMX asset into the demo

This copies a generated WMX asset folder into `examples/r3f-demo/public/wmx-bundled/` so Vite serves it and includes it in builds:

```bash
python3 - <<'PY'
import shutil
from pathlib import Path

# Point this at a generated WMX asset folder (the folder containing `asset.wmx.json`).
# Example: dist/my-asset/
src = Path("dist/my-asset")
dest = Path("examples/r3f-demo/public/wmx-bundled")
dest.mkdir(parents=True, exist_ok=True)
for child in src.iterdir():
  target = dest / child.name
  if child.is_dir():
    shutil.copytree(child, target, dirs_exist_ok=True)
  else:
    shutil.copy2(child, target)
print("Bundled:", src, "->", dest)
PY
```

### Load a real local WMX output folder (no bundling)

Run with `WMX_ASSETS_DIR`:

```bash
WMX_ASSETS_DIR="/absolute/path/to/your/wmx/output/dist" \
  npm run dev -w examples/r3f-demo
```

Then open:
- `http://localhost:5174/?asset=stream-deck`

### Integration architecture

- Static rendering path uses `WMXModel`.
- Streaming rendering path uses `WMXStreamingTileset`.
- Both are provided by `@worldmatrix/wmx-r3f` and use `@worldmatrix/wmx-runtime` under the hood.


