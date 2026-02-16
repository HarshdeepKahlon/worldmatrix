export type WMXQuality = 'ultraLow' | 'low' | 'medium' | 'high';

export type WMXRequiredQuality = 'low' | 'medium' | 'high';

export type WMXVariantRequirements = Partial<{
  /** e.g. `KHR_texture_basisu` */
  KHR_texture_basisu: boolean;
  /** e.g. `EXT_meshopt_compression` */
  EXT_meshopt_compression: boolean;
  /** e.g. `KHR_draco_mesh_compression` */
  KHR_draco_mesh_compression: boolean;
  /** e.g. `KHR_mesh_quantization` */
  KHR_mesh_quantization: boolean;
  /** e.g. `EXT_mesh_gpu_instancing` */
  EXT_mesh_gpu_instancing: boolean;
}>;

export type WMXVariantMetrics = Partial<{
  triangles: number;
  meshes: number;
  primitives: number;
  textures: number;
  materials: number;
  nodes: number;
  animations: number;
  skins: number;
  /** Axis-aligned bounding box in meters, if known. */
  bounds: { min: [number, number, number]; max: [number, number, number] };
}>;

export interface WMXVariant {
  /** Variant URL (absolute or relative to the manifest URL). */
  url: string;
  /** File size in bytes (recommended). */
  bytes?: number;
  /** Computed metrics for the optimized variant (optional in v1). */
  metrics?: WMXVariantMetrics;
  /** Decoder/extension requirements (optional in v1). */
  requires?: WMXVariantRequirements;
}

export interface WMXArtifacts {
  /** Relative path to a PNG thumbnail (relative to the manifest location). */
  thumbnail?: string;
  /** Relative path to a JSON stats blob (relative to the manifest location). */
  stats?: string;
}

export interface WMXManifestV1 {
  schemaVersion: '1.0';

  /**
   * Stable identifier for this asset and its derived outputs.
   * Suggested: content hash of the source GLB, or a registry ID.
   */
  assetId: string;

  /** Human-friendly name (optional). */
  name?: string;

  source?: Partial<{
    filename: string;
    bytes: number;
    /** ISO timestamp */
    createdAt: string;
  }>;

  /**
   * Variants always include at least `low|medium|high`.
   * Additional qualities (e.g. `ultraLow`) are optional.
   */
  variants: Record<WMXRequiredQuality, WMXVariant> & Partial<Record<WMXQuality, WMXVariant>>;

  artifacts?: WMXArtifacts;

  /**
   * Optional streaming metadata for node-subtree LOD streaming.
   * When present, runtimes may stream tiles rather than loading a single variant.
   */
  streaming?: import('./streaming.js').WMXStreamingRefineTreeV1;

  /**
   * Extra data that producers/consumers may add without breaking readers.
   * Keep this JSON-serializable.
   */
  extras?: Record<string, unknown>;
}

export function isWMXManifestV1(value: unknown): value is WMXManifestV1 {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<WMXManifestV1>;
  if (v.schemaVersion !== '1.0') return false;
  if (typeof v.assetId !== 'string' || !v.assetId) return false;
  if (!v.variants || typeof v.variants !== 'object') return false;

  const qualities: WMXRequiredQuality[] = ['low', 'medium', 'high'];
  for (const q of qualities) {
    const variant = (v.variants as any)[q] as WMXVariant | undefined;
    if (!variant || typeof variant !== 'object') return false;
    if (typeof variant.url !== 'string' || !variant.url) return false;
  }
  return true;
}

/**
 * Convenience: export schema version as a constant.
 * Useful for producers writing manifests.
 */
export const WMX_SCHEMA_VERSION_V1 = '1.0' as const;

