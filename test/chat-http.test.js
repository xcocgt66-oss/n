import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('HTTPS-only chat: presence, private isolation, replay, duplicate receipt, expiry, logout and retired browser', { timeout: 20000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-https-'));
  const probe = http.createServer();
  await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise(r => probe.close(r));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: String(port), SPOWER_PASSWORD: 'test-password', DATA_DIR: directory, GEMINI_API_KEY: '', OPENAI_API_KEY: '', OPENROUTER_API_KEY: '', NVIDIA_API_KEY: '' }, stdio: 'pipe' });
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(origin + '/health')).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
    async function request(route, body, cookie = '', site = origin) {
      return fetch(origin + route, { method: body ? 'POST' : 'GET', headers: { origin: site, cookie, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    }
    async function login() {
      const response = await request('/api/login', { password: 'test-password' });
      assert.equal(response.status, 200);
      const peer = { cookie: response.headers.get('set-cookie').split(';')[0], client: crypto.randomUUID() };
      peer.call = async (route, extra = {}) => {
        const response = await request('/api/chat/' + route, { client: peer.client, token: peer.token, ...extra }, peer.cookie);
        return { status: response.status, ...await response.json() };
      };
      peer.token = (await peer.call('open')).token;
      return peer;
    }
    assert.equal((await request('/api/chat/open', { client: crypto.randomUUID() })).status, 401);
    const a = await login(), b = await login(), c = await login();
    assert.equal((await request('/api/chat/open', { client: a.client }, a.cookie, 'https://other.example')).status, 403);
    const first = await a.call('poll', { after: 0 });
    assert.equal(first.events.find(e => e.data.kind === 'presence' && e.data.users.length === 3).data.users.length, 3);
    assert.deepEqual((await a.call('poll', { after: 0 })).events, first.events, 'Unacknowledged events replay');
    const bIdentity = (await b.call('poll', { after: 0 })).events.find(e => e.data.kind === 'identity').data.id;
    const message = { id: crypto.randomUUID(), message: { kind: 'message', text: 'Private HTTPS hello', toId: bIdentity } };
    assert.equal((await a.call('send', message)).ok, true);
    assert.equal((await a.call('send', message)).ok, true);
    const privateEvents = (await b.call('poll', { after: 0 })).events.filter(e => e.data.kind === 'message');
    assert.equal(privateEvents.length, 1, 'Retry must not duplicate');
    assert.equal(privateEvents[0].data.text, 'Private HTTPS hello');
    assert.equal((await c.call('poll', { after: 0 })).events.filter(e => e.data.kind === 'message').length, 0);
    assert.match((await a.call('send', { id: crypto.randomUUID(), message: { kind: 'message', text: 'Too soon' } })).error, /wait/);
    assert.equal((await c.call('poll', { token: b.token, after: 0 })).status, 410);
    assert.equal((await b.call('poll', { after: privateEvents[0].sequence })).events.length, 0);
    assert.equal((await b.call('close')).ok, true);
    assert.equal((await b.call('poll', { after: 0 })).status, 410);
    const oldToken = b.token;
    b.token = (await b.call('open')).token;
    assert.notEqual(b.token, oldToken);
    assert.equal((await b.call('poll', { after: 0 })).events.find(e => e.data.kind === 'history').data.items.length, 1);
    await request('/api/logout', {}, a.cookie);
    assert.equal((await a.call('poll', { after: 0 })).status, 401);
    for (const route of ['/api/browser', '/api/browser/start', '/api/browser/stop']) assert.equal((await request(route, {}, c.cookie)).status, 404);
    assert.equal((await request('/stream/', null, c.cookie)).status, 404);
    const me = await (await request('/api/me', null, c.cookie)).json();
    assert.ok(!('browserStream' in me));
  } finally {
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill(); await exited;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
