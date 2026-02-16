import fs from 'node:fs/promises';
import path from 'node:path';

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const ent of entries) {
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) await copyDir(s, d);
    else if (ent.isFile()) await fs.copyFile(s, d);
  }
}

async function main() {
  const candidates = [
    path.resolve(process.cwd(), 'node_modules', 'three', 'examples', 'jsm', 'libs', 'basis'),
    path.resolve(process.cwd(), '..', 'node_modules', 'three', 'examples', 'jsm', 'libs', 'basis')
  ];

  const src = (await exists(candidates[0])) ? candidates[0] : (await exists(candidates[1])) ? candidates[1] : null;
  if (!src) {
    throw new Error(`Could not find three basis transcoder dir. Tried:\n- ${candidates.join('\n- ')}`);
  }

  const out = path.resolve(process.cwd(), 'public', 'basis');
  await copyDir(src, out);
  // eslint-disable-next-line no-console
  console.log(`[dashboard] Copied basis transcoder to ${out}`);
}

await main();

