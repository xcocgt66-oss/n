// App service worker: proxy engine (Browser tab) + push notifications
importScripts('/uv/uv.bundle.js', '/uv/uv.config.js', '/uv/uv.sw.js');
const uv = new UVServiceWorker();

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  // Only proxied pages go through the engine; the app itself is untouched
  if (uv.route(event)) event.respondWith(uv.fetch(event));
});

self.addEventListener('push', event => {
  let data = { title: 'S-Power chat', body: 'New message' };
  try { data = event.data.json(); } catch {}
  event.waitUntil(self.registration.showNotification(data.title, { body: data.body, tag: 'sp-chat' }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.openWindow('/'));
});
