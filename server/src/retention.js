'use strict';
/*
 * Frister: hvor længe HolyMoly gemmer hvad. Den ENESTE kilde til tallene.
 * Oprydningen (purge), /api/info.retention og siderne /privatliv og /vilkaar-elev læser de samme tal.
 *
 * Standarder (kan ændres med miljøvariabler):
 *   kladder (ikke afleveret)        60 dage efter seneste ændring        DRAFT_DAYS
 *   afspilning, skrivelog og        60 dage efter aflevering             VERSIONS_DAYS
 *   skrivedetaljer
 *   afleverede dokumenter           365 dage efter aflevering            DOC_RETENTION_DAYS
 *   beviser (gravsten)              3 år efter udstedelse, derefter 410  CERT_YEARS
 *   hændelser, skærmbilleder, lamper 30 dage                             LOG_RETENTION_DAYS
 *   sikkerhedskopier                14 dage                              BACKUP_DAYS (0 = ingen)
 * Ved aflevering beholdes højst MAX_VERSIONS versioner til afspilning.
 * Serveren sletter aldrig elevens lokale kopier i elev-appen.
 */
const DAY = 86400_000;
const MAX_VERSIONS = 120;
const DEFAULTS = { draftDays: 60, versionsDays: 60, docDays: 365, certYears: 3, logDays: 30, backupDays: 14 };

/** Tallene fra opts (tests/createServer) eller miljøet. Ugyldige værdier giver standarden. */
function fromEnv(opts = {}, env = process.env) {
  const pos = (v, d) => { const n = Number(v); return v != null && v !== '' && Number.isFinite(n) && n > 0 ? n : d; };
  // Tom værdi (fx fra docker compose) = standarden – ikke 0, som ville slå backup fra
  const backup = Number(opts.backupDays ?? (env.BACKUP_DAYS === '' ? undefined : env.BACKUP_DAYS) ?? DEFAULTS.backupDays);
  return {
    draftDays: pos(opts.draftDays ?? env.DRAFT_DAYS, DEFAULTS.draftDays),
    versionsDays: pos(opts.versionsDays ?? env.VERSIONS_DAYS, DEFAULTS.versionsDays),
    docDays: pos(opts.docRetentionDays ?? env.DOC_RETENTION_DAYS, DEFAULTS.docDays),
    certYears: pos(opts.certYears ?? env.CERT_YEARS, DEFAULTS.certYears),
    logDays: pos(opts.retentionDays ?? env.LOG_RETENTION_DAYS, DEFAULTS.logDays),
    backupDays: Number.isFinite(backup) && backup >= 0 ? Math.floor(backup) : DEFAULTS.backupDays,
    maxVersions: MAX_VERSIONS,
  };
}

/** Fristerne i hele sætninger (til /privatliv og /api/info). */
function describe(R) {
  const years = R.certYears === 1 ? '1 år' : `${R.certYears} år`;
  return [
    { key: 'draftDays', what: 'Kladder (ikke afleveret)', text: `Slettes ${R.draftDays} dage efter seneste ændring.` },
    { key: 'versionsDays', what: 'Afspilning, skrivelog og skrivedetaljer', text: `Slettes ${R.versionsDays} dage efter aflevering. Kun minuttal og vurderingen bliver.` },
    { key: 'docDays', what: 'Afleverede dokumenter', text: `Slettes ${R.docDays} dage efter aflevering.` },
    { key: 'certYears', what: 'Beviser', text: `Kan tjekkes i ${years} efter aflevering. Når teksten er slettet, er der intet navn på beviset.` },
    { key: 'logDays', what: 'Hændelser, skærmbilleder og lampernes tidslinje', text: `Slettes efter ${R.logDays} dage.` },
    { key: 'backupDays', what: 'Sikkerhedskopier', text: R.backupDays ? `Gemmes i ${R.backupDays} dage.` : 'Der laves ingen sikkerhedskopier.' },
  ];
}

/** Til /api/info: tallene og teksterne. */
function publicInfo(R) {
  const { draftDays, versionsDays, docDays, certYears, logDays, backupDays, maxVersions } = R;
  return { draftDays, versionsDays, docDays, certYears, logDays, backupDays, maxVersions, items: describe(R) };
}

/** Højst max versioner af et dokument: jævnt fordelt, første og sidste beholdes. */
function trimVersions(db, docId, max = MAX_VERSIONS) {
  const rows = db.prepare('SELECT rowid AS r FROM doc_versions WHERE doc_id = ? ORDER BY ts, rowid').all(docId);
  if (rows.length <= max) return 0;
  const keep = new Set();
  for (let i = 0; i < max; i++) keep.add(rows[Math.round(i * (rows.length - 1) / (max - 1))].r);
  const del = db.prepare('DELETE FROM doc_versions WHERE rowid = ?');
  let n = 0;
  for (const { r } of rows) if (!keep.has(r)) n += del.run(r).changes;
  return n;
}

/** Skrivedetaljer efter fristen: kun minuttal bliver (ingen grunde, flag eller tastestatistik). */
function reduceMonitor(json) {
  let m = {};
  try { m = JSON.parse(json || '{}'); } catch (e) { /* tom */ }
  const min = (ms) => Math.round((Number(ms) || 0) / 60_000) * 60_000;
  return JSON.stringify({
    greenMs: min(m.greenMs), redMs: min(m.redMs), greyMs: min(m.greyMs), greyCounted: min(m.greyCounted ?? m.greyMs), greyIdle: min(m.greyIdle),
    red: [], grey: [], flags: [], lessons: Array.isArray(m.lessons) ? m.lessons : [], first: Number(m.first) || 0, reduced: true,
  });
}

/**
 * Oprydning efter fristerne. Kaldes hver time (index.js retention()). now kan sættes i tests.
 * Returnerer antal for hver slags.
 */
function purge(db, R, now = Date.now()) {
  const out = { drafts: 0, versions: 0, events: 0, reduced: 0, documents: 0, expired: 0 };
  // 1) Kladder, der ikke er rørt i draftDays
  out.drafts = db.prepare('DELETE FROM documents WHERE submitted IS NULL AND updated < ?').run(now - R.draftDays * DAY).changes;
  // 2) Afspilning og skrivedetaljer for afleverede dokumenter efter versionsDays
  const vCut = now - R.versionsDays * DAY;
  out.versions = db.prepare('DELETE FROM doc_versions WHERE doc_id IN (SELECT id FROM documents WHERE submitted IS NOT NULL AND submitted < ?)').run(vCut).changes;
  // Skrivelogen (indsatte udsnit, rettelser …) følger afspilningen
  try { out.events = db.prepare('DELETE FROM doc_events WHERE doc_id IN (SELECT id FROM documents WHERE submitted IS NOT NULL AND submitted < ?)').run(vCut).changes; } catch (e) { /* ingen tabel */ }
  const upd = db.prepare("UPDATE documents SET stats = '{}', monitor = ? WHERE id = ?");
  for (const d of db.prepare("SELECT id, monitor FROM documents WHERE submitted IS NOT NULL AND submitted < ? AND json_extract(monitor, '$.reduced') IS NULL").all(vCut)) {
    out.reduced += upd.run(reduceMonitor(d.monitor), d.id).changes;
  }
  // 3) Afleverede dokumenter efter docDays: beviset bliver en gravsten med dagens dato (triggeren rører den ikke igen)
  const dCut = now - R.docDays * DAY;
  db.prepare(`UPDATE certificates SET doc_id = '', student_name = '', class_name = '', doc_deleted = ?
    WHERE doc_id IN (SELECT id FROM documents WHERE submitted IS NOT NULL AND submitted < ?)`).run(now, dCut);
  out.documents = db.prepare('DELETE FROM documents WHERE submitted IS NOT NULL AND submitted < ?').run(dCut).changes;
  // 4) Beviser efter certYears: kun id'et bliver (så tjek-siden kan svare "udløbet" i stedet for "aldrig udstedt")
  out.expired = db.prepare(`UPDATE certificates SET payload = '', sig = '', text_sha256 = NULL, doc_id = '', student_name = '', class_name = '', expired = ?
    WHERE expired IS NULL AND created < ?`).run(now, now - R.certYears * 365 * DAY).changes;
  return out;
}

module.exports = { fromEnv, describe, publicInfo, purge, trimVersions, reduceMonitor, DEFAULTS, MAX_VERSIONS, DAY };
