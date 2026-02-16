import test from 'node:test';
import assert from 'node:assert/strict';
import { REVISION } from 'three';
import * as THREE from 'three';

import { createWMXRuntime, defaultDecoderPathsFromThree } from '../../packages/wmx-runtime/dist/index.js';

test('wmx-runtime derives decoder CDN paths from three revision', () => {
  const paths = defaultDecoderPathsFromThree();
  const expectedVersion = `0.${Number.parseInt(REVISION, 10)}.0`;

  assert.equal(paths.threeVersion, expectedVersion);
  assert.equal(
    paths.basisTranscoderPath,
    `https://unpkg.com/three@${expectedVersion}/examples/jsm/libs/basis/`
  );
  assert.equal(
    paths.dracoDecoderPath,
    `https://unpkg.com/three@${expectedVersion}/examples/jsm/libs/draco/`
  );
});

test('wmx-runtime creates wired loaders and preloads decoder URLs', async () => {
  const calls = [];
  const runtime = createWMXRuntime({
    renderer: {
      capabilities: { isWebGL2: true },
      extensions: {
        has: () => true,
        get: () => ({ getSupportedProfiles: () => [] })
      }
    },
    decoders: {
      basisTranscoderPath: 'https://example.test/basis/',
      dracoDecoderPath: 'https://example.test/draco/'
    },
    fetch: async (url) => {
      calls.push(String(url));
      return new Response('', { status: 200 });
    }
  });

  try {
    assert.ok(runtime.gltfLoader);
    assert.ok(runtime.ktx2Loader);
    assert.ok(runtime.dracoLoader);
    assert.ok(runtime.wmxLoader);

    await runtime.preloadDecoders();
    assert.deepEqual(calls.sort(), [
      'https://example.test/basis/basis_transcoder.js',
      'https://example.test/basis/basis_transcoder.wasm',
      'https://example.test/draco/draco_decoder.js',
      'https://example.test/draco/draco_decoder.wasm',
      'https://example.test/draco/draco_wasm_wrapper.js'
    ]);
  } finally {
    runtime.dispose();
  }
});

test('wmx-runtime supports injected loader for .glb.br variants and streaming tiles', async () => {
  const manifestUrl = 'https://cdn.example.com/wmx/asset/asset.wmx.json';
  const manifest = {
    schemaVersion: '1.0',
    assetId: 'br-test',
    variants: {
      low: { url: 'variants/low.glb.br', bytes: 10 },
      medium: { url: 'variants/medium.glb.br', bytes: 10 },
      high: { url: 'variants/high.glb.br', bytes: 10 }
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
            low: { url: 'tiles/root-low.glb.br', bytes: 10 },
            medium: { url: 'tiles/root-medium.glb.br', bytes: 10 },
            high: { url: 'tiles/root-high.glb.br', bytes: 10 }
          }
        }
      }
    }
  };

  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), manifestUrl);
    return new Response(JSON.stringify(manifest), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const loadCalls = [];
  const runtime = createWMXRuntime({
    renderer: {
      capabilities: { isWebGL2: true },
      extensions: { has: () => true, get: () => ({ getSupportedProfiles: () => [] }) }
    },
    gltfLoader: {
      manager: {},
      loadAsync: async (url) => {
        loadCalls.push(String(url));
        const scene = new THREE.Group();
        scene.name = `loaded:${url}`;
        return { scene };
      }
    }
  });

  try {
    // Static variant load should route through injected loader with .glb.br URL.
    await runtime.loadStatic(manifestUrl, { quality: 'high' });
    assert.ok(loadCalls.some((u) => u.endsWith('/variants/high.glb.br')));

    // Streaming tile load should also route through injected loader.
    const tileset = await runtime.loadStreamingTileset(manifestUrl);
    tileset.updateMatrixWorld(true);
    const manager = runtime.createStreamManager({ viewportHeightPx: 900 });
    manager.add(tileset);
    const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    cam.position.set(0, 0, 20);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld(true);
    manager.update(cam);
    await new Promise((r) => setTimeout(r, 0));
    manager.update(cam);
    assert.ok(loadCalls.some((u) => u.includes('/tiles/root-') && u.endsWith('.glb.br')));
  } finally {
    globalThis.fetch = prevFetch;
    runtime.dispose();
  }
});
