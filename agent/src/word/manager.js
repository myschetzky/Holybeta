'use strict';
/*
 * "Skriv i Word" – økten: Word-broen, tekst-tjekket, rammen med muldvarpen, serveren og "Tekst færdig".
 *
 * Flow:
 *  1. start(): Word åbner et nyt (eller elevens påbegyndte) dokument i Dokumenter/HolyMoly. Serveren ser det tomme dokument straks.
 *  2. Hvert sekund: bridge.state() -> WordCheck (skiltet) -> rammen følger Word-vinduet. Ændret tekst sendes til serveren
 *     som en almindelig 'doc'-gemning med source: 'word' (højst hver 2,5 sek.). Hvert 500 ms: udklipsholderen.
 *  3. "Tekst færdig": Word gemmer -> teksten læses fra den gemte .docx -> 'doc-submit' (serveren vurderer og udsteder beviset).
 *     Gyldig: Word forsegler (sidefod + læsebeskyttelse) til "{titel} – forseglet.docx", som tjekkes mod beviset, og
 *     dokumentet står i Min HolyMoly. Ikke gyldig: årsagerne og valget "Skriv videre" / "Gem uden mærke".
 *
 * Ingen Electron her: alt udefra gives som opts, så hele forløbet kan testes med bridge-fake.js.
 *   opts: { bridge, overlay, clipboard, send(msg) -> bool, lessonActive() -> bool, online() -> bool, serverUrl, dir, dataDir,
 *           showInFolder(p), onChange(), onOpenMine(), autoTick (standard true), saveEveryMs, now() }
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const D = require('../doc.js');
const { WordCheck, wordTextToBlocks, wordText } = require('./session.js');
const { ClipboardGuard } = require('./clipboard.js');
const S = require('./seal.js');

const SAVE_EVERY_MS = 2500;      // højst så ofte sendes teksten til serveren
const WORD_SAVE_EVERY_MS = 60_000; // Word gemmer selv dokumentet hvert minut, hvis det er ændret
const hhmm = (t) => new Date(t).toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' }).replace(':', '.');

class WordManager {
  constructor(opts) {
    this.o = opts;
    this.now = opts.now || Date.now;
    this.bridge = opts.bridge;
    this.overlay = opts.overlay || { update() {}, hide() {}, destroy() {}, focused: () => false };
    this.assignments = [];
    this.docs = this._load();
    this.s = null;              // den åbne økt
    this.pending = new Map();   // 'doc:'+id / 'a:'+opgave / 's:'+opgave -> resolve
    this.panel = null;          // boks i rammen (resultat eller valg)
    this._info = null;
  }

  /* ---------------------------------------------------------------- registret (Min HolyMoly) ---------------------------------------------------------------- */
  _file() { return path.join(this.o.dataDir, 'word-documents.json'); }
  _load() {
    try { const raw = JSON.parse(fs.readFileSync(this._file(), 'utf8')); return Array.isArray(raw.docs) ? raw.docs.slice(0, 500) : []; } catch (e) { return []; }
  }
  _persist() {
    try {
      fs.mkdirSync(path.dirname(this._file()), { recursive: true });
      fs.writeFileSync(this._file() + '.tmp', JSON.stringify({ docs: this.docs }));
      fs.renameSync(this._file() + '.tmp', this._file());
    } catch (e) { /* disken er fuld e.l. */ }
    if (this.o.onChange) this.o.onChange();
  }
  get(id) { return this.docs.find(d => d.id === id) || null; }
  /** Til Min HolyMoly: Word-dokumenterne uden teksten. */
  list() {
    return this.docs.map(d => ({ id: d.id, title: d.title, path: d.path, sealedPath: d.sealedPath || '', assignmentId: d.assignmentId || 0, created: d.created, updated: d.updated, submitted: d.submitted || 0, certId: (d.result && d.result.certId) || null, label: d.result && d.result.certId ? D.label(d.result.place, WordManager.markInfo(d.result)) : '', verified: !!d.verified, sealError: d.sealError || '', words: d.words || 0, open: !!(this.s && this.s.id === d.id) }));
  }
  static markInfo(r) {
    const out = {};
    if (r && Array.isArray(r.observed)) out.observed = r.observed.map(String).filter(x => x === 'word' || x === 'vagt');
    if (r && r.test) out.test = true;
    return out;
  }

  /** Kan "Skriv i Word" bruges her? { supported, word } (startes én gang, Word startes ikke) */
  async info() {
    if (!this._info) this._info = this.bridge.probe().catch(() => ({ supported: false, word: false }));
    const r = await this._info;
    return { supported: !!r.supported, word: !!r.word, available: !!(r.supported && r.word) };
  }

  /* ---------------------------------------------------------------- serveren ---------------------------------------------------------------- */
  _ask(key, msg, ms = 15_000) {
    return new Promise((resolve) => {
      this.pending.set(key, resolve);
      if (!this.o.send(msg)) { this.pending.delete(key); resolve({ ok: false, error: 'Ingen forbindelse til HolyMoly-serveren' }); return; }
      const t = setTimeout(() => { if (this.pending.delete(key)) resolve({ ok: false, error: 'Serveren svarede ikke – prøv igen' }); }, ms);
      if (t.unref) t.unref();
    });
  }
  _resolve(key, v) { const r = this.pending.get(key); if (r) { this.pending.delete(key); r(v); } }

  onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'assignments') {
      this.assignments = (Array.isArray(msg.items) ? msg.items : []).slice(0, 200).map(a => ({ id: Number(a.id) || 0, title: String(a.title || ''), className: String(a.className || ''), due: Number(a.due) || 0, home: !!a.home, submission: a.submission ? { docId: String(a.submission.docId || ''), title: String(a.submission.title || ''), certified: !!a.submission.certified } : null })).filter(a => a.id);
      if (this.o.onChange) this.o.onChange();
    } else if (msg.type === 'my-lamp') {
      const color = msg.color === 'green' || msg.color === 'red' ? msg.color : 'grey';
      if (this.s) { this.s.check.server({ lamp: { color, reason: String(msg.reason || '') } }); this._render(); }
      this.lamp = { color, reason: String(msg.reason || '') };
    } else if (msg.type === 'welcome') {
      this.lamp = null;
      if (this.s) {
        this.s.check.server({ lamp: null });
        // Forbundet igen under en skriveøkt hjemme: fortsæt økten (samme som skrivevinduet)
        if (this.s.solo) this.o.send({ type: 'write-session', assignmentId: this.s.solo, on: true, resume: true });
      }
    } else if (msg.type === 'doc-saved' && this.s && String(msg.id) === this.s.id) {
      if (msg.ok) {
        this.s.synced = this.s.sending;
        const d = this.get(this.s.id);
        if (d) { d.lastText = this.s.synced; d.updated = this.now(); d.words = D.wordCount(this.s.synced); this._persist(); }
        if (msg.preview && typeof msg.preview === 'object') this.s.check.server({ preview: { ok: !!msg.preview.ok, categories: (Array.isArray(msg.preview.categories) ? msg.preview.categories : []).slice(0, 10).map(c => ({ key: String((c && c.key) || ''), text: String((c && c.text) || '') })) } });
      } else if (msg.error && msg.error !== 'busy') this.s.saveError = String(msg.error).slice(0, 200);
      this.s.sending = null;
      this._render();
    } else if (msg.type === 'doc-result') {
      this._resolve('doc:' + String(msg.id || ''), msg);
    } else if (msg.type === 'assignment-result') {
      this._resolve('a:' + (Number(msg.assignmentId) || 0), { ok: !!msg.ok, error: String(msg.error || '') });
    } else if (msg.type === 'write-session-result') {
      this._resolve('s:' + (Number(msg.assignmentId) || 0), { ok: !!msg.ok, error: String(msg.error || ''), endsAt: Number(msg.endsAt) || 0 });
    }
  }

  /** Lektion/forbindelse ændret (main.js). */
  lessonChanged() { if (this.s) this._render(); }

  /* ---------------------------------------------------------------- økten ---------------------------------------------------------------- */
  /**
   * Skriv i Word. input: { assignmentId, docId } – docId fortsætter et påbegyndt Word-dokument.
   * Returnerer { ok, error?, id }.
   */
  async start(input = {}) {
    const inf = await this.info();
    if (!inf.supported) return { ok: false, error: 'Skriv i Word findes kun på Windows' };
    if (!inf.word) return { ok: false, error: 'Word findes ikke på computeren' };
    if (this.s) return { ok: false, error: 'Du har allerede et Word-dokument åbent i HolyMoly. Tryk "Tekst færdig" eller luk det først.' };
    const aid = Number(input.assignmentId) || 0;
    const asg = aid ? this.assignments.find(a => a.id === aid) : null;
    if (aid && !asg) return { ok: false, error: 'Afleveringen findes ikke' };
    let d = input.docId ? this.get(String(input.docId)) : asg ? this.docs.find(x => x.assignmentId === aid && !x.submitted) : null;
    if (input.docId && (!d || d.submitted)) return { ok: false, error: 'Dokumentet kan ikke fortsættes' };
    // Uden lektion: kun en aflevering, der må skrives hjemme (skriveøkt – kun mens Word-økten er åben)
    let solo = 0;
    if (!this.o.lessonActive()) {
      const a = asg || (d && d.assignmentId ? this.assignments.find(x => x.id === d.assignmentId) : null);
      if (!a || !a.home) return { ok: false, error: 'Skriv i Word kan kun bruges, mens en lektion er i gang – eller til en aflevering, der må skrives hjemme.' };
      if (a.due && this.now() > a.due) return { ok: false, error: 'Fristen er overskredet' };
      const r = await this._ask('s:' + a.id, { type: 'write-session', assignmentId: a.id, on: true });
      if (!r.ok) return { ok: false, error: r.error || 'Kunne ikke starte skriveøkten' };
      solo = a.id;
    }
    const fail = (error) => { if (solo) this.o.send({ type: 'write-session', assignmentId: solo, on: false }); return { ok: false, error }; };
    try { fs.mkdirSync(this.o.dir, { recursive: true }); } catch (e) { return fail('Kunne ikke oprette mappen ' + this.o.dir); }
    let created = false;
    if (!d) {
      const title = asg ? asg.title : 'Dokument ' + new Date(this.now()).toLocaleDateString('da-DK');
      d = { id: crypto.randomUUID(), title: String(title).slice(0, D.LIMITS.title), path: S.paths(this.o.dir, title).draft, assignmentId: aid, created: this.now(), updated: this.now(), submitted: 0, result: null, lastText: '', words: 0 };
      created = true;
    } else if (!fs.existsSync(d.path)) return fail('Word-filen findes ikke længere: ' + path.basename(d.path));
    const op = await this.bridge.open(d.path, created);
    if (!op.ok) return fail('Word kunne ikke åbne dokumentet: ' + (op.error || 'ukendt fejl'));
    if (created) { this.docs.unshift(d); this._persist(); }
    const check = new WordCheck();
    check.server({ live: !!this.o.lessonActive() || !!solo, online: this.o.online ? !!this.o.online() : true, lamp: this.lamp || null });
    this.s = { id: d.id, check, solo, sending: null, synced: created ? null : d.lastText, lastSend: 0, lastWordSave: this.now(), savedAt: this.now(), lastState: null, started: false };
    this.s.clip = new ClipboardGuard({ clipboard: this.o.clipboard || { readText: () => '', availableFormats: () => [], clear() {} }, knows: (t) => check.knows(t), onClear: () => { check.clipboardCleared(); this._render(); } });
    this.panel = null;
    // Serveren ser det tomme dokument straks (et nyt dokument må højst have 150 tegn første gang)
    if (created) this._sendDoc('');
    await this.tick();
    if (this.o.autoTick !== false) {
      this.s.timer = setInterval(() => this.tick(), 1000);
      this.s.clipTimer = setInterval(() => this.clipTick(), 500);
    }
    this._persist();
    return { ok: true, id: d.id };
  }

  _sendDoc(text, raw) {
    const d = this.get(this.s.id);
    const blocks = raw != null ? wordTextToBlocks(raw) : [];
    this.s.sending = text;
    this.s.lastSend = this.now();
    return this.o.send({ type: 'doc', id: d.id, title: d.title, blocks, stats: this.s.check.stats(), source: 'word' });
  }

  /** Én måling (hvert sekund). */
  async tick() {
    const s = this.s;
    if (!s || s.busy) return;
    s.busy = true;
    let st;
    try { st = await this.bridge.state(); } finally { s.busy = false; }
    if (this.s !== s) return;
    const now = this.now();
    s.check.server({ live: !!this.o.lessonActive() || !!s.solo, online: this.o.online ? !!this.o.online() : true });
    if (!st.ok) { s.check.snapshot({ t: now, error: st.error || 'Word svarer ikke' }); this._render(); return; }
    if (!st.open) { this._ended('Word-dokumentet er lukket. Det står i Min HolyMoly, hvor du kan fortsætte.'); return; }
    s.lastState = st;
    if (!s.started) { s.started = true; s.check.start(st.text, now, s.synced == null ? null : s.synced); }
    s.check.snapshot({ t: now, text: st.text, copilot: st.copilot, foreground: st.foreground });
    if (st.saved && s.wasSaved === false) s.savedAt = now;
    s.wasSaved = !!st.saved;
    // Til serveren: ændret tekst højst hver 2,5 sek. (serveren har sit eget vækstbudget)
    const text = wordText(st.text);
    if (text !== s.synced && s.sending == null && now - s.lastSend >= (this.o.saveEveryMs || SAVE_EVERY_MS) && this.o.lessonActive()) this._sendDoc(text, st.text);
    else if (s.sending != null && now - s.lastSend > 15_000) s.sending = null; // intet svar: prøv igen
    // Word gemmer selv hvert minut, hvis dokumentet er ændret
    if (!st.saved && now - s.lastWordSave >= WORD_SAVE_EVERY_MS) {
      s.lastWordSave = now;
      const r = await this.bridge.save();
      if (r.ok && this.s === s) { s.savedAt = this.now(); s.wasSaved = true; }
    }
    this._render();
  }

  /** Udklipsholderen (hvert 500 ms). */
  clipTick() {
    const s = this.s;
    if (!s || !s.lastState) return false;
    const fg = !!s.lastState.foreground || !!(this.overlay.focused && this.overlay.focused());
    return s.clip.tick({ wordForeground: fg });
  }

  /** Hvad rammen viser. */
  view() {
    const s = this.s;
    const d = s ? this.get(s.id) : null;
    const st = s && s.lastState;
    const visible = !!(this.panel || (st && st.open && !st.minimized && st.rect && (st.foreground || (this.overlay.focused && this.overlay.focused()))));
    return {
      visible,
      rect: st && st.rect ? st.rect : this._lastRect || null,
      status: s ? s.check.status() : null,
      bar: d ? { title: d.title, saved: s && s.savedAt ? 'Gemt kl. ' + hhmm(s.savedAt) : '', error: s.saveError || '' } : null,
      panel: this.panel,
      busy: !!(s && s.finishing),
    };
  }
  _render() {
    const v = this.view();
    if (v.rect) this._lastRect = v.rect;
    this.overlay.update(v);
    return v;
  }

  /** Økten slutter (Word lukket, forseglet eller gemt uden mærke). Word lukkes ikke af HolyMoly. */
  _ended(note) {
    const s = this.s;
    if (!s) return;
    clearInterval(s.timer); clearInterval(s.clipTimer);
    this.s = null;
    if (s.solo) this.o.send({ type: 'write-session', assignmentId: s.solo, on: false });
    if (note && !this.panel) this.panel = { kind: 'info', title: 'Word-økten er slut', text: note, actions: [{ id: 'mine', label: 'Min HolyMoly' }, { id: 'close', label: 'Luk', primary: true }] };
    if (!this.panel) this.overlay.hide(); else this._render();
    if (this.o.onChange) this.o.onChange();
  }

  /* ---------------------------------------------------------------- Tekst færdig ---------------------------------------------------------------- */
  /** Gem via Word, lad serveren vurdere, og forsegl, hvis teksten er gyldig. force: "Gem uden mærke". */
  async finish(force = false) {
    const s = this.s;
    if (!s || s.finishing) return { ok: false, error: 'Intet Word-dokument er åbent' };
    s.finishing = true;
    this.panel = { kind: 'busy', title: 'Tekst færdig', text: 'Word gemmer dokumentet …', actions: [] };
    this._render();
    try {
      return await this._finish(s, force);
    } finally {
      s.finishing = false;
      if (this.s === s) this._render();
    }
  }
  async _finish(s, force) {
    const d = this.get(s.id);
    this.lastId = d.id;
    const problem = (text) => { this.panel = { kind: 'error', title: 'Tekst færdig', text, actions: [{ id: 'continue', label: 'Skriv videre', primary: true }] }; return { ok: false, error: text }; };
    if (!this.o.lessonActive() && !s.solo) return problem('Tekst færdig kræver, at lektionen eller skriveøkten er i gang. Dokumentet er gemt i Word.');
    const sv = await this.bridge.save();
    if (!sv.ok) return problem('Word kunne ikke gemme dokumentet: ' + (sv.error || 'ukendt fejl'));
    s.savedAt = this.now(); s.wasSaved = true;
    // Teksten læses fra den gemte fil – det er den, tjek-siden læser i den forseglede fil
    let blocks;
    try { blocks = await S.docxBlocks(fs.readFileSync(d.path)); } catch (e) {
      const st = await this.bridge.state();
      blocks = st.ok && st.open ? wordTextToBlocks(st.text) : null;
    }
    if (!blocks) return problem('HolyMoly kunne ikke læse dokumentet.');
    const text = S.textOfBlocks(blocks);
    this.panel = { kind: 'busy', title: 'Tekst færdig', text: 'HolyMoly tjekker teksten …', actions: [] };
    this._render();
    const res = await this._ask('doc:' + d.id, { type: 'doc-submit', id: d.id, title: d.title, blocks, stats: s.check.stats(), source: 'word', force: !!force, assignmentId: d.assignmentId || 0 }, 20_000);
    if (res.confirm) {
      const cats = (Array.isArray(res.categories) ? res.categories : []).map(c => String((c && c.text) || '')).filter(Boolean).slice(0, 10);
      this.panel = { kind: 'confirm', title: 'Teksten kan ikke få mærket', text: 'Beviset vil mangle, fordi:', items: cats, note: 'Skriver du videre, kan du stadig nå at få mærket. Gemmer du uden mærke, kan teksten ikke længere ændres i HolyMoly.', actions: [{ id: 'continue', label: 'Skriv videre', primary: true }, { id: 'nomark', label: 'Gem uden mærke' }] };
      return { ok: false, confirm: true, categories: cats };
    }
    if (!res.ok) return problem(String(res.error || 'Serveren kunne ikke tage imod teksten'));
    d.submitted = this.now();
    d.updated = this.now();
    d.words = D.wordCount(text);
    d.lastText = text;
    d.result = Object.assign({ certId: res.certId || null, place: String((res.facts && res.facts.place) || '') }, WordManager.markInfo(res));
    this._persist();
    let out;
    if (res.certId) {
      // Gyldig: Word forsegler (sidefod med mærket, koden og tjek-linket + læsebeskyttelse)
      const url = new URL('/bevis/' + res.certId, this.o.serverUrl).toString();
      const foot = S.footerFor(res, url, d.words);
      const sealedPath = S.freePath(path.dirname(d.path), S.safeName(d.title) + ' – forseglet');
      const r = await this.bridge.seal({ footerLines: foot.lines, green: foot.green, password: crypto.randomBytes(18).toString('base64url'), path: sealedPath });
      if (!r.ok) {
        d.sealError = 'Word kunne ikke forsegle dokumentet: ' + (r.error || 'ukendt fejl');
        this._persist();
        this.panel = { kind: 'warn', title: 'Teksten er gyldig', text: `Beviset er udstedt (${S.codeOf(res.certId)}), men ${d.sealError.charAt(0).toLowerCase() + d.sealError.slice(1)}. Dokumentet står i Min HolyMoly. Beviset kan tjekkes på ${url}`, actions: [{ id: 'mine', label: 'Min HolyMoly' }, { id: 'close', label: 'Luk', primary: true }] };
        out = { ok: true, certId: res.certId, sealed: false };
      } else {
        d.sealedPath = r.path || sealedPath;
        let v = { ok: false };
        try { v = await S.verifySealed(fs.readFileSync(d.sealedPath), S.sha256(text)); } catch (e) { /* */ }
        d.verified = !!v.ok;
        if (v.ok) { try { fs.unlinkSync(d.path); } catch (e) { /* */ } d.path = d.sealedPath; }
        this._persist();
        this.panel = { kind: 'ok', title: 'Teksten er gyldig', text: v.ok ? `Dokumentet er forseglet med mærket og gemt som "${path.basename(d.sealedPath)}". Det står i Min HolyMoly.` : `Dokumentet er forseglet, men HolyMoly kunne ikke genkende teksten i den forseglede fil. Brug tjek-linket i sidefoden: ${url}`, mark: D.label(d.result.place, WordManager.markInfo(d.result)), actions: [{ id: 'folder', label: 'Åbn mappe' }, { id: 'mine', label: 'Min HolyMoly' }, { id: 'close', label: 'Luk', primary: true }] };
        out = { ok: true, certId: res.certId, sealed: true, verified: !!v.ok, path: d.sealedPath };
      }
    } else {
      // Gem uden mærke: Word gemmer og lukker dokumentet (det kan stadig vedhæftes en aflevering – uden mærke)
      await this.bridge.close(true);
      this.panel = { kind: 'info', title: 'Gemt uden mærke', text: `Dokumentet er gemt som "${path.basename(d.path)}" uden mærke. Det står i Min HolyMoly.`, actions: [{ id: 'folder', label: 'Åbn mappe' }, { id: 'mine', label: 'Min HolyMoly' }, { id: 'close', label: 'Luk', primary: true }] };
      out = { ok: true, certId: null };
    }
    // Skrevet til en aflevering: vedhæft med det samme (som skrivevinduet)
    if (d.assignmentId) {
      const a = await this.attach(d.id, d.assignmentId);
      const asg = this.assignments.find(x => x.id === d.assignmentId);
      this.panel.text += a.ok ? ` Afleveret til "${(asg && asg.title) || 'afleveringen'}".` : ` Kunne ikke vedhæfte til afleveringen: ${a.error}`;
      out.attached = !!a.ok;
    }
    this._ended();
    return out;
  }

  /** Vedhæft et afsluttet Word-dokument til en aflevering (samme besked som skrivevinduet). */
  attach(docId, assignmentId) {
    const d = this.get(String(docId || ''));
    const aid = Number(assignmentId) || 0;
    if (!d) return Promise.resolve({ ok: false, error: 'Dokumentet findes ikke' });
    if (!d.submitted) return Promise.resolve({ ok: false, error: 'Tryk "Tekst færdig" først' });
    return this.attachDoc(d.id, aid);
  }
  /** Vedhæft et hvilket som helst af elevens afsluttede dokumenter (også fra skrivevinduet). Serveren tjekker ejerskab. */
  attachDoc(docId, assignmentId) {
    const aid = Number(assignmentId) || 0;
    if (!this.assignments.some(a => a.id === aid)) return Promise.resolve({ ok: false, error: 'Afleveringen findes ikke' });
    return this._ask('a:' + aid, { type: 'assignment-attach', assignmentId: aid, docId: String(docId || '').slice(0, 64) });
  }

  /** Knapper i rammen: done | continue | nomark | folder | mine | close | mole */
  async action(id) {
    if (id === 'done') return this.finish(false);
    if (id === 'nomark') return this.finish(true);
    if (id === 'continue') { this.panel = null; this._render(); return { ok: true }; }
    if (id === 'folder') {
      const d = this.get(this.lastId || '');
      if (d && this.o.showInFolder) this.o.showInFolder(d.sealedPath || d.path);
      return { ok: !!d };
    }
    if (id === 'mine') { if (this.o.onOpenMine) this.o.onOpenMine(); return { ok: true }; }
    if (id === 'close') { this.panel = null; if (this.s) this._render(); else this.overlay.hide(); return { ok: true }; }
    return { ok: false };
  }

  /** Appen lukker: stop målingen (Word og elevens dokument forbliver åbne). */
  stop() {
    if (this.s) { clearInterval(this.s.timer); clearInterval(this.s.clipTimer); if (this.s.solo) this.o.send({ type: 'write-session', assignmentId: this.s.solo, on: false }); }
    this.s = null;
    try { this.bridge.stop(); } catch (e) { /* */ }
    this.overlay.destroy();
  }
}

module.exports = { WordManager, hhmm };
