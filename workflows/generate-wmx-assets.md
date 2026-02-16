## Generate WMX assets for a folder of glTF/GLB

### Prereqs

From repo root:

```bash
npm install
npm run build
```

### 1) If your inputs are `.glb`

#### Non-recursive (one folder)

```bash
INPUT_DIR="/path/to/models"
OUT_DIR="dist"

mkdir -p "$OUT_DIR"
for f in "$INPUT_DIR"/*.glb; do
  node packages/wmx-cli/dist/cli.js build "$f" --out "$OUT_DIR"
done
```

#### Recursive (nested folders)

```bash
INPUT_DIR="/path/to/models"
OUT_DIR="dist"

mkdir -p "$OUT_DIR"
find "$INPUT_DIR" -type f -name "*.glb" -print0 | while IFS= read -r -d '' f; do
  node packages/wmx-cli/dist/cli.js build "$f" --out "$OUT_DIR"
done
```

### Optional: KTX2 textures (BasisU)

To generate KTX2 textures (via `gltf-transform etc1s`) you need KTX-Software tools installed:

```bash
# macOS
brew install ktx-software
```

Then add `--textures ktx2`:

```bash
node packages/wmx-cli/dist/cli.js build "$f" --out "$OUT_DIR" --textures ktx2
```

### 2) If your inputs are `.gltf` (JSON)

Current `wmx-cli` expects **`.glb`**. Convert first, then run the `.glb` workflow.

One option is `gltf-transform` (CLI) conversion:

```bash
# install once
npm install -g @gltf-transform/cli

# convert a single file
gltf-transform copy "model.gltf" "model.glb"
```

Then run the `.glb` batch generation steps above.

### Output shape

For each input, the CLI produces:

```text
<OUT_DIR>/<assetNameOrId>/
  asset.wmx.json
  variants/low.glb
  variants/medium.glb
  variants/high.glb
  artifacts/stats.json
  artifacts/thumbnail.png   (optional)
```

### Thumbnails

Thumbnail rendering is **best-effort**. To enable thumbnails, install:

```bash
npm install -w @worldmatrix/wmx-cli @shopify/screenshot-glb
```

If it’s not installed, `wmx build` will warn and continue.

For Docker Compose (`wmx-asset-server`), the runtime image includes `@shopify/screenshot-glb` plus headless Chrome Linux dependencies, so dashboard-triggered builds can generate thumbnails without extra host setup.

