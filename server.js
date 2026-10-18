import { installDesktop } from './desktop.js';
import { installYouTube } from './youtube.js';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { createChatStore, attachChat } from './chat.js';
import { installChatHttp } from './chat-http.js';
import http from 'node:http';
import crypto from 'node:crypto';
import webpush from 'web-push';
import { createBareServer } from '@tomphttp/bare-server-node';

const pkgDist = name => path.resolve('node_modules', name, 'dist');
const uvPath = pkgDist('@titaniumnetwork-dev/ultraviolet');
const baremuxPath = pkgDist('@mercuryworkshop/bare-mux');
const baremodPath = pkgDist('@mercuryworkshop/bare-as-module3');

const password = process.env.SPOWER_PASSWORD;
if (!password) throw new Error('Missing SPOWER_PASSWORD: add it in Railway service Variables and deploy the staged change');
const sessions = new Map();
const attempts = new Map();
const subscriptions = new Map();
const app = express();
const dataDir = process.env.DATA_DIR || './data';

// Web proxy engine: every page the Browser tab opens is fetched by THIS server (its IP),
// over plain HTTPS requests to /bare/. Only signed-in sessions may use it.
const bare = createBareServer('/bare/', {
  logErrors: process.env.PROXY_DEBUG === '1',
  blockLocal: process.env.PROXY_ALLOW_LOCAL !== '1',
  connectionLimiter: { maxConnectionsPerIP: 100000, windowDuration: 60, blockDuration: 1 },
});
// The proxy transport sends requests without cookies, so it authenticates with a per-session
// token in the path: /bare/<token>/v3/...  (token is issued by /api/me after sign-in)
function bareAuth(req) {
  const m = /^\/bare\/([A-Za-z0-9_-]{32,64})(\/.*)$/.exec(req.url || '');
  if (m) {
    for (const s of sessions.values()) if (s.proxyToken === m[1] && s.expires > Date.now()) { req.url = '/bare' + m[2]; return true; }
    return false;
  }
  return !!getSession(req);
}
const server = http.createServer((req, res) => {
  if ((req.url || '').startsWith('/bare/')) {
    if (!bareAuth(req) || !bare.shouldRoute(req)) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{"error":"Sign in required"}'); }
    return bare.routeRequest(req, res);
  }
  app(req, res);
});
// Optional: websites that use WebSockets themselves (only works where WS isn't blocked; normal browsing doesn't need it)
server.on('upgrade', (req, socket, head) => {
  if ((req.url || '').startsWith('/bare/') && bareAuth(req) && bare.shouldRoute(req)) return bare.routeUpgrade(req, socket, head);
  socket.destroy();
});
const vapidReady = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT);
if (vapidReady) webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // Proxy engine files run rewritten third-party code, so they cannot carry the app's strict CSP
  const proxyAsset = /^\/(uv\/|baremux\/|baremod\/|sw\.js|sp-shared)/.test(req.path);
  if (!proxyAsset) res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob:; connect-src 'self'; frame-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'");
  next();
});

// ---- Proxy engine static files ----
const uvBundle = fs.readFileSync(path.resolve('public/sp-shared.js'), 'utf8') + '\n' + fs.readFileSync(path.join(uvPath, 'uv.bundle.js'), 'utf8');
app.get('/uv/uv.bundle.js', (req, res) => { res.type('application/javascript').send(uvBundle); });
app.get('/uv/uv.config.js', (req, res) => res.sendFile(path.resolve('public/uv/uv.config.js')));
app.use('/uv/', express.static(uvPath, { index: false }));
app.use('/baremux/', express.static(baremuxPath, { index: false }));
app.use('/baremod/', express.static(baremodPath, { index: false }));
// If the service worker is not controlling the frame yet (first visit / hard reload), load it and retry once
app.get('/uv/service/*', (req, res) => {
  res.type('html').send(`<!doctype html><meta charset="utf-8"><body style="background:#101214;color:#aaa;font-family:sans-serif;display:grid;place-items:center;height:90vh">Starting browser engine…<script>
  (async()=>{try{await navigator.serviceWorker.register('/sw.js',{scope:'/'});await navigator.serviceWorker.ready;}catch(e){}
  const k='sp_sw_retry',t=+sessionStorage.getItem(k)||0;if(Date.now()-t>15000){sessionStorage.setItem(k,Date.now());location.reload();}else{document.body.textContent='Browser engine failed to start. Reload the app and try again.';}})();
  </script>`);
});

const desktop = installDesktop(app, { auth, sameOrigin, getSession, directory: dataDir });
app.use(express.json({ limit: '20kb' }));

function token(req) {
  const match = /(?:^|; )sp_session=([^;]+)/.exec(req.headers.cookie || '');
  try { return match && decodeURIComponent(match[1]); } catch { return null; }
}
function getSession(req) {
  const id = token(req);
  const s = id && sessions.get(id);
  if (!s || s.expires < Date.now()) return null;
  return { id, ...s };
}
function auth(req, res, next) {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: 'Sign in required' });
  req.session = s;
  next();
}
function sameOrigin(req, res, next) {
  const origin = req.get('origin');
  const host = req.get('x-forwarded-host') || req.get('host');
  try { if (!origin || !host || new URL(origin).host !== host) throw Error(); } catch { return res.status(403).json({ error: 'Origin rejected' }); }
  next();
}
function digest(s) { return crypto.createHash('sha256').update(s).digest(); }
function setCookie(res, id) { res.setHeader('Set-Cookie', `sp_session=${encodeURIComponent(id)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`); }

app.post('/api/login', sameOrigin, (req, res) => {
  const ip = req.ip;
  const state = attempts.get(ip) || { n: 0, until: 0 };
  if (state.until > Date.now()) return res.status(429).json({ error: 'Try again later' });
  const entered = typeof req.body.password === 'string' ? req.body.password : '';
  if (!crypto.timingSafeEqual(digest(entered), digest(password))) {
    state.n++;
    if (state.n >= 5) { state.until = Date.now() + 15 * 60_000; state.n = 0; }
    attempts.set(ip, state);
    return res.status(401).json({ error: 'Invalid password' });
  }
  attempts.delete(ip);
  const existing = getSession(req);
  if (existing) { setCookie(res, existing.id); return res.json({ ok: true }); }
  const id = crypto.randomBytes(32).toString('base64url');
  sessions.set(id, { expires: Date.now() + 8 * 60 * 60_000, chatId: crypto.randomUUID(), proxyToken: crypto.randomBytes(24).toString('base64url') });
  setCookie(res, id);
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => {
  res.json({
    ok: true,
    sessionTag: req.session.chatId,
    proxyToken: req.session.proxyToken,
    vapid: vapidReady ? process.env.VAPID_PUBLIC_KEY : null,
  });
});

app.post('/api/logout', sameOrigin, auth, async (req, res) => {
  chat.disconnect(req.session.id);
  desktop.release(req.session.id);
  sessions.delete(req.session.id);
  subscriptions.delete(req.session.id);
  res.setHeader('Set-Cookie', 'sp_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ ok: true });
});

// ======================================================
// PUSH NOTIFICATIONS
// ======================================================
installYouTube(app, { auth, directory: dataDir });

app.get('/api/host/download', auth, (req, res) => res.download(path.resolve('downloads/S-Power-Host.zip'), 'S-Power-Host.zip'));
app.post('/api/push/disable', sameOrigin, auth, (req, res) => { subscriptions.delete(req.session.id); res.json({ ok: true }); });
app.post('/api/push', sameOrigin, auth, (req, res) => {
  if (!vapidReady) return res.status(503).json({ error: 'Push is not configured' });
  const s = req.body.subscription;
  if (typeof s?.endpoint !== 'string' || !s.endpoint.startsWith('https://') || typeof s.keys?.p256dh !== 'string' || typeof s.keys?.auth !== 'string') return res.status(400).json({ error: 'Invalid subscription' });
  subscriptions.set(req.session.id, s);
  res.json({ ok: true });
});
app.get('/health', (req, res) => res.json({ ok: true }));
app.use(express.static('public', { index: 'index.html' }));

// ======================================================
// CHAT (HTTP-only, no WebSocket upgrade)
// ======================================================
// Internal EventEmitter-based chat hub (no external WebSocket)
class InternalHub extends EventEmitter {
  constructor() { super(); this.clients = new Set(); }
  // Mimics WSS enough for chat.js attachChat
  handleUpgrade() {}
}
const chatHub = new InternalHub();
const chatStore = createChatStore(dataDir);
const chat = attachChat(chatHub, { sessions, store: chatStore, notify: (sessionId, item) => {
  const subscription = subscriptions.get(sessionId);
  if (!vapidReady || !subscription) return;
  webpush.sendNotification(subscription, JSON.stringify({ title: item.toId ? 'Private message' : 'You were mentioned', body: `${item.from}: ${item.sticker ? 'Sticker' : item.text.slice(0, 100)}` })).catch(error => { if ([404, 410].includes(error.statusCode)) subscriptions.delete(sessionId); });
} });
installChatHttp(app, { wss: chatHub, auth, sameOrigin });

// ======================================================
// DESKTOP (SSE-based, no WebSocket upgrade needed on server)
// ======================================================
// Desktop host connections use SSE + HTTP POST (handled in desktop.js)
// No server.on('upgrade') needed

// ======================================================
// CLEANUP
// ======================================================
setInterval(async () => {
  const now = Date.now();
  for (const [id, session] of sessions) if (session.expires < now) { sessions.delete(id); subscriptions.delete(id); }
  for (const [ip, entry] of attempts) if (entry.until < now && !entry.n) attempts.delete(ip);
}, 60_000).unref();

server.listen(Number(process.env.PORT) || 3000, '0.0.0.0');
