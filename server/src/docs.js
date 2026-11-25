'use strict';
/*
 * "Skriv i HolyMoly": dokumenter og skrive-bevis.
 *
 * Beviset bygger på SKRIVEFORLØBET, ikke på et gæt om teksten:
 *   1. Teksten er skrevet i HolyMolys editor, mens HolyMoly overvågede (lektion i gang).
 *   2. Serveren noterer selv elevens lampe ved hver gemning: ingen rød, og overvågningen var komplet (ingen længere grå perioder).
 *   3. Alt i teksten er tastet: indsæt og træk-og-slip er blokeret i editoren, og serveren tjekker selv,
 *      at teksten ikke vokser hurtigere, end et menneske kan skrive.
 *   4. Intet tegn på maskinel indtastning (for hurtigt eller for jævnt tempo – "autotyper").
 *   5. Ingen ordrette chatbot-fraser i teksten (fx "as an AI language model"). Svagere spor er kun en note til læreren.
 * Er alt opfyldt, udsteder serveren et bevis signeret med sin egen nøgle (Ed25519). Alle kan tjekke det på /bevis/<id>.
 *
 * Det signerede bevis (v2) har ingen persondata: kun en saltet hash af navnet. Navn og klasse ligger i databasen
 * og vises kun for elevens egen lærer. Ældre beviser (v1) vises offentligt kun som gyldig/ugyldig og dato.
 *
 * Hvad beviset IKKE kan: se om eleven har skrevet en tekst af efter en anden skærm/telefon. Det står på beviset.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const D = require('../../shared/doc.js');
const RET = require('./retention.js');

const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_HUMAN_CPS = 15;          // vedvarende tegn/sek (5 sek. vindue) – hurtigere er ikke et menneske
const MAX_BURST = 30;              // tegn inden for ét sekund (en hel sætning på én gang = et program)
const MAX_FAST_SHARE = 0.25;       // andel tastetryk hurtigere end en finger kan (< 12 ms)
const SERVER_GROWTH_CPS = 15;      // serverens eget tjek mellem to gemninger
const MAX_AVG_CPS = 10;            // gennemsnit over hele skrivetiden (inkl. pauser) – ingen mennesker holder det tempo
const OBSERVE_GAP_MS = 30_000;     // længere tid uden serverens egen måling tæller som "ikke fulgt"
const MIN_REGULARITY = 0.25;       // variationskoefficient for tastetryk – lavere = maskinelt jævnt
const GREY_MAX_SHARE = 0.10;       // højst 10 % af skrivetiden uden fuld overvågning
const GREY_MAX_MS = 3 * 60_000;    // … og højst 3 minutter
const FIRST_SAVE_BUDGET = 150;     // så meget tekst må et nyt dokument have, første gang serveren ser det (appen sender det tomme dokument straks)
const MAX_OPEN_DOCS = 30;           // diskkvote: højst 30 uafleverede dokumenter pr. elev …
const QUOTA_BYTES = 10 * 1024 * 1024; // … højst 10 MB tekst (dokumenter + afspilning) pr. elev …
const MAX_GROWTH = 3000;           // … og højst 3.000 nye tegn pr. gemning (ellers gemmes intet)
const GAP_MS = 2 * 60_000;         // længere pause mellem to gemninger tæller ikke som skrivetid
const MIN_WORDS = 100;             // kortere tekster får ikke et bevis
const GUARD_GRACE_MS = 30_000;     // de første 30 sek. med "Venter på HolyMoly-vagten" tæller ikke som grå
const IDLE_MAX_MS = 10 * 60_000;   // grå tid UDEN vækst: højst 10 minutter …
const IDLE_MAX_SHARE = 0.15;       // … og højst 15 % af tiden
const DOWN_CPS = 2;                // mens serveren selv var nede, godtages vækst på 2 tegn/sek. …
const DOWN_MAX = 400;              // … dog højst 400 tegn pr. hul
const TEST_ISSUER = 'Testserver – må ikke bruges til bedømmelse';

/* Hvorfor beviset mangler – i elevens sprog og uden tal (eleven skal ikke kunne justere sig ind under grænserne) */
const CATEGORY_TEXT = {
  kort: `Teksten er for kort. Et bevis kræver mindst ${MIN_WORDS} ord.`,
  rod: 'Lampen var rød, mens du skrev.',
  forbindelse: 'HolyMoly kunne ikke følge hele skriveforløbet (grå lampe eller ingen forbindelse).',
  indsat: 'Der er tekst, som ikke er tastet i HolyMoly.',
  tempo: 'Skrivetempoet ligner ikke et menneskes.',
  ai: 'Teksten indeholder en ordret sætning fra en AI-chat.',
};

const num = (v, max = 1e12) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : 0; };

class DocStore {
  /** opts: { testServer: issuer får "Testserver" (enkel tilstand uden skole), minWords } */
  constructor(db, dataDir, opts = {}) {
    this.db = db;
    this.testServer = !!opts.testServer;
    this.minWords = Number.isInteger(opts.minWords) && opts.minWords > 0 ? opts.minWords : MIN_WORDS;
    // Diskkvote pr. elev (kan sættes lavere i tests)
    this.maxOpenDocs = Number(opts.maxOpenDocs) > 0 ? Number(opts.maxOpenDocs) : MAX_OPEN_DOCS;
    this.quotaBytes = Number(opts.quotaBytes) > 0 ? Number(opts.quotaBytes) : QUOTA_BYTES;
    this.usage = new Map(); // studentId -> { bytes, ts } (genberegnes højst hvert minut)
    db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        class_id INTEGER NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        blocks TEXT NOT NULL DEFAULT '[]',
        text TEXT NOT NULL DEFAULT '',
        stats TEXT NOT NULL DEFAULT '{}',
        monitor TEXT NOT NULL DEFAULT '{}',
        created INTEGER NOT NULL,
        updated INTEGER NOT NULL,
        submitted INTEGER,
        result TEXT,
        cert_id TEXT
      );
      CREATE INDEX IF NOT EXISTS documents_student ON documents(student_id, updated);
      CREATE TABLE IF NOT EXISTS doc_versions (
        doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        ts INTEGER NOT NULL,
        text TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS doc_versions_d ON doc_versions(doc_id, ts);
      CREATE TABLE IF NOT EXISTS certificates (
        id TEXT PRIMARY KEY,
        doc_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        sig TEXT NOT NULL,
        created INTEGER NOT NULL
      );
    `);
    // Navn og klasse gemmes usigneret ved siden af beviset (kun til elevens egen lærer – aldrig offentligt)
    const certCols = new Set(db.prepare('PRAGMA table_info(certificates)').all().map(c => c.name));
    if (!certCols.has('student_name')) db.exec("ALTER TABLE certificates ADD COLUMN student_name TEXT NOT NULL DEFAULT ''");
    if (!certCols.has('class_name')) db.exec("ALTER TABLE certificates ADD COLUMN class_name TEXT NOT NULL DEFAULT ''");
    // Gravsten: hvornår teksten blev slettet (beviset lever videre uden navn), tekstens hash og hvornår beviset udløb
    if (!certCols.has('doc_deleted')) db.exec('ALTER TABLE certificates ADD COLUMN doc_deleted INTEGER');
    if (!certCols.has('text_sha256')) db.exec('ALTER TABLE certificates ADD COLUMN text_sha256 TEXT');
    if (!certCols.has('expired')) db.exec('ALTER TABLE certificates ADD COLUMN expired INTEGER');
    db.exec(`
      UPDATE certificates SET text_sha256 = json_extract(payload, '$.sha256') WHERE text_sha256 IS NULL AND json_valid(payload);
      CREATE INDEX IF NOT EXISTS certificates_sha ON certificates(text_sha256);
      -- Slettes et dokument (frist, klasse eller lærer slettet), bliver beviset en gravsten: det kan stadig tjekkes,
      -- men navn, klasse og kobling til teksten er væk. Kun "Slet elev" sletter beviserne (se deleteStudentCertificates).
      DROP TRIGGER IF EXISTS documents_cleanup;
      CREATE TRIGGER documents_cleanup AFTER DELETE ON documents BEGIN
        UPDATE certificates SET doc_id = '', student_name = '', class_name = '', doc_deleted = COALESCE(doc_deleted, CAST(unixepoch('subsec') * 1000 AS INTEGER)) WHERE doc_id = OLD.id;
        DELETE FROM assignment_submissions WHERE doc_id = OLD.id;
      END;
    `);
    // Signeringsnøgle (kun serveren har den). Den offentlige nøgle står på tjek-siden.
    const keyPath = path.join(dataDir, 'proof-key.pem');
    if (!fs.existsSync(keyPath)) {
      // Findes der beviser, er nøglen forsvundet (fx en backup uden den). En ny nøgle ville stille gøre alle beviser ugyldige.
      const n = db.prepare('SELECT COUNT(*) AS n FROM certificates').get().n;
      if (n > 0) {
        throw new Error(`Signeringsnøglen mangler: ${keyPath} findes ikke, men databasen har ${n} skrive-beviser. `
          + 'Serveren starter ikke, for en ny nøgle ville gøre alle beviser ugyldige. Læg proof-key.pem tilbage fra backuppen og start igen.');
      }
      const { privateKey } = crypto.generateKeyPairSync('ed25519');
      fs.writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    }
    this.privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath));
    this.publicKey = crypto.createPublicKey(this.privateKey);
    this.publicPem = this.publicKey.export({ type: 'spki', format: 'pem' });
    this.keyId = crypto.createHash('sha256').update(this.publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
    // Salt til navne-hash: afledt af den hemmelige nøgle (kan ikke regnes ud fra beviset eller den offentlige nøgle)
    this.nameSalt = Buffer.from(crypto.hkdfSync('sha256', this.privateKey.export({ type: 'pkcs8', format: 'der' }), Buffer.alloc(0), 'HolyMoly navne-hash v1', 32));
    this.q = {
      get: db.prepare('SELECT * FROM documents WHERE id = ?'),
      ins: db.prepare('INSERT INTO documents (id, student_id, class_id, title, blocks, text, stats, monitor, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?)'),
      upd: db.prepare('UPDATE documents SET title = ?, blocks = ?, text = ?, stats = ?, monitor = ?, updated = ? WHERE id = ?'),
      mon: db.prepare('UPDATE documents SET monitor = ? WHERE id = ?'),
      ofStudent: db.prepare('SELECT id, title, text, created, updated, submitted, result, cert_id FROM documents WHERE student_id = ? ORDER BY updated DESC LIMIT 200'),
      cert: db.prepare('SELECT * FROM certificates WHERE id = ?'),
    };
  }

  static validId(id) { return typeof id === 'string' && ID_RE.test(id); }

  /** Hvilke linjer i den normaliserede tekst der er listepunkter (Word sætter "1." / "•" foran dem). */
  static listLines(blocks) {
    const out = [];
    let i = 0;
    for (const b of blocks) {
      const line = D.normalizeText(b.r.map(r => r.x).join(''));
      if (!line) continue;
      if (b.t === 'ul' || b.t === 'ol') out.push(i);
      i++;
    }
    return out;
  }

  /** Rens tal fra appen (de kan kun komme fra den ægte app, men tjekkes alligevel). */
  static cleanStats(s) {
    s = s && typeof s === 'object' ? s : {};
    return {
      typed: num(s.typed, 1e7), deleted: num(s.deleted, 1e7), keystrokes: num(s.keystrokes, 1e7),
      pasteBlocked: num(s.pasteBlocked, 1e6), pasteInserted: num(s.pasteInserted, 1e6), dropBlocked: num(s.dropBlocked, 1e6),
      maxCps: num(s.maxCps, 1e4), regularity: s.regularity == null ? null : num(s.regularity, 100),
      restored: num(s.restored, 1e7), burst: num(s.burst, 1e6), fastShare: Math.min(1, num(s.fastShare, 1)),
      focusLostMs: num(s.focusLostMs), activeMs: num(s.activeMs),
    };
  }

  /**
   * Gem en version. view = elevens aktuelle lampe (fra serveren selv, ikke fra appen).
   * Returnerer { ok, error?, doc }
   */
  /**
   * Serverens egen løbende måling af elevens lampe, mens eleven skriver (kaldes ca. hvert 3. sek. af hubben,
   * og ved hver gemning/aflevering). Tiden siden sidste måling tilskrives den lampe eleven havde dengang.
   */
  observe(id, view, now = Date.now()) {
    const row = this.q.get.get(String(id || ''));
    if (!row || row.submitted) return;
    const m = JSON.parse(row.monitor);
    this._observe(m, view, now);
    this.q.mon.run(JSON.stringify(m), row.id);
  }
  /** Lektionen er slut: pausér målingen (pauser mellem lektioner tæller ikke). */
  pause(id) {
    const row = this.q.get.get(String(id || ''));
    if (!row || row.submitted) return;
    const m = JSON.parse(row.monitor);
    if (!m.lastObs) return;
    m.lastObs = 0;
    this.q.mon.run(JSON.stringify(m), row.id);
  }
  /** Hvor meget af tidsrummet [from, to] serveren selv var nede (huller mellem to kørsler i server_runs). */
  _downtime(from, to) {
    if (!(to > from)) return 0;
    let ms = 0;
    try {
      const rows = this.db.prepare('SELECT start, LAG(last_alive) OVER (ORDER BY start) AS prev FROM server_runs').all();
      for (const r of rows) {
        if (r.prev == null) continue;
        const a = Math.max(from, r.prev), b = Math.min(to, r.start);
        if (b > a) ms += b - a;
      }
    } catch (e) { /* ingen tabel */ }
    return Math.min(ms, to - from);
  }

  /*
   * Grå tid: al grå tid tælles (greyMs). Grå tid siden sidste gemning samles i greyPending og afgøres ved næste gemning:
   * voksede teksten, tæller den mod beviset (greyCounted); ellers lægges den i greyIdle (grå tid uden vækst), som har
   * sin egen, større grænse (10 min. eller 15 %). De første 30 sek. med "Venter på HolyMoly-vagten" tæller aldrig.
   * Tid, hvor serveren selv var nede (server_runs), tæller hverken som grå eller uden vækst.
   */
  _observe(m, view, now) {
    if (m.greyCounted == null) { m.greyCounted = m.greyMs || 0; m.greyPending = 0; } // dokument fra før reglen: som før
    if (m.greyIdle == null) m.greyIdle = 0;
    if (m.lastObs) {
      const dt = Math.max(0, now - m.lastObs);
      if (dt > OBSERVE_GAP_MS) {
        // Serveren har ikke fulgt med. Den del, hvor serveren selv var nede, er ikke elevens skyld.
        const down = this._downtime(m.lastObs, now);
        if (down > 0) {
          m.downMs = (m.downMs || 0) + down;
          m.downPending = (m.downPending || 0) + down;
          m.downAllow = (m.downAllow || 0) + Math.min(DOWN_MAX, Math.round(DOWN_CPS * down / 1000));
        }
        const rest = dt - down;
        if (rest > 0) {
          m.greyMs += rest;
          m.greyPending += rest;
          if (m.grey.length < 20 && !m.grey.includes('HolyMoly-serveren kunne ikke følge med')) m.grey.push('HolyMoly-serveren kunne ikke følge med');
        }
      } else if (m.lastColor === 'green') m.greenMs += dt;
      else if (m.lastColor === 'red') m.redMs += dt;
      else {
        m.greyMs += dt;
        const graceEnd = /venter på (holymoly-)?vagten/i.test(m.greyWhy || '') ? (m.greyStart || m.lastObs) + GUARD_GRACE_MS : 0;
        m.greyPending += Math.max(0, now - Math.max(m.lastObs, graceEnd));
      }
    }
    const color = view ? view.color : 'grey';
    if (color !== 'green' && color !== 'red') {
      const why = String((view && view.greyReason) || '');
      if (m.lastColor === 'green' || m.lastColor === 'red' || !m.lastColor || m.greyWhy !== why) { m.greyStart = now; m.greyWhy = why; }
    } else { m.greyStart = 0; m.greyWhy = ''; }
    if (color === 'red' && view.violations && m.red.length < 20) {
      for (const v of view.violations.slice(0, 3)) if (!m.red.includes(v.text)) m.red.push(String(v.text).slice(0, 160));
    }
    if (color !== 'green' && color !== 'red' && m.grey.length < 20) {
      const why = (view && view.greyReason) || 'Overvågningen var ikke komplet';
      if (!m.grey.includes(why)) m.grey.push(String(why).slice(0, 160));
    }
    m.lastObs = now;
    m.lastColor = color;
  }

  /** sinceMs (hvor længe eleven har været i lektionen) bruges ikke længere: et nyt dokument har et fast budget. */
  save(student, input, view, lessonId, now = Date.now(), sinceMs = 0) {
    if (!DocStore.validId(input.id)) return { ok: false, error: 'Ugyldigt dokument-id' };
    let blocks;
    try { blocks = D.validateBlocks(input.blocks); } catch (e) { return { ok: false, error: e.message } }
    const title = String(input.title || '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, D.LIMITS.title);
    const text = D.normalizeText(D.textOf(blocks));
    const stats = DocStore.cleanStats(input.stats);
    let row = this.q.get.get(input.id);
    if (row && row.student_id !== student.id) return { ok: false, error: 'Ugyldigt dokument-id' };
    if (row && row.submitted) return { ok: false, error: 'Dokumentet er afleveret og kan ikke ændres' };
    const m = row ? JSON.parse(row.monitor) : { greenMs: 0, redMs: 0, greyMs: 0, red: [], grey: [], flags: [], lessons: [], lastTs: 0, lastLen: 0, lastColor: '', lastObs: 0, first: now };
    // Diskkvote: før der skrives noget
    const blocksJson = JSON.stringify(blocks);
    if (text.length - (m.lastLen || 0) > MAX_GROWTH) return { ok: false, error: 'For meget ny tekst på én gang. HolyMoly gemmer højst 3.000 nye tegn ad gangen. Teksten er kun gemt på computeren.' };
    if (!row && this.db.prepare('SELECT COUNT(*) AS n FROM documents WHERE student_id = ? AND submitted IS NULL').get(student.id).n >= this.maxOpenDocs) {
      return { ok: false, error: 'Du har for mange åbne dokumenter. Aflever eller slet nogle først.' };
    }
    const newSize = Buffer.byteLength(blocksJson) + Buffer.byteLength(text);
    const oldSize = row ? Buffer.byteLength(row.blocks) + Buffer.byteLength(row.text) : 0;
    if (newSize > oldSize && this._usageOf(student.id) - oldSize + newSize > this.quotaBytes) {
      return { ok: false, error: 'Der er ikke mere plads til dine dokumenter. Tal med din lærer.' };
    }
    this._observe(m, view, now);
    // Serverens eget tjek: voksede teksten hurtigere, end et menneske kan skrive? (15 tegn/sek.)
    const dt = m.lastTs ? now - m.lastTs : 0;
    const growth = text.length - (m.lastLen || 0);
    // Var serveren selv nede siden sidste gemning, godtages lidt vækst fra den tid (højst 400 tegn pr. hul)
    const downDt = m.downPending || 0;
    const eff = growth - (m.downAllow || 0);
    m.downPending = 0; m.downAllow = 0;
    if (m.flags.length < 20 && growth > 30) {
      if (!m.lastTs) {
        // Første gang serveren ser dokumentet: fast budget på 150 tegn (forberedt tekst, fx i en redigeret documents.json)
        if (growth > FIRST_SAVE_BUDGET) m.flags.push(`Dokumentet havde allerede ${growth} tegn, første gang HolyMoly så det`);
      } else if (downDt > 0 && eff > 80) m.flags.push(`${growth} tegn blev skrevet, mens HolyMoly ikke kunne følge med (serveren var nede i ${Math.max(1, Math.round(downDt / 60000))} min.)`);
      else if (dt - downDt > GAP_MS && eff > 80) m.flags.push(`${growth} tegn blev skrevet, mens HolyMoly ikke kunne følge med (${Math.round(dt / 60000)} min. uden forbindelse)`);
      else if (dt > 0 && eff / (dt / 1000) > SERVER_GROWTH_CPS) m.flags.push(`Tekst indsat for hurtigt: teksten voksede med ${growth} tegn på ${Math.max(1, Math.round(dt / 1000))} sek.`);
    }
    // Grå tid siden sidste gemning tæller mod beviset, hvis teksten voksede imens – ellers som grå tid uden vækst
    if (growth > 0) m.greyCounted += m.greyPending;
    else m.greyIdle = (m.greyIdle || 0) + m.greyPending;
    m.greyPending = 0;
    if (lessonId && !m.lessons.includes(lessonId) && m.lessons.length < 50) m.lessons.push(lessonId);
    m.lastTs = now; m.lastLen = text.length;
    if (row) this.q.upd.run(title, blocksJson, text, JSON.stringify(stats), JSON.stringify(m), now, input.id);
    else this.q.ins.run(input.id, student.id, student.class_id, title, blocksJson, text, JSON.stringify(stats), JSON.stringify(m), now, now);
    const added = this._version(input.id, text, now);
    const u = this.usage.get(student.id);
    if (u) u.bytes += newSize - oldSize + added;
    const doc = this.q.get.get(input.id);
    // Prøve-vurdering: hvad ville mangle, hvis eleven afleverede nu (kun kategorier – aldrig tal)
    const ev = this.evaluate(doc);
    return { ok: true, doc, preview: { ok: ev.ok, categories: ev.categories } };
  }

  /**
   * "Afspil skriveforløbet": en version højst hvert 20. sek. (eller ved en ændring på 100+ tegn), højst 720 pr. dokument.
   */
  _version(id, text, now) {
    const last = this.db.prepare('SELECT ts, length(text) AS n FROM doc_versions WHERE doc_id = ? ORDER BY ts DESC LIMIT 1').get(id);
    if (last && now - last.ts < 20_000 && Math.abs(text.length - last.n) < 100) return 0;
    if (last && last.n === text.length && this.db.prepare('SELECT text FROM doc_versions WHERE doc_id = ? ORDER BY ts DESC LIMIT 1').get(id).text === text) return 0;
    if (this.db.prepare('SELECT COUNT(*) AS n FROM doc_versions WHERE doc_id = ?').get(id).n >= 720) return 0;
    this.db.prepare('INSERT INTO doc_versions (doc_id, ts, text) VALUES (?,?,?)').run(id, now, text);
    return Buffer.byteLength(text);
  }
  /** Hvor meget elevens dokumenter og afspilning fylder (bytes). Genberegnes højst hvert minut; ellers lægges ændringer til. */
  _usageOf(studentId) {
    const u = this.usage.get(studentId);
    if (u && Math.abs(Date.now() - u.ts) < 60_000) return u.bytes;
    const r = this.db.prepare(`SELECT
        COALESCE((SELECT SUM(length(CAST(blocks AS BLOB)) + length(CAST(text AS BLOB))) FROM documents WHERE student_id = ?), 0)
      + COALESCE((SELECT SUM(length(CAST(v.text AS BLOB))) FROM doc_versions v JOIN documents d ON d.id = v.doc_id WHERE d.student_id = ?), 0) AS n`).get(studentId, studentId);
    this.usage.set(studentId, { bytes: r.n, ts: Date.now() });
    return r.n;
  }
  versions(id) {
    return this.db.prepare('SELECT ts, text FROM doc_versions WHERE doc_id = ? ORDER BY ts').all(String(id || ''));
  }

  /**
   * Ligner dokumentet andre dokumenter i samme klasse? Lokalt (ingen AI/API): andel af fælles 5-ords-sekvenser.
   * Det er en oplysning til læreren – aldrig en rød lampe (to elever kan citere den samme kilde).
   */
  similar(id) {
    const row = this.q.get.get(String(id || ''));
    if (!row || !row.submitted) return []; // kun afleverede dokumenter sammenlignes
    const shingles = (t) => {
      const w = String(t).toLocaleLowerCase('da').match(/[\p{L}\p{N}]+/gu) || [];
      const set = new Set();
      for (let i = 0; i + 5 <= w.length; i++) set.add(w.slice(i, i + 5).join(' '));
      return set;
    };
    const mine = shingles(row.text);
    if (mine.size < 8) return [];
    const others = this.db.prepare('SELECT d.id, d.title, d.text, d.submitted, s.name FROM documents d JOIN students s ON s.id = d.student_id WHERE d.class_id = ? AND d.student_id != ? AND d.submitted IS NOT NULL LIMIT 400').all(row.class_id, row.student_id);
    const out = [];
    for (const o of others) {
      const theirs = shingles(o.text);
      if (theirs.size < 8) continue;
      let common = 0;
      for (const s of mine) if (theirs.has(s)) common++;
      const share = common / Math.min(mine.size, theirs.size);
      if (share >= 0.2) out.push({ id: o.id, student: o.name, title: o.title, percent: Math.round(share * 100), commonPhrases: common, submitted: o.submitted });
    }
    return out.sort((a, b) => b.percent - a.percent).slice(0, 5);
  }

  /**
   * Vurdér skriveforløbet. Returnerer { ok, reasons: [], notes: [], facts, categories: [{ key, text }] }
   * reasons/notes er til læreren. categories er til eleven: hvorfor beviset mangler, uden tal.
   */
  evaluate(row) {
    const m = JSON.parse(row.monitor);
    const s = JSON.parse(row.stats);
    const text = row.text;
    const reasons = [];
    const notes = [];
    const cats = new Set();
    const no = (cat, why) => { reasons.push(why); cats.add(cat); };
    const words = D.wordCount(text);
    const totalMs = m.greenMs + m.redMs + m.greyMs;
    const greyCounted = m.greyCounted == null ? m.greyMs : m.greyCounted; // grå tid uden gemning bagefter: teksten voksede ikke
    if (words < this.minWords) no('kort', `Teksten er for kort til et bevis (mindst ${this.minWords} ord)`);
    if (m.redMs > 0 || m.red.length) no('rod', 'Rød lampe mens teksten blev skrevet: ' + (m.red.join('; ') || 'forbudt aktivitet'));
    if (greyCounted > GREY_MAX_MS || (totalMs > 0 && greyCounted / totalMs > GREY_MAX_SHARE)) {
      no('forbindelse', `Overvågningen var ikke komplet i ${Math.max(1, Math.round(greyCounted / 60000))} min., mens teksten voksede` + (m.grey.length ? ' (' + m.grey.join('; ') + ')' : ''));
    }
    // Grå tid uden vækst (fx forbindelsen væk, mens dokumentet var åbent): over 10 min. eller 15 % af tiden
    const idle = (m.greyIdle || 0) + (m.greyPending || 0);
    if (!cats.has('forbindelse') && (idle > IDLE_MAX_MS || (totalMs > 0 && idle / totalMs > IDLE_MAX_SHARE))) {
      no('forbindelse', `Overvågningen var ikke komplet i ${Math.max(1, Math.round(idle / 60000))} min., mens dokumentet var åbent` + (m.grey.length ? ' (' + m.grey.join('; ') + ')' : ''));
    }
    if (s.pasteInserted > 0) no('indsat', 'Der er indsat tekst, som ikke er tastet');
    // Tastet minus slettet (plus fortrudt) skal kunne forklare teksten
    if (s.typed - s.deleted + s.restored + 20 < text.length) no('indsat', 'Der er mere tekst, end der er tastet');
    for (const f of m.flags) no(/ikke kunne følge med/.test(f) ? 'forbindelse' : 'indsat', f);
    if (s.maxCps > MAX_HUMAN_CPS) no('tempo', `Skrevet hurtigere end et menneske kan (${Math.round(s.maxCps)} tegn/sek.)`);
    if (s.burst > MAX_BURST) no('tempo', `${Math.round(s.burst)} tegn kom på under ét sekund (et program, ikke et menneske)`);
    if (s.keystrokes >= 200 && s.fastShare > MAX_FAST_SHARE) no('tempo', 'Mange tastetryk kom hurtigere, end en finger kan trykke');
    if (text.length > 600 && totalMs > 0 && text.length / (totalMs / 1000) > MAX_AVG_CPS) no('tempo', `Teksten er længere, end det er muligt at skrive på ${Math.max(1, Math.round(totalMs / 60000))} min.`);
    if (s.regularity != null && s.keystrokes >= 300 && s.regularity < MIN_REGULARITY) no('tempo', 'Tastetrykkene kom i et maskinelt jævnt tempo');
    for (const t of D.aiTraces(text)) no('ai', t);
    for (const t of D.aiHints(text)) notes.push(t + ' – kun en oplysning, ikke et afslag');
    if (s.pasteBlocked + s.dropBlocked > 0) notes.push(`${s.pasteBlocked + s.dropBlocked} forsøg på at indsætte tekst blev blokeret`);
    // Hjemme er tid uden for skrivevinduet elevens egen sag: ingen fokus-note (place='hjemme')
    if (s.focusLostMs > 60_000 && !(({ home, lesson }) => home && !lesson)(this.placeOf(row.id))) notes.push(`Skrivevinduet var ikke i fokus i ${Math.round(s.focusLostMs / 60000)} min.`);
    if (m.greyMs > 0 && !cats.has('forbindelse')) {
      const quiet = Math.max(0, m.greyMs - greyCounted);
      notes.push(`Kort tid uden fuld overvågning (${Math.max(1, Math.round(m.greyMs / 1000))} sek.` + (quiet >= 1000 ? `, heraf ${Math.round(quiet / 1000)} sek. hvor teksten ikke voksede` : '') + ')');
    }
    const facts = {
      words, chars: text.length, writingMinutes: Math.max(1, Math.round(totalMs / 60000)),
      typed: s.typed, deleted: s.deleted, pasteBlocked: s.pasteBlocked + s.dropBlocked,
      monitoredShare: totalMs ? Math.round((m.greenMs / totalMs) * 100) : 0,
      started: m.first, lessons: m.lessons.length,
    };
    const categories = Object.keys(CATEGORY_TEXT).filter(k => cats.has(k)).map(key => ({ key, text: key === 'kort' ? `Teksten er for kort. Et bevis kræver mindst ${this.minWords} ord.` : CATEGORY_TEXT[key] }));
    return { ok: reasons.length === 0, reasons, notes, facts, categories };
  }

  /** Saltet hash af et navn (står i beviset i stedet for navnet). Samme navn giver samme hash på denne server. */
  nameHash(name) {
    const n = String(name || '').normalize('NFC').toLocaleLowerCase('da').replace(/\s+/g, ' ').trim();
    return crypto.createHmac('sha256', this.nameSalt).update(n, 'utf8').digest('hex');
  }

  /**
   * Aflever: vurdér og udsted evt. bevis. meta: { studentName, className, teacherName, issuer, view, force }
   * Giver vurderingen ikke et bevis, låses dokumentet IKKE, medmindre eleven har valgt "Aflever alligevel" (force).
   * Så svarer serveren { ok: false, confirm: true, reasons, categories }, og eleven kan skrive videre.
   */
  submit(student, id, meta, now = Date.now()) {
    const row = this.q.get.get(String(id || ''));
    if (!row || row.student_id !== student.id) return { ok: false, error: 'Dokumentet findes ikke' };
    if (row.submitted) return Object.assign({ ok: true, already: true }, JSON.parse(row.result || '{}'));
    if (meta.view !== undefined) { this.observe(row.id, meta.view, now); }
    const ev = this.evaluate(this.q.get.get(row.id));
    const where = this.placeOf(row.id);
    const place = where.home ? (where.lesson ? 'lektion og hjemme' : 'hjemme') : 'lektion';
    ev.facts.place = place;
    if (!ev.ok && !meta.force) {
      return {
        ok: false, confirm: true, reasons: ev.reasons, notes: ev.notes, categories: ev.categories,
        error: 'Beviset vil mangle: ' + ev.categories.map(c => c.text).join(' '),
      };
    }
    let cert = null;
    if (ev.ok) {
      const certId = crypto.randomBytes(12).toString('base64url');
      const issuer = this.testServer ? (meta.issuer ? `${meta.issuer} (${TEST_ISSUER})` : TEST_ISSUER) : String(meta.issuer || '');
      // Fast rækkefølge af felter – det er præcis denne tekst der signeres. Ingen navne, klasse eller lærer (kun en saltet hash af navnet).
      const payload = JSON.stringify({
        v: 2, id: certId,
        sha256: crypto.createHash('sha256').update(row.text, 'utf8').digest('hex'),
        words: ev.facts.words, submitted: now, place,
        checks: [where.home ? (where.lesson ? 'Tastet i HolyMoly med overvågning – i timen og hjemme i en skriveøkt uden opsyn' : 'Tastet i HolyMoly med overvågning – hjemme i en skriveøkt uden opsyn') : 'Tastet i HolyMoly under en lektion med overvågning', 'Ingen rød lampe undervejs', 'Al tekst er tastet (indsæt blokeret)', 'Menneskeligt skrivetempo', 'Ingen ordrette fraser fra en AI-chat i teksten'],
        limits: 'Beviset dækker skriveforløbet på computeren – ikke afskrift fra telefon eller papir.' + (where.home ? ' Skrevet hjemme uden lærer til stede.' : ''),
        issuer, keyId: this.keyId,
        nameHash: this.nameHash(meta.studentName),
      });
      const sig = crypto.sign(null, Buffer.from(payload), this.privateKey).toString('base64');
      this.db.prepare('INSERT INTO certificates (id, doc_id, payload, sig, created, student_name, class_name, text_sha256) VALUES (?,?,?,?,?,?,?,?)')
        .run(certId, row.id, payload, sig, now, String(meta.studentName || ''), String(meta.className || ''), JSON.parse(payload).sha256);
      cert = { id: certId };
    }
    const result = { certId: cert ? cert.id : null, reasons: ev.reasons, notes: ev.notes, facts: ev.facts, categories: ev.categories };
    this.db.prepare('UPDATE documents SET submitted = ?, result = ?, cert_id = ? WHERE id = ?').run(now, JSON.stringify(result), cert ? cert.id : null, row.id);
    // Afspilningen beholder højst 120 versioner efter aflevering (retention.js)
    RET.trimVersions(this.db, row.id);
    return Object.assign({ ok: true }, result);
  }

  /** Slet en kladde (aldrig et afleveret dokument). studentId = ejeren. */
  deleteDraft(id, studentId) {
    const row = this.q.get.get(String(id || ''));
    if (!row || row.student_id !== Number(studentId)) return { ok: false, error: 'Dokumentet findes ikke', missing: true };
    if (row.submitted) return { ok: false, error: 'Et afleveret dokument kan ikke slettes' };
    this.db.prepare('DELETE FROM documents WHERE id = ? AND submitted IS NULL').run(row.id);
    return { ok: true, title: row.title };
  }

  /** Blev dokumentet skrevet i timen, hjemme i en skriveøkt – eller begge? */
  placeOf(id) {
    const row = this.q.get.get(String(id || ''));
    const ids = row ? (JSON.parse(row.monitor).lessons || []).map(Number).filter(Number.isInteger) : [];
    if (!ids.length) return { home: false, lesson: true };
    const solo = this.db.prepare(`SELECT COUNT(*) AS n FROM lessons WHERE student_id IS NOT NULL AND id IN (${ids.map(() => '?').join(',')})`).get(...ids).n;
    return { home: solo > 0, lesson: solo < ids.length };
  }

  list(studentId) {
    return this.q.ofStudent.all(studentId).map(r => {
      const res = r.result ? JSON.parse(r.result) : null;
      return { id: r.id, title: r.title, words: D.wordCount(r.text), created: r.created, updated: r.updated, submitted: r.submitted, certId: r.cert_id, reasons: res ? res.reasons : [], notes: res ? res.notes : [] };
    });
  }

  /** Fuldt dokument + løbende vurdering (til læreren). */
  full(id) {
    const r = this.q.get.get(String(id || ''));
    if (!r) return null;
    const res = r.result ? JSON.parse(r.result) : null;
    const live = this.evaluate(r);
    return {
      id: r.id, studentId: r.student_id, title: r.title, blocks: JSON.parse(r.blocks), words: D.wordCount(r.text),
      created: r.created, updated: r.updated, submitted: r.submitted, certId: r.cert_id,
      reasons: res ? res.reasons : live.reasons, notes: res ? res.notes : live.notes, facts: res ? res.facts : live.facts,
      place: res && res.facts ? res.facts.place : undefined,
    };
  }

  /**
   * Offentligt tjek af et bevis. Nye beviser (v2): payload + signatur + offentlig nøgle (ingen persondata).
   * Ældre beviser (v1) havde navn, klasse og lærer i klartekst: dem viser vi kun som gyldig/ugyldig og dato.
   * Signaturen tjekkes på samme måde for begge.
   */
  certificate(id) {
    const c = this.q.cert.get(String(id || ''));
    if (!c) return null;
    // Udløbet efter fristen (retention.js): id'et er udstedt her, men beviset findes ikke længere
    if (c.expired) return { expired: c.expired, created: c.created };
    const valid = crypto.verify(null, Buffer.from(c.payload), this.publicKey, Buffer.from(c.sig, 'base64'));
    let p = {};
    try { p = JSON.parse(c.payload); } catch (e) { /* ødelagt: ugyldig */ }
    const docDeleted = c.doc_deleted || null; // gravsten: teksten er slettet efter skolens frist
    if (p.v !== 2) return Object.assign({ v: Number(p.v) || 1, legacy: true, valid, submitted: Number(p.submitted) || c.created }, docDeleted ? { docDeleted } : {});
    return { v: 2, payload: p, signed: c.payload, sig: c.sig, publicKey: this.publicPem, valid, docDeleted };
  }

  /** "Slet elev": elevens beviser slettes helt (ingen gravsten). Kaldes, før eleven slettes. */
  deleteStudentCertificates(studentId) {
    return this.db.prepare('DELETE FROM certificates WHERE doc_id IN (SELECT id FROM documents WHERE student_id = ?)').run(Number(studentId)).changes;
  }

  /** Hvem beviset tilhører (KUN til elevens egen lærer – tjek ejerskab før brug). */
  certificateOwner(id) {
    const c = this.db.prepare('SELECT c.payload, c.student_name, c.class_name, d.student_id, d.title FROM certificates c LEFT JOIN documents d ON d.id = c.doc_id WHERE c.id = ?').get(String(id || ''));
    if (!c || c.student_id == null) return null;
    let p = {};
    try { p = JSON.parse(c.payload); } catch (e) { /* */ }
    return { studentId: c.student_id, student: c.student_name || String(p.student || ''), class: c.class_name || String(p.class || ''), title: c.title || '' };
  }
}

module.exports = { DocStore, MAX_HUMAN_CPS, MIN_WORDS };
