'use strict';
/*
 * Målinger til piloten: "Var det forkert?" (feedback) og pilottallene (npm run enkel -- pilottal).
 *
 * KUN aggregerede tal for hele skolen pr. måned. Der er bevidst INGEN opdeling pr. lærer, klasse eller elev, ingen navne
 * og ingen tælling af AI-forsøg – det er ikke et rektor-dashboard (test/pilottal.test.js låser det fast).
 * k-anonymitet: et tal, der bygger på færre end K = 5 (lektioner, lampe-episoder, afleveringer eller markeringer),
 * vises ikke – feltet er tomt, og noten siger "færre end 5".
 *
 * feedback: én række pr. "Var det forkert?" – kun dag, art ('lampe' | 'afslag'), årsagskode og bevistype
 * ('klasse' | 'hjemme' | 'word'). Ingen elev, ingen lærer, intet klokkeslæt. Slettes efter AUDIT_DAYS (retention.js).
 */
const ACRules = require('../../shared/rules.js');
const D = require('../../shared/doc.js');

const K = 5;
const KINDS = ['lampe', 'afslag'];
const SOURCES = ['klasse', 'hjemme', 'word'];
// Årsagskoder: lampens kategorier (rules.js), afslagets kategorier (doc.js), 'graa' og 'andet'
const REASONS = new Set([...Object.keys(ACRules.CATEGORIES), ...Object.keys(D.CATEGORY_TEXT), 'graa', 'andet']);

function ensure(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY,
    day TEXT NOT NULL,
    kind TEXT NOT NULL,
    reason TEXT NOT NULL,
    source TEXT NOT NULL
  )`);
}

/** "Var det forkert?": gem kun art, årsagskode, bevistype og dag. Returnerer { ok } eller { ok: false, error }. */
function record(db, b, now = Date.now()) {
  ensure(db);
  const kind = String((b && b.kind) || ''), reason = String((b && b.reason) || ''), source = String((b && b.source) || '');
  if (!KINDS.includes(kind)) return { ok: false, error: 'Ukendt art' };
  if (!SOURCES.includes(source)) return { ok: false, error: 'Ukendt bevistype' };
  db.prepare('INSERT INTO feedback (day, kind, reason, source) VALUES (?,?,?,?)').run(new Date(now).toISOString().slice(0, 10), kind, REASONS.has(reason) ? reason : 'andet', source);
  return { ok: true };
}

const month = (ts) => new Date(Number(ts)).toISOString().slice(0, 7);
const median = (a) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
const LABEL_TO_CAT = Object.fromEntries(Object.entries(ACRules.CATEGORIES).map(([k, v]) => [v.label, k]));
/** Rød årsag -> kategori (teksten er "Kategori: vært" – værten tages aldrig med). */
function redCat(reason) {
  const label = String(reason || '').split(':')[0].trim();
  return LABEL_TO_CAT[label] || (/vagt/i.test(label) ? 'vagt' : 'andet');
}
/** Grå årsag -> en kort, generel tekst (intet efter kolon eller parentes). */
function greyCat(reason) {
  const r = String(reason || '').split(/[:(]/)[0].trim().slice(0, 60);
  return r || 'ukendt';
}

/**
 * Pilottallene for perioden [from, to). Returnerer rækker { month, metric, reason, value, n, note } – aldrig andet.
 * FORBUDT her: GROUP BY lærer, klasse eller elev, navne og AI-forsøg.
 */
function stats(db, { from = 0, to = Date.now() } = {}) {
  ensure(db);
  const rows = [];
  const add = (m, metric, reason, value, n) => {
    const hide = n < K;
    rows.push({ month: m, metric, reason: reason || '', value: hide ? '' : value, n: hide ? '' : n, note: hide ? `færre end ${K}` : '' });
  };
  const q = (sql, ...a) => { try { return db.prepare(sql).all(...a); } catch (e) { return []; } };

  // 1) Klassens lektioner: tid til alle er grønne, og grå/røde minutter pr. årsag (lesson_colors – slettes efter LOG_RETENTION_DAYS)
  const lessons = q("SELECT id, started, COALESCE(ended, ends_at) AS stop FROM lessons WHERE started >= ? AND started < ? AND student_id IS NULL AND (kind IS NULL OR kind != 'hjemme')", from, to);
  const byMonth = new Map();
  const get = (m) => { if (!byMonth.has(m)) byMonth.set(m, { lessons: 0, toGreen: [], notAll: 0, minutes: new Map(), red: 0 }); return byMonth.get(m); };
  for (const l of lessons) {
    const agg = get(month(l.started));
    const cs = q('SELECT student_id, ts, color, reason FROM lesson_colors WHERE lesson_id = ? ORDER BY student_id, ts', l.id);
    if (!cs.length) continue;
    agg.lessons++;
    const per = new Map();
    for (const c of cs) { if (!per.has(c.student_id)) per.set(c.student_id, []); per.get(c.student_id).push(c); }
    // "Uden HolyMoly (andet udstyr)": hverken grå minutter eller "ikke alle blev grønne"
    for (const [sid, list] of per) if (list.every(c => c.color === 'other')) per.delete(sid);
    let lastGreen = 0, all = true;
    for (const list of per.values()) {
      const g = list.find(c => c.color === 'green');
      if (!g) all = false; else lastGreen = Math.max(lastGreen, g.ts);
      list.forEach((c, i) => {
        if (c.color === 'green' || c.color === 'other') return;
        const end = i + 1 < list.length ? list[i + 1].ts : Number(l.stop) || c.ts;
        const min = Math.max(0, Math.min(end, Number(l.stop) || end) - c.ts) / 60_000;
        let key;
        if (c.color === 'red') {
          const cat = redCat(c.reason);
          if (cat === 'ai') return; // AI-forsøg tælles ikke i pilottallene
          key = 'rød|' + cat;
          agg.red++;
        } else key = 'grå|' + greyCat(c.reason);
        const cur = agg.minutes.get(key) || { min: 0, n: 0 };
        cur.min += min; cur.n++;
        agg.minutes.set(key, cur);
      });
    }
    if (all && lastGreen) agg.toGreen.push((lastGreen - l.started) / 60_000); else agg.notAll++;
  }
  // 2) Afleveringer: andel med mærke og afslag pr. årsag
  const docs = new Map();
  for (const d of q('SELECT submitted, cert_id, result, monitor FROM documents WHERE submitted >= ? AND submitted < ?', from, to)) {
    const m = month(d.submitted);
    if (!docs.has(m)) docs.set(m, { n: 0, cert: 0, rejected: 0, reasons: new Map() });
    const a = docs.get(m);
    a.n++;
    if (d.cert_id) { a.cert++; continue; }
    a.rejected++;
    let cats = [];
    try { cats = (JSON.parse(d.result || '{}').categories || []).map(c => c.key); } catch (e) { /* */ }
    for (const c of new Set(cats)) a.reasons.set(c, (a.reasons.get(c) || 0) + 1);
  }
  // 3) "Var det forkert?"
  const fb = new Map();
  for (const f of q('SELECT day, kind, reason, source FROM feedback WHERE day >= ? AND day < ?', new Date(from).toISOString().slice(0, 10), new Date(to).toISOString().slice(0, 10) + 'z')) {
    const m = f.day.slice(0, 7);
    if (!fb.has(m)) fb.set(m, { lampe: 0, afslag: 0, by: new Map() });
    const a = fb.get(m);
    a[f.kind]++;
    const key = f.kind + '|' + f.reason + '|' + f.source;
    a.by.set(key, (a.by.get(key) || 0) + 1);
  }
  // 4) Driftsforstyrrelser (serveren stoppede uden at lukke pænt) og åbnede afspilninger
  const runs = q('SELECT start, clean FROM server_runs WHERE start >= ? AND start < ? ORDER BY start', from, to);
  const crashes = new Map();
  runs.slice(0, -1).forEach(r => { if (!r.clean) crashes.set(month(r.start), (crashes.get(month(r.start)) || 0) + 1); });
  const replays = new Map();
  for (const r of q("SELECT ts FROM audit_log WHERE action = 'afspillede dokument' AND ts >= ? AND ts < ?", from, to)) replays.set(month(r.ts), (replays.get(month(r.ts)) || 0) + 1);

  const months = [...new Set([...byMonth.keys(), ...docs.keys(), ...fb.keys(), ...crashes.keys(), ...replays.keys()])].sort();
  for (const m of months) {
    const L = byMonth.get(m) || { lessons: 0, toGreen: [], notAll: 0, minutes: new Map(), red: 0 };
    add(m, 'lektioner', '', L.lessons, L.lessons);
    add(m, 'minutter til alle er grønne (median)', '', L.toGreen.length ? Math.round(median(L.toGreen) * 10) / 10 : '', L.toGreen.length);
    add(m, 'lektioner hvor ikke alle blev grønne', '', L.notAll, L.lessons);
    for (const [key, v] of [...L.minutes].sort()) {
      const [color, reason] = key.split('|');
      add(m, color === 'rød' ? 'røde minutter' : 'grå minutter', reason, Math.round(v.min), v.n);
    }
    const A = docs.get(m) || { n: 0, cert: 0, rejected: 0, reasons: new Map() };
    add(m, 'afleveringer', '', A.n, A.n);
    add(m, 'andel med mærke (%)', '', A.n ? Math.round((A.cert / A.n) * 100) : '', A.n);
    for (const [c, n] of [...A.reasons].sort()) add(m, 'afslag', c, n, n);
    const F = fb.get(m) || { lampe: 0, afslag: 0, by: new Map() };
    add(m, 'røde lamper markeret forkert (%)', '', L.red ? Math.round((F.lampe / L.red) * 100) : '', Math.min(L.red, F.lampe));
    add(m, 'afslag markeret forkert (%)', '', A.rejected ? Math.round((F.afslag / A.rejected) * 100) : '', Math.min(A.rejected, F.afslag));
    for (const [key, n] of [...F.by].sort()) {
      const [kind, reason, source] = key.split('|');
      add(m, kind === 'lampe' ? 'markeret forkert: rød lampe' : 'markeret forkert: afslag', `${reason} (${source})`, n, n);
    }
    // Driftsforstyrrelser og afspilninger er tal om serveren og lærernes brug – ikke om elever. De vises altid.
    rows.push({ month: m, metric: 'driftsforstyrrelser', reason: '', value: crashes.get(m) || 0, n: '', note: '' });
    rows.push({ month: m, metric: 'åbnede afspilninger', reason: '', value: replays.get(m) || 0, n: '', note: '' });
  }
  return rows;
}

function toCsv(rows) {
  const cell = (v) => { const x = v == null ? '' : String(v); return /[;"\r\n]/.test(x) || /^[=+\-@]/.test(x) ? '"' + x.replace(/"/g, '""').replace(/^([=+\-@])/, "'$1") + '"' : x; };
  const out = [['Måned', 'Måling', 'Årsag', 'Værdi', 'Antal', 'Note'].join(';')];
  for (const r of rows) out.push([r.month, r.metric, r.reason, r.value, r.n, r.note].map(cell).join(';'));
  return '﻿' + out.join('\r\n') + '\r\n';
}

module.exports = { K, KINDS, SOURCES, REASONS, ensure, record, stats, toCsv, redCat, greyCat };
