import { MeshoptDecoder } from 'meshoptimizer';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';

import type { WMXQuality } from '@worldmatrix/wmx-core';
import { WMXLoader, type GLTFLoaderLike } from '@worldmatrix/wmx-three';
import { WMXStreamManager, type WMXStreamManagerOptions, WMXStreamedTileset } from '@worldmatrix/wmx-three-streaming';

import { defaultDecoderPathsFromThree, type WMXDecoderPathsOptions } from './decoderPaths.js';

export type CreateWMXRuntimeOptions = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  renderer: any;
  /**
   * Optional externally managed loader (e.g. BuildCoresLoader) that already
   * supports custom payload formats like .glb.br + decrypt/decompress.
   * When provided, WMX runtime delegates all GLB fetch/parse work to this loader.
   */
  gltfLoader?: GLTFLoaderLike;
  decoders?: WMXDecoderPathsOptions;
  fetch?: typeof globalThis.fetch;
  logger?: Pick<Console, 'warn'>;
};

export type CreateWMXStreamManagerOptions = Partial<Omit<WMXStreamManagerOptions, 'wmxLoader'>> & {
  viewportHeightPx: number;
};

export type WMXRuntime = {
  gltfLoader: GLTFLoaderLike;
  ktx2Loader: KTX2Loader | null;
  dracoLoader: DRACOLoader | null;
  wmxLoader: WMXLoader;
  decoderPaths: ReturnType<typeof defaultDecoderPathsFromThree>;
  loadStatic: (manifestUrl: string, options?: { quality?: WMXQuality }) => Promise<unknown>;
  loadStreamingTileset: (manifestUrl: string) => Promise<WMXStreamedTileset>;
  createStreamManager: (options: CreateWMXStreamManagerOptions) => WMXStreamManager;
  preloadDecoders: () => Promise<void>;
  dispose: () => void;
};

export function createWMXRuntime(options: CreateWMXRuntimeOptions): WMXRuntime {
  const decoderPaths = defaultDecoderPathsFromThree(options.decoders);

  const externalLoader = options.gltfLoader;
  const usingExternalLoader = !!externalLoader;

  let ktx2Loader: KTX2Loader | null = null;
  let dracoLoader: DRACOLoader | null = null;
  let gltfLoader: GLTFLoaderLike;
  let wmxLoader: WMXLoader;

  if (externalLoader) {
    gltfLoader = externalLoader;
    wmxLoader = new WMXLoader(gltfLoader, {});
  } else {
    ktx2Loader = new KTX2Loader();
    ktx2Loader.setTranscoderPath(decoderPaths.basisTranscoderPath);
    ktx2Loader.detectSupport(options.renderer);

    dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath(decoderPaths.dracoDecoderPath);

    const created = new GLTFLoader();
    (created as any).setKTX2Loader?.(ktx2Loader);
    (created as any).setMeshoptDecoder?.(MeshoptDecoder);
    (created as any).setDRACOLoader?.(dracoLoader);
    gltfLoader = created as GLTFLoaderLike;
    wmxLoader = new WMXLoader(gltfLoader as any, { ktx2Loader });
  }

  const loadStatic: WMXRuntime['loadStatic'] = async (manifestUrl, opts = {}) => {
    return await wmxLoader.load(manifestUrl, opts);
  };

  const loadStreamingTileset: WMXRuntime['loadStreamingTileset'] = async (manifestUrl) => {
    return await WMXStreamedTileset.fromManifestUrl(manifestUrl);
  };

  const createStreamManager: WMXRuntime['createStreamManager'] = (opts) => {
    return new WMXStreamManager({
      ...opts,
      wmxLoader
    } as WMXStreamManagerOptions);
  };

  const preloadDecoders = async () => {
    if (usingExternalLoader) {
      options.logger?.warn?.('[wmx-runtime] preloadDecoders() ignored when using external gltfLoader.');
      return;
    }
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (!fetchImpl) return;

    const urls = [
      `${decoderPaths.basisTranscoderPath}basis_transcoder.js`,
      `${decoderPaths.basisTranscoderPath}basis_transcoder.wasm`,
      `${decoderPaths.dracoDecoderPath}draco_decoder.js`,
      `${decoderPaths.dracoDecoderPath}draco_decoder.wasm`,
      `${decoderPaths.dracoDecoderPath}draco_wasm_wrapper.js`
    ];

    await Promise.all(
      urls.map(async (url) => {
        const abs = toAbsoluteUrl(url);
        if (!abs) return;
        const res = await fetchImpl(abs);
        if (!res.ok) {
          throw new Error(`Decoder preload failed (${res.status}) for ${abs}`);
        }
      })
    );
  };

  const dispose = () => {
    try {
      ktx2Loader?.dispose?.();
    } catch (e) {
      options.logger?.warn?.('[wmx-runtime] failed to dispose KTX2Loader', e);
    }
    try {
      (dracoLoader as any)?.dispose?.();
    } catch (e) {
      options.logger?.warn?.('[wmx-runtime] failed to dispose DRACOLoader', e);
    }
  };

  return {
    gltfLoader,
    ktx2Loader,
    dracoLoader,
    wmxLoader,
    decoderPaths,
    loadStatic,
    loadStreamingTileset,
    createStreamManager,
    preloadDecoders,
    dispose
  };
}

function toAbsoluteUrl(url: string): string | null {
  try {
    return new URL(url, typeof window !== 'undefined' ? window.location.href : 'http://localhost/').toString();
  } catch {
    return null;
  }
}
