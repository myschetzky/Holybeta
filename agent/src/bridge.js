'use strict';
/*
 * Lokal bro mellem elev-appen og browser-udvidelsen (kun 127.0.0.1).
 * Udvidelsen fortæller hvilke faner der er åbne, logger besøgte sider og
 * melder blokeringsforsøg. Appen sender regler og lektionsstatus tilbage.
 */
const { EventEmitter } = require('node:events');
const http = require('node:http');
const { WebSocketServer } = require('ws');

const PORTS = [47811, 47812, 47813, 47814, 47815];
const ORIGIN_RE = /^(chrome-extension|moz-extension|safari-web-extension|extension):\/\/([a-z0-9-]+)\/?$/i;
const str = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').slice(0, n);

class Bridge extends EventEmitter {
  /**
   * identifyPeer(remotePort, localPort) -> {pid, name, orig} for processen der forbinder
   * browserOfProc({name, orig}) -> 'chrome' | 'edge' | 'firefox' | … | null
   * Kun forbindelser fra en RIGTIG browser-proces accepteres; browsernavnet tages fra
   * processen – aldrig fra hvad klienten selv påstår.
   */
  constructor({ allowedIds = [], identifyPeer = null, browserOfProc = null } = {}) {
    super();
    this.allowedIds = allowedIds.map(s => s.toLowerCase());
    this.identifyPeer = identifyPeer;
    this.browserOfProc = browserOfProc;
    this.squatted = []; // porte et andet program allerede lytter på
    this.clients = new Set();
    this.state = { active: false };
    this.port = null;
  }

  async start() {
    for (const port of PORTS) {
      try {
        await this._listen(port);
        this.port = port;
        return port;
      } catch (e) {
        if (e && e.code === 'EADDRINUSE') this.squatted.push(port);
      }
    }
    throw new Error('Ingen ledig port til browser-udvidelsen');
  }

  _listen(port) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
      const wss = new WebSocketServer({
        server, maxPayload: 512 * 1024, perMessageDeflate: false,
        verifyClient: (info) => this._verify(info.origin || info.req.headers.origin),
      });
      wss.on('connection', (ws, req) => this._onClient(ws, req));
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        this.server = server;
        this.wss = wss;
        resolve();
      });
    });
  }

  _verify(origin) {
    const m = ORIGIN_RE.exec(String(origin || ''));
    if (!m) return false;
    // Firefox giver hver installation et tilfældigt id (moz-extension://<uuid>), så det kan ikke låses fast.
    // Det er ufarligt: elev-appen læser adressen fra browseren selv og stoler ikke blindt på udvidelsen.
    if (m[1].toLowerCase() === 'moz-extension') return true;
    if (this.allowedIds.length && !this.allowedIds.includes(m[2].toLowerCase())) return false;
    return true;
  }

  _onClient(ws, req) {
    const c = { ws, origin: req.headers.origin, browser: 'ukendt', version: '', incognitoAllowed: false, windows: [], tabs: [], lastSeen: Date.now(), hello: false, verified: !this.identifyPeer };
    this.clients.add(c);
    if (this.identifyPeer) this._verifyPeer(c, req);
    ws.on('message', (data) => {
      if (data.length > 512 * 1024) return;
      let msg;
      try { msg = JSON.parse(data.toString('utf8')); } catch (e) { return; }
      c.lastSeen = Date.now();
      if (c.verified || msg.type === 'hello') this._onMessage(c, msg);
    });
    ws.on('close', () => {
      this.clients.delete(c);
      this.emit('change');
      if (c.hello && c.verified) this.emit('ext-disconnected', c);
    });
    ws.on('error', () => {});
    if (c.verified) this._sendState(c);
  }

  async _verifyPeer(c, req) {
    let peer = null;
    try { peer = await this.identifyPeer(req.socket.remotePort, this.port); } catch (e) { peer = null; }
    const browser = peer && this.browserOfProc ? this.browserOfProc(peer) : null;
    const scheme = String(c.origin || '').split(':')[0].toLowerCase();
    // Firefox-udvidelser har moz-extension://, Chromium-udvidelser chrome-extension://
    const schemeOk = browser && (browser === 'firefox' ? scheme === 'moz-extension' : scheme !== 'moz-extension');
    if (!browser || !schemeOk) {
      this.emit('rejected', { peer, origin: c.origin });
      try { c.ws.close(4403, 'not a browser'); } catch (e) { /* */ }
      return;
    }
    c.browser = browser;
    c.pid = peer.pid;
    c.verified = true;
    this._sendState(c);
    this.emit('change');
  }

  _onMessage(c, msg) {
    switch (msg.type) {
      case 'hello':
        c.hello = true;
        if (!this.identifyPeer) c.browser = str(msg.browser, 20).toLowerCase() || 'ukendt';
        c.version = str(msg.version, 20);
        c.incognitoAllowed = !!msg.incognitoAllowed;
        this.emit('change');
        // Tilstand og token sendes først, når det er bekræftet, at det er en rigtig browser (se verificeringen)
        if (c.verified) this._sendState(c);
        break;
      case 'tabs':
        c.windows = (Array.isArray(msg.windows) ? msg.windows : []).slice(0, 40).map(w => ({
          focused: !!w.focused, incognito: !!w.incognito, type: str(w.type, 10),
          active: w.active ? { url: str(w.active.url, 2000), title: str(w.active.title, 300) } : null,
        }));
        c.tabs = (Array.isArray(msg.tabs) ? msg.tabs : []).slice(0, 100).map(t => ({ url: str(t.url, 2000), title: str(t.title, 300), active: !!t.active }));
        this.emit('change');
        break;
      case 'nav':
        this.emit('nav', { url: str(msg.url, 2000), title: str(msg.title, 300), browser: c.browser, blocked: !!msg.blocked });
        break;
      case 'blocked':
        this.emit('blocked', { url: str(msg.url, 2000), title: str(msg.title, 300), category: str(msg.category, 20), reason: str(msg.reason, 60), browser: c.browser });
        break;
      case 'ping':
        this._send(c, { type: 'pong' });
        break;
      default:
        break;
    }
  }

  /** Aktive (friske) udvidelser, evt. filtreret på browser. */
  live(browser) {
    const now = Date.now();
    return [...this.clients].filter(c => c.verified && c.hello && now - c.lastSeen < 45_000 && (!browser || c.browser === browser));
  }

  setState(state) {
    this.state = state;
    for (const c of this.clients) if (c.verified) this._sendState(c);
  }

  _sendState(c) { this._send(c, Object.assign({ type: 'state' }, this.state)); }

  _send(c, msg) {
    if (c.ws.readyState === 1) c.ws.send(JSON.stringify(msg));
  }

  stop() {
    for (const c of this.clients) { try { c.ws.close(); } catch (e) { /* */ } }
    if (this.server) this.server.close();
  }
}

module.exports = { Bridge, PORTS };
