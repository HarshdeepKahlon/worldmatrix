import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import fs from 'node:fs/promises';
import path from 'node:path';
import fsSync from 'node:fs';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  server: {
    port: 5174
  },
  define: {
    // Expose to client for UI hints only (not required to function).
    __WMX_ASSETS_DIR__: JSON.stringify(process.env.WMX_ASSETS_DIR ?? '')
  },
  // Serve a local WMX output directory at /wmx/... during dev.
  // Start with: WMX_ASSETS_DIR=/abs/path/to/dist/setup-assets-... npm run dev -w examples/r3f-demo
  // Then open: http://localhost:5174/?asset=stream-deck
  plugins: [
    react(),
    basisTranscoderPlugin(),
    {
      name: 'wmx-local-assets-middleware',
      configureServer(server) {
        const rootDir = process.env.WMX_ASSETS_DIR;
        if (!rootDir) return;

        server.middlewares.use('/wmx', async (req, res, next) => {
          try {
            const urlPath = (req.url ?? '/').split('?')[0] ?? '/';
            const decoded = decodeURIComponent(urlPath);
            // Prevent path traversal.
            if (decoded.includes('..')) {
              res.statusCode = 400;
              res.end('bad path');
              return;
            }

            const filePath = path.join(rootDir, decoded);
            const absRoot = path.resolve(rootDir);
            const absFile = path.resolve(filePath);
            if (!absFile.startsWith(absRoot)) {
              res.statusCode = 400;
              res.end('bad path');
              return;
            }

            const buf = await fs.readFile(absFile);

            if (absFile.endsWith('.wmx.json') || absFile.endsWith('.json')) {
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
            } else if (absFile.endsWith('.glb')) {
              res.setHeader('Content-Type', 'model/gltf-binary');
            } else if (absFile.endsWith('.gltf')) {
              res.setHeader('Content-Type', 'model/gltf+json; charset=utf-8');
            } else if (absFile.endsWith('.png')) {
              res.setHeader('Content-Type', 'image/png');
            } else {
              res.setHeader('Content-Type', 'application/octet-stream');
            }

            res.statusCode = 200;
            res.end(buf);
          } catch {
            next();
          }
        });
      }
    }
  ]
});

function basisTranscoderPlugin() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const basisDir = findBasisDir(here);
  const jsFile = 'basis_transcoder.js';
  const wasmFile = 'basis_transcoder.wasm';

  return {
    name: 'wmx-basis-transcoder',
    configureServer(server) {
      server.middlewares.use('/basis', async (req, res, next) => {
        try {
          const urlPath = (req.url ?? '/').split('?')[0] ?? '/';
          const decoded = decodeURIComponent(urlPath);
          if (decoded.includes('..')) {
            res.statusCode = 400;
            res.end('bad path');
            return;
          }

          const rel = decoded.replace(/^\//, '');
          const allowed = new Set([jsFile, wasmFile]);
          if (!allowed.has(rel)) return next();

          const abs = path.join(basisDir, rel);
          const buf = await fs.readFile(abs);
          if (rel.endsWith('.js')) res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
          if (rel.endsWith('.wasm')) res.setHeader('Content-Type', 'application/wasm');
          res.statusCode = 200;
          res.end(buf);
        } catch {
          next();
        }
      });
    },
    closeBundle() {
      // Copy into build output so `vite build` works too.
      const outDir = path.join(here, 'dist', 'basis');
      fsSync.mkdirSync(outDir, { recursive: true });
      fsSync.copyFileSync(path.join(basisDir, jsFile), path.join(outDir, jsFile));
      fsSync.copyFileSync(path.join(basisDir, wasmFile), path.join(outDir, wasmFile));
    }
  };
}

function findBasisDir(startDir: string): string {
  let cur = startDir;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(cur, 'node_modules', 'three', 'examples', 'jsm', 'libs', 'basis');
    if (fsSync.existsSync(path.join(candidate, 'basis_transcoder.js'))) return candidate;
    const next = path.dirname(cur);
    if (next === cur) break;
    cur = next;
  }
  throw new Error('Could not find three basis transcoder files in node_modules.');
}

