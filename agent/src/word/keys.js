'use strict';
/*
 * "Skriv i Word" – tastetælleren (keys.ps1) som underproces. Startes af Word-broen, når en Word-økt åbner,
 * og stoppes, når den slutter. Den tæller kun i det Word-vindue (hwnd), broen giver den, og kun mens det er i forgrunden.
 * Den gemmer aldrig hvilke taster – kun kategorier og tider (se keys.ps1).
 *
 * get(hwnd) svarer:
 *   { typed, deleted, pasteKeys, injected, undo, keystrokes, maxCps, burst, fastShare, regularity }  tællerne
 *   undefined   tælleren starter stadig (ved ikke endnu)
 *   null        tastetryk kan ikke tælles på denne computer (hooken kunne ikke installeres, processen stoppede …)
 *
 * Testene bruger `node bridge-fake.js --keys` (samme protokol).
 */
const fs = require('node:fs');
const { spawn } = require('node:child_process');
// bridge.js kræver denne fil – derfor hentes asciiJson og BOOT først, når de bruges
const bridge = () => require('./bridge.js');

const FIELDS = ['typed', 'deleted', 'pasteKeys', 'injected', 'undo', 'keystrokes', 'maxCps', 'burst', 'fastShare'];

/** Kun de kendte felter, som tal (alt andet fra processen smides væk). */
function cleanKeys(k) {
  if (!k || typeof k !== 'object') return null;
  const out = {};
  for (const f of FIELDS) { const n = Number(k[f]); out[f] = Number.isFinite(n) && n > 0 ? n : 0; }
  const r = Number(k.regularity);
  out.regularity = k.regularity == null || !Number.isFinite(r) || r < 0 ? null : r;
  return out;
}

class KeysHelper {
  /** opts: { command, args, script (sti til keys.ps1 eller null), env, readyMs, timeoutMs } */
  constructor(opts = {}) {
    this.command = opts.command;
    this.args = opts.args || [];
    this.script = opts.script || null;
    this.env = opts.env;
    this.readyMs = Number(opts.readyMs) > 0 ? Number(opts.readyMs) : 20_000;
    this.timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 2000;
    this.state = 'off'; // off | starting | on | failed
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  /** Starter processen. Svarer true, når hooken kører (false: kan ikke tælles). */
  start() {
    if (this._ready) return this._ready;
    this.state = 'starting';
    this._ready = new Promise((resolve) => {
      let child;
      const fail = () => { if (this.state !== 'failed') { this.state = 'failed'; this._kill(); } resolve(false); };
      try {
        child = spawn(this.command, this.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: this.env });
      } catch (e) { fail(); return; }
      this.child = child;
      const timer = setTimeout(() => { if (this.state === 'starting') fail(); }, this.readyMs);
      if (timer.unref) timer.unref();
      let buf = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          let m;
          try { m = JSON.parse(line); } catch (e) { continue; }
          if (m && m.ready && this.state === 'starting') {
            clearTimeout(timer);
            if (m.hook === true) { this.state = 'on'; resolve(true); } else fail();
          } else if (m && this.pending.has(m.id)) {
            const p = this.pending.get(m.id);
            this.pending.delete(m.id);
            clearTimeout(p.timer);
            p.resolve(m);
          }
        }
        if (buf.length > 1_000_000) buf = '';
      });
      child.on('error', () => { /* exit følger */ });
      child.on('exit', () => {
        if (this.child !== child) return;
        clearTimeout(timer);
        this.child = null;
        if (this.state !== 'off') this.state = 'failed';
        for (const [, p] of this.pending) { clearTimeout(p.timer); p.resolve(null); }
        this.pending.clear();
        resolve(false);
      });
      child.stdin.on('error', () => { /* processen er væk */ });
      if (this.script) {
        let src = '';
        try { src = fs.readFileSync(this.script, 'utf8'); } catch (e) { /* */ }
        child.stdin.write(Buffer.from(src, 'utf8').toString('base64') + '\n');
      }
    });
    return this._ready;
  }

  /** Tællerne for Word-vinduet hwnd (se øverst). */
  async get(hwnd) {
    if (this.state === 'starting') return undefined;
    if (this.state !== 'on' || !this.child) return null;
    const id = this.nextId++;
    const m = await new Promise((resolve) => {
      const timer = setTimeout(() => { if (this.pending.delete(id)) resolve(undefined); }, this.timeoutMs);
      this.pending.set(id, { resolve, timer });
      try { this.child.stdin.write(bridge().asciiJson({ id, cmd: 'get', hwnd: Number(hwnd) || 0 }) + '\n'); } catch (e) { clearTimeout(timer); this.pending.delete(id); resolve(null); }
    });
    if (m === undefined) return undefined; // svarede ikke i tide: prøv igen ved næste måling
    if (!m || !m.ok) { this.state = 'failed'; this._kill(); return null; }
    return cleanKeys(m.keys);
  }

  _kill() {
    const c = this.child;
    this.child = null;
    if (c) { try { c.stdin.end(); } catch (e) { /* */ } try { c.kill(); } catch (e) { /* */ } }
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.resolve(null); }
    this.pending.clear();
  }

  /** Word-økten er slut: hooken fjernes (processen lukker, når stdin lukkes – ellers dræbes den). */
  stop() {
    this.state = 'off';
    this._kill();
  }
}

/** Tastetælleren med PowerShell og keys.ps1 (kun Windows). */
function powershellKeys(scriptPath) {
  return new KeysHelper({
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(bridge().BOOT, 'utf16le').toString('base64')],
    script: scriptPath,
  });
}

module.exports = { KeysHelper, powershellKeys, cleanKeys, FIELDS };
