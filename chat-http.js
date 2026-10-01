import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';

// Short HTTPS requests work with ordinary forward proxies. No streaming response,
// upgrade, third-party origin, or client-side provider connection is required.
export function installChatHttp(app, { wss, auth, sameOrigin }) {
  const clients = new Map();
  class Client extends EventEmitter {
    readyState = 1;
    bufferedAmount = 0;
    events = [];
    sequence = 0;
    receipts = new Map();
    send(raw) {
      const data = JSON.parse(raw);
      if (data.kind === 'error') this.error = data.text;
      if (this.events.length >= 512) return this.close();
      this.events.push({ sequence: ++this.sequence, data });
    }
    close() {
      if (this.readyState !== 1) return;
      this.readyState = 3;
      clients.delete(this.key);
      this.emit('close');
    }
  }
  const keyFor = req => req.session.id + ':' + req.body?.client;
  const validId = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
  app.post('/api/chat/open', sameOrigin, auth, (req, res) => {
    if (!validId(req.body?.client)) return res.status(400).json({ error: 'Invalid client' });
    const key = keyFor(req);
    let client = clients.get(key);
    if (!client) {
      if ([...clients.values()].filter(c => c.sessionId === req.session.id).length >= 8) return res.status(429).json({ error: 'Close an unused chat tab and retry' });
      client = new Client();
      Object.assign(client, { key, sessionId: req.session.id, token: crypto.randomUUID() });
      clients.set(key, client);
      wss.emit('connection', client, req, req.session);
    }
    client.touched = Date.now();
    res.json({ token: client.token });
  });
  function selected(req, res, next) {
    const client = clients.get(keyFor(req));
    if (!client || client.token !== req.body?.token) return res.status(410).json({ error: 'Reconnect chat' });
    client.touched = Date.now();
    req.chatClient = client;
    next();
  }
  app.post('/api/chat/poll', sameOrigin, auth, selected, (req, res) => {
    const client = req.chatClient, after = req.body.after;
    if (!Number.isSafeInteger(after) || after < 0 || after > client.sequence) return res.status(400).json({ error: 'Invalid cursor' });
    // Retain unacknowledged events so a dropped HTTP response loses no messages.
    client.events = client.events.filter(event => event.sequence > after);
    res.json({ events: client.events.slice(0, 100) });
  });
  app.post('/api/chat/send', sameOrigin, auth, selected, (req, res) => {
    const client = req.chatClient, { id, message } = req.body;
    if (!validId(id) || !message || !['message', 'name'].includes(message.kind)) return res.status(400).json({ error: 'Invalid message' });
    for (const [key, receipt] of client.receipts) if (receipt.at < Date.now() - 120000) client.receipts.delete(key);
    if (client.receipts.has(id)) return res.json(client.receipts.get(id).result);
    client.error = null;
    client.emit('message', JSON.stringify(message));
    const result = client.error ? { error: client.error } : { ok: true };
    client.receipts.set(id, { at: Date.now(), result });
    if (client.receipts.size > 256) client.receipts.delete(client.receipts.keys().next().value);
    res.json(result);
  });
  app.post('/api/chat/close', sameOrigin, auth, selected, (req, res) => {
    req.chatClient.close();
    res.json({ ok: true });
  });
  const timer = setInterval(() => {
    for (const client of clients.values()) if (client.touched < Date.now() - 90000) client.close();
  }, 10000);
  timer.unref();
  return { close() { clearInterval(timer); for (const client of clients.values()) client.close(); } };
}
