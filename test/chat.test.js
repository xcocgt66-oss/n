import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChatStore, attachChat, CHAT_TTL } from '../chat.js';
class Peer extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  received = [];
  send(raw) { this.received.push(JSON.parse(raw)); }
  close() { this.readyState = 3; this.emit('close'); }
  message(value) { this.emit('message', JSON.stringify(value)); }
}
test('private visibility, mentions, presence, reconnect, expiry and persistence', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-chat-'));
  try {
    const store = createChatStore(directory), wss = new EventEmitter(), alerts = [];
    const sessions = new Map(['a', 'b', 'c'].map(id => [id, { expires: Date.now() + 60000, chatId: id, name: id + id }]));
    const chat = attachChat(wss, { sessions, store, notify: (id, m) => alerts.push([id, m]) });
    const a = new Peer(), b = new Peer(), c = new Peer();
    for (const [id, peer] of [['a', a], ['b', b], ['c', c]]) wss.emit('connection', peer, {}, { id });
    assert.equal(c.received.at(-1).users.length, 3);
    a.message({ kind: 'message', text: 'Private secret', toId: 'b' });
    assert.ok(b.received.some(m => m.text === 'Private secret'));
    assert.ok(!c.received.some(m => m.text === 'Private secret'));
    assert.deepEqual(alerts.map(x => x[0]), ['b']);
    assert.equal(store.read('c').length, 0);
    b.close();
    const next = new Peer(); wss.emit('connection', next, {}, { id: 'b' });
    assert.equal(next.received.find(m => m.kind === 'history').items[0].text, 'Private secret');
    next.message({ kind: 'message', text: 'Hello @cc', sticker: 'wave' });
    assert.equal(c.received.at(-1).sticker, 'wave');
    assert.ok(alerts.some(([id]) => id === 'c'));
    c.message({ kind: 'name', name: 'aa' });
    assert.equal(c.received.at(-1).kind, 'error');
    store.add({ id: 'old', text: 'Expired', at: Date.now() - CHAT_TTL - 1 });
    store.purge();
    const reopened = createChatStore(directory);
    assert.equal(reopened.read('c').length, 1);
    assert.ok(!fs.readFileSync(path.join(directory, 'messages.json'), 'utf8').includes('Expired'));
    sessions.get('c').expires = 0;
    c.message({ kind: 'message', text: 'not allowed' });
    assert.equal(c.readyState, 3);
    chat.disconnect('a'); assert.equal(a.readyState, 3);
    next.close();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
