const CACHE = 'aw-tawla-v31-no-voice';
const ASSETS = ['/', '/index.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(ASSETS.map(url => new Request(url, {cache: 'reload'})));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const upgrading = keys.some(key => key.startsWith('aw-tawla-') && key !== CACHE);
    await Promise.all(keys.filter(key => key.startsWith('aw-tawla-') && key !== CACHE).map(key => caches.delete(key)));
    await self.clients.claim();
    // Replace already-open older game code once when upgrading.
    if (upgrading) {
      const windows = await self.clients.matchAll({type: 'window'});
      await Promise.all(windows.map(client => client.navigate(client.url)));
    }
  })());
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(event.request, {cache: 'no-cache'});
      if (response.ok) await cache.put(event.request, response.clone());
      return response;
    } catch (error) {
      const saved = await cache.match(event.request);
      if (saved) return saved;
      if (event.request.mode === 'navigate') {
        const home = await cache.match('/');
        if (home) return home;
      }
      throw error;
    }
  })());
});
