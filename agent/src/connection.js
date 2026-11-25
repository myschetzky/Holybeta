'use strict';
/*
 * Forbindelse til HolyMoly-serveren. Designet til dårligt skole-wifi:
 * - genforbinder automatisk med eksponentiel backoff + jitter
 * - hændelser (web-log m.m.) lægges i kø og sendes først når serveren har kvitteret
 * - skærmbilleder droppes hellere end at hobe sig op
 */
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');

const MAX_QUEUE = 5000;

class Connection extends EventEmitter {
  constructor({ serverUrl, getTokens, device }) {
    super();
    this.serverUrl = serverUrl;
    this.getTokens = getTokens;
    this.device = device;
    this.ws = null;
    this.state = 'offline';
    this.backoff = 1000;
    this.stopped = true;
    this.queue = []; // {seq, item}
    this.seq = 0;
    this.inflight = 0;
    this.flushTimer = null;
    this.reconnectTimer = null;
    this.rtt = 300;
  }

  wsUrl() {
    const u = new URL(this.serverUrl);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.pathname = '/ws/agent';
    return u.toString();
  }

  start() {
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.flushTimer);
    clearInterval(this.pingTimer);
    if (this.ws) { try { this.ws.close(1000); } catch (e) { /* */ } }
    this.ws = null;
    this._setState('offline');
  }

  restart() {
    this.stop();
    this.start();
  }

  _setState(s, extra) {
    if (this.state === s && !extra) return;
    this.state = s;
    this.emit('state', s, extra);
  }

  _connect() {
    if (this.stopped) return;
    const tokens = this.getTokens();
    if (!tokens.length) { this._setState('offline'); return; }
    this._setState('connecting');
    let ws;
    try {
      ws = new WebSocket(this.wsUrl(), { handshakeTimeout: 15_000, perMessageDeflate: false, maxPayload: 4 * 1024 * 1024 });
    } catch (e) {
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', tokens, device: this.device }));
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try { msg = JSON.parse(data.toString('utf8')); } catch (e) { return; }
      this._onMessage(msg);
    });
    ws.on('close', (code) => {
      if (this.ws !== ws) return;
      this.ws = null;
      clearInterval(this.flushTimer);
      clearInterval(this.pingTimer);
      this.inflight = 0;
      if (code === 4401) {
        this._setState('unauthorized');
        this.emit('unauthorized');
        this._scheduleReconnect(60_000);
        return;
      }
      this._setState('offline');
      this._scheduleReconnect();
    });
    ws.on('error', () => { /* close-eventet håndterer genforbindelse */ });
  }

  _scheduleReconnect(min) {
    if (this.stopped) return;
    clearTimeout(this.reconnectTimer);
    const delay = Math.max(min || 0, this.backoff) * (0.7 + Math.random() * 0.6);
    this.backoff = Math.min(30_000, this.backoff * 2);
    this.reconnectTimer = setTimeout(() => this._connect(), delay);
  }

  _onMessage(msg) {
    switch (msg.type) {
      case 'welcome':
        this.backoff = 1000;
        this._setState('online');
        this.flushTimer = setInterval(() => this._flush(), 2000);
        this.pingTimer = setInterval(() => this.send({ type: 'ping', t: Date.now() }), 15_000);
        this._flush();
        break;
      case 'ack': {
        const seq = Number(msg.seq) || 0;
        this.queue = this.queue.filter(q => q.seq > seq);
        this.inflight = 0;
        if (this.queue.length) setImmediate(() => this._flush());
        break;
      }
      case 'pong':
        if (msg.t) this.rtt = Math.max(20, Date.now() - msg.t);
        break;
      default:
        break;
    }
    this.emit('message', msg);
  }

  get online() { return this.state === 'online' && this.ws && this.ws.readyState === 1; }

  send(obj) {
    if (!this.online) return false;
    this.ws.send(JSON.stringify(obj));
    return true;
  }

  /** Sender et binært billede, men kun hvis forbindelsen ikke allerede er fyldt op. */
  sendBinary(buf, maxBuffered = 600_000) {
    if (!this.online) return false;
    if (this.ws.bufferedAmount > maxBuffered) return false;
    this.ws.send(buf, { binary: true });
    return true;
  }

  get buffered() { return this.ws ? this.ws.bufferedAmount : 0; }

  /** Lægger en hændelse i kø; den sendes når der er forbindelse. */
  event(item) {
    this.queue.push({ seq: ++this.seq, item: Object.assign({ ts: Date.now() }, item) });
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
  }

  _flush() {
    if (!this.online || !this.queue.length || this.inflight) return;
    const batch = this.queue.slice(0, 200);
    this.inflight = Date.now();
    this.send({ type: 'events', seq: batch[batch.length - 1].seq, items: batch.map(b => b.item) });
    // Hvis kvitteringen udebliver, prøver vi igen efter 20 s.
    setTimeout(() => { if (this.inflight && Date.now() - this.inflight >= 20_000) { this.inflight = 0; this._flush(); } }, 20_500);
  }
}

module.exports = { Connection };
