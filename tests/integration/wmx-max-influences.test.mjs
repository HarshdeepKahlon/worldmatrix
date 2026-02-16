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

async function writeSkinnedFixtureGlb(outPath) {
  const doc = new Document();
  const buffer = doc.createBuffer('buf');

  // Minimal geometry: one triangle.
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

  // 8 influences per vertex using JOINTS_0/1 and WEIGHTS_0/1.
  const joints0 = doc
    .createAccessor('JOINTS_0')
    .setType('VEC4')
    .setArray(new Uint16Array([0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3]))
    .setBuffer(buffer);
  const joints1 = doc
    .createAccessor('JOINTS_1')
    .setType('VEC4')
    .setArray(new Uint16Array([4, 5, 6, 7, 4, 5, 6, 7, 4, 5, 6, 7]))
    .setBuffer(buffer);
  const weights0 = doc
    .createAccessor('WEIGHTS_0')
    .setType('VEC4')
    .setArray(new Float32Array([0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2]))
    .setBuffer(buffer);
  const weights1 = doc
    .createAccessor('WEIGHTS_1')
    .setType('VEC4')
    .setArray(new Float32Array([0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05]))
    .setBuffer(buffer);

  const prim = doc
    .createPrimitive()
    .setIndices(indices)
    .setAttribute('POSITION', position)
    .setAttribute('JOINTS_0', joints0)
    .setAttribute('WEIGHTS_0', weights0)
    .setAttribute('JOINTS_1', joints1)
    .setAttribute('WEIGHTS_1', weights1);

  const mesh = doc.createMesh('SkinnedMesh').addPrimitive(prim);

  // Create joints for skin.
  const joints = [];
  for (let i = 0; i < 8; i++) {
    joints.push(doc.createNode(`J${i}`));
  }
  const skeletonRoot = doc.createNode('SkeletonRoot');
  joints.forEach((j) => skeletonRoot.addChild(j));

  const skin = doc.createSkin('Skin');
  joints.forEach((j) => skin.addJoint(j));
  // Ensure a skeleton root is set — some transforms (e.g. quantize) need this for skin math.
  skin.setSkeleton(skeletonRoot);
  // Provide inverse bind matrices (required by quantize() when skins are present).
  const I = new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1
  ]);
  const ibm = new Float32Array(16 * joints.length);
  for (let i = 0; i < joints.length; i++) ibm.set(I, i * 16);
  const ibmAcc = doc.createAccessor('IBM').setType('MAT4').setArray(ibm).setBuffer(buffer);
  if (typeof skin.setInverseBindMatrices !== 'function') {
    throw new Error('Expected glTF-Transform Skin.setInverseBindMatrices() to exist for this test fixture.');
  }
  skin.setInverseBindMatrices(ibmAcc);

  const node = doc.createNode('Root').setMesh(mesh);
  if (typeof node.setSkin !== 'function') {
    throw new Error('Expected glTF-Transform Node.setSkin() to exist for this test fixture.');
  }
  node.setSkin(skin);

  // Keep everything under one scene subtree for predictable world matrices.
  skeletonRoot.addChild(node);
  doc.createScene('Scene').addChild(skeletonRoot);

  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const glb = Buffer.from(await io.writeBinary(doc));
  await fs.writeFile(outPath, glb);
}

function countNonZeroInfluencesPerVertex(doc) {
  const root = doc.getRoot();
  const mesh = root.listMeshes()[0];
  const prim = mesh.listPrimitives()[0];

  const weightsAccessors = [];
  for (const sem of prim.listSemantics()) {
    if (!sem.startsWith('WEIGHTS_')) continue;
    weightsAccessors.push(prim.getAttribute(sem));
  }

  const counts = [];
  const arrays = weightsAccessors.map((a) => a.getArray());
  // Each WEIGHTS_* accessor is VEC4 => 4 floats/ints per vertex.
  const vertexCount = arrays[0].length / 4;
  for (let v = 0; v < vertexCount; v++) {
    let nonZero = 0;
    for (const arr of arrays) {
      for (let k = 0; k < 4; k++) {
        const w = Number(arr[v * 4 + k] ?? 0);
        if (w > 1e-4) nonZero++;
      }
    }
    counts.push(nonZero);
  }
  return counts;
}

test('wmx build --maxInfluences caps skinning influences per vertex', async () => {
  const repoRoot = path.resolve(process.cwd());
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wmx-maxinf-'));
  const inputGlb = path.join(tmp, 'input.glb');
  await writeSkinnedFixtureGlb(inputGlb);

  const outDir = path.join(tmp, 'out');
  const cli = path.join(repoRoot, 'packages', 'wmx-cli', 'dist', 'cli.js');

  await execNode(
    [cli, 'build', inputGlb, '--out', outDir, '--name', 'maxinf-test', '--no-thumbnails', '--maxInfluences', '4', '--textures', 'png'],
    { cwd: repoRoot }
  );

  await MeshoptDecoder.ready;
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'meshopt.decoder': MeshoptDecoder
    });

  const assetDir = path.join(outDir, 'maxinf-test');
  const mediumPath = path.join(assetDir, 'variants', 'medium.glb');
  const glb = await fs.readFile(mediumPath);
  const doc = await io.readBinary(new Uint8Array(glb));

  const counts = countNonZeroInfluencesPerVertex(doc);
  assert.ok(counts.length > 0);
  for (const c of counts) {
    assert.ok(c <= 4, `expected <=4 influences, got ${c}`);
  }
});

