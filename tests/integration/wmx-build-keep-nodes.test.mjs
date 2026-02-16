import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
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

async function writeFixtureGlb(outPath) {
  const doc = new Document();
  const buffer = doc.createBuffer('buf');

  const makeTriMesh = (name, xOffset = 0) => {
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

  const root = doc.createNode('Root').setMesh(makeTriMesh('RootMesh', 0));
  const anchor = doc.createNode('DIMM_1').setMesh(makeTriMesh('AnchorMesh', 2));
  root.addChild(anchor);
  doc.createScene('Scene').addChild(root);

  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const glb = Buffer.from(await io.writeBinary(doc));
  await fs.writeFile(outPath, glb);
}

async function readNodeNames(glbPath) {
  await MeshoptDecoder.ready;
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'meshopt.decoder': MeshoptDecoder
    });
  const glb = await fs.readFile(glbPath);
  const doc = await io.readBinary(new Uint8Array(glb));
  const root = doc.getRoot();
  return root.listNodes().map((n) => n.getName()).filter(Boolean);
}

test('wmx keep-nodes-regex preserves anchor node names in ultraLow output', async () => {
  const repoRoot = path.resolve(process.cwd());
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wmx-keepnodes-'));
  const inputGlb = path.join(tmp, 'input.glb');
  await writeFixtureGlb(inputGlb);

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
      'keepnodes-test',
      '--no-thumbnails',
      '--stage',
      '2',
      '--keep-nodes-regex',
      'DIMM_'
    ],
    { cwd: repoRoot }
  );

  const assetDir = path.join(outDir, 'keepnodes-test');
  const manifestPath = path.join(assetDir, 'asset.wmx.json');
  const manifestJson = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  assert.ok(isWMXManifestV1(manifestJson));
  const streaming = manifestJson.streaming ?? manifestJson.extras?.streaming;
  assert.equal(streaming?.rootTileId, 'root');

  const ultraLowAbs = path.join(assetDir, manifestJson.variants.ultraLow.url);
  const nodeNames = await readNodeNames(ultraLowAbs);
  assert.ok(nodeNames.includes('DIMM_1'));
});

