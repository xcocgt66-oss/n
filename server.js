import express from 'express';
import http from 'node:http';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { WebSocketServer } from 'ws';
import { chromium } from 'playwright';
import webpush from 'web-push';
import { availableModels, modelInfo, parseImage, cloudAnswer } from './ai.js';

const password = process.env.SPOWER_PASSWORD;
const secret = process.env.SESSION_SECRET;
if (!password || !secret || secret.length < 32) throw new Error('Set SPOWER_PASSWORD and a SESSION_SECRET of at least 32 characters');
const allow = new Set((process.env.ALLOWED_BROWSER_HOSTS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean));
const sessions = new Map();
const attempts = new Map();
const sockets = new Map();
const subscriptions = new Map();
const history = [];
const browserTabs = new Map();
const agents = new Map();
const remoteTickets = new Map();
const remoteAttempts = new Map();
const remoteWss = new WebSocketServer({ noServer: true, maxPayload: 6_000_000 });
const aiPending = new Map();
const aiUsage = new Map();
const aiBusy = new Set();
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 8192 });
const vapidReady = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT);
if (vapidReady) webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
let browser;

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' wss: ws:; frame-src 'self' https:; object-src 'none'; base-uri 'none'; form-action 'self'");
  next();
});
app.use('/api/ai/chat', express.json({ limit: '4mb' }));
app.use(express.json({ limit: '20kb' }));

function token(req) {
  const match = /(?:^|; )sp_session=([^;]+)/.exec(req.headers.cookie || '');
  return match && decodeURIComponent(match[1]);
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
  const id = crypto.randomBytes(32).toString('base64url');
  sessions.set(id, { expires: Date.now() + 8 * 60 * 60_000 });
  setCookie(res, id);
  res.json({ ok: true });
});
app.get('/api/me', auth, (req, res) => res.json({ ok: true, vapid: vapidReady ? process.env.VAPID_PUBLIC_KEY : null, browserHosts: [...allow], aiModels: availableModels(), aiDailyLimit: process.env.AI_DAILY_REQUEST_LIMIT === undefined ? 100 : Math.max(0, Number(process.env.AI_DAILY_REQUEST_LIMIT) || 0) }));
app.post('/api/logout', sameOrigin, auth, async (req, res) => {
  sessions.delete(req.session.id);
  subscriptions.delete(req.session.id);
  const tab = browserTabs.get(req.session.id);
  if (tab) { browserTabs.delete(req.session.id); await tab.context.close(); }
  res.setHeader('Set-Cookie', 'sp_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ ok: true });
});
app.post('/api/remote/connect', sameOrigin, auth, (req, res) => {
  const code = typeof req.body.code === 'string' ? req.body.code.trim().toUpperCase() : '';
  const candidate = typeof req.body.password === 'string' ? req.body.password : '';
  const key = req.session.id + ':' + code;
  const state = remoteAttempts.get(key) || { count: 0, until: 0 };
  if (state.until > Date.now()) return res.status(429).json({ error: 'Too many attempts' });
  const agent = agents.get(code);
  let match = false;
  if (agent && candidate && candidate.length <= 128) {
    const hash = crypto.scryptSync(candidate, Buffer.from(agent.salt, 'hex'), 32);
    match = crypto.timingSafeEqual(hash, Buffer.from(agent.passwordHash, 'hex'));
  }
  if (!match || !agent?.ready || agent.controller) {
    state.count++;
    if (state.count >= 5) { state.count = 0; state.until = Date.now() + 15 * 60_000; }
    remoteAttempts.set(key, state);
    return res.status(401).json({ error: 'Device unavailable or credentials invalid' });
  }
  remoteAttempts.delete(key);
  const ticket = crypto.randomBytes(24).toString('base64url');
  remoteTickets.set(ticket, { code, sessionId: req.session.id, expires: Date.now() + 30_000 });
  res.json({ ticket });
});
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
  const limit = info.provider === 'local' ? 0 : process.env.AI_DAILY_REQUEST_LIMIT === undefined ? 100 : Math.max(0, Number(process.env.AI_DAILY_REQUEST_LIMIT) || 0);
  const usage = aiUsage.get(id);
  const used = usage?.day === day ? usage.count : 0;
  if (limit && used >= limit) return res.status(429).json({ error: 'Daily limit reached; it resets at 00:00 UTC' });
  if (info.provider !== 'local' && !process.env[info.env]) return res.status(503).json({ error: 'Add this provider API key in Railway variables' });
  let agent;
  if (info.provider === 'local') {
    const code = typeof req.body.code === 'string' ? req.body.code.trim().toUpperCase() : '';
    const pass = typeof req.body.devicePassword === 'string' ? req.body.devicePassword : '';
    agent = agents.get(code);
    const key = id + ':' + code;
    const guard = remoteAttempts.get(key) || { count: 0, until: 0 };
    if (guard.until > Date.now()) return res.status(429).json({ error: 'Too many device password attempts' });
    let valid = false;
    if (agent?.ready && pass.length > 0 && pass.length <= 128) valid = crypto.timingSafeEqual(crypto.scryptSync(pass, Buffer.from(agent.salt, 'hex'), 32), Buffer.from(agent.passwordHash, 'hex'));
    if (!valid) {
      guard.count++;
      if (guard.count >= 5) { guard.count = 0; guard.until = Date.now() + 15 * 60_000; }
      remoteAttempts.set(key, guard);
      return res.status(401).json({ error: 'Device unavailable or credentials invalid' });
    }
    remoteAttempts.delete(key);
  }
  if (agent?.aiBusy) return res.status(429).json({ error: 'Local model is busy' });
  if (agent) agent.aiBusy = true;
  aiBusy.add(id);
  if (info.provider !== 'local') aiUsage.set(id, { day, count: used + 1 });
  try {
    let answer;
    if (info.provider !== 'local') answer = await cloudAnswer(req.body.model, entries, image);
    else {
      const requestId = crypto.randomUUID();
      answer = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { aiPending.delete(requestId); reject(new Error('Local model timed out')); }, 120_000);
        aiPending.set(requestId, { resolve, reject, timeout, agent });
        try { agent.ws.send(JSON.stringify({ kind: 'ai-request', requestId, model: req.body.model, history: entries, image: image?.base64 || null })); }
        catch { clearTimeout(timeout); aiPending.delete(requestId); reject(new Error('Device disconnected')); }
      });
    }
    res.json({ answer, usedToday: info.provider === 'local' ? null : used + 1, day });
  } catch (error) {
    if (info.provider !== 'local') aiUsage.set(id, { day, count: used });
    res.status(502).json({ error: error.message || 'AI request failed' });
  } finally { aiBusy.delete(id); if (agent) agent.aiBusy = false; }
});
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
  const origin = req.headers.origin;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const session = getSession(req);
  let path;
  try { path = new URL(req.url, 'http://localhost').pathname; } catch { socket.destroy(); return; }
  if (path === '/agent') {
    remoteWss.handleUpgrade(req, socket, head, ws => remoteWss.emit('connection', ws, req));
    return;
  }
  let validOrigin = false;
  try { validOrigin = !!origin && new URL(origin).host === host; } catch {}
  if (!session || !validOrigin) { socket.destroy(); return; }
  if (path === '/remote') {
    remoteWss.handleUpgrade(req, socket, head, ws => remoteWss.emit('connection', ws, req, session));
    return;
  }
  if (path !== '/ws') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req, session));
});
remoteWss.on('connection', (ws, req, session) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/agent') {
    let code;
    const timeout = setTimeout(() => ws.close(), 8000);
    ws.on('message', raw => {
      let data;
      try { data = JSON.parse(raw); } catch { ws.close(); return; }
      if (!code) {
        if (data.kind !== 'register' || !/^[A-Z0-9]{10}$/.test(data.code) || !/^[a-f0-9]{64}$/.test(data.secret) || !/^[a-f0-9]{32}$/.test(data.salt) || !/^[a-f0-9]{64}$/.test(data.passwordHash)) { ws.close(); return; }
        const prior = agents.get(data.code);
        if (prior?.ws?.readyState === 1 || prior && prior.secret !== data.secret || crypto.createHash('sha256').update(Buffer.from(data.secret, 'hex')).digest('hex').slice(0, 10).toUpperCase() !== data.code) { ws.close(); return; }
        code = data.code;
        agents.set(code, { ws, secret: data.secret, salt: data.salt, passwordHash: data.passwordHash, ready: true, controller: null });
        clearTimeout(timeout);
        send(ws, { kind: 'registered' });
        return;
      }
      const agent = agents.get(code);
      if (data.kind === 'ai-result') {
        const pending = aiPending.get(data.requestId);
        if (!pending || pending.agent?.ws !== ws) return;
        aiPending.delete(data.requestId);
        clearTimeout(pending.timeout);
        if (typeof data.answer === 'string' && data.answer.length <= 30000) pending.resolve(data.answer);
        else pending.reject(new Error(typeof data.error === 'string' ? data.error.slice(0, 140) : 'Local model returned no answer'));
        return;
      }
      if (!agent || agent.ws !== ws || data.kind !== 'frame' || typeof data.image !== 'string' || data.image.length > 1_700_000 || !/^[a-zA-Z0-9+/=]+$/.test(data.image)) return;
      if (agent.controller?.readyState === 1) send(agent.controller, { kind: 'frame', image: data.image });
    });
    ws.on('close', () => {
      clearTimeout(timeout);
      const agent = agents.get(code);
      if (agent?.ws === ws) { agent.controller?.close(); agent.controller = null; agent.ws = null; agent.ready = false; for (const [requestId, pending] of aiPending) if (pending.agent === agent) { clearTimeout(pending.timeout); aiPending.delete(requestId); pending.reject(new Error('Device disconnected')); } }
    });
    return;
  }
  const ticket = url.searchParams.get('ticket');
  const claim = ticket && remoteTickets.get(ticket);
  if (ticket) remoteTickets.delete(ticket);
  const agent = claim && agents.get(claim.code);
  if (!session || !claim || claim.expires < Date.now() || claim.sessionId !== session.id || !agent || agent.controller) { ws.close(); return; }
  agent.controller = ws;
  send(agent.ws, { kind: 'start' });
  ws.on('message', raw => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    if (agent.controller !== ws || !['move', 'click', 'scroll', 'key'].includes(data.kind)) return;
    if (JSON.stringify(data).length > 512) return;
    send(agent.ws, data);
  });
  ws.on('close', () => {
    if (agent.controller === ws) { agent.controller = null; send(agent.ws, { kind: 'stop' }); }
  });
});
function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function notify(to, payload) {
  if (!vapidReady) return;
  for (const [id, subscription] of subscriptions) {
    if (id === payload.fromSession || to && id !== to) continue;
    webpush.sendNotification(subscription, JSON.stringify({ title: 'S-Power chat', body: `${payload.from}: ${payload.text.slice(0, 100)}` })).catch(() => subscriptions.delete(id));
  }
}
wss.on('connection', (ws, req, session) => {
  const id = crypto.randomUUID();
  sockets.set(id, { ws, sessionId: session.id, name: `Guest-${id.slice(0, 4)}` });
  send(ws, { kind: 'history', items: history });
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const actor = sockets.get(id);
    if (!actor) return;
    if (msg.kind === 'name' && typeof msg.name === 'string') {
      const name = msg.name.trim().slice(0, 24);
      if (!/^[\p{L}\p{N}_ -]{2,24}$/u.test(name) || [...sockets.values()].some(x => x !== actor && x.name.toLowerCase() === name.toLowerCase())) return send(ws, { kind: 'error', text: 'Username unavailable or invalid' });
      actor.name = name;
      return send(ws, { kind: 'name', name });
    }
    if (msg.kind !== 'message' || typeof msg.text !== 'string') return;
    const text = msg.text.trim().slice(0, 1000);
    if (!text) return;
    const now = Date.now();
    if (actor.last && now - actor.last < 500) return;
    actor.last = now;
    const toName = typeof msg.to === 'string' ? msg.to.trim() : '';
    const recipient = toName && [...sockets.values()].find(x => x.name.toLowerCase() === toName.toLowerCase());
    if (toName && !recipient) return send(ws, { kind: 'error', text: 'Recipient is offline' });
    const item = { kind: 'message', from: actor.name, to: recipient?.name || '', text, at: now };
    if (!recipient) { history.push(item); if (history.length > 50) history.shift(); }
    for (const peer of sockets.values()) if (!recipient || peer === recipient || peer === actor) send(peer.ws, item);
    notify(recipient?.sessionId, { ...item, fromSession: actor.sessionId });
  });
  ws.on('close', () => sockets.delete(id));
});
setInterval(async () => {
  const now = Date.now();
  for (const [id, session] of sessions) if (session.expires < now) { sessions.delete(id); subscriptions.delete(id); }
  for (const [id, tab] of browserTabs) if (!sessions.has(id) || now - tab.last > 15 * 60_000) { browserTabs.delete(id); await tab.context.close().catch(() => {}); }
  for (const [ip, entry] of attempts) if (entry.until < now && !entry.n) attempts.delete(ip);
  for (const [ticket, claim] of remoteTickets) if (claim.expires < now) remoteTickets.delete(ticket);
  for (const [key, entry] of remoteAttempts) if (entry.until < now && !entry.count) remoteAttempts.delete(key);
  for (const [id, usage] of aiUsage) if (!sessions.has(id) || usage.day !== new Date().toISOString().slice(0, 10)) aiUsage.delete(id);
}, 60_000).unref();
server.listen(Number(process.env.PORT) || 3000, '0.0.0.0');
