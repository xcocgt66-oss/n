// YouTube through the server's own IP.
// yt-dlp (downloaded automatically on first use) resolves search results and stream URLs,
// and every video/audio byte is piped through this server, so the viewer's network
// never talks to YouTube directly. HTTP only (Range requests), no WebSocket.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';

const ID = /^[A-Za-z0-9_-]{11}$/;
const CHUNK = 4 * 1024 * 1024;           // max bytes per proxied range response
const INFO_TTL = 3 * 60 * 60_000;         // stream URLs live ~6h on YouTube; refresh after 3h
const SEARCH_TTL = 15 * 60_000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

export function installYouTube(app, { auth, directory }) {
  const binDir = path.resolve(directory, 'bin');
  const binary = process.env.YTDLP_PATH || path.join(binDir, 'yt-dlp');
  const asset = process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
  let installing = null, installedAt = 0;

  // Optional cookies (Netscape cookies.txt, plain or base64) for when YouTube asks the server to "sign in"
  let cookieFile = null;
  if (process.env.YT_COOKIES) {
    let text = process.env.YT_COOKIES.trim();
    if (!text.includes('\t')) { try { text = Buffer.from(text, 'base64').toString('utf8'); } catch {} }
    fs.mkdirSync(binDir, { recursive: true });
    cookieFile = path.join(binDir, 'cookies.txt');
    fs.writeFileSync(cookieFile, text.endsWith('\n') ? text : text + '\n', { mode: 0o600 });
  }

  async function download() {
    fs.mkdirSync(binDir, { recursive: true });
    const r = await fetch(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`, { redirect: 'follow' });
    if (!r.ok) throw new Error(`yt-dlp download failed (${r.status})`);
    const temp = binary + '.part';
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(temp, { mode: 0o755 });
      Readable.fromWeb(r.body).pipe(out).on('finish', resolve).on('error', reject);
    });
    fs.chmodSync(temp, 0o755);
    fs.renameSync(temp, binary);
    installedAt = Date.now();
    console.log('yt-dlp ready');
  }

  function ensure() {
    if (process.env.YTDLP_PATH) return Promise.resolve();
    const stale = installedAt && Date.now() - installedAt > 24 * 60 * 60_000;
    if (fs.existsSync(binary) && !stale) { installedAt ||= Date.now(); return Promise.resolve(); }
    if (!installing) installing = download().catch(e => { if (!fs.existsSync(binary)) throw e; }).finally(() => { installing = null; });
    return installing;
  }
  ensure().catch(e => console.error('yt-dlp:', e.message)); // warm up at boot

  // Small concurrency gate so Railway's free tier is not overloaded
  let running = 0; const waiting = [];
  async function gate(fn) {
    if (running >= 2) await new Promise(r => waiting.push(r));
    running++;
    try { return await fn(); } finally { running--; waiting.shift()?.(); }
  }

  function ytdlp(args, timeout = 60_000) {
    return gate(async () => {
      await ensure();
      const base = ['--no-warnings', '--ignore-config', '--no-cache-dir', '--js-runtimes', 'node', '--user-agent', UA];
      if (cookieFile) base.push('--cookies', cookieFile);
      return await new Promise((resolve, reject) => {
        const child = spawn(binary, [...base, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
        const out = [], err = []; let size = 0;
        const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
        child.stdout.on('data', d => { size += d.length; if (size > 40 * 1024 * 1024) child.kill('SIGKILL'); else out.push(d); });
        child.stderr.on('data', d => { if (err.length < 50) err.push(d); });
        child.on('error', e => { clearTimeout(timer); reject(e); });
        child.on('close', code => {
          clearTimeout(timer);
          const stdout = Buffer.concat(out).toString('utf8');
          if (code === 0 && stdout) return resolve(stdout);
          const message = Buffer.concat(err).toString('utf8').split('\n').filter(l => l.includes('ERROR')).pop() || `yt-dlp exited with ${code}`;
          reject(new Error(message.replace(/^ERROR:\s*/, '').slice(0, 300)));
        });
      });
    });
  }

  // ---------------- search ----------------
  const searches = new Map();
  function mapEntry(e) {
    return {
      id: e.id,
      title: e.title || '',
      duration: Math.round(e.duration || 0),
      uploaderName: e.channel || e.uploader || '',
      views: e.view_count || 0,
      live: e.live_status === 'is_live',
      thumbnail: `/api/yt/thumb/${e.id}`,
    };
  }
  async function search(query, count = 24) {
    const key = count + ':' + query.toLowerCase();
    const hit = searches.get(key);
    if (hit && hit.expires > Date.now()) return hit.items;
    const raw = await ytdlp(['--flat-playlist', '-J', `ytsearch${count}:${query}`], 45_000);
    const data = JSON.parse(raw);
    const items = (data.entries || []).filter(e => e && ID.test(e.id || '')).map(mapEntry);
    searches.set(key, { items, expires: Date.now() + SEARCH_TTL });
    if (searches.size > 200) searches.delete(searches.keys().next().value);
    return items;
  }

  app.get('/api/yt/search', auth, async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 200);
    if (!q) return res.status(400).json({ error: 'Search query required' });
    try { res.json({ items: await search(q) }); }
    catch (e) { res.status(502).json({ error: 'YouTube search failed: ' + e.message }); }
  });

  app.get('/api/yt/home', auth, async (req, res) => {
    const q = String(req.query.q || process.env.YT_HOME_QUERY || 'trending').slice(0, 100);
    try { res.json({ items: await search(q) }); }
    catch (e) { res.status(502).json({ error: 'YouTube unavailable: ' + e.message }); }
  });

  // ---------------- stream resolving ----------------
  const tokens = new Map();   // token -> { url, headers, expires, id }
  const infos = new Map();    // videoId -> { data, expires }
  const pendingInfo = new Map();

  function register(format, id) {
    const token = crypto.randomBytes(18).toString('base64url');
    tokens.set(token, { url: format.url, headers: format.http_headers || {}, expires: Date.now() + INFO_TTL + 30 * 60_000, id });
    return `/api/yt/media/${token}`;
  }

  function codecRank(f) { return /^avc1/.test(f.vcodec) ? 0 : /^vp0?9/.test(f.vcodec) ? 1 : /^av01/.test(f.vcodec) ? 2 : 3; }

  async function resolve(id) {
    const raw = await ytdlp(['-J', '--no-playlist', '--', `https://www.youtube.com/watch?v=${id}`], 90_000);
    const v = JSON.parse(raw);
    if (v.is_live) throw new Error('Live streams are not supported yet');
    const formats = (v.formats || []).filter(f => f.url && (f.protocol === 'https' || f.protocol === 'http'));
    const muxed = formats.filter(f => f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none' && f.ext === 'mp4').sort((a, b) => (b.height || 0) - (a.height || 0));
    const videoOnly = formats.filter(f => f.vcodec && f.vcodec !== 'none' && (!f.acodec || f.acodec === 'none') && f.height && f.height <= 1080);
    const audioOnly = formats.filter(f => (!f.vcodec || f.vcodec === 'none') && f.acodec && f.acodec !== 'none')
      .sort((a, b) => (a.ext === 'm4a' ? 0 : 1) - (b.ext === 'm4a' ? 0 : 1) || (b.abr || 0) - (a.abr || 0));

    const qualities = [];
    if (muxed[0]) qualities.push({ label: `${muxed[0].height || 360}p`, height: muxed[0].height || 360, mode: 'muxed', src: register(muxed[0], id) });
    const audio = audioOnly[0];
    if (audio) {
      const audioSrc = register(audio, id);
      const byHeight = new Map();
      for (const f of videoOnly) {
        const best = byHeight.get(f.height);
        if (!best || codecRank(f) < codecRank(best) || (codecRank(f) === codecRank(best) && (f.tbr || 0) > (best.tbr || 0))) byHeight.set(f.height, f);
      }
      for (const [height, f] of [...byHeight].sort((a, b) => b[0] - a[0])) {
        if (qualities.some(q => q.mode === 'muxed' && q.height === height)) continue;
        qualities.push({ label: `${height}p`, height, mode: 'split', video: register(f, id), audio: audioSrc });
      }
      qualities.push({ label: 'Audio only', height: 0, mode: 'audio', audio: audioSrc });
    }
    if (!qualities.length) throw new Error('No playable formats were returned');
    qualities.sort((a, b) => b.height - a.height);
    return {
      id, title: v.title || '', uploaderName: v.channel || v.uploader || '', duration: Math.round(v.duration || 0),
      views: v.view_count || 0, description: (v.description || '').slice(0, 3000), qualities,
    };
  }

  async function info(id, fresh) {
    const cached = infos.get(id);
    if (cached && cached.expires > Date.now() && !fresh) return cached.data;
    if (pendingInfo.has(id)) return pendingInfo.get(id);
    const job = resolve(id).then(data => { infos.set(id, { data, expires: Date.now() + INFO_TTL }); return data; }).finally(() => pendingInfo.delete(id));
    pendingInfo.set(id, job);
    return job;
  }

  app.get('/api/yt/video/:id', auth, async (req, res) => {
    const id = req.params.id;
    if (!ID.test(id)) return res.status(400).json({ error: 'Invalid video id' });
    try { res.json(await info(id, req.query.fresh === '1')); }
    catch (e) { res.status(502).json({ error: e.message }); }
  });

  // ---------------- media proxy (Range) ----------------
  app.get('/api/yt/media/:token', auth, async (req, res) => {
    const entry = tokens.get(req.params.token);
    if (!entry || entry.expires < Date.now()) return res.status(410).json({ error: 'Stream expired' });

    let start = 0, end = null;
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (range) { start = Number(range[1]); end = range[2] ? Number(range[2]) : null; }
    if (end === null || end - start + 1 > CHUNK) end = start + CHUNK - 1;

    const controller = new AbortController();
    res.on('close', () => controller.abort());
    try {
      const upstream = await fetch(entry.url, {
        signal: controller.signal,
        headers: { ...entry.headers, 'User-Agent': entry.headers['User-Agent'] || UA, Range: `bytes=${start}-${end}` },
      });
      if (upstream.status === 403 || upstream.status === 404 || upstream.status === 410) {
        infos.delete(entry.id); tokens.delete(req.params.token);
        return res.status(410).json({ error: 'Stream expired' });
      }
      if (upstream.status === 416) return res.status(416).set('Content-Range', upstream.headers.get('content-range') || '').end();
      if (!upstream.ok) return res.status(502).json({ error: `Upstream ${upstream.status}` });

      res.status(upstream.status === 206 ? 206 : 200);
      for (const name of ['content-type', 'content-length', 'content-range']) {
        const value = upstream.headers.get(name);
        if (value) res.setHeader(name, value);
      }
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'private, max-age=3600');
      Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
    } catch (e) {
      if (!res.headersSent) res.status(502).json({ error: 'Stream failed' });
      else res.destroy();
    }
  });

  // Thumbnails through the server as well
  app.get('/api/yt/thumb/:id', auth, async (req, res) => {
    const id = req.params.id;
    if (!ID.test(id)) return res.sendStatus(400);
    try {
      const r = await fetch(`https://i.ytimg.com/vi/${id}/mqdefault.jpg`, { headers: { 'User-Agent': UA } });
      if (!r.ok) return res.sendStatus(404);
      res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.send(Buffer.from(await r.arrayBuffer()));
    } catch { res.sendStatus(502); }
  });

  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of tokens) if (v.expires < now) tokens.delete(k);
    for (const [k, v] of infos) if (v.expires < now) infos.delete(k);
    for (const [k, v] of searches) if (v.expires < now) searches.delete(k);
  }, 10 * 60_000).unref();
}
