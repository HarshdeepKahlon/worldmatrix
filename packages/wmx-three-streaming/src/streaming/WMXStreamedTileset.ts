import * as THREE from 'three';
import type { WMXManifestV1, WMXQuality } from '@worldmatrix/wmx-core';
import { isWMXManifestV1 } from '@worldmatrix/wmx-core';

import type { WMXStreamingRefineTreeV1, WMXStreamingTileV1 } from '../schema.js';
import { isWMXStreamingRefineTreeV1 } from '../schema.js';
import { makeMatrixFromTRS } from './math.js';

export type WMXStreamedTilesetOptions = {
  /** If provided, used when a tile does not define `refine`. */
  defaultRefine?: 'replace' | 'add';
};

export type WMXTileHint = Partial<{
  /** Force a specific quality for this tile (overrides default policy). */
  quality: WMXQuality;
  /** Keep this tile resident (do not evict). */
  pinned: boolean;
  /** Treat as visible even if frustum culled (logical override). */
  forceVisible: boolean;
  /**
   * Treat as hidden even if it would otherwise be selected (e.g. occlusion culling).
   * When set, the streaming manager will skip selecting this tile and its subtree.
   */
  forceHidden: boolean;
}>;

export class WMXStreamedTileset extends THREE.Group {
  readonly manifestUrl: string;
  readonly manifest: WMXManifestV1;
  readonly tree: WMXStreamingRefineTreeV1;
  readonly tilesById: Record<string, WMXStreamingTileV1>;
  readonly groupsById: Record<string, THREE.Group>;

  private tileHints = new Map<string, WMXTileHint>();

  private constructor(params: {
    manifestUrl: string;
    manifest: WMXManifestV1;
    tree: WMXStreamingRefineTreeV1;
    groupsById: Record<string, THREE.Group>;
  }) {
    super();
    this.manifestUrl = params.manifestUrl;
    this.manifest = params.manifest;
    this.tree = params.tree;
    this.tilesById = params.tree.tiles;
    this.groupsById = params.groupsById;

    const rootGroup = params.groupsById[params.tree.rootTileId];
    if (!rootGroup) throw new Error(`[WMXStreamedTileset] Missing root group: ${params.tree.rootTileId}`);
    this.add(rootGroup);
  }

  static async fromManifestUrl(manifestUrl: string, _opts: WMXStreamedTilesetOptions = {}): Promise<WMXStreamedTileset> {
    const abs = toAbsoluteUrl(manifestUrl);
    const manifest = await fetchManifest(abs);
    const tree = parseStreamingTree(manifest);
    const groupsById = buildGroups(tree);

    return new WMXStreamedTileset({ manifestUrl: abs, manifest, tree, groupsById });
  }

  setTileHint(tileId: string, hint: WMXTileHint | null) {
    if (!hint) this.tileHints.delete(tileId);
    else this.tileHints.set(tileId, hint);
  }

  getTileHint(tileId: string): WMXTileHint | undefined {
    return this.tileHints.get(tileId);
  }
}

function parseStreamingTree(manifest: WMXManifestV1): WMXStreamingRefineTreeV1 {
  const streaming = ((manifest as any).streaming ?? (manifest.extras as any)?.streaming) as unknown;
  if (!isWMXStreamingRefineTreeV1(streaming)) {
    throw new Error('[WMXStreamedTileset] Missing or invalid manifest.streaming (expected wmx-streaming-refine-tree@1)');
  }
  return streaming;
}

function buildGroups(tree: WMXStreamingRefineTreeV1): Record<string, THREE.Group> {
  const groups: Record<string, THREE.Group> = {};
  for (const [id, tile] of Object.entries(tree.tiles) as Array<[string, WMXStreamingTileV1]>) {
    const g = new THREE.Group();
    g.name = `wmx-tile:${id}`;
    // Apply local transform (relative to parent) if present.
    if (tile.transform) g.applyMatrix4(makeMatrixFromTRS(tile.transform));
    groups[id] = g;
  }

  // Connect hierarchy.
  for (const [id, tile] of Object.entries(tree.tiles) as Array<[string, WMXStreamingTileV1]>) {
    if (!tile.parentId) continue;
    const parent = groups[tile.parentId];
    const child = groups[id];
    if (parent && child) parent.add(child);
  }
  return groups;
}

async function fetchManifest(url: string): Promise<WMXManifestV1> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`[WMXStreamedTileset] Failed to fetch manifest: ${res.status} ${res.statusText}`);
  const json = (await res.json()) as unknown;
  if (!isWMXManifestV1(json)) throw new Error('[WMXStreamedTileset] Invalid WMX manifest (expected schemaVersion "1.0")');
  return json;
}

function toAbsoluteUrl(url: string): string {
  try {
    const base = typeof window !== 'undefined' ? window.location.href : 'http://localhost/';
    return new URL(url, base).toString();
  } catch {
    return url;
  }
}

