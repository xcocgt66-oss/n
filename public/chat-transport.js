// WebSocket-shaped adapter keeps the existing UI while using same-origin HTTPS.
class ChatTransport {
  readyState = 0;
  client = crypto.randomUUID();
  after = 0;
  stopped = false;
  constructor() {
    this.controller = new AbortController();
    this.unload = () => this.close(4001);
    window.addEventListener('pagehide', this.unload);
    queueMicrotask(() => this.poll());
  }
  async request(path, data) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    this.controller.signal.addEventListener('abort', abort, { once: true });
    if (this.stopped) controller.abort();
    const timer = setTimeout(abort, 12000);
    try {
      const response = await fetch('/api/chat/' + path, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client: this.client, token: this.token, ...data }),
        signal: controller.signal
      });
      if (response.status === 401) { this.close(4001); throw Error('Please sign in again'); }
      if (response.status === 410) { this.token = null; this.after = 0; throw Error('Messages are reconnecting'); }
      const result = await response.json();
      if (!response.ok) throw Error(result.error || 'Messages are unavailable');
      return result;
    } finally {
      clearTimeout(timer);
      this.controller.signal.removeEventListener('abort', abort);
    }
  }
  async poll() {
    let delay = 1500;
    try {
      if (!this.token) {
        const result = await this.request('open', {});
        this.token = result.token;
      }
      const result = await this.request('poll', { after: this.after });
      if (this.stopped) return;
      if (this.readyState !== 1) { this.readyState = 1; this.onopen?.(); }
      for (const event of result.events) {
        if (event.sequence <= this.after) continue;
        this.onmessage?.({ data: JSON.stringify(event.data) });
        this.after = event.sequence;
      }
      if (result.events.length === 100) delay = 0;
    } catch {
      if (this.stopped) return;
      this.readyState = 0;
      this.onoffline?.();
      delay = 3000;
    }
    if (!this.stopped) this.timer = setTimeout(() => this.poll(), delay);
  }
  async send(raw) {
    if (this.readyState !== 1) throw Error('Messages are reconnecting');
    const payload = { id: crypto.randomUUID(), message: JSON.parse(raw) };
    let result;
    try { result = await this.request('send', payload); }
    catch (error) {
      // Retry only with the same receipt and live connection token.
      if (this.stopped || !this.token) throw error;
      result = await this.request('send', payload);
    }
    if (result.error) throw Error(result.error);
  }
  close(code = 1000) {
    if (this.stopped) return;
    this.stopped = true;
    this.readyState = 3;
    clearTimeout(this.timer);
    this.controller.abort();
    window.removeEventListener('pagehide', this.unload);
    if (this.token) navigator.sendBeacon?.('/api/chat/close', new Blob([JSON.stringify({ client: this.client, token: this.token })], { type: 'application/json' }));
    this.onclose?.({ code });
  }
}
