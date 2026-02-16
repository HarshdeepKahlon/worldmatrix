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

async function writeTinyGlb(outPath) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const position = doc
    .createAccessor('POSITION')
    .setType('VEC3')
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
    .setBuffer(buffer);
  const indices = doc.createAccessor('indices').setType('SCALAR').setArray(new Uint16Array([0, 1, 2])).setBuffer(buffer);

  const prim = doc.createPrimitive().setAttribute('POSITION', position).setIndices(indices);
  const mesh = doc.createMesh('Triangle').addPrimitive(prim);
  const node = doc.createNode('Root').setMesh(mesh);
  doc.createScene('Scene').addChild(node);

  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const glb = Buffer.from(await io.writeBinary(doc));
  await fs.writeFile(outPath, glb);
}

test('wmx build-streaming writes manifest.streaming refine-tree', async () => {
  const repoRoot = path.resolve(process.cwd());
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wmx-it-'));
  const inputGlb = path.join(tmp, 'tiny.glb');
  await writeTinyGlb(inputGlb);

  const outDir = path.join(tmp, 'out');
  const cli = path.join(repoRoot, 'packages', 'wmx-cli', 'dist', 'cli.js');

  await execNode([cli, 'build-streaming', inputGlb, '--out', outDir, '--name', 'tiny-stream', '--no-thumbnails'], {
    cwd: repoRoot
  });

  const assetDir = path.join(outDir, 'tiny-stream');
  const manifestPath = path.join(assetDir, 'asset.wmx.json');

  const manifestJson = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  assert.ok(isWMXManifestV1(manifestJson));
  const streaming = manifestJson.streaming ?? manifestJson.extras?.streaming;
  assert.ok(streaming);
  assert.equal(streaming.schema, 'wmx-streaming-refine-tree@1');
  assert.equal(streaming.rootTileId, 'root');
  assert.ok(streaming.tiles?.root);
  assert.ok(streaming.tiles?.root?.bounds?.sphere?.radius >= 0);
});

