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
 * Det signerede bevis (v3) har ingen persondata og intet pseudonym: kun tekstens hash, omfang, tider, hvad der blev målt
 * (observed), om det er fra en testserver og hvornår afleveringen blev oprettet. Navn og klasse ligger i databasen
 * og vises kun for elevens egen lærer. v2-beviser (med en saltet navne-hash) vises og tjekkes stadig.
 * Ældre beviser (v1) vises offentligt kun som gyldig/ugyldig og dato.
 *
 * Hvad beviset IKKE kan: se om eleven har skrevet en tekst af efter en anden skærm/telefon. Det står på beviset.
 *
 * "Skriv i Word" (source: 'word'): elev-appen sender Word-dokumentets tekst som almindelige gemninger. Vækstbudgettet,
 * lampen (rød/grå) og AI-fraserne gælder som i skrivevinduet. Kan appen tælle tastetryk i Word-vinduet (stats.keys),
 * gælder tastetjekkene også – med en margin til autokorrektur (shared/doc.js evaluateStats). Ellers springes de over,
 * og Copilot slået til giver afslag. Appen melder selv tekst indsat fra et andet program (pasteInserted).
 * Beviset siger observed: ['word'] (+ 'vagt').
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const D = require('../../shared/doc.js');
const RET = require('./retention.js');

const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
// Grænserne for elevens egne tal (tempo, ord, diktering) står i shared/doc.js (PROOF), så øvedokumentet bruger de samme
const MAX_HUMAN_CPS = D.PROOF.MAX_HUMAN_CPS;
const SERVER_GROWTH_CPS = 15;      // serverens eget tjek mellem to gemninger
const MAX_AVG_CPS = 10;            // gennemsnit over hele skrivetiden (inkl. pauser) – ingen mennesker holder det tempo
const OBSERVE_GAP_MS = 30_000;     // længere tid uden serverens egen måling tæller som "ikke fulgt"
const GREY_MAX_SHARE = 0.10;       // højst 10 % af skrivetiden uden fuld overvågning
const GREY_MAX_MS = 3 * 60_000;    // … og højst 3 minutter
const FIRST_SAVE_BUDGET = 150;     // så meget tekst må et nyt dokument have, første gang serveren ser det (appen sender det tomme dokument straks)
const MAX_OPEN_DOCS = 30;           // diskkvote: højst 30 uafleverede dokumenter pr. elev …
const QUOTA_BYTES = 10 * 1024 * 1024; // … højst 10 MB tekst (dokumenter + afspilning) pr. elev …
const MAX_GROWTH = 3000;           // … og højst 3.000 nye tegn pr. gemning (ellers gemmes intet)
const GAP_MS = 2 * 60_000;         // længere pause mellem to gemninger tæller ikke som skrivetid
const MIN_WORDS = D.PROOF.MIN_WORDS;
const GUARD_GRACE_MS = 30_000;     // de første 30 sek. med "Venter på HolyMoly-vagten" tæller ikke som grå
const IDLE_MAX_MS = 10 * 60_000;   // grå tid UDEN vækst: højst 10 minutter …
const IDLE_MAX_SHARE = 0.15;       // … og højst 15 % af tiden
const DOWN_CPS = 2;                // mens serveren selv var nede, godtages vækst på 2 tegn/sek. …
const DOWN_MAX = 400;              // … dog højst 400 tegn pr. hul
const TEST_ISSUER = 'Testserver – må ikke bruges til bedømmelse';

/* Hvorfor beviset mangler – i elevens sprog og uden tal (shared/doc.js: samme tekster i øvedokumentet) */
const CATEGORY_TEXT = D.CATEGORY_TEXT;
/* Kort navn til "Dette dokument kan ikke længere få mærket (kl. 10.14: AI-side)" */
/* Tempolinjen i det signerede bevis (skrivevinduet). Ens for alle – hjælpemidler må ikke kunne aflæses. */
const TEMPO_CHECK = 'Intet skrevet hurtigere, end et menneske kan';
/* Lærerens egen visning: tempoet blev ikke vurderet, fordi eleven har hjælpemidler. */
const TEMPO_NOT_ASSESSED = 'Skrivetempo ikke vurderet (eleven har hjælpemidler)';
const CATEGORY_LABEL = { forbindelse: 'forbindelse', indsat: 'indsat tekst', tempo: 'skrivetempo', ai: 'AI-spor', hjaelpemiddel: 'diktering' };
/*
 * Rød lampe koster kun beviset, når den kan have skrevet teksten: AI, fjernstyring, virtuel maskine og proxy/VPN
 * (omgåelse af blokeringen) – og rød uden kategori (fx en vagt-advarsel). Anden rød (video, spil, sociale medier …)
 * er en note til læreren. '' = ingen kategori.
 */
const HARD_RED = new Set(['ai', 'remote', 'vm', 'proxy', '']);
const RED_LABEL = { ai: 'AI-side', remote: 'fjernstyring', vm: 'virtuel maskine', proxy: 'proxy eller VPN', '': 'rød lampe' };

const num = (v, max = 1e12) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : 0; };

/*
 * Skrivelogen: hvad der skete mellem to gemninger. En simpel diff i to trin: først afsnit, så ord inden for de
 * ændrede afsnit (fælles start/slut skæres fra, resten parres med LCS). Korte fælles stykker (under 20 tegn,
 * fx et mellemrum eller "og") deler ikke et stykke i to, så et indsat afsnit forbliver ét stykke.
 */
const LOG_PASTE_MAX = 2000;     // indsat tekst gemmes med højst 2.000 tegn …
const LOG_FIX_MAX = 500;        // … det fjernede ved en rettelse med højst 500
const LOG_FIX_MIN = 20;         // rettelser under 20 tegn er almindelig skrivning
const LOG_PIECE_MIN = 30;       // indsat stykke: mindst 30 tegn
const LOG_WORD_BURST = 60;      // Word: mere end 60 nye tegn på én gemning (eller 15 tegn/sek.), som ikke stod der før
const LOG_MOVE_MIN = 40;        // fortrudt (restored) egen tekst: mindst 40 tegn
const LOG_SESSION_GAP = 20 * 60_000; // ny skriveøkt efter 20 min. uden gemning (eller en ny lektion/skriveøkt)
const LOG_MAX_EVENTS = 3000;    // højst så mange rækker pr. dokument …
const LOG_MAX_TEXT = 500_000;   // … og højst så mange tegn uddrag; derefter gemmes kun de første 200 tegn af hvert uddrag
const LOG_MIN_RUN = 20;         // fælles stykker kortere end dette deler ikke et ændret stykke

/** Par af indeks (i, j), hvor a[i] === b[j], i den længste fælles delsekvens. null, hvis listerne er for store. */
function lcsPairs(a, b, maxCells = 250_000) {
  const n = a.length, m = b.length;
  if (!n || !m) return [];
  if (n * m > maxCells) return null;
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push([i, j]); i++; j++; } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++; else j++;
  }
  return out;
}

/** Ændrede stykker mellem to lister af tekststykker: [{ del, ins }] (sammensat med sep). */
function hunks(a, b, sep) {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const A = a.slice(p, a.length - s), B = b.slice(p, b.length - s);
  if (!A.length && !B.length) return [];
  const pairs = lcsPairs(A, B);
  if (!pairs) return [{ del: A.join(sep), ins: B.join(sep) }];
  // Fælles løb: kun løb på mindst LOG_MIN_RUN tegn deler stykkerne
  const runs = [];
  for (const [i, j] of pairs) {
    const r = runs[runs.length - 1];
    if (r && r.i + r.n === i && r.j + r.n === j) { r.n++; r.len += A[i].length + sep.length; } else runs.push({ i, j, n: 1, len: A[i].length });
  }
  const keep = runs.filter(r => r.len >= LOG_MIN_RUN);
  const out = [];
  let i = 0, j = 0;
  for (const r of keep.concat([{ i: A.length, j: B.length, n: 0 }])) {
    if (r.i > i || r.j > j) out.push({ del: A.slice(i, r.i).join(sep), ins: B.slice(j, r.j).join(sep) });
    i = r.i + r.n; j = r.j + r.n;
  }
  return out;
}

/**
 * Hvad der er fjernet og indsat mellem to tekster: [{ del, ins, delW, insW }] (afsnit, så ord, så tegn).
 * del/ins er skåret helt ned til tegn (til at tælle tastet og slettet); delW/insW stopper ved mellemrum (hele ord til uddrag).
 */
function diffPieces(oldText, newText) {
  if (oldText === newText) return [];
  const words = (t) => t.match(/\s+|[^\s]+/gu) || [];
  const w = (c) => c != null && !/\s/u.test(c); // del af et ord (inkl. tegnsætning)
  const out = [];
  for (const h of hunks(oldText.split('\n'), newText.split('\n'), '\n')) {
    for (const x of hunks(words(h.del), words(h.ins), '')) {
      const { del, ins } = x;
      let a = 0;
      while (a < del.length && a < ins.length && del[a] === ins[a]) a++;
      let z = 0;
      while (z < del.length - a && z < ins.length - a && del[del.length - 1 - z] === ins[ins.length - 1 - z]) z++;
      // Til hele ord: et fælles stykke, der slutter/starter midt i et ord, tæller ikke med i uddraget
      let aw = a, zw = z;
      if (aw > 0 && w(del[aw - 1]) && (w(del[aw]) || w(ins[aw]))) while (aw > 0 && w(del[aw - 1])) aw--;
      if (zw > 0 && w(del[del.length - zw]) && (w(del[del.length - zw - 1]) || w(ins[ins.length - zw - 1]))) while (zw > 0 && w(del[del.length - zw])) zw--;
      const p = { del: del.slice(a, del.length - z), ins: ins.slice(a, ins.length - z), delW: del.slice(aw, del.length - zw), insW: ins.slice(aw, ins.length - zw) };
      if (p.del || p.ins) out.push(p);
    }
  }
  return out;
}
const clip = (t, max) => (t.length > max ? t.slice(0, max) + '…' : t);

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
      -- Skrivelogen (se _planLog): indsatte udsnit, rettelser, flytninger, skrivning pr. minut, lampeskift og skriveøkter
      CREATE TABLE IF NOT EXISTS doc_events (
        doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        chars INTEGER NOT NULL DEFAULT 0,
        excerpt TEXT,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS doc_events_d ON doc_events(doc_id, ts);
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
        DELETE FROM assignment_history WHERE doc_id = OLD.id;
      END;
      -- Skrivelogen følger dokumentet (også hvis fremmednøglerne er slået fra)
      CREATE TRIGGER IF NOT EXISTS documents_log_cleanup AFTER DELETE ON documents BEGIN
        DELETE FROM doc_events WHERE doc_id = OLD.id;
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
      // Hjælpemidler (kun når læreren har slået dem til): tegn fra ordforslag og diktering
      predicted: num(s.predicted, 1e7), dictated: num(s.dictated, 1e7),
      // Word: Copilot-status, som elev-appen kunne se den i registret ('on' | 'off' | 'unknown')
      copilot: ['on', 'off', 'unknown'].includes(s.copilot) ? s.copilot : '',
      // Word: kunne appen tælle tastetryk i hele dokumentet? Kun kategorier og tider – aldrig hvilke taster.
      keys: s.keys === true,
      pasteKeys: num(s.pasteKeys, 1e6), injected: num(s.injected, 1e7), undo: num(s.undo, 1e7), untyped: num(s.untyped, 1e6),
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
    // Rød tid deles i "hård" (AI, fjernstyring …) og "blød" (video, spil …). Dokumenter fra før reglen: al rød er hård, som før.
    if (m.redHard == null) { m.redHard = m.redMs || 0; m.redSoft = 0; }
    if (!Array.isArray(m.redNote)) m.redNote = [];
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
      else if (m.lastColor === 'red') {
        m.redMs += dt;
        if (m.lastRedHard === false) m.redSoft += dt; else m.redHard += dt;
      }
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
    if (color === 'red') {
      const vs = Array.isArray(view.violations) ? view.violations : [];
      const hard = vs.filter(v => HARD_RED.has(String((v && v.category) || '')));
      m.lastRedHard = hard.length > 0 || !vs.length; // rød uden fund: som før
      if (m.lastRedHard && !m.redHardAt) { m.redHardAt = now; m.redHardCat = hard.length ? String(hard[0].category || '') : ''; }
      for (const v of hard.slice(0, 3)) if (m.red.length < 20 && !m.red.includes(v.text)) m.red.push(String(v.text).slice(0, 160));
      for (const v of vs.filter(x => !hard.includes(x)).slice(0, 3)) if (m.redNote.length < 20 && !m.redNote.includes(v.text)) m.redNote.push(String(v.text).slice(0, 160));
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
    const source = input.source === 'word' ? 'word' : '';
    let blocks;
    try { blocks = D.validateBlocks(input.blocks); } catch (e) { return { ok: false, error: e.message } }
    const title = String(input.title || '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, D.LIMITS.title);
    const text = D.normalizeText(D.textOf(blocks));
    const stats = DocStore.cleanStats(input.stats);
    let row = this.q.get.get(input.id);
    if (row && row.student_id !== student.id) return { ok: false, error: 'Ugyldigt dokument-id' };
    if (row && row.submitted) return { ok: false, error: 'Dokumentet er afleveret og kan ikke ændres' };
    // Hjemme (uden opsyn) måles fokus ikke: tiden uden fokus fra en skriveøkt hjemme lægges ikke til
    if (this._homeLesson(lessonId)) {
      let prev = 0;
      try { prev = num(JSON.parse((row && row.stats) || '{}').focusLostMs); } catch (e) { prev = 0; }
      stats.focusLostMs = prev;
    }
    const m = row ? JSON.parse(row.monitor) : Object.assign({ greenMs: 0, redMs: 0, greyMs: 0, red: [], grey: [], flags: [], lessons: [], lastTs: 0, lastLen: 0, lastColor: '', lastObs: 0, first: now }, source ? { source } : {});
    // Et dokument skrives enten i skrivevinduet eller i Word – aldrig skiftevis
    if ((m.source || '') !== source) return { ok: false, error: source ? 'Dokumentet er skrevet i HolyMoly og kan ikke fortsættes i Word' : 'Dokumentet er skrevet i Word og kan kun fortsættes i Word' };
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
    // Vækst-flag: jump = hvorfor (til skrivelogen: 'start' | 'offline' | 'hurtigt'), flag = teksten til læreren
    let jump = '', flag = '';
    if (growth > 30) {
      if (!m.lastTs) {
        // Første gang serveren ser dokumentet: fast budget på 150 tegn (forberedt tekst, fx i en redigeret documents.json)
        if (growth > FIRST_SAVE_BUDGET) { jump = 'start'; flag = `Dokumentet havde allerede ${growth} tegn, første gang HolyMoly så det`; }
      } else if (downDt > 0 && eff > 80) { jump = 'offline'; flag = `${growth} tegn blev skrevet, mens HolyMoly ikke kunne følge med (serveren var nede i ${Math.max(1, Math.round(downDt / 60000))} min.)`; }
      else if (dt - downDt > GAP_MS && eff > 80) { jump = 'offline'; flag = `${growth} tegn blev skrevet, mens HolyMoly ikke kunne følge med (${Math.round(dt / 60000)} min. uden forbindelse)`; }
      else if (dt > 0 && eff / (dt / 1000) > SERVER_GROWTH_CPS) { jump = 'hurtigt'; flag = `Tekst indsat for hurtigt: teksten voksede med ${growth} tegn på ${Math.max(1, Math.round(dt / 1000))} sek.`; }
    }
    if (flag && m.flags.length < 20) m.flags.push(flag);
    if (m.flags.length && !m.flagAt) m.flagAt = now; // hvornår (til "kan ikke længere få mærket (kl. …)")
    // Skrivelogen: hvad der blev indsat, rettet og flyttet siden sidste gemning (skrives, når dokumentet er gemt)
    let plan = null;
    try {
      plan = this._planLog(input.id, m, {
        oldText: row ? row.text : '', text, oldStats: row ? JSON.parse(row.stats || '{}') : {}, stats, view, lessonId, now, dt, jump, word: !!source,
      });
    } catch (e) { plan = null; /* skrivelogen må aldrig stoppe en gemning */ }
    // Grå tid siden sidste gemning tæller mod beviset, hvis teksten voksede imens – ellers som grå tid uden vækst
    if (growth > 0) m.greyCounted += m.greyPending;
    else m.greyIdle = (m.greyIdle || 0) + m.greyPending;
    m.greyPending = 0;
    if (lessonId && !m.lessons.includes(lessonId) && m.lessons.length < 50) m.lessons.push(lessonId);
    m.lastTs = now; m.lastLen = text.length;
    if (row) this.q.upd.run(title, blocksJson, text, JSON.stringify(stats), JSON.stringify(m), now, input.id);
    else this.q.ins.run(input.id, student.id, student.class_id, title, blocksJson, text, JSON.stringify(stats), JSON.stringify(m), now, now);
    if (plan) try { this._writeLog(input.id, plan); } catch (e) { /* som ovenfor */ }
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

  /*
   * Skrivelogen ("hvordan blev teksten skrevet"): kaldes af save() for hver gemning. Sammenligner forrige tekst med den nye
   * og returnerer rækkerne til doc_events (skrives af _writeLog, når dokumentet er gemt). Ændrer m.logState.
   *  - 'indsat':   et stykke, der ikke kan forklares som tastning: gemningen fik et vækst-flag, appen meldte indsat tekst
   *                (pasteInserted, eller blokeret indsæt + et spring), eller (Word) over 60 nye tegn på én gemning.
   *                excerpt = selve teksten (højst 2.000 tegn). detail.reason = start | offline | hurtigt | paste | word.
   *  - 'flyttet':  et stykke (der ellers ville være 'indsat', eller som skrivevinduets "fortryd" bragte tilbage), der allerede
   *                stod i dokumentet (kopi/flyt af egen tekst). Kun antal tegn.
   *  - 'rettelse': et fjernet eller erstattet stykke over 20 tegn. excerpt = det fjernede (højst 500 tegn).
   *  - 'skrivning': tastet og slettet pr. minut (én række pr. minut: chars = tilføjet, detail { added, removed, last }).
   *  - 'blokeret': indsæt blev blokeret (eller Word-udklipsholderen tømt). detail.n.
   *  - 'lampe':    lampen skiftede (detail { color, why }). Rød/grå mellem to gemninger: detail.between = [fra, til].
   *  - 'start':    en ny skriveøkt (første gemning, ny lektion/skriveøkt eller 20 min. uden gemning). detail.lesson.
   */
  _planLog(id, m, o) {
    const { oldText, text, oldStats, stats, view, lessonId, now, dt, jump, word } = o;
    const ev = [];
    const L = m.logState || (m.logState = { c: '', red: 0, note: 0, grey: 0, lesson: null });
    const prevTs = m.lastTs || 0;
    // Skriveøkt
    if (!prevTs || now - prevTs > LOG_SESSION_GAP || (lessonId && L.lesson && lessonId !== L.lesson)) ev.push({ ts: now, kind: 'start', chars: 0, detail: { lesson: lessonId || null } });
    if (lessonId) L.lesson = lessonId;
    // Lampen (som serveren selv målte den: view ved gemningen og m.red/m.redNote/m.grey fra målingerne imellem)
    const color = view && (view.color === 'green' || view.color === 'red') ? view.color : 'grey';
    const vs = view && Array.isArray(view.violations) ? view.violations.map(v => String((v && v.text) || '')).filter(Boolean) : [];
    const why = color === 'red' ? vs.slice(0, 3).join('; ') : color === 'grey' ? String((view && view.greyReason) || 'Overvågningen var ikke komplet') : '';
    const red = m.red || [], note = m.redNote || [], grey = m.grey || [];
    const newRed = red.slice(L.red).concat(note.slice(L.note));
    const newGrey = grey.slice(L.grey);
    if (prevTs && newRed.length && color !== 'red') {
      const at = m.redHardAt > prevTs && m.redHardAt <= now ? m.redHardAt : prevTs;
      ev.push({ ts: at, kind: 'lampe', chars: 0, detail: { color: 'red', why: newRed.join('; ').slice(0, 300), between: [prevTs, now] } });
    }
    if (prevTs && newGrey.length && color !== 'grey') ev.push({ ts: prevTs, kind: 'lampe', chars: 0, detail: { color: 'grey', why: newGrey.join('; ').slice(0, 300), between: [prevTs, now] } });
    if (color !== L.c ? (L.c || color !== 'green') : color === 'red' && newRed.length) {
      ev.push({ ts: now, kind: 'lampe', chars: 0, detail: { color, why: (color === 'red' && !why ? newRed.join('; ') : why).slice(0, 300) } });
    }
    L.c = color; L.red = red.length; L.note = note.length; L.grey = grey.length;
    // Indsæt blokeret / tekst indsat fra et andet program (appens egne tal; kun stigninger)
    const n = (s, k) => num(s && s[k]);
    const blocked = Math.max(0, n(stats, 'pasteBlocked') + n(stats, 'dropBlocked') - n(oldStats, 'pasteBlocked') - n(oldStats, 'dropBlocked'));
    const pasted = Math.max(0, n(stats, 'pasteInserted') - n(oldStats, 'pasteInserted'));
    const restored = n(stats, 'restored') > n(oldStats, 'restored');
    if (blocked) ev.push({ ts: now, kind: 'blokeret', chars: 0, detail: { n: blocked } });
    // Teksten: hvad er indsat, flyttet og rettet
    const pieces = diffPieces(oldText, text);
    const wordLimit = Math.max(LOG_WORD_BURST, SERVER_GROWTH_CPS * (dt || 0) / 1000);
    const dels = pieces.map(p => p.delW.trim());
    const usedDel = new Set();
    const typedPieces = [];
    let added = 0, removed = 0, found = false;
    for (const p of pieces) {
      const ins = p.insW.trim();
      if (!ins) { added += p.ins.length; continue; }
      const len = ins.length;
      const reason = jump && len > LOG_PIECE_MIN ? jump : pasted && len > LOG_PIECE_MIN ? 'paste' : blocked && len > LOG_WORD_BURST ? 'paste' : word && len > wordLimit ? 'word' : '';
      // Flyttet/fortrudt egen tekst: kun når stykket ellers ville være indsat, eller skrivevinduet meldte "fortryd" (restored)
      if ((reason || (restored && len >= LOG_MOVE_MIN)) && len >= LOG_FIX_MIN) {
        const d = dels.findIndex((x, i) => !usedDel.has(i) && x === ins);
        if (d >= 0) usedDel.add(d);
        if (d >= 0 || this._knownText(id, oldText, ins, !!reason)) { ev.push({ ts: now, kind: 'flyttet', chars: len, detail: null }); found = true; continue; }
      }
      if (reason) { ev.push({ ts: now, kind: 'indsat', chars: len, excerpt: clip(ins, LOG_PASTE_MAX), detail: { reason } }); found = true; continue; }
      added += p.ins.length;
      typedPieces.push(p);
    }
    // Vækst-flag uden et enkelt stort stykke (fx flere mindre stykker): det største stykke er det indsatte
    if (jump && !found && typedPieces.length) {
      const big = typedPieces.reduce((a, b) => (b.insW.trim().length > a.insW.trim().length ? b : a));
      const ins = big.insW.trim();
      if (ins && !this._knownText(id, oldText, ins, true)) {
        added -= big.ins.length;
        ev.push({ ts: now, kind: 'indsat', chars: ins.length, excerpt: clip(ins, LOG_PASTE_MAX), detail: { reason: jump } });
      }
    }
    pieces.forEach((p, i) => {
      if (usedDel.has(i) || !p.del) return;
      removed += p.del.length;
      const d = p.delW.trim();
      if (d.length > LOG_FIX_MIN) ev.push({ ts: now, kind: 'rettelse', chars: d.length, excerpt: clip(d, LOG_FIX_MAX), detail: { replaced: p.insW.trim().length } });
    });
    if (added > 0 || removed > 0) ev.push({ ts: now, kind: 'skrivning', chars: added, detail: { added, removed } });
    return ev;
  }

  /**
   * Har stykket stået i dokumentet før? Forrige tekst og det fjernede ved rettelser – og (deep, kun når stykket ellers
   * ville blive logget som indsat) de seneste 60 versioner i afspilningen.
   */
  _knownText(id, oldText, piece, deep) {
    if (oldText.includes(piece)) return true;
    if (this.db.prepare("SELECT 1 AS x FROM doc_events WHERE doc_id = ? AND kind = 'rettelse' AND instr(excerpt, ?) > 0 LIMIT 1").get(id, piece)) return true;
    return !!(deep && this.db.prepare('SELECT 1 AS x FROM (SELECT text FROM doc_versions WHERE doc_id = ? ORDER BY ts DESC LIMIT 60) WHERE instr(text, ?) > 0 LIMIT 1').get(id, piece));
  }

  /** Skriv skrivelogens rækker. Skrivning samles i én række pr. minut; højst LOG_MAX_EVENTS rækker pr. dokument. */
  _writeLog(id, ev) {
    if (!ev || !ev.length) return;
    const used = this.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(length(excerpt)), 0) AS chars FROM doc_events WHERE doc_id = ?').get(id);
    let count = used.n, chars = used.chars;
    const ins = this.db.prepare('INSERT INTO doc_events (doc_id, ts, kind, chars, excerpt, detail) VALUES (?,?,?,?,?,?)');
    for (const e of ev) {
      if (e.kind === 'skrivning') {
        const min = Math.floor(e.ts / 60_000) * 60_000;
        const r = this.db.prepare("SELECT rowid AS r, detail FROM doc_events WHERE doc_id = ? AND kind = 'skrivning' AND ts >= ? AND ts < ? ORDER BY ts LIMIT 1").get(id, min, min + 60_000);
        if (r) {
          let d = {};
          try { d = JSON.parse(r.detail || '{}'); } catch (x) { /* */ }
          const added = (Number(d.added) || 0) + e.detail.added, removed = (Number(d.removed) || 0) + e.detail.removed;
          this.db.prepare('UPDATE doc_events SET chars = ?, detail = ? WHERE rowid = ?').run(added, JSON.stringify({ added, removed, last: e.ts }), r.r);
          continue;
        }
      }
      if (count >= LOG_MAX_EVENTS) continue;
      let excerpt = e.excerpt == null ? null : e.excerpt;
      if (excerpt && chars + excerpt.length > LOG_MAX_TEXT) excerpt = clip(excerpt, 200); // pladsen til uddrag er brugt
      ins.run(id, e.ts, e.kind, Math.round(e.chars || 0), excerpt, e.detail ? JSON.stringify(e.detail) : null);
      count++; chars += excerpt ? excerpt.length : 0;
    }
  }

  /**
   * Skrivelogen til læreren (kun afleverede dokumenter – index.js tjekker det).
   * { summary: { started, submitted, minutesWriting, sessions, words, typed?, deleted?, pastes, pastedChars, corrections, moves, source, expired? },
   *   events: [{ ts, kind, chars, excerpt?, detail? }] (ældste først, nyeste sidst; 'slut' og 'afleveret' beregnes her),
   *   pastes: [{ ts, chars, excerpt, reason }] }
   */
  log(id) {
    const row = this.q.get.get(String(id || ''));
    if (!row) return null;
    let m = {}, s = {};
    try { m = JSON.parse(row.monitor || '{}'); s = JSON.parse(row.stats || '{}'); } catch (e) { /* */ }
    const word = m.source === 'word';
    const rows = this.db.prepare('SELECT ts, kind, chars, excerpt, detail FROM doc_events WHERE doc_id = ? ORDER BY ts, rowid').all(row.id);
    let lessonOf = null;
    try { lessonOf = this.db.prepare('SELECT kind, student_id FROM lessons WHERE id = ?'); } catch (e) { /* ingen tabel */ }
    const events = [];
    let sessions = 0, last = 0;
    const close = () => { if (sessions && last) events.push({ ts: last, kind: 'slut', chars: 0 }); };
    for (const r of rows) {
      let d = null;
      try { d = r.detail ? JSON.parse(r.detail) : null; } catch (e) { d = null; }
      if (r.kind === 'start') {
        close();
        sessions++;
        // Hvor økten foregik (lektionens id sendes ikke til dashboardet)
        let place = '';
        const l = d && d.lesson && lessonOf ? lessonOf.get(Number(d.lesson)) : null;
        if (l) place = l.kind === 'hjemme' || l.student_id != null ? 'hjemme' : 'lektion';
        d = place ? { place } : null;
      }
      const e = { ts: r.ts, kind: r.kind, chars: r.chars };
      if (r.excerpt != null) e.excerpt = r.excerpt;
      if (d) e.detail = d;
      events.push(e);
      last = Math.max(last, r.ts, (d && Number(d.last)) || 0);
    }
    if (!sessions && rows.length) sessions = 1; // dokumenter fra før økterne blev logget
    close();
    if (row.submitted) events.push({ ts: row.submitted, kind: 'afleveret', chars: 0 });
    events.sort((a, b) => a.ts - b.ts);
    const totalMs = (Number(m.greenMs) || 0) + (Number(m.redMs) || 0) + (Number(m.greyMs) || 0);
    const pastes = events.filter(e => e.kind === 'indsat');
    const summary = {
      started: Number(m.first) || row.created, submitted: row.submitted || null,
      minutesWriting: totalMs > 0 ? Math.max(1, Math.round(totalMs / 60_000)) : 0, sessions, words: D.wordCount(row.text),
      pastes: pastes.length, pastedChars: pastes.reduce((a, e) => a + e.chars, 0),
      corrections: events.filter(e => e.kind === 'rettelse').length, moves: events.filter(e => e.kind === 'flyttet').length,
      source: word ? 'word' : 'holymoly',
    };
    // Tastestatistik findes kun fra skrivevinduet (og fra Word, hvis appen sender den)
    if (!word || num(s.typed) > 0) { summary.typed = num(s.typed); summary.deleted = num(s.deleted); }
    if (m.reduced) summary.expired = true; // skrivedetaljerne er slettet efter fristen (retention.js)
    return { summary, events, pastes: pastes.map(e => ({ ts: e.ts, chars: e.chars, excerpt: e.excerpt || '', reason: (e.detail && e.detail.reason) || '' })) };
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
  evaluate(row, aids) {
    const m = JSON.parse(row.monitor);
    const s = JSON.parse(row.stats);
    const text = row.text;
    aids = Array.isArray(aids) ? D.cleanAids(aids) : this.aidsOf(row.student_id);
    const word = m.source === 'word'; // Word: ingen tastestatistik
    const reasons = [];
    const notes = [];
    const cats = new Set();
    const no = (cat, why) => { reasons.push(why); cats.add(cat); };
    const words = D.wordCount(text);
    const totalMs = m.greenMs + m.redMs + m.greyMs;
    const greyCounted = m.greyCounted == null ? m.greyMs : m.greyCounted; // grå tid uden gemning bagefter: teksten voksede ikke
    // Elevens egne tal og teksten (samme vurdering som øvedokumentet i skrivevinduet – shared/doc.js)
    const own = D.evaluateStats(text, s, { minWords: this.minWords, aids, word });
    const ownNo = (cat) => { for (const f of own.found) if (f.cat === cat) no(cat, f.why); };
    ownNo('kort');
    const redHard = m.redHard == null ? m.redMs : m.redHard;
    if (redHard > 0 || m.red.length) no('rod', 'Rød lampe mens teksten blev skrevet: ' + (m.red.join('; ') || 'forbudt aktivitet'));
    if (greyCounted > GREY_MAX_MS || (totalMs > 0 && greyCounted / totalMs > GREY_MAX_SHARE)) {
      no('forbindelse', `Overvågningen var ikke komplet i ${Math.max(1, Math.round(greyCounted / 60000))} min., mens teksten voksede` + (m.grey.length ? ' (' + m.grey.join('; ') + ')' : ''));
    }
    // Grå tid uden vækst (fx forbindelsen væk, mens dokumentet var åbent): over 10 min. eller 15 % af tiden
    const idle = (m.greyIdle || 0) + (m.greyPending || 0);
    if (!cats.has('forbindelse') && (idle > IDLE_MAX_MS || (totalMs > 0 && idle / totalMs > IDLE_MAX_SHARE))) {
      no('forbindelse', `Overvågningen var ikke komplet i ${Math.max(1, Math.round(idle / 60000))} min., mens dokumentet var åbent` + (m.grey.length ? ' (' + m.grey.join('; ') + ')' : ''));
    }
    ownNo('indsat');
    for (const f of m.flags) no(/ikke kunne følge med/.test(f) ? 'forbindelse' : 'indsat', f);
    ownNo('tempo');
    // Serverens eget gennemsnit over hele skrivetiden gælder også med hjælpemidler (det kan ingen hjælpemidler forklare)
    if (text.length > 600 && totalMs > 0 && text.length / (totalMs / 1000) > MAX_AVG_CPS) no('tempo', `Teksten er længere, end det er muligt at skrive på ${Math.max(1, Math.round(totalMs / 60000))} min.`);
    ownNo('ai');
    ownNo('hjaelpemiddel');
    notes.push(...own.notes);
    // Anden rød end AI, fjernstyring og virtuelle maskiner: kun en note
    if ((m.redSoft || 0) > 0 || (m.redNote || []).length) notes.push(`Rød lampe i ${Math.max(1, Math.round((m.redSoft || 0) / 1000))} sek. (${(m.redNote || []).join('; ') || 'anden aktivitet'}) – kun en oplysning, ikke et afslag`);
    // Hjemme er tid uden for skrivevinduet elevens egen sag: ingen fokus-note (place='hjemme')
    if (s.focusLostMs > 60_000 && !(({ home, lesson }) => home && !lesson)(this.placeOf(row.id))) notes.push(`${word ? 'Word' : 'Skrivevinduet'} var ikke i fokus i ${Math.round(s.focusLostMs / 60000)} min.`);
    if (m.greyMs > 0 && !cats.has('forbindelse')) {
      const quiet = Math.max(0, m.greyMs - greyCounted);
      notes.push(`Kort tid uden fuld overvågning (${Math.max(1, Math.round(m.greyMs / 1000))} sek.` + (quiet >= 1000 ? `, heraf ${Math.round(quiet / 1000)} sek. hvor teksten ikke voksede` : '') + ')');
    }
    const facts = {
      words, chars: text.length, writingMinutes: Math.max(1, Math.round(totalMs / 60000)),
      typed: s.typed, deleted: s.deleted, pasteBlocked: s.pasteBlocked + s.dropBlocked,
      // Word: talte appen tastetryk? (skrivevinduet tæller altid)
      keys: word ? s.keys === true : true,
      monitoredShare: totalMs ? Math.round((m.greenMs / totalMs) * 100) : 0,
      started: m.first, lessons: m.lessons.length,
    };
    /*
     * Til eleven: kategorier uden tal. Kun 'kort' kan rettes (skriv videre). De andre er permanente for dokumentet:
     * så står der hvornår (at) og et kort navn (label), og eleven får at vide, at et nyt dokument kan få mærket.
     */
    const categories = Object.keys(CATEGORY_TEXT).filter(k => cats.has(k)).map((key) => {
      if (key === 'kort') return { key, text: `Teksten er for kort. Et bevis kræver mindst ${this.minWords} ord.`, fixable: true, need: this.minWords };
      const c = { key, text: (word && D.CATEGORY_TEXT_WORD[key]) || CATEGORY_TEXT[key], fixable: false, label: key === 'rod' ? RED_LABEL[m.redHardCat || ''] || RED_LABEL[''] : CATEGORY_LABEL[key] };
      const at = key === 'rod' ? m.redHardAt : key === 'indsat' && m.flags.some(f => !/ikke kunne følge med/.test(f)) ? m.flagAt : 0;
      if (at) c.at = at;
      return c;
    });
    return { ok: reasons.length === 0, reasons, notes, facts, categories };
  }

  /** Elevens hjælpemidler (students.aids, sat af læreren). Kun til vurderingen – aldrig i beviset. */
  aidsOf(studentId) {
    try {
      const r = this.db.prepare('SELECT aids FROM students WHERE id = ?').get(Number(studentId));
      return D.cleanAids(r && r.aids ? JSON.parse(r.aids) : []);
    } catch (e) { return []; }
  }

  /**
   * Hvad HolyMoly målte (v3): altid skrivevinduet (eller 'word' for et dokument skrevet i Word), og vagten kun hvis klassen kræver den (hub.policyFor)
   * og vagten fulgte hele forløbet (ingen grå tid, fordi vagten manglede, ikke svarede eller havde en fejl).
   */
  _observed(row, observed) {
    const out = [JSON.parse(row.monitor).source === 'word' ? 'word' : 'skrivevindue'];
    if (Array.isArray(observed) && observed.includes('vagt')) {
      const m = JSON.parse(row.monitor);
      const gone = (m.grey || []).some(g => /vagten (er ikke tilknyttet|findes ikke|svarer ikke|har en fejl)/i.test(g));
      if (!gone) out.push('vagt');
    }
    return out;
  }

  /**
   * Aflever: vurdér og udsted evt. bevis.
   * meta: { studentName, className, teacherName, issuer, view, force, observed, assignmentCreated, aids, extra }
   *  - observed: fra hub.policyFor (['skrivevindue'] + 'vagt', når vagten kræves)
   *  - assignmentCreated: hvornår afleveringen, dokumentet er skrevet til, blev oprettet (ms) – kun datoen kommer i beviset
   *  - aids: elevens hjælpemidler (fx ['ordforslag']); så vurderes skrivetempoet ikke
   *  - extra: skrevet i ekstra tid efter klassens lektion (kind 'ekstra')
   * Giver vurderingen ikke et bevis, låses dokumentet IKKE, medmindre eleven har valgt "Aflever alligevel" (force).
   * Så svarer serveren { ok: false, confirm: true, reasons, categories }, og eleven kan skrive videre.
   */
  submit(student, id, meta, now = Date.now()) {
    const row = this.q.get.get(String(id || ''));
    if (!row || row.student_id !== student.id) return { ok: false, error: 'Dokumentet findes ikke' };
    if (row.submitted) return Object.assign({ ok: true, already: true }, JSON.parse(row.result || '{}'));
    if (meta.view !== undefined) { this.observe(row.id, meta.view, now); }
    // Hjælpemidler: fra hubben (meta.aids) – ellers fra elevens række. De står aldrig i beviset.
    const aids = Array.isArray(meta.aids) ? D.cleanAids(meta.aids) : this.aidsOf(row.student_id);
    const ev = this.evaluate(this.q.get.get(row.id), aids);
    const where = this.placeOf(row.id);
    const place = where.home ? (where.lesson ? 'lektion og hjemme' : 'hjemme') : 'lektion';
    ev.facts.place = place;
    // Kun til læreren (documents.result) – aldrig i beviset
    if (aids.length && JSON.parse(row.monitor).source !== 'word' && !ev.notes.includes(TEMPO_NOT_ASSESSED)) ev.notes.push(TEMPO_NOT_ASSESSED);
    if (!ev.ok && !meta.force) {
      return {
        ok: false, confirm: true, reasons: ev.reasons, notes: ev.notes, categories: ev.categories,
        error: 'Beviset vil mangle: ' + ev.categories.map(c => c.text).join(' '),
      };
    }
    const kind = where.home ? 'hjemme' : meta.extra ? 'ekstra' : 'klasse';
    const observed = this._observed(this.q.get.get(row.id), meta.observed);
    const test = this.testServer;
    let cert = null;
    if (ev.ok) {
      const certId = crypto.randomBytes(12).toString('base64url');
      const issuer = this.testServer ? (meta.issuer ? `${meta.issuer} (${TEST_ISSUER})` : TEST_ISSUER) : String(meta.issuer || '');
      const word = observed.includes('word');
      const checks = [word ? 'Skrevet i Word gennem HolyMoly – ingen tekst indsat fra andre programmer' : 'Tastet i HolyMolys skrivevindue – indsæt blokeret'];
      if (observed.includes('vagt')) checks.push('HolyMoly-vagten blokerede AI på computeren');
      checks.push('Ingen rød lampe undervejs');
      // Neutral tempolinje: den samme for alle elever, så beviset aldrig afslører hjælpemidler (ordblindhed).
      // Word med talte tastetryk: teksten passer med dem, og tempoet er vurderet som i skrivevinduet
      if (word && ev.facts.keys) checks.push('Teksten passer med tastetrykkene i Word', TEMPO_CHECK);
      else checks.push(word ? 'Teksten voksede i et menneskeligt tempo' : TEMPO_CHECK);
      checks.push('Ingen ordrette fraser fra en AI-chat i teksten');
      const created = Number(meta.assignmentCreated) > 0 ? new Date(Number(meta.assignmentCreated)).toLocaleDateString('sv-SE', { timeZone: 'Europe/Copenhagen' }) : null;
      // Fast rækkefølge af felter – det er præcis denne tekst der signeres (v3).
      // Ingen navne, klasse, lærer eller pseudonym: intet felt kobler to beviser fra samme elev sammen.
      const payload = JSON.stringify({
        v: 3, id: certId,
        sha256: crypto.createHash('sha256').update(row.text, 'utf8').digest('hex'),
        words: ev.facts.words, started: Number(ev.facts.started) || null, submitted: now,
        kind, observed, test, assignmentCreated: created,
        checks, issuer, keyId: this.keyId,
      });
    const sig = crypto.sign(null, Buffer.from(payload), this.privateKey).toString('base64');
      this.db.prepare('INSERT INTO certificates (id, doc_id, payload, sig, created, student_name, class_name, text_sha256) VALUES (?,?,?,?,?,?,?,?)')
        .run(certId, row.id, payload, sig, now, String(meta.studentName || ''), String(meta.className || ''), JSON.parse(payload).sha256);
      cert = { id: certId };
    }
    const result = { certId: cert ? cert.id : null, reasons: ev.reasons, notes: ev.notes, facts: ev.facts, categories: ev.categories, kind, observed, test };
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

  /** Er lektionen en skriveøkt hjemme? */
  _homeLesson(lessonId) {
    if (!Number.isInteger(Number(lessonId))) return false;
    try { return !!this.db.prepare("SELECT 1 FROM lessons WHERE id = ? AND (kind = 'hjemme' OR student_id IS NOT NULL)").get(Number(lessonId)); } catch (e) { return false; }
  }

  /** Blev dokumentet skrevet i timen, hjemme i en skriveøkt – eller begge? */
  placeOf(id) {
    const row = this.q.get.get(String(id || ''));
    const m = row ? JSON.parse(row.monitor) : {};
    const ids = (m.lessons || []).map(Number).filter(Number.isInteger);
    if (!ids.length) return { home: false, lesson: true };
    const solo = this.db.prepare(`SELECT COUNT(*) AS n FROM lessons WHERE (kind = 'hjemme' OR student_id IS NOT NULL) AND id IN (${ids.map(() => '?').join(',')})`).get(...ids).n;
    // homeGone: skriveøkter hjemme, der er slettet efter fristen (retention.js) – dokumentet blev stadig skrevet hjemme
    const gone = Array.isArray(m.homeGone) ? ids.filter(i => m.homeGone.map(Number).includes(i)).length : 0;
    return { home: solo + gone > 0, lesson: solo + gone < ids.length };
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
      // Mærket (v3): hvad der blev målt, og om beviset er fra en testserver. Ældre afleveringer har ikke observed.
      kind: res ? res.kind : undefined, observed: res && Array.isArray(res.observed) ? res.observed : undefined,
      test: res && typeof res.test === 'boolean' ? res.test : this.testServer,
      source: JSON.parse(r.monitor).source === 'word' ? 'word' : 'holymoly',
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
    if (p.v !== 2 && p.v !== 3) return Object.assign({ v: Number(p.v) || 1, legacy: true, valid, submitted: Number(p.submitted) || c.created }, docDeleted ? { docDeleted } : {});
    return { v: p.v, payload: p, signed: c.payload, sig: c.sig, publicKey: this.publicPem, valid, docDeleted };
  }

  /**
   * Tjek-siden: find beviser ud fra tekstens sha256 (indekset certificates_sha). Kun beviser udstedt af denne server.
   * Svarer kun med kode, dato og mærke – aldrig navn, klasse eller tekst. Udløbne beviser og ugyldige signaturer tæller ikke.
   * Returnerer [{ sha256, id, code, date, kind, observed, test }] (id er kun til at tjekke ejerskab hos kalderen).
   */
  findBySha(hashes) {
    const list = [...new Set((Array.isArray(hashes) ? hashes : []).map(String).filter(h => /^[0-9a-f]{64}$/.test(h)))].slice(0, 8);
    const q = this.db.prepare('SELECT id, payload, sig, created, expired FROM certificates WHERE text_sha256 = ? ORDER BY created DESC');
    const out = [];
    for (const sha of list) {
      for (const c of q.all(sha)) {
        if (c.expired) continue;
        if (!crypto.verify(null, Buffer.from(c.payload), this.publicKey, Buffer.from(c.sig, 'base64'))) continue;
        let p = {};
        try { p = JSON.parse(c.payload); } catch (e) { continue; }
        if (p.v !== 3 && p.v !== 2) continue;
        const submitted = Number(p.submitted) || c.created;
        out.push({
          sha256: sha, id: c.id, code: 'HM-' + c.id.slice(0, 8).toUpperCase(),
          date: new Date(submitted).toLocaleDateString('sv-SE', { timeZone: 'Europe/Copenhagen' }),
          kind: p.v === 3 ? p.kind : p.place, observed: Array.isArray(p.observed) ? p.observed : undefined, test: p.test === true,
        });
      }
    }
    return out;
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

module.exports = { DocStore, MAX_HUMAN_CPS, MIN_WORDS, TEMPO_CHECK };
