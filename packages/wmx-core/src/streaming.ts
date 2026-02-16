import type { WMXQuality, WMXVariant } from './manifest.js';

/**
 * Streaming schema is part of the WMX core contract (v1).
 *
 * Note: earlier prototypes stored this under `manifest.extras.streaming`. Readers should
 * accept that legacy location for now, but producers should write `manifest.streaming`.
 */

export type WMXStreamingSchemaId = 'wmx-streaming-refine-tree@1';

export type WMXSphereBounds = {
  center: [number, number, number];
  radius: number;
};

export type WMXAabbBounds = {
  min: [number, number, number];
  max: [number, number, number];
};

export type WMXTileTransformTRS = Partial<{
  translation: [number, number, number];
  rotation: [number, number, number, number]; // quaternion
  scale: [number, number, number];
}>;

export type WMXTileRefineMode = 'replace' | 'add';

export type WMXStreamingTileV1 = {
  id: string;
  parentId?: string;
  children: string[];
  /** Default: 'replace' */
  refine?: WMXTileRefineMode;
  /** Relative transform to parent (optional). */
  transform?: WMXTileTransformTRS;
  bounds: {
    sphere: WMXSphereBounds;
    aabb?: WMXAabbBounds;
  };
  /**
   * Optional geometric error value. If provided, selection can use a more
   * 3D-Tiles-like SSE calculation; otherwise we approximate from bounds.
   */
  geometricError?: number;
  /**
   * Optional renderable payloads for this tile.
   * If omitted, the tile is a structural node only (children may still render).
   */
  content?: Partial<Record<WMXQuality, WMXVariant>>;
};

export type WMXStreamingRefineTreeV1 = {
  schema: WMXStreamingSchemaId;
  rootTileId: string;
  tiles: Record<string, WMXStreamingTileV1>;
};

export function isWMXStreamingRefineTreeV1(value: unknown): value is WMXStreamingRefineTreeV1 {
  if (!value || typeof value !== 'object') return false;
  const v = value as any;
  if (v.schema !== 'wmx-streaming-refine-tree@1') return false;
  if (typeof v.rootTileId !== 'string' || !v.rootTileId) return false;
  if (!v.tiles || typeof v.tiles !== 'object') return false;
  const root = v.tiles[v.rootTileId];
  if (!root) return false;
  return true;
}

