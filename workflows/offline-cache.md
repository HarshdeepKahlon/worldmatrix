## Offline cache (ultraLow + medium)

Use this workflow to add browser disk caching for WMX manifests and coarse/mid LOD GLBs.

This approach uses:

- **Service Worker + Cache Storage** for HTTP response caching.
- **IndexedDB metadata** for LRU eviction by byte budget.

The examples cache:

- `/**/*.wmx.json` (network-first, cache fallback)
- `/**/variants/{ultraLow,medium}.glb(.br)?` (cache-first)
- `/**/tiles/**/{ultraLow,medium}.glb(.br)?` (cache-first)

Default budget in this guide is **500MB**.

---

### 1) Add `public/wmx-sw.js`

Create `public/wmx-sw.js` in your app:

```js
/* eslint-disable no-restricted-globals */
const CACHE_NAME = 'wmx-v1-ultralow-medium';
const META_DB_NAME = 'wmx-cache-meta';
const META_STORE = 'entries';
const MAX_BYTES = 500 * 1024 * 1024;

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await self.clients.claim();
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n.startsWith('wmx-') && n !== CACHE_NAME)
          .map((n) => caches.delete(n))
      );
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (!isCacheable(req)) return;
  event.respondWith(handleRequest(req));
});

function isCacheable(req) {
  if (req.method !== 'GET') return false;
  if (req.headers.has('range')) return false;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return false;
  const p = url.pathname;

  if (p.endsWith('.wmx.json')) return true;
  return isTargetLodGlbPath(p);
}

function isTargetLodGlbPath(pathname) {
  if (!(pathname.endsWith('.glb') || pathname.endsWith('.glb.br'))) return false;
  const lodSeg = pathname.endsWith('.glb.br')
    ? pathname.slice(0, -3) // remove ".br"
    : pathname;
  return /\/(variants|tiles)\//.test(lodSeg) && /\/(ultraLow|medium)\.glb$/.test(lodSeg);
}

async function handleRequest(req) {
  const url = new URL(req.url);
  const cache = await caches.open(CACHE_NAME);
  const isManifest = url.pathname.endsWith('.wmx.json');

  if (isManifest) {
    return networkFirstManifest(req, cache);
  }
  return cacheFirstLodGlb(req, cache);
}

async function networkFirstManifest(req, cache) {
  try {
    const res = await fetch(req);
    if (res.ok) {
      await cache.put(req, res.clone());
      await touchEntry(req.url, await estimateBytes(res));
      await enforceBudget(cache);
    }
    return res;
  } catch {
    const cached = await cache.match(req);
    if (cached) {
      await touchEntry(req.url, undefined);
      return cached;
    }
    throw new Error(`Offline and no cached manifest: ${req.url}`);
  }
}

async function cacheFirstLodGlb(req, cache) {
  const cached = await cache.match(req);
  if (cached) {
    await touchEntry(req.url, undefined);
    return cached;
  }

  const res = await fetch(req);
  if (!res.ok) return res;

  await cache.put(req, res.clone());
  await touchEntry(req.url, await estimateBytes(res));
  await enforceBudget(cache);
  return res;
}

async function estimateBytes(res) {
  const cl = res.headers.get('content-length');
  if (cl) {
    const parsed = Number(cl);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  const buf = await res.clone().arrayBuffer();
  return buf.byteLength;
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(META_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'url' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function touchEntry(url, bytesMaybe) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readwrite');
    const store = tx.objectStore(META_STORE);
    const now = Date.now();
    const getReq = store.get(url);

    getReq.onsuccess = () => {
      const prev = getReq.result;
      const next = {
        url,
        bytes: Number.isFinite(bytesMaybe) ? bytesMaybe : prev?.bytes ?? 0,
        lastAccessMs: now
      };
      store.put(next);
    };

    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

async function getAllMeta() {
  const db = await openDb();
  const out = await new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readonly');
    const store = tx.objectStore(META_STORE);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return out;
}

async function deleteMeta(url) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readwrite');
    tx.objectStore(META_STORE).delete(url);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function enforceBudget(cache) {
  const entries = await getAllMeta();
  let total = entries.reduce((s, e) => s + (Number(e.bytes) || 0), 0);
  if (total <= MAX_BYTES) return;

  entries.sort((a, b) => (a.lastAccessMs || 0) - (b.lastAccessMs || 0));

  for (const e of entries) {
    if (total <= MAX_BYTES) break;
    const deleted = await cache.delete(e.url);
    if (deleted) {
      total -= Number(e.bytes) || 0;
      await deleteMeta(e.url);
    } else {
      // Entry is missing in cache, cleanup stale metadata.
      await deleteMeta(e.url);
    }
  }
}
```

---

### 2) Register the Service Worker once

Add this to your app startup.

#### Vite / React (`src/main.tsx`)

```ts
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      await navigator.serviceWorker.register('/wmx-sw.js', { scope: '/' });
      if (navigator.storage?.persist) {
        await navigator.storage.persist();
      }
    } catch (err) {
      console.warn('[wmx-cache] SW registration failed', err);
    }
  });
}
```

#### Next.js App Router (`app/wmx-sw-register.tsx`)

```tsx
'use client';

import { useEffect } from 'react';

export function WMXSWRegister() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const run = async () => {
      try {
        await navigator.serviceWorker.register('/wmx-sw.js', { scope: '/' });
        if (navigator.storage?.persist) await navigator.storage.persist();
      } catch (err) {
        console.warn('[wmx-cache] SW registration failed', err);
      }
    };
    run();
  }, []);

  return null;
}
```

Then render `<WMXSWRegister />` once near the root client boundary.

---

### 3) Verify caching

1. Open DevTools > **Application** > **Service Workers** and confirm `wmx-sw.js` is active.
2. In **Application** > **Cache Storage**, confirm entries include:
   - `.wmx.json`
   - `variants/ultraLow.glb` and/or `variants/medium.glb`
   - `tiles/**/ultraLow.glb` and/or `tiles/**/medium.glb`
3. Toggle **Offline** in DevTools network panel and reload:
   - cached manifests and cached `ultraLow`/`medium` assets should still load.
4. Optional budget test:
   - temporarily lower `MAX_BYTES` in `wmx-sw.js` to something like `5 * 1024 * 1024`
   - load multiple assets and observe old entries evicted from Cache Storage.

---

### Caveats

- This caches HTTP responses on disk, not decoded GPU buffers.
- Service Worker requires same-origin asset URLs to intercept (`/wmx/...`, `/wmx-samples/...`, etc.).
- Mobile browsers can still evict storage under pressure; `navigator.storage.persist()` is best-effort.
- If `Range` requests are introduced later for partial content streaming, update the SW strategy before enabling Range caching.
