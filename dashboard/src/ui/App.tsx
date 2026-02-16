import React, { useMemo, useState } from 'react';
import type { WMXManifestV1 } from '@worldmatrix/wmx-core';
import { isWMXManifestV1 } from '@worldmatrix/wmx-core';
import { WMXAutoViewer } from '@worldmatrix/wmx-viewer';
import { BenchmarkScene } from './BenchmarkScene.js';

type AssetEntry = {
  id: string;
  name: string;
  manifestPath: string;
  manifest: WMXManifestV1;
  folderHandle?: FileSystemDirectoryHandle;
  baseUrl?: string;
};

export function App() {
  const [rootHandle, setRootHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [assets, setAssets] = useState<AssetEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useMemo(() => assets.find((a) => a.id === selectedId) ?? null, [assets, selectedId]);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'server' | 'local'>('server');
  const [buildJobId, setBuildJobId] = useState<string | null>(null);
  const [buildStatus, setBuildStatus] = useState<string | null>(null);
  const [source, setSource] = useState<Array<{ path: string; bytes: number; mtimeMs: number }>>([]);
  const [sourceSelected, setSourceSelected] = useState<Record<string, boolean>>({});
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [view, setView] = useState<'details' | 'benchmark'>('details');
  const [benchSelected, setBenchSelected] = useState<Record<string, boolean>>({});

  const pickFolder = async () => {
    setError(null);
    try {
      // File System Access API (Chromium). This is the intended v1 path.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handle = await (window as any).showDirectoryPicker();
      setRootHandle(handle);
      const found = await scanForManifests(handle);
      setAssets(found);
      setSelectedId(found[0]?.id ?? null);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  };

  const refreshFromServer = async () => {
    setError(null);
    try {
      const res = await fetch('/api/assets', { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`Failed to load assets: ${res.status} ${res.statusText}`);
      const json = (await res.json()) as { assets?: any[] };
      const list = Array.isArray(json.assets) ? json.assets : [];
      const mapped: AssetEntry[] = list
        .map((a) => {
          const manifest = a?.variants ? ({ schemaVersion: '1.0', assetId: a.assetId, name: a.name, variants: a.variants } as WMXManifestV1) : null;
          if (!manifest || !isWMXManifestV1(manifest)) return null;
          return {
            id: String(a.id),
            name: String(a.name ?? a.id),
            manifestPath: String(a.manifestUrl ?? ''),
            manifest,
            baseUrl: '' // same-origin, resolved later
          } satisfies AssetEntry;
        })
        .filter(Boolean) as AssetEntry[];

      setAssets(mapped);
      setSelectedId((prev) => prev ?? mapped[0]?.id ?? null);
      setBenchSelected((prev) => {
        // keep previous selections where possible
        const next: Record<string, boolean> = {};
        for (const a of mapped) next[a.id] = prev[a.id] ?? false;
        return next;
      });
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  };

  const refreshSourceFromServer = async () => {
    try {
      const res = await fetch('/api/source', { headers: { Accept: 'application/json' } });
      if (!res.ok) return;
      const json = (await res.json()) as { source?: Array<{ path: string; bytes: number; mtimeMs: number }> };
      const list = Array.isArray(json.source) ? json.source : [];
      setSource(list);
      setSourceSelected((prev) => {
        // keep previous selections for existing files
        const next: Record<string, boolean> = {};
        for (const s of list) next[s.path] = prev[s.path] ?? false;
        return next;
      });
    } catch {
      // ignore
    }
  };

  const uploadFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError(null);
    setUploadStatus(`Uploading ${files.length} file(s)...`);
    try {
      const fd = new FormData();
      for (const f of Array.from(files)) fd.append('files', f, f.name);
      const res = await fetch('/api/upload', { method: 'POST', body: fd });
      if (!res.ok) throw new Error(`Upload failed: ${res.status} ${res.statusText}`);
      const json = (await res.json()) as { saved?: any[]; errors?: string[] };
      const savedCount = Array.isArray(json.saved) ? json.saved.length : 0;
      const errCount = Array.isArray(json.errors) ? json.errors.length : 0;
      setUploadStatus(`Uploaded ${savedCount} file(s)` + (errCount ? ` (${errCount} error(s))` : ''));
      await refreshSourceFromServer();
    } catch (e: any) {
      setUploadStatus(null);
      setError(e?.message ?? String(e));
    }
  };

  const startBuild = async () => {
    setError(null);
    setBuildStatus('Starting build...');
    try {
      const res = await fetch('/api/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ textures: 'ktx2', thumbnails: true, streaming: true })
      });
      if (!res.ok) throw new Error(`Build start failed: ${res.status} ${res.statusText}`);
      const json = (await res.json()) as { jobId?: string };
      if (!json.jobId) throw new Error('Build start failed: missing jobId');
      setBuildJobId(json.jobId);
      setBuildStatus(`Build started: ${json.jobId}`);
    } catch (e: any) {
      setBuildStatus(null);
      setError(e?.message ?? String(e));
    }
  };

  const startBuildSelected = async () => {
    const inputs = Object.entries(sourceSelected)
      .filter(([, v]) => v)
      .map(([k]) => k);
    if (inputs.length === 0) {
      setError('Select at least one source file to build.');
      return;
    }
    setError(null);
    setBuildStatus(`Starting build (${inputs.length} selected)...`);
    try {
      const res = await fetch('/api/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ textures: 'ktx2', thumbnails: true, streaming: true, inputs })
      });
      if (!res.ok) throw new Error(`Build start failed: ${res.status} ${res.statusText}`);
      const json = (await res.json()) as { jobId?: string };
      if (!json.jobId) throw new Error('Build start failed: missing jobId');
      setBuildJobId(json.jobId);
      setBuildStatus(`Build started: ${json.jobId}`);
    } catch (e: any) {
      setBuildStatus(null);
      setError(e?.message ?? String(e));
    }
  };

  React.useEffect(() => {
    if (mode !== 'server') return;
    refreshFromServer();
    refreshSourceFromServer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  React.useEffect(() => {
    if (!buildJobId) return;
    let cancelled = false;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/build/${encodeURIComponent(buildJobId)}`, { headers: { Accept: 'application/json' } });
        if (!res.ok) return;
        const json = (await res.json()) as { status?: string; error?: string };
        if (cancelled) return;
        setBuildStatus(json.status ?? 'unknown');
        if (json.status === 'succeeded' || json.status === 'failed') {
          clearInterval(interval);
          if (json.status === 'failed') setError(json.error ?? 'build failed');
          await refreshFromServer();
        }
      } catch {
        // ignore poll errors
      }
    }, 1200);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildJobId]);

  return (
    <div style={styles.shell}>
      <header style={styles.header}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <div style={styles.title}>WorldMatrix Dashboard</div>
          <div style={styles.subtitle}>
            {mode === 'server' ? 'Browse assets from asset-server' : 'Browse local `.wmx.json` manifests and artifacts'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button onClick={() => setView((v) => (v === 'details' ? 'benchmark' : 'details'))} style={styles.button}>
            View: {view === 'details' ? 'details' : 'benchmark'}
          </button>
          <button
            onClick={() => setMode((m) => (m === 'server' ? 'local' : 'server'))}
            style={{ ...styles.button, background: '#ffffff', color: '#0b1220' }}
          >
            Mode: {mode === 'server' ? 'server' : 'local'}
          </button>
          {mode === 'server' ? (
            <>
              <button onClick={refreshFromServer} style={styles.button}>
                Refresh
              </button>
              <button onClick={refreshSourceFromServer} style={styles.button}>
                Refresh source
              </button>
              <button onClick={startBuild} style={styles.button}>
                Build all
              </button>
              <button onClick={startBuildSelected} style={styles.button}>
                Build selected
              </button>
              <div style={styles.smallText}>{buildStatus ? `Build: ${buildStatus}` : 'Idle'}</div>
            </>
          ) : (
            <>
              <button onClick={pickFolder} style={styles.button}>
                Select folder
              </button>
              <div style={styles.smallText}>{rootHandle ? 'Folder selected' : 'No folder selected'}</div>
            </>
          )}
        </div>
      </header>

      {error ? (
        <div style={styles.banner}>
          <div style={{ fontWeight: 700 }}>Error</div>
          <div style={{ whiteSpace: 'pre-wrap' }}>{error}</div>
        </div>
      ) : null}

      {mode === 'local' && !supportsDirectoryPicker() ? (
        <div style={styles.banner}>
          <div style={{ fontWeight: 700 }}>Browser support</div>
          <div>
            This dashboard uses the File System Access API. It works best in Chromium browsers (Chrome/Edge). Future versions
            can add a local API server for Safari/Firefox compatibility.
          </div>
        </div>
      ) : null}

      <div style={styles.body}>
        <aside style={styles.sidebar}>
          <div style={styles.sectionTitle}>Assets ({assets.length})</div>
          <div style={styles.assetList}>
            {assets.map((a) => (
              <button
                key={a.id}
                style={{
                  ...styles.assetRow,
                  ...(a.id === selectedId ? styles.assetRowActive : {})
                }}
                onClick={() => setSelectedId(a.id)}
                title={a.manifestPath}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  {mode === 'server' ? (
                    <input
                      type="checkbox"
                      checked={!!benchSelected[a.id]}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setBenchSelected((prev) => ({ ...prev, [a.id]: e.target.checked }))}
                      title="Include in benchmark scene"
                    />
                  ) : null}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <div style={{ fontWeight: 700 }}>{a.name}</div>
                    <div style={styles.monoSmall}>{a.manifest.assetId.slice(0, 12)}</div>
                  </div>
                </div>
              </button>
            ))}
            {assets.length === 0 ? <div style={styles.smallText}>No `.wmx.json` found yet.</div> : null}
          </div>
        </aside>

        <main style={styles.main}>
          {mode === 'server' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={styles.card}>
                <div style={styles.cardTitle}>Upload source assets</div>
                <div style={styles.smallText}>Upload one or many `.glb` files from Finder into the asset-server.</div>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 10 }}>
                  <input
                    type="file"
                    multiple
                    accept=".glb"
                    onChange={(e) => uploadFiles(e.target.files)}
                    style={styles.fileInput}
                  />
                  <div style={styles.smallText}>{uploadStatus ?? ''}</div>
                </div>
              </div>

              <div style={styles.card}>
                <div style={styles.cardTitle}>Source files ({source.length})</div>
                {source.length ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        style={{ ...styles.button, background: '#ffffff', color: '#0b1220' }}
                        onClick={() => setSourceSelected(Object.fromEntries(source.map((s) => [s.path, true])))}
                      >
                        Select all
                      </button>
                      <button
                        style={{ ...styles.button, background: '#ffffff', color: '#0b1220' }}
                        onClick={() => setSourceSelected(Object.fromEntries(source.map((s) => [s.path, false])))}
                      >
                        Clear
                      </button>
                    </div>
                    <div style={{ maxHeight: 220, overflow: 'auto', border: '1px solid rgba(0,0,0,0.08)', borderRadius: 12, padding: 8 }}>
                      {source.map((s) => (
                        <label key={s.path} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0' }}>
                          <input
                            type="checkbox"
                            checked={!!sourceSelected[s.path]}
                            onChange={(e) => setSourceSelected((prev) => ({ ...prev, [s.path]: e.target.checked }))}
                          />
                          <span style={styles.tdMono}>{s.path}</span>
                          <span style={styles.smallText}>({s.bytes.toLocaleString()} bytes)</span>
                        </label>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div style={styles.smallText}>No `.glb` found on server yet. Upload some files above.</div>
                )}
              </div>

              {view === 'details' ? (
                <>{selected ? <AssetDetails asset={selected} /> : <div style={styles.smallText}>Select an asset.</div>}</>
              ) : (
                <div style={styles.card}>
                  <div style={styles.cardTitle}>Benchmark</div>
                  <div style={styles.smallText}>
                    Select multiple assets in the sidebar (checkboxes), then they will be loaded together into one scene for benchmarking.
                  </div>
                  <div style={{ height: 10 }} />
                  {(() => {
                    const picked = assets.filter((a) => !!benchSelected[a.id]).filter((a) => a.manifestPath?.startsWith('/wmx/'));
                    if (picked.length === 0) return <div style={styles.smallText}>No benchmark assets selected yet.</div>;
                    return (
                      <BenchmarkScene
                        assets={picked.map((a) => ({ id: a.id, name: a.name, manifestUrl: a.manifestPath }))}
                      />
                    );
                  })()}
                </div>
              )}
            </div>
          ) : (
            <>
              {view === 'benchmark' ? (
                <div style={styles.banner}>
                  <div style={{ fontWeight: 700 }}>Benchmark mode</div>
                  <div>Benchmark mode currently requires server mode (assets served under `/wmx/`).</div>
                </div>
              ) : null}
              {selected ? <AssetDetails asset={selected} /> : <div style={styles.smallText}>Select an asset.</div>}
            </>
          )}
        </main>
      </div>
    </div>
  );
}

function AssetDetails({ asset }: { asset: AssetEntry }) {
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const [thumbnailLoadError, setThumbnailLoadError] = useState(false);
  const [statsText, setStatsText] = useState<string | null>(null);
  const [artifactError, setArtifactError] = useState<string | null>(null);
  const [fullManifest, setFullManifest] = useState<WMXManifestV1>(asset.manifest);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [retention, setRetention] = useState<'cache' | 'dispose'>('cache');
  const [disposeFrames, setDisposeFrames] = useState<number>(30);

  React.useEffect(() => {
    let cancelled = false;
    setManifestError(null);
    setFullManifest(asset.manifest);
    setRetention('cache');
    setDisposeFrames(30);

    (async () => {
      try {
        if (asset.folderHandle) {
          // Local mode: manifest is already parsed from disk (and should include artifacts/extras).
          return;
        }
        if (asset.manifestPath) {
          // Server mode: fetch the full manifest so we can show extras/artifacts/streaming metadata.
          const res = await fetch(asset.manifestPath, { headers: { Accept: 'application/json' } });
          if (!res.ok) throw new Error(`Failed to fetch manifest: ${res.status} ${res.statusText}`);
          const json = (await res.json()) as unknown;
          if (!isWMXManifestV1(json)) throw new Error('Invalid WMX manifest');
          if (!cancelled) setFullManifest(json);
        }
      } catch (e: any) {
        if (!cancelled) setManifestError(e?.message ?? String(e));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [asset]);

  React.useEffect(() => {
    let revoked: string | null = null;
    setArtifactError(null);
    setThumbnailUrl(null);
    setThumbnailLoadError(false);
    setStatsText(null);

    (async () => {
      try {
        const thumbRel = fullManifest.artifacts?.thumbnail;
        if (thumbRel) {
          if (asset.folderHandle) {
            const file = await getFileByRelativePath(asset.folderHandle, thumbRel);
            if (file) {
              revoked = URL.createObjectURL(file);
              setThumbnailUrl(revoked);
            }
          } else if (asset.manifestPath) {
            // server mode: artifacts are relative to the manifest folder
            const base = asset.manifestPath.replace(/\/asset\.wmx\.json$/, '/');
            setThumbnailUrl(base + thumbRel);
          }
        }

        const statsRel = fullManifest.artifacts?.stats;
        if (statsRel) {
          if (asset.folderHandle) {
            const file = await getFileByRelativePath(asset.folderHandle, statsRel);
            if (file) setStatsText(await file.text());
          } else if (asset.manifestPath) {
            const base = asset.manifestPath.replace(/\/asset\.wmx\.json$/, '/');
            const res = await fetch(base + statsRel);
            if (res.ok) setStatsText(await res.text());
          }
        }
      } catch (e: any) {
        setArtifactError(e?.message ?? String(e));
      }
    })();

    return () => {
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [asset, fullManifest]);

  const streaming = ((fullManifest as any).streaming ?? (fullManifest.extras as any)?.streaming) as any;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <div style={styles.sectionTitle}>{asset.name}</div>
          <div style={styles.monoSmall}>assetId: {fullManifest.assetId}</div>
          <div style={styles.monoSmall}>manifest: {asset.manifestPath}</div>
        </div>
      </div>

      {manifestError ? (
        <div style={styles.banner}>
          <div style={{ fontWeight: 700 }}>Manifest error</div>
          <div style={{ whiteSpace: 'pre-wrap' }}>{manifestError}</div>
        </div>
      ) : null}

      {artifactError ? (
        <div style={styles.banner}>
          <div style={{ fontWeight: 700 }}>Artifacts error</div>
          <div style={{ whiteSpace: 'pre-wrap' }}>{artifactError}</div>
        </div>
      ) : null}

      <div style={styles.grid}>
        <div style={styles.card}>
          <div style={styles.cardTitle}>Thumbnail</div>
          {thumbnailUrl && !thumbnailLoadError ? (
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            <img
              src={thumbnailUrl}
              style={{ width: '100%', borderRadius: 12 }}
              alt="thumbnail"
              onError={() => setThumbnailLoadError(true)}
            />
          ) : (
            <div style={styles.smallText}>
              {thumbnailLoadError ? 'Thumbnail failed to load (file missing or invalid).' : 'No thumbnail found (or not generated).'}
            </div>
          )}
        </div>

        <div style={styles.card}>
          <div style={styles.cardTitle}>Variants</div>
          <VariantTable manifest={fullManifest} />
        </div>
      </div>

      {asset.manifestPath && asset.manifestPath.startsWith('/wmx/') ? (
        <div style={styles.card}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div style={styles.cardTitle}>Preview</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: '#51607a' }}>
                retention
                <select value={retention} onChange={(e) => setRetention(e.target.value as any)}>
                  <option value="cache">cache (hide when culled)</option>
                  <option value="dispose">dispose (remove when culled)</option>
                </select>
              </label>
              {retention === 'dispose' ? (
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: '#51607a' }}>
                  dispose frames
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={disposeFrames}
                    onChange={(e) => setDisposeFrames(Math.max(0, Number(e.target.value || 0)))}
                    style={{ width: 90 }}
                  />
                </label>
              ) : null}
            </div>
          </div>
          <WMXAutoViewer
            manifestUrl={asset.manifestPath}
            debug
            stats
            renderer="webgpu"
            occlusion={{ enabled: true, maxQueriesPerFrame: 64, occludedFramesToHide: 6 }}
            streaming={{ retention, disposeOutOfFrustumFrames: disposeFrames }}
          />
        </div>
      ) : (
        <div style={styles.card}>
          <div style={styles.cardTitle}>Preview</div>
          <div style={styles.smallText}>Three.js preview is available in server mode (assets served under `/wmx/`).</div>
        </div>
      )}

      {streaming?.schema ? (
        <div style={styles.card}>
          <div style={styles.cardTitle}>Streaming</div>
          <div style={styles.smallText}>
            schema: <span style={styles.tdMono}>{String(streaming.schema)}</span>
          </div>
          <div style={styles.smallText}>
            rootTileId: <span style={styles.tdMono}>{String(streaming.rootTileId ?? '')}</span>
          </div>
          <div style={styles.smallText}>
            tiles: <span style={styles.tdMono}>{String(Object.keys(streaming.tiles ?? {}).length)}</span>
          </div>
          <div style={{ height: 10 }} />
          <pre style={styles.pre}>{JSON.stringify(streaming, null, 2)}</pre>
        </div>
      ) : (
        <div style={styles.card}>
          <div style={styles.cardTitle}>Streaming</div>
          <div style={styles.smallText}>No `streaming` block found in this manifest.</div>
        </div>
      )}

      <div style={styles.card}>
        <div style={styles.cardTitle}>Stats JSON</div>
        {statsText ? (
          <pre style={styles.pre}>{statsText}</pre>
        ) : (
          <div style={styles.smallText}>No stats found (or not generated).</div>
        )}
      </div>

      <div style={styles.card}>
        <div style={styles.cardTitle}>Manifest JSON</div>
        <pre style={styles.pre}>{JSON.stringify(fullManifest, null, 2)}</pre>
      </div>
    </div>
  );
}

function VariantTable({ manifest }: { manifest: WMXManifestV1 }) {
  const order = ['ultraLow', 'low', 'medium', 'high'] as const;
  const rows = order
    .map((q) => ({ q, v: (manifest.variants as any)[q] }))
    .filter((r) => r.v);

  return (
    <table style={styles.table}>
      <thead>
        <tr>
          <th style={styles.th}>quality</th>
          <th style={styles.th}>url</th>
          <th style={styles.th}>bytes</th>
          <th style={styles.th}>triangles</th>
          <th style={styles.th}>textures</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ q, v }) => (
          <tr key={q}>
            <td style={styles.tdMono}>{q === 'ultraLow' ? 'ultra-low' : q}</td>
            <td style={styles.tdMono}>{v.url}</td>
            <td style={styles.tdMono}>{typeof v.bytes === 'number' ? v.bytes.toLocaleString() : '-'}</td>
            <td style={styles.tdMono}>{typeof v.metrics?.triangles === 'number' ? v.metrics.triangles.toLocaleString() : '-'}</td>
            <td style={styles.tdMono}>{typeof v.metrics?.textures === 'number' ? v.metrics.textures.toLocaleString() : '-'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

async function scanForManifests(root: FileSystemDirectoryHandle): Promise<AssetEntry[]> {
  const results: AssetEntry[] = [];
  await walk(root, '', async (dirHandle, relDirPath) => {
    for await (const [name, handle] of dirHandle.entries()) {
      if (handle.kind === 'file' && name.endsWith('.wmx.json')) {
        const file = await handle.getFile();
        const text = await file.text();
        const json = JSON.parse(text) as unknown;
        if (!isWMXManifestV1(json)) continue;
        const manifest = json as WMXManifestV1;

        const manifestPath = joinRel(relDirPath, name);
        results.push({
          id: manifest.assetId,
          name: manifest.name ?? name.replace(/\.wmx\.json$/, ''),
          manifestPath,
          manifest,
          folderHandle: root
        });
      }
    }
  });

  // stable ordering for UX
  results.sort((a, b) => a.name.localeCompare(b.name));
  return results;
}

async function walk(
  dir: FileSystemDirectoryHandle,
  relDir: string,
  visitor: (dir: FileSystemDirectoryHandle, relDir: string) => Promise<void>
): Promise<void> {
  await visitor(dir, relDir);
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === 'directory') {
      await walk(handle, joinRel(relDir, name), visitor);
    }
  }
}

function joinRel(a: string, b: string) {
  if (!a) return b;
  return `${a}/${b}`;
}

function supportsDirectoryPicker(): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return typeof (window as any).showDirectoryPicker === 'function';
}

async function getFileByRelativePath(
  root: FileSystemDirectoryHandle,
  relPath: string
): Promise<File | null> {
  const parts = relPath.split('/').filter(Boolean);
  let dir: FileSystemDirectoryHandle = root;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const isLast = i === parts.length - 1;
    if (isLast) {
      try {
        const fh = await dir.getFileHandle(part);
        return await fh.getFile();
      } catch {
        return null;
      }
    } else {
      try {
        dir = await dir.getDirectoryHandle(part);
      } catch {
        return null;
      }
    }
  }
  return null;
}

const styles: Record<string, React.CSSProperties> = {
  shell: {
    fontFamily:
      'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"',
    color: '#0b1220',
    background: '#f7f8fb',
    minHeight: '100vh'
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 16,
    alignItems: 'center',
    padding: 16,
    borderBottom: '1px solid rgba(0,0,0,0.08)',
    background: '#ffffff'
  },
  title: { fontSize: 18, fontWeight: 800 },
  subtitle: { fontSize: 12, color: '#51607a' },
  body: { display: 'grid', gridTemplateColumns: '320px 1fr', gap: 16, padding: 16 },
  sidebar: {
    background: '#ffffff',
    border: '1px solid rgba(0,0,0,0.08)',
    borderRadius: 16,
    padding: 12,
    height: 'calc(100vh - 96px)',
    overflow: 'auto'
  },
  main: {
    background: '#ffffff',
    border: '1px solid rgba(0,0,0,0.08)',
    borderRadius: 16,
    padding: 16,
    minHeight: 'calc(100vh - 96px)',
    overflow: 'auto'
  },
  sectionTitle: { fontSize: 14, fontWeight: 800, marginBottom: 8 },
  assetList: { display: 'flex', flexDirection: 'column', gap: 8 },
  assetRow: {
    textAlign: 'left',
    padding: 10,
    borderRadius: 12,
    border: '1px solid rgba(0,0,0,0.08)',
    background: '#ffffff',
    cursor: 'pointer'
  },
  assetRowActive: {
    border: '1px solid rgba(43, 99, 255, 0.4)',
    background: 'rgba(43, 99, 255, 0.06)'
  },
  button: {
    borderRadius: 12,
    padding: '10px 12px',
    border: '1px solid rgba(0,0,0,0.12)',
    background: '#0b1220',
    color: '#ffffff',
    cursor: 'pointer',
    fontWeight: 700
  },
  smallText: { fontSize: 12, color: '#51607a' },
  monoSmall: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', fontSize: 11, color: '#51607a' },
  banner: {
    margin: 16,
    padding: 12,
    borderRadius: 12,
    border: '1px solid rgba(0,0,0,0.10)',
    background: '#fff6e5'
  },
  grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 },
  card: {
    border: '1px solid rgba(0,0,0,0.08)',
    borderRadius: 16,
    padding: 12,
    background: '#ffffff'
  },
  cardTitle: { fontSize: 12, fontWeight: 800, color: '#51607a', marginBottom: 8, textTransform: 'uppercase' },
  pre: {
    margin: 0,
    padding: 12,
    borderRadius: 12,
    background: '#0b1220',
    color: '#eaf0ff',
    overflow: 'auto',
    fontSize: 12
  },
  fileInput: {
    fontSize: 12
  },
  table: { width: '100%', borderCollapse: 'collapse' },
  th: { textAlign: 'left', fontSize: 12, color: '#51607a', borderBottom: '1px solid rgba(0,0,0,0.08)', padding: '6px 0' },
  tdMono: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    fontSize: 12,
    padding: '6px 0',
    borderBottom: '1px solid rgba(0,0,0,0.06)'
  }
};

