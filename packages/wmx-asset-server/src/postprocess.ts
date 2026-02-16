import { brotliCompress } from 'node:zlib';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { WMXManifestV1 } from '@worldmatrix/wmx-core';
import { isWMXManifestV1 } from '@worldmatrix/wmx-core';

const brotliCompressAsync = promisify(brotliCompress);

export async function convertAssetFolderToEncryptedBrotli(params: {
  assetDir: string;
  encryptionKey: string;
}): Promise<{ manifest: WMXManifestV1; transformedFiles: number }> {
  const manifestPath = path.join(params.assetDir, 'asset.wmx.json');
  const manifestRaw = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as unknown;
  if (!isWMXManifestV1(manifestRaw)) {
    throw new Error(`Invalid WMX manifest at ${manifestPath}`);
  }
  const manifest = manifestRaw as WMXManifestV1;

  const glbFiles = await listFilesRecursive(params.assetDir, (abs) => {
    const rel = path.relative(params.assetDir, abs).split(path.sep).join('/');
    return abs.endsWith('.glb') && (rel.startsWith('variants/') || rel.startsWith('tiles/'));
  });

  let transformedFiles = 0;
  for (const abs of glbFiles) {
    const input = await fs.readFile(abs);
    const compressed = await brotliCompressAsync(new Uint8Array(input));
    const encrypted = customEncrypt(new Uint8Array(compressed), params.encryptionKey);
    const outPath = `${abs}.br`;
    await fs.writeFile(outPath, encrypted);
    await fs.rm(abs, { force: true });
    transformedFiles += 1;
  }

  await rewriteManifestToBrotli(manifest, params.assetDir);
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  return { manifest, transformedFiles };
}

export function customEncrypt(data: Uint8Array, encryptionKey: string): Uint8Array {
  if (!encryptionKey) throw new Error('MODEL_ENCRYPTION_KEY is not defined');
  const buffer = Buffer.from(data);
  const result = Buffer.alloc(buffer.length);
  for (let i = 0; i < buffer.length; i++) {
    result[i] = buffer[i] ^ encryptionKey.charCodeAt(i % encryptionKey.length) ^ (i & 0xff);
  }
  return new Uint8Array(result);
}

async function rewriteManifestToBrotli(manifest: WMXManifestV1, assetDir: string) {
  for (const variant of Object.values(manifest.variants)) {
    if (!variant.url.endsWith('.glb')) continue;
    variant.url = `${variant.url}.br`;
    variant.bytes = await bytesForRelativePath(assetDir, variant.url);
  }

  const streaming = manifest.streaming;
  if (!streaming?.tiles) return;
  for (const tile of Object.values(streaming.tiles)) {
    const content = tile.content;
    if (!content) continue;
    for (const item of Object.values(content)) {
      if (!item?.url?.endsWith('.glb')) continue;
      item.url = `${item.url}.br`;
      item.bytes = await bytesForRelativePath(assetDir, item.url);
    }
  }
}

async function bytesForRelativePath(assetDir: string, relPath: string): Promise<number | undefined> {
  const abs = path.resolve(assetDir, relPath);
  try {
    const st = await fs.stat(abs);
    return st.size;
  } catch {
    return undefined;
  }
}

async function listFilesRecursive(root: string, predicate: (absPath: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) await walk(abs);
      else if (ent.isFile() && predicate(abs)) out.push(abs);
    }
  }
  await walk(root);
  out.sort();
  return out;
}
