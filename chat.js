import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const CHAT_TTL = 24 * 60 * 60 * 1000;
export const STICKERS = new Set(['wave', 'party', 'heart', 'thinking']);
export function visibleMessages(items, identity, now = Date.now()) {
  return items.filter(item => now - item.at < CHAT_TTL && (!item.toId || item.toId === identity || item.fromId === identity));
}
export function createChatStore(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'messages.json');
  let items = [];
  try { const parsed = JSON.parse(fs.readFileSync(file, 'utf8')); if (Array.isArray(parsed)) items = parsed.filter(m => m && typeof m.at === 'number'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  function prune() { const now = Date.now(); items = items.filter(m => now - m.at < CHAT_TTL); }
  function save() { const temp = file + '.tmp'; fs.writeFileSync(temp, JSON.stringify(items), { mode: 0o600 }); fs.renameSync(temp, file); }
  prune(); save();
  return {
    read(id) { prune(); return visibleMessages(items, id); },
    add(item) { prune(); if (items.length >= 20000) throw new Error('Chat storage is full; try later'); items.push(item); try { save(); } catch (error) { items.pop(); throw error; } },
    purge() { prune(); save(); }
  };
}

export function attachChat(wss, { sessions, store, notify }) {
  const peers = new Map();
  const send = (ws, data) => { if (ws.readyState === 1 && ws.bufferedAmount < 2_000_000) ws.send(JSON.stringify(data)); };
  const valid = peer => sessions.get(peer.sessionId)?.expires > Date.now();
  function presence() {
    const users = new Map();
    for (const peer of peers.values()) if (valid(peer)) users.set(peer.chatId, { id: peer.chatId, name: sessions.get(peer.sessionId).name });
    for (const peer of peers.values()) send(peer.ws, { kind: 'presence', users: [...users.values()] });
  }
  wss.on('connection', (ws, req, session) => {
    const identity = sessions.get(session.id);
    if (!identity) return ws.close();
    identity.chatId ||= crypto.randomUUID();
    identity.name ||= `Guest-${identity.chatId.slice(0, 5)}`;
    const peer = { ws, sessionId: session.id, chatId: identity.chatId, last: 0 };
    peers.set(ws, peer);
    send(ws, { kind: 'identity', id: identity.chatId, name: identity.name });
    send(ws, { kind: 'history', items: store.read(identity.chatId), cutoff: Date.now() - CHAT_TTL });
    presence();
    ws.on('message', raw => {
      if (!valid(peer)) return ws.close(4001, 'Session expired');
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.kind === 'name') {
        const name = typeof msg.name === 'string' ? msg.name.trim() : '';
        if (!/^[\p{L}\p{N}_-]{2,24}$/u.test(name) || [...sessions.values()].some(s => s !== identity && s.expires > Date.now() && s.name?.toLowerCase() === name.toLowerCase())) return send(ws, { kind: 'error', text: 'Choose a unique name: 2–24 letters, numbers, _ or -' });
        identity.name = name;
        for (const p of peers.values()) if (p.chatId === identity.chatId) send(p.ws, { kind: 'identity', id: identity.chatId, name });
        presence(); return;
      }
      if (msg.kind !== 'message') return;
      const now = Date.now();
      if (now - peer.last < 500) return send(ws, { kind: 'error', text: 'Please wait before sending again' });
      peer.last = now;
      const text = typeof msg.text === 'string' ? msg.text.trim().slice(0, 2000) : '';
      const sticker = STICKERS.has(msg.sticker) ? msg.sticker : '';
      if (!text && !sticker) return;
      const toId = typeof msg.toId === 'string' ? msg.toId : '';
      const receiver = toId && [...peers.values()].find(p => p.chatId === toId && valid(p));
      if (toId && (!receiver || toId === identity.chatId)) return send(ws, { kind: 'error', text: 'Recipient is unavailable' });
      const recipient = receiver && sessions.get(receiver.sessionId);
      const mentions = [...new Set([...peers.values()].filter(p => valid(p) && text.split(/\s+/).some(word => word.replace(/[.,!?،؟]+$/u, '').toLowerCase() === '@' + sessions.get(p.sessionId).name.toLowerCase())).map(p => p.chatId))];
      const item = { kind: 'message', id: crypto.randomUUID(), fromId: identity.chatId, from: identity.name, toId, to: recipient?.name || '', text, sticker, mentions, at: now };
      try { store.add(item); } catch { return send(ws, { kind: 'error', text: 'Unable to save message; please try again' }); }
      const alerted = new Set();
      for (const p of peers.values()) {
        if (!valid(p) || toId && p.chatId !== toId && p.chatId !== identity.chatId) continue;
        send(p.ws, item);
        if (p.chatId !== identity.chatId && (toId === p.chatId || mentions.includes(p.chatId)) && !alerted.has(p.sessionId)) {
          alerted.add(p.sessionId); notify(p.sessionId, item);
        }
      }
    });
    ws.on('close', () => { peers.delete(ws); presence(); });
  });
  const interval = setInterval(() => {
    try { store.purge(); } catch (error) { console.error('Chat retention write failed:', error.code || 'storage error'); }
    for (const peer of peers.values()) {
      if (!valid(peer)) peer.ws.close(4001, 'Session expired');
      else send(peer.ws, { kind: 'prune', cutoff: Date.now() - CHAT_TTL });
    }
  }, 10000);
  interval.unref();
  return { disconnect(sessionId) { for (const peer of peers.values()) if (peer.sessionId === sessionId) peer.ws.close(4001, 'Signed out'); } };
}
