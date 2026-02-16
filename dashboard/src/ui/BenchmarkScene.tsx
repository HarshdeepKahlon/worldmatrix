import React from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { WMXQuality } from '@worldmatrix/wmx-core';
import { createWMXLoaders } from '@worldmatrix/wmx-viewer';
import { WMXStreamManager, WMXStreamedTileset } from '@worldmatrix/wmx-three-streaming';

export type BenchmarkAsset = {
  id: string;
  name: string;
  manifestUrl: string;
};

export function BenchmarkScene(props: {
  assets: BenchmarkAsset[];
  renderer?: 'webgl' | 'webgpu';
}) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);

  const [status, setStatus] = React.useState<string>('Idle');
  const [quality, setQuality] = React.useState<WMXQuality | 'auto'>('auto');
  const [spacing, setSpacing] = React.useState<number>(6);
  const [showStats, setShowStats] = React.useState<boolean>(true);
  const [triangles, setTriangles] = React.useState<number | null>(null);
  const [retention, setRetention] = React.useState<'cache' | 'dispose'>('dispose');
  const [disposeOutOfFrustumFrames, setDisposeOutOfFrustumFrames] = React.useState<number>(30);
  const [gizmoMode, setGizmoMode] = React.useState<'translate' | 'rotate' | 'scale'>('translate');

  const assetUrls = React.useMemo(() => props.assets.map((a) => a.manifestUrl), [props.assets]);
  const assetNames = React.useMemo(() => props.assets.map((a) => a.name), [props.assets]);
  const debugLogs = React.useMemo(() => {
    try {
      return new URLSearchParams(window.location.search).has('wmxDebug');
    } catch {
      return false;
    }
  }, []);
  const debugSeqRef = React.useRef<number>(0);

  React.useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    let disposed = false;
    setStatus('Initializing…');

    let renderer: THREE.WebGLRenderer | null = null;
    let stats: any | null = null;
    let statsDom: HTMLElement | null = null;
    let streamManager: WMXStreamManager | null = null;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0b1220');

    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 50_000);
    camera.position.set(10, 8, 12);

    const hemi = new THREE.HemisphereLight(0xffffff, 0x334455, 0.9);
    scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 0.9);
    dir.position.set(8, 12, 6);
    scene.add(dir);

    const grid = new THREE.GridHelper(200, 50, 0x335577, 0x223344);
    (grid.material as any).transparent = true;
    (grid.material as any).opacity = 0.35;
    scene.add(grid);

    const modelsRoot = new THREE.Group();
    modelsRoot.name = 'wmx-benchmark-models';
    scene.add(modelsRoot);

    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    // three.js TransformControls typing can vary across distributions; keep this loosely typed.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tcontrols: any = new (TransformControls as any)(camera, canvas);
    tcontrols.enabled = true;
    tcontrols.setMode(gizmoMode);
    tcontrols.visible = false;
    tcontrols.addEventListener('dragging-changed', (e: any) => {
      controls.enabled = !e.value;
    });
    scene.add(tcontrols);

    const selectionBox = new THREE.Box3Helper(new THREE.Box3(), 0x2b63ff);
    selectionBox.visible = false;
    selectionBox.renderOrder = 9_999;
    scene.add(selectionBox);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    const getWrapper = (obj: THREE.Object3D | null): THREE.Object3D | null => {
      let o: THREE.Object3D | null = obj;
      while (o) {
        if ((o as any).userData?.wmxWrapper === true) return o;
        o = o.parent ?? null;
      }
      return null;
    };

    const setSelected = (wrapper: THREE.Object3D | null) => {
      if (!wrapper) {
        tcontrols.detach();
        tcontrols.visible = false;
        selectionBox.visible = false;
        return;
      }
      tcontrols.attach(wrapper);
      tcontrols.visible = true;
      selectionBox.visible = true;
      selectionBox.box.setFromObject(wrapper);
    };

    const onPointerDown = (ev: PointerEvent) => {
      if (!renderer) return;
      const rect = canvas.getBoundingClientRect();
      const x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      const y = -(((ev.clientY - rect.top) / rect.height) * 2 - 1);
      pointer.set(x, y);
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObject(modelsRoot, true);
      const hit = hits[0]?.object ?? null;
      setSelected(getWrapper(hit));
    };

    canvas.addEventListener('pointerdown', onPointerDown);

    const disposeObject = (o: THREE.Object3D) => {
      o.traverse((n: any) => {
        if (n.geometry?.dispose) n.geometry.dispose();
        const m = n.material;
        if (Array.isArray(m)) m.forEach((mm: any) => mm?.dispose?.());
        else m?.dispose?.();
        // Best-effort texture disposal.
        if (m) {
          for (const k of Object.keys(m)) {
            const v = (m as any)[k];
            if (v?.isTexture && v.dispose) v.dispose();
          }
        }
      });
    };

    const countTriangles = (obj: THREE.Object3D) => {
      let tri = 0;
      obj.traverse((n: any) => {
        const g: THREE.BufferGeometry | undefined = n?.geometry;
        if (!g) return;
        const idx = g.getIndex();
        if (idx) tri += Math.floor(idx.count / 3);
        else {
          const pos = g.getAttribute('position') as any;
          if (pos?.count) tri += Math.floor(pos.count / 3);
        }
      });
      return tri;
    };

    const fitCameraToObject = (obj: THREE.Object3D) => {
      const box = new THREE.Box3().setFromObject(obj);
      if (!Number.isFinite(box.min.x) || !Number.isFinite(box.max.x)) return;
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const radius = Math.max(0.001, size.length() * 0.5);
      const fov = THREE.MathUtils.degToRad(camera.fov);
      const dist = radius / Math.sin(fov / 2);
      const dirVec = new THREE.Vector3(1, 0.6, 1).normalize();
      camera.position.copy(center).addScaledVector(dirVec, dist * 1.1);
      camera.near = Math.max(0.001, dist / 200);
      camera.far = dist * 400;
      camera.updateProjectionMatrix();
      controls.target.copy(center);
      controls.update();
    };

    const resize = () => {
      const w = Math.max(1, container.clientWidth);
      const h = Math.max(1, Math.floor(container.clientWidth * 0.6));
      renderer?.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };

    const ro = new ResizeObserver(() => resize());
    ro.observe(container);

    const isStreamingManifest = async (manifestUrl: string): Promise<boolean> => {
      try {
        if (debugLogs) {
          // eslint-disable-next-line no-console
          console.log('[wmx-benchmark] fetch manifest', { manifestUrl });
        }
        const res = await fetch(manifestUrl, { headers: { Accept: 'application/json' } });
        if (!res.ok) return false;
        const json = (await res.json()) as any;
        return json?.streaming?.schema === 'wmx-streaming-refine-tree@1' || json?.extras?.streaming?.schema === 'wmx-streaming-refine-tree@1';
      } catch {
        return false;
      }
    };

    (async () => {
      try {
        if (debugLogs) {
          // eslint-disable-next-line no-console
          console.log('[wmx-benchmark] debug enabled', { search: window.location.search });
        }
        if (props.renderer === 'webgpu') {
          // For benchmarking we default to WebGL for max compatibility.
          // (We can add WebGPU later if needed.)
        }
        renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
        renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.0;
        renderer.shadowMap.enabled = false;

        resize();

        if (showStats) {
          try {
            const mod: any = await import('three/examples/jsm/libs/stats.module.js');
            const StatsCtor = mod?.default ?? mod?.Stats ?? mod;
            if (StatsCtor) {
              stats = new StatsCtor();
              statsDom = stats.dom as HTMLElement;
              if (statsDom) {
                statsDom.style.position = 'absolute';
                statsDom.style.left = '10px';
                statsDom.style.top = '10px';
                statsDom.style.zIndex = '10';
                container.appendChild(statsDom);
              }
            }
          } catch {
            // ignore
          }
        }

        setStatus(`Loading ${assetUrls.length} asset(s)…`);
        const { wmxLoader } = createWMXLoaders({ renderer });

        // Clear any previous models.
        for (const c of [...modelsRoot.children]) {
          modelsRoot.remove(c);
          try {
            disposeObject(c);
          } catch {
            // ignore
          }
        }
        streamManager = null;

        const count = assetUrls.length;
        const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
        const midX = (cols - 1) / 2;
        const midZ = (Math.max(1, Math.ceil(count / cols)) - 1) / 2;

        const loaded: THREE.Object3D[] = [];
        const streamingFlags = await Promise.all(assetUrls.map((u) => isStreamingManifest(u)));
        const hasStreaming = streamingFlags.some(Boolean);
        if (hasStreaming) {
          if (debugLogs) {
            // eslint-disable-next-line no-console
            console.log('[wmx-benchmark] streaming manager created', { count, hasStreaming });
          }
          streamManager = new WMXStreamManager({
            viewportHeightPx: Math.max(1, container.clientHeight || 1),
            wmxLoader,
            debug: debugLogs,
            retention,
            disposeOutOfFrustumFrames
          } as any);
        }

        for (let i = 0; i < assetUrls.length; i++) {
          if (disposed) return;
          const manifestUrl = assetUrls[i]!;
          const name = assetNames[i] ?? `asset-${i}`;
          const cx = i % cols;
          const cz = Math.floor(i / cols);
          const posX = (cx - midX) * spacing;
          const posZ = (cz - midZ) * spacing;

          const isStreaming = streamingFlags[i] === true;
          if (debugLogs) {
            // eslint-disable-next-line no-console
            console.log('[wmx-benchmark] asset mode', { i, manifestUrl, isStreaming, quality });
          }
          let root: THREE.Object3D;
          const wrapper = new THREE.Group();
          (wrapper as any).userData.wmxWrapper = true;
          wrapper.name = `wmx-wrapper:${name}`;
          wrapper.position.set(posX, 0, posZ);
          modelsRoot.add(wrapper);
          if (isStreaming) {
            setStatus(`Loading streaming tileset (${i + 1}/${assetUrls.length})…`);
            const tileset = await WMXStreamedTileset.fromManifestUrl(manifestUrl);
            if (disposed) return;
            tileset.name = `wmx-bench-stream:${name}`;
            wrapper.add(tileset);
            streamManager?.add(tileset);

            if (quality !== 'auto') {
              for (const id of Object.keys(tileset.tilesById)) tileset.setTileHint(id, { quality: quality as WMXQuality });
            }
            root = tileset;
          } else {
            setStatus(`Loading static model (${i + 1}/${assetUrls.length})…`);
            const q = quality === 'auto' ? 'medium' : (quality as WMXQuality);
            const gltf: any = await wmxLoader.load(manifestUrl, { quality: q });
            if (disposed) return;
            root = (gltf?.scene ?? gltf) as THREE.Object3D;
            root.name = `wmx-bench:${name}`;
            wrapper.add(root);
          }

          // Ground each asset (best effort).
          try {
            const b = new THREE.Box3().setFromObject(root);
            if (Number.isFinite(b.min.y)) wrapper.position.y += -b.min.y;
          } catch {
            // ignore
          }
          loaded.push(wrapper);
        }

        try {
          setTriangles(countTriangles(modelsRoot));
        } catch {
          setTriangles(null);
        }

        fitCameraToObject(modelsRoot);
        setStatus('Ready');

        const animate = () => {
          if (disposed) return;
          controls.update();
          if (tcontrols.visible) {
            try {
              selectionBox.box.setFromObject(tcontrols.object as any);
            } catch {
              // ignore
            }
          }
          try {
            // Make selection robust: update matrices before streaming step.
            modelsRoot.updateMatrixWorld(true);
            streamManager?.update(camera);
          } catch {
            // ignore
          }
          if (debugLogs && streamManager && (++debugSeqRef.current % 120 === 0)) {
            // eslint-disable-next-line no-console
            console.log('[wmx-benchmark] tick', { n: debugSeqRef.current });
          }
          stats?.begin?.();
          renderer?.render(scene, camera);
          stats?.end?.();
          if (streamManager && (performance.now() | 0) % 350 < 16) {
            try {
              setTriangles(countTriangles(modelsRoot));
            } catch {
              // ignore
            }
          }
          requestAnimationFrame(animate);
        };
        animate();
      } catch (e: any) {
        if (!disposed) setStatus(e?.message ?? String(e));
      }
    })();

    return () => {
      disposed = true;
      try {
        canvas.removeEventListener('pointerdown', onPointerDown);
      } catch {
        // ignore
      }
      try {
        ro.disconnect();
      } catch {
        // ignore
      }
      try {
        tcontrols.detach();
        tcontrols.dispose();
      } catch {
        // ignore
      }
      try {
        controls.dispose();
      } catch {
        // ignore
      }
      try {
        for (const c of [...modelsRoot.children]) {
          modelsRoot.remove(c);
          disposeObject(c);
        }
      } catch {
        // ignore
      }
      try {
        renderer?.dispose();
      } catch {
        // ignore
      }
      renderer = null;
      streamManager = null;
      if (statsDom && statsDom.parentElement) statsDom.parentElement.removeChild(statsDom);
      stats = null;
      statsDom = null;
    };
  }, [assetUrls, assetNames, quality, spacing, showStats, props.renderer, retention, disposeOutOfFrustumFrames, gizmoMode]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ fontSize: 12, color: '#51607a', fontWeight: 800, textTransform: 'uppercase' }}>Benchmark scene</div>
          <div style={{ fontSize: 12, color: '#51607a' }}>
            {props.assets.length} model(s){triangles !== null ? ` • ${triangles.toLocaleString()} tris` : ''}
          </div>
          {debugLogs ? (
            <div
              style={{
                fontSize: 11,
                padding: '3px 8px',
                borderRadius: 999,
                border: '1px solid rgba(43, 99, 255, 0.35)',
                background: 'rgba(43, 99, 255, 0.08)',
                color: '#2b63ff',
                fontWeight: 800
              }}
              title="Debug logging enabled via ?wmxDebug=1"
            >
              wmxDebug ON
            </div>
          ) : null}
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: '#51607a' }}>
            quality
            <select value={quality} onChange={(e) => setQuality(e.target.value as any)}>
              <option value="auto">auto</option>
              <option value="ultraLow">ultraLow</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
          </label>
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
                value={disposeOutOfFrustumFrames}
                onChange={(e) => setDisposeOutOfFrustumFrames(Math.max(0, Number(e.target.value || 0)))}
                style={{ width: 90 }}
              />
            </label>
          ) : null}
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: '#51607a' }}>
            spacing
            <input
              type="number"
              min={0.5}
              step={1}
              value={spacing}
              onChange={(e) => setSpacing(Math.max(0.5, Number(e.target.value || 0.5)))}
              style={{ width: 90 }}
            />
          </label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: '#51607a' }}>
            gizmo
            <select value={gizmoMode} onChange={(e) => setGizmoMode(e.target.value as any)}>
              <option value="translate">translate</option>
              <option value="rotate">rotate</option>
              <option value="scale">scale</option>
            </select>
          </label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: '#51607a' }}>
            <input type="checkbox" checked={showStats} onChange={(e) => setShowStats(e.target.checked)} />
            stats
          </label>
        </div>
      </div>

      <div ref={containerRef} style={{ position: 'relative', width: '100%', borderRadius: 12, overflow: 'hidden' }}>
        <canvas ref={canvasRef} style={{ width: '100%', display: 'block' }} />
        <div
          style={{
            position: 'absolute',
            right: 10,
            top: 10,
            padding: '6px 8px',
            borderRadius: 10,
            background: 'rgba(0,0,0,0.45)',
            color: '#eaf0ff',
            fontSize: 12,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
          }}
        >
          {status}
        </div>
      </div>
    </div>
  );
}

