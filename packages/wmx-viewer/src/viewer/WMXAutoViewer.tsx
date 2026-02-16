import React from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import type { WMXQuality } from '@worldmatrix/wmx-core';
import { WMXStreamManager, WMXStreamedTileset } from '@worldmatrix/wmx-three-streaming';

import { createWMXLoaders } from './createWMXLoaders.js';
import { WMXViewer, type WMXViewerProps } from './WMXViewer.js';

export type WMXAutoViewerMode = 'auto' | 'static' | 'streaming';

export type WMXAutoViewerProps = WMXViewerProps & {
  mode?: WMXAutoViewerMode;
};

export function WMXAutoViewer(props: WMXAutoViewerProps) {
  const [detectedStreaming, setDetectedStreaming] = React.useState<boolean | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setDetectedStreaming(null);
    (async () => {
      try {
        const res = await fetch(props.manifestUrl, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`Failed to fetch manifest (${res.status})`);
        const json = (await res.json()) as any;
        const ok = json?.streaming?.schema === 'wmx-streaming-refine-tree@1' || json?.extras?.streaming?.schema === 'wmx-streaming-refine-tree@1';
        if (!cancelled) setDetectedStreaming(ok);
      } catch {
        if (!cancelled) setDetectedStreaming(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.manifestUrl]);

  const mode: WMXAutoViewerMode = props.mode ?? 'auto';
  const resolvedMode: 'static' | 'streaming' =
    mode === 'static' ? 'static' : mode === 'streaming' ? 'streaming' : detectedStreaming ? 'streaming' : 'static';

  if (resolvedMode === 'static') {
    return <WMXViewer {...props} />;
  }

  return <WMXStreamingViewer {...props} />;
}

function WMXStreamingViewer(props: WMXViewerProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const tilesetRef = React.useRef<WMXStreamedTileset | null>(null);
  const hasFitRef = React.useRef<boolean>(false);
  const [status, setStatus] = React.useState<string>('Idle');
  const [internalQuality, setInternalQuality] = React.useState<WMXQuality>(props.defaultQuality ?? 'medium');
  const [override, setOverride] = React.useState<WMXQuality | 'auto'>('auto');
  const [residentDebug, setResidentDebug] = React.useState<Array<{ tileId: string; quality: WMXQuality }>>([]);
  const [occlusionDebug, setOcclusionDebug] = React.useState<
    | {
        supported: boolean;
        queriesPerFrame: number;
        occludedNow: number;
        hiddenTiles: number;
        probesTotal: number;
        probesAabb: number;
        probesSphere: number;
      }
    | null
  >(null);
  const [showBBoxes, setShowBBoxes] = React.useState<boolean>(() => !!(props.debug || props.debugBBoxes));
  const [triangles, setTriangles] = React.useState<number | null>(null);
  const [showOcclusionProbes, setShowOcclusionProbes] = React.useState<boolean>(false);
  const showBBoxesRef = React.useRef<boolean>(showBBoxes);
  const bboxApiRef = React.useRef<null | { clear: () => void }>(null);

  React.useEffect(() => {
    showBBoxesRef.current = showBBoxes;
    if (!showBBoxes) bboxApiRef.current?.clear();
  }, [showBBoxes]);
  const occlusionRef = React.useRef<{
    enabled: boolean;
    maxQueriesPerFrame: number;
    occludedFramesToHide: number;
    lastQueried: Set<string>;
    occludedFrames: Map<string, number>;
    probes: Map<string, THREE.Mesh>;
    lastQueriesPerFrame: number;
    lastOccludedNow: number;
    lastProbeCounts: { total: number; aabb: number; sphere: number };
  }>({
    enabled: true,
    maxQueriesPerFrame: 48,
    occludedFramesToHide: 8,
    lastQueried: new Set(),
    occludedFrames: new Map(),
    probes: new Map(),
    lastQueriesPerFrame: 0,
    lastOccludedNow: 0,
    lastProbeCounts: { total: 0, aabb: 0, sphere: 0 }
  });

  const mergeTileHint = React.useCallback((t: WMXStreamedTileset, tileId: string, patch: Record<string, any>) => {
    const prev = (t.getTileHint(tileId) ?? {}) as any;
    const next: any = { ...prev, ...patch };
    for (const k of Object.keys(next)) {
      if (next[k] === undefined) delete next[k];
    }
    if (Object.keys(next).length === 0) t.setTileHint(tileId, null);
    else t.setTileHint(tileId, next);
  }, []);

  // Keep occlusion defaults in sync with props (streaming mode only).
  React.useEffect(() => {
    const o = occlusionRef.current;
    o.enabled = props.occlusion?.enabled ?? true;
    o.maxQueriesPerFrame = props.occlusion?.maxQueriesPerFrame ?? 48;
    o.occludedFramesToHide = props.occlusion?.occludedFramesToHide ?? 8;
  }, [props.occlusion?.enabled, props.occlusion?.maxQueriesPerFrame, props.occlusion?.occludedFramesToHide]);

  const ensureOcclusionProbe = React.useCallback((t: WMXStreamedTileset, tileId: string) => {
    const o = occlusionRef.current;
    const existing = o.probes.get(tileId);
    if (existing) return existing;
    const tile = t.tilesById[tileId];
    const group = t.groupsById[tileId];
    if (!tile || !group) return null;

    const s = tile.bounds?.sphere;
    if (!s) return null;
    const aabb = (tile.bounds as any)?.aabb as { min: [number, number, number]; max: [number, number, number] } | undefined;

    const geom = aabb ? new THREE.BoxGeometry(1, 1, 1) : new THREE.SphereGeometry(1, 8, 6);
    const mat = new THREE.MeshBasicMaterial();
    // Default: render to depth only (no color). In debug we can flip these on.
    (mat as any).colorWrite = false;
    mat.depthWrite = false;
    mat.depthTest = true;
    mat.transparent = false;

    const m = new THREE.Mesh(geom, mat);
    m.name = `wmx-occlusion:${tileId}`;
    if (aabb) {
      const cx = (aabb.min[0] + aabb.max[0]) / 2;
      const cy = (aabb.min[1] + aabb.max[1]) / 2;
      const cz = (aabb.min[2] + aabb.max[2]) / 2;
      const sx = Math.max(1e-6, aabb.max[0] - aabb.min[0]);
      const sy = Math.max(1e-6, aabb.max[1] - aabb.min[1]);
      const sz = Math.max(1e-6, aabb.max[2] - aabb.min[2]);
      m.position.set(cx, cy, cz);
      m.scale.set(sx, sy, sz);
      (m as any).userData = { ...(m as any).userData, wmxProbeShape: 'aabb' };
    } else {
      m.position.set(s.center[0], s.center[1], s.center[2]);
      m.scale.setScalar(Math.max(1e-6, s.radius));
      (m as any).userData = { ...(m as any).userData, wmxProbeShape: 'sphere' };
    }
    m.frustumCulled = false;
    // Make sure probes render late, after scene depth is populated.
    m.renderOrder = 10_000;
    // Enable/disable per frame.
    (m as any).occlusionTest = false;

    group.add(m);
    o.probes.set(tileId, m);
    return m;
  }, []);

  const computeTightTileBox = React.useCallback((t: WMXStreamedTileset, tileId: string): THREE.Box3 | null => {
    const g = t.groupsById[tileId];
    if (!g) return null;
    const box = new THREE.Box3();
    box.makeEmpty();
    for (const c of g.children) {
      const name = (c as any).name as string | undefined;
      if (name?.startsWith?.('wmx-tile:')) continue;
      if (name?.startsWith?.('wmx-occlusion:')) continue;
      box.expandByObject(c);
    }
    return box.isEmpty() ? null : box;
  }, []);

  const applyBoxToProbe = React.useCallback((probe: THREE.Mesh, box: THREE.Box3) => {
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const sx = Math.max(1e-6, size.x);
    const sy = Math.max(1e-6, size.y);
    const sz = Math.max(1e-6, size.z);
    // Upgrade geometry to a box if it isn't already.
    const currentShape = (probe as any).userData?.wmxProbeShape as string | undefined;
    if (currentShape !== 'runtime-aabb') {
      try {
        (probe.geometry as any)?.dispose?.();
      } catch {
        // ignore
      }
      probe.geometry = new THREE.BoxGeometry(1, 1, 1);
      (probe as any).userData = { ...(probe as any).userData, wmxProbeShape: 'runtime-aabb' };
    }
    probe.position.copy(center);
    probe.scale.set(sx, sy, sz);
  }, []);

  // Visualize occlusion probes in debug mode (optional).
  React.useEffect(() => {
    const o = occlusionRef.current;
    for (const p of o.probes.values()) {
      const mat: any = (p as any).material;
      if (!mat) continue;
      if (showOcclusionProbes) {
        mat.colorWrite = true;
        mat.wireframe = true;
        mat.transparent = true;
        mat.opacity = 0.22;
        mat.depthWrite = false;
        mat.depthTest = true;
        mat.color?.set?.('#7c3aed'); // purple
        (p as any).visible = true;
      } else {
        mat.colorWrite = false;
        mat.wireframe = false;
        mat.transparent = false;
        mat.opacity = 1;
        mat.depthWrite = false;
        mat.depthTest = true;
        (p as any).visible = true;
      }
      mat.needsUpdate = true;
    }
  }, [showOcclusionProbes]);

  React.useEffect(() => {
    if (props.quality !== undefined) return;
    if (props.defaultQuality) setInternalQuality(props.defaultQuality);
  }, [props.defaultQuality, props.quality]);

  const applyQualityOverride = React.useCallback((q: WMXQuality | null) => {
    const t = tilesetRef.current;
    if (!t) return;
    for (const id of Object.keys(t.tilesById)) {
      if (!q) t.setTileHint(id, null);
      else t.setTileHint(id, { quality: q });
    }
  }, []);

  React.useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    let disposed = false;
    setStatus('Initializing…');

    let renderer: any | null = null;
    let rendererElement: HTMLCanvasElement = canvas;
    let appendedWebgpuCanvas: HTMLCanvasElement | null = null;

    let stats: any | null = null;
    let statsDom: HTMLElement | null = null;
    (async () => {
      if (!props.stats) return;
      try {
        const mod: any = await import('three/examples/jsm/libs/stats.module.js');
        const StatsCtor = mod?.default ?? mod?.Stats ?? mod;
        if (!StatsCtor) return;
        stats = new StatsCtor();
        statsDom = stats.dom as HTMLElement;
        if (statsDom) {
          statsDom.style.position = 'absolute';
          statsDom.style.left = '10px';
          statsDom.style.top = '10px';
          statsDom.style.zIndex = '10';
          container.appendChild(statsDom);
        }
      } catch {
        // ignore
      }
    })();

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100_000);
    camera.position.set(2, 1.2, 2);

    const hemi = new THREE.HemisphereLight(0xffffff, 0x334455, 0.9);
    scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 0.9);
    dir.position.set(5, 8, 3);
    scene.add(dir);

    const bboxRoot = new THREE.Group();
    bboxRoot.name = 'wmx-bboxes';
    scene.add(bboxRoot);

    const bboxHelpers = new Map<string, THREE.Box3Helper>();
    const countTriangles = (root: THREE.Object3D): number => {
      let tris = 0;
      root.traverse((o: any) => {
        const name = (o as any).name as string | undefined;
        if (name?.startsWith?.('wmx-occlusion:')) return;
        if (name === 'wmx-bboxes') return;
        if (o.isBox3Helper) return;
        if (!o.isMesh && !o.isSkinnedMesh && !o.isInstancedMesh) return;
        const g = o.geometry as THREE.BufferGeometry | undefined;
        if (!g) return;
        const idx = g.getIndex?.();
        const pos = g.getAttribute?.('position');
        const base = idx ? Math.floor(idx.count / 3) : pos ? Math.floor(pos.count / 3) : 0;
        const instances = o.isInstancedMesh ? Math.max(1, o.count ?? o.instanceCount ?? 1) : 1;
        tris += base * instances;
      });
      return tris;
    };
    const bboxBoxes = new Map<string, THREE.Box3>();

    const disposeObject = (obj: THREE.Object3D) => {
      obj.traverse((o: any) => {
        if (o.geometry?.dispose) o.geometry.dispose();
        if (o.material) {
          if (Array.isArray(o.material)) o.material.forEach((m: any) => m?.dispose?.());
          else o.material?.dispose?.();
        }
      });
    };

    const clearBBoxes = () => {
      for (const h of bboxHelpers.values()) {
        h.parent?.remove(h);
        try {
          disposeObject(h);
        } catch {
          // ignore
        }
      }
      bboxHelpers.clear();
      bboxBoxes.clear();
      bboxRoot.visible = false;
    };

    bboxApiRef.current = { clear: clearBBoxes };

    let controls: OrbitControls | null = null;

    let wmxLoader: any | null = null;
    let ktx2Loader: any | null = null;

    const wantsWebGPU =
      (props.renderer ?? 'webgl') === 'webgpu' ||
      ((props.renderer ?? 'webgl') === 'auto' && typeof (navigator as any)?.gpu !== 'undefined');

    const initRenderer = async () => {
      if (!wantsWebGPU) {
        renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
        rendererElement = canvas;
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setClearColor(0x000000, 0);
        return;
      }

      try {
        const mod: any = await import('three/webgpu');
        const WebGPURenderer = mod?.WebGPURenderer ?? mod?.default;
        if (!WebGPURenderer) throw new Error('WebGPURenderer not available');
        renderer = new WebGPURenderer({ antialias: true, alpha: true });
        if (typeof renderer.init === 'function') await renderer.init();

        const dom = renderer.domElement as HTMLCanvasElement | undefined;
        if (!dom) throw new Error('WebGPURenderer missing domElement');
        appendedWebgpuCanvas = dom;
        appendedWebgpuCanvas.style.width = '100%';
        appendedWebgpuCanvas.style.height = '100%';
        appendedWebgpuCanvas.style.display = 'block';
        container.appendChild(appendedWebgpuCanvas);

        canvas.style.display = 'none';
        rendererElement = appendedWebgpuCanvas;
      } catch {
        // Fallback: keep using WebGPU renderer class but force a WebGL2 backend.
        // This preserves `renderer.isOccluded()` support (occlusion queries) in three.js.
        try {
          const mod: any = await import('three/webgpu');
          const WebGPURenderer = mod?.WebGPURenderer ?? mod?.default;
          if (!WebGPURenderer) throw new Error('WebGPURenderer not available');
          renderer = new WebGPURenderer({ antialias: true, alpha: true, forceWebGL: true });
          if (typeof renderer.init === 'function') await renderer.init();

          const dom = renderer.domElement as HTMLCanvasElement | undefined;
          if (!dom) throw new Error('WebGPURenderer missing domElement');
          appendedWebgpuCanvas = dom;
          appendedWebgpuCanvas.style.width = '100%';
          appendedWebgpuCanvas.style.height = '100%';
          appendedWebgpuCanvas.style.display = 'block';
          container.appendChild(appendedWebgpuCanvas);

          canvas.style.display = 'none';
          rendererElement = appendedWebgpuCanvas;
        } catch {
          // Last resort fallback to classic WebGLRenderer.
          renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
          rendererElement = canvas;
          renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
          renderer.setClearColor(0x000000, 0);
        }
      }
    };

    const resize = () => {
      const rect = container.getBoundingClientRect();
      const w = Math.max(1, Math.floor(rect.width));
      const h = Math.max(1, Math.floor(rect.height));
      renderer?.setSize?.(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };

    let ro: ResizeObserver | null = null;

    let raf = 0;
    let tileset: WMXStreamedTileset | null = null;
    let manager: WMXStreamManager | null = null;

    const fitCameraToRoot = (t: WMXStreamedTileset) => {
      const rootId = t.tree.rootTileId;
      const root = t.tilesById[rootId];
      const s = root?.bounds?.sphere;
      if (!s) return;
      const center = new THREE.Vector3(s.center[0], s.center[1], s.center[2]);
      const radius = Math.max(0.001, s.radius);
      const fov = THREE.MathUtils.degToRad(camera.fov);
      const dist = radius / Math.sin(fov / 2);
      const dirVec = new THREE.Vector3(1, 0.6, 1).normalize();
      camera.position.copy(center).addScaledVector(dirVec, dist);
      camera.near = Math.max(0.001, dist / 200);
      camera.far = dist * 200;
      camera.updateProjectionMatrix();
      controls?.target.copy(center);
      controls?.update();
    };

    const fitCameraToObject = (obj: THREE.Object3D) => {
      const box = new THREE.Box3().setFromObject(obj);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());

      const radius = Math.max(0.001, size.length() * 0.5);
      const fov = THREE.MathUtils.degToRad(camera.fov);
      const dist = radius / Math.sin(fov / 2);

      const dirVec = new THREE.Vector3(1, 0.6, 1).normalize();
      camera.position.copy(center).addScaledVector(dirVec, dist);
      camera.near = Math.max(0.001, dist / 200);
      camera.far = dist * 200;
      camera.updateProjectionMatrix();

      controls?.target.copy(center);
      controls?.update();
    };

    const animate = () => {
      if (disposed) return;
      tileset?.updateMatrixWorld(true);
      controls?.update();

      // Apply occlusion results from the previous frame (if supported by the renderer).
      if (tileset && manager && renderer && typeof (renderer as any).isOccluded === 'function' && occlusionRef.current.enabled) {
        const o = occlusionRef.current;
        let occludedNow = 0;
        for (const tileId of o.lastQueried) {
          const probe = o.probes.get(tileId);
          if (!probe) continue;
          const occluded = !!(renderer as any).isOccluded(probe);
          if (occluded) occludedNow++;
          const prev = o.occludedFrames.get(tileId) ?? 0;
          o.occludedFrames.set(tileId, occluded ? prev + 1 : 0);
        }
        o.lastOccludedNow = occludedNow;
        o.lastQueried.clear();

        // Convert consecutive occluded frames into a forceHidden hint.
        for (const [tileId, frames] of o.occludedFrames.entries()) {
          if (tileId === 'root') continue;
          const prevHint: any = tileset.getTileHint(tileId) ?? {};
          if (prevHint.pinned || prevHint.forceVisible) continue;
          const shouldHide = frames >= o.occludedFramesToHide;
          if (!!prevHint.forceHidden !== shouldHide) {
            mergeTileHint(tileset, tileId, { forceHidden: shouldHide ? true : undefined });
          }
        }
      }

      if (manager) manager.update(camera);

      // Streaming bbox debug overlay (per loaded tile, colored by quality).
      if (tileset && manager) {
        if (!showBBoxesRef.current) {
          if (bboxHelpers.size) clearBBoxes();
        } else {
          bboxRoot.visible = true;
          const info = manager.getResidentDebugInfo(tileset);
          const residentIds = new Set(info.map((r) => r.tileId));

          // Remove stale helpers.
          for (const [tileId, h] of bboxHelpers.entries()) {
            if (!residentIds.has(tileId)) {
              h.parent?.remove(h);
              try {
                disposeObject(h);
              } catch {
                // ignore
              }
              bboxHelpers.delete(tileId);
              bboxBoxes.delete(tileId);
            }
          }

          for (const r of info) {
            const tileId = r.tileId;
            const g = tileset.groupsById[tileId];
            if (!g) continue;
            const box = bboxBoxes.get(tileId) ?? new THREE.Box3();
            bboxBoxes.set(tileId, box);
            const helper =
              bboxHelpers.get(tileId) ??
              (() => {
                const hh = new THREE.Box3Helper(box, new THREE.Color(qualityToColor(r.quality)));
                hh.renderOrder = 9_999;
                bboxRoot.add(hh);
                bboxHelpers.set(tileId, hh);
                return hh;
              })();

            // Compute bbox from direct renderable children of this tile group.
            // (Avoid including child tile groups and occlusion probes.)
            box.makeEmpty();
            for (const c of g.children) {
              const name = (c as any).name as string | undefined;
              if (name?.startsWith?.('wmx-tile:')) continue;
              if (name?.startsWith?.('wmx-occlusion:')) continue;
              box.expandByObject(c);
            }
            (helper.material as any).color?.copy?.(new THREE.Color(qualityToColor(r.quality)));
          }
        }
      }

      // Schedule occlusion queries for a subset of currently desired tiles.
      if (tileset && manager && renderer && typeof (renderer as any).isOccluded === 'function' && occlusionRef.current.enabled) {
        const o = occlusionRef.current;
        // Reset all probes first so we only query the bounded picked set.
        for (const p of o.probes.values()) {
          (p as any).occlusionTest = false;
        }
        // In some editor TS setups, workspace package types can lag behind build output.
        // Use a soft call here to keep runtime behavior correct even if types are stale.
        const desired = (((manager as any).getDesiredDebugInfo?.(tileset) ?? []) as Array<{ tileId: string }>);
        const picked = desired
          .map((d: { tileId: string }) => d.tileId)
          .filter((id: string) => id !== 'root')
          .slice(0, o.maxQueriesPerFrame);
        o.lastQueriesPerFrame = picked.length;
        for (const tileId of picked) {
          const probe = ensureOcclusionProbe(tileset, tileId);
          if (!probe) continue;
          // Tighten probe using runtime-derived content bounds when available.
          // This avoids loose manifest bounds causing probes to always be partially visible.
          try {
            const tight = computeTightTileBox(tileset, tileId);
            if (tight) applyBoxToProbe(probe, tight);
          } catch {
            // ignore
          }
          (probe as any).occlusionTest = true;
          o.lastQueried.add(tileId);
        }

        // Track probe shapes for debug.
        let aabb = 0;
        let sphere = 0;
        for (const p of o.probes.values()) {
          const shape = (p as any).userData?.wmxProbeShape;
          if (shape === 'aabb') aabb++;
          else sphere++;
        }
        o.lastProbeCounts = { total: o.probes.size, aabb, sphere };
      }
      if (props.debug && manager && tileset) {
        // Throttle UI updates: ~4Hz.
        if ((performance.now() | 0) % 250 < 16) {
          try {
            const info = manager.getResidentDebugInfo(tileset).map((r) => ({ tileId: r.tileId, quality: r.quality }));
            setResidentDebug(info);
            try {
              setTriangles(countTriangles(tileset));
            } catch {
              // ignore
            }
            const t = tileset;
            const hiddenTiles = Object.keys(t.tilesById)
              .filter((id) => id !== 'root')
              .reduce((acc, id) => acc + ((t.getTileHint(id) as any)?.forceHidden ? 1 : 0), 0);
            const supported = !!(renderer && typeof (renderer as any).isOccluded === 'function');
            setOcclusionDebug({
              supported,
              queriesPerFrame: occlusionRef.current.lastQueriesPerFrame,
              hiddenTiles,
              occludedNow: supported ? occlusionRef.current.lastOccludedNow : 0,
              probesTotal: occlusionRef.current.lastProbeCounts.total,
              probesAabb: occlusionRef.current.lastProbeCounts.aabb,
              probesSphere: occlusionRef.current.lastProbeCounts.sphere
            });
          } catch {
            // ignore
          }
        }
      }
      // Once any streaming content is present, fit camera to the actual rendered bounds.
      // This avoids relying on producer-provided bounds during early v1 iterations.
      if (tileset && !hasFitRef.current) {
        // Heuristic: if any tile group has a direct child that's not another tile group, we have content.
        let hasContent = false;
        for (const g of Object.values(tileset.groupsById)) {
          if (g.children.some((c) => !(c as any).name?.startsWith?.('wmx-tile:'))) {
            hasContent = true;
            break;
          }
        }
        if (hasContent) {
          try {
            fitCameraToObject(tileset);
            hasFitRef.current = true;
          } catch {
            // ignore
          }
        }
      }
      stats?.begin?.();
      renderer?.render?.(scene, camera);
      stats?.end?.();
      raf = window.requestAnimationFrame(animate);
    };

    (async () => {
      try {
        await initRenderer();
        if (disposed) return;

        controls = new OrbitControls(camera, rendererElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.minDistance = 0.05;
        controls.maxDistance = 5000;

        const loaders = createWMXLoaders({
          renderer,
          basisTranscoderPath: props.basisTranscoderPath,
          dracoDecoderPath: props.dracoDecoderPath
        });
        wmxLoader = loaders.wmxLoader;
        ktx2Loader = loaders.ktx2Loader;

        ro = new ResizeObserver(() => resize());
        ro.observe(container);
        resize();

        raf = window.requestAnimationFrame(animate);

        setStatus('Loading streaming tileset…');
        tileset = await WMXStreamedTileset.fromManifestUrl(props.manifestUrl);
        if (disposed) return;
        tilesetRef.current = tileset;
        hasFitRef.current = false;
        scene.add(tileset);

        manager = new WMXStreamManager({
          // WMXStreamManager uses `.gltfLoader.loadAsync()` via `as any` for v1 streaming payloads.
          wmxLoader: wmxLoader as any,
          viewportHeightPx: Math.max(1, container.getBoundingClientRect().height),
          retention: props.streaming?.retention,
          disposeOutOfFrustumFrames: props.streaming?.disposeOutOfFrustumFrames
        } as any);
        manager.add(tileset);

        fitCameraToRoot(tileset);
        setStatus('Ready (streaming)');

        // Apply initial override (if any).
        const q = props.quality ?? (override === 'auto' ? null : override);
        applyQualityOverride(q);
      } catch (e: any) {
        if (disposed) return;
        setStatus(`Error: ${e?.message ?? String(e)}`);
      }
    })();

    return () => {
      disposed = true;
      window.cancelAnimationFrame(raf);
      ro?.disconnect();
      controls?.dispose();
      try {
        ktx2Loader?.dispose?.();
      } catch {
        // ignore
      }
      try {
        renderer?.dispose?.();
      } catch {
        // ignore
      }
      try {
        if (appendedWebgpuCanvas) appendedWebgpuCanvas.remove();
        canvas.style.display = 'block';
      } catch {
        // ignore
      }
      bboxApiRef.current = null;
      if (statsDom && statsDom.parentElement) statsDom.parentElement.removeChild(statsDom);
      stats = null;
      statsDom = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    props.manifestUrl,
    props.basisTranscoderPath,
    props.dracoDecoderPath,
    props.stats,
    applyQualityOverride,
    props.renderer,
    props.streaming?.retention,
    props.streaming?.disposeOutOfFrustumFrames
  ]);

  // Keep overrides updated without rebuilding Three.js.
  React.useEffect(() => {
    // If parent controls `quality`, treat it as a forced override.
    if (props.quality !== undefined) setOverride('auto');
  }, [props.quality]);

  React.useEffect(() => {
    const q = props.quality ?? (override === 'auto' ? null : override);
    applyQualityOverride(q);
  }, [props.quality, override, applyQualityOverride]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
        <div style={{ fontWeight: 700 }}>Preview</div>
        <div style={{ fontSize: 12, color: '#51607a', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{status}</div>
      </div>

      {props.debug ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ fontSize: 12, color: '#51607a' }}>mode</div>
          <div style={{ fontSize: 12, padding: '4px 10px', borderRadius: 999, background: '#0b1220', color: '#fff' }}>streaming</div>
          <div style={{ width: 12 }} />

          <div style={{ fontSize: 12, color: '#51607a' }}>override</div>
          {(['auto', 'ultraLow', 'low', 'medium', 'high'] as const).map((v) => {
            const active = v === override;
            const label = v === 'ultraLow' ? 'ultra-low' : v;
            return (
              <button
                key={v}
                onClick={() => {
                  setOverride(v);
                  if (v !== 'auto') {
                    props.onQualityChange?.(v);
                    if (props.quality === undefined) setInternalQuality(v);
                  }
                }}
                style={{
                  fontSize: 12,
                  padding: '6px 10px',
                  borderRadius: 999,
                  border: '1px solid rgba(0,0,0,0.12)',
                  background: active ? '#0b1220' : '#ffffff',
                  color: active ? '#ffffff' : '#0b1220',
                  cursor: 'pointer'
                }}
              >
                {label}
              </button>
            );
          })}

          <div style={{ width: 12 }} />
          <button
            onClick={() => {
              setShowBBoxes((v) => {
                const next = !v;
                if (!next) bboxApiRef.current?.clear();
                return next;
              });
            }}
            style={{
              fontSize: 12,
              padding: '6px 10px',
              borderRadius: 999,
              border: '1px solid rgba(0,0,0,0.12)',
              background: showBBoxes ? '#0b1220' : '#ffffff',
              color: showBBoxes ? '#ffffff' : '#0b1220',
              cursor: 'pointer'
            }}
            title="Toggle per-tile bounding boxes"
          >
            bboxes
          </button>

          <div style={{ width: 12 }} />
          <div style={{ fontSize: 12, color: '#51607a' }}>loaded</div>
          {residentDebug.length ? (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              {residentDebug.slice(0, 24).map((r) => (
                <div
                  key={r.tileId}
                  title={`${r.tileId} (${r.quality})`}
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 999,
                    background: qualityToColor(r.quality),
                    boxShadow: '0 0 0 1px rgba(0,0,0,0.22)'
                  }}
                />
              ))}
              {residentDebug.length > 24 ? (
                <div style={{ fontSize: 12, color: '#51607a' }}>+{residentDebug.length - 24}</div>
              ) : null}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: '#51607a' }}>none</div>
          )}

          <div style={{ width: 12 }} />
          <div style={{ fontSize: 12, color: '#51607a' }}>occlusion</div>
          {occlusionDebug ? (
            <div style={{ fontSize: 12, color: '#51607a' }}>
              {occlusionDebug.supported ? 'on' : 'off'}{' '}
              q/f:{' '}
              <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace' }}>
                {occlusionDebug.queriesPerFrame}
              </span>{' '}
              occl:{' '}
              <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace' }}>
                {occlusionDebug.occludedNow}
              </span>{' '}
              probes:{' '}
              <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace' }}>
                {occlusionDebug.probesTotal}
              </span>{' '}
              box:{' '}
              <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace' }}>
                {occlusionDebug.probesAabb}
              </span>{' '}
              sph:{' '}
              <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace' }}>
                {occlusionDebug.probesSphere}
              </span>{' '}
              hidden:{' '}
              <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace' }}>
                {occlusionDebug.hiddenTiles}
              </span>
            </div>
          ) : (
            <div style={{ fontSize: 12, color: '#51607a' }}>n/a</div>
          )}
          <button
            onClick={() => setShowOcclusionProbes((v) => !v)}
            style={{
              fontSize: 12,
              padding: '6px 10px',
              borderRadius: 999,
              border: '1px solid rgba(0,0,0,0.12)',
              background: showOcclusionProbes ? '#0b1220' : '#ffffff',
              color: showOcclusionProbes ? '#ffffff' : '#0b1220',
              cursor: 'pointer'
            }}
            title="Toggle occlusion probe visualization (wireframe purple)"
          >
            probes
          </button>

          <div style={{ width: 12 }} />
          <div style={{ fontSize: 12, color: '#51607a' }}>
            tris:{' '}
            <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace' }}>
              {typeof triangles === 'number' ? triangles.toLocaleString() : '…'}
            </span>
          </div>

          <div style={{ flex: 1 }} />
          <div style={{ fontSize: 12, color: '#51607a', maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {props.manifestUrl}
          </div>
        </div>
      ) : null}

      <div
        ref={containerRef}
        style={{
          width: '100%',
          aspectRatio: '16 / 9',
          borderRadius: 12,
          overflow: 'hidden',
          background: props.background ?? '#0b1220',
          position: 'relative'
        }}
      >
        <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
      </div>
    </div>
  );
}

function qualityToColor(q: WMXQuality): string {
  if (q === 'ultraLow') return '#ff3b30'; // red
  if (q === 'low') return '#ff9500'; // orange
  if (q === 'medium') return '#ffd60a'; // yellow
  return '#34c759'; // green
}

