import type { createWMXRuntime } from '@worldmatrix/wmx-runtime';
import { defaultDecoderPathsFromThree } from '@worldmatrix/wmx-runtime';
import { createWMXRuntime as createRuntime } from '@worldmatrix/wmx-runtime';

export type CreateWMXLoadersOptions = {
  /**
   * Renderer used for capability detection (KTX2 compressed texture support).
   * Supports both WebGLRenderer and WebGPURenderer.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  renderer: any;
  basisTranscoderPath?: string;
  dracoDecoderPath?: string;
};

export type CreateWMXLoadersResult = Pick<
  ReturnType<typeof createWMXRuntime>,
  'gltfLoader' | 'ktx2Loader' | 'dracoLoader' | 'wmxLoader'
>;

export function createWMXLoaders(opts: CreateWMXLoadersOptions) {
  const defaults = defaultDecoderPathsFromThree({
    basisTranscoderPath: opts.basisTranscoderPath ?? '/basis/',
    dracoDecoderPath: opts.dracoDecoderPath ?? '/draco/'
  });
  const runtime = createRuntime({
    renderer: opts.renderer,
    decoders: {
      basisTranscoderPath: defaults.basisTranscoderPath,
      dracoDecoderPath: defaults.dracoDecoderPath
    }
  });
  return {
    gltfLoader: runtime.gltfLoader,
    ktx2Loader: runtime.ktx2Loader,
    dracoLoader: runtime.dracoLoader,
    wmxLoader: runtime.wmxLoader
  } as CreateWMXLoadersResult;
}

