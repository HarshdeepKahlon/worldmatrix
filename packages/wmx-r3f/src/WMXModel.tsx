import React from 'react';

import type { WMXQuality } from '@worldmatrix/wmx-core';
import type { WMXRuntime } from '@worldmatrix/wmx-runtime';

import { useWMXRuntime } from './useWMXRuntime.js';

export type WMXModelProps = {
  manifestUrl: string;
  quality?: WMXQuality;
  /** Supply a host-created runtime (e.g. BuildCoresLoader-backed). */
  runtime?: WMXRuntime;
};

const loadCache = new WeakMap<WMXRuntime, Map<string, Promise<any>>>();

export function WMXModel(props: WMXModelProps) {
  const hookRuntime = useWMXRuntime();
  const runtime = props.runtime ?? hookRuntime;
  const quality = props.quality ?? 'medium';

  const gltf = React.use(loadStaticCached(runtime, props.manifestUrl, quality));
  const scene = (gltf as any)?.scene;
  if (!scene) return null;
  return <primitive object={scene} />;
}

function loadStaticCached(runtime: WMXRuntime, manifestUrl: string, quality: WMXQuality): Promise<any> {
  let map = loadCache.get(runtime);
  if (!map) {
    map = new Map();
    loadCache.set(runtime, map);
  }
  const key = `${manifestUrl}::${quality}`;
  const cached = map.get(key);
  if (cached) return cached;

  const promise = runtime.loadStatic(manifestUrl, { quality });
  map.set(key, promise);
  return promise;
}
