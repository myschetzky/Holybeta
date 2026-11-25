'use strict';
/*
 * Låst konfiguration: fingeraftrykket af det, skolen sagde ja til (DPIA_DATO og LEDELSE_JA_DATO).
 *
 * Når skolens ja er udfyldt, gemmes et fingeraftryk af funktionerne (featuresFor – også Word-flaget), fristerne
 * (retention.fromEnv), REQUIRE_GUARD og signeringsnøglens keyId i meta.config_ja. Ingen hemmeligheder.
 * Ændres noget bagefter, viser startlinjen, /healthz?deep=1 og beta-forsiden "ændret siden DPIA: …".
 * Nye lektioner blokeres KUN, når en overvågningsfunktion er slået til siden (liveScreen, screenshot, autoEvidence,
 * similar, word) – aldrig ved ændrede frister og aldrig midt i en lektion. Blokeringen hæves med
 * "npm run enkel -- bekraeft-ja", som står i revisionssporet. Et nyt ja (nye datoer) registrerer konfigurationen igen.
 *
 * Elevernes accept: en hash af funktionerne gemmes med terms_accepted (students.terms_features). Ændres funktionerne,
 * beder elev-appen eleven om at læse vilkårene igen og bekræfte.
 */
const crypto = require('node:crypto');

const SURVEILLANCE = ['liveScreen', 'screenshot', 'autoEvidence', 'similar', 'word'];
const META = 'config_ja';

const sorted = (o) => Object.fromEntries(Object.keys(o || {}).sort().map(k => [k, o[k]]));
const short = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

/** Fingeraftrykkets indhold (kun indstillinger – ingen hemmeligheder). */
function snapshot({ features, retention, requireGuard, keyId }) {
  return { features: sorted(features), retention: sorted(retention), requireGuard: !!requireGuard, keyId: String(keyId || '') };
}
function hash(snap) { return short(JSON.stringify(snap)); }
/** Hash af funktionerne (gemmes med elevens accept). */
function featuresHash(features) { return short(JSON.stringify(sorted(features))); }
const approvalKey = (a) => JSON.stringify([a.controller, a.dpo, a.dpiaDate, a.approvedDate].map(x => String(x || '')));

function read(db) {
  try { const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(META); return r ? JSON.parse(r.value) : null; } catch (e) { return null; }
}
/** Gem fingeraftrykket for skolens ja. by: hvem/hvad (står i revisionssporet). */
function store(db, approval, snap, by, now = Date.now()) {
  const v = { approval: approvalKey(approval), dpiaDate: approval.dpiaDate || '', approvedDate: approval.approvedDate || '', config: snap, hash: hash(snap), ts: now };
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(META, JSON.stringify(v));
  try { db.prepare('INSERT INTO audit_log (ts, teacher_id, action, student_id, student_ref) VALUES (?, NULL, ?, NULL, NULL)').run(now, String(by || 'konfiguration registreret ved skolens ja').slice(0, 120)); } catch (e) { /* ældre skema */ }
  return v;
}

/** Ved start: første gang skolens ja er udfyldt – eller ved et nyt ja (andre datoer) – gemmes konfigurationen. */
function sync(db, approval, snap, log) {
  const cur = read(db);
  if (cur && cur.approval === approvalKey(approval)) return cur;
  const v = store(db, approval, snap, cur ? 'konfiguration registreret ved nyt ja fra skolen' : 'konfiguration registreret ved skolens ja');
  if (log) log(`Skolens ja er registreret med denne konfiguration (${v.hash}).`);
  return v;
}

/** Hvad er ændret siden skolens ja? Navnene: funktionernes nøgler, 'frister', 'vagt' og 'nøgle'. */
function changes(stored, snap) {
  if (!stored || !stored.config) return [];
  const a = stored.config, out = [];
  const keys = [...new Set([...Object.keys(a.features || {}), ...Object.keys(snap.features)])].sort();
  for (const k of keys) if (!!(a.features || {})[k] !== !!snap.features[k]) out.push(k);
  if (JSON.stringify(sorted(a.retention)) !== JSON.stringify(snap.retention)) out.push('frister');
  if (!!a.requireGuard !== snap.requireGuard) out.push('vagt');
  if (String(a.keyId || '') !== snap.keyId) out.push('nøgle');
  return out;
}
/** Overvågningsfunktioner, der er slået til siden skolens ja (kun de blokerer nye lektioner). */
function blocking(stored, snap) {
  if (!stored || !stored.config) return [];
  return SURVEILLANCE.filter(k => snap.features[k] && !(stored.config.features || {})[k]);
}

module.exports = { SURVEILLANCE, snapshot, hash, featuresHash, read, store, sync, changes, blocking, approvalKey };
