const body = document.body;
let keys = 0, taps = [], ws, username = localStorage.getItem('sp_name') || '', myConfig;
const glyphs = { browser: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a18 18 0 0 1 0 18 18 18 0 0 1 0-18"/>', youtube: '<polygon points="10 8 16 12 10 16"/><rect x="2" y="4" width="20" height="16" rx="4"/>', remote: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>', chat: '<path d="M21 11a8 8 0 0 1-8 8H6l-4 3V11a9 9 0 0 1 19 0Z"/><path d="M7 11h10M7 7h6"/>', settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2"/>', exit: '<path d="M9 4H4v16h5m5-13 5 5-5 5m-5-5h10"/>', full: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>', arrow: '<path d="M12 20V4m-6 6 6-6 6 6"/>', plus: '<path d="M12 4v16M4 12h16"/>', copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M15 4H4v11"/>', search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/>', play: '<polygon points="10 8 16 12 10 16"/>', back: '<path d="M19 12H5m7-7-7 7 7 7"/>', forward: '<path d="M5 12h14m-7-7 7 7-7 7"/>', reload: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>', home: '<path d="m3 11 9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1Z"/>' };
function icon(name) { const span = document.createElement('span'); span.className = 'icon'; span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${glyphs[name] || glyphs.browser}</svg>`; return span; }
function el(tag, attrs = {}, children = []) { const n = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'text') n.textContent = v; else if (k === 'class') n.className = v; else n.setAttribute(k, v); } for (const c of children) n.append(c); return n; }
function message(container, value) { container.textContent = value; }
function button(label, action, symbol, cls = '') { const b = el('button', { type: 'button', class: cls, 'aria-label': label }, [...symbol ? [icon(symbol)] : [], el('span', { text: label })]); if (action) b.onclick = action; return b; }
async function api(path, data) { const r = await fetch(path, { method: data ? 'POST' : 'GET', credentials: 'same-origin', headers: data ? { 'Content-Type': 'application/json' } : {}, body: data ? JSON.stringify(data) : undefined }); const result = await r.json().catch(() => ({ error: 'Connection unavailable' })); if (r.status === 401 && path !== '/api/login') result.error ||= 'Please sign in again'; return result; }
function unlock() {
  if (document.querySelector('dialog') || document.querySelector('main')) return;
  const dialog = el('dialog'), form = el('form'), input = el('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password', required: '' }), error = el('p', { class: 'error', role: 'alert' });
  form.append(el('div', { class: 'brand-mark', text: 'S' }), el('h2', { text: 'Welcome back' }), input, el('button', { text: 'Continue', class: 'primary' }), error);
  dialog.append(form); body.append(dialog); dialog.showModal(); input.focus(); dialog.addEventListener('close', () => dialog.remove());
  form.onsubmit = async e => { e.preventDefault(); const submit = form.querySelector('button'); submit.disabled = true; try { const r = await api('/api/login', { password: input.value }); if (r.ok) { dialog.close(); await dashboard(); } else message(error, r.error); } catch { message(error, 'Connection failed'); } finally { submit.disabled = false; } };
}
document.addEventListener('keydown', e => { if (document.querySelector('dialog') || document.querySelector('main') || e.repeat || e.ctrlKey || e.altKey || e.metaKey) return; keys = e.key.toUpperCase() === String.fromCharCode(89) ? keys + 1 : 0; if (keys === 5) { keys = 0; unlock(); } });
document.addEventListener('pointerdown', e => { if (document.querySelector('dialog') || document.querySelector('main') || e.pointerType === 'mouse') return; if (e.clientX < innerWidth - 90 || e.clientY < innerHeight - 90) { taps = []; return; } const now = Date.now(); taps = taps.filter(t => now - t < 1100); taps.push(now); if (taps.length === 3) { taps = []; unlock(); } });
async function dashboard() {
  myConfig = await api('/api/me'); if (!myConfig.ok) return;
  body.replaceChildren(); body.classList.add('unlocked'); applyPrefs();
  const main = el('main', { class: 'app' }), sidebar = el('aside', { class: 'sidebar' }), nav = el('nav'), content = el('div', { class: 'workspace' }), top = el('header', { class: 'topbar' }), title = el('span', { class: 'crumb', text: 'Workspace / Browser' });
  sidebar.append(el('div', { class: 'brand' }, [el('div', { class: 'brand-mark', text: 'S' }), el('strong', { text: 'S—POWER' })]), el('p', { class: 'nav-label', text: 'WORKSPACE' }), nav);
  top.append(title, el('div', { class: 'top-actions' }, [el('span', { class: 'private-badge', text: 'Private workspace' }), el('span', { class: 'avatar', text: (username || 'S').slice(0, 1).toUpperCase() })]));
  content.append(top); main.append(sidebar, content); body.append(main);
  const items = [['Browser', 'browser', browserPanel], ['YouTube', 'youtube', youtubePanel], ['Remote Access', 'remote', rdpPanel], ['Messages', 'chat', chatPanel], ['Settings', 'settings', settingsPanel]];
  const sections = [];
  for (const [label, symbol, build] of items) {
    const section = el('section', { class: `panel ${symbol}-panel hidden` }); sections.push(section); content.append(section); let built = false;
    const tab = button(label, () => { for (const s of sections) s.classList.add('hidden'); nav.querySelectorAll('button').forEach(b => b.classList.remove('active')); tab.classList.add('active'); section.classList.remove('hidden'); title.textContent = `Workspace / ${label}`; if (!built) { build(section); built = true; } }, symbol, 'nav-button'); nav.append(tab);
  }
  sidebar.append(el('div', { class: 'sidebar-bottom' }, [el('div', { class: 'account' }, [el('span', { class: 'avatar', text: (username || 'S').slice(0, 1).toUpperCase() }), el('div', {}, [el('strong', { text: username || 'Personal account' }), el('small', { text: 'S-Power workspace' })])]), button('Lock workspace', async () => { await api('/api/logout', {}); ws?.close(4001); location.reload(); }, 'exit', 'nav-button')]));
  startChat(); nav.firstElementChild.click();
}
function heading(s, eyebrow, title, trailing) { const row = el('div', { class: 'page-heading' }, [el('div', {}, [el('span', { class: 'eyebrow', text: eyebrow }), el('h1', { text: title })])]); if (trailing) row.append(trailing); s.append(row); }
const prefs = Object.assign({theme:'dark',sound:true,volume:.35,enterSend:true,motion:true,fontSize:'normal',notifications:false}, JSON.parse(localStorage.getItem('sp_preferences') || '{}'));
function savePrefs(){localStorage.setItem('sp_preferences',JSON.stringify(prefs));applyPrefs()}
function applyPrefs(){body.dataset.theme=prefs.theme==='system'?(matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'):prefs.theme;body.classList.toggle('reduce-motion',!prefs.motion);body.classList.toggle('large-text',prefs.fontSize==='large')}
matchMedia('(prefers-color-scheme: light)').addEventListener('change',applyPrefs);
function toast(text,type='error'){let stack=document.querySelector('.toast-stack');if(!stack){stack=el('div',{class:'toast-stack','aria-live':'polite'});body.append(stack)}const item=el('div',{class:`toast ${type}`,role:type==='error'?'alert':'status'},[el('span',{text}),button('×',()=>item.remove())]);stack.append(item);while(stack.children.length>4)stack.firstElementChild.remove();setTimeout(()=>{item.classList.add('leaving');setTimeout(()=>item.remove(),400)},10000)}
let soundContext;
document.addEventListener('pointerdown',()=>{if(!body.classList.contains('unlocked'))return;try{soundContext ||= new AudioContext();soundContext.resume()}catch{}},{passive:true});
function beep(){if(!prefs.sound||!soundContext)return;const a=soundContext;[660,880].forEach((f,i)=>{const o=a.createOscillator(),g=a.createGain(),t=a.currentTime+i*.13;o.type='sine';o.frequency.value=f;g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(prefs.volume*.12,t+.015);g.gain.exponentialRampToValueAtTime(.001,t+.22);o.connect(g).connect(a.destination);o.start(t);o.stop(t+.23)})}

// ======================================================
// BROWSER PANEL — live browsing through the server's IP
// ======================================================
let proxyReady = null;
function setupProxy() {
  return proxyReady ||= (async () => {
    if (!('serviceWorker' in navigator)) throw Error('This browser does not support service workers');
    await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;
    const { BareMuxConnection } = await import('/baremux/index.mjs');
    const connection = new BareMuxConnection('/baremux/worker.js');
    if (!myConfig?.proxyToken) throw Error('Sign in again to use the browser');
    await connection.setTransport('/baremod/index.mjs', [location.origin + '/bare/' + myConfig.proxyToken + '/']);
  })().catch(e => { proxyReady = null; throw e; });
}
const uvPrefix = '/uv/service/';
function uvEncode(str) { let t = ''; for (let i = 0; i < str.length; i++) t += i % 2 ? String.fromCharCode(str.charCodeAt(i) ^ 2) : str[i]; return encodeURIComponent(t); }
function uvDecode(str) { const [input, ...search] = str.split('?'); let t = ''; const d = decodeURIComponent(input); for (let i = 0; i < d.length; i++) t += i % 2 ? String.fromCharCode(d.charCodeAt(i) ^ 2) : d[i]; return t + (search.length ? '?' + search.join('?') : ''); }
const searchEngines = { google: 'https://www.google.com/search?q=', duckduckgo: 'https://duckduckgo.com/?q=', bing: 'https://www.bing.com/search?q=' };
function toUrl(input, engine) {
  const q = input.trim();
  if (/^https?:\/\//i.test(q)) return q;
  if (/^[^\s/]+\.[a-z]{2,}(?:[/:?#].*)?$/i.test(q)) return 'https://' + q;
  return (searchEngines[engine] || searchEngines.google) + encodeURIComponent(q);
}
function browserPanel(s) {
  heading(s, 'LIVE WEB · VIA SERVER', 'Browser');
  const urlBar = el('input', { type: 'text', inputmode: 'url', placeholder: 'Search Google or type a URL', 'aria-label': 'URL or search', class: 'browser-url', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  const engine = el('select', { 'aria-label': 'Search engine', class: 'engine-select' });
  for (const [v, t] of [['google', 'Google'], ['duckduckgo', 'DuckDuckGo'], ['bing', 'Bing']]) engine.append(el('option', { value: v, text: t }));
  try { engine.value = localStorage.getItem('sp_engine') || 'google'; } catch {}
  engine.onchange = () => { try { localStorage.setItem('sp_engine', engine.value); } catch {} };
  const form = el('form', { class: 'browser-bar' }, [urlBar, el('div', { class: 'browser-bar-actions' }, [engine, button('Go', null, 'arrow', 'primary')])]);
  form.lastChild.lastChild.type = 'submit';
  const frame = el('iframe', { class: 'browser-frame', title: 'Web browser', allow: 'autoplay; fullscreen; clipboard-read; clipboard-write; encrypted-media; picture-in-picture', referrerpolicy: 'no-referrer' });
  const status = el('span', { class: 'browser-tab', text: 'New tab' });
  const loading = el('div', { class: 'browser-progress hidden' });
  const nav = (fn) => () => { try { fn(frame.contentWindow); } catch {} };
  const toolbar = el('div', { class: 'browser-toolbar' }, [
    el('div', { class: 'toolbar-actions' }, [
      button('Back', nav(w => w.history.back()), 'back', 'icon-button'),
      button('Forward', nav(w => w.history.forward()), 'forward', 'icon-button'),
      button('Reload', nav(w => w.location.reload()), 'reload', 'icon-button'),
      button('Home', () => open('https://www.google.com/'), 'home', 'icon-button'),
    ]),
    status,
    button('Full screen', () => stage.requestFullscreen?.().catch(() => toast('Full screen unavailable')), 'full', 'icon-button'),
  ]);
  const quick = el('div', { class: 'quick-links' });
  for (const [label, url] of [['Google', 'https://www.google.com/'], ['YouTube', 'https://www.youtube.com/'], ['Wikipedia', 'https://www.wikipedia.org/'], ['Reddit', 'https://old.reddit.com/'], ['X', 'https://x.com/'], ['GitHub', 'https://github.com/']]) quick.append(button(label, () => open(url), null, 'quick-link'));
  const welcome = el('div', { class: 'browser-empty' }, [icon('browser'), el('h2', { text: 'Browse through the server' }), el('p', { class: 'muted', text: 'Pages load on the server’s IP and stream to you over HTTPS. Scripts, logins and videos work like a normal browser.' }), quick]);
  const stage = el('div', { class: 'browser-stage' }, [toolbar, loading, welcome]);
  s.append(form, stage);

  function current() {
    try { const p = frame.contentWindow.location.pathname + frame.contentWindow.location.search; if (p.startsWith(uvPrefix)) return uvDecode(p.slice(uvPrefix.length)); } catch {}
    return '';
  }
  frame.addEventListener('load', () => {
    loading.classList.add('hidden');
    const url = current();
    if (url) { if (document.activeElement !== urlBar) urlBar.value = url; try { status.textContent = frame.contentDocument.title || new URL(url).hostname; } catch { status.textContent = url; } }
  });
  async function open(url) {
    loading.classList.remove('hidden'); status.textContent = 'Starting engine…';
    try { await setupProxy(); } catch (e) { loading.classList.add('hidden'); status.textContent = 'Engine failed'; return toast('Browser engine failed: ' + e.message); }
    if (!frame.isConnected) { welcome.remove(); stage.append(frame); }
    urlBar.value = url; status.textContent = 'Loading…';
    frame.src = uvPrefix + uvEncode(url);
  }
  form.onsubmit = e => { e.preventDefault(); if (urlBar.value.trim()) { open(toUrl(urlBar.value, engine.value)); urlBar.blur(); } };
  setupProxy().catch(() => {});
}

// ======================================================
// YOUTUBE PANEL — search + playback streamed through the server
// ======================================================
function formatDuration(seconds) { if (!seconds) return ''; const h = Math.floor(seconds / 3600), m = Math.floor(seconds % 3600 / 60), s2 = seconds % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s2).padStart(2, '0'); }
function formatViews(n) { if (!n) return ''; if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B views'; if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M views'; if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K views'; return n + ' views'; }
function youtubePanel(s) {
  heading(s, 'WATCH · VIA SERVER', 'YouTube');
  const searchInput = el('input', { type: 'search', placeholder: 'Search YouTube or paste a link', 'aria-label': 'YouTube search', dir: 'auto', enterkeyhint: 'search' });
  const form = el('form', { class: 'yt-bar' }, [searchInput, button('Search', null, 'search', 'primary'), button('Home', () => loadHome(), null, '')]);
  form.children[1].type = 'submit';
  const playerArea = el('div', { class: 'yt-player hidden' });
  const content = el('div', { class: 'yt-content' });
  s.append(form, playerArea, content);

  let player = null;
  function stopPlayer() { if (player) { player.destroy(); player = null; } playerArea.replaceChildren(); playerArea.classList.add('hidden'); }

  function linkId(text) {
    const t = text.trim();
    try { const u = new URL(t); if (/youtu\.be$/.test(u.hostname)) return u.pathname.slice(1, 12); if (/youtube\.com$/.test(u.hostname)) return u.searchParams.get('v') || (u.pathname.match(/\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})/) || [])[1] || null; } catch {}
    return null;
  }

  async function play(id, meta = {}) {
    stopPlayer();
    const video = el('video', { class: 'yt-video', controls: '', playsinline: '', preload: 'auto', poster: `/api/yt/thumb/${id}` });
    const audio = el('audio', { preload: 'auto', class: 'hidden' });
    const quality = el('select', { 'aria-label': 'Quality', class: 'yt-quality' });
    const title = el('h3', { text: meta.title || 'Loading…', dir: 'auto' });
    const sub = el('small', { class: 'muted', text: 'Resolving stream on the server…' });
    playerArea.append(el('div', { class: 'yt-player-wrapper' }, [video, audio, el('div', { class: 'yt-player-info' }, [el('div', { class: 'yt-player-text' }, [title, sub]), el('div', { class: 'yt-player-actions' }, [quality, button('Close', stopPlayer, null, '')])])]));
    playerArea.classList.remove('hidden');
    playerArea.scrollIntoView({ behavior: 'smooth', block: 'start' });

    let info = null, current = null, retried = false, syncTimer = 0, resumeAfterAudio = false, alive = true;
    player = { destroy() { alive = false; clearInterval(syncTimer); for (const m of [video, audio]) { m.pause(); m.removeAttribute('src'); m.load(); } } };

    const split = () => current?.mode === 'split';
    function sync() { if (split() && !video.paused && Math.abs(audio.currentTime - video.currentTime) > 0.35) audio.currentTime = video.currentTime; }
    video.addEventListener('play', () => { if (split()) { audio.currentTime = video.currentTime; audio.play().catch(() => {}); } });
    video.addEventListener('pause', () => { if (split()) audio.pause(); });
    video.addEventListener('seeking', () => { if (split()) audio.currentTime = video.currentTime; });
    video.addEventListener('waiting', () => { if (split()) audio.pause(); });
    video.addEventListener('playing', () => { if (split()) { sync(); audio.play().catch(() => {}); } });
    video.addEventListener('ratechange', () => { audio.playbackRate = video.playbackRate; });
    video.addEventListener('volumechange', () => { audio.volume = video.volume; audio.muted = video.muted; });
    audio.addEventListener('waiting', () => { if (split() && !video.paused) { resumeAfterAudio = true; video.pause(); } });
    audio.addEventListener('canplay', () => { if (resumeAfterAudio) { resumeAfterAudio = false; video.play().catch(() => {}); } });
    syncTimer = setInterval(sync, 1000);

    async function onError() {
      if (!alive || retried) { if (alive) sub.textContent = 'Playback failed. Try another quality.'; return; }
      retried = true; const at = (current?.mode === 'audio' ? audio : video).currentTime;
      sub.textContent = 'Refreshing stream…';
      const fresh = await api(`/api/yt/video/${id}?fresh=1`);
      if (fresh.error || !alive) { sub.textContent = fresh.error || 'Playback failed'; return; }
      info = fresh; fill(); choose(quality.value, at);
    }
    video.addEventListener('error', () => { if (video.getAttribute('src')) onError(); });
    audio.addEventListener('error', () => { if (audio.getAttribute('src')) onError(); });

    function fill() {
      quality.replaceChildren();
      info.qualities.forEach((q, i) => quality.append(el('option', { value: String(i), text: q.label + (q.mode === 'muxed' ? ' · fast' : '') })));
    }
    function choose(index, at = 0) {
      current = info.qualities[Number(index)] || info.qualities[0];
      const wasPaused = !(at > 0) ? false : video.paused && audio.paused;
      for (const m of [video, audio]) { m.pause(); m.removeAttribute('src'); }
      video.classList.toggle('audio-mode', current.mode === 'audio');
      if (current.mode === 'muxed') { video.src = current.src; }
      else if (current.mode === 'split') { video.src = current.video; audio.src = current.audio; }
      else { audio.src = current.audio; audio.controls = true; }
      audio.classList.toggle('hidden', current.mode !== 'audio');
      const main = current.mode === 'audio' ? audio : video;
      main.addEventListener('loadedmetadata', () => { if (at) main.currentTime = at; if (!wasPaused) main.play().catch(() => {}); }, { once: true });
      try { localStorage.setItem('sp_yt_quality', String(current.height)); } catch {}
    }
    quality.onchange = () => { retried = false; choose(quality.value, (current?.mode === 'audio' ? audio : video).currentTime); };

    info = await api(`/api/yt/video/${id}`);
    if (!alive) return;
    if (info.error) { sub.textContent = info.error; return; }
    title.textContent = info.title; sub.textContent = [info.uploaderName, formatViews(info.views)].filter(Boolean).join(' · ');
    fill();
    let preferred = 360; try { preferred = Number(localStorage.getItem('sp_yt_quality')) || 360; } catch {}
    let index = info.qualities.findIndex(q => q.height === preferred && (q.mode !== 'split' || !info.qualities.some(o => o.mode === 'muxed' && o.height === preferred)));
    if (index < 0) index = info.qualities.findIndex(q => q.mode === 'muxed');
    if (index < 0) index = info.qualities.findIndex(q => q.mode === 'split' && q.height <= 480);
    if (index < 0) index = 0;
    quality.value = String(index); choose(index);
  }

  function renderResults(items) {
    if (!items?.length) { content.replaceChildren(el('p', { class: 'muted', text: 'No videos found' })); return; }
    const grid = el('div', { class: 'yt-results' });
    for (const v of items) {
      const card = el('button', { type: 'button', class: 'yt-card' }, [
        el('div', { class: 'yt-thumb-wrap' }, [el('img', { src: v.thumbnail, alt: '', class: 'yt-thumb', loading: 'lazy' }), ...(v.live ? [el('span', { class: 'yt-duration live', text: 'LIVE' })] : v.duration ? [el('span', { class: 'yt-duration', text: formatDuration(v.duration) })] : [])]),
        el('div', { class: 'yt-meta' }, [el('strong', { text: v.title || 'Untitled', class: 'yt-title', dir: 'auto' }), el('small', { class: 'muted', text: [v.uploaderName, formatViews(v.views)].filter(Boolean).join(' · '), dir: 'auto' })]),
      ]);
      card.querySelector('img').addEventListener('error', e => { e.target.style.visibility = 'hidden'; });
      card.onclick = () => play(v.id, v);
      grid.append(card);
    }
    content.replaceChildren(grid);
  }
  async function run(path, label) {
    content.replaceChildren(el('div', { class: 'thinking', text: label }));
    const r = await api(path);
    if (r.error) { content.replaceChildren(el('p', { class: 'error', text: r.error })); return; }
    renderResults(r.items);
  }
  function loadHome() { run('/api/yt/home', 'Loading…'); }
  form.onsubmit = e => {
    e.preventDefault();
    const q = searchInput.value.trim(); if (!q) return;
    const id = linkId(q);
    if (id) return play(id);
    searchInput.blur();
    run(`/api/yt/search?q=${encodeURIComponent(q)}`, 'Searching on the server…');
  };
  loadHome();
}

// ======================================================
// SETTINGS PANEL
// ======================================================
function settingsPanel(s){heading(s,'MAKE IT YOURS','Settings');const grid=el('div',{class:'settings-grid'});s.append(grid);function card(title){const c=el('div',{class:'settings-card'},[el('h2',{text:title})]);grid.append(c);return c}const account=card('Profile'),name=el('input',{placeholder:'Username',maxlength:'24','aria-label':'Username'});name.value=username;account.append(name,button('Save name',()=>{if(ws?.readyState!==1)return toast('Messages are reconnecting');ws.send(JSON.stringify({kind:'name',name:name.value})).catch(e=>toast(e.message))},null,'primary'));const appearance=card('Appearance');function choice(parent,label,key,options){const select=el('select',{'aria-label':label});options.forEach(([value,text])=>select.append(el('option',{value,text})));select.value=prefs[key];select.onchange=()=>{prefs[key]=select.value;savePrefs()};parent.append(el('label',{class:'setting-row'},[el('span',{text:label}),select]))}function toggle(parent,label,key){const input=el('input',{type:'checkbox'});input.checked=prefs[key];input.onchange=()=>{prefs[key]=input.checked;savePrefs()};parent.append(el('label',{class:'setting-row'},[el('span',{text:label}),input]))}choice(appearance,'Theme','theme',[['dark','Midnight'],['light','Daylight'],['system','System']]);choice(appearance,'Text size','fontSize',[['normal','Normal'],['large','Large']]);toggle(appearance,'Animations','motion');const notifications=card('Notifications');toggle(notifications,'Notification sound','sound');const volume=el('input',{type:'range',min:'0',max:'1',step:'.05','aria-label':'Notification volume'});volume.value=prefs.volume;volume.oninput=()=>{prefs.volume=Number(volume.value);savePrefs()};notifications.append(el('label',{class:'setting-row'},[el('span',{text:'Volume'}),volume]),button('Preview sound',beep),button('Enable device notifications',enableNotifications),button('Disable device notifications',async()=>{prefs.notifications=false;savePrefs();await api('/api/push/disable',{});const registration=await navigator.serviceWorker?.getRegistration();await (await registration?.pushManager.getSubscription())?.unsubscribe();toast('Notifications disabled','success')}));const chat=card('Chat');toggle(chat,'Enter to send','enterSend');chat.append(el('p',{class:'muted',text:'Messages expire after 24 hours.'}));}
async function enableNotifications(){try{if(!('Notification'in window))throw Error('Device notifications are unavailable in this browser');if(await Notification.requestPermission()!=='granted')throw Error('Allow notifications in your browser settings');prefs.notifications=true;savePrefs();if(myConfig.vapid&&'serviceWorker'in navigator&&'PushManager'in window){const registration=await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;const bytes=Uint8Array.from(atob(myConfig.vapid.replace(/-/g,'+').replace(/_/g,'/')),x=>x.charCodeAt(0));const subscription=await registration.pushManager.getSubscription()||await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:bytes});const r=await api('/api/push',{subscription});if(r.error)throw Error(r.error)}toast(myConfig.vapid?'Device notifications enabled':'Notifications enabled while this page is open','success')}catch(e){toast(e.message)}}

// ======================================================
// CHAT PANEL
// ======================================================
const chatState={id:'',users:[],items:[],tabs:new Map([['public','Public']]),active:'public',unread:new Map(),render:()=>{},connected:false};
function startChat(){ws=new ChatTransport();ws.onoffline=()=>{chatState.connected=false;chatState.render()};ws.onopen=()=>{chatState.connected=true;if(username)ws.send(JSON.stringify({kind:'name',name:username})).catch(e=>toast(e.message));chatState.render()};ws.onclose=e=>{chatState.connected=false;chatState.render();if(e.code!==4001)setTimeout(startChat,2500);else toast('Your session ended. Sign in again.')};ws.onmessage=e=>{let item;try{item=JSON.parse(e.data)}catch{return}if(item.kind==='identity'){chatState.id=item.id;username=item.name;localStorage.setItem('sp_name',username);document.querySelectorAll('.avatar').forEach(n=>n.textContent=username[0].toUpperCase());const accountName=document.querySelector('.account strong');if(accountName)accountName.textContent=username}else if(item.kind==='presence')chatState.users=item.users;else if(item.kind==='history'){chatState.items=item.items;for(const m of item.items)if(m.toId)chatState.tabs.set(m.fromId===chatState.id?m.toId:m.fromId,m.fromId===chatState.id?m.to:m.from)}else if(item.kind==='prune')chatState.items=chatState.items.filter(m=>m.at>item.cutoff);else if(item.kind==='error')toast(item.text);else if(item.kind==='message'){if(chatState.items.some(x=>x.id===item.id))return;chatState.items.push(item);const tab=item.toId?(item.fromId===chatState.id?item.toId:item.fromId):'public';if(tab!=='public')chatState.tabs.set(tab,item.fromId===chatState.id?item.to:item.from);const panel=document.querySelector('.chat-panel');if(tab!==chatState.active||!panel||panel.classList.contains('hidden'))chatState.unread.set(tab,(chatState.unread.get(tab)||0)+1);if(item.fromId!==chatState.id&&(item.toId===chatState.id||item.mentions?.includes(chatState.id))){beep();toast(`${item.from}: ${item.sticker?'Sent a sticker':item.text.slice(0,140)}`,'notice');if(prefs.notifications&&!myConfig.vapid&&document.hidden&&'Notification'in window&&Notification.permission==='granted')new Notification(item.toId?'Private message':'You were mentioned',{body:`${item.from}: ${item.text||'Sticker'}`})}}chatState.render()}}
function chatPanel(s){heading(s,'STAY IN THE LOOP','Messages',el('span',{class:'muted',text:'24-hour history'}));const layout=el('div',{class:'chat-layout'}),people=el('aside',{class:'people-list'}),main=el('div',{class:'chat-main'}),tabs=el('div',{class:'chat-tabs',role:'tablist'}),feed=el('div',{id:'messages','aria-live':'polite'}),input=el('textarea',{placeholder:'Write a message…',rows:'2',maxlength:'2000',dir:'auto','aria-label':'Message'}),status=el('span',{class:'muted'}),picker=el('div',{class:'emoji-picker hidden'});['😀','😂','❤️','👍','🎉','🙏','🔥','👀'].forEach(emoji=>picker.append(button(emoji,()=>{input.value+=emoji;input.focus()})));['wave','party','heart','thinking'].forEach(sticker=>picker.append(button(sticker,()=>send(sticker),null,'sticker-choice')));const compose=el('div',{class:'chat-composer'},[input,el('div',{class:'composer-bottom'},[button('Emoji & stickers',()=>picker.classList.toggle('hidden')),status,button('Send',()=>send(),'arrow','primary')]),picker]);main.append(tabs,feed,compose);layout.append(main,people);s.append(layout);let sending=false;async function send(sticker=''){if(sending)return;if(ws?.readyState!==1)return toast('Reconnecting…');if(!input.value.trim()&&!sticker)return;const text=input.value;sending=true;try{await ws.send(JSON.stringify({kind:'message',text,toId:chatState.active==='public'?'':chatState.active,sticker}));if(input.value===text)input.value='';picker.classList.add('hidden')}catch(e){toast(e.message)}finally{sending=false}}input.onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&prefs.enterSend){e.preventDefault();send()}};function activate(id,name){chatState.tabs.set(id,name);chatState.active=id;chatState.unread.delete(id);render();input.focus()}function render(){status.textContent=chatState.connected?'Connected':'Reconnecting…';tabs.replaceChildren();for(const[id,label]of chatState.tabs){const count=chatState.unread.get(id)||0,b=button(label+(count?` · ${count}`:''),()=>activate(id,label),null,id===chatState.active?'active':'');b.setAttribute('role','tab');b.setAttribute('aria-selected',String(id===chatState.active));tabs.append(b)}people.replaceChildren(el('h3',{text:`Online · ${chatState.users.length}`}));for(const user of chatState.users){const row=el('div',{class:'person'},[el('span',{class:'presence-dot'}),user.id===chatState.id?el('strong',{text:user.name+' · you'}):button(user.name,()=>activate(user.id,user.name),null,'person-name')]);if(user.id!==chatState.id)row.append(button('Message',()=>activate(user.id,user.name)),button('@',()=>{activate('public','Public');input.value+=`@${user.name} `;input.focus()}));people.append(row)}feed.replaceChildren();const messages=chatState.items.filter(m=>chatState.active==='public'?!m.toId:m.toId&&(m.fromId===chatState.active||m.toId===chatState.active));if(!messages.length)feed.append(el('div',{class:'chat-empty',text:'Start a conversation'}));for(const m of messages){const line=el('article',{class:`chat-message ${m.fromId===chatState.id?'own':''}`,dir:'auto'},[el('div',{class:'chat-meta'},[el('strong',{text:m.from}),el('time',{text:new Date(m.at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})})])]);if(m.text)line.append(el('p',{text:m.text}));if(['wave','party','heart','thinking'].includes(m.sticker))line.append(el('img',{src:`/stickers/${m.sticker}.svg`,class:'chat-sticker',alt:m.sticker}));feed.append(line)}feed.scrollTop=feed.scrollHeight}chatState.render=render;render()}

// ======================================================
// REMOTE ACCESS PANEL
// ======================================================
function rdpPanel(s) {
  heading(s, 'YOUR DEVICES', 'Remote Access', el('a', { href: '/api/host/download', class: 'download-button', text: 'Download host app' }));
  const code = el('input', { type: 'password', placeholder: 'Paste connection code (SP2...)', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Connection code', maxlength: '800', required: '' });
  const status = el('p', { class: 'status', role: 'status', text: 'Disconnected' });
  const stage = el('div', { class: 'remote-stage' });
  const frame = el('iframe', { class: 'remote-view', title: 'Remote desktop', allow: 'autoplay; fullscreen; clipboard-read; clipboard-write; gamepad', allowfullscreen: '' });
  const setup = el('details', { class: 'remote-setup' }, [el('summary', { text: 'First-time PC setup (only once)' }), el('p', { text: 'Already have a connection code from the host app? Paste it above and connect. This setup section is only for registering a new PC: install the host app, create a pairing code below, then enter it and this site URL in the host app.' })]);
  const pairing = el('input', { readonly: '', type: 'password', 'aria-label': 'Pairing code', placeholder: 'Valid for 10 minutes' });
  setup.append(el('div', { class: 'pairing-row' }, [button('Create pairing code', async () => { try { const r = await api('/api/desktop/enroll', {}); if (r.error) throw Error(r.error); pairing.value = r.token; } catch (e) { toast(e.message); } }), pairing, button('Copy pairing code', async () => { try { if (pairing.value) await navigator.clipboard.writeText(pairing.value); } catch { pairing.type = 'text'; pairing.select(); } })]), el('p', { class: 'muted', text: 'First connection: add 127.0.0.1 in Moonlight, pair its PIN in Sunshine on your PC, then open Desktop. Pairing is saved. Keep the host window open.' }));
  let connected = false;
  const connect = button('Connect', null, null, 'primary');
  async function connectHost() {
    connect.disabled = true; status.textContent = 'Connecting…';
    try {
      const match = /^SP2\.([A-F0-9]{10})\.([A-Za-z0-9_-]+)$/.exec(code.value.trim());
      if (!match) throw Error('Copy the full connection code using Copy connection code in the host app.');
      let password;
      try {
        const value = match[2].replace(/-/g, '+').replace(/_/g, '/');
        password = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(value), c => c.charCodeAt(0)));
        if (password.length < 12 || password.length > 128) throw Error();
      } catch { throw Error('Invalid connection code. Copy it again from the host app.'); }
      const r = await api('/api/desktop/connect', { code: match[1], password });
      if (!r.url) throw Error(r.error || 'Connection failed');
      frame.src = r.url; stage.replaceChildren(frame); connected = true; status.textContent = 'Host connected';
      code.value = ''; setup.open = false;
    } catch (e) { status.textContent = e.message || 'Connection failed. Please retry.'; }
    finally { connect.disabled = false; }
  }
  async function disconnect() {
    connected = false; frame.removeAttribute('src'); stage.replaceChildren(); status.textContent = 'Disconnected';
    try { await api('/api/desktop/disconnect', {}); } catch {}
  }
  const form = el('form', { class: 'remote-form' }, [code, connect]);
  connect.type = 'submit'; connect.onclick = null;
  form.onsubmit = async e => { e.preventDefault(); if (!connect.disabled) await connectHost(); };
  s.append(el('p', { class: 'muted', text: 'Copy the connection code from S-Power Host, paste it here, then connect. Keep the host app running on your PC.' }), form, setup, el('div', { class: 'remote-toolbar' }, [status, button('Full screen', () => stage.requestFullscreen?.().catch(() => toast('Full screen unavailable')), 'full'), button('Disconnect', disconnect)]), stage);
  window.addEventListener('pagehide', () => { if (connected) navigator.sendBeacon('/api/desktop/disconnect', new Blob(['{}'], { type: 'application/json' })); });
  const poll = setInterval(async () => {
    if (!s.isConnected) { clearInterval(poll); return; }
    if (!connected) return;
    try { const r = await api('/api/desktop/status'); if (!r.connected) { connected = false; frame.removeAttribute('src'); stage.replaceChildren(); status.textContent = 'Host disconnected'; } } catch {}
  }, 5000);
}
