import type { WMXManifestV1, WMXQuality } from '@worldmatrix/wmx-core';
import { isWMXManifestV1 } from '@worldmatrix/wmx-core';

/**
 * We intentionally avoid importing `three` types here.
 *
 * Some `three` distributions (and/or consumer setups) do not include TypeScript
 * declarations. This package only requires a loader with `loadAsync()` and a
 * `manager` field, so we keep the surface area minimal and type-safe.
 */
export type GLTF = unknown;

export interface GLTFLoaderLike {
  manager: unknown;
  loadAsync(url: string): Promise<GLTF>;
}

export type WMXLoaderQuality = WMXQuality;

export type WMXLoaderDecoderConfig = Partial<{
  /**
   * KTX2Loader instance (Three.js). If provided and the manifest requires
   * `KHR_texture_basisu`, WMXLoader will call `gltfLoader.setKTX2Loader(ktx2Loader)`
   * when that method exists.
   */
  ktx2Loader: unknown;
}>;

export type WMXLoaderOptions = {
  /** Explicit quality override. If omitted, defaults to `medium`. */
  quality?: WMXLoaderQuality;
};

export class WMXLoader {
  readonly gltfLoader: GLTFLoaderLike;
  readonly decoders: WMXLoaderDecoderConfig;

  constructor(gltfLoader: GLTFLoaderLike, decoders: WMXLoaderDecoderConfig = {}) {
    this.gltfLoader = gltfLoader;
    this.decoders = decoders;
  }

  get manager(): unknown {
    return this.gltfLoader.manager;
  }

  async load(manifestUrl: string, options: WMXLoaderOptions = {}): Promise<GLTF> {
    const resolvedQuality = options.quality ?? qualityFromUrl(manifestUrl) ?? 'medium';
    // Normalize to an absolute URL so relative variant URLs can be resolved reliably.
    const manifestAbs = toAbsoluteUrl(manifestUrl);
    const manifest = await fetchManifest(manifestAbs);

    const variant =
      (manifest.variants as any)[resolvedQuality] ??
      // Backwards/forwards-compatible fallback: if ultraLow is requested but missing, use low.
      (resolvedQuality === 'ultraLow' ? (manifest.variants as any).low : undefined);
    if (!variant) {
      throw new Error(`[WMXLoader] Missing variant "${resolvedQuality}" in manifest`);
    }

    this.maybeConfigureDecoders(variant.requires);

    const glbUrl = resolveUrl(variant.url, manifestAbs);
    return await this.gltfLoader.loadAsync(glbUrl);
  }

  private maybeConfigureDecoders(requires?: Record<string, unknown>) {
    if (!requires) return;

    // KTX2 (KHR_texture_basisu)
    if (requires['KHR_texture_basisu'] && this.decoders.ktx2Loader) {
      const anyLoader = this.gltfLoader as any;
      if (typeof anyLoader.setKTX2Loader === 'function') {
        anyLoader.setKTX2Loader(this.decoders.ktx2Loader);
      }
    }
  }
}

async function fetchManifest(url: string): Promise<WMXManifestV1> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`[WMXLoader] Failed to fetch manifest: ${res.status} ${res.statusText}`);
  const json = (await res.json()) as unknown;
  if (!isWMXManifestV1(json)) throw new Error('[WMXLoader] Invalid WMX manifest (expected schemaVersion "1.0")');
  return json;
}

function resolveUrl(maybeRelative: string, baseUrl: string): string {
  return new URL(maybeRelative, baseUrl).toString();
}

function toAbsoluteUrl(url: string): string {
  try {
    const base = typeof window !== 'undefined' ? window.location.href : 'http://localhost/';
    return new URL(url, base).toString();
  } catch {
    // If URL parsing still fails, return as-is and let fetch/loader throw a clearer error.
    return url;
  }
}

function qualityFromUrl(url: string): WMXLoaderQuality | undefined {
  try {
    const u = new URL(url, typeof window !== 'undefined' ? window.location.href : 'http://localhost/');
    const q = u.searchParams.get('quality');
    if (q === 'ultraLow' || q === 'low' || q === 'medium' || q === 'high') return q;
    return undefined;
  } catch {
    return undefined;
  }
}

