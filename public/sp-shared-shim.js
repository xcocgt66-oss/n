// Dedicated-worker host for a SharedWorker script (see sp-shared.js)
var src = new URL(location.href).searchParams.get('src') || '';
if (!/^\/[A-Za-z0-9/_.-]+\.js$/.test(src) || src.indexOf('//') !== -1) throw new Error('Invalid worker source');
importScripts(src);
self.addEventListener('message', function (event) {
  if (event.data && event.data.__spConnect && typeof self.onconnect === 'function') self.onconnect({ ports: [event.data.port] });
});
