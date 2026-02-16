import React, { useEffect, useMemo, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { WMXModel, WMXStreamingTileset } from '@worldmatrix/wmx-r3f';
import { makeDemoManifestDataUrl } from './demoAsset';

export function App() {
  const [quality, setQuality] = useState<'low' | 'medium' | 'high'>('medium');
  const [mode, setMode] = useState<'auto' | 'static' | 'streaming'>(() => {
    const m = getSearchParam('mode');
    if (m === 'auto' || m === 'static' || m === 'streaming') return m;
    return getSearchParam('streaming') === '1' ? 'streaming' : 'auto';
  });
  const [assetName, setAssetName] = useState(() => getSearchParam('asset') ?? '');
  const [sampleAssets, setSampleAssets] = useState<Array<{ id: string; name: string; manifestUrl: string }> | null>(null);
  const [sampleId, setSampleId] = useState(() => getSearchParam('sample') ?? '');
  const [streamingDetected, setStreamingDetected] = useState<boolean>(false);
  const [fallbackToEmbedded, setFallbackToEmbedded] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Load bundled sample index (generated into `public/wmx-samples/index.json`).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/wmx-samples/index.json', { headers: { Accept: 'application/json' } });
        if (!res.ok) return;
        const json = (await res.json()) as { assets?: Array<{ id: string; name: string; manifestUrl: string }> };
        const assets = Array.isArray(json.assets) ? json.assets : [];
        if (!cancelled) setSampleAssets(assets);
      } catch {
        // ignore; demo can still run without samples
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // If no explicit selection provided, default to first sample asset (when available).
  useEffect(() => {
    const hasLocal = !!getSearchParam('asset');
    if (hasLocal) return;
    if (!sampleAssets || sampleAssets.length === 0) return;
    if (sampleId) return;
    const first = sampleAssets[0]!.id;
    setSampleId(first);
    setSearchParam('sample', first);
  }, [sampleAssets, sampleId]);

  const manifestUrl = useMemo(() => {
    const local = getSearchParam('asset');
    if (local) return `/wmx/${encodeURIComponent(local)}/asset.wmx.json`;
    if (sampleId) return `/wmx-samples/${encodeURIComponent(sampleId)}/asset.wmx.json`;
    return `/wmx-bundled/asset.wmx.json`;
  }, [sampleId]);

  const activeManifestUrl = fallbackToEmbedded ? makeDemoManifestDataUrl() : manifestUrl;
  const resolvedMode: 'static' | 'streaming' = useMemo(() => {
    if (activeManifestUrl.startsWith('data:')) return 'static';
    if (mode === 'streaming') return 'streaming';
    if (mode === 'static') return 'static';
    return streamingDetected ? 'streaming' : 'static';
  }, [activeManifestUrl, mode, streamingDetected]);

  useEffect(() => {
    let cancelled = false;
    setStreamingDetected(false);
    setFallbackToEmbedded(false);
    setError(null);
    if (manifestUrl.startsWith('data:')) return;
    (async () => {
      try {
        const res = await fetch(manifestUrl, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`Manifest fetch failed (${res.status})`);
        const json = (await res.json()) as any;
        const ok =
          json?.streaming?.schema === 'wmx-streaming-refine-tree@1' ||
          json?.extras?.streaming?.schema === 'wmx-streaming-refine-tree@1';
        if (!cancelled) setStreamingDetected(ok);
      } catch {
        if (!cancelled) setStreamingDetected(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [manifestUrl]);

  useEffect(() => {
    (window as any).__WMX_DEMO__ = {
      manifestUrl: activeManifestUrl,
      mode: resolvedMode,
      quality,
      error,
      fallbackToEmbedded
    };
  }, [activeManifestUrl, resolvedMode, quality, error, fallbackToEmbedded]);

  const onStaticLoadError = (e: unknown) => {
    const message = e instanceof Error ? e.message : String(e);
    if (!fallbackToEmbedded && manifestUrl.startsWith('/wmx-bundled/')) {
      setFallbackToEmbedded(true);
      setError(`Failed to load bundled WMX asset. Showing embedded fallback.\n\n${message}`);
      return;
    }
    setError(message);
  };

  return (
    <div style={styles.shell}>
      <header style={styles.header}>
        <div>
          <div style={styles.title}>WorldMatrix + R3F demo</div>
          <div style={styles.subtitle}>
            Uses <span style={styles.mono}>@worldmatrix/wmx-r3f</span> (
            <span style={styles.mono}>WMXModel</span> / <span style={styles.mono}>WMXStreamingTileset</span>) with
            auto/static/streaming mode selection.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={styles.label}>mode</span>
          {(['auto', 'static', 'streaming'] as const).map((m) => (
            <button
              key={m}
              onClick={() => {
                setMode(m);
                setSearchParam('mode', m);
                setSearchParam('streaming', m === 'streaming' ? '1' : null);
              }}
              style={{
                ...styles.button,
                ...(m === mode ? styles.buttonActive : {})
              }}
            >
              {m}
            </button>
          ))}
          <span style={styles.label}>quality</span>
          {(['low', 'medium', 'high'] as const).map((q) => (
            <button
              key={q}
              onClick={() => setQuality(q)}
              style={{
                ...styles.button,
                ...(q === quality ? styles.buttonActive : {})
              }}
            >
              {q}
            </button>
          ))}
        </div>
      </header>

      <div style={styles.body}>
        <div style={styles.canvasWrap}>
          <Canvas camera={{ position: [1.6, 1.6, 1.6], fov: 50 }}>
            <ambientLight intensity={0.7} />
            <directionalLight position={[2, 3, 4]} intensity={1.2} />
            <React.Suspense fallback={null}>
              {resolvedMode === 'streaming' ? (
                <WMXStreamingTileset manifestUrl={activeManifestUrl} retention="cache" disposeOutOfFrustumFrames={30} />
              ) : (
                <StaticModelWithFallback manifestUrl={activeManifestUrl} quality={quality} onError={onStaticLoadError} />
              )}
            </React.Suspense>
            <OrbitControls makeDefault />
            <gridHelper args={[10, 10]} />
            <axesHelper args={[2]} />
          </Canvas>
        </div>

        <aside style={styles.sidebar}>
          <div style={styles.sectionTitle}>Status</div>
          <div style={styles.p}>
            Open DevTools console for details. Runtime state is on <span style={styles.mono}>window.__WMX_DEMO__</span>.
          </div>
          <div style={styles.p}>
            mode: <span style={styles.mono}>{resolvedMode}</span>
            <br />
            detected streaming: <span style={styles.mono}>{String(streamingDetected)}</span>
            <br />
            fallback embedded: <span style={styles.mono}>{String(fallbackToEmbedded)}</span>
            {error ? (
              <>
                <br />
                last error: <span style={styles.mono}>{error}</span>
              </>
            ) : null}
          </div>

          <div style={styles.sectionTitle}>Bundled sample assets</div>
          {sampleAssets && sampleAssets.length > 0 ? (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
              <select
                value={sampleId}
                onChange={(e) => {
                  const next = e.target.value;
                  setSampleId(next);
                  setSearchParam('sample', next);
                  // Clear local mode if present.
                  setSearchParam('asset', null);
                  setAssetName('');
                }}
                style={styles.select}
              >
                {sampleAssets.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div style={styles.p}>No bundled samples found yet. Generate them into `public/wmx-samples/`.</div>
          )}

          <div style={styles.sectionTitle}>Load a real local asset</div>
          <div style={styles.p}>
            Start the dev server with:
            <br />
            <span style={styles.mono}>
              WMX_ASSETS_DIR=/abs/path/to/setup-assets-... npm run dev -w examples/r3f-demo
            </span>
            <br />
            Then load an asset folder name (e.g. <span style={styles.mono}>stream-deck</span>).
            <br />
            Current WMX_ASSETS_DIR: <span style={styles.mono}>{__WMX_ASSETS_DIR__ || '(not set)'}</span>
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
            <input
              value={assetName}
              onChange={(e) => setAssetName(e.target.value)}
              placeholder="asset folder name (e.g. stream-deck)"
              style={styles.input}
            />
            <button
              style={styles.button}
              onClick={() => {
                const next = assetName.trim();
                if (next) {
                  setSearchParam('asset', next);
                  setSearchParam('sample', null);
                  window.location.reload();
                } else {
                  setSearchParam('asset', null);
                  window.location.reload();
                }
              }}
            >
              Load
            </button>
          </div>

          <div style={styles.sectionTitle}>How this works</div>
          <div style={styles.p}>
            - `WMXModel` loads static variants via `@worldmatrix/wmx-r3f`.
            <br />- `WMXStreamingTileset` loads and updates tiled streaming content.
            <br />- mode `auto` detects `manifest.streaming` from the manifest.
          </div>

          <div style={styles.sectionTitle}>Manifest URL</div>
          <pre style={styles.pre}>{activeManifestUrl}</pre>
        </aside>
      </div>
    </div>
  );
}

function StaticModelWithFallback({
  manifestUrl,
  quality,
  onError
}: {
  manifestUrl: string;
  quality: 'low' | 'medium' | 'high';
  onError: (e: unknown) => void;
}) {
  return (
    <ErrorBoundary onError={onError} key={`${manifestUrl}:${quality}`}>
      <WMXModel manifestUrl={manifestUrl} quality={quality} />
    </ErrorBoundary>
  );
}

class ErrorBoundary extends React.Component<{ onError: (e: unknown) => void; children: React.ReactNode }, { hasError: boolean }> {
  constructor(props: { onError: (e: unknown) => void; children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    this.props.onError(error);
  }

  componentDidUpdate(prevProps: { children: React.ReactNode }) {
    if (prevProps.children !== this.props.children && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }

  render() {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}

function getSearchParam(name: string): string | null {
  try {
    const u = new URL(window.location.href);
    return u.searchParams.get(name);
  } catch {
    return null;
  }
}

function setSearchParam(name: string, value: string | null) {
  try {
    const u = new URL(window.location.href);
    if (value === null || value === '') u.searchParams.delete(name);
    else u.searchParams.set(name, value);
    window.history.replaceState({}, '', u.toString());
  } catch {
    // ignore
  }
}

const styles: Record<string, React.CSSProperties> = {
  shell: {
    fontFamily:
      'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"',
    color: '#0b1220',
    background: '#0b1220',
    minHeight: '100vh'
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 16,
    padding: 16,
    borderBottom: '1px solid rgba(255,255,255,0.08)',
    background: '#0b1220',
    color: '#eaf0ff'
  },
  title: { fontSize: 18, fontWeight: 900 },
  subtitle: { fontSize: 12, opacity: 0.75, marginTop: 4, maxWidth: 720 },
  label: { fontSize: 12, opacity: 0.8 },
  mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' },
  button: {
    borderRadius: 10,
    padding: '8px 10px',
    border: '1px solid rgba(255,255,255,0.14)',
    background: 'rgba(255,255,255,0.06)',
    color: '#eaf0ff',
    cursor: 'pointer',
    fontWeight: 800
  },
  buttonActive: {
    border: '1px solid rgba(43, 99, 255, 0.7)',
    background: 'rgba(43, 99, 255, 0.25)'
  },
  body: {
    display: 'grid',
    gridTemplateColumns: '1fr 420px',
    gap: 16,
    padding: 16
  },
  canvasWrap: {
    borderRadius: 16,
    border: '1px solid rgba(255,255,255,0.08)',
    overflow: 'hidden',
    background: '#0b1220',
    height: 'calc(100vh - 96px)'
  },
  sidebar: {
    borderRadius: 16,
    border: '1px solid rgba(255,255,255,0.08)',
    background: 'rgba(255,255,255,0.04)',
    color: '#eaf0ff',
    padding: 12,
    overflow: 'auto',
    height: 'calc(100vh - 96px)'
  },
  sectionTitle: { fontSize: 12, fontWeight: 900, textTransform: 'uppercase', opacity: 0.85, marginBottom: 8 },
  p: { fontSize: 12, opacity: 0.85, lineHeight: 1.6, marginBottom: 12 },
  input: {
    flex: 1,
    borderRadius: 10,
    padding: '10px 10px',
    border: '1px solid rgba(255,255,255,0.14)',
    background: 'rgba(255,255,255,0.06)',
    color: '#eaf0ff',
    outline: 'none'
  },
  select: {
    flex: 1,
    borderRadius: 10,
    padding: '10px 10px',
    border: '1px solid rgba(255,255,255,0.14)',
    background: 'rgba(255,255,255,0.06)',
    color: '#eaf0ff',
    outline: 'none'
  },
  pre: {
    margin: 0,
    padding: 10,
    borderRadius: 12,
    background: '#060a12',
    border: '1px solid rgba(255,255,255,0.08)',
    color: '#eaf0ff',
    fontSize: 10,
    overflow: 'auto',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all'
  }
};

