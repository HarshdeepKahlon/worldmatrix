## Docker Compose: asset-server + dashboard

This workflow runs a **local asset-server** (build + serve WMX assets) and a **dashboard UI** (trigger builds + view per-model metrics).

### 1) Prepare data directory

The compose file mounts a single volume:

- `./wmx_data` → `/data`

Inside it we use:

- `/data/source` for raw inputs (`.glb`)
- `/data/wmx` for outputs (generated WMX folders)

Create folders:

```bash
mkdir -p wmx_data/source wmx_data/wmx
```

Copy your source GLBs into `wmx_data/source/`:

```bash
cp -R "/Users/harshdeep/Downloads/sample_assets/"*.glb wmx_data/source/
```

### 2) Start containers

```bash
docker compose up --build
```

Or use the helper script:

```bash
./scripts/run-compose.sh
```

Services:
- **asset-server**: `http://localhost:8080`
- **dashboard**: `http://localhost:3000`

Optional env for encrypted payloads:
- `MODEL_ENCRYPTION_KEY`: when set, asset-server postprocess rewrites payload URLs to `.glb.br` (BuildCores-style encrypted brotli).
- If not set, builds still succeed and outputs remain plain `.glb` (default for local compose).

### 3) Trigger a build

Open the dashboard at `http://localhost:3000` and click **Build all**.

The server will run `wmx build-streaming --stage 2` for each `.glb` in `/data/source` and write outputs into `/data/wmx`.

### 3b) Upload from Finder (one or many)

In the dashboard, use the **Upload source assets** section to select one or many `.glb` files from Finder.

- Uploaded files are written into the container at `/data/source` (persisted on your host under `./wmx_data/source`).
- After upload, the dashboard refreshes the **Source files** list.
- You can then click **Build selected** (or **Build all**).

If you hit `413 Request Entity Too Large`, make sure you rebuilt/restarted compose after pulling the latest dashboard `nginx.conf`:

```bash
docker compose up --build
```

### 4) View metrics

The dashboard list shows assets discovered under `/data/wmx/**/asset.wmx.json`.

Each asset details page shows:
- per-variant bytes
- per-variant triangle / texture counts
- `artifacts/stats.json` when present
- thumbnail when present

### Notes

- **KTX2 tooling**: the `asset-server` image installs KTX-Software (`toktx`, `ktxsc`, `ktx`, `libktx.so*`) using the same pattern as BuildCores (pinned tarball + `ldconfig` + `ktx --version`).
- **Encryption mode**:
  - local default (no key): serves/publishes plain `.glb` payloads.
  - BuildCores mode (`MODEL_ENCRYPTION_KEY` set): converts payloads to `.glb.br` and rewrites manifest URLs/bytes.
- **Thumbnails**: server builds now request thumbnails by default. The asset-server image installs `@shopify/screenshot-glb` and required headless Chrome Linux libraries so `artifacts/thumbnail.png` is generated when rendering succeeds (best-effort).
- **Upload limits**: dashboard nginx is configured for large uploads (`client_max_body_size` set in `dashboard/nginx.conf`).
- **Reset state**:
  - remove generated data: `rm -rf ./wmx_data/wmx/*`
  - remove uploaded sources: `rm -rf ./wmx_data/source/*`
- **Debug logs**: open `http://localhost:3000/?wmxDebug=1` for benchmark streaming diagnostics.
