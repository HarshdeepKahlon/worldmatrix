import { defineConfig } from 'vite';
import fs from 'node:fs/promises';
import path from 'node:path';

export default defineConfig({
  server: {
    port: 5175
  },
  define: {
    __WMX_ASSETS_DIR__: JSON.stringify(process.env.WMX_ASSETS_DIR ?? '')
  },
  plugins: [
    {
      name: 'wmx-local-assets-middleware',
      configureServer(server) {
        const rootDir = process.env.WMX_ASSETS_DIR;
        if (!rootDir) return;

        server.middlewares.use('/wmx', async (req, res, next) => {
          try {
            const urlPath = (req.url ?? '/').split('?')[0] ?? '/';
            const decoded = decodeURIComponent(urlPath);
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
