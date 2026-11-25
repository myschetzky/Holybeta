'use strict';
/*
 * Klient til HolyMoly-netværksfilteret på Mac (systemudvidelse, se macos/).
 *
 * Filteret ser hver ny forbindelse på Mac'en (program + værtsnavn). Under en lektion
 * blokerer det AI-tjenester og forbudte sider for ALLE programmer og melder
 * AI-forbindelser hertil. Elev-appen:
 *   - forbinder til 127.0.0.1:47830 og tjekker at det VIRKELIG er systemudvidelsen der lytter
 *   - sender lektionens regler (og gentager dem hvert 5. sekund)
 *   - opdager hvis et andet program ændrer filterets indstillinger (= manipulation)
 */
const { EventEmitter } = require('node:events');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');

const PORT = 47830;
const EXT_ID = 'dk.holymoly.filterapp.extension';

/** Tjekker at processen der lytter på porten er HolyMoly-systemudvidelsen. */
function verifyListener(port) {
  return new Promise((resolve) => {
    execFile('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], { timeout: 4000 }, (err, out) => {
      const pid = Number((String(out || '').match(/^p(\d+)/m) || [])[1]);
      if (err || !pid) return resolve({ ok: false, reason: 'ingen lytter' });
      execFile('ps', ['-o', 'comm=', '-p', String(pid)], { timeout: 4000 }, (err2, out2) => {
        const exe = String(out2 || '').trim();
        // Systemudvidelser installeres af macOS i /Library/SystemExtensions/<uuid>/<id>.systemextension/
        const ok = !err2 && exe.startsWith('/Library/SystemExtensions/') && exe.includes(`/${EXT_ID}.systemextension/`);
        resolve({ ok, pid, exe, reason: ok ? '' : 'forkert proces: ' + exe });
      });
    });
  });
}

class MacFilter extends EventEmitter {
  constructor({ port = PORT, verify = verifyListener, log = () => {} } = {}) {
    super();
    this.port = port;
    this.verify = verify;
    this.log = log;
    this.sock = null;
    this.state = 'missing'; // 'ok' | 'missing' | 'unverified'
    this.connId = 0;
    this.config = null;
    this.flows = []; // seneste hændelser fra filteret
    this.timer = null;
    this.stopped = true;
    this.lastForeignChange = 0;
    this.version = '';
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this._connect();
    this.timer = setInterval(() => {
      if (!this.sock) this._connect();
      else if (this.config) this._sendConfig();
    }, 5000);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    if (this.sock) this.sock.destroy();
    this.sock = null;
  }

  /** Lektionens regler. active=false betyder "ingen lektion". */
  setConfig(cfg) {
    this.config = cfg;
    this._sendConfig();
  }

  _sendConfig() {
    if (!this.sock || this.state !== 'ok' || !this.config) return;
    this._write(Object.assign({ type: 'config' }, this.config));
  }

  _write(obj) {
    try { this.sock.write(JSON.stringify(obj) + '\n'); } catch (e) { /* lukket */ }
  }

  _setState(s, why) {
    if (this.state === s) return;
    this.state = s;
    this.emit('state', s, why);
  }

  _connect() {
    if (this.stopped || this.connecting) return;
    this.connecting = true;
    const sock = net.connect({ host: '127.0.0.1', port: this.port });
    let buf = '';
    let helloSeen = false;
    let rejected = false;
    const fail = () => {
      this.connecting = false;
      if (this.sock === sock) this.sock = null;
      if (!rejected) this._setState('missing', 'ingen forbindelse');
    };
    sock.setTimeout(10_000, () => sock.destroy());
    sock.on('error', fail);
    sock.on('close', fail);
    sock.on('connect', async () => {
      sock.setTimeout(0);
      const v = await this.verify(this.port);
      if (!v.ok) {
        rejected = true;
        this.log('Netværksfilter ikke verificeret: ' + v.reason);
        this._setState('unverified', v.reason);
        this.connecting = false;
        sock.destroy();
        return;
      }
      this.sock = sock;
      this.connecting = false;
    });
    sock.setEncoding('utf8');
    sock.on('data', (d) => {
      buf += d;
      if (buf.length > 2_000_000) { sock.destroy(); return; }
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m;
        try { m = JSON.parse(line); } catch (e) { continue; }
        if (m.type === 'hello') {
          helloSeen = true;
          this.connId = Number(m.conn) || 0;
          this.version = String(m.version || '');
          // Vent til verificeringen er færdig, før vi melder "ok"
          let tries = 0;
          const ready = () => {
            if (rejected || sock.destroyed || ++tries > 200) return;
            if (this.sock !== sock) return setTimeout(ready, 50);
            this._setState('ok');
            this._sendConfig();
          };
          ready();
        } else if (helloSeen) {
          this._onMessage(m);
        }
      }
    });
  }

  _onMessage(m) {
    if (m.type === 'flow') {
      const f = {
        ts: Date.now(), app: String(m.app || '').slice(0, 200), pid: Number(m.pid) || 0,
        host: String(m.host || '').slice(0, 300), rule: String(m.rule || '').slice(0, 300), ai: !!m.ai, blocked: !!m.blocked,
      };
      this.flows.push(f);
      if (this.flows.length > 500) this.flows.splice(0, this.flows.length - 500);
      this.emit('flow', f);
    } else if (m.type === 'state') {
      // Ændret af en anden forbindelse end vores = et andet program prøver at styre filteret
      const by = Number(m.by) || 0;
      if (by && by !== this.connId) {
        this.lastForeignChange = Date.now();
        this.emit('tamper', { by, active: !!m.active, until: Number(m.until) || 0 });
        // Gendan vores egne regler med det samme
        this._sendConfig();
      }
    }
  }

  /** AI-forbindelser fra de seneste `ms` millisekunder. */
  recentAi(ms = 20_000, now = Date.now()) {
    return this.flows.filter(f => f.ai && now - f.ts < ms);
  }
}

/* ---------------- installation (HolyMoly Filter.app) ---------------- */

function helperApp(resourcesPath) {
  const candidates = [
    '/Applications/HolyMoly Filter.app',
    path.join(resourcesPath || '', 'HolyMoly Filter.app'),
  ];
  return candidates.find(p => fs.existsSync(path.join(p, 'Contents', 'MacOS', 'HolyMoly Filter'))) || null;
}

/** Kører værts-appen og returnerer dens sidste JSON-svar. onEvent får mellemsvar (fx "needs_approval"). */
function runHelper(appPath, command, onEvent = () => {}) {
  return new Promise((resolve) => {
    const bin = path.join(appPath, 'Contents', 'MacOS', 'HolyMoly Filter');
    const child = spawn(bin, [command], { stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    let last = { ok: false, status: 'no_output' };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        try { last = JSON.parse(line); onEvent(last); } catch (e) { /* */ }
      }
    });
    child.on('error', (e) => resolve({ ok: false, status: 'spawn_failed', error: e.message }));
    child.on('exit', () => resolve(last));
  });
}

/** Installerer og slår filteret til. Flytter værts-appen til /Programmer hvis macOS kræver det. */
async function activate(resourcesPath, onEvent) {
  let app = helperApp(resourcesPath);
  if (!app) return { ok: false, status: 'not_bundled' };
  let r = await runHelper(app, 'activate', onEvent);
  if (!r.ok && r.parentLocation && app !== '/Applications/HolyMoly Filter.app') {
    await new Promise((res) => execFile('ditto', [app, '/Applications/HolyMoly Filter.app'], { timeout: 60_000 }, res));
    app = '/Applications/HolyMoly Filter.app';
    r = await runHelper(app, 'activate', onEvent);
  }
  return r;
}

module.exports = { MacFilter, verifyListener, activate, helperApp, runHelper, PORT, EXT_ID };
