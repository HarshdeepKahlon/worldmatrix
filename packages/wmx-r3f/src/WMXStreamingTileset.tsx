import React from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import type { Group } from 'three';

import type { WMXRuntime } from '@worldmatrix/wmx-runtime';
import type { WMXStreamManager } from '@worldmatrix/wmx-three-streaming';
import type { WMXStreamedTileset } from '@worldmatrix/wmx-three-streaming';

import { useWMXRuntime } from './useWMXRuntime.js';

export type WMXStreamingTilesetProps = {
  manifestUrl: string;
  /** Supply a host-created runtime (e.g. BuildCoresLoader-backed). */
  runtime?: WMXRuntime;
  retention?: 'cache' | 'dispose';
  disposeOutOfFrustumFrames?: number;
  concurrency?: number;
};

export function WMXStreamingTileset(props: WMXStreamingTilesetProps) {
  const hookRuntime = useWMXRuntime();
  const runtime = props.runtime ?? hookRuntime;
  const camera = useThree((s) => s.camera);
  const viewportHeightPx = useThree((s) => Math.max(1, Math.floor(s.size.height)));
  const groupRef = React.useRef<Group | null>(null);
  const managerRef = React.useRef<WMXStreamManager | null>(null);
  const tilesetRef = React.useRef<WMXStreamedTileset | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const group = groupRef.current;
    if (!group) return;

    (async () => {
      const tileset = await runtime.loadStreamingTileset(props.manifestUrl);
      if (cancelled) return;

      const manager = runtime.createStreamManager({
        viewportHeightPx,
        concurrency: props.concurrency,
        retention: props.retention,
        disposeOutOfFrustumFrames: props.disposeOutOfFrustumFrames
      });
      manager.add(tileset);
      group.add(tileset);
      tilesetRef.current = tileset;
      managerRef.current = manager;
    })().catch((e) => {
      // eslint-disable-next-line no-console
      console.error('[wmx-r3f] failed to load streaming tileset', {
        manifestUrl: props.manifestUrl,
        error: e
      });
    });

    return () => {
      cancelled = true;
      const manager = managerRef.current;
      const tileset = tilesetRef.current;
      if (manager && tileset) manager.remove(tileset);
      if (group && tileset) group.remove(tileset);
      managerRef.current = null;
      tilesetRef.current = null;
    };
  }, [
    runtime,
    props.manifestUrl,
    props.concurrency,
    props.retention,
    props.disposeOutOfFrustumFrames,
    viewportHeightPx
  ]);

  useFrame(() => {
    const manager = managerRef.current;
    const tileset = tilesetRef.current;
    if (!manager || !tileset) return;
    tileset.updateMatrixWorld(true);
    manager.update(camera);
  });

  return <group ref={groupRef} />;
}
