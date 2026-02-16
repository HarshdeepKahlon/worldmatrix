import fs from 'node:fs/promises';
import path from 'node:path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

type S3Config = {
  bucket: string;
  prefix: string;
  region: string;
  endpoint?: string;
  publicBaseUrl: string;
  forcePathStyle: boolean;
  makePublic: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
};

export function getS3ConfigFromEnv(): S3Config | null {
  const bucket = process.env.WMX_S3_BUCKET;
  const publicBaseUrl = process.env.WMX_S3_PUBLIC_BASE_URL;
  if (!bucket || !publicBaseUrl) return null;
  return {
    bucket,
    publicBaseUrl: publicBaseUrl.replace(/\/+$/, ''),
    prefix: (process.env.WMX_S3_PREFIX ?? '3d-assets/wmx').replace(/^\/+|\/+$/g, ''),
    region: process.env.WMX_S3_REGION ?? 'us-east-1',
    endpoint: process.env.WMX_S3_ENDPOINT,
    forcePathStyle: process.env.WMX_S3_FORCE_PATH_STYLE === '1',
    // Default to public so `publicBaseUrl` URLs are fetchable without extra bucket policy.
    // Set WMX_S3_MAKE_PUBLIC=0 to disable.
    makePublic: process.env.WMX_S3_MAKE_PUBLIC !== '0',
    accessKeyId: process.env.WMX_S3_ACCESS_KEY_ID ?? process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.WMX_S3_SECRET_ACCESS_KEY ?? process.env.AWS_SECRET_ACCESS_KEY
  };
}

export async function publishAssetFolderToS3(params: {
  assetDir: string;
  assetId: string;
  config: S3Config;
  client?: Pick<S3Client, 'send'>;
}): Promise<{ manifestUrl: string; s3Prefix: string; uploadedCount: number }> {
  const client = params.client ?? createS3Client(params.config);
  const files = await listFilesRecursive(params.assetDir);
  const keyPrefix = `${params.config.prefix}/${params.assetId}`.replace(/^\/+|\/+$/g, '');

  let uploadedCount = 0;
  for (const abs of files) {
    const rel = path.relative(params.assetDir, abs).split(path.sep).join('/');
    const body = await fs.readFile(abs);
    const key = `${keyPrefix}/${rel}`;
    const command = new PutObjectCommand({
      Bucket: params.config.bucket,
      Key: key,
      Body: body,
      ContentType: contentTypeFor(rel),
      ...(params.config.makePublic ? { ACL: 'public-read' as const } : {})
    });
    await client.send(command);
    uploadedCount += 1;
  }

  return {
    manifestUrl: `${params.config.publicBaseUrl}/${keyPrefix}/asset.wmx.json`,
    s3Prefix: keyPrefix,
    uploadedCount
  };
}

function createS3Client(config: S3Config): S3Client {
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    credentials:
      config.accessKeyId && config.secretAccessKey
        ? { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }
        : undefined
  });
}

function contentTypeFor(rel: string): string {
  if (rel.endsWith('.json')) return 'application/json';
  if (rel.endsWith('.png')) return 'image/png';
  if (rel.endsWith('.glb') || rel.endsWith('.glb.br')) return 'model/gltf-binary';
  return 'application/octet-stream';
}

async function listFilesRecursive(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) await walk(abs);
      else if (ent.isFile()) out.push(abs);
    }
  }
  await walk(root);
  out.sort();
  return out;
}
