import React from 'react';
import { useThree } from '@react-three/fiber';

import { createWMXRuntime, type CreateWMXRuntimeOptions, type WMXRuntime } from '@worldmatrix/wmx-runtime';

type UseWMXRuntimeOptions = Partial<Omit<CreateWMXRuntimeOptions, 'renderer'>>;

type RuntimeEntry = {
  runtime: WMXRuntime;
  refs: number;
  decoderKey: string;
};

const runtimeCache = new WeakMap<object, RuntimeEntry>();

export function useWMXRuntime(options: UseWMXRuntimeOptions = {}): WMXRuntime {
  const renderer = useThree((s) => s.gl as unknown as object);
  const externalLoader = options.gltfLoader;
  const decoderKey = JSON.stringify(options.decoders ?? {});

  const externalRuntime = React.useMemo(() => {
    if (!externalLoader) return null;
    return createWMXRuntime({
      renderer,
      gltfLoader: externalLoader,
      decoders: options.decoders,
      fetch: options.fetch,
      logger: options.logger
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderer, externalLoader]);

  React.useEffect(() => {
    return () => {
      externalRuntime?.dispose();
    };
  }, [externalRuntime]);

  if (externalRuntime) return externalRuntime;

  const runtime = React.useMemo(() => {
    const cached = runtimeCache.get(renderer);
    if (cached) {
      cached.refs += 1;
      if (cached.decoderKey !== decoderKey) {
        options.logger?.warn?.(
          '[wmx-r3f] Existing runtime for this renderer uses different decoder options; reusing existing runtime.'
        );
      }
      return cached.runtime;
    }

    const created = createWMXRuntime({
      renderer,
      decoders: options.decoders,
      fetch: options.fetch,
      logger: options.logger
    });
    runtimeCache.set(renderer, { runtime: created, refs: 1, decoderKey });
    return created;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderer, decoderKey]);

  React.useEffect(() => {
    return () => {
      const cached = runtimeCache.get(renderer);
      if (!cached) return;
      cached.refs -= 1;
      if (cached.refs <= 0) {
        cached.runtime.dispose();
        runtimeCache.delete(renderer);
      }
    };
  }, [renderer]);

  return runtime;
}
