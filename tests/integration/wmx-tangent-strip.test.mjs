import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

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

async function writeTangentFixtureGlb(outPath) {
  const doc = new Document();
  const buffer = doc.createBuffer('buf');

  const position = doc
    .createAccessor('POSITION')
    .setType('VEC3')
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
    .setBuffer(buffer);
  const normal = doc
    .createAccessor('NORMAL')
    .setType('VEC3')
    .setArray(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]))
    .setBuffer(buffer);
  const uv = doc
    .createAccessor('TEXCOORD_0')
    .setType('VEC2')
    .setArray(new Float32Array([0, 0, 1, 0, 0, 1]))
    .setBuffer(buffer);
  const tangent = doc
    .createAccessor('TANGENT')
    .setType('VEC4')
    .setArray(new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]))
    .setBuffer(buffer);
  const indices = doc
    .createAccessor('indices')
    .setType('SCALAR')
    .setArray(new Uint16Array([0, 1, 2]))
    .setBuffer(buffer);

  // Material without a normalTexture — tangents are safe to drop.
  // Add a baseColorTexture so UVs are definitely "in use" and won't be pruned.
  const png1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
    'base64'
  );
  const tex = doc.createTexture('tex').setImage(png1x1).setMimeType('image/png');
  const mat = doc
    .createMaterial('NoNormalMap')
    .setBaseColorFactor([1, 1, 1, 1])
    .setBaseColorTexture(tex);

  const prim = doc
    .createPrimitive()
    .setIndices(indices)
    .setAttribute('POSITION', position)
    .setAttribute('NORMAL', normal)
    .setAttribute('TEXCOORD_0', uv)
    .setAttribute('TANGENT', tangent)
    .setMaterial(mat);

  const mesh = doc.createMesh('M').addPrimitive(prim);
  const node = doc.createNode('Root').setMesh(mesh);
  doc.createScene('Scene').addChild(node);

  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const glb = Buffer.from(await io.writeBinary(doc));
  await fs.writeFile(outPath, glb);
}

async function listSemantics(glbPath) {
  await MeshoptDecoder.ready;
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'meshopt.decoder': MeshoptDecoder
    });
  const glb = await fs.readFile(glbPath);
  const doc = await io.readBinary(new Uint8Array(glb));
  const root = doc.getRoot();
  const mesh = root.listMeshes()[0];
  const prim = mesh.listPrimitives()[0];
  return prim.listSemantics();
}

test('wmx build strips tangents on low tiers when no normal map is present', async () => {
  const repoRoot = path.resolve(process.cwd());
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wmx-tangentstrip-'));
  const inputGlb = path.join(tmp, 'input.glb');
  await writeTangentFixtureGlb(inputGlb);

  const outDir = path.join(tmp, 'out');
  const cli = path.join(repoRoot, 'packages', 'wmx-cli', 'dist', 'cli.js');

  await execNode(
    [cli, 'build', inputGlb, '--out', outDir, '--name', 'tangentstrip-test', '--no-thumbnails', '--textures', 'png'],
    { cwd: repoRoot }
  );

  const assetDir = path.join(outDir, 'tangentstrip-test');
  const lowPath = path.join(assetDir, 'variants', 'low.glb');
  const ultraPath = path.join(assetDir, 'variants', 'ultraLow.glb');
  const highPath = path.join(assetDir, 'variants', 'high.glb');

  const lowSem = await listSemantics(lowPath);
  const ultraSem = await listSemantics(ultraPath);

  assert.ok(!lowSem.includes('TANGENT'), `expected low to drop TANGENT, got: ${lowSem.join(', ')}`);
  assert.ok(!ultraSem.includes('TANGENT'), `expected ultraLow to drop TANGENT, got: ${ultraSem.join(', ')}`);
  // High tier behavior is allowed to vary (prune may remove unused tangents); we only
  // enforce that low tiers do not carry unnecessary tangent data when normal maps aren't used.
});

