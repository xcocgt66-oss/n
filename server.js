import { installDesktop } from './desktop.js';
import express from 'express';
import path from 'node:path';
import { createChatStore, attachChat } from './chat.js';
import httpProxy from 'http-proxy';
import http from 'node:http';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { WebSocketServer } from 'ws';
import { chromium } from 'playwright';
import webpush from 'web-push';
import { availableModels, refreshModels, modelDiagnostics, modelInfo, parseImage, cloudAnswer } from './ai.js';

const password = process.env.SPOWER_PASSWORD;
if (!password) throw new Error('Missing SPOWER_PASSWORD: add it in Railway service Variables and deploy the staged change');
const allow = new Set((process.env.ALLOWED_BROWSER_HOSTS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean));
const sessions = new Map();
const attempts = new Map();
const subscriptions = new Map();
const browserTabs = new Map();
const aiUsage = new Map();
const aiBusy = new Set();
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 8192 });
const vapidReady = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT);
if (vapidReady) webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
let browser;
const streamUpstream = process.env.BROWSER_STREAM_UPSTREAM || '';
const streamProxy = httpProxy.createProxyServer({ target: streamUpstream || 'http://127.0.0.1:3001', ws: true, changeOrigin: false, proxyTimeout: 3600000, timeout: 3600000 });
let streamOwner = null;
const streamSockets = new Set();
function closeStream() { for (const socket of streamSockets) socket.destroy(); streamSockets.clear(); streamOwner = null; }
streamProxy.on('error', (error, req, target) => { if (typeof target.writeHead === 'function') { if (!target.headersSent) target.writeHead(502, { 'Content-Type': 'text/plain' }); target.end('Browser service unavailable'); } else target.destroy(); });
function streamHeaders(proxyReq) { proxyReq.removeHeader('cookie'); proxyReq.removeHeader('authorization'); if (process.env.BROWSER_SERVICE_PASSWORD) proxyReq.setHeader('Authorization', 'Basic ' + Buffer.from((process.env.BROWSER_SERVICE_USER || 'spower') + ':' + process.env.BROWSER_SERVICE_PASSWORD).toString('base64')); }
streamProxy.on('proxyReq', streamHeaders);
streamProxy.on('proxyReqWs', streamHeaders);

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (!req.path.startsWith('/stream/')) res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' wss: ws:; frame-src 'self' https:; object-src 'none'; base-uri 'none'; form-action 'self'");
  next();
});
app.use((req, res, next) => {
  if (!req.path.startsWith('/stream/')) return next();
  const session = getSession(req);
  if (!session || session.id !== streamOwner) return res.status(401).send('Sign in to open the browser');
  if (!streamUpstream) return res.status(503).send('Browser service unavailable');
  streamProxy.web(req, res);
});
const desktop = installDesktop(app, { auth, sameOrigin, getSession, directory: process.env.DATA_DIR || './data' });
app.use('/api/ai/chat', express.json({ limit: '4mb' }));
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
app.get('/api/me', auth, async (req, res) => { await refreshModels(); res.json({ aiDiagnostics: modelDiagnostics(), ok: true, sessionTag: req.session.chatId, vapid: vapidReady ? process.env.VAPID_PUBLIC_KEY : null, browserHosts: [...allow], browserStream: !!streamUpstream, aiModels: availableModels(), aiDailyLimit: process.env.AI_DAILY_REQUEST_LIMIT === undefined ? 100 : Math.max(0, Number(process.env.AI_DAILY_REQUEST_LIMIT) || 0) }); });
app.post('/api/logout', sameOrigin, auth, async (req, res) => {
  if (streamOwner === req.session.id) closeStream();
  chat.disconnect(req.session.id);
  desktop.release(req.session.id);
  sessions.delete(req.session.id);
  subscriptions.delete(req.session.id);
  const tab = browserTabs.get(req.session.id);
  if (tab) { browserTabs.delete(req.session.id); await tab.context.close(); }
  res.setHeader('Set-Cookie', 'sp_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ ok: true });
});
app.post('/api/browser/start', sameOrigin, auth, (req, res) => {
  if (!streamUpstream) return res.status(503).json({ error: 'Browser service is offline' });
  const owner = streamOwner && sessions.get(streamOwner);
  if (owner && owner.expires > Date.now() && streamOwner !== req.session.id) return res.status(409).json({ error: 'Browser is in use' });
  streamOwner = req.session.id;
  res.json({ url: '/stream/' });
});
app.post('/api/browser/stop', sameOrigin, auth, (req, res) => { if (streamOwner === req.session.id) closeStream(); res.json({ ok: true }); });
app.post('/api/ai/chat', sameOrigin, auth, async (req, res) => {
  const info = modelInfo(req.body?.model);
  if (!info) return res.status(400).json({ error: 'Unknown AI model' });
  const entries = req.body?.history;
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 12 || !entries.every((v, i) => v && v.role === (i % 2 ? 'assistant' : 'user') && typeof v.text === 'string' && v.text.length > 0 && v.text.length <= 4000) || entries.at(-1).role !== 'user') return res.status(400).json({ error: 'Invalid conversation' });
  let image;
  try { image = parseImage(req.body.image); } catch (error) { return res.status(400).json({ error: error.message }); }
  const id = req.session.id;
  if (aiBusy.has(id)) return res.status(429).json({ error: 'Wait for your current response' });
  const day = new Date().toISOString().slice(0, 10);
  const limit = process.env.AI_DAILY_REQUEST_LIMIT === undefined ? 100 : Math.max(0, Number(process.env.AI_DAILY_REQUEST_LIMIT) || 0);
  const usage = aiUsage.get(id);
  const used = usage?.day === day ? usage.count : 0;
  if (limit && used >= limit) return res.status(429).json({ error: 'Daily limit reached; it resets at 00:00 UTC' });
  if (!process.env[info.env]) return res.status(503).json({ error: 'Add this provider API key in Railway variables' });
  aiBusy.add(id);
  aiUsage.set(id, { day, count: used + 1 });
  try {
    const answer = await cloudAnswer(req.body.model, entries, image);
    res.json({ answer, usedToday: used + 1, day });
  } catch (error) {
    aiUsage.set(id, { day, count: used });
    res.status(502).json({ error: error.message || 'AI request failed' });
  } finally { aiBusy.delete(id); }
});
app.get('/api/host/download', auth, (req, res) => res.download(path.resolve('downloads/S-Power-Host.zip'), 'S-Power-Host.zip'));
app.post('/api/push/disable', sameOrigin, auth, (req, res) => { subscriptions.delete(req.session.id); res.json({ ok: true }); });
app.post('/api/push', sameOrigin, auth, (req, res) => {
  if (!vapidReady) return res.status(503).json({ error: 'Push is not configured' });
  const s = req.body.subscription;
  if (typeof s?.endpoint !== 'string' || !s.endpoint.startsWith('https://') || typeof s.keys?.p256dh !== 'string' || typeof s.keys?.auth !== 'string') return res.status(400).json({ error: 'Invalid subscription' });
  subscriptions.set(req.session.id, s);
  res.json({ ok: true });
});
function privateAddress(ip) {
  if (net.isIP(ip) === 4) {
    const p = ip.split('.').map(Number);
    return p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224 || p[0] === 169 && p[1] === 254 || p[0] === 172 && p[1] >= 16 && p[1] <= 31 || p[0] === 192 && p[1] === 168 || p[0] === 100 && p[1] >= 64 && p[1] <= 127 || p[0] === 192 && p[1] === 0;
  }
  return !ip || ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80') || ip.startsWith('::ffff:');
}
async function allowedUrl(input) {
  let u;
  try { u = new URL(input); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !allow.has(u.hostname.toLowerCase()) || net.isIP(u.hostname)) return false;
  try { return (await dns.lookup(u.hostname, { all: true })).every(x => !privateAddress(x.address)); } catch { return false; }
}
async function getTab(id) {
  if (browserTabs.has(id)) return browserTabs.get(id);
  if (!browser) browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block', acceptDownloads: false });
  const page = await context.newPage();
  const tab = { context, page, adblock: true, last: Date.now(), busy: false };
  await context.route('**/*', async route => {
    const url = route.request().url();
    if (!await allowedUrl(url)) return route.abort();
    if (tab.adblock && /(?:^|[./-])(doubleclick|googlesyndication|adservice|adsystem)(?:[./-]|$)/i.test(new URL(url).hostname)) return route.abort();
    return route.continue();
  });
  browserTabs.set(id, tab);
  return tab;
}
app.post('/api/browser', sameOrigin, auth, async (req, res) => {
  if (!allow.size) return res.status(503).json({ error: 'Configure ALLOWED_BROWSER_HOSTS' });
  const { action, url, x, y, deltaY, text, adblock } = req.body;
  if (!['navigate', 'click', 'scroll', 'type', 'refresh', 'block'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
  if (action === 'navigate' && !await allowedUrl(url)) return res.status(400).json({ error: 'Host is not allowed' });
  let tab;
  try {
    tab = await getTab(req.session.id);
    if (tab.busy) return res.status(429).json({ error: 'Browser is busy' });
    tab.busy = true;
    tab.last = Date.now();
    if (action === 'navigate') await tab.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    if (action === 'click' && Number.isFinite(x) && Number.isFinite(y)) await tab.page.mouse.click(Math.max(0, Math.min(1279, x)), Math.max(0, Math.min(799, y)));
    if (action === 'scroll' && Number.isFinite(deltaY)) await tab.page.mouse.wheel(0, Math.max(-1600, Math.min(1600, deltaY)));
    if (action === 'type' && typeof text === 'string') await tab.page.keyboard.type(text.slice(0, 400));
    if (action === 'refresh') await tab.page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
    if (action === 'block') tab.adblock = adblock !== false;
    const screenshot = await tab.page.screenshot({ type: 'jpeg', quality: 65, timeout: 10000 });
    res.json({ url: tab.page.url(), image: `data:image/jpeg;base64,${screenshot.toString('base64')}`, adblock: tab.adblock });
  } catch { res.status(502).json({ error: 'This site could not be rendered' }); }
  finally { if (tab) tab.busy = false; }
});
app.get('/health', (req, res) => res.json({ ok: true }));
app.use(express.static('public', { index: 'index.html' }));
server.on('upgrade', (req, socket, head) => {
  if (desktop.upgrade(req, socket, head)) return;
  const origin = req.headers.origin;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const session = getSession(req);
  let path;
  try { path = new URL(req.url, 'http://localhost').pathname; } catch { socket.destroy(); return; }
  if (path.startsWith('/stream/')) {
    let valid = false;
    try { valid = !!origin && new URL(origin).host === host; } catch {}
    if (!streamUpstream || !session || session.id !== streamOwner || !valid) { socket.destroy(); return; }
    streamSockets.add(socket);
    socket.on('close', () => streamSockets.delete(socket));
    streamProxy.ws(req, socket, head);
    return;
  }
  let validOrigin = false;
  try { validOrigin = !!origin && new URL(origin).host === host; } catch {}
  if (!session || !validOrigin) { socket.destroy(); return; }
  if (path !== '/ws') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req, session));
});
const chatStore = createChatStore(process.env.DATA_DIR || './data');
const chat = attachChat(wss, { sessions, store: chatStore, notify: (sessionId, item) => {
  const subscription = subscriptions.get(sessionId);
  if (!vapidReady || !subscription) return;
  webpush.sendNotification(subscription, JSON.stringify({ title: item.toId ? 'Private message' : 'You were mentioned', body: `${item.from}: ${item.sticker ? 'Sticker' : item.text.slice(0, 100)}` })).catch(error => { if ([404, 410].includes(error.statusCode)) subscriptions.delete(sessionId); });
} });
setInterval(async () => {
  const now = Date.now();
  if (streamOwner && (!sessions.has(streamOwner) || sessions.get(streamOwner).expires < now)) closeStream();
  for (const [id, session] of sessions) if (session.expires < now) { sessions.delete(id); subscriptions.delete(id); }
  for (const [id, tab] of browserTabs) if (!sessions.has(id) || now - tab.last > 15 * 60_000) { browserTabs.delete(id); await tab.context.close().catch(() => {}); }
  for (const [ip, entry] of attempts) if (entry.until < now && !entry.n) attempts.delete(ip);
  for (const [id, usage] of aiUsage) if (!sessions.has(id) || usage.day !== new Date().toISOString().slice(0, 10)) aiUsage.delete(id);
}, 60_000).unref();
server.listen(Number(process.env.PORT) || 3000, '0.0.0.0');
