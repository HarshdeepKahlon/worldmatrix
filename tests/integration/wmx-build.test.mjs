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
  const position = doc.createAccessor('POSITION')
    .setType('VEC3')
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
    .setBuffer(buffer);
  const indices = doc.createAccessor('indices')
    .setType('SCALAR')
    .setArray(new Uint16Array([0, 1, 2]))
    .setBuffer(buffer);

  const prim = doc.createPrimitive().setAttribute('POSITION', position).setIndices(indices);
  const mesh = doc.createMesh('Triangle').addPrimitive(prim);
  const node = doc.createNode('Root').setMesh(mesh);
  const scene = doc.createScene('Scene');
  scene.addChild(node);

  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const glb = Buffer.from(await io.writeBinary(doc));
  await fs.writeFile(outPath, glb);
}

test('wmx build produces manifest + variants + stats', async () => {
  const repoRoot = path.resolve(process.cwd());
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wmx-it-'));
  const inputGlb = path.join(tmp, 'tiny.glb');
  await writeTinyGlb(inputGlb);

  const outDir = path.join(tmp, 'out');
  const cli = path.join(repoRoot, 'packages', 'wmx-cli', 'dist', 'cli.js');

  await execNode([cli, 'build', inputGlb, '--out', outDir, '--name', 'tiny-test', '--no-thumbnails'], { cwd: repoRoot });

  const assetDir = path.join(outDir, 'tiny-test');
  const manifestPath = path.join(assetDir, 'asset.wmx.json');
  const statsPath = path.join(assetDir, 'artifacts', 'stats.json');
  const lowPath = path.join(assetDir, 'variants', 'low.glb');
  const medPath = path.join(assetDir, 'variants', 'medium.glb');
  const highPath = path.join(assetDir, 'variants', 'high.glb');

  const [manifestText, statsText] = await Promise.all([fs.readFile(manifestPath, 'utf8'), fs.readFile(statsPath, 'utf8')]);
  const manifestJson = JSON.parse(manifestText);
  assert.ok(isWMXManifestV1(manifestJson));
  assert.equal(manifestJson.schemaVersion, '1.0');
  assert.equal(manifestJson.name, 'tiny-test');
  assert.equal(manifestJson.variants.low.url, 'variants/low.glb');

  const statsJson = JSON.parse(statsText);
  assert.equal(statsJson.name, 'tiny-test');

  const [lowSz, medSz, highSz] = await Promise.all([
    fs.stat(lowPath).then((s) => s.size),
    fs.stat(medPath).then((s) => s.size),
    fs.stat(highPath).then((s) => s.size)
  ]);

  assert.ok(lowSz > 0);
  assert.ok(medSz > 0);
  assert.ok(highSz > 0);
});

