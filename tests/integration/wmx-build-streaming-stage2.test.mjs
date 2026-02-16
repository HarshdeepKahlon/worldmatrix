import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { isWMXManifestV1 } from '../../packages/wmx-core/dist/index.js';

function execNode(args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`command failed (${code})\n${stdout}\n${stderr}`));
    });
  });
}

async function writeStage2FixtureGlb(outPath) {
  const doc = new Document();
  const buffer = doc.createBuffer();

  // A tiny triangle mesh helper.
  const makeTriMesh = (name, xOffset) => {
    const position = doc
      .createAccessor(`${name}-POSITION`)
      .setType('VEC3')
      .setArray(new Float32Array([0 + xOffset, 0, 0, 1 + xOffset, 0, 0, 0 + xOffset, 1, 0]))
      .setBuffer(buffer);
    const indices = doc
      .createAccessor(`${name}-indices`)
      .setType('SCALAR')
      .setArray(new Uint16Array([0, 1, 2]))
      .setBuffer(buffer);
    const prim = doc.createPrimitive().setAttribute('POSITION', position).setIndices(indices);
    return doc.createMesh(name).addPrimitive(prim);
  };

  const root = doc.createNode('Root');
  const childA = doc.createNode('ChildA').setMesh(makeTriMesh('MeshA', 0));
  const childB = doc.createNode('ChildB').setMesh(makeTriMesh('MeshB', 2)).setTranslation([2, 0, 0]);
  root.addChild(childA);
  root.addChild(childB);

  doc.createScene('Scene').addChild(root);

  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const glb = Buffer.from(await io.writeBinary(doc));
  await fs.writeFile(outPath, glb);
}

test('wmx build-streaming --stage 2 emits tiles/** and a populated refine tree', async () => {
  const repoRoot = path.resolve(process.cwd());
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wmx-it-'));
  const inputGlb = path.join(tmp, 'stage2.glb');
  await writeStage2FixtureGlb(inputGlb);

  const outDir = path.join(tmp, 'out');
  const cli = path.join(repoRoot, 'packages', 'wmx-cli', 'dist', 'cli.js');

  await execNode(
    [
      cli,
      'build-streaming',
      inputGlb,
      '--out',
      outDir,
      '--name',
      'stage2-test',
      '--no-thumbnails',
      '--stage',
      '2',
      '--streamingDepth',
      '1',
      '--maxTiles',
      '64',
      '--minTileTriangles',
      '0'
    ],
    { cwd: repoRoot }
  );

  const assetDir = path.join(outDir, 'stage2-test');
  const manifestPath = path.join(assetDir, 'asset.wmx.json');
  const manifestJson = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  assert.ok(isWMXManifestV1(manifestJson));

  const streaming = manifestJson.streaming ?? manifestJson.extras?.streaming;
  assert.equal(streaming?.schema, 'wmx-streaming-refine-tree@1');
  assert.equal(streaming?.rootTileId, 'root');
  assert.ok(streaming?.tiles?.root);

  // Root should have children when depth=1 and minTileTriangles=0.
  const rootChildren = streaming.tiles.root.children ?? [];
  assert.ok(rootChildren.length > 0);

  // Every non-root tile should have tile content URLs pointing at tiles/<tileId>/<quality>.glb.
  for (const tileId of rootChildren) {
    const t = streaming.tiles[tileId];
    assert.ok(t, `missing tile ${tileId}`);
    assert.ok(t.bounds?.aabb, `missing aabb bounds for tile ${tileId}`);
    assert.ok(t.content?.low?.url?.startsWith(`tiles/${tileId}/`));

    // Verify the GLBs exist on disk for a couple of qualities.
    const lowPath = path.join(assetDir, 'tiles', tileId, 'low.glb');
    const ultraPath = path.join(assetDir, 'tiles', tileId, 'ultraLow.glb');
    await fs.access(lowPath);
    await fs.access(ultraPath);
  }
});

