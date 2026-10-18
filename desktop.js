// Desktop remote access module — HTTPS only (SSE + HTTP POST)
// Host connects via SSE (EventSource) for receiving commands
// and sends data back via HTTP POST. No WebSocket needed.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const scryptAsync = promisify(crypto.scrypt);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const safeEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const validCode = code => typeof code === 'string' && /^[A-F0-9]{10}$/.test(code);

export function installDesktop(app, { auth, sameOrigin, getSession, directory }) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const registryFile = path.join(directory, 'devices.json');
  let registry = {};
  try { registry = JSON.parse(fs.readFileSync(registryFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  function save() { fs.writeFileSync(registryFile + '.tmp', JSON.stringify(registry), { mode: 0o600 }); fs.renameSync(registryFile + '.tmp', registryFile); }

  const hosts = new Map();       // code -> host object
  const enrollments = new Map();  // token -> { expires, sessionId }
  const leases = new Map();       // sessionId -> { code, expires }
  const pending = new Map();      // requestId -> { resolve, reject, timer, res?, headers?, chunks? }
  const attempts = new Map();     // key -> { count, until }

  function sendSSE(host, event, data) {
    if (!host || !host.res || host.res.writableEnded) return false;
    try {
      host.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      return true;
    } catch { return false; }
  }

  function releaseSession(sessionId) {
    const lease = leases.get(sessionId);
    if (!lease) return;
    leases.delete(sessionId);
    const host = hosts.get(lease.code);
    if (host) sendSSE(host, 'cmd', { kind: 'end-session' });
    // Clean up pending requests for this session
    for (const [id, p] of pending) {
      if (p.sessionId === sessionId) {
        clearTimeout(p.timer);
        pending.delete(id);
        if (p.resolve) p.resolve({ error: true });
      }
    }
  }

  function leaseFor(req, code) {
    const session = getSession(req), lease = session && leases.get(session.id);
    if (!session || !lease || lease.code !== code || lease.expires <= Date.now()) return null;
    const host = hosts.get(code);
    if (!host || host.res.writableEnded) return null;
    return { session, host };
  }

  function routeCode(url) { return /^\/desktop\/([A-F0-9]{10})(?:\/|\?|$)/.exec(url || '')?.[1]; }

  // ===================== ENROLLMENT =====================
  app.post('/api/desktop/enroll', sameOrigin, auth, (req, res) => {
    for (const [token, item] of enrollments) if (item.sessionId === req.session.id || item.expires < Date.now()) enrollments.delete(token);
    const token = crypto.randomBytes(32).toString('base64url'), expires = Date.now() + 10 * 60_000;
    enrollments.set(token, { expires, sessionId: req.session.id });
    res.json({ token, expires });
  });

  // ===================== HOST SSE CONNECTION =====================
  // Host connects via EventSource. Server pushes commands as SSE events.
  app.get('/api/host/events', (req, res) => {
    const code = String(req.query.code || '').trim().toUpperCase();
    const secret = String(req.query.secret || '');
    const salt = String(req.query.salt || '');
    const passwordHash = String(req.query.passwordHash || '');
    const enrollment = String(req.query.enrollment || '');

    if (!validCode(code) || !/^[a-f0-9]{64}$/.test(secret) || !/^[a-f0-9]{32}$/.test(salt) || !/^[a-f0-9]{64}$/.test(passwordHash)) {
      return res.status(400).json({ error: 'Invalid registration' });
    }
    if (hash(Buffer.from(secret, 'hex')).slice(0, 10).toUpperCase() !== code) {
      return res.status(403).json({ error: 'Code mismatch' });
    }

    const existing = registry[code];
    if (existing && !safeEqual(existing.secretHash, hash(secret))) {
      return res.status(403).json({ error: 'Identity mismatch' });
    }

    // New device: require enrollment token
    if (!existing) {
      const token = enrollments.get(enrollment);
      if (!token || token.expires < Date.now()) {
        return res.status(403).json({ error: 'Create a fresh pairing code in the portal' });
      }
      enrollments.delete(enrollment);
      if (Object.keys(registry).length >= 100) return res.status(409).json({ error: 'Too many devices' });
    }

    // Save/update device
    registry[code] = { secretHash: hash(secret), salt, passwordHash };
    try { save(); } catch { return res.status(500).json({ error: 'Save failed' }); }

    // Disconnect old host connection for same code
    const prior = hosts.get(code);
    if (prior) {
      for (const [id, lease] of leases) if (lease.code === code) releaseSession(id);
      try { prior.res.end(); } catch {}
      hosts.delete(code);
    }

    // Set up SSE stream
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write(':connected\n\n');

    const host = { res, code, sessionActive: false, sessionId: null, cookie: null };
    hosts.set(code, host);
    sendSSE(host, 'cmd', { kind: 'registered' });

    // Keepalive
    const keepalive = setInterval(() => {
      if (host.res.writableEnded) { clearInterval(keepalive); return; }
      try { host.res.write(':ping\n\n'); } catch { clearInterval(keepalive); }
    }, 25000);

    req.on('close', () => {
      clearInterval(keepalive);
      if (hosts.get(code) === host) {
        hosts.delete(code);
        for (const [id, lease] of leases) if (lease.code === code) { leases.delete(id); }
        for (const [id, p] of pending) {
          if (p.hostCode === code) { clearTimeout(p.timer); pending.delete(id); p.resolve?.({ error: true }); }
        }
      }
    });
  });

  // ===================== HOST DATA POST =====================
  // Host sends HTTP response data back via POST.
  // Format: JSON header line + newline + binary payload
  app.post('/api/host/data', (req, res) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) { req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks);
        const sep = raw.indexOf(0x0A);
        if (sep < 0) return res.status(400).end();
        const header = JSON.parse(raw.slice(0, sep).toString('utf8'));
        const payload = raw.slice(sep + 1);
        const code = header.code;
        const host = hosts.get(code);
        if (!host) return res.status(404).end();
        const kind = header.kind;

        if (kind === 'session-ready') {
          host.sessionActive = true;
          host.cookie = header.cookie || null;
          host.sessionId = header.sessionId;
          const p = pending.get(header.id);
          if (p) { clearTimeout(p.timer); pending.delete(header.id); p.resolve?.({ ready: true }); }
        } else if (kind === 'session-error') {
          const p = pending.get(header.id);
          if (p) { clearTimeout(p.timer); pending.delete(header.id); p.resolve?.({ error: true }); }
        } else if (kind === 'headers') {
          const p = pending.get(header.id);
          if (p && p.proxyRes && !p.proxyRes.headersSent) {
            const status = Number.isInteger(header.status) && header.status >= 100 && header.status < 600 ? header.status : 502;
            p.proxyRes.statusCode = status;
            const safe = ['content-type','content-length','content-range','accept-ranges','etag','location'];
            for (const name of safe) {
              if (typeof header.headers?.[name] === 'string' && !/[\r\n]/.test(header.headers[name])) {
                if (name === 'location' && !header.headers[name].startsWith(`/desktop/${code}/`)) continue;
                p.proxyRes.setHeader(name, header.headers[name]);
              }
            }
            p.proxyRes.flushHeaders();
          }
        } else if (kind === 'chunk') {
          const p = pending.get(header.id);
          if (p && p.proxyRes && p.proxyRes.headersSent && !p.proxyRes.writableEnded) {
            p.proxyRes.write(payload, () => {
              // Credit back to host
              sendSSE(host, 'cmd', { kind: 'credit', id: header.id });
            });
          }
        } else if (kind === 'end') {
          const p = pending.get(header.id);
          if (p) {
            clearTimeout(p.timer);
            pending.delete(header.id);
            if (p.proxyRes && !p.proxyRes.writableEnded) p.proxyRes.end();
          }
        } else if (kind === 'error') {
          const p = pending.get(header.id);
          if (p) {
            clearTimeout(p.timer);
            pending.delete(header.id);
            if (p.proxyRes && !p.proxyRes.headersSent) { p.proxyRes.statusCode = 502; p.proxyRes.end(); }
            else if (p.resolve) p.resolve({ error: true });
          }
        } else if (kind === 'session-ended') {
          host.sessionActive = false;
          host.cookie = null;
        }

        res.json({ ok: true });
      } catch { res.status(400).end(); }
    });
  });

  // ===================== VIEWER CONNECT =====================
  app.post('/api/desktop/connect', sameOrigin, auth, async (req, res) => {
    const code = String(req.body?.code || '').trim().toUpperCase(), password = req.body?.password;
    const key = req.session.id + ':' + code, guard = attempts.get(key) || { count: 0, until: 0 };
    if (guard.until > Date.now()) return res.status(429).json({ error: 'Too many attempts; try later' });
    const device = validCode(code) && registry[code], host = hosts.get(code);
    let valid = false;
    if (device && typeof password === 'string' && password.length >= 12 && password.length <= 128) {
      const actual = await scryptAsync(password, Buffer.from(device.salt, 'hex'), 32, { N: 16384, r: 8, p: 1 });
      valid = safeEqual(actual.toString('hex'), device.passwordHash);
    }
    if (!valid || !host || host.res.writableEnded) {
      guard.count++; if (guard.count >= 5) { guard.count = 0; guard.until = Date.now() + 15 * 60_000; }
      attempts.set(key, guard); return res.status(401).json({ error: 'Host offline or device credentials invalid' });
    }
    if ([...leases].some(([id, l]) => id !== req.session.id && l.code === code && l.expires > Date.now())) {
      return res.status(409).json({ error: 'This device already has an active session' });
    }
    attempts.delete(key); releaseSession(req.session.id);
    leases.set(req.session.id, { code, expires: req.session.expires });

    const sessionId = crypto.randomUUID();
    try {
      await new Promise((resolve, reject) => {
        pending.set(sessionId, {
          resolve, reject, hostCode: code, sessionId: req.session.id,
          timer: setTimeout(() => { pending.delete(sessionId); reject(new Error('Timeout')); }, 25000)
        });
        sendSSE(host, 'cmd', { kind: 'begin-session', id: sessionId, password });
      });
      res.json({ url: `/desktop/${code}/`, code, engine: 'Sunshine / Moonlight Web' });
    } catch {
      releaseSession(req.session.id);
      res.status(502).json({ error: 'Host engine could not start. Check the host app log.' });
    }
  });

  app.post('/api/desktop/disconnect', sameOrigin, auth, (req, res) => {
    releaseSession(req.session.id); res.json({ ok: true });
  });

  app.get('/api/desktop/status', auth, (req, res) => {
    const lease = leases.get(req.session.id);
    const host = lease && hosts.get(lease.code);
    res.json({ connected: !!(host && !host.res.writableEnded && host.sessionActive), code: lease?.code || null });
  });

  // ===================== HTTP PROXY TO HOST =====================
  app.use('/desktop', async (req, res) => {
    const target = req.originalUrl, code = routeCode(target), selected = code && leaseFor(req, code);
    if (!selected) return res.status(401).send('Connect to this device from Remote Access first.');
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(req.method)) return res.sendStatus(405);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      try { if (new URL(req.headers.origin).host !== (req.headers['x-forwarded-host'] || req.headers.host)) return res.sendStatus(403); } catch { return res.sendStatus(403); }
    }

    const activePending = [...pending.values()].filter(p => p.hostCode === code).length;
    if (activePending >= 64) return res.status(429).send('Too many open requests');

    // Read request body
    const chunks = []; let size = 0;
    try { for await (const chunk of req) { size += chunk.length; if (size > 256 * 1024) return res.sendStatus(413); chunks.push(chunk); } } catch { return; }

    const id = crypto.randomUUID();
    const headersToForward = {};
    for (const name of ['content-type', 'accept', 'range', 'if-none-match']) {
      if (typeof req.headers[name] === 'string') headersToForward[name] = req.headers[name];
    }
    if (req.headers.cookie) {
      headersToForward.cookie = req.headers.cookie.split(';').filter(v => !/^\s*sp_/.test(v)).join(';');
    }

    // Send HTTP request to host via SSE
    const sent = sendSSE(selected.host, 'cmd', {
      kind: 'http', id,
      method: req.method,
      path: target,
      headers: headersToForward,
      body: Buffer.concat(chunks).toString('base64'),
    });

    if (!sent) return res.status(502).send('Host connection lost');

    // Register pending response
    pending.set(id, {
      proxyRes: res, hostCode: code, sessionId: selected.session.id,
      timer: setTimeout(() => {
        pending.delete(id);
        if (!res.headersSent) res.status(504).send('Host timed out');
        else if (!res.writableEnded) res.end();
      }, 60000),
    });

    res.on('close', () => {
      const p = pending.get(id);
      if (p) { clearTimeout(p.timer); pending.delete(id); }
    });
  });

  // ===================== CLEANUP =====================
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [id, lease] of leases) if (lease.expires <= now) releaseSession(id);
    for (const [id, token] of enrollments) if (token.expires <= now) enrollments.delete(id);
    for (const [id, guard] of attempts) if (guard.until && guard.until <= now) attempts.delete(id);
  }, 20000);
  cleanup.unref();

  return {
    release: releaseSession,
    upgrade() { return false; }, // No WebSocket upgrade
  };
}
