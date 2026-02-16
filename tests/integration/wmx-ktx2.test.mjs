import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync, spawn } from 'node:child_process';

import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRTextureBasisu } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import zlib from 'node:zlib';

function hasCmd(cmd) {
  const res = spawnSync(cmd, ['--version'], { stdio: 'ignore' });
  return res.status === 0;
}

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

async function writeTexturedGlb(outPath) {
  const doc = new Document();
  const buffer = doc.createBuffer();

  // Non-uniform PNG so `prune()` doesn't collapse it to a factor.
  const png = makePng2x2();

  const tex = doc.createTexture('Tex');
  tex.setMimeType('image/png');
  tex.setImage(png);

  const mat = doc.createMaterial('Mat');
  mat.setBaseColorTexture(tex);

  const position = doc
    .createAccessor('POSITION')
    .setType('VEC3')
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
    .setBuffer(buffer);
  const uv = doc
    .createAccessor('TEXCOORD_0')
    .setType('VEC2')
    .setArray(new Float32Array([0, 0, 1, 0, 0, 1]))
    .setBuffer(buffer);
  const indices = doc
    .createAccessor('indices')
    .setType('SCALAR')
    .setArray(new Uint16Array([0, 1, 2]))
    .setBuffer(buffer);

  const prim = doc
    .createPrimitive()
    .setAttribute('POSITION', position)
    .setAttribute('TEXCOORD_0', uv)
    .setIndices(indices)
    .setMaterial(mat);
  const mesh = doc.createMesh('Triangle').addPrimitive(prim);
  const node = doc.createNode('Root').setMesh(mesh);
  doc.createScene('Scene').addChild(node);

  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const glb = Buffer.from(await io.writeBinary(doc));
  await fs.writeFile(outPath, glb);
}

function makePng2x2() {
  // 2x2 RGBA:
  // row0: red, green
  // row1: blue, white
  const pixels = Buffer.from([
    // filter byte 0 + 2 pixels
    0, 255, 0, 0, 255, 0, 255, 0, 255,
    // filter byte 0 + 2 pixels
    0, 0, 0, 255, 255, 255, 255, 255, 255
  ]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0); // width
  ihdr.writeUInt32BE(2, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const idat = zlib.deflateSync(pixels);

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function pngChunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

test(
  'wmx build --textures ktx2 emits KHR_texture_basisu when tools available',
  { skip: !(hasCmd('toktx') && hasCmd('ktxsc')) },
  async () => {
    const repoRoot = path.resolve(process.cwd());
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wmx-ktx2-'));
    const inputGlb = path.join(tmp, 'textured.glb');
    await writeTexturedGlb(inputGlb);

    const outDir = path.join(tmp, 'out');
    const cli = path.join(repoRoot, 'packages', 'wmx-cli', 'dist', 'cli.js');

    await execNode([cli, 'build', inputGlb, '--out', outDir, '--name', 'ktx2-test', '--textures', 'ktx2', '--no-thumbnails'], {
      cwd: repoRoot
    });

    const lowPath = path.join(outDir, 'ktx2-test', 'variants', 'low.glb');
    const lowBuf = await fs.readFile(lowPath);

    await MeshoptDecoder.ready;
    const io = new NodeIO()
      .registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
    const doc = await io.readBinary(new Uint8Array(lowBuf));

    const used = doc.getRoot().listExtensionsUsed();
    const names = used.map((ext) => ext.extensionName ?? ext.constructor?.name ?? '');
    const hasBasisu =
      names.includes('KHR_texture_basisu') ||
      names.includes('KHRTextureBasisu') ||
      used.some((ext) => ext instanceof KHRTextureBasisu);
    assert.ok(hasBasisu, `expected KHR_texture_basisu extension in output (got: ${names.join(', ')})`);
  }
);

