import { installDesktop } from './desktop.js';
import express from 'express';
import path from 'node:path';
import { createChatStore, attachChat } from './chat.js';
import { installChatHttp } from './chat-http.js';
import http from 'node:http';
import crypto from 'node:crypto';
import webpush from 'web-push';

const password = process.env.SPOWER_PASSWORD;
if (!password) throw new Error('Missing SPOWER_PASSWORD: add it in Railway service Variables and deploy the staged change');
const sessions = new Map();
const attempts = new Map();
const subscriptions = new Map();
const app = express();
const server = http.createServer(app);
const vapidReady = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT);
if (vapidReady) webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-src 'self' https://www.youtube-nocookie.com https://www.youtube.com; object-src 'none'; base-uri 'none'; form-action 'self'");
  next();
});
const desktop = installDesktop(app, { auth, sameOrigin, getSession, directory: process.env.DATA_DIR || './data' });
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
  sessions.set(id, { expires: Date.now() + 8 * 60 * 60_000, chatId: crypto.randomUUID() });
  setCookie(res, id);
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => {
  res.json({
    ok: true,
    sessionTag: req.session.chatId,
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
// YOUTUBE SEARCH via Piped API (free, no API key)
// ======================================================
const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://pipedapi.in.projectsegfau.lt',
];
let pipedIndex = 0;

app.get('/api/youtube/search', auth, async (req, res) => {
  const query = String(req.query.q || '').trim();
  if (!query) return res.status(400).json({ error: 'Search query required' });
  const errors = [];
  for (let i = 0; i < PIPED_INSTANCES.length; i++) {
    const instance = PIPED_INSTANCES[(pipedIndex + i) % PIPED_INSTANCES.length];
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      const r = await fetch(`${instance}/search?q=${encodeURIComponent(query)}&filter=videos`, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' },
      });
      clearTimeout(timer);
      if (!r.ok) { errors.push(`${instance}: ${r.status}`); continue; }
      const data = await r.json();
      pipedIndex = (pipedIndex + i) % PIPED_INSTANCES.length;
      const items = (data.items || []).filter(v => v.type === 'stream').slice(0, 20).map(v => ({
        id: (v.url || '').replace('/watch?v=', ''),
        title: v.title || '',
        thumbnail: v.thumbnail || '',
        duration: v.duration || 0,
        uploaderName: v.uploaderName || '',
        views: v.views || 0,
        uploaded: v.uploaded || 0,
      }));
      return res.json({ items });
    } catch (e) { errors.push(`${instance}: ${e.message}`); }
  }
  res.status(502).json({ error: 'YouTube search unavailable', details: errors });
});

app.get('/api/youtube/trending', auth, async (req, res) => {
  const errors = [];
  for (let i = 0; i < PIPED_INSTANCES.length; i++) {
    const instance = PIPED_INSTANCES[(pipedIndex + i) % PIPED_INSTANCES.length];
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      const r = await fetch(`${instance}/trending?region=${req.query.region || 'US'}`, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' },
      });
      clearTimeout(timer);
      if (!r.ok) continue;
      const data = await r.json();
      pipedIndex = (pipedIndex + i) % PIPED_INSTANCES.length;
      const items = (data || []).slice(0, 20).map(v => ({
        id: (v.url || '').replace('/watch?v=', ''),
        title: v.title || '',
        thumbnail: v.thumbnail || '',
        duration: v.duration || 0,
        uploaderName: v.uploaderName || '',
        views: v.views || 0,
        uploaded: v.uploaded || 0,
      }));
      return res.json({ items });
    } catch (e) { errors.push(`${instance}: ${e.message}`); }
  }
  res.status(502).json({ error: 'Trending unavailable' });
});

// ======================================================
// LIGHTWEIGHT BROWSER PROXY
// ======================================================
const PROXY_MAX_SIZE = 4 * 1024 * 1024; // 4MB max page size
const BLOCKED_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::]', '[::1]']);

app.get('/api/browse', auth, async (req, res) => {
  const target = String(req.query.url || '').trim();
  if (!target) return res.status(400).json({ error: 'URL required' });
  let parsed;
  try {
    parsed = new URL(target);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw Error();
    if (BLOCKED_HOSTS.has(parsed.hostname)) throw Error();
  } catch { return res.status(400).json({ error: 'Invalid URL' }); }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const r = await fetch(target, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
      },
      redirect: 'follow',
    });
    clearTimeout(timer);
    const contentType = r.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      return res.status(415).json({ error: 'Not an HTML page' });
    }
    const html = await r.text();
    if (html.length > PROXY_MAX_SIZE) return res.status(413).json({ error: 'Page too large' });

    // Rewrite relative URLs to absolute and inject base tag
    const base = `${parsed.protocol}//${parsed.host}`;
    const injectedHtml = html
      .replace(/<head([^>]*)>/i, `<head$1><base href="${base}/" target="_self">`)
      .replace(/<script[\s\S]*?<\/script>/gi, '') // Remove scripts for safety
      .replace(/on\w+="[^"]*"/gi, ''); // Remove inline event handlers

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src * 'unsafe-inline'; script-src 'none'; frame-src 'none'");
    res.send(injectedHtml);
  } catch (e) {
    res.status(502).json({ error: e.name === 'AbortError' ? 'Page load timed out' : `Failed to load: ${e.message}` });
  }
});

// Google search proxy
app.get('/api/search', auth, async (req, res) => {
  const query = String(req.query.q || '').trim();
  if (!query) return res.status(400).json({ error: 'Search query required' });
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const r = await fetch(searchUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'Accept': 'text/html',
      },
    });
    clearTimeout(timer);
    const html = await r.text();
    // Parse DuckDuckGo HTML results
    const results = [];
    const regex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = regex.exec(html)) !== null && results.length < 15) {
      const url = decodeURIComponent(match[1].replace(/.*uddg=/, '').replace(/&.*/, ''));
      const title = match[2].replace(/<[^>]+>/g, '').trim();
      const snippet = match[3].replace(/<[^>]+>/g, '').trim();
      if (url.startsWith('http') && title) results.push({ url, title, snippet });
    }
    // Fallback: simpler parsing
    if (!results.length) {
      const linkRegex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      while ((match = linkRegex.exec(html)) !== null && results.length < 15) {
        let url = match[1];
        try { url = decodeURIComponent(url.replace(/.*uddg=/, '').replace(/&.*/, '')); } catch {}
        const title = match[2].replace(/<[^>]+>/g, '').trim();
        if (url.startsWith('http') && title) results.push({ url, title, snippet: '' });
      }
    }
    res.json({ results });
  } catch (e) {
    res.status(502).json({ error: 'Search failed' });
  }
});

// ======================================================
// PUSH NOTIFICATIONS
// ======================================================
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
import { EventEmitter } from 'node:events';
class InternalHub extends EventEmitter {
  constructor() { super(); this.clients = new Set(); }
  // Mimics WSS enough for chat.js attachChat
  handleUpgrade() {}
}
const chatHub = new InternalHub();
const chatStore = createChatStore(process.env.DATA_DIR || './data');
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
