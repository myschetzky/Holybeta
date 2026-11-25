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
const store = require('./store.js');

class Writer {
  /** opts: { send(msg) -> bool, lessonActive() -> bool, serverUrl, studentName() -> string, online() -> bool, lastRecv() -> ms } */
  constructor(opts) {
    this.o = opts;
    this.win = null;
    this.pending = new Map(); // dokument-id / 'a:'+opgave-id -> resolve
    this.assignments = [];    // lærerens afleveringer (fra serveren)
    this.docs = this._load();
    this._saveTimer = null;
    // Elevens egen lampe (my-lamp fra serveren) i skrivevinduets footer
    this.lamp = { color: '', reason: '', home: false, restart: false };
    this._lostSince = 0;
    this._lampSent = '';
    this._lampTimer = setInterval(() => this._pushLamp(), 2000);
    if (this._lampTimer.unref) this._lampTimer.unref();
    this.resuming = false; // en afbrudt skriveøkt er ved at blive genoptaget (skrivevinduet låses ikke imens)
    this.aids = [];           // hjælpemidler fra læreren (lesson.aids): 'ordforslag', 'diktering'
    this.prefs = store.loadWriterPrefs(); // zoom, tekststørrelse og linjeafstand (kun denne computer)
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
  _summary() { return this.docs.map(d => ({ id: d.id, title: d.title, submitted: d.submitted || 0, certId: d.result && d.result.certId, assignmentId: d.assignmentId || 0, words: Writer.words(d.blocks), label: d.result && d.result.certId ? D.label(d.result.place, Writer.markInfo(d.result)) : '' })); }
  static words(blocks) { try { return D.wordCount(D.textOf(blocks || [])); } catch (e) { return 0; } }

  /** Nyt dokument (evt. til en aflevering). Kalderen sender det straks til serveren (this._send). */
  _create(assignmentId, title) {
    const asg = assignmentId ? this.assignments.find(a => a.id === Number(assignmentId)) : null;
    const aid = asg ? asg.id : (Number(assignmentId) || 0);
    const d = { id: crypto.randomUUID(), title: String((asg ? asg.title : title) || '').slice(0, D.LIMITS.title), blocks: [], stats: {}, created: Date.now(), updated: Date.now(), submitted: 0, result: null, assignmentId: aid };
    this.docs.unshift(d);
    this._persist();
    return d;
  }
  /** Elevens kladde til afleveringen (uafleveret) – ellers et nyt dokument til den. */
  _docForAssignment(aid, title) {
    const draft = this.docs.find(x => x.assignmentId === aid && !x.submitted);
    if (draft) return draft;
    const d = this._create(aid, title);
    this._send(d); // serveren ser det tomme dokument straks
    return d;
  }
  /**
   * Åbner afleveringen i skrivevinduet: kladden, hvis eleven har en, ellers et nyt dokument.
   * flash: vinduet åbnes uden at tage fokus fra det, eleven er i gang med, og blinker på proceslinjen.
   */
  openForAssignment(aid, { title = '', flash = false } = {}) {
    aid = Number(aid) || 0;
    if (!aid) return null;
    const d = this._docForAssignment(aid, title);
    if (this.win && !this.win.isDestroyed()) {
      if (flash) { if (!this.win.isVisible()) this.win.showInactive(); this.win.flashFrame(true); } else { this.win.show(); this.win.focus(); }
      this.win.webContents.send('write:open-doc', d.id);
    } else {
      this.pendingOpen = d.id; // vinduet åbner dokumentet, når det er klar (write:state)
      this.open({ inactive: flash });
      if (flash) this.win.flashFrame(true);
    }
    return { id: d.id };
  }
  /**
   * Skrivetime (lesson.write fra serveren): læreren har valgt en opgave. Skrivevinduet åbner den med et banner.
   * null = ingen skrivetime (lektionen er slut, eller det er en almindelig lektion).
   */
  writeLesson(w) {
    const aid = w ? Number(w.assignmentId) || 0 : 0;
    if (aid === (this.writeAsg ? this.writeAsg.assignmentId : 0)) return;
    this.writeAsg = aid ? { assignmentId: aid, title: String(w.title || '').slice(0, 200) } : null;
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send('write:write-lesson', this.writeAsg);
    if (aid) this.openForAssignment(aid, { title: this.writeAsg.title, flash: true });
  }

  /** Åbner skrive-vinduet med listen over afleveringer. */
  openAssignments() {
    const show = () => { if (this.win && !this.win.isDestroyed()) this.win.webContents.send('write:show-assignments'); };
    if (this.win && !this.win.isDestroyed()) { this.open(); show(); return; }
    this.open();
    this.win.webContents.once('did-finish-load', () => setTimeout(show, 200));
  }
  /** Antal afleveringer eleven mangler (til hovedvinduet). */
  openCount() { return this.assignments.filter(a => !a.submission).length; }

  open({ inactive = false } = {}) {
    if (this.win && !this.win.isDestroyed()) { if (!inactive) { this.win.show(); this.win.focus(); } return; }
    this.win = new BrowserWindow({
      show: !inactive,
      width: 1000, height: 820, minWidth: 560, minHeight: 480, title: 'Skriv i HolyMoly', backgroundColor: '#eef0f3', autoHideMenuBar: true,
      icon: path.join(__dirname, '..', 'assets', 'icon.png'),
      webPreferences: { preload: path.join(__dirname, 'write-preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, devTools: !app.isPackaged, spellcheck: true },
    });
    this.win.removeMenu();
    // Skrivetime: vinduet vises uden at stjæle fokus (det blinker på proceslinjen i stedet)
    if (inactive) this.win.once('ready-to-show', () => { if (this.win && !this.win.isDestroyed()) this.win.showInactive(); });
    try { this.win.webContents.session.setSpellCheckerLanguages(['da', 'en-US']); } catch (e) { /* ikke på Mac */ }
    this.win.loadFile(path.join(__dirname, '..', 'renderer', 'write.html'));
    this._assist(this.win.webContents);
    this.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.win.webContents.on('will-navigate', (e) => e.preventDefault());
    this.win.on('closed', () => {
      this.win = null;
      // Skrivevinduet lukket: en skriveøkt uden for timen slutter (så overvåges computeren ikke længere)
      if (this.soloAssignment) { this.o.send({ type: 'write-session', assignmentId: this.soloAssignment, on: false }); this.soloAssignment = 0; }
      this.resuming = false;
      this._lampSent = '';
    });
  }

  /**
   * Lektion startet/slut: skrive-vinduet låses op/ned. Mens en afbrudt skriveøkt genoptages (this.resuming),
   * låses det ikke – en afbrydelse må aldrig låse elevens tekst.
   */
  lessonChanged(live) {
    this._serverLive = !!live;
    live = !!live || this.resuming;
    if (this.live !== live) {
      this.live = live;
      if (this.win && !this.win.isDestroyed()) this.win.webContents.send('write:lesson', live);
    }
    this._pushLamp();
  }

  _winOpen() { return !!(this.win && !this.win.isDestroyed()); }

  /**
   * Appen har forbindelse igen ('welcome'): har eleven en skriveøkt og skrivevinduet åbent, fortsættes økten af sig selv
   * (resume – samme økt, kun fra samme computer og kort efter afbrydelsen). Kan den ikke fortsættes, startes en ny.
   */
  _resumeSolo() {
    const aid = this.soloAssignment;
    if (!aid || !this._winOpen()) return;
    this.resuming = true;
    // Forsvinder forbindelsen igen før svaret, sendes resume igen ved næste 'welcome' (vinduet forbliver åbent for skrivning)
    if (!this.o.send({ type: 'write-session', assignmentId: aid, on: true, resume: true })) this.resuming = false;
  }
  _resumeResult(msg) {
    const aid = Number(msg.assignmentId) || 0;
    if (!this.resuming || aid !== this.soloAssignment) return;
    if (msg.ok) { this.resuming = false; this.lessonChanged(this._serverLive); return; }
    if (msg.resume) {
      // Økten kunne ikke fortsættes (fx for længe væk): prøv en ny skriveøkt til samme aflevering
      if (this.o.send({ type: 'write-session', assignmentId: aid, on: true })) return;
    }
    this.resuming = false;
    this.soloAssignment = 0;
    if (this._winOpen()) this.win.webContents.send('write:session-ended', String(msg.error || 'Skriveøkten er slut'));
    this.lessonChanged(this._serverLive);
  }

  /**
   * Hvad lampen i skrivevinduets footer viser. s: { live, color, reason, home, restart, online, lastRecv, lostSince }.
   * Returnerer null uden lektion/skriveøkt, ellers { color, symbol, text, homeNote, lost, banner }.
   */
  static lampView(s, now = Date.now()) {
    if (!s || !s.live) return null;
    const homeNote = s.home ? 'Hjemme ser din lærer kun farven.' : '';
    const clean = (t) => String(t || '').trim().replace(/[.…\s]+$/u, '').slice(0, 160);
    const lost = !!s.restart || !s.online || !(now - (Number(s.lastRecv) || 0) <= 15_000);
    const out = (color, symbol, text) => ({ color, symbol, text, homeNote, lost, banner: lost && !!s.lostSince && now - s.lostSince >= 60_000 });
    const later = 'Skriv videre – teksten gemmes på computeren.';
    if (s.restart) return out('grey', '?', 'HolyMoly-serveren genstarter. Skriv bare videre – teksten gemmes på computeren.');
    if (lost) return out('grey', '?', `Grå: Ingen forbindelse til HolyMoly. ${later}`);
    if (s.color === 'green') return out('green', '✓', 'Grøn – skriveforløbet følges.');
    if (s.color === 'red') return out('red', '!', `Rød: ${clean(s.reason) || 'Et forbudt program'} åben. Luk det. Dette dokument kan ikke få mærket for tiden med rødt.`);
    return out('grey', '?', `Grå: ${clean(s.reason) || 'Venter på HolyMoly'}. ${later}`);
  }
  _lampState(now = Date.now()) {
    const online = this.o.online ? !!this.o.online() : true;
    const lastRecv = this.o.lastRecv ? Number(this.o.lastRecv()) || 0 : now;
    const s = Object.assign({}, this.lamp, { live: !!this.live, online, lastRecv, home: this.lamp.color ? this.lamp.home : !!this.soloAssignment });
    const lost = s.restart || !online || !(now - lastRecv <= 15_000);
    if (!lost || !s.live) this._lostSince = 0;
    else if (!this._lostSince) this._lostSince = now;
    s.lostSince = this._lostSince;
    return s;
  }
  /** Sender lampen til skrivevinduet, når den har ændret sig (kaldes også hvert 2. sek., så den bliver grå uden forbindelse). */
  _pushLamp(now = Date.now()) {
    const v = Writer.lampView(this._lampState(now), now);
    const key = JSON.stringify(v);
    if (key === this._lampSent || !this._winOpen()) return v;
    this._lampSent = key;
    this.win.webContents.send('write:lamp', v);
    return v;
  }

  /** Beskeder fra serveren */
  onMessage(msg) {
    if (msg.type === 'my-lamp') {
      const color = msg.color === 'green' || msg.color === 'red' ? msg.color : 'grey';
      this.lamp = { color, reason: String(msg.reason || '').slice(0, 160), home: !!msg.home, restart: false };
      this._pushLamp();
    } else if (msg.type === 'server-restart') {
      this.lamp = Object.assign({}, this.lamp, { restart: true });
      this._pushLamp();
    } else if (msg.type === 'welcome') {
      // Forbundet (igen): lampen venter på serverens næste my-lamp, og en afbrudt skriveøkt fortsættes
      this.lamp = { color: '', reason: '', home: this.lamp.home, restart: false };
      this._resumeSolo();
      this._pushLamp();
    } else if (msg.type === 'doc-saved') {
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
    } else if (msg.type === 'write-session-result' && this.resuming && !this.pending.has('s:' + (Number(msg.assignmentId) || 0))) {
      this._resumeResult(msg);
    } else if (msg.type === 'write-session-result') {
      const key = 's:' + (Number(msg.assignmentId) || 0);
      const resolve = this.pending.get(key);
      if (resolve) { this.pending.delete(key); resolve({ ok: !!msg.ok, error: String(msg.error || ''), endsAt: Number(msg.endsAt) || 0 }); }
    } else if (msg.type === 'doc-deleted') {
      const key = 'd:' + String(msg.id || '');
      const resolve = this.pending.get(key);
      if (resolve) { this.pending.delete(key); resolve({ ok: !!msg.ok, error: String(msg.error || '') }); }
    } else if (msg.type === 'assignment-result') {
      const key = 'a:' + (Number(msg.assignmentId) || 0);
      const resolve = this.pending.get(key);
      if (resolve) { this.pending.delete(key); resolve({ ok: !!msg.ok, error: String(msg.error || '') }); }
    }
  }

  /**
   * { ok, categories: [{ key, text, fixable, need?, label?, at? }] } fra serveren – højst 10 punkter.
   * fixable: kan rettes ved at skrive videre (kun 'kort'). need: ord der kræves. label/at: hvad og hvornår (permanente kategorier).
   */
  static cleanPreview(p) {
    if (!p || typeof p !== 'object') return null;
    const cats = (Array.isArray(p.categories) ? p.categories : []).slice(0, 10).map((c) => {
      const out = { key: String((c && c.key) || '').slice(0, 20), text: String((c && c.text) || '').slice(0, 200) };
      out.fixable = c && typeof c.fixable === 'boolean' ? c.fixable : out.key === 'kort'; // ældre server: kun 'kort'
      if (c && Number(c.need) > 0) out.need = Math.min(10_000, Math.round(Number(c.need)));
      if (c && c.label) out.label = String(c.label).slice(0, 40);
      if (c && Number(c.at) > 0) out.at = Number(c.at);
      return out;
    }).filter(c => c.key && c.text);
    return { ok: !!p.ok && !cats.length, categories: cats };
  }

  /* ---------- hjælpemidler og visning (stavekontrol, zoom, tastatur) ---------- */

  /** Hjælpemidler fra læreren (lesson-beskeden). Skrivevinduet tillader ordforslag og diktering. */
  setAids(list) {
    const aids = D.cleanAids(list);
    if (aids.join() === this.aids.join()) return;
    this.aids = aids;
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send('write:aids', aids);
  }

  /**
   * Stavekontrol i højreklik-menuen (forslag, "Tilføj til ordbogen", Klip og Kopiér – aldrig Indsæt) og zoom med Ctrl +/-/0.
   * Et valgt forslag erstatter ordet i Chromium (insertReplacementText) og tæller som tastet i skrivevinduet.
   */
  _assist(wc) {
    wc.on('context-menu', (_e, params) => {
      const { Menu } = require('electron');
      if (!Menu || !params || (!params.isEditable && !params.selectionText)) return;
      const tpl = [];
      if (params.isEditable && params.misspelledWord) {
        const sug = (params.dictionarySuggestions || []).slice(0, 6);
        for (const w of sug) tpl.push({ label: w, click: () => wc.replaceMisspelling(w) });
        if (!sug.length) tpl.push({ label: 'Ingen forslag', enabled: false });
        tpl.push({ label: `Tilføj "${params.misspelledWord}" til ordbogen`, click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord) });
        tpl.push({ type: 'separator' });
      }
      const f = params.editFlags || {};
      if (params.isEditable) tpl.push({ label: 'Klip', role: 'cut', enabled: !!f.canCut });
      tpl.push({ label: 'Kopiér', role: 'copy', enabled: !!f.canCopy });
      Menu.buildFromTemplate(tpl).popup({ window: this.win || undefined });
    });
    wc.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return;
      const k = input.key;
      let zoom = this.prefs.zoom;
      if (k === '+' || k === '=' || k === 'Add') zoom += 0.5;
      else if (k === '-' || k === 'Subtract') zoom -= 0.5;
      else if (k === '0') zoom = 0;
      else return;
      e.preventDefault();
      this.setPrefs({ zoom });
    });
    wc.on('did-finish-load', () => { try { wc.setZoomLevel(this.prefs.zoom); } catch (err) { /* */ } });
  }

  /** Gem visningen (zoom -1..3, tekststørrelse 14-24 px, linjeafstand) og brug den med det samme. */
  setPrefs(p) {
    this.prefs = store.saveWriterPrefs(p);
    if (this.win && !this.win.isDestroyed()) {
      try { this.win.webContents.setZoomLevel(this.prefs.zoom); } catch (err) { /* */ }
      this.win.webContents.send('write:prefs', this.prefs);
    }
    return this.prefs;
  }

  /** Hvad beviset siger om målingen (v3): { observed, test }. Ældre beviser har ingen observed. */
  static markInfo(r) {
    const out = {};
    if (r && Array.isArray(r.observed)) out.observed = r.observed.map(String).filter(x => x === 'skrivevindue' || x === 'vagt');
    if (r && r.test) out.test = true;
    return out;
  }

  _send(d) {
    // Øvedokumentet forlader aldrig computeren (det ligger kun i skrivevinduets hukommelse – dette er et ekstra værn)
    if (!d || d.practice) return false;
    if (!this.o.lessonActive()) return false;
    return this.o.send({ type: 'doc', id: d.id, title: d.title, blocks: d.blocks, stats: d.stats });
  }

  _proofUrl(certId) { return certId ? new URL('/bevis/' + certId, this.o.serverUrl).toString() : ''; }

  _ipc() {
    // Mærket (samme tekst som i Word-filen og på tjek-siden – D.label)
    const labels = { base: D.label(), lektion: D.label('lektion'), hjemme: D.label('hjemme') };
    ipcMain.handle('write:state', () => {
      const openId = this.pendingOpen || '';
      this.pendingOpen = '';
      this._lampSent = ''; // vinduet er (gen)indlæst: lampen sendes igen
      setTimeout(() => this._pushLamp(), 0);
      return { lesson: this.o.lessonActive() || this.resuming, docs: this._summary(), labels, writeLesson: this.writeAsg || null, openId, aids: this.aids, prefs: this.prefs };
    });
    // "Fortsæt kladde" / "Skriv besvarelse": kladden til afleveringen, ellers et nyt dokument
    ipcMain.handle('write:open-for', (_e, aid) => {
      aid = Number(aid) || 0;
      if (!this.assignments.some(a => a.id === aid)) return { ok: false, error: 'Afleveringen findes ikke' };
      return { ok: true, id: this._docForAssignment(aid).id };
    });
    ipcMain.handle('write:assignments', () => this.assignments);
    // Visning: tekststørrelse og linjeafstand (zoom styres med Ctrl +/-/0 i _assist)
    ipcMain.handle('write:prefs', (_e, p) => {
      const out = {};
      if (p && Number(p.size) > 0) out.size = Number(p.size);
      if (p && (p.lh === 'normal' || p.lh === 'luftig')) out.lh = p.lh;
      return this.setPrefs(out);
    });
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
      // Kun lærerens egne afleveringer kan vælges herfra (ukendt id = et almindeligt dokument)
      const asg = opts && this.assignments.find(a => a.id === Number(opts.assignmentId));
      // Serveren ser dokumentet straks (tomt), så den kan følge det fra første tegn (et nyt dokument må højst have 150 tegn første gang)
      const d = this._create(asg ? asg.id : 0);
      this._send(d);
      return { id: d.id };
    });
    // Slet en kladde: først hos serveren, derefter på computeren. Afsluttede dokumenter kan ikke slettes.
    ipcMain.handle('write:delete', async (_e, id) => {
      const d = this._get(String(id || ''));
      if (!d) return { ok: false, error: 'Dokumentet findes ikke' };
      if (d.submitted) return { ok: false, error: 'Et afsluttet dokument kan ikke slettes' };
      const key = 'd:' + d.id;
      const r = await new Promise((resolve) => {
        this.pending.set(key, resolve);
        if (!this.o.send({ type: 'doc-delete', id: d.id })) { this.pending.delete(key); resolve({ ok: false, error: 'Ingen forbindelse til HolyMoly-serveren. Prøv igen senere.' }); }
        setTimeout(() => { if (this.pending.delete(key)) resolve({ ok: false, error: 'Serveren svarede ikke – prøv igen' }); }, 15_000);
      });
      if (!r.ok) return r;
      this.docs = this.docs.filter(x => x.id !== d.id);
      this._persist();
      return { ok: true };
    });
    ipcMain.handle('write:load', (_e, id) => {
      const d = this._get(id);
      if (!d) return null;
      const out = JSON.parse(JSON.stringify(d));
      // Mærket, som det står i Word-filen (med "kun skrivevinduet" og "TESTSERVER", når det gælder)
      if (out.result && out.result.certId) out.result.label = D.label(out.result.place, Writer.markInfo(out.result));
      return out;
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
    // Aflever. force = eleven har valgt "Aflever uden mærke". Uden force låser serveren kun, hvis der er et bevis –
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
        if (!this.o.send({ type: 'doc-submit', id, title: d.title, blocks: d.blocks, stats: d.stats, force, assignmentId: d.assignmentId || 0 })) { this.pending.delete(id); resolve({ ok: false, error: 'Ingen forbindelse til HolyMoly-serveren' }); }
        setTimeout(() => { if (this.pending.delete(id)) resolve({ ok: false, error: 'Serveren svarede ikke – prøv igen' }); }, 20_000);
      });
      const categories = (Writer.cleanPreview({ categories: res.categories }) || { categories: [] }).categories;
      if (res.ok) {
        d.submitted = Date.now();
        d.result = Object.assign({ certId: res.certId || null, place: String((res.facts && res.facts.place) || ''), categories, reasons: res.reasons || [], notes: res.notes || [] }, Writer.markInfo(res));
        this._persist();
      } else if (res.confirm) {
        d.preview = { ok: false, categories };
        this._persist();
      }
      // Til skrivevinduet: kun kategorier (ingen tempotal)
      const place = String((res.facts && res.facts.place) || '');
      return { ok: !!res.ok, error: String(res.error || ''), confirm: !!res.confirm, certId: res.certId || null, already: !!res.already, categories, place, label: D.label(place, Writer.markInfo(res)), url: this._proofUrl(res.certId) };
    });
    ipcMain.handle('write:docx', async (_e, id) => {
      const d = this._get(id);
      if (!d) return { ok: false, error: 'Dokumentet findes ikke' };
      const certId = d.result && d.result.certId;
      // Mærket i sidefoden (D.label: "Tastet i HolyMoly – intet indsat · i timen/hjemme", evt. "· kun skrivevinduet" og "· TESTSERVER")
      // når teksten har et bevis. Uden vagt eller fra en testserver er mærket gråt. Filen er altid skrivebeskyttet i Word.
      const mark = certId ? Object.assign({ code: 'HM-' + certId.slice(0, 8).toUpperCase(), url: this._proofUrl(certId), place: d.result.place || '' }, Writer.markInfo(d.result)) : null;
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
