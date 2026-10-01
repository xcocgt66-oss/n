import { installDesktop } from './desktop.js';
import express from 'express';
import path from 'node:path';
import { createChatStore, attachChat } from './chat.js';
import { installChatHttp } from './chat-http.js';
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import webpush from 'web-push';
import { availableModels, refreshModels, modelDiagnostics, modelInfo, parseImage, cloudAnswer } from './ai.js';

const password = process.env.SPOWER_PASSWORD;
if (!password) throw new Error('Missing SPOWER_PASSWORD: add it in Railway service Variables and deploy the staged change');
const sessions = new Map();
const attempts = new Map();
const subscriptions = new Map();
const aiUsage = new Map();
const aiBusy = new Set();
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 8192 });
const vapidReady = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT);
if (vapidReady) webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' wss: ws:; frame-src 'self' https:; object-src 'none'; base-uri 'none'; form-action 'self'");
  next();
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
app.get('/api/me', auth, async (req, res) => { await refreshModels(); res.json({ aiDiagnostics: modelDiagnostics(), ok: true, sessionTag: req.session.chatId, vapid: vapidReady ? process.env.VAPID_PUBLIC_KEY : null, aiModels: availableModels(), aiDailyLimit: process.env.AI_DAILY_REQUEST_LIMIT === undefined ? 100 : Math.max(0, Number(process.env.AI_DAILY_REQUEST_LIMIT) || 0) }); });
app.post('/api/logout', sameOrigin, auth, async (req, res) => {
  chat.disconnect(req.session.id);
  desktop.release(req.session.id);
  sessions.delete(req.session.id);
  subscriptions.delete(req.session.id);
  res.setHeader('Set-Cookie', 'sp_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ ok: true });
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
app.get('/health', (req, res) => res.json({ ok: true }));
app.use(express.static('public', { index: 'index.html' }));
server.on('upgrade', (req, socket, head) => {
  if (desktop.upgrade(req, socket, head)) return;
  const origin = req.headers.origin;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const session = getSession(req);
  let path;
  try { path = new URL(req.url, 'http://localhost').pathname; } catch { socket.destroy(); return; }
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
installChatHttp(app, { wss, auth, sameOrigin });
setInterval(async () => {
  const now = Date.now();
  for (const [id, session] of sessions) if (session.expires < now) { sessions.delete(id); subscriptions.delete(id); }
  for (const [ip, entry] of attempts) if (entry.until < now && !entry.n) attempts.delete(ip);
  for (const [id, usage] of aiUsage) if (!sessions.has(id) || usage.day !== new Date().toISOString().slice(0, 10)) aiUsage.delete(id);
}, 60_000).unref();
server.listen(Number(process.env.PORT) || 3000, '0.0.0.0');
