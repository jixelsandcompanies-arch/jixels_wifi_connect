const CACHE_NAME = 'barrio-admin-v3';
const APP_FILES = [
  '/admin.html',
  '/admin.css',
  '/admin-login.css',
  '/admin.js',
  '/admin.webmanifest',
  '/assets/admin-icon.svg',
  '/assets/admin-icon-192.png',
  '/assets/admin-icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith('barrio-admin-') && key !== CACHE_NAME).map(key => caches.delete(key))
  )));
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (url.pathname === '/admin.html') {
    event.respondWith(fetch(request).then(response => {
      if (response.ok) caches.open(CACHE_NAME).then(cache => cache.put('/admin.html', response.clone()));
      return response;
    }).catch(async () => (await caches.match('/admin.html')) || Response.error()));
    return;
  }

  if (APP_FILES.includes(url.pathname)) {
    event.respondWith(fetch(request).then(response => {
      if (response.ok) caches.open(CACHE_NAME).then(cache => cache.put(request, response.clone()));
      return response;
    }).catch(async () => (await caches.match(request)) || Response.error()));
  }
});
