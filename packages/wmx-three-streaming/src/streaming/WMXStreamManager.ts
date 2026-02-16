import * as THREE from 'three';
import type { WMXQuality, WMXVariant } from '@worldmatrix/wmx-core';
import type { GLTF } from '@worldmatrix/wmx-three';
import { WMXLoader } from '@worldmatrix/wmx-three';

import type { WMXStreamingTileV1 } from '../schema.js';
import { disposeObject } from './disposeObject.js';
import { makeMatrixFromTRS, projectedRadiusPx, transformSphere } from './math.js';
import { WMXStreamedTileset } from './WMXStreamedTileset.js';

export type WMXStreamManagerBudgets = {
  /** Approximate GPU/system memory budget for resident content (bytes). */
  maxBytes: number;
};

export type WMXStreamManagerThresholds = {
  /** If projected radius (px) exceeds this, we refine to children. */
  refinePx: number;
  /** If projected radius (px) falls below this, we coarsen back to parent. Must be < refinePx. */
  coarsenPx: number;
  /** Choose quality thresholds (px). */
  highPx: number;
  mediumPx: number;
  /**
   * Threshold to switch from `ultraLow` → `low`.
   * If projected radius is below this, we use `ultraLow` (when available).
   */
  lowPx: number;
};

export type WMXStreamManagerOptions = {
  /** Viewport height in pixels, for SSE proxy. */
  viewportHeightPx: number;
  /** Maximum concurrent network/parse loads. */
  concurrency?: number;
  /** Budgets for eviction. */
  budgets?: Partial<WMXStreamManagerBudgets>;
  /** Selection thresholds. */
  thresholds?: Partial<WMXStreamManagerThresholds>;
  /** Default tile refine mode if omitted. */
  defaultRefine?: 'replace' | 'add';
  /** Enable verbose console logging for debugging thrash/culling/load decisions. */
  debug?: boolean;
  /**
   * Retention policy for tiles that are no longer desired.
   * - `dispose`: remove + dispose (frees memory, may re-download later)
   * - `cache`: keep resident but hidden (avoids re-download thrash; eviction still happens on budget)
   */
  retention?: 'dispose' | 'cache';
  /** Number of consecutive out-of-frustum frames before disposing in `retention=dispose`. */
  disposeOutOfFrustumFrames?: number;

  /** Reuse a preconfigured WMXLoader (recommended). */
  wmxLoader: WMXLoader;
};

type Resident = {
  tileId: string;
  quality: WMXQuality;
  url: string;
  object: THREE.Object3D;
  bytes: number;
  lastUsedFrame: number;
};

type TileRuntimeState = {
  desired: boolean;
  desiredQuality?: WMXQuality;
  refined: boolean;
  /** Frame index when this tile was last marked desired. Used to avoid thrash near frustum edges. */
  lastDesiredFrame?: number;
  /** Frame index when this tile was last observed in frustum. */
  lastInFrustumFrame?: number;
  // Content:
  resident?: Resident;
  loading?: { url: string; abort: AbortController; promise: Promise<Resident> };
  /** Runtime-derived bounds in world space (more reliable than producer bounds in v1). */
  boundsWorld?: { center: THREE.Vector3; radius: number };
  /** Simple cooldown to avoid infinite retry loops on repeated load failures. */
  lastError?: { url: string; frame: number; count: number };
};

export class WMXStreamManager {
  private readonly opts: Required<Pick<WMXStreamManagerOptions, 'viewportHeightPx' | 'concurrency' | 'defaultRefine'>> & {
    wmxLoader: WMXLoader;
    budgets: WMXStreamManagerBudgets;
    thresholds: WMXStreamManagerThresholds;
    debug: boolean;
    retention: 'dispose' | 'cache';
    disposeOutOfFrustumFrames: number;
  };

  private tilesets = new Set<WMXStreamedTileset>();
  private tileState = new WeakMap<WMXStreamedTileset, Map<string, TileRuntimeState>>();
  private frame = 0;

  private residentBytes = 0;
  /** Grace window (frames) before cancelling/unloading tiles after they leave selection. */
  private readonly lingerFrames = 24;

  constructor(options: WMXStreamManagerOptions) {
    this.opts = {
      viewportHeightPx: options.viewportHeightPx,
      concurrency: options.concurrency ?? 6,
      defaultRefine: options.defaultRefine ?? 'replace',
      wmxLoader: options.wmxLoader,
      debug: options.debug ?? false,
      retention: options.retention ?? 'dispose',
      disposeOutOfFrustumFrames: Math.max(0, options.disposeOutOfFrustumFrames ?? 30),
      budgets: {
        maxBytes: options.budgets?.maxBytes ?? 512 * 1024 * 1024
      },
      thresholds: {
        refinePx: options.thresholds?.refinePx ?? 220,
        coarsenPx: options.thresholds?.coarsenPx ?? 160,
        // `ultraLow` should behave like the old "low distance" default.
        // Then we make `low` and `medium` kick in a bit closer.
        highPx: options.thresholds?.highPx ?? 520,
        mediumPx: options.thresholds?.mediumPx ?? 220,
        // Old default: anything below ~180px used to be `low`. Now that's `ultraLow`.
        lowPx: options.thresholds?.lowPx ?? 180
      }
    };
  }

  add(tileset: WMXStreamedTileset) {
    this.tilesets.add(tileset);
    if (!this.tileState.has(tileset)) this.tileState.set(tileset, new Map());
  }

  remove(tileset: WMXStreamedTileset) {
    this.tilesets.delete(tileset);
  }

  update(camera: THREE.Camera) {
    this.frame++;
    if (!(camera as any).isPerspectiveCamera) return;
    const cam = camera as THREE.PerspectiveCamera;
    // Ensure camera matrices are current when used outside renderer.render().
    cam.updateMatrixWorld(true);

    const frustum = new THREE.Frustum();
    const projView = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projView);

    for (const tileset of this.tilesets) {
      // Ensure tileset transforms are current before selection.
      tileset.updateMatrixWorld(true);
      const states = this.ensureTilesetStates(tileset);
      // Mark all as undesired; traversal sets desired.
      for (const s of states.values()) {
        s.desired = false;
        s.desiredQuality = undefined;
      }

      const rootId = tileset.tree.rootTileId;
      const root = tileset.tilesById[rootId];
      if (!root) continue;

      const rootWorld = tileset.groupsById[rootId]?.matrixWorld ?? new THREE.Matrix4();
      // Early out when the whole tileset is out of frustum. This prevents thrash
      // from stale/approximate bounds and makes debug logging clearer.
      const rootHint = tileset.getTileHint(rootId);
      // Prefer runtime-tight bounds when available (prevents "out of scene but still in frustum" due to loose producer bounds).
      const rootState = states.get(rootId);
      const bw = rootState?.boundsWorld;
      const canUseBw = !!bw && Number.isFinite(bw.radius) && bw.radius > 1e-6;
      const rootSphere = canUseBw ? { center: bw!.center, radius: bw!.radius } : transformSphere(root.bounds.sphere, rootWorld);
      const rootInFrustum = rootHint?.forceVisible
        ? true
        : frustum.intersectsSphere(new THREE.Sphere(rootSphere.center, rootSphere.radius));
      if (rootInFrustum && rootState) rootState.lastInFrustumFrame = this.frame;
      if (!rootInFrustum) {
        if (this.opts.debug) {
          // eslint-disable-next-line no-console
          console.log('[wmx-three-streaming] tileset out of frustum', {
            frame: this.frame,
            manifestUrl: tileset.manifestUrl,
            rootId,
            center: [rootSphere.center.x, rootSphere.center.y, rootSphere.center.z],
            radius: rootSphere.radius
          });
        }
        // Still apply load/unload policy below. In dispose mode this may dispose
        // after `disposeOutOfFrustumFrames`.
        this.applyStates(tileset, states, { rootOutOfFrustum: true });
        continue;
      } else if (this.opts.debug && (this.frame % 120 === 0)) {
        // eslint-disable-next-line no-console
        console.log('[wmx-three-streaming] tileset in frustum', {
          frame: this.frame,
          manifestUrl: tileset.manifestUrl,
          rootId
        });
      }
      this.traverseSelect({
        tileset,
        tile: root,
        tileWorld: rootWorld,
        frustum,
        camera: cam,
        states
      });

      // Record desired frames for thrash-resistant unloading.
      for (const s of states.values()) {
        if (s.desired) s.lastDesiredFrame = this.frame;
      }

      // Enact loads/unloads.
      this.applyStates(tileset, states, { rootOutOfFrustum: false });
    }

    this.evictIfOverBudget();
  }

  /**
   * Debug helper: list currently resident tiles with their quality.
   * Safe to call every frame; intended for UI overlays.
   */
  getResidentDebugInfo(tileset: WMXStreamedTileset): Array<{ tileId: string; quality: WMXQuality; url: string; bytes: number }> {
    const states = this.tileState.get(tileset);
    if (!states) return [];
    const out: Array<{ tileId: string; quality: WMXQuality; url: string; bytes: number }> = [];
    for (const [tileId, s] of states.entries()) {
      if (!s.resident) continue;
      out.push({ tileId, quality: s.resident.quality, url: s.resident.url, bytes: s.resident.bytes });
    }
    out.sort((a, b) => a.tileId.localeCompare(b.tileId));
    return out;
  }

  /**
   * Debug/inspection helper: list tiles currently selected as desired this frame.
   * Intended for tools like occlusion-culling overlays.
   */
  getDesiredDebugInfo(tileset: WMXStreamedTileset): Array<{ tileId: string; desiredQuality: WMXQuality }> {
    const states = this.tileState.get(tileset);
    if (!states) return [];
    const out: Array<{ tileId: string; desiredQuality: WMXQuality }> = [];
    for (const [tileId, s] of states.entries()) {
      if (!s.desired || !s.desiredQuality) continue;
      out.push({ tileId, desiredQuality: s.desiredQuality });
    }
    out.sort((a, b) => a.tileId.localeCompare(b.tileId));
    return out;
  }

  private ensureTilesetStates(tileset: WMXStreamedTileset): Map<string, TileRuntimeState> {
    const m = this.tileState.get(tileset);
    if (!m) {
      const created = new Map<string, TileRuntimeState>();
      this.tileState.set(tileset, created);
      return created;
    }
    // Ensure all tiles have state entries.
    for (const id of Object.keys(tileset.tilesById)) {
      if (!m.has(id)) m.set(id, { desired: false, refined: false });
    }
    return m;
  }

  private traverseSelect(params: {
    tileset: WMXStreamedTileset;
    tile: WMXStreamingTileV1;
    tileWorld: THREE.Matrix4;
    frustum: THREE.Frustum;
    camera: THREE.PerspectiveCamera;
    states: Map<string, TileRuntimeState>;
  }) {
    const { tileset, tile, tileWorld, frustum, camera, states } = params;
    const id = tile.id;

    const hint = tileset.getTileHint(id);
    if (hint?.forceHidden) return;

    const existing = states.get(id);
    const bw = existing?.boundsWorld;
    const canUseBw = !!bw && Number.isFinite(bw.radius) && bw.radius > 1e-6;
    const { center, radius } = canUseBw ? { center: bw!.center, radius: bw!.radius } : transformSphere(tile.bounds.sphere, tileWorld);
    const inFrustum = hint?.forceVisible ? true : frustum.intersectsSphere(new THREE.Sphere(center, radius));
    if (!inFrustum) {
      // Not desired, but still traverse if forceVisible? already handled.
      return;
    }

    const px = projectedRadiusPx({
      sphereCenterWorld: center,
      sphereRadiusWorld: radius,
      camera,
      viewportHeightPx: this.opts.viewportHeightPx
    });

    const state = existing ?? { desired: false, refined: false };
    states.set(id, state);
    state.lastInFrustumFrame = this.frame;

    const desiredQuality = hint?.quality ?? chooseQuality(px, this.opts.thresholds);

    const hasChildren = (tile.children?.length ?? 0) > 0;
    const refineMode = tile.refine ?? this.opts.defaultRefine;
    const shouldRefine = hasChildren && px >= this.opts.thresholds.refinePx;
    const shouldCoarsen = hasChildren && px <= this.opts.thresholds.coarsenPx;

    if (shouldRefine) state.refined = true;
    else if (shouldCoarsen) state.refined = false;

    if (!state.refined || !hasChildren) {
      state.desired = true;
      state.desiredQuality = desiredQuality;
      return;
    }

    // Refined: desire children, and (replace) keep parent until children are ready.
    for (const childId of tile.children ?? []) {
      const child = tileset.tilesById[childId];
      if (!child) continue;
      const childLocal = makeMatrixFromTRS(child.transform);
      const childWorld = new THREE.Matrix4().multiplyMatrices(tileWorld, childLocal);
      this.traverseSelect({ tileset, tile: child, tileWorld: childWorld, frustum, camera, states });
    }

    if (refineMode === 'add') {
      state.desired = true;
      state.desiredQuality = desiredQuality;
      return;
    }

    // replace mode: render parent only while children not resident.
    const allChildrenReady = (tile.children ?? []).every((cid) => {
      const cs = states.get(cid);
      return !!cs?.resident;
    });
    if (!allChildrenReady) {
      state.desired = true;
      state.desiredQuality = desiredQuality;
    }
  }

  private applyStates(tileset: WMXStreamedTileset, states: Map<string, TileRuntimeState>, opts: { rootOutOfFrustum: boolean }) {
    // Selection controls visibility; lifetime policy controls disposal.
    // Even in `dispose` mode, non-desired content can remain resident for a while,
    // but should still be hidden immediately.
    for (const s of states.values()) {
      if (s.resident) {
        try {
          s.resident.object.visible = !!s.desired;
        } catch {
          // ignore
        }
      }
    }

    // Start loads for desired tiles.
    const candidates: Array<{ tileId: string; url: string; quality: WMXQuality; bytes: number }> = [];
    for (const [tileId, s] of states.entries()) {
      if (!s.desired || !s.desiredQuality) continue;
      const tile = tileset.tilesById[tileId];
      const pickVariant = (desired: WMXQuality): { variant?: WMXVariant; quality?: WMXQuality } => {
        const c = tile.content;
        if (!c) return {};
        const order: WMXQuality[] =
          desired === 'high'
            ? ['high', 'medium', 'low', 'ultraLow']
            : desired === 'medium'
              ? ['medium', 'low', 'ultraLow']
              : desired === 'low'
                ? ['low', 'ultraLow']
                : ['ultraLow', 'low']; // desired === 'ultraLow'
        for (const q of order) {
          const v = c[q];
          if (v) return { variant: v, quality: q };
        }
        return {};
      };

      const picked = pickVariant(s.desiredQuality);
      const variant = picked.variant;
      if (!variant) continue; // structural tile or missing content
      const url = resolveUrl(variant.url, tileset.manifestUrl);
      const bytes = variant.bytes ?? 0;

      // If already resident with same url, just touch.
      if (s.resident && s.resident.url === url) {
        s.resident.lastUsedFrame = this.frame;
        try {
          s.resident.object.visible = true;
        } catch {
          // ignore
        }
        continue;
      }
      // Avoid hammering the same failing URL every frame.
      if (s.lastError?.url === url) {
        const cooldownFrames = Math.min(600, 30 + s.lastError.count * 30); // 0.5s → 10s @ 60fps
        if (this.frame - s.lastError.frame < cooldownFrames) continue;
      }
      candidates.push({ tileId, url, quality: picked.quality ?? s.desiredQuality, bytes });
    }

    // Respect concurrency.
    const currentlyLoading = countLoading(states);
    const available = Math.max(0, this.opts.concurrency - currentlyLoading);
    for (const c of candidates.slice(0, available)) {
      const s = states.get(c.tileId)!;
      if (s.loading?.url === c.url) continue;
      // Cancel old in-flight request if switching.
      if (s.loading && s.loading.url !== c.url) {
        if (this.opts.debug) {
          // eslint-disable-next-line no-console
          console.log('[wmx-three-streaming] cancel (switch url)', {
            frame: this.frame,
            manifestUrl: tileset.manifestUrl,
            tileId: c.tileId,
            from: s.loading.url,
            to: c.url
          });
        }
        s.loading.abort.abort();
        s.loading = undefined;
      }
      this.startLoad(tileset, states, c.tileId, c.quality, c.url, c.bytes);
    }

    // Cancel/unload policy for non-desired tiles.
    for (const [tileId, s] of states.entries()) {
      const hint = tileset.getTileHint(tileId);
      if (hint?.pinned) continue;
      if (s.desired) continue;

      // Never hard-dispose for selection/refine toggles while in frustum.
      if (this.opts.retention === 'cache') {
        // In cache mode we only cancel loading after a short settle window.
        const recentlyDesired =
          typeof s.lastDesiredFrame === 'number' && this.frame - s.lastDesiredFrame <= this.lingerFrames;
        if (!recentlyDesired && s.loading) {
          if (this.opts.debug) {
            // eslint-disable-next-line no-console
            console.log('[wmx-three-streaming] cancel (no longer desired)', {
              frame: this.frame,
              manifestUrl: tileset.manifestUrl,
              tileId,
              url: s.loading.url
            });
          }
          s.loading.abort.abort();
          s.loading = undefined;
        }
        continue;
      }

      // dispose mode: only dispose when out of frustum for enough frames.
      const lastInFrustumFrame = s.lastInFrustumFrame ?? Number.NEGATIVE_INFINITY;
      const outForFrames = this.frame - lastInFrustumFrame;
      const shouldDispose = opts.rootOutOfFrustum
        ? outForFrames >= this.opts.disposeOutOfFrustumFrames
        : outForFrames >= this.opts.disposeOutOfFrustumFrames;
      if (!shouldDispose) continue;

      if (s.loading) {
        if (this.opts.debug) {
          // eslint-disable-next-line no-console
          console.log('[wmx-three-streaming] cancel (out of frustum)', {
            frame: this.frame,
            manifestUrl: tileset.manifestUrl,
            tileId,
            url: s.loading.url,
            outForFrames
          });
        }
        s.loading.abort.abort();
        s.loading = undefined;
      }
      if (s.resident) {
        if (this.opts.debug) {
          // eslint-disable-next-line no-console
          console.log('[wmx-three-streaming] unload (out of frustum)', {
            frame: this.frame,
            manifestUrl: tileset.manifestUrl,
            tileId,
            url: s.resident.url,
            quality: s.resident.quality,
            outForFrames
          });
        }
        this.unresident(tileset, s);
      }
    }
  }

  private startLoad(
    tileset: WMXStreamedTileset,
    states: Map<string, TileRuntimeState>,
    tileId: string,
    quality: WMXQuality,
    url: string,
    bytesHint: number
  ) {
    const s = states.get(tileId)!;
    const abort = new AbortController();

    const promise = (async (): Promise<Resident> => {
      // WMXLoader loads from a manifest, but tile content is a GLB URL; use GLTFLoader directly.
      // However, WMXVariant may require decoder wiring; WMXLoader already configures decoders from `requires`.
      // Here we use a small trick: fabricate a tiny manifest URL-like load by calling GLTFLoader through WMXLoader internals isn't public.
      // For v1 we rely on GLTFLoader having been configured up-front (meshopt/ktx2/draco).
      const gltf = (await (this.opts.wmxLoader as any).gltfLoader.loadAsync(url)) as GLTF;
      const object = (gltf as any).scene ?? (gltf as any).scenes?.[0] ?? (gltf as any);
      const resident: Resident = { tileId, quality, url, object, bytes: bytesHint, lastUsedFrame: this.frame };
      return resident;
    })();

    s.loading = { url, abort, promise };
    if (this.opts.debug) {
      // eslint-disable-next-line no-console
      console.log('[wmx-three-streaming] load start', {
        frame: this.frame,
        manifestUrl: tileset.manifestUrl,
        tileId,
        quality,
        url,
        bytesHint
      });
    }
    promise
      .then((resident) => {
        // Ignore if cancelled/superseded.
        if (s.loading?.url !== url) return;
        s.loading = undefined;

        // Replace old content if present.
        if (s.resident) this.unresident(tileset, s);

        s.resident = resident;
        this.residentBytes += resident.bytes;

        const g = tileset.groupsById[tileId];
        if (g) {
          g.add(resident.object);
        }
        if (this.opts.debug) {
          // eslint-disable-next-line no-console
          console.log('[wmx-three-streaming] load done', {
            frame: this.frame,
            manifestUrl: tileset.manifestUrl,
            tileId,
            quality: resident.quality,
            url: resident.url
          });
        }

        // Capture world-space bounds from the loaded content. This makes v1 robust even if
        // producer-provided bounds are approximate (e.g. ignores node transforms).
        try {
          tileset.updateMatrixWorld(true);
          resident.object.updateMatrixWorld(true);
          const box = new THREE.Box3().setFromObject(resident.object);
          const sphere = new THREE.Sphere();
          box.getBoundingSphere(sphere);
          if (Number.isFinite(sphere.radius) && sphere.radius > 1e-6) {
            s.boundsWorld = { center: sphere.center.clone(), radius: sphere.radius };
          }
        } catch {
          // ignore
        }
      })
      .catch((e) => {
        // Ignore errors for now; keep tile empty.
        // eslint-disable-next-line no-console
        console.warn('[wmx-three-streaming] Tile load failed', { tileId, url, error: e?.message ?? String(e) });
        if (s.loading?.url === url) s.loading = undefined;
        const prev = s.lastError?.url === url ? s.lastError : undefined;
        s.lastError = { url, frame: this.frame, count: (prev?.count ?? 0) + 1 };
        if (this.opts.debug) {
          // eslint-disable-next-line no-console
          console.log('[wmx-three-streaming] load failed', {
            frame: this.frame,
            manifestUrl: tileset.manifestUrl,
            tileId,
            url,
            error: e?.message ?? String(e),
            failCount: s.lastError.count
          });
        }
      });
  }

  private unresident(tileset: WMXStreamedTileset, s: TileRuntimeState) {
    const r = s.resident;
    if (!r) return;
    const g = tileset.groupsById[r.tileId];
    if (g) g.remove(r.object);
    disposeObject(r.object);
    this.residentBytes -= r.bytes;
    s.resident = undefined;
    // Keep last-known tight bounds as a hint for frustum checks even while non-resident.
    // This avoids bouncing back to loose producer bounds immediately after disposal.
  }

  private evictIfOverBudget() {
    if (this.residentBytes <= this.opts.budgets.maxBytes) return;

    // Collect eviction candidates across tilesets (not pinned, not desired).
    const all: Resident[] = [];
    for (const tileset of this.tilesets) {
      const states = this.tileState.get(tileset);
      if (!states) continue;
      for (const [tileId, s] of states.entries()) {
        const hint = tileset.getTileHint(tileId);
        if (hint?.pinned) continue;
        if (s.desired) continue;
        if (s.resident) all.push(s.resident);
      }
    }

    // Evict least recently used first.
    all.sort((a, b) => a.lastUsedFrame - b.lastUsedFrame);
    for (const r of all) {
      if (this.residentBytes <= this.opts.budgets.maxBytes) break;
      for (const tileset of this.tilesets) {
        const states = this.tileState.get(tileset);
        const s = states?.get(r.tileId);
        if (s?.resident?.url === r.url) this.unresident(tileset, s);
      }
    }
  }
}

function chooseQuality(px: number, t: WMXStreamManagerThresholds): WMXQuality {
  if (px >= t.highPx) return 'high';
  if (px >= t.mediumPx) return 'medium';
  if (px >= t.lowPx) return 'low';
  return 'ultraLow';
}

function resolveUrl(rel: string, baseAbs: string): string {
  return new URL(rel, baseAbs).toString();
}

function countLoading(states: Map<string, TileRuntimeState>): number {
  let n = 0;
  for (const s of states.values()) if (s.loading) n++;
  return n;
}

