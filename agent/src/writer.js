'use strict';
/*
 * "Skriv i HolyMoly" – hovedprocessen: skrive-vinduet, lokal kopi af dokumenterne,
 * afsendelse til serveren (kun under en lektion), aflevering og Word-fil (.docx).
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const D = require('./doc.js');

class Writer {
  /** opts: { send(msg) -> bool, lessonActive() -> bool, serverUrl, studentName() -> string } */
  constructor(opts) {
    this.o = opts;
    this.win = null;
    this.pending = new Map(); // dokument-id / 'a:'+opgave-id -> resolve
    this.assignments = [];    // lærerens afleveringer (fra serveren)
    this.docs = this._load();
    this._saveTimer = null;
    this._ipc();
  }

  _file() { return path.join(app.getPath('userData'), 'documents.json'); }
  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this._file(), 'utf8'));
      return Array.isArray(raw.docs) ? raw.docs.slice(0, 200) : [];
    } catch (e) { return []; }
  }
  _persist() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      try {
        fs.mkdirSync(path.dirname(this._file()), { recursive: true });
        const tmp = this._file() + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ docs: this.docs }));
        fs.renameSync(tmp, this._file());
      } catch (e) { /* disken er fuld e.l. – serveren har en kopi */ }
    }, 500);
  }
  _get(id) { return this.docs.find(d => d.id === id); }
  _summary() { return this.docs.map(d => ({ id: d.id, title: d.title, submitted: d.submitted || 0, certId: d.result && d.result.certId, assignmentId: d.assignmentId || 0 })); }

  /** Åbner skrive-vinduet med listen over afleveringer. */
  openAssignments() {
    const show = () => { if (this.win && !this.win.isDestroyed()) this.win.webContents.send('write:show-assignments'); };
    if (this.win && !this.win.isDestroyed()) { this.open(); show(); return; }
    this.open();
    this.win.webContents.once('did-finish-load', () => setTimeout(show, 200));
  }
  /** Antal afleveringer eleven mangler (til hovedvinduet). */
  openCount() { return this.assignments.filter(a => !a.submission).length; }

  open() {
    if (this.win && !this.win.isDestroyed()) { this.win.show(); this.win.focus(); return; }
    this.win = new BrowserWindow({
      width: 1000, height: 820, minWidth: 560, minHeight: 480, title: 'Skriv i HolyMoly', backgroundColor: '#eef0f3', autoHideMenuBar: true,
      icon: path.join(__dirname, '..', 'assets', 'icon.png'),
      webPreferences: { preload: path.join(__dirname, 'write-preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, devTools: !app.isPackaged, spellcheck: true },
    });
    this.win.removeMenu();
    try { this.win.webContents.session.setSpellCheckerLanguages(['da', 'en-US']); } catch (e) { /* ikke på Mac */ }
    this.win.loadFile(path.join(__dirname, '..', 'renderer', 'write.html'));
    this.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.win.webContents.on('will-navigate', (e) => e.preventDefault());
    this.win.on('closed', () => {
      this.win = null;
      // Skrivevinduet lukket: en skriveøkt uden for timen slutter (så overvåges computeren ikke længere)
      if (this.soloAssignment) { this.o.send({ type: 'write-session', assignmentId: this.soloAssignment, on: false }); this.soloAssignment = 0; }
    });
  }

  /** Lektion startet/slut: skrive-vinduet låses op/ned. */
  lessonChanged(live) {
    live = !!live;
    if (this.live === live) return;
    this.live = live;
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send('write:lesson', live);
  }

  /** Beskeder fra serveren */
  onMessage(msg) {
    if (msg.type === 'doc-saved') {
      // Prøve-vurdering fra serveren: hvorfor beviset vil mangle, hvis eleven afleverer nu (kategorier – aldrig tal)
      const preview = Writer.cleanPreview(msg.preview);
      if (this.win && !this.win.isDestroyed()) this.win.webContents.send('write:saved', { id: String(msg.id || ''), ok: !!msg.ok, error: String(msg.error || ''), preview });
      const d = this._get(String(msg.id || ''));
      if (d && msg.ok) { d.syncedAt = Date.now(); if (preview) d.preview = preview; this._persist(); }
    } else if (msg.type === 'doc-result') {
      const resolve = this.pending.get(String(msg.id || ''));
      if (resolve) { this.pending.delete(String(msg.id)); resolve(msg); }
    } else if (msg.type === 'assignments') {
      this.assignments = (Array.isArray(msg.items) ? msg.items : []).slice(0, 200).map(a => ({
        id: Number(a.id) || 0, className: String(a.className || ''), title: String(a.title || ''), description: String(a.description || ''),
        due: Number(a.due) || 0, home: !!a.home, submission: a.submission ? { docId: String(a.submission.docId || ''), title: String(a.submission.title || ''), submitted: Number(a.submission.submitted) || 0, certified: !!a.submission.certified } : null,
      })).filter(a => a.id);
      if (this.win && !this.win.isDestroyed()) this.win.webContents.send('write:assignments', this.assignments);
      if (this.o.onAssignments) this.o.onAssignments(this.assignments);
    } else if (msg.type === 'write-session-result') {
      const key = 's:' + (Number(msg.assignmentId) || 0);
      const resolve = this.pending.get(key);
      if (resolve) { this.pending.delete(key); resolve({ ok: !!msg.ok, error: String(msg.error || ''), endsAt: Number(msg.endsAt) || 0 }); }
    } else if (msg.type === 'assignment-result') {
      const key = 'a:' + (Number(msg.assignmentId) || 0);
      const resolve = this.pending.get(key);
      if (resolve) { this.pending.delete(key); resolve({ ok: !!msg.ok, error: String(msg.error || '') }); }
    }
  }

  /** { ok, categories: [{ key, text }] } fra serveren – kun tekst, højst 10 punkter. */
  static cleanPreview(p) {
    if (!p || typeof p !== 'object') return null;
    const cats = (Array.isArray(p.categories) ? p.categories : []).slice(0, 10)
      .map(c => ({ key: String((c && c.key) || '').slice(0, 20), text: String((c && c.text) || '').slice(0, 200) })).filter(c => c.key && c.text);
    return { ok: !!p.ok && !cats.length, categories: cats };
  }

  _send(d) {
    if (!this.o.lessonActive()) return false;
    return this.o.send({ type: 'doc', id: d.id, title: d.title, blocks: d.blocks, stats: d.stats });
  }

  _proofUrl(certId) { return certId ? new URL('/bevis/' + certId, this.o.serverUrl).toString() : ''; }

  _ipc() {
    // Mærket (samme tekst som i Word-filen og på tjek-siden – D.label)
    const labels = { base: D.label(), lektion: D.label('lektion'), hjemme: D.label('hjemme') };
    ipcMain.handle('write:state', () => ({ lesson: this.o.lessonActive(), docs: this._summary(), labels }));
    ipcMain.handle('write:assignments', () => this.assignments);
    // Skriveøkt: skriv en aflevering hjemme med HolyMoly aktiv (kun når læreren har tilladt det)
    ipcMain.handle('write:session', async (_e, input) => {
      const aid = Number(input && input.assignmentId) || 0;
      const on = !!(input && input.on);
      const a = this.assignments.find(x => x.id === aid);
      if (on && (!a || !a.home)) return { ok: false, error: 'Afleveringen må ikke skrives uden for timen' };
      const key = 's:' + aid;
      const r = await new Promise((resolve) => {
        this.pending.set(key, resolve);
        if (!this.o.send({ type: 'write-session', assignmentId: aid, on })) { this.pending.delete(key); resolve({ ok: false, error: 'Ingen forbindelse til HolyMoly-serveren' }); }
        setTimeout(() => { if (this.pending.delete(key)) resolve({ ok: false, error: 'Serveren svarede ikke – prøv igen' }); }, 15_000);
      });
      if (r.ok) this.soloAssignment = on ? aid : 0;
      return r;
    });
    // Vedhæft et afsluttet HolyMoly-dokument til en aflevering
    ipcMain.handle('write:attach', async (_e, input) => {
      const aid = Number(input && input.assignmentId) || 0;
      const d = this._get(String(input && input.docId || ''));
      if (!this.assignments.some(a => a.id === aid)) return { ok: false, error: 'Afleveringen findes ikke' };
      if (!d) return { ok: false, error: 'Dokumentet findes ikke' };
      if (!d.submitted) return { ok: false, error: 'Afslut dokumentet først' };
      const key = 'a:' + aid;
      return new Promise((resolve) => {
        this.pending.set(key, resolve);
        if (!this.o.send({ type: 'assignment-attach', assignmentId: aid, docId: d.id })) { this.pending.delete(key); resolve({ ok: false, error: 'Ingen forbindelse til HolyMoly-serveren' }); }
        setTimeout(() => { if (this.pending.delete(key)) resolve({ ok: false, error: 'Serveren svarede ikke – prøv igen' }); }, 15_000);
      });
    });
    ipcMain.handle('write:create', (_e, opts) => {
      const asg = opts && this.assignments.find(a => a.id === Number(opts.assignmentId));
      const d = { id: crypto.randomUUID(), title: asg ? asg.title.slice(0, D.LIMITS.title) : '', blocks: [], stats: {}, created: Date.now(), updated: Date.now(), submitted: 0, result: null, assignmentId: asg ? asg.id : 0 };
      this.docs.unshift(d);
      this._persist();
      return { id: d.id };
    });
    ipcMain.handle('write:load', (_e, id) => {
      const d = this._get(id);
      return d ? JSON.parse(JSON.stringify(d)) : null;
    });
    ipcMain.handle('write:save', (_e, input) => {
      const d = this._get(String(input && input.id || ''));
      if (!d) return { ok: false, error: 'Dokumentet findes ikke' };
      if (d.submitted) return { ok: false, error: 'Dokumentet er afleveret' };
      try { d.blocks = D.validateBlocks(input.blocks); } catch (e) { return { ok: false, error: e.message }; }
      d.title = String(input.title || '').slice(0, D.LIMITS.title);
      d.stats = input.stats && typeof input.stats === 'object' ? input.stats : {};
      d.updated = Date.now();
      this._persist();
      const sent = this._send(d);
      return { ok: true, local: !sent };
    });
    // Aflever. force = eleven har valgt "Aflever alligevel" uden bevis. Uden force låser serveren kun, hvis der er et bevis –
    // ellers svarer den { confirm: true, categories }, og eleven kan skrive videre.
    ipcMain.handle('write:submit', async (_e, input) => {
      const id = String(input && typeof input === 'object' ? input.id || '' : input || '');
      const force = !!(input && typeof input === 'object' && input.force === true);
      const d = this._get(id);
      if (!d) return { ok: false, error: 'Dokumentet findes ikke' };
      if (!this.o.lessonActive()) return { ok: false, error: 'Du kan kun aflevere, mens lektionen er i gang' };
      // Den endelige version følger med afleveringen (så beviset altid gælder præcis det, eleven afleverer)
      const res = await new Promise((resolve) => {
        this.pending.set(id, resolve);
        if (!this.o.send({ type: 'doc-submit', id, title: d.title, blocks: d.blocks, stats: d.stats, force })) { this.pending.delete(id); resolve({ ok: false, error: 'Ingen forbindelse til HolyMoly-serveren' }); }
        setTimeout(() => { if (this.pending.delete(id)) resolve({ ok: false, error: 'Serveren svarede ikke – prøv igen' }); }, 20_000);
      });
      const categories = (Writer.cleanPreview({ categories: res.categories }) || { categories: [] }).categories;
      if (res.ok) {
        d.submitted = Date.now();
        d.result = { certId: res.certId || null, place: String((res.facts && res.facts.place) || ''), categories, reasons: res.reasons || [], notes: res.notes || [] };
        this._persist();
      } else if (res.confirm) {
        d.preview = { ok: false, categories };
        this._persist();
      }
      // Til skrivevinduet: kun kategorier (ingen tempotal)
      return { ok: !!res.ok, error: String(res.error || ''), confirm: !!res.confirm, certId: res.certId || null, already: !!res.already, categories, place: String((res.facts && res.facts.place) || ''), url: this._proofUrl(res.certId) };
    });
    ipcMain.handle('write:docx', async (_e, id) => {
      const d = this._get(id);
      if (!d) return { ok: false, error: 'Dokumentet findes ikke' };
      const certId = d.result && d.result.certId;
      // Mærket i sidefoden (D.label: "Tastet i HolyMoly – intet indsat · i timen/hjemme uden opsyn") når teksten har et bevis.
      // Filen er altid skrivebeskyttet i Word.
      const mark = certId ? { code: 'HM-' + certId.slice(0, 8).toUpperCase(), url: this._proofUrl(certId), place: d.result.place || '' } : null;
      const safe = (d.title || 'Dokument').replace(/[\\/:*?"<>|\u0000-\u001F]/g, '').slice(0, 80) || 'Dokument';
      const r = await dialog.showSaveDialog(this.win || undefined, { title: 'Gem som Word', defaultPath: path.join(app.getPath('documents'), safe + '.docx'), filters: [{ name: 'Word-dokument', extensions: ['docx'] }] });
      if (r.canceled || !r.filePath) return { ok: false };
      try {
        fs.writeFileSync(r.filePath, D.toDocx(d.blocks, { title: d.title, author: this.o.studentName(), mark, readOnly: true }));
        return { ok: true, name: path.basename(r.filePath) };
      } catch (e) { return { ok: false, error: 'Kunne ikke gemme filen' }; }
    });
  }
}

module.exports = { Writer };
