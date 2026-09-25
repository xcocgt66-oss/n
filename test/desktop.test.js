import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { WebSocket } from 'ws';
import { installDesktop } from '../desktop.js';

function inbox(ws) {
  const queued = [], waiters = [];
  ws.on('message', (raw, binary) => { const value = binary ? raw : JSON.parse(raw); const waiter = waiters.shift(); if (waiter) waiter(value); else queued.push(value); });
  return () => queued.length ? Promise.resolve(queued.shift()) : new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(Error('Message timeout')), 3000); waiters.push(value => { clearTimeout(timeout); resolve(value); }); });
}
function open(url, options) { return new Promise((resolve, reject) => { const ws = new WebSocket(url, options); ws.on('open', () => resolve(ws)); ws.on('error', reject); }); }

test('desktop enrollment, credentials, isolated relay, disconnect and persisted identity', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-test-'));
  const app = express(), server = http.createServer(app);
  const expires = Date.now() + 60000;
  const getSession = req => /sp_session=(one|two)/.exec(req.headers.cookie || '') && { id: /sp_session=(one|two)/.exec(req.headers.cookie)[1], expires };
  const auth = (req, res, next) => { req.session = getSession(req); if (!req.session) return res.sendStatus(401); next(); };
  const sameOrigin = (req, res, next) => req.headers.origin === `http://${req.headers.host}` ? next() : res.sendStatus(403);
  const desktop = installDesktop(app, { auth, sameOrigin, getSession, directory });
  server.on('upgrade', (req, socket, head) => { if (!desktop.upgrade(req, socket, head)) socket.destroy(); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`, wsOrigin = origin.replace('http', 'ws');
  const sockets = [];
  const request = (route, body, session = 'one') => fetch(origin + route, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', origin, cookie: `sp_session=${session}` }, body: body ? JSON.stringify(body) : undefined });
  try {
    assert.equal((await fetch(origin + '/api/desktop/enroll', { method: 'POST', headers: { origin } })).status, 401);
    const secret = crypto.randomBytes(32).toString('hex'), salt = crypto.randomBytes(16).toString('hex'), password = 'a-good-device-password';
    const code = crypto.createHash('sha256').update(Buffer.from(secret, 'hex')).digest('hex').slice(0,10).toUpperCase();
    const registration = { kind: 'register', code, secret, salt, passwordHash: crypto.scryptSync(password, Buffer.from(salt,'hex'),32).toString('hex') };
    const bad = await open(wsOrigin + '/host-link'); sockets.push(bad); const badNext = inbox(bad); bad.send(JSON.stringify(registration)); assert.equal((await badNext()).kind, 'error');
    const token = await (await request('/api/desktop/enroll', {})).json();
    const host = await open(wsOrigin + '/host-link'); sockets.push(host); const next = inbox(host);
    host.send(JSON.stringify({ ...registration, enrollment: token.token })); assert.equal((await next()).kind, 'registered');
    assert.equal((await request('/api/desktop/connect', { code, password: 'wrong-password' })).status, 401);
    assert.equal((await request(`/desktop/${code}/`)).status, 401);
    const connecting = request('/api/desktop/connect', { code, password });
    const begin = await next(); assert.equal(begin.kind, 'begin-session'); assert.equal(begin.password, password);
    host.send(JSON.stringify({kind:'session-ready',id:begin.id})); assert.equal((await connecting).status, 200);
    assert.equal((await request('/api/desktop/connect', { code, password }, 'two')).status, 409);
    assert.equal((await request(`/desktop/${code}/`, null, 'two')).status, 401);
    const get = request(`/desktop/${code}/index.html`);
    const httpRequest = await next(); assert.equal(httpRequest.kind, 'http'); assert.ok(!JSON.stringify(httpRequest.headers).includes('sp_session'));
    host.send(JSON.stringify({kind:'headers',id:httpRequest.id,status:200,headers:{'content-type':'text/plain'}}));
    host.send(Buffer.concat([Buffer.from([1]),Buffer.from(httpRequest.id.replaceAll('-',''),'hex'),Buffer.from('hello desktop')]));
    host.send(JSON.stringify({kind:'end',id:httpRequest.id}));
    const response = await get; assert.equal(await response.text(),'hello desktop'); assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'self'/);
    let msg = await next(); assert.equal(msg.kind,'credit');
    const viewer = await open(`${wsOrigin}/desktop/${code}/api/host/stream`, { headers: { origin, cookie: 'sp_session=one' } }); sockets.push(viewer);
    const channel = await next(); assert.equal(channel.kind,'ws');
    viewer.send('hello websocket'); const packet = await next(); assert.equal(packet[0],2); assert.equal(packet.subarray(17).toString(),'hello websocket');
    const fromHost = new Promise(resolve=>viewer.once('message',(raw,binary)=>resolve({raw,binary})));
    host.send(Buffer.concat([Buffer.from([2]),Buffer.from(channel.id.replaceAll('-',''),'hex'),Buffer.from('from host')]));
    const received = await fromHost; assert.equal(received.binary,false); assert.equal(received.raw.toString(),'from host');
    const closed = new Promise(resolve=>viewer.once('close',resolve));
    assert.equal((await request('/api/desktop/disconnect', {})).status,200);
    await closed;
    assert.equal((await next()).kind,'close'); assert.equal((await next()).kind,'end-session');
    assert.equal((await request(`/desktop/${code}/`)).status,401);
    assert.equal((await (await request('/api/desktop/status')).json()).connected,false);
    const stored = JSON.parse(fs.readFileSync(path.join(directory,'devices.json')));
    assert.ok(stored[code].secretHash); assert.ok(!JSON.stringify(stored).includes(password)); assert.ok(!JSON.stringify(stored).includes(secret));
  } finally {
    for (const ws of sockets) ws.terminate();
    server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));
    fs.rmSync(directory,{recursive:true,force:true});
  }
});
