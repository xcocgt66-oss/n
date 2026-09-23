import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { WebSocket, WebSocketServer } from 'ws';
import { once } from 'node:events';

test('stream requires login and lease, proxies WebSockets, strips portal credentials', { timeout: 15000 }, async () => {
  let upstreamCookie;
  const upstream = http.createServer((req, res) => { upstreamCookie = req.headers.cookie; res.end('stream-ready'); });
  const upstreamWs = new WebSocketServer({ server: upstream });
  upstreamWs.on('connection', ws => ws.on('message', data => ws.send(data)));
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const probe = http.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening'); const port = probe.address().port; await new Promise(r => probe.close(r));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, SPOWER_PASSWORD: 'test-password', PORT: String(port), BROWSER_STREAM_UPSTREAM: `http://127.0.0.1:${upstream.address().port}` }, stdio: 'pipe' });
  let client;
  try {
    for (let i = 0; i < 60; i++) { try { if ((await fetch(origin + '/health')).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
    assert.equal((await fetch(origin + '/stream/')).status, 401);
    const headers = { Origin: origin, 'Content-Type': 'application/json' };
    const login = await fetch(origin + '/api/login', { method: 'POST', headers, body: JSON.stringify({ password: 'test-password' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0]; headers.Cookie = cookie;
    assert.equal((await fetch(origin + '/stream/', { headers })).status, 401);
    assert.equal((await fetch(origin + '/api/browser/start', { method: 'POST', headers, body: '{}' })).status, 200);
    assert.equal(await (await fetch(origin + '/stream/', { headers })).text(), 'stream-ready');
    assert.equal(upstreamCookie, undefined);
    client = new WebSocket(`ws://127.0.0.1:${port}/stream/socket`, { headers }); await once(client, 'open');
    const result = once(client, 'message'); client.send('media-frame'); assert.equal((await result)[0].toString(), 'media-frame');
    await fetch(origin + '/api/browser/stop', { method: 'POST', headers, body: '{}' });
    assert.equal((await fetch(origin + '/stream/', { headers })).status, 401);
  } finally { client?.terminate(); child.kill(); for (const ws of upstreamWs.clients) ws.terminate(); upstreamWs.close(); upstream.closeAllConnections(); await new Promise(r => upstream.close(r)); }
});
