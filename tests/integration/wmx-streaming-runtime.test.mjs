import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { WMXStreamManager, WMXStreamedTileset } from '../../packages/wmx-three-streaming/dist/index.js';

function nextTick() {
  return new Promise((r) => setTimeout(r, 0));
}

test('wmx-three-streaming replace refinement keeps parent until child is resident', async () => {
  const manifestUrl = 'http://example.test/assets/asset.wmx.json';

  const manifest = {
    schemaVersion: '1.0',
    assetId: 'test',
    variants: {
      low: { url: 'variants/low.glb', bytes: 10, metrics: { bounds: { min: [-1, -1, -1], max: [1, 1, 1] } } },
      medium: { url: 'variants/medium.glb', bytes: 10, metrics: { bounds: { min: [-1, -1, -1], max: [1, 1, 1] } } },
      high: { url: 'variants/high.glb', bytes: 10, metrics: { bounds: { min: [-1, -1, -1], max: [1, 1, 1] } } }
    },
    streaming: {
      schema: 'wmx-streaming-refine-tree@1',
      rootTileId: 'root',
      tiles: {
        root: {
          id: 'root',
          children: ['child'],
          refine: 'replace',
          bounds: { sphere: { center: [0, 0, 0], radius: 10 } },
          content: {
            low: { url: 'tiles/root-low.glb', bytes: 50 },
            medium: { url: 'tiles/root-med.glb', bytes: 50 },
            high: { url: 'tiles/root-high.glb', bytes: 50 }
          }
        },
        child: {
          id: 'child',
          parentId: 'root',
          children: [],
          bounds: { sphere: { center: [0, 0, 0], radius: 10 } },
          content: {
            low: { url: 'tiles/child-low.glb', bytes: 50 },
            medium: { url: 'tiles/child-med.glb', bytes: 50 },
            high: { url: 'tiles/child-high.glb', bytes: 50 }
          }
        }
      }
    }
  };

  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(url, manifestUrl);
    return new Response(JSON.stringify(manifest), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const tileset = await WMXStreamedTileset.fromManifestUrl(manifestUrl);
    tileset.updateMatrixWorld(true);

    // Fake WMXLoader: WMXStreamManager will call `.gltfLoader.loadAsync(url)` via `as any`.
    const fakeWMXLoader = {
      gltfLoader: {
        loadAsync: async (url) => {
          const scene = new THREE.Group();
          scene.name = `loaded:${url}`;
          return { scene };
        }
      }
    };

    const manager = new WMXStreamManager({
      wmxLoader: fakeWMXLoader,
      viewportHeightPx: 900,
      thresholds: { refinePx: 1, coarsenPx: 0 } // always refine when visible
    });
    manager.add(tileset);

    const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    cam.position.set(0, 0, 30);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld(true);

    manager.update(cam);
    await nextTick();

    // First update: both parent + child are desired; parent remains until child is resident.
    const rootNames1 = tileset.groupsById.root.children.map((c) => c.name).filter(Boolean);
    assert.ok(rootNames1.some((n) => n.startsWith('loaded:')), 'expected root content to be present initially');

    manager.update(cam);
    await nextTick();

    // Second update: child is resident, replace refinement should stop desiring parent content.
    // In robust dispose mode, parent may stay resident while still in frustum, but should be hidden.
    const rootNames2 = tileset.groupsById.root.children.map((c) => c.name).filter(Boolean);
    const rootPayload = tileset.groupsById.root.children.find((c) => String(c.name).includes('/tiles/root-'));
    assert.ok(rootPayload, 'expected root payload to remain resident while in-frustum');
    assert.equal(rootPayload.visible, false, 'expected root payload to be hidden when no longer desired');

    const childNames = tileset.groupsById.child.children.map((c) => c.name).filter(Boolean);
    assert.ok(childNames.some((n) => n.includes('/tiles/child-')));
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test('wmx-three-streaming dispose mode disposes only after out-of-frustum threshold', async () => {
  const manifestUrl = 'http://example.test/assets/dispose-asset.wmx.json';
  const manifest = {
    schemaVersion: '1.0',
    assetId: 'dispose-test',
    variants: {
      low: { url: 'variants/low.glb', bytes: 10 },
      medium: { url: 'variants/medium.glb', bytes: 10 },
      high: { url: 'variants/high.glb', bytes: 10 }
    },
    streaming: {
      schema: 'wmx-streaming-refine-tree@1',
      rootTileId: 'root',
      tiles: {
        root: {
          id: 'root',
          children: [],
          bounds: { sphere: { center: [0, 0, 0], radius: 5 } },
          content: {
            ultraLow: { url: 'tiles/root-ultra.glb', bytes: 25 },
            low: { url: 'tiles/root-low.glb', bytes: 25 },
            medium: { url: 'tiles/root-med.glb', bytes: 25 },
            high: { url: 'tiles/root-high.glb', bytes: 25 }
          }
        }
      }
    }
  };

  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(url, manifestUrl);
    return new Response(JSON.stringify(manifest), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const tileset = await WMXStreamedTileset.fromManifestUrl(manifestUrl);
    tileset.updateMatrixWorld(true);

    const loadCalls = [];
    const fakeWMXLoader = {
      gltfLoader: {
        loadAsync: async (url) => {
          loadCalls.push(String(url));
          const scene = new THREE.Group();
          scene.name = `loaded:${url}`;
          return { scene };
        }
      }
    };

    const manager = new WMXStreamManager({
      wmxLoader: fakeWMXLoader,
      viewportHeightPx: 900,
      retention: 'dispose',
      disposeOutOfFrustumFrames: 2
    });
    manager.add(tileset);

    const camIn = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    camIn.position.set(0, 0, 20);
    camIn.lookAt(0, 0, 0);
    camIn.updateMatrixWorld(true);

    // Load once in-frustum.
    manager.update(camIn);
    await nextTick();
    manager.update(camIn);
    await nextTick();
    assert.ok(tileset.groupsById.root.children.some((c) => String(c.name).includes('/tiles/root-')));
    const callsAfterInFrustum = loadCalls.length;

    // Move camera far away so object is out-of-frustum; this should dispose after threshold.
    const camOut = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    camOut.position.set(0, 0, 2000);
    camOut.lookAt(0, 0, 2001);
    camOut.updateMatrixWorld(true);

    manager.update(camOut);
    await nextTick();
    manager.update(camOut);
    await nextTick();
    manager.update(camOut);
    await nextTick();
    assert.equal(
      tileset.groupsById.root.children.some((c) => String(c.name).includes('/tiles/root-')),
      false,
      'expected root payload disposed after out-of-frustum threshold'
    );

    // While still out-of-frustum, additional updates should not refetch.
    manager.update(camOut);
    await nextTick();
    manager.update(camOut);
    await nextTick();
    assert.equal(loadCalls.length, callsAfterInFrustum, 'expected no extra refetch while object remains out-of-frustum');
  } finally {
    globalThis.fetch = prevFetch;
  }
});

