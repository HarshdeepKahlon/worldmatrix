#!/usr/bin/env node
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, instance, meshopt, prune, quantize, simplify, sortPrimitiveWeights, textureCompress, weld } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import draco3d from 'draco3dgltf';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import type { WMXManifestV1, WMXQuality, WMXVariantMetrics, WMXVariantRequirements } from '@worldmatrix/wmx-core';

type VariantConfig = {
  quality: WMXQuality;
  maxTextureSize: number;
  simplifyError?: number;
  simplifyRatio?: number;
  /** Lock topological borders during simplification (seam safety for chunked/tiled content). */
  lockBorders?: boolean;
  /** Vertex attribute quantization (KHR_mesh_quantization), in bits. */
  quantizePosition?: number;
  quantizeNormal?: number;
  quantizeTexcoord?: number;
  quantizeWeight?: number;
  /**
   * If true, remove TANGENT attribute when the material does not use a normal map.
   * Safe optimization: tangents are only required for normal mapping.
   */
  stripTangentsWhenNoNormalMap?: boolean;
};

type TexturesMode = 'auto' | 'png' | 'ktx2';

type StreamingStage = 1 | 2;

type StreamTileTRS = Partial<{
  translation: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
}>;

type StreamSphere = { center: [number, number, number]; radius: number };
type StreamAabb = { min: [number, number, number]; max: [number, number, number] };

type StreamTile = {
  id: string;
  parentId?: string;
  children: string[];
  refine?: 'replace' | 'add';
  transform?: StreamTileTRS;
  bounds: { sphere: StreamSphere; aabb?: StreamAabb };
  content?: Partial<Record<WMXQuality, { url: string; bytes?: number; metrics?: WMXVariantMetrics; requires?: any }>>;
};

function usage(exitCode = 0): never {
  // eslint-disable-next-line no-console
  console.log(`wmx (worldmatrix)

Usage:
  wmx build <input.glb> [--out <dir>] [--name <assetName>] [--textures auto|png|ktx2] [--no-thumbnails]
  wmx build-streaming <input.glb> [--out <dir>] [--name <assetName>] [--textures auto|png|ktx2] [--no-thumbnails] [--stage 1|2]
    Stage 1: adds extras.streaming (single root tile pointing at variants)
    Stage 2: emits tiles/<tileId>/<quality>.glb and a node-hierarchy refine tree
      Flags:
        --streamingDepth <n>       (default 1)
        --maxTiles <n>             (default 64)
        --minTileTriangles <n>     (default 20000)
  Optional:
        --keep-nodes-regex <regex> Keep matching node names intact across variants/tiles.
                                   Env fallback: WMX_KEEP_NODES_REGEX
        --maxInfluences <n>        Limit skinning joint influences per vertex (e.g. 4). Applies to all outputs.
        --lock-borders             Lock topological borders during simplification (helps avoid seams on chunked meshes).

Output:
  <out>/<assetNameOrId>/
    asset.wmx.json
    variants/ultraLow.glb|low.glb|medium.glb|high.glb
    artifacts/stats.json
    artifacts/thumbnail.png (optional)
`);
  process.exit(exitCode);
}

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  if (args.length === 0) usage(1);

  const cmd = args[0];
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();

  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const key = a.slice(2);
    if (key.startsWith('no-')) {
      flags.set(key.slice(3), false);
      continue;
    }
    const next = args[i + 1];
    if (!next || next.startsWith('--')) {
      flags.set(key, true);
    } else {
      flags.set(key, next);
      i++;
    }
  }

  return { cmd, positional, flags };
}

function sha256Hex(buffer: Buffer): string {
  // Node 24 types are strict about Buffer<ArrayBufferLike>.
  return crypto.createHash('sha256').update(new Uint8Array(buffer)).digest('hex');
}

function safeSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 64);
}

async function ensureDir(p: string) {
  await fs.mkdir(p, { recursive: true });
}

async function fileSizeBytes(p: string): Promise<number | undefined> {
  try {
    const st = await fs.stat(p);
    return st.size;
  } catch {
    return undefined;
  }
}

async function computeBasicMetrics(glb: Buffer): Promise<WMXVariantMetrics> {
  const io = await createIO();

  const doc = await io.readBinary(new Uint8Array(glb));
  const root = doc.getRoot();

  let triangles = 0;
  let primitives = 0;

  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      primitives++;
      const idx = prim.getIndices();
      if (idx) triangles += Math.floor(idx.getCount() / 3);
    }
  }

  const bounds = computeAabbBounds(root);

  return {
    triangles,
    primitives,
    meshes: root.listMeshes().length,
    textures: root.listTextures().length,
    materials: root.listMaterials().length,
    nodes: root.listNodes().length,
    animations: root.listAnimations().length,
    skins: root.listSkins().length,
    ...(bounds ? { bounds } : {})
  };
}

function computeAabbBounds(root: any): { min: [number, number, number]; max: [number, number, number] } | undefined {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute?.('POSITION');
      if (!pos) continue;
      const arr: ArrayLike<number> | undefined = pos.getArray?.();
      if (!arr || (arr as any).length < 3) continue;
      for (let i = 0; i + 2 < (arr as any).length; i += 3) {
        const x = (arr as any)[i] as number;
        const y = (arr as any)[i + 1] as number;
        const z = (arr as any)[i + 2] as number;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        minZ = Math.min(minZ, z);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        maxZ = Math.max(maxZ, z);
      }
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return undefined;
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

function aabbToSphere(aabb: { min: [number, number, number]; max: [number, number, number] }) {
  const cx = (aabb.min[0] + aabb.max[0]) / 2;
  const cy = (aabb.min[1] + aabb.max[1]) / 2;
  const cz = (aabb.min[2] + aabb.max[2]) / 2;
  const dx = aabb.max[0] - aabb.min[0];
  const dy = aabb.max[1] - aabb.min[1];
  const dz = aabb.max[2] - aabb.min[2];
  const radius = 0.5 * Math.sqrt(dx * dx + dy * dy + dz * dz);
  return { center: [cx, cy, cz] as [number, number, number], radius };
}

function streamingFromManifest(manifest: WMXManifestV1) {
  const bounds =
    manifest.variants.medium.metrics?.bounds ??
    manifest.variants.high.metrics?.bounds ??
    manifest.variants.low.metrics?.bounds ??
    ({ min: [-1, -1, -1], max: [1, 1, 1] } as const);

  const sphere = aabbToSphere(bounds);

  return {
    schema: 'wmx-streaming-refine-tree@1',
    rootTileId: 'root',
    tiles: {
      root: {
        id: 'root',
        children: [],
        refine: 'replace',
        bounds: { sphere },
        content: {
          ultraLow: (manifest.variants as any).ultraLow,
          low: manifest.variants.low,
          medium: manifest.variants.medium,
          high: manifest.variants.high
        }
      }
    }
  };
}

function parseIntFlag(flags: Map<string, string | boolean>, key: string, fallback: number): number {
  const v = flags.get(key);
  if (typeof v !== 'string') return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseStage(flags: Map<string, string | boolean>): StreamingStage {
  const v = flags.get('stage');
  if (v === true) return 1;
  if (typeof v !== 'string') return 1;
  const n = Number.parseInt(v, 10);
  return n === 2 ? 2 : 1;
}

let dracoDepsPromise:
  | Promise<{
      decoder: unknown;
      encoder: unknown;
    }>
  | null = null;

async function getDracoDeps() {
  if (!dracoDepsPromise) {
    dracoDepsPromise = Promise.all([draco3d.createDecoderModule(), draco3d.createEncoderModule()]).then(
      ([decoder, encoder]) => ({ decoder, encoder })
    );
  }
  return dracoDepsPromise;
}

async function createIO(): Promise<NodeIO> {
  await MeshoptDecoder.ready;
  await MeshoptEncoder.ready;
  const draco = await getDracoDeps();

  return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'meshopt.decoder': MeshoptDecoder,
    'meshopt.encoder': MeshoptEncoder,
    // Needed to read assets that already use Draco compression.
    'draco3d.decoder': draco.decoder,
    'draco3d.encoder': draco.encoder
  });
}

async function tryTransformTextures(doc: any, maxTextureSize: number): Promise<void> {
  // `sharp` is optional: it can be painful to install on some systems.
  // If it's unavailable, we just skip image transcoding/resizing in v1.
  let sharp: any;
  try {
    sharp = (await import('sharp')).default;
  } catch {
    return;
  }

  try {
    await doc.transform(
      textureCompress({
        encoder: sharp,
        targetFormat: 'png',
        effort: 80,
        quality: 70,
        resize: [maxTextureSize, maxTextureSize]
      })
    );
  } catch (e: any) {
    // Best-effort: texture tooling can fail on odd/invalid inputs; do not fail the whole build.
    // eslint-disable-next-line no-console
    console.warn(`[wmx] Texture transform skipped (sharp error): ${e?.message ?? String(e)}`);
  }
}

async function buildVariant(inputGlb: Buffer, cfg: VariantConfig): Promise<Buffer> {
  const io = await createIO();

  const doc = await io.readBinary(new Uint8Array(inputGlb));
  const keepNodesRegex = activeKeepNodesRegex;
  const preservedNodeNames = keepNodesRegex ? findMatchingNodeNames(doc, keepNodesRegex) : [];
  const preserveAnchorNodes = preservedNodeNames.length > 0;

  // Note: `weld()` only merges bitwise-identical vertices. For `low`/`ultraLow`,
  // we run an additional weld pass after quantization, which increases the chance
  // that vertices become identical and can be merged.
  await doc.transform(
    dedup(),
    // If a scene reuses the same Mesh multiple times, emit EXT_mesh_gpu_instancing.
    // This is primarily a runtime perf optimization (draw calls), and is broadly
    // supported by modern engines.
    instance({ min: 5 }),
    weld({ overwrite: true }),
    // Keep empty leaves too, so author-defined anchor points survive cleanup.
    prune({ keepLeaves: true })
  );

  // Preserve author-defined anchor meshes/nodes used for parenting/attachment.
  // When present, avoid lossy geometry transforms that can collapse these markers.
  if (!preserveAnchorNodes && cfg.simplifyError !== undefined) {
    await doc.transform(
      simplify({
        simplifier: MeshoptSimplifier,
        ratio: cfg.simplifyRatio ?? 0,
        error: cfg.simplifyError,
        lockBorder: !!cfg.lockBorders
      })
    );
  }

  if (activeMaxInfluences && !preserveAnchorNodes) {
    applyMaxInfluences(doc, activeMaxInfluences);
  } else if (activeMaxInfluences) {
    // Still safe to apply in preserve mode; it doesn't alter node hierarchy.
    applyMaxInfluences(doc, activeMaxInfluences);
  }

  if (
    !preserveAnchorNodes &&
    (cfg.quantizePosition || cfg.quantizeNormal || cfg.quantizeTexcoord || cfg.quantizeWeight)
  ) {
    await doc.transform(
      quantize({
        ...(cfg.quantizePosition ? { quantizePosition: cfg.quantizePosition } : {}),
        ...(cfg.quantizeNormal ? { quantizeNormal: cfg.quantizeNormal } : {}),
        ...(cfg.quantizeTexcoord ? { quantizeTexcoord: cfg.quantizeTexcoord } : {}),
        ...(cfg.quantizeWeight ? { quantizeWeight: cfg.quantizeWeight } : {})
      })
    );

    if (cfg.quality === 'low' || cfg.quality === 'ultraLow') {
      await doc.transform(weld({ overwrite: true }));
    }
  }

  if (cfg.stripTangentsWhenNoNormalMap) {
    stripTangentsWhenSafe(doc);
  }

  await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'high' }));

  if (preserveAnchorNodes) {
    // eslint-disable-next-line no-console
    console.log(`[wmx] keep-nodes-regex matched ${preservedNodeNames.length} node(s); skipped lossy transforms for this variant.`);
  }

  await tryTransformTextures(doc, cfg.maxTextureSize);

  return Buffer.from(await io.writeBinary(doc));
}

let activeKeepNodesRegex: RegExp | null = null;
let activeMaxInfluences: number | null = null;

function applyMaxInfluences(doc: any, maxInfluences: number) {
  const root = doc.getRoot?.();
  for (const mesh of root?.listMeshes?.() ?? []) {
    for (const prim of mesh.listPrimitives?.() ?? []) {
      const hasJoints0 = !!prim.getAttribute?.('JOINTS_0');
      const hasWeights0 = !!prim.getAttribute?.('WEIGHTS_0');
      if (!hasJoints0 || !hasWeights0) continue;
      try {
        sortPrimitiveWeights(prim, maxInfluences);
      } catch {
        // Best-effort: never fail the build for this optional optimization.
      }
    }
  }
}

function stripTangentsWhenSafe(doc: any) {
  const root = doc.getRoot?.();
  for (const mesh of root?.listMeshes?.() ?? []) {
    for (const prim of mesh.listPrimitives?.() ?? []) {
      const hasTangent = !!prim.getAttribute?.('TANGENT');
      if (!hasTangent) continue;
      const mat = prim.getMaterial?.();
      const anyMat = mat as any;
      const normalTex = anyMat?.getNormalTexture?.() ?? anyMat?.getNormalTextureInfo?.()?.texture;
      const hasNormalMap = !!normalTex;
      if (hasNormalMap) continue;
      try {
        prim.removeAttribute?.('TANGENT');
      } catch {
        // ignore
      }
    }
  }
}

function parseKeepNodesRegex(flags: Map<string, string | boolean>): RegExp | null {
  const raw = (flags.get('keep-nodes-regex') as string | undefined) ?? process.env.WMX_KEEP_NODES_REGEX;
  if (!raw || !raw.trim()) return null;
  try {
    return new RegExp(raw);
  } catch (error) {
    throw new Error(`Invalid --keep-nodes-regex / WMX_KEEP_NODES_REGEX: ${raw}. ${String(error)}`);
  }
}

function findMatchingNodeNames(doc: any, regex: RegExp): string[] {
  const root = doc.getRoot?.();
  const seen = new Set<string>();
  for (const node of root?.listNodes?.() ?? []) {
    const name = String(node.getName?.() ?? '');
    if (!name) continue;
    if (regex.test(name)) {
      seen.add(name);
    }
    regex.lastIndex = 0;
  }
  return Array.from(seen.values()).sort();
}

async function extractSubtreeGlb(params: {
  sourceGlb: Buffer;
  /** Path of child indices from the scene root to the node. Empty means whole scene. */
  nodePath: number[];
  /** If true, zero out the selected node's TRS in the output GLB (so TRS can live in manifest tile.transform). */
  zeroSelectedNodeTrs: boolean;
}): Promise<Buffer> {
  const io = await createIO();
  const doc = await io.readBinary(new Uint8Array(params.sourceGlb));
  const root = doc.getRoot() as any;
  const scene = (root.listScenes?.() ?? [])[0];
  if (!scene) return Buffer.from(await io.writeBinary(doc));

  const sceneChildren: any[] = scene.listChildren?.() ?? [];
  let selected: any | null = null;
  if (params.nodePath.length === 0) {
    // Whole scene: keep as-is.
    selected = null;
  } else {
    selected = sceneChildren[params.nodePath[0]] ?? null;
    for (let i = 1; i < params.nodePath.length && selected; i++) {
      const kids: any[] = selected.listChildren?.() ?? [];
      selected = kids[params.nodePath[i]] ?? null;
    }
    if (!selected) {
      return Buffer.from(await io.writeBinary(doc));
    }

    // Keep only the selected node as the scene root.
    sceneChildren.forEach((c) => scene.removeChild?.(c));
    scene.addChild?.(selected);

    if (params.zeroSelectedNodeTrs) {
      selected.setTranslation?.([0, 0, 0]);
      selected.setRotation?.([0, 0, 0, 1]);
      selected.setScale?.([1, 1, 1]);
    }
  }

  // Prune removes unreachable content now that the scene roots were replaced.
  await (doc as any).transform(prune());
  return Buffer.from(await io.writeBinary(doc));
}

function getNodeAtPath(doc: any, nodePath: number[]): any | null {
  const root = doc.getRoot?.();
  const scene = (root?.listScenes?.() ?? [])[0];
  if (!scene) return null;
  const sceneChildren: any[] = scene.listChildren?.() ?? [];
  if (nodePath.length === 0) return null;
  let n: any | null = sceneChildren[nodePath[0]] ?? null;
  for (let i = 1; i < nodePath.length && n; i++) {
    const kids: any[] = n.listChildren?.() ?? [];
    n = kids[nodePath[i]] ?? null;
  }
  return n;
}

function nodeLocalTrs(node: any): StreamTileTRS {
  const t = (node?.getTranslation?.() ?? [0, 0, 0]) as [number, number, number];
  const r = (node?.getRotation?.() ?? [0, 0, 0, 1]) as [number, number, number, number];
  const s = (node?.getScale?.() ?? [1, 1, 1]) as [number, number, number];
  return { translation: [t[0], t[1], t[2]], rotation: [r[0], r[1], r[2], r[3]], scale: [s[0], s[1], s[2]] };
}

function matMul(a: number[], b: number[]): number[] {
  const out = new Array(16).fill(0);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      out[r * 4 + c] =
        a[r * 4 + 0] * b[0 * 4 + c] +
        a[r * 4 + 1] * b[1 * 4 + c] +
        a[r * 4 + 2] * b[2 * 4 + c] +
        a[r * 4 + 3] * b[3 * 4 + c];
    }
  }
  return out;
}

function trsToMat4(trs: StreamTileTRS): number[] {
  const t = trs.translation ?? [0, 0, 0];
  const q = trs.rotation ?? [0, 0, 0, 1];
  const s = trs.scale ?? [1, 1, 1];
  const x = q[0], y = q[1], z = q[2], w = q[3];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;

  const sx = s[0], sy = s[1], sz = s[2];

  // Column-major-like numbers but we’ll use consistent multiplication above.
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    t[0], t[1], t[2], 1
  ];
}

function transformPoint(m: number[], p: [number, number, number]): [number, number, number] {
  const x = p[0], y = p[1], z = p[2];
  const tx = m[0] * x + m[4] * y + m[8] * z + m[12];
  const ty = m[1] * x + m[5] * y + m[9] * z + m[13];
  const tz = m[2] * x + m[6] * y + m[10] * z + m[14];
  return [tx, ty, tz];
}

function updateBoundsFromAabbWithMat(bounds: { min: number[]; max: number[] }, aabb: { min: [number, number, number]; max: [number, number, number] }, m: number[]) {
  const corners: [number, number, number][] = [
    [aabb.min[0], aabb.min[1], aabb.min[2]],
    [aabb.min[0], aabb.min[1], aabb.max[2]],
    [aabb.min[0], aabb.max[1], aabb.min[2]],
    [aabb.min[0], aabb.max[1], aabb.max[2]],
    [aabb.max[0], aabb.min[1], aabb.min[2]],
    [aabb.max[0], aabb.min[1], aabb.max[2]],
    [aabb.max[0], aabb.max[1], aabb.min[2]],
    [aabb.max[0], aabb.max[1], aabb.max[2]]
  ];
  for (const c of corners) {
    const p = transformPoint(m, c);
    bounds.min[0] = Math.min(bounds.min[0], p[0]);
    bounds.min[1] = Math.min(bounds.min[1], p[1]);
    bounds.min[2] = Math.min(bounds.min[2], p[2]);
    bounds.max[0] = Math.max(bounds.max[0], p[0]);
    bounds.max[1] = Math.max(bounds.max[1], p[1]);
    bounds.max[2] = Math.max(bounds.max[2], p[2]);
  }
}

function computeSubtreeBounds(params: {
  doc: any;
  nodePath: number[];
  excludeRootTransform: boolean;
}): { sphere: StreamSphere; aabb?: StreamAabb } {
  const root = params.doc.getRoot?.();
  const scene = (root?.listScenes?.() ?? [])[0];
  if (!scene) return { sphere: { center: [0, 0, 0], radius: 1 } };

  const selected = params.nodePath.length ? getNodeAtPath(params.doc, params.nodePath) : null;
  const startNodes: any[] = selected ? [selected] : (scene.listChildren?.() ?? []);

  const bounds = { min: [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY], max: [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY] };

  const walk = (node: any, parentMat: number[], isRoot: boolean) => {
    const trs = nodeLocalTrs(node);
    const local = params.excludeRootTransform && isRoot ? trsToMat4({}) : trsToMat4(trs);
    const mat = matMul(parentMat, local);

    const mesh = node.getMesh?.();
    if (mesh) {
      for (const prim of mesh.listPrimitives?.() ?? []) {
        const pos = prim.getAttribute?.('POSITION');
        if (!pos) continue;
        const arr: any = pos.getArray?.();
        if (!arr || arr.length < 3) continue;
        let minX = Number.POSITIVE_INFINITY, minY = Number.POSITIVE_INFINITY, minZ = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY, maxY = Number.NEGATIVE_INFINITY, maxZ = Number.NEGATIVE_INFINITY;
        for (let i = 0; i + 2 < arr.length; i += 3) {
          const x = arr[i] as number;
          const y = arr[i + 1] as number;
          const z = arr[i + 2] as number;
          minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
          maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
        }
        if (!Number.isFinite(minX) || !Number.isFinite(maxX)) continue;
        updateBoundsFromAabbWithMat(bounds, { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] }, mat);
      }
    }

    for (const child of node.listChildren?.() ?? []) {
      walk(child, mat, false);
    }
  };

  const I = [1, 0, 0, 0,
             0, 1, 0, 0,
             0, 0, 1, 0,
             0, 0, 0, 1];

  for (const n of startNodes) walk(n, I, true);

  if (!Number.isFinite(bounds.min[0]) || !Number.isFinite(bounds.max[0])) {
    return { sphere: { center: [0, 0, 0], radius: 1 } };
  }

  const cx = (bounds.min[0] + bounds.max[0]) / 2;
  const cy = (bounds.min[1] + bounds.max[1]) / 2;
  const cz = (bounds.min[2] + bounds.max[2]) / 2;
  const dx = bounds.max[0] - bounds.min[0];
  const dy = bounds.max[1] - bounds.min[1];
  const dz = bounds.max[2] - bounds.min[2];
  const radius = 0.5 * Math.sqrt(dx * dx + dy * dy + dz * dz);
  return {
    sphere: { center: [cx, cy, cz], radius: Math.max(1e-6, radius) },
    aabb: {
      min: [bounds.min[0], bounds.min[1], bounds.min[2]],
      max: [bounds.max[0], bounds.max[1], bounds.max[2]]
    }
  };
}

  async function buildTileVariant(params: {
  sourceGlb: Buffer;
  nodePath: number[];
  quality: WMXQuality;
  cfg: VariantConfig;
  ktx2Available: boolean;
  texturesMode: TexturesMode;
  outAbs: string;
  requiresByQuality: Record<WMXQuality, WMXVariantRequirements>;
  /** If provided, `ultraLow` is derived from this already-built low tile buffer. */
  baseOverride?: Buffer;
}): Promise<{ bytes: number; metrics: WMXVariantMetrics }> {
  const base = params.baseOverride ?? (await extractSubtreeGlb({ sourceGlb: params.sourceGlb, nodePath: params.nodePath, zeroSelectedNodeTrs: params.nodePath.length > 0 }));
  const out = await buildVariant(base, params.cfg);
  await fs.writeFile(params.outAbs, new Uint8Array(out));

  if (params.cfg.quantizePosition || params.cfg.quantizeNormal || params.cfg.quantizeTexcoord) {
    params.requiresByQuality[params.quality].KHR_mesh_quantization = true;
  }

  if (params.ktx2Available && (params.texturesMode === 'ktx2' || params.texturesMode === 'auto')) {
    const initialMetrics = await computeBasicMetrics(out);
    if ((initialMetrics.textures ?? 0) > 0) {
      const etc1sQuality =
        params.quality === 'ultraLow' ? 4 : params.quality === 'low' ? 15 : params.quality === 'medium' ? 100 : 150;
      const tmpOut = path.join(os.tmpdir(), `wmx-tile-${params.quality}-${Date.now()}-${Math.random().toString(16).slice(2)}.glb`);
      await compressTexturesToKtx2({ inputGlbPath: params.outAbs, outputGlbPath: tmpOut, etc1sQuality });
      await fs.copyFile(tmpOut, params.outAbs);
      await fs.rm(tmpOut, { force: true }).catch(() => {});
      params.requiresByQuality[params.quality].KHR_texture_basisu = true;
    }
  }

  const finalBuf = await fs.readFile(params.outAbs);
  const metrics = await computeBasicMetrics(finalBuf);
  const bytes = finalBuf.byteLength;
  return { bytes, metrics };
}

function hasCommand(cmd: string): boolean {
  const res = spawnSync(cmd, ['--version'], { stdio: 'ignore' });
  return res.status === 0;
}

function canUseKtx2Tools(): boolean {
  // gltf-transform uses KTX-Software binaries (toktx and ktxsc) for KTX2 output.
  // We keep this as an opt-in, best-effort feature.
  return hasCommand('toktx') && hasCommand('ktxsc');
}

function resolveGltfTransformCliPath(): string {
  const require = createRequire(import.meta.url);
  const entry = require.resolve('@gltf-transform/cli');
  // entry is something like: .../node_modules/@gltf-transform/cli/dist/cli.esm.js
  // bin lives at:          .../node_modules/@gltf-transform/cli/bin/cli.js
  const pkgDir = path.resolve(path.dirname(entry), '..');
  return path.join(pkgDir, 'bin', 'cli.js');
}

async function runGltfTransformCli(args: string[]): Promise<void> {
  const cli = resolveGltfTransformCliPath();
  const res = spawnSync(process.execPath, [cli, ...args], {
    stdio: 'inherit',
    env: process.env
  });
  if (res.status !== 0) {
    throw new Error(`[wmx] gltf-transform failed: gltf-transform ${args.join(' ')}`);
  }
}

async function compressTexturesToKtx2(params: { inputGlbPath: string; outputGlbPath: string; etc1sQuality: number }) {
  // Default to ETC1S for v1 — fast and widely applicable. UASTC/hybrid can be added later.
  await runGltfTransformCli([
    'etc1s',
    params.inputGlbPath,
    params.outputGlbPath,
    '--quality',
    String(params.etc1sQuality)
  ]);
}

async function maybeRenderThumbnail(params: {
  glbPath: string;
  pngPath: string;
}): Promise<{ ok: boolean; reason?: string }> {
  try {
    // Optional dependency: avoid a hard TypeScript dependency by using require().
    const require = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod: any = require('@shopify/screenshot-glb');
    const screenshotGlb = mod.default ?? mod.screenshotGlb ?? mod;

    if (typeof screenshotGlb !== 'function') {
      return { ok: false, reason: 'unexpected @shopify/screenshot-glb export shape' };
    }

    await screenshotGlb(params.glbPath, params.pngPath, {
      width: 512,
      height: 512,
      transparent: true
    });

    return { ok: true };
  } catch (e: any) {
    const message = e?.message ?? String(e);
    const lower = String(message).toLowerCase();

    if (lower.includes('cannot find module') || lower.includes('module_not_found')) {
      return {
        ok: false,
        reason: `@shopify/screenshot-glb is not installed (${message})`
      };
    }

    if (
      lower.includes('puppeteer') ||
      lower.includes('chrome') ||
      lower.includes('chromium') ||
      lower.includes('failed to launch') ||
      lower.includes('libx') ||
      lower.includes('gtk')
    ) {
      return {
        ok: false,
        reason: `headless Chrome unavailable (install Linux X11/GTK deps in Docker): ${message}`
      };
    }

    if (lower.includes('timeout')) {
      return { ok: false, reason: `thumbnail render timeout: ${message}` };
    }

    return { ok: false, reason: message };
  }
}

async function main() {
  const { cmd, positional, flags } = parseArgs(process.argv);
  const isBuild = cmd === 'build' || cmd === 'build-streaming';
  if (!isBuild) usage(1);
  const streamingEnabled = cmd === 'build-streaming';
  const streamingStage: StreamingStage = streamingEnabled ? parseStage(flags) : 1;
  const streamingDepth = streamingEnabled ? parseIntFlag(flags, 'streamingDepth', 1) : 1;
  const maxTiles = streamingEnabled ? parseIntFlag(flags, 'maxTiles', 64) : 64;
  const minTileTriangles = streamingEnabled ? parseIntFlag(flags, 'minTileTriangles', 20_000) : 20_000;

  const inputPath = positional[0];
  if (!inputPath) usage(1);

  const outRoot = (flags.get('out') as string | undefined) ?? 'dist';
  const nameArg = flags.get('name') as string | undefined;
  const thumbnailsEnabled = flags.get('thumbnails') !== false;
  const texturesMode = ((flags.get('textures') as string | undefined) ?? 'auto') as TexturesMode;
  activeKeepNodesRegex = parseKeepNodesRegex(flags);
  activeMaxInfluences = (() => {
    const raw = flags.get('maxInfluences');
    if (typeof raw !== 'string') return null;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid --maxInfluences: ${raw}`);
    return n;
  })();
  const lockBorders = flags.get('lock-borders') === true;

  const inputAbs = path.resolve(process.cwd(), inputPath);
  const inputBytes = await fs.readFile(inputAbs);
  const assetId = sha256Hex(inputBytes);

  const baseName =
    nameArg ??
    safeSlug(path.basename(inputAbs).replace(path.extname(inputAbs), '')) ??
    assetId.slice(0, 12);

  const outDir = path.resolve(process.cwd(), outRoot, baseName);
  const variantsDir = path.join(outDir, 'variants');
  const artifactsDir = path.join(outDir, 'artifacts');

  await ensureDir(variantsDir);
  await ensureDir(artifactsDir);

  const configs: VariantConfig[] = [
    // Build `low` first so `ultraLow` can be derived from it (monotonic triangle counts).
    {
      quality: 'low',
      maxTextureSize: 256,
      simplifyError: 0.005,
      simplifyRatio: 0,
      lockBorders,
      quantizePosition: 12,
      quantizeNormal: 8,
      quantizeTexcoord: 10,
      quantizeWeight: 8,
      stripTangentsWhenNoNormalMap: true
    },
    // More aggressive than `low`: intended for very memory-constrained devices.
    // Derived from `low` output to avoid surprising cases where triangles go up.
    {
      quality: 'ultraLow',
      maxTextureSize: 64,
      simplifyError: 0.14,
      simplifyRatio: 0.1,
      lockBorders,
      quantizePosition: 10,
      quantizeNormal: 8,
      quantizeTexcoord: 10,
      quantizeWeight: 8,
      stripTangentsWhenNoNormalMap: true
    },
    { quality: 'medium', maxTextureSize: 512, quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 14, quantizeWeight: 10 },
    // High quality: quantize too (big VRAM win vs float32 attributes).
    { quality: 'high', maxTextureSize: 2048, quantizePosition: 16, quantizeNormal: 12, quantizeTexcoord: 16, quantizeWeight: 12 }
  ];

  const variantRel = (q: WMXQuality) => `variants/${q}.glb`;
  const variantOutAbs = (q: WMXQuality) => path.join(outDir, variantRel(q));

  const metricsByQuality: Record<WMXQuality, WMXVariantMetrics> = {
    ultraLow: {},
    low: {},
    medium: {},
    high: {}
  };

  const requiresByQuality: Record<WMXQuality, WMXVariantRequirements> = {
    ultraLow: { EXT_meshopt_compression: true },
    low: { EXT_meshopt_compression: true },
    medium: { EXT_meshopt_compression: true },
    high: { EXT_meshopt_compression: true }
  };

  const ktx2Allowed = texturesMode === 'ktx2' || texturesMode === 'auto';
  const ktx2Available = ktx2Allowed && canUseKtx2Tools();
  if ((texturesMode === 'ktx2' || texturesMode === 'auto') && !ktx2Available) {
    // eslint-disable-next-line no-console
    console.warn(
      '[wmx] KTX2 tools not found (need `toktx` and `ktxsc`). Continuing without KTX2. (Install KTX-Software, e.g. `brew install ktx-software`.)'
    );
  }

  const built: Partial<Record<WMXQuality, Buffer>> = {};

  for (const cfg of configs) {
    const outPath = variantOutAbs(cfg.quality);
    const baseInput = cfg.quality === 'ultraLow' && built.low ? built.low : inputBytes;
    const out = await buildVariant(baseInput, cfg);
    await fs.writeFile(outPath, new Uint8Array(out));
    if (cfg.quantizePosition || cfg.quantizeNormal || cfg.quantizeTexcoord || cfg.quantizeWeight) {
      requiresByQuality[cfg.quality].KHR_mesh_quantization = true;
    }

    // If enabled and tools available, produce a KTX2-textured output via gltf-transform CLI.
    if (ktx2Available && (texturesMode === 'ktx2' || texturesMode === 'auto')) {
      const initialMetrics = await computeBasicMetrics(out);
      if ((initialMetrics.textures ?? 0) > 0) {
        const etc1sQuality =
          cfg.quality === 'ultraLow' ? 4 : cfg.quality === 'low' ? 15 : cfg.quality === 'medium' ? 100 : 150;
        const tmpOut = path.join(os.tmpdir(), `wmx-${assetId.slice(0, 8)}-${cfg.quality}-${Date.now()}.glb`);
        await compressTexturesToKtx2({ inputGlbPath: outPath, outputGlbPath: tmpOut, etc1sQuality });
        await fs.copyFile(tmpOut, outPath);
        await fs.rm(tmpOut, { force: true }).catch(() => {});
        requiresByQuality[cfg.quality].KHR_texture_basisu = true;
      }
    }

    const finalBuf = await fs.readFile(outPath);
    built[cfg.quality] = finalBuf;
    metricsByQuality[cfg.quality] = await computeBasicMetrics(finalBuf);
  }

  const stats = {
    assetId,
    name: baseName,
    source: {
      filename: path.basename(inputAbs),
      bytes: inputBytes.byteLength
    },
    variants: {
      ultraLow: { bytes: await fileSizeBytes(variantOutAbs('ultraLow')), metrics: metricsByQuality.ultraLow },
      low: { bytes: await fileSizeBytes(variantOutAbs('low')), metrics: metricsByQuality.low },
      medium: { bytes: await fileSizeBytes(variantOutAbs('medium')), metrics: metricsByQuality.medium },
      high: { bytes: await fileSizeBytes(variantOutAbs('high')), metrics: metricsByQuality.high }
    }
  };

  const statsRel = 'artifacts/stats.json';
  await fs.writeFile(path.join(outDir, statsRel), JSON.stringify(stats, null, 2), 'utf8');

  const manifest: WMXManifestV1 = {
    schemaVersion: '1.0',
    assetId,
    name: baseName,
    source: {
      filename: path.basename(inputAbs),
      bytes: inputBytes.byteLength,
      createdAt: new Date().toISOString()
    },
    variants: {
      ultraLow: {
        url: variantRel('ultraLow'),
        bytes: stats.variants.ultraLow.bytes,
        metrics: metricsByQuality.ultraLow,
        requires: requiresByQuality.ultraLow
      },
      low: { url: variantRel('low'), bytes: stats.variants.low.bytes, metrics: metricsByQuality.low, requires: requiresByQuality.low },
      medium: {
        url: variantRel('medium'),
        bytes: stats.variants.medium.bytes,
        metrics: metricsByQuality.medium,
        requires: requiresByQuality.medium
      },
      high: { url: variantRel('high'), bytes: stats.variants.high.bytes, metrics: metricsByQuality.high, requires: requiresByQuality.high }
    },
    artifacts: {
      stats: statsRel
    }
  };

  if (thumbnailsEnabled) {
    const thumbRel = 'artifacts/thumbnail.png';
    const thumbAbs = path.join(outDir, thumbRel);
    const result = await maybeRenderThumbnail({ glbPath: variantOutAbs('medium'), pngPath: thumbAbs });
    if (result.ok) {
      manifest.artifacts = { ...(manifest.artifacts ?? {}), thumbnail: thumbRel };
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        `[wmx] Thumbnail skipped: ${result.reason ?? 'unknown reason'} (install @shopify/screenshot-glb to enable)`
      );
    }
  }

  if (streamingEnabled) {
    if (streamingStage === 1) {
      (manifest as any).streaming = streamingFromManifest(manifest);
      // Temporary compatibility for older consumers during transition.
      manifest.extras = { ...(manifest.extras ?? {}), streaming: (manifest as any).streaming };
    } else {
      // Stage 2: node-hierarchy tile GLBs + refine-tree manifest.
      const io = await createIO();
      const srcDoc = await io.readBinary(new Uint8Array(inputBytes));
      const srcRoot = (srcDoc as any).getRoot?.();
      const srcScene = (srcRoot?.listScenes?.() ?? [])[0];
      const sceneChildren: any[] = srcScene?.listChildren?.() ?? [];

      const tileIdForPath = (p: number[]) => `n${p.join('_')}`;
      const tiles: Record<string, StreamTile> = {};

      // Root tile: points to the normal variants (cheap/compatible baseline).
      const rootBounds = computeSubtreeBounds({ doc: srcDoc as any, nodePath: [], excludeRootTransform: false });
      tiles.root = {
        id: 'root',
        children: [],
        refine: 'replace',
        bounds: { sphere: rootBounds.sphere, ...(rootBounds.aabb ? { aabb: rootBounds.aabb } : {}) },
        content: {
          ultraLow: (manifest.variants as any).ultraLow,
          low: manifest.variants.low,
          medium: manifest.variants.medium,
          high: manifest.variants.high
        }
      };

      // Decide which nodes become tiles: depth-limited, triangle-limited, maxTiles-limited.
      let tileCount = 1;

      const estimateSubtreeTriangles = (node: any): number => {
        let tris = 0;
        const walk = (n: any) => {
          const mesh = n.getMesh?.();
          if (mesh) {
            for (const prim of mesh.listPrimitives?.() ?? []) {
              const idx = prim.getIndices?.();
              if (idx) tris += Math.floor(idx.getCount() / 3);
            }
          }
          for (const c of n.listChildren?.() ?? []) walk(c);
        };
        walk(node);
        return tris;
      };

      const shouldRefineNode = (node: any, depth: number): boolean => {
        if (depth >= streamingDepth) return false;
        const kids: any[] = node.listChildren?.() ?? [];
        if (kids.length === 0) return false;
        if (tileCount + kids.length > maxTiles) return false;
        const tris = estimateSubtreeTriangles(node);
        return tris >= minTileTriangles;
      };

      const buildTiles = (parentTileId: string, node: any, pathFromScene: number[], depth: number) => {
        const id = tileIdForPath(pathFromScene);
        const trs = nodeLocalTrs(node);
        const b = computeSubtreeBounds({ doc: srcDoc as any, nodePath: pathFromScene, excludeRootTransform: true });
        tiles[id] = {
          id,
          parentId: parentTileId,
          children: [],
          refine: 'replace',
          transform: trs,
          bounds: { sphere: b.sphere, ...(b.aabb ? { aabb: b.aabb } : {}) },
          content: {
            ultraLow: { url: `tiles/${id}/ultraLow.glb`, requires: requiresByQuality.ultraLow },
            low: { url: `tiles/${id}/low.glb`, requires: requiresByQuality.low },
            medium: { url: `tiles/${id}/medium.glb`, requires: requiresByQuality.medium },
            high: { url: `tiles/${id}/high.glb`, requires: requiresByQuality.high }
          }
        };
        tileCount++;

        if (shouldRefineNode(node, depth)) {
          const kids: any[] = node.listChildren?.() ?? [];
          tiles[id].children = kids.map((_c, i) => tileIdForPath([...pathFromScene, i]));
          for (let i = 0; i < kids.length; i++) {
            buildTiles(id, kids[i], [...pathFromScene, i], depth + 1);
          }
        }
      };

      // Root children: either fully refine to all top-level nodes, or remain leaf.
      const canRefineRoot =
        streamingDepth > 0 &&
        sceneChildren.length > 0 &&
        tileCount + sceneChildren.length <= maxTiles &&
        sceneChildren.some((n) => estimateSubtreeTriangles(n) >= minTileTriangles);

      if (canRefineRoot) {
        tiles.root.children = sceneChildren.map((_n, i) => tileIdForPath([i]));
        for (let i = 0; i < sceneChildren.length; i++) {
          buildTiles('root', sceneChildren[i], [i], 0);
        }
      }

      // Emit tile GLBs for each non-root tile.
      const tilesDir = path.join(outDir, 'tiles');
      await ensureDir(tilesDir);

      const tileQualities: Array<{ q: WMXQuality; cfg: VariantConfig }> = [
        {
          q: 'low',
          cfg: {
            quality: 'low',
            maxTextureSize: 256,
            // Tiles are often many-resident; be more aggressive than non-tiled variants.
            simplifyError: 0.01,
            simplifyRatio: 0,
            lockBorders: true,
            quantizePosition: 12,
            quantizeNormal: 8,
            quantizeTexcoord: 10,
            quantizeWeight: 8,
            stripTangentsWhenNoNormalMap: true
          }
        },
        // Keep in sync with the main `ultraLow` preset above.
        {
          q: 'ultraLow',
          cfg: {
            quality: 'ultraLow',
            maxTextureSize: 64,
            simplifyError: 0.2,
            simplifyRatio: 0.1,
            lockBorders: true,
            quantizePosition: 10,
            quantizeNormal: 8,
            quantizeTexcoord: 10,
            quantizeWeight: 8,
            stripTangentsWhenNoNormalMap: true
          }
        },
        {
          q: 'medium',
          cfg: {
            quality: 'medium',
            maxTextureSize: 512,
            simplifyError: 0.002,
            simplifyRatio: 0,
            lockBorders: true,
            quantizePosition: 14,
            quantizeNormal: 10,
            quantizeTexcoord: 14,
            quantizeWeight: 10
          }
        },
        {
          q: 'high',
          cfg: {
            quality: 'high',
            maxTextureSize: 2048,
            simplifyError: 0.0008,
            simplifyRatio: 0,
            lockBorders: true,
            quantizePosition: 16,
            quantizeNormal: 12,
            quantizeTexcoord: 16,
            quantizeWeight: 12
          }
        }
      ];

      for (const [tileId, tile] of Object.entries(tiles)) {
        if (tileId === 'root') continue;
        const outTileDir = path.join(tilesDir, tileId);
        await ensureDir(outTileDir);

        let lowBuf: Buffer | undefined;
        const nodePath = tileId
          .slice(1)
          .split('_')
          .filter(Boolean)
          .map((s) => Number.parseInt(s, 10));
        for (const { q, cfg } of tileQualities) {
          const outAbs = path.join(outTileDir, `${q}.glb`);
          const result = await buildTileVariant({
            sourceGlb: inputBytes,
            nodePath,
            quality: q,
            cfg,
            ktx2Available,
            texturesMode,
            outAbs,
            requiresByQuality,
            baseOverride: q === 'ultraLow' ? lowBuf : undefined
          });

          // Capture low buffer for monotonic ultraLow.
          if (q === 'low') lowBuf = await fs.readFile(outAbs);

          // Fill bytes/metrics into content for this tile.
          (tile.content as any)[q] = {
            ...(tile.content as any)[q],
            bytes: result.bytes,
            metrics: result.metrics,
            requires: requiresByQuality[q]
          };
        }
      }

      (manifest as any).streaming = {
        schema: 'wmx-streaming-refine-tree@1',
        rootTileId: 'root',
        tiles
      };
      // Temporary compatibility for older consumers during transition.
      manifest.extras = { ...(manifest.extras ?? {}), streaming: (manifest as any).streaming };
    }
  }

  await fs.writeFile(path.join(outDir, 'asset.wmx.json'), JSON.stringify(manifest, null, 2), 'utf8');

  // eslint-disable-next-line no-console
  console.log(`[wmx] Wrote: ${path.relative(process.cwd(), outDir)}/asset.wmx.json`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

