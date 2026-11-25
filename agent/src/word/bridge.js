'use strict';
/*
 * "Skriv i Word" – broen til Word (Windows først).
 *
 * En langtlevende PowerShell-proces (word.ps1) styrer Word via COM (Word.Application). Elev-appen sender én JSON-linje
 * pr. forespørgsel og får én JSON-linje tilbage med samme id:
 *
 *   -> { "id": 1, "cmd": "open", "path": "C:\\...\\Stil.docx", "create": true }
 *   <- { "id": 1, "ok": true, "path": "C:\\...\\Stil.docx" }
 *
 * Kommandoer:
 *   probe                     -> { word: bool, version }                     (findes Word – uden at starte det)
 *   open { path, create }     -> { path, hwnd }                              (opretter og gemmer en ny .docx, eller åbner en)
 *   state                     -> { open, path, text, saved, minimized, rect: { x, y, w, h }, foreground, copilot, hwnd }
 *   save                      -> { path, saved }
 *   seal { footerLines, green, password, path } -> { path }                  (sidefod + læsebeskyttelse + SaveAs2, lukker dokumentet)
 *   close { save }            -> {}
 * Første linje fra processen er { ready: true, word, version }. Al tekst er ASCII (\uXXXX) i begge retninger,
 * så tegnsæt i konsollen er ligegyldige.
 *
 * Tastetryk: mens en Word-økt er åben, kører tastetælleren (keys.ps1, keys.js) i sin egen proces. Den tæller kun i
 * Word-vinduet (hwnd fra open/state) og kun mens det er i forgrunden – aldrig hvilke taster. state() svarer derfor også
 *   keys: { typed, deleted, pasteKeys, injected, undo, keystrokes, maxCps, burst, fastShare, regularity }
 * eller keys: null (tastetryk kan ikke tælles på denne computer). Mens tælleren starter, mangler keys. hwnd sendes ikke videre.
 *
 * På andre platforme end Windows svarer broen { supported: false }. Testene og demoen bruger bridge-fake.js,
 * der taler den samme protokol (command/args).
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { powershellKeys } = require('./keys.js');

/** JSON uden andre tegn end ASCII. */
function asciiJson(o) {
  return JSON.stringify(o).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

// PowerShell læser selve word.ps1 (base64, UTF-8) som første linje på stdin – virker også fra app.asar og uden en midlertidig fil
const BOOT = "$l=[Console]::In.ReadLine();& ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($l))))";

class WordBridge extends EventEmitter {
  /**
   * opts: { platform, command, args, script (sti til .ps1 eller false), timeoutMs, env, keys }
   * Uden command bruges PowerShell med word.ps1 (kun Windows).
   * keys: () => KeysHelper (tastetælleren) eller false. Standard: PowerShell med keys.ps1 – kun uden command.
   */
  constructor(opts = {}) {
    super();
    this.platform = opts.platform || process.platform;
    this.custom = !!opts.command;
    this.supported = this.custom || this.platform === 'win32';
    this.command = opts.command || 'powershell.exe';
    this.args = opts.args || ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(BOOT, 'utf16le').toString('base64')];
    this.script = opts.script === false || this.custom ? null : (opts.script || path.join(__dirname, 'word.ps1'));
    this.timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 10_000;
    this.env = opts.env;
    this.child = null;
    this.hello = null;
    this.nextId = 1;
    this.pending = new Map();
    this._starting = null;
    this.makeKeys = opts.keys === false ? null : typeof opts.keys === 'function' ? opts.keys : this.custom ? null : () => powershellKeys(path.join(__dirname, 'keys.ps1'));
    this.keys = null; // tastetælleren for den åbne Word-økt
  }

  /** Starter processen (én gang). Returnerer { supported, word, version }. */
  start() {
    if (!this.supported) return Promise.resolve({ supported: false, word: false });
    if (this.hello) return Promise.resolve(this.hello);
    if (this._starting) return this._starting;
    this._starting = new Promise((resolve) => {
      let child;
      try {
        child = spawn(this.command, this.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: this.env });
      } catch (e) { this._starting = null; resolve({ supported: true, word: false, error: 'Kunne ikke starte Word-broen' }); return; }
      this.child = child;
      let buf = '';
      const timer = setTimeout(() => { if (!this.hello) { this._starting = null; this.stop(); resolve({ supported: true, word: false, error: 'Word-broen svarede ikke' }); } }, this.timeoutMs);
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
          if (m && m.ready && !this.hello) {
            clearTimeout(timer);
            this.hello = { supported: true, word: !!m.word, version: String(m.version || '') };
            this._starting = null;
            resolve(this.hello);
          } else if (m && this.pending.has(m.id)) {
            const p = this.pending.get(m.id);
            this.pending.delete(m.id);
            clearTimeout(p.timer);
            p.resolve(m);
          }
        }
        if (buf.length > 20_000_000) buf = '';
      });
      child.on('error', () => { /* exit følger */ });
      child.on('exit', () => {
        if (this.child !== child) return;
        clearTimeout(timer);
        this.child = null;
        this.hello = null;
        if (this._starting) { this._starting = null; resolve({ supported: true, word: false, error: 'Word-broen stoppede' }); }
        for (const [, p] of this.pending) { clearTimeout(p.timer); p.resolve({ ok: false, error: 'Word-broen stoppede' }); }
        this.pending.clear();
        this.emit('exit');
      });
      child.stdin.on('error', () => { /* processen er væk */ });
      if (this.script) {
        let src = '';
        try { src = fs.readFileSync(this.script, 'utf8'); } catch (e) { /* */ }
        child.stdin.write(Buffer.from(src, 'utf8').toString('base64') + '\n');
      }
    });
    return this._starting;
  }

  /** Én forespørgsel. Svarer altid (aldrig en fejl, der kastes): { ok, error?, ... }. */
  async request(cmd, args = {}, timeoutMs = this.timeoutMs) {
    if (!this.supported) return { ok: false, supported: false, error: 'Skriv i Word findes kun på Windows' };
    const hello = await this.start();
    if (!hello.word && cmd !== 'probe' && !this.custom) return { ok: false, error: hello.error || 'Word findes ikke på computeren' };
    if (!this.child) return { ok: false, error: hello.error || 'Word-broen kører ikke' };
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { if (this.pending.delete(id)) resolve({ ok: false, error: 'Word svarer ikke', timeout: true }); }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      try { this.child.stdin.write(asciiJson(Object.assign({}, args, { id, cmd })) + '\n'); } catch (e) {
        clearTimeout(timer); this.pending.delete(id); resolve({ ok: false, error: 'Word-broen kører ikke' });
      }
    });
  }

  /** Kan Word bruges her? { supported, word, version } – starter ikke Word. */
  async probe() {
    if (!this.supported) return { supported: false, word: false };
    const h = await this.start();
    return { supported: true, word: !!h.word, version: h.version || '' };
  }
  /** Åbner dokumentet. Tastetælleren startes samtidig (den er klar et par sekunder senere). */
  async open(p, create) {
    this._keysStop();
    if (this.makeKeys) { try { this.keys = this.makeKeys(); this.keys.start(); } catch (e) { this.keys = null; } }
    const r = await this.request('open', { path: String(p || ''), create: !!create }, 60_000);
    if (!r.ok) this._keysStop();
    delete r.hwnd;
    return r;
  }
  /** Word-dokumentets tilstand + tastetællerne (se øverst). */
  async state() {
    const r = await this.request('state', {}, 5000);
    if (r.ok && !r.open) this._keysStop();
    else if (r.ok && !('keys' in r)) {
      // Tællerne læses EFTER teksten: hooken tæller en tast, før Word får den, så teksten kan aldrig være foran tællerne
      const k = this.keys ? await this.keys.get(r.hwnd) : null;
      if (k !== undefined) r.keys = k;
    }
    delete r.hwnd;
    return r;
  }
  save() { return this.request('save', {}, 30_000); }
  async seal(o) {
    const r = await this.request('seal', { footerLines: (o.footerLines || []).map(String), green: !!o.green, password: String(o.password || ''), path: String(o.path || '') }, 60_000);
    if (r.ok) this._keysStop();
    return r;
  }
  async close(save) {
    const r = await this.request('close', { save: !!save }, 30_000);
    if (r.ok) this._keysStop();
    return r;
  }
  _keysStop() {
    const k = this.keys;
    this.keys = null;
    if (k) { try { k.stop(); } catch (e) { /* */ } }
  }

  stop() {
    this._keysStop();
    const c = this.child;
    this.child = null;
    this.hello = null;
    if (c) { try { c.stdin.end(); } catch (e) { /* */ } try { c.kill(); } catch (e) { /* */ } }
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.resolve({ ok: false, error: 'Word-broen stoppede' }); }
    this.pending.clear();
  }
}

module.exports = { WordBridge, asciiJson, BOOT };
