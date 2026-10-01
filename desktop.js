import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { promisify } from 'node:util';
import { WebSocketServer } from 'ws';

const scrypt = promisify(crypto.scrypt);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const safeEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const validCode = code => typeof code === 'string' && /^[A-F0-9]{10}$/.test(code);
const packet = (kind, id, payload) => Buffer.concat([Buffer.from([kind]), Buffer.from(id.replaceAll('-', ''), 'hex'), Buffer.from(payload)]);
const uuid = bytes => { const h = bytes.toString('hex'); return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`; };
const MAX_BUFFER = 8 * 1024 * 1024;

export function installDesktop(app, { auth, sameOrigin, getSession, directory }) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const registryFile = path.join(directory, 'devices.json');
  let registry = {};
  try { registry = JSON.parse(fs.readFileSync(registryFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const hosts = new Map(), enrollments = new Map(), leases = new Map(), channels = new Map(), attempts = new Map();
  const hostWss = new WebSocketServer({ noServer: true, maxPayload: MAX_BUFFER, perMessageDeflate: false });
  const viewerWss = new WebSocketServer({ noServer: true, maxPayload: MAX_BUFFER, perMessageDeflate: false });
  function save() { fs.writeFileSync(registryFile + '.tmp', JSON.stringify(registry), { mode: 0o600 }); fs.renameSync(registryFile + '.tmp', registryFile); }
  function send(ws, data, binary = false) {
    if (ws?.readyState !== 1) return false;
    if (ws.bufferedAmount > MAX_BUFFER) { ws.close(1013, 'Connection too slow'); return false; }
    ws.send(binary === true || binary === null ? data : JSON.stringify(data), { binary: binary === true }); return true;
  }
  function finish(id, notify = true) {
    const channel = channels.get(id); if (!channel) return;
    channels.delete(id); clearTimeout(channel.timeout);
    if (notify) send(channel.host.ws, { kind: 'close', id });
    if (channel.res && !channel.res.writableEnded) { if (!channel.res.headersSent) channel.res.statusCode = 502; channel.res.end(); }
    channel.ws?.close();
    channel.reject?.(new Error('Host did not accept the session'));
    if (channel.stream) release(channel.sessionId);
  }
  function release(sessionId) {
    const lease = leases.get(sessionId); if (!lease) return;
    leases.delete(sessionId);
    for (const [id, c] of channels) if (c.sessionId === sessionId) finish(id);
    send(hosts.get(lease.code)?.ws, { kind: 'end-session' });
  }
  function leaseFor(req, code) {
    const session = getSession(req), lease = session && leases.get(session.id);
    if (!session || !lease || lease.code !== code || lease.expires <= Date.now()) return null;
    const host = hosts.get(code); if (!host || host.ws.readyState !== 1) return null;
    return { session, host };
  }
  function routeCode(url) { return /^\/desktop\/([A-F0-9]{10})(?:\/|\?|$)/.exec(url || '')?.[1]; }
  function headersFor(req) {
    const headers = {};
    for (const name of ['content-type', 'accept', 'range', 'if-none-match', 'authorization']) if (typeof req.headers[name] === 'string') headers[name] = req.headers[name];
    if (req.headers.cookie) headers.cookie = req.headers.cookie.split(';').filter(v => !/^\s*sp_/.test(v)).join(';');
    return headers;
  }
  app.post('/api/desktop/enroll', express.json({ limit: '2kb' }), sameOrigin, auth, (req, res) => {
    for (const [token, item] of enrollments) if (item.sessionId === req.session.id || item.expires < Date.now()) enrollments.delete(token);
    const token = crypto.randomBytes(32).toString('base64url'), expires = Date.now() + 10 * 60_000;
    enrollments.set(token, { expires, sessionId: req.session.id });
    res.json({ token, expires });
  });
  app.post('/api/desktop/connect', express.json({ limit: '2kb' }), sameOrigin, auth, async (req, res) => {
    const code = String(req.body?.code || '').trim().toUpperCase(), password = req.body?.password;
    const key = req.session.id + ':' + code, guard = attempts.get(key) || { count: 0, until: 0 };
    if (guard.until > Date.now()) return res.status(429).json({ error: 'Too many attempts; try later' });
    const device = validCode(code) && registry[code], host = hosts.get(code);
    let valid = false;
    if (device && typeof password === 'string' && password.length >= 12 && password.length <= 128) {
      const actual = await scrypt(password, Buffer.from(device.salt, 'hex'), 32);
      valid = safeEqual(actual.toString('hex'), device.passwordHash);
    }
    if (!valid || !host || host.ws.readyState !== 1) {
      guard.count++; if (guard.count >= 5) { guard.count = 0; guard.until = Date.now() + 15 * 60_000; }
      attempts.set(key, guard); return res.status(401).json({ error: 'Host offline or device credentials invalid' });
    }
    if ([...leases].some(([id, l]) => id !== req.session.id && l.code === code && l.expires > Date.now())) return res.status(409).json({ error: 'This device already has an active session' });
    attempts.delete(key); release(req.session.id);
    leases.set(req.session.id, { code, expires: req.session.expires });
    try {
      await new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        channels.set(id, { host, sessionId: req.session.id, type: 'control', resolve, reject, timeout: setTimeout(() => finish(id), 20000) });
        send(host.ws, { kind: 'begin-session', id, password });
      });
      res.json({ url: `/desktop/${code}/`, code, engine: 'Sunshine / Moonlight Web' });
    } catch { release(req.session.id); res.status(502).json({ error: 'Host engine could not start. Check the host app log.' }); }
  });
  app.post('/api/desktop/disconnect', express.json({ limit: '2kb' }), sameOrigin, auth, (req, res) => { release(req.session.id); res.json({ ok: true }); });
  app.get('/api/desktop/status', auth, (req, res) => {
    const lease = leases.get(req.session.id), online = lease && leaseFor(req, lease.code);
    res.json({ connected: !!online, code: online ? lease.code : null });
  });
  app.use('/desktop', async (req, res) => {
    const target = req.originalUrl, code = routeCode(target), selected = code && leaseFor(req, code);
    if (!selected) return res.status(401).send('Connect to this device from Remote Access first.');
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(req.method)) return res.sendStatus(405);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      try { if (new URL(req.headers.origin).host !== (req.headers['x-forwarded-host'] || req.headers.host)) return res.sendStatus(403); } catch { return res.sendStatus(403); }
    }
    if ([...channels.values()].filter(c => c.host === selected.host).length >= 64) return res.status(429).send('Too many open requests');
    const chunks = []; let size = 0;
    try { for await (const chunk of req) { size += chunk.length; if (size > 256 * 1024) return res.sendStatus(413); chunks.push(chunk); } } catch { return; }
    const id = crypto.randomUUID();
    const channel = { host: selected.host, sessionId: selected.session.id, res, type: 'http', timeout: setTimeout(() => finish(id), 60000) };
    channels.set(id, channel);
    res.on('close', () => finish(id));
    send(selected.host.ws, { kind: 'http', id, method: req.method, path: target, headers: headersFor(req), body: Buffer.concat(chunks).toString('base64') });
  });
  hostWss.on('connection', ws => {
    let host;
    ws.alive = true; ws.on('pong', () => ws.alive = true);
    const timeout = setTimeout(() => ws.close(), 10000);
    ws.on('message', (raw, binary) => {
      if (binary) {
        if (!host || raw.length < 17) return ws.close();
        const kind = raw[0], id = uuid(raw.subarray(1,17)), channel = channels.get(id);
        if (!channel || channel.host !== host) return;
        const payload = raw.subarray(17);
        if (kind === 1 && channel.type === 'http') {
          if (!channel.res.headersSent) return finish(id);
          channel.res.write(payload, () => send(ws, { kind: 'credit', id }));
        } else if ((kind === 2 || kind === 3) && channel.type === 'ws') send(channel.ws, payload, kind === 3 ? true : null);
        return;
      }
      let msg; try { msg = JSON.parse(raw); } catch { return ws.close(); }
      if (!host) {
        if (msg.kind !== 'register' || !validCode(msg.code) || !/^[a-f0-9]{64}$/.test(msg.secret) || !/^[a-f0-9]{32}$/.test(msg.salt) || !/^[a-f0-9]{64}$/.test(msg.passwordHash) || hash(Buffer.from(msg.secret,'hex')).slice(0,10).toUpperCase() !== msg.code) return ws.close();
        const existing = registry[msg.code];
        if (existing && !safeEqual(existing.secretHash, hash(msg.secret))) return ws.close();
        if (!existing) {
          const token = typeof msg.enrollment === 'string' && enrollments.get(msg.enrollment);
          if (!token || token.expires < Date.now()) { send(ws, { kind: 'error', message: 'Create a fresh pairing code in the portal' }); return ws.close(); }
          enrollments.delete(msg.enrollment);
          if (Object.keys(registry).length >= 100) return ws.close();
        }
        registry[msg.code] = { secretHash: hash(msg.secret), salt: msg.salt, passwordHash: msg.passwordHash };
        try { save(); } catch { return ws.close(); }
        const prior = hosts.get(msg.code);
        if (prior) {
          for (const [id, lease] of leases) if (lease.code === msg.code) release(id);
          prior.ws.close();
        }
        host = { ws, code: msg.code }; hosts.set(msg.code, host); clearTimeout(timeout);
        send(ws, { kind: 'registered' }); return;
      }
      const channel = channels.get(msg.id);
      if (!channel || channel.host !== host) return;
      if (msg.kind === 'session-ready' && channel.type === 'control') { clearTimeout(channel.timeout); channels.delete(msg.id); channel.resolve(); return; }
      if (msg.kind === 'headers' && channel.type === 'http' && !channel.res.headersSent) {
        channel.res.statusCode = Number.isInteger(msg.status) && msg.status >= 200 && msg.status < 600 ? msg.status : 502;
        for (const name of ['content-type','content-length','content-range','accept-ranges','etag']) if (typeof msg.headers?.[name] === 'string' && !/[\r\n]/.test(msg.headers[name])) channel.res.setHeader(name, msg.headers[name]);
        if (typeof msg.headers?.location === 'string' && msg.headers.location.startsWith(`/desktop/${host.code}/`) && !/[\r\n]/.test(msg.headers.location)) channel.res.setHeader('Location', msg.headers.location);
        if (Array.isArray(msg.cookies)) {
          const cookies = msg.cookies.filter(c => typeof c === 'string' && !/[\r\n]/.test(c) && !/^sp_/i.test(c)).map(c => c.replace(/;\s*(?:Domain|Path)=[^;]*/gi, '') + `; Path=/desktop/${host.code}/; Secure; SameSite=Strict`);
          if (cookies.length) channel.res.setHeader('Set-Cookie', cookies);
        }
        channel.res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'sha256-rIN45+SUBO4U012a5IK5piEITuk5/0Pm3JdMLlbiLSs='; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' wss:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'");
        channel.res.flushHeaders();
      } else if (msg.kind === 'end' && channel.type === 'http') { channel.res.end(); finish(msg.id, false); }
      else if (msg.kind === 'closed' || msg.kind === 'error') finish(msg.id, false);
    });
    ws.on('close', () => {
      clearTimeout(timeout);
      if (host && hosts.get(host.code) === host) {
        hosts.delete(host.code);
        for (const [id, channel] of channels) if (channel.host === host) finish(id, false);
        for (const [id, lease] of leases) if (lease.code === host.code) leases.delete(id);
      }
    });
    ws.on('error', () => {});
  });
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [id, lease] of leases) if (lease.expires <= now) release(id);
    for (const [id, token] of enrollments) if (token.expires <= now) enrollments.delete(id);
    for (const [id, guard] of attempts) if (guard.until && guard.until <= now) attempts.delete(id);
    for (const ws of hostWss.clients) { if (!ws.alive) ws.terminate(); else { ws.alive = false; ws.ping(); } }
  }, 20000); cleanup.unref();
  return {
    release,
    upgrade(req, socket, head) {
      let pathname; try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { socket.destroy(); return true; }
      if (pathname === '/host-link') { hostWss.handleUpgrade(req,socket,head,ws=>hostWss.emit('connection',ws)); return true; }
      if (!pathname.startsWith('/desktop/')) return false;
      const code = routeCode(req.url), selected = code && leaseFor(req,code);
      let valid = false; try { valid = new URL(req.headers.origin).host === (req.headers['x-forwarded-host'] || req.headers.host); } catch {}
      if (!selected || !valid || [...channels.values()].filter(c=>c.host===selected.host).length>=64) { socket.destroy(); return true; }
      viewerWss.handleUpgrade(req,socket,head,ws=>{
        const id=crypto.randomUUID(), channel={host:selected.host,sessionId:selected.session.id,ws,type:'ws',stream:pathname.endsWith('/api/host/stream')};
        channels.set(id,channel);
        send(selected.host.ws,{kind:'ws',id,path:req.url,headers:headersFor(req),protocols:(req.headers['sec-websocket-protocol']||'').split(',').map(v=>v.trim()).filter(Boolean)});
        ws.on('message',(data,binary)=>send(selected.host.ws,packet(binary?3:2,id,data),true));
        ws.on('close',()=>finish(id)); ws.on('error',()=>finish(id));
      }); return true;
    }
  };
}
