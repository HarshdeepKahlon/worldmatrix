## Run the dashboard

From repo root:

```bash
npm install
npm run dev -w dashboard
```

Open:

- `http://localhost:5173`

### Local mode workflow

1. Click **Mode: local** if needed.
2. Click **Select folder** and choose the folder containing generated `*.wmx.json`.
3. Browse variant metadata, stats, and thumbnails.

### Server mode workflow (requires asset-server)

If using Docker Compose (`http://localhost:3000`), server mode lets you:

1. Upload `.glb` files from Finder.
2. Build selected/all on the asset server.
3. View assets under `/wmx/*` and run benchmark mode.

### Benchmark + debug

- Open Benchmark view for multi-model tests.
- Add `?wmxDebug=1` to enable verbose streaming logs.
- Use `retention` and `dispose frames` to evaluate culling/disposal behavior.

