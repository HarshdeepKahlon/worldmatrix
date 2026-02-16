import React from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import type { WMXQuality } from '@worldmatrix/wmx-core';
import { createWMXLoaders } from './createWMXLoaders.js';

export type WMXViewerProps = {
  manifestUrl: string;
  quality?: WMXQuality;
  onQualityChange?: (quality: WMXQuality) => void;
  defaultQuality?: WMXQuality;
  debug?: boolean;
  /** Shows a Stats.js overlay (FPS/MS/MB). */
  stats?: boolean;
  /**
   * When enabled (or when `debug` is true), renders per-node bounding boxes as a debug overlay.
   * Boxes are colored according to the currently loaded quality.
   */
  debugBBoxes?: boolean;
  /**
   * Occlusion culling controls (streaming mode only).
   * Uses three.js occlusion queries when supported by the active renderer backend.
   */
  occlusion?: Partial<{
    enabled: boolean;
    /** Maximum occlusion queries scheduled per frame. */
    maxQueriesPerFrame: number;
    /** Consecutive occluded frames before hiding a tile. */
    occludedFramesToHide: number;
  }>;
  /**
   * Streaming runtime controls (streaming mode only).
   */
  streaming?: Partial<{
    retention: 'cache' | 'dispose';
    disposeOutOfFrustumFrames: number;
  }>;
  /**
   * Rendering backend to use.
   * - `webgl`: Always use WebGLRenderer (default, most compatible).
   * - `webgpu`: Always try WebGPURenderer (falls back to WebGL if init fails).
   * - `auto`: Use WebGPURenderer when `navigator.gpu` is available, else WebGL.
   */
  renderer?: 'webgl' | 'webgpu' | 'auto';
  basisTranscoderPath?: string;
  dracoDecoderPath?: string;
  background?: string;
};

export function WMXViewer(props: WMXViewerProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const [status, setStatus] = React.useState<string>('Idle');
  const [internalQuality, setInternalQuality] = React.useState<WMXQuality>(props.defaultQuality ?? 'medium');

  const effectiveQuality = props.quality ?? internalQuality;
  const qualityColor = qualityToColor(effectiveQuality);
  const qualityLabel = effectiveQuality === 'ultraLow' ? 'ultra-low' : effectiveQuality;
  const [showBBoxes, setShowBBoxes] = React.useState<boolean>(() => !!(props.debug || props.debugBBoxes));
  const showBBoxesRef = React.useRef<boolean>(showBBoxes);
  const bboxApiRef = React.useRef<null | { clear: () => void; rebuildIfPossible: () => void }>(null);
  const [triangles, setTriangles] = React.useState<number | null>(null);

  React.useEffect(() => {
    showBBoxesRef.current = showBBoxes;
  }, [showBBoxes]);

  React.useEffect(() => {
    // If the host provides a defaultQuality later, honor it (uncontrolled mode only).
    if (props.quality !== undefined) return;
    if (props.defaultQuality) setInternalQuality(props.defaultQuality);
  }, [props.defaultQuality, props.quality]);

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
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 10_000);
    camera.position.set(2, 1.2, 2);

    const hemi = new THREE.HemisphereLight(0xffffff, 0x334455, 0.9);
    scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 0.9);
    dir.position.set(5, 8, 3);
    scene.add(dir);

    const contentRoot = new THREE.Group();
    scene.add(contentRoot);

    const bboxRoot = new THREE.Group();
    bboxRoot.name = 'wmx-bboxes';
    scene.add(bboxRoot);

    type BBoxEntry = { node: THREE.Object3D; box: THREE.Box3; helper: THREE.Box3Helper };
    const bboxEntries: BBoxEntry[] = [];
    const bboxBox = new THREE.Box3();
    let lastSceneObj: THREE.Object3D | null = null;
    const countTriangles = (root: THREE.Object3D): number => {
      let tris = 0;
      root.traverse((o: any) => {
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
      for (const c of [...bboxRoot.children]) {
        bboxRoot.remove(c);
        try {
          disposeObject(c);
        } catch {
          // ignore
        }
      }
      bboxEntries.length = 0;
    };

    const rebuildBBoxes = (sceneObj: THREE.Object3D) => {
      clearBBoxes();
      // For each node that directly contains renderable geometry, show a bbox.
      sceneObj.traverse((n) => {
        const hasGeometry = !!(n as any).isMesh || !!(n as any).isSkinnedMesh;
        if (!hasGeometry) return;
        const box = new THREE.Box3();
        const helper = new THREE.Box3Helper(box, new THREE.Color(qualityColor));
        helper.renderOrder = 9_999;
        bboxRoot.add(helper);
        bboxEntries.push({ node: n, box, helper });
      });
      if (bboxEntries.length === 0) {
        // Fallback: show one bbox for whole object.
        const box = new THREE.Box3();
        const helper = new THREE.Box3Helper(box, new THREE.Color(qualityColor));
        helper.renderOrder = 9_999;
        bboxRoot.add(helper);
        bboxEntries.push({ node: sceneObj, box, helper });
      }
    };

    const updateBBoxes = () => {
      if (!showBBoxesRef.current) {
        // Ensure boxes are fully removed when toggled off.
        if (bboxRoot.children.length) bboxApiRef.current?.clear();
        return;
      }
      bboxRoot.visible = true;
      const col = new THREE.Color(qualityColor);
      // Throttle-ish: compute boxes, but keep it simple for now.
      for (const e of bboxEntries) {
        // Compute bbox for this node subtree.
        e.box.setFromObject(e.node);
        if (!e.box.isEmpty()) {
          (e.helper.material as any).color?.copy?.(col);
        }
      }
      // Ensure helpers update their geometry.
      bboxBox.setFromObject(bboxRoot);
    };

    bboxApiRef.current = {
      clear: () => {
        bboxRoot.visible = false;
        clearBBoxes();
      },
      rebuildIfPossible: () => {
        if (lastSceneObj) rebuildBBoxes(lastSceneObj);
      }
    };

    let controls: OrbitControls | null = null;
    let wmxLoader: any | null = null;
    let ktx2Loader: any | null = null;
    let ro: ResizeObserver | null = null;

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
      if (!renderer) return;
      const rect = container.getBoundingClientRect();
      const w = Math.max(1, Math.floor(rect.width));
      const h = Math.max(1, Math.floor(rect.height));
      renderer.setSize?.(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
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

    let raf = 0;
    const animate = () => {
      if (disposed) return;
      controls?.update();
      stats?.begin?.();
      updateBBoxes();
      if (props.debug && lastSceneObj) {
        // Throttle: ~4Hz
        if ((performance.now() | 0) % 250 < 16) {
          try {
            setTriangles(countTriangles(lastSceneObj));
          } catch {
            // ignore
          }
        }
      }
      renderer?.render(scene, camera);
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

        setStatus('Loading WMX…');
        const gltf = await wmxLoader.load(props.manifestUrl, { quality: effectiveQuality });
        if (disposed) return;

        setStatus('Rendering…');
        contentRoot.clear();

        const sceneObj = (gltf as any)?.scene as THREE.Object3D | undefined;
        if (!sceneObj) throw new Error('Loaded GLTF missing .scene');
        contentRoot.add(sceneObj);
        lastSceneObj = sceneObj;
        if (showBBoxesRef.current) rebuildBBoxes(sceneObj);
        try {
          setTriangles(countTriangles(sceneObj));
        } catch {
          // ignore
        }
        fitCameraToObject(sceneObj);
        setStatus('Ready');
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
  }, [props.manifestUrl, effectiveQuality, props.basisTranscoderPath, props.dracoDecoderPath, props.stats, props.renderer]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
        <div style={{ fontWeight: 700 }}>Preview</div>
        <div style={{ fontSize: 12, color: '#51607a', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{status}</div>
      </div>

      {props.debug ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <div
            title={`loaded: ${qualityLabel}`}
            style={{
              width: 10,
              height: 10,
              borderRadius: 999,
              background: qualityColor,
              boxShadow: '0 0 0 1px rgba(0,0,0,0.22)'
            }}
          />
          <div style={{ fontSize: 12, color: '#51607a' }}>variant</div>
          {(['ultraLow', 'low', 'medium', 'high'] as const).map((q) => {
            const active = q === effectiveQuality;
            const label = q === 'ultraLow' ? 'ultra-low' : q;
            return (
              <button
                key={q}
                onClick={() => {
                  props.onQualityChange?.(q);
                  if (props.quality === undefined) setInternalQuality(q);
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
                else bboxApiRef.current?.rebuildIfPossible();
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
            title="Toggle per-node bounding boxes"
          >
            bboxes
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
  // Matches the dashboard legend.
  if (q === 'ultraLow') return '#ff3b30'; // red
  if (q === 'low') return '#ff9500'; // orange
  if (q === 'medium') return '#ffd60a'; // yellow
  return '#34c759'; // green (high)
}

