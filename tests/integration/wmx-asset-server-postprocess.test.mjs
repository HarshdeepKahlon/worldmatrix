import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

import { convertAssetFolderToEncryptedBrotli } from '../../packages/wmx-asset-server/dist/postprocess.js';
import { publishAssetFolderToS3 } from '../../packages/wmx-asset-server/dist/s3Publish.js';

test('wmx-asset-server postprocess converts payloads to .glb.br and rewrites manifest bytes/urls', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wmx-postprocess-'));
  const assetDir = path.join(tmp, 'asset');
  await fs.mkdir(path.join(assetDir, 'variants'), { recursive: true });
  await fs.mkdir(path.join(assetDir, 'tiles', 'root'), { recursive: true });

  const variantAbs = path.join(assetDir, 'variants', 'high.glb');
  const tileAbs = path.join(assetDir, 'tiles', 'root', 'low.glb');
  await fs.writeFile(variantAbs, Buffer.from('variant-glb'));
  await fs.writeFile(tileAbs, Buffer.from('tile-glb'));

  const manifest = {
    schemaVersion: '1.0',
    assetId: 'abc123',
    variants: {
      low: { url: 'variants/high.glb', bytes: 0 },
      medium: { url: 'variants/high.glb', bytes: 0 },
      high: { url: 'variants/high.glb', bytes: 0 }
    },
    streaming: {
      schema: 'wmx-streaming-refine-tree@1',
      rootTileId: 'root',
      tiles: {
        root: {
          id: 'root',
          children: [],
          bounds: { sphere: { center: [0, 0, 0], radius: 1 } },
          content: {
            low: { url: 'tiles/root/low.glb', bytes: 0 },
            medium: { url: 'tiles/root/low.glb', bytes: 0 },
            high: { url: 'tiles/root/low.glb', bytes: 0 }
          }
        }
      }
    }
  };
  await fs.writeFile(path.join(assetDir, 'asset.wmx.json'), JSON.stringify(manifest, null, 2), 'utf8');

  await convertAssetFolderToEncryptedBrotli({
    assetDir,
    encryptionKey: 'test-key'
  });

  await assert.rejects(() => fs.access(variantAbs));
  await assert.rejects(() => fs.access(tileAbs));
  const variantBr = `${variantAbs}.br`;
  const tileBr = `${tileAbs}.br`;
  await fs.access(variantBr);
  await fs.access(tileBr);

  const rewritten = JSON.parse(await fs.readFile(path.join(assetDir, 'asset.wmx.json'), 'utf8'));
  assert.equal(rewritten.variants.high.url, 'variants/high.glb.br');
  assert.equal(rewritten.streaming.tiles.root.content.low.url, 'tiles/root/low.glb.br');
  const variantSize = (await fs.stat(variantBr)).size;
  const tileSize = (await fs.stat(tileBr)).size;
  assert.equal(rewritten.variants.high.bytes, variantSize);
  assert.equal(rewritten.streaming.tiles.root.content.low.bytes, tileSize);
});

test('wmx-asset-server s3 publisher uploads expected keys and returns manifestUrl', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wmx-s3pub-'));
  const assetDir = path.join(tmp, 'asset');
  await fs.mkdir(path.join(assetDir, 'variants'), { recursive: true });
  await fs.writeFile(path.join(assetDir, 'asset.wmx.json'), '{"ok":true}', 'utf8');
  await fs.writeFile(path.join(assetDir, 'variants', 'high.glb.br'), Buffer.from([1, 2, 3]));

  const sends = [];
  const fakeClient = {
    send: async (command) => {
      sends.push(command.input);
      return {};
    }
  };

  const res = await publishAssetFolderToS3({
    assetDir,
    assetId: 'asset-id',
    config: {
      bucket: 'my-bucket',
      prefix: '3d-assets/wmx',
      region: 'us-east-1',
      publicBaseUrl: 'https://static.buildcores.com',
      forcePathStyle: false,
      makePublic: true
    },
    client: fakeClient
  });

  assert.equal(res.manifestUrl, 'https://static.buildcores.com/3d-assets/wmx/asset-id/asset.wmx.json');
  assert.equal(res.s3Prefix, '3d-assets/wmx/asset-id');
  assert.equal(res.uploadedCount, 2);
  assert.ok(sends.some((s) => s.Key === '3d-assets/wmx/asset-id/asset.wmx.json'));
  assert.ok(sends.some((s) => s.Key === '3d-assets/wmx/asset-id/variants/high.glb.br'));
  assert.ok(sends.every((s) => s.ACL === 'public-read'));
});

test('wmx-asset-server build succeeds without MODEL_ENCRYPTION_KEY and keeps plain .glb URLs', async () => {
  const repoRoot = path.resolve(process.cwd());
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wmx-asset-server-no-key-'));
  const dataDir = path.join(tmp, 'data');
  const sourceDir = path.join(dataDir, 'source');
  const outputDir = path.join(dataDir, 'wmx');
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.mkdir(outputDir, { recursive: true });

  const inputAbs = path.join(sourceDir, 'fixture.glb');
  await writeTinyGlb(inputAbs);

  const port = String(18080 + Math.floor(Math.random() * 1000));
  const serverEntry = path.join(repoRoot, 'packages', 'wmx-asset-server', 'dist', 'server.js');
  const child = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: port,
      WMX_DATA_DIR: dataDir,
      WMX_SOURCE_DIR: sourceDir,
      WMX_OUTPUT_DIR: outputDir,
      // Explicitly clear optional key to validate plain .glb mode.
      MODEL_ENCRYPTION_KEY: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d.toString();
  });

  try {
    await waitForHealth(`http://127.0.0.1:${port}`);

    const startRes = await fetchWithTimeout(`http://127.0.0.1:${port}/api/build-one`, 2000, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: 'fixture.glb',
        textures: 'png',
        thumbnails: false,
        streaming: false
      })
    });
    assert.equal(startRes.status, 200);
    const startJson = await startRes.json();
    assert.ok(startJson?.jobId);

    const job = await waitForJobTerminal(`http://127.0.0.1:${port}`, startJson.jobId);
    assert.equal(job.status, 'succeeded', `expected succeeded status; got ${job.status} (${job.error ?? 'no error'})`);

    const manifestPath = path.join(outputDir, 'fixture', 'asset.wmx.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    const urls = [
      manifest.variants?.low?.url,
      manifest.variants?.medium?.url,
      manifest.variants?.high?.url
    ].filter(Boolean);
    assert.ok(urls.length > 0);
    for (const u of urls) {
      assert.ok(String(u).endsWith('.glb'), `expected plain .glb URL, got ${u}`);
      assert.ok(!String(u).endsWith('.glb.br'), `did not expect .glb.br URL, got ${u}`);
    }

    const highPath = path.join(outputDir, 'fixture', 'variants', 'high.glb');
    await fs.access(highPath);
    await assert.rejects(() => fs.access(`${highPath}.br`));
  } finally {
    child.kill('SIGTERM');
    await onceExit(child).catch(() => {});
  }

  assert.equal(stderr.includes('Build failed'), false, `unexpected server stderr:\n${stderr}`);
});

test('wmx-asset-server build with MODEL_ENCRYPTION_KEY rewrites payload URLs to .glb.br', async () => {
  const repoRoot = path.resolve(process.cwd());
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wmx-asset-server-with-key-'));
  const dataDir = path.join(tmp, 'data');
  const sourceDir = path.join(dataDir, 'source');
  const outputDir = path.join(dataDir, 'wmx');
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.mkdir(outputDir, { recursive: true });

  const inputAbs = path.join(sourceDir, 'fixture.glb');
  await writeTinyGlb(inputAbs);

  const port = String(19080 + Math.floor(Math.random() * 1000));
  const serverEntry = path.join(repoRoot, 'packages', 'wmx-asset-server', 'dist', 'server.js');
  const child = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: port,
      WMX_DATA_DIR: dataDir,
      WMX_SOURCE_DIR: sourceDir,
      WMX_OUTPUT_DIR: outputDir,
      MODEL_ENCRYPTION_KEY: 'test-key'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d.toString();
  });

  try {
    await waitForHealth(`http://127.0.0.1:${port}`);

    const startRes = await fetchWithTimeout(`http://127.0.0.1:${port}/api/build-one`, 2000, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: 'fixture.glb',
        textures: 'png',
        thumbnails: false,
        streaming: false
      })
    });
    assert.equal(startRes.status, 200);
    const startJson = await startRes.json();
    assert.ok(startJson?.jobId);

    const job = await waitForJobTerminal(`http://127.0.0.1:${port}`, startJson.jobId);
    assert.equal(job.status, 'succeeded', `expected succeeded status; got ${job.status} (${job.error ?? 'no error'})`);

    const manifestPath = path.join(outputDir, 'fixture', 'asset.wmx.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    const urls = [
      manifest.variants?.low?.url,
      manifest.variants?.medium?.url,
      manifest.variants?.high?.url
    ].filter(Boolean);
    assert.ok(urls.length > 0);
    for (const u of urls) {
      assert.ok(String(u).endsWith('.glb.br'), `expected .glb.br URL, got ${u}`);
    }

    const highPath = path.join(outputDir, 'fixture', 'variants', 'high.glb');
    await fs.access(`${highPath}.br`);
    await assert.rejects(() => fs.access(highPath));
  } finally {
    child.kill('SIGTERM');
    await onceExit(child).catch(() => {});
  }

  assert.equal(stderr.includes('Build failed'), false, `unexpected server stderr:\n${stderr}`);
});

async function writeTinyGlb(outPath) {
  const doc = new Document();
  const buffer = doc.createBuffer('buf');

  const position = doc
    .createAccessor('POSITION')
    .setType('VEC3')
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
    .setBuffer(buffer);
  const indices = doc
    .createAccessor('indices')
    .setType('SCALAR')
    .setArray(new Uint16Array([0, 1, 2]))
    .setBuffer(buffer);

  const prim = doc.createPrimitive().setAttribute('POSITION', position).setIndices(indices);
  const mesh = doc.createMesh('Mesh').addPrimitive(prim);
  const node = doc.createNode('Node').setMesh(mesh);
  doc.createScene('Scene').addChild(node);

  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const glb = Buffer.from(await io.writeBinary(doc));
  await fs.writeFile(outPath, glb);
}

async function waitForHealth(baseUrl) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetchWithTimeout(`${baseUrl}/api/health`, 500);
      if (res.ok) return;
    } catch {
      // retry
    }
    await sleep(100);
  }
  throw new Error(`asset-server did not become healthy at ${baseUrl}`);
}

async function waitForJobTerminal(baseUrl, jobId) {
  for (let i = 0; i < 300; i++) {
    try {
      const res = await fetchWithTimeout(`${baseUrl}/api/build/${encodeURIComponent(jobId)}`, 1000);
      if (res.ok) {
        const json = await res.json();
        if (json.status === 'succeeded' || json.status === 'failed') return json;
      }
    } catch {
      // retry
    }
    await sleep(100);
  }
  throw new Error(`job ${jobId} did not finish in time`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function onceExit(child, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      resolve();
    }, timeoutMs);

    child.once('close', () => {
      clearTimeout(t);
      resolve();
    });
    child.once('error', (err) => {
      clearTimeout(t);
      reject(err);
    });
  });
}

async function fetchWithTimeout(url, timeoutMs, init) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}
