import express, { type Request, type Response } from 'express';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import Busboy from 'busboy';

import type { WMXManifestV1 } from '@worldmatrix/wmx-core';
import { isWMXManifestV1 } from '@worldmatrix/wmx-core';
import { convertAssetFolderToEncryptedBrotli } from './postprocess.js';
import { getS3ConfigFromEnv, publishAssetFolderToS3 } from './s3Publish.js';

type BuildStatus = 'queued' | 'running' | 'succeeded' | 'failed';

type BuildJob = {
  id: string;
  status: BuildStatus;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  inputs?: string[];
  mode?: 'single' | 'batch';
  logs: string[];
  error?: string;
  result?: {
    assetId: string;
    manifestUrl: string;
    s3Prefix?: string;
    assets?: Array<{ assetId: string; manifestUrl: string; s3Prefix?: string }>;
  };
};

const WMX_DATA_DIR = process.env.WMX_DATA_DIR ?? '/data';
const WMX_SOURCE_DIR = process.env.WMX_SOURCE_DIR ?? path.join(WMX_DATA_DIR, 'source');
const WMX_OUTPUT_DIR = process.env.WMX_OUTPUT_DIR ?? path.join(WMX_DATA_DIR, 'wmx');
const PORT = Number(process.env.PORT ?? '8080');
const WMX_SHARED_SECRET = process.env.WMX_SHARED_SECRET;

const app = express();
app.use(express.json({ limit: '2mb' }));

const jobs = new Map<string, BuildJob>();
let activeBuild: Promise<void> | null = null;

function logServer(message: string, extra?: unknown) {
  // eslint-disable-next-line no-console
  if (typeof extra === 'undefined') console.log(message);
  // eslint-disable-next-line no-console
  else console.log(message, extra);
}

function requireSharedSecret(req: Request, res: Response, next: () => void) {
  if (!WMX_SHARED_SECRET) return next();
  const provided = req.header('x-wmx-secret');
  if (!provided || provided !== WMX_SHARED_SECRET) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

app.get('/api/health', async (_req: Request, res: Response) => {
  res.json({
    ok: true,
    dataDir: WMX_DATA_DIR,
    sourceDir: WMX_SOURCE_DIR,
    outputDir: WMX_OUTPUT_DIR
  });
});

app.get('/api/assets', async (_req: Request, res: Response) => {
  try {
    const assets = await listAssets(WMX_OUTPUT_DIR);
    res.json({ assets });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

app.get('/api/source', async (_req: Request, res: Response) => {
  try {
    await ensureDir(WMX_SOURCE_DIR);
    const files = await listFilesRecursive(WMX_SOURCE_DIR, (p) => p.toLowerCase().endsWith('.glb'));
    const items = await Promise.all(
      files.map(async (abs) => {
        const st = await fs.stat(abs);
        return {
          path: path.relative(WMX_SOURCE_DIR, abs).split(path.sep).join('/'),
          bytes: st.size,
          mtimeMs: st.mtimeMs
        };
      })
    );
    items.sort((a, b) => a.path.localeCompare(b.path));
    res.json({ source: items });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

app.post('/api/upload', requireSharedSecret, async (req: Request, res: Response) => {
  try {
    const uploadId = crypto.randomBytes(6).toString('hex');
    const startedAt = Date.now();
    const sourceIp = req.ip || req.socket.remoteAddress || 'unknown';
    logServer(`[asset-server] upload ${uploadId} started`, {
      ip: sourceIp,
      contentType: req.headers['content-type'] ?? 'unknown'
    });

    await ensureDir(WMX_SOURCE_DIR);

    const bb = Busboy({
      headers: req.headers,
      limits: {
        files: 100,
        fileSize: 2 * 1024 * 1024 * 1024 // 2GB per file (v1)
      }
    });

    const saved: Array<{ filename: string; path: string; bytes: number }> = [];
    const errors: string[] = [];
    const pendingWrites: Array<Promise<void>> = [];

    bb.on('file', (fieldname, file, info) => {
      const original = info.filename || 'upload.glb';
      logServer(`[asset-server] upload ${uploadId} processing file`, {
        field: fieldname,
        filename: original
      });
      const ext = path.extname(original).toLowerCase();
      if (ext !== '.glb') {
        errors.push(`Rejected ${original}: only .glb supported in v1`);
        logServer(`[asset-server] upload ${uploadId} rejected file`, {
          filename: original,
          reason: 'only .glb supported'
        });
        file.resume();
        return;
      }

      const safeName = sanitizeFilename(path.basename(original, ext)) + ext;
      const destAbs = uniqueDestPath(path.join(WMX_SOURCE_DIR, safeName));
      const rel = path.relative(WMX_SOURCE_DIR, destAbs).split(path.sep).join('/');

      let bytes = 0;
      const ws = fsSync.createWriteStream(destAbs);
      file.on('data', (d: Buffer) => {
        bytes += d.length;
      });
      file.on('limit', () => {
        errors.push(`File too large: ${original}`);
        ws.destroy();
      });

      // IMPORTANT: busboy's 'finish' can fire before the file write stream closes.
      // Wait for all writes to complete before returning the response.
      const writePromise = pipeline(file, ws)
        .then(() => {
          saved.push({ filename: original, path: rel, bytes });
          logServer(`[asset-server] upload ${uploadId} saved file`, {
            filename: original,
            path: rel,
            bytes
          });
        })
        .catch((e) => {
          errors.push(`Write failed for ${original}: ${String(e)}`);
          logServer(`[asset-server] upload ${uploadId} failed file`, {
            filename: original,
            error: String(e)
          });
        });
      pendingWrites.push(writePromise);
    });

    bb.on('error', (e) => {
      errors.push(String(e));
      logServer(`[asset-server] upload ${uploadId} parser error`, { error: String(e) });
    });

    bb.on('finish', async () => {
      await Promise.allSettled(pendingWrites);
      const totalBytes = saved.reduce((sum, item) => sum + item.bytes, 0);
      logServer(`[asset-server] upload ${uploadId} completed`, {
        savedCount: saved.length,
        errorCount: errors.length,
        totalBytes,
        durationMs: Date.now() - startedAt
      });
      res.json({ saved, errors });
    });

    req.pipe(bb);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

app.post('/api/build', requireSharedSecret, async (req: Request, res: Response) => {
  const textures = (req.body?.textures as string | undefined) ?? 'ktx2';
  const thumbnails = (req.body?.thumbnails as boolean | undefined) ?? false;
  const inputs = (req.body?.inputs as string[] | undefined) ?? null;
  const streaming = (req.body?.streaming as boolean | undefined) ?? true;
  const keepNodesRegex = (req.body?.keepNodesRegex as string | undefined) ?? undefined;

  const job: BuildJob = {
    id: crypto.randomBytes(8).toString('hex'),
    status: 'queued',
    createdAt: new Date().toISOString(),
    mode: 'batch',
    ...(inputs ? { inputs } : {}),
    logs: []
  };
  jobs.set(job.id, job);

  // Ensure only one build runs at a time (simple v1 safety).
  if (!activeBuild) {
    activeBuild = runJob(job, { textures, thumbnails, inputs, streaming, keepNodesRegex })
      .catch(() => {})
      .finally(() => {
        activeBuild = null;
      });
  } else {
    job.logs.push('[asset-server] A build is already running; this job will start after it finishes (v1).');
    // naive queue: poll until activeBuild clears, then run.
    (async () => {
      while (activeBuild) await new Promise((r) => setTimeout(r, 1000));
      activeBuild = runJob(job, { textures, thumbnails, inputs, streaming, keepNodesRegex })
        .catch(() => {})
        .finally(() => {
          activeBuild = null;
        });
    })();
  }

  res.json({ jobId: job.id });
});

app.post('/api/build-one', requireSharedSecret, async (req: Request, res: Response) => {
  try {
    const textures = (req.body?.textures as string | undefined) ?? 'ktx2';
    const thumbnails = (req.body?.thumbnails as boolean | undefined) ?? false;
    const input = req.body?.input as string | undefined;
    const streaming = (req.body?.streaming as boolean | undefined) ?? true;
    const keepNodesRegex = (req.body?.keepNodesRegex as string | undefined) ?? undefined;
    if (!input) return res.status(400).json({ error: 'input is required' });
    resolveSourcePathOrThrow(input);

    const job: BuildJob = {
      id: crypto.randomBytes(8).toString('hex'),
      status: 'queued',
      createdAt: new Date().toISOString(),
      mode: 'single',
      inputs: [input],
      logs: []
    };
    jobs.set(job.id, job);

    if (!activeBuild) {
      activeBuild = runJob(job, { textures, thumbnails, inputs: [input], streaming, keepNodesRegex })
        .catch(() => {})
        .finally(() => {
          activeBuild = null;
        });
    } else {
      job.logs.push('[asset-server] A build is already running; this job will start after it finishes (v1).');
      (async () => {
        while (activeBuild) await new Promise((r) => setTimeout(r, 1000));
        activeBuild = runJob(job, { textures, thumbnails, inputs: [input], streaming, keepNodesRegex })
          .catch(() => {})
          .finally(() => {
            activeBuild = null;
          });
      })();
    }

    return res.json({ jobId: job.id });
  } catch (e: any) {
    return res.status(400).json({ error: e?.message ?? String(e) });
  }
});

app.get('/api/build/:jobId', requireSharedSecret, (req: Request, res: Response) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });
  res.json(job);
});

// Serve generated WMX outputs.
app.use('/wmx', express.static(WMX_OUTPUT_DIR, { fallthrough: true, etag: true, maxAge: '1h' }));

// 404 fallback.
app.use((_req: Request, res: Response) => res.status(404).json({ error: 'not found' }));

app.listen(PORT, async () => {
  // eslint-disable-next-line no-console
  console.log(`[asset-server] listening on :${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`[asset-server] source: ${WMX_SOURCE_DIR}`);
  // eslint-disable-next-line no-console
  console.log(`[asset-server] output: ${WMX_OUTPUT_DIR}`);
});

async function runJob(job: BuildJob, opts: { textures: string; thumbnails: boolean; inputs: string[] | null; streaming: boolean; keepNodesRegex?: string }) {
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  job.logs.push(
    `[asset-server] Build started. streaming=${opts.streaming} textures=${opts.textures} thumbnails=${opts.thumbnails} inputs=${
      opts.inputs ? opts.inputs.length : 'ALL'
    }`
  );

  try {
    await ensureDir(WMX_SOURCE_DIR);
    await ensureDir(WMX_OUTPUT_DIR);

    const allInputs = await listFilesRecursive(WMX_SOURCE_DIR, (p) => p.toLowerCase().endsWith('.glb'));
    const selectedAbs = opts.inputs ? opts.inputs.map((p) => resolveSourcePathOrThrow(p)) : allInputs;

    if (selectedAbs.length === 0) {
      job.logs.push('[asset-server] No .glb files found in /data/source.');
      job.status = 'succeeded';
      job.endedAt = new Date().toISOString();
      return;
    }

    job.logs.push(`[asset-server] Building ${selectedAbs.length} model(s).`);

    const cliPath = await resolveWmxCliPath();
    const published: Array<{ assetId: string; manifestUrl: string; s3Prefix?: string }> = [];
    const s3Config = getS3ConfigFromEnv();
    const encryptionKey = process.env.MODEL_ENCRYPTION_KEY;
    if (encryptionKey) {
      job.logs.push('[asset-server] MODEL_ENCRYPTION_KEY detected: output payloads will be converted to encrypted .glb.br.');
    } else {
      job.logs.push('[asset-server] MODEL_ENCRYPTION_KEY not set: output payloads remain plain .glb.');
    }

    for (const input of selectedAbs) {
      const rel = path.relative(WMX_SOURCE_DIR, input);
      job.logs.push(`\n[wmx] ${opts.streaming ? 'build-streaming' : 'build'} ${rel}`);

      await runCommand(job, process.execPath, [
        cliPath,
        opts.streaming ? 'build-streaming' : 'build',
        input,
        '--out',
        WMX_OUTPUT_DIR,
        ...(opts.streaming ? ['--stage', '2'] : []),
        ...(opts.keepNodesRegex ? ['--keep-nodes-regex', opts.keepNodesRegex] : []),
        '--textures',
        opts.textures,
        ...(opts.thumbnails ? [] : ['--no-thumbnails'])
      ]);

      const assetDir = await resolveBuiltAssetDirForInput(WMX_OUTPUT_DIR, input);
      let manifest: WMXManifestV1;
      if (encryptionKey) {
        const transformed = await convertAssetFolderToEncryptedBrotli({
          assetDir,
          encryptionKey
        });
        manifest = transformed.manifest;
        job.logs.push(`[asset-server] transformed ${transformed.transformedFiles} payload(s) to .glb.br for asset ${manifest.assetId}`);
      } else {
        manifest = await readManifestFromAssetDir(assetDir);
        job.logs.push(`[asset-server] skipped .glb.br postprocess for asset ${manifest.assetId}; serving plain .glb payloads.`);
      }

      if (s3Config) {
        if (!encryptionKey) {
          job.logs.push(`[asset-server] S3 publish for asset ${manifest.assetId} will upload plain .glb payloads (no MODEL_ENCRYPTION_KEY).`);
        }
        const publishedOne = await publishAssetFolderToS3({
          assetDir,
          assetId: manifest.assetId,
          config: s3Config
        });
        job.logs.push(`[asset-server] published ${manifest.assetId} to s3://${s3Config.bucket}/${publishedOne.s3Prefix}`);
        published.push({
          assetId: manifest.assetId,
          manifestUrl: publishedOne.manifestUrl,
          s3Prefix: publishedOne.s3Prefix
        });
      } else {
        const folder = path.relative(WMX_OUTPUT_DIR, assetDir).split(path.sep)[0] ?? manifest.assetId;
        published.push({
          assetId: manifest.assetId,
          manifestUrl: `/wmx/${encodeURIComponent(folder)}/asset.wmx.json`
        });
      }
    }

    const expectedSingle = job.mode === 'single' || opts.inputs?.length === 1;
    if (expectedSingle) {
      if (published.length !== 1) {
        throw new Error(`single-input build expected exactly 1 published asset, got ${published.length}`);
      }
      job.result = {
        assetId: published[0].assetId,
        manifestUrl: published[0].manifestUrl,
        ...(published[0].s3Prefix ? { s3Prefix: published[0].s3Prefix } : {}),
        assets: published
      };
    } else if (published[0]) {
      job.result = {
        assetId: published[0].assetId,
        manifestUrl: published[0].manifestUrl,
        ...(published[0].s3Prefix ? { s3Prefix: published[0].s3Prefix } : {}),
        assets: published
      };
    }
    job.logs.push('\n[asset-server] Build completed.');
    job.status = 'succeeded';
    job.endedAt = new Date().toISOString();
  } catch (e: any) {
    job.status = 'failed';
    job.endedAt = new Date().toISOString();
    job.error = e?.message ?? String(e);
    job.logs.push(`\n[asset-server] Build failed: ${job.error}`);
  }
}

function resolveSourcePathOrThrow(rel: string): string {
  const cleaned = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!cleaned || cleaned.includes('..')) throw new Error(`Invalid input path: ${rel}`);
  const abs = path.resolve(WMX_SOURCE_DIR, cleaned);
  const root = path.resolve(WMX_SOURCE_DIR);
  if (!abs.startsWith(root)) throw new Error(`Invalid input path: ${rel}`);
  return abs;
}

function sanitizeFilename(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 120) || 'asset';
}

function safeSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 64);
}

function uniqueDestPath(baseAbs: string): string {
  if (!fsSync.existsSync(baseAbs)) return baseAbs;
  const dir = path.dirname(baseAbs);
  const ext = path.extname(baseAbs);
  const base = path.basename(baseAbs, ext);
  for (let i = 2; i < 1000; i++) {
    const candidate = path.join(dir, `${base}-${i}${ext}`);
    if (!fsSync.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${base}-${Date.now()}${ext}`);
}

async function runCommand(job: BuildJob, cmd: string, args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { env: process.env });

    const onData = (chunk: Buffer) => {
      const s = chunk.toString();
      // Keep logs bounded (v1): store last ~5000 lines.
      job.logs.push(s);
      if (job.logs.length > 5000) job.logs.splice(0, job.logs.length - 5000);
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`command failed (${code}): ${cmd} ${args.join(' ')}`));
    });
  });
}

async function resolveWmxCliPath(): Promise<string> {
  // In dev, we can resolve from workspace layout; in Docker, we’ll copy the built CLI alongside.
  const candidates = [
    // workspace root layout
    path.resolve(process.cwd(), 'packages', 'wmx-cli', 'dist', 'cli.js'),
    // when packaged inside wmx-asset-server dist folder (optional future)
    path.resolve(process.cwd(), 'dist', 'wmx-cli', 'cli.js')
  ];
  for (const c of candidates) {
    try {
      await fs.access(c);
      return c;
    } catch {
      // continue
    }
  }
  throw new Error('Could not locate wmx-cli dist/cli.js (did you run build in the image?)');
}

async function resolveBuiltAssetDirForInput(outputDir: string, inputAbs: string): Promise<string> {
  const base = path.basename(inputAbs, path.extname(inputAbs));
  const slug = safeSlug(base);
  if (slug) {
    const candidate = path.join(outputDir, slug);
    try {
      await fs.access(path.join(candidate, 'asset.wmx.json'));
      return candidate;
    } catch {
      // fall through
    }
  }

  const manifests = await listFilesRecursive(outputDir, (p) => p.endsWith(`${path.sep}asset.wmx.json`) || p.endsWith('/asset.wmx.json'));
  if (manifests.length === 0) throw new Error(`No asset.wmx.json found under ${outputDir}`);

  const withMtime = await Promise.all(
    manifests.map(async (m) => {
      const st = await fs.stat(m);
      return { path: m, mtimeMs: st.mtimeMs };
    })
  );
  withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return path.dirname(withMtime[0].path);
}

async function readManifestFromAssetDir(assetDir: string): Promise<WMXManifestV1> {
  const manifestPath = path.join(assetDir, 'asset.wmx.json');
  const raw = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as unknown;
  if (!isWMXManifestV1(raw)) {
    throw new Error(`Invalid WMX manifest at ${manifestPath}`);
  }
  return raw as WMXManifestV1;
}

async function ensureDir(p: string) {
  await fs.mkdir(p, { recursive: true });
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

async function listAssets(wmxDir: string) {
  const manifests = await listFilesRecursive(wmxDir, (p) => p.endsWith('asset.wmx.json'));
  const assets: Array<{
    id: string;
    name: string;
    manifestUrl: string;
    assetId: string;
    variants: WMXManifestV1['variants'];
  }> = [];

  for (const abs of manifests) {
    try {
      const text = await fs.readFile(abs, 'utf8');
      const json = JSON.parse(text) as unknown;
      if (!isWMXManifestV1(json)) continue;
      const m = json as WMXManifestV1;
      const folder = path.relative(wmxDir, path.dirname(abs)).split(path.sep)[0] ?? '';
      assets.push({
        id: folder || m.assetId,
        name: (m.name ?? folder) || m.assetId,
        manifestUrl: `/wmx/${encodeURIComponent(folder)}/asset.wmx.json`,
        assetId: m.assetId,
        variants: m.variants
      });
    } catch {
      // skip bad manifests
    }
  }

  assets.sort((a, b) => a.name.localeCompare(b.name));
  return assets;
}

