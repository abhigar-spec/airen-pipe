/* Airen Pipe V6.21 RC21 - Offline/PWA + verification fix */
const AIR_CACHE = 'airen-shell-rc21-v1';
const AIR_DB = 'airen-offline-sync-v1';
const AIR_STORE = 'orderQueue';
const AIR_SYNC_TAG = 'airen-order-sync';
const LOCAL_SHELL = ['./', './index.html', './manifest.webmanifest', './airen-icon-192.png', './airen-icon-512.png'];
const EXTERNAL_WARM = [
  'https://cdn.tailwindcss.com',
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(AIR_CACHE);
    await cache.addAll(LOCAL_SHELL);
    await Promise.allSettled(EXTERNAL_WARM.map(async url => {
      try {
        const res = await fetch(url, {mode:'no-cors'});
        await cache.put(url, res.clone());
      } catch (_) {}
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('airen-shell-') && k !== AIR_CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(AIR_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(AIR_STORE)) req.result.createObjectStore(AIR_STORE, {keyPath:'id'});
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Sync DB open failed'));
  });
}

async function getQueuedOrders() {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(AIR_STORE, 'readonly');
      const req = tx.objectStore(AIR_STORE).getAll();
      req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
      req.onerror = () => reject(req.error);
    });
  } finally { db.close(); }
}

async function updateAttempt(entry, ok, errorText='') {
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(AIR_STORE, 'readwrite');
      tx.objectStore(AIR_STORE).put({...entry, attempts:Number(entry.attempts||0)+1, lastAttemptAt:Date.now(), lastAttemptOk:!!ok, lastError:errorText});
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}

function encodePipeSize(value) {
  const s = String(value == null ? '' : value).trim();
  return /^\d{1,2}(?:\/\d{1,2})?$/.test(s) ? `${s} inch` : s;
}

function payloadFor(entry) {
  const order = entry?.order || {};
  if (entry?.op === 'delete') {
    return {
      id: order.id,
      action: 'delete',
      expectedRevision: order.expectedRevision == null ? order.revision : order.expectedRevision,
      mutationId: order.mutationId || ''
    };
  }
  return {
    ...order,
    items: Array.isArray(order.items) ? order.items.map(it => ({...it, size: encodePipeSize(it?.size)})) : order.items
  };
}

async function notifyClients(message) {
  const clients = await self.clients.matchAll({type:'window', includeUncontrolled:true});
  clients.forEach(client => client.postMessage(message));
}

async function backgroundSyncOrders() {
  const entries = await getQueuedOrders();
  if (!entries.length) return;
  let failed = 0;
  for (const entry of entries) {
    try {
      if (!entry.webhookUrl) throw new Error('Missing webhook URL');
      await fetch(entry.webhookUrl, {
        method: 'POST',
        mode: 'no-cors',
        headers: {'Content-Type':'text/plain;charset=utf-8'},
        body: JSON.stringify(payloadFor(entry))
      });
      // Keep the mirrored record until the normal in-app verifier confirms the Sheet.
      // This avoids falsely declaring a no-cors request "verified" from an opaque response.
      await updateAttempt(entry, true, '');
    } catch (err) {
      failed++;
      await updateAttempt(entry, false, String(err?.message || err || 'Network error'));
    }
  }
  await notifyClients({type: failed ? 'AIREN_BACKGROUND_SYNC_ERROR' : 'AIREN_BACKGROUND_SYNC_ATTEMPT', count:entries.length, failed});
  if (failed) throw new Error(`${failed} Airen order sync attempt(s) failed`);
}

self.addEventListener('sync', event => {
  if (event.tag === AIR_SYNC_TAG) event.waitUntil(backgroundSyncOrders());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'AIREN_TRY_BACKGROUND_SYNC') event.waitUntil(backgroundSyncOrders());
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Navigations: prefer fresh app when online, fall back to cached shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(AIR_CACHE);
        cache.put('./index.html', fresh.clone()).catch(()=>{});
        return fresh;
      } catch (_) {
        return (await caches.match('./index.html')) || (await caches.match('./')) || Response.error();
      }
    })());
    return;
  }

  // Same-origin shell/assets: cache first, then network and retain a copy.
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      const fresh = await fetch(req);
      const cache = await caches.open(AIR_CACHE);
      cache.put(req, fresh.clone()).catch(()=>{});
      return fresh;
    })());
    return;
  }

  // Tailwind/Google Fonts and other GET resources: stale-while-revalidate.
  event.respondWith((async () => {
    const cached = await caches.match(req);
    const network = fetch(req).then(async fresh => {
      const cache = await caches.open(AIR_CACHE);
      cache.put(req, fresh.clone()).catch(()=>{});
      return fresh;
    }).catch(() => null);
    return cached || (await network) || Response.error();
  })());
});
