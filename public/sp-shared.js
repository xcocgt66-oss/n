// SharedWorker fallback for browsers that lack it (older Android browsers).
// The proxy engine (bare-mux) needs one shared worker for the app and every proxied frame;
// here a single dedicated Worker owned by the top window plays that role.
(function () {
  if (typeof window === 'undefined' || typeof window.SharedWorker === 'function') return;
  var hub = null;
  try { if (window.top !== window && window.top.__spSharedHub) hub = window.top.__spSharedHub; } catch (e) {}
  if (!hub) {
    var workers = {};
    hub = {
      connect: function (url) {
        var w = workers[url];
        if (!w) { w = new Worker('/sp-shared-shim.js?src=' + encodeURIComponent(url)); workers[url] = w; }
        var channel = new MessageChannel();
        w.postMessage({ __spConnect: true, port: channel.port2 }, [channel.port2]);
        return channel.port1;
      }
    };
    window.__spSharedHub = hub;
  }
  window.SharedWorker = function SharedWorker(url) { return { port: hub.connect(new URL(String(url), location.href).pathname) }; };
})();
