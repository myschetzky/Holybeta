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
 *   og skriveøkter hjemme (lessons)
 *   hjælpemidler, enhedsoplysninger 180 dage uden forbindelse            INACTIVE_STUDENT_DAYS
 *   og ekstra tid (inaktiv elev)
 *   revisionsspor (audit_log:       365 dage                             AUDIT_DAYS
 *   lærerhandlinger uden indhold)
 *   sikkerhedskopier                14 dage                              BACKUP_DAYS (0 = ingen)
 * Ved aflevering beholdes højst MAX_VERSIONS versioner til afspilning.
 * Serveren sletter aldrig elevens lokale kopier i elev-appen.
 * Computerens fingeraftryk på en skriveøkt (lessons.device_hash) nulstilles, når økten er slut.
 * Fristerne gælder på alle servere – også uden LICENSING=1 (retention() i index.js kører altid).
 */
const DAY = 86400_000;
const MAX_VERSIONS = 120;
const DEFAULTS = { draftDays: 60, versionsDays: 60, docDays: 365, certYears: 3, logDays: 30, backupDays: 14, inactiveDays: 180, auditDays: 365 };

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
    inactiveDays: pos(opts.inactiveStudentDays ?? env.INACTIVE_STUDENT_DAYS, DEFAULTS.inactiveDays),
    auditDays: pos(opts.auditDays ?? env.AUDIT_DAYS, DEFAULTS.auditDays),
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
    { key: 'logDays', what: 'Hændelser, skærmbilleder, lampernes tidslinje og skriveøkter hjemme', text: `Slettes efter ${R.logDays} dage.` },
    { key: 'inactiveDays', what: 'Hjælpemidler, ekstra tid og oplysninger om elevens computer', text: `Slettes, når eleven ikke har været forbundet i ${R.inactiveDays} dage.` },
    { key: 'auditDays', what: 'Revisionsspor (hvilken lærer åbnede, afspillede, eksporterede eller ændrede hvad hos hvilken elev – uden indhold)', text: `Slettes efter ${R.auditDays} dage. Slettes eleven, står der kun et pseudonym.` },
    { key: 'backupDays', what: 'Sikkerhedskopier', text: R.backupDays ? `Gemmes i ${R.backupDays} dage.` : 'Der laves ingen sikkerhedskopier.' },
  ];
}

/** Til /api/info: tallene og teksterne. */
function publicInfo(R) {
  const { draftDays, versionsDays, docDays, certYears, logDays, backupDays, inactiveDays, auditDays, maxVersions } = R;
  return { draftDays, versionsDays, docDays, certYears, logDays, backupDays, inactiveDays, auditDays, maxVersions, items: describe(R) };
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
  const out = { drafts: 0, versions: 0, events: 0, reduced: 0, documents: 0, expired: 0, homeLessons: 0, deviceHashes: 0, inactive: 0, extensions: 0, audit: 0 };
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
  // Afleveringens historik (tidligere vedhæftninger) følger dokumenterne
  try { db.prepare('DELETE FROM assignment_history WHERE submitted < ?').run(dCut); } catch (e) { /* ældre skema */ }
  // 4) Beviser efter certYears: kun id'et bliver (så tjek-siden kan svare "udløbet" i stedet for "aldrig udstedt")
  out.expired = db.prepare(`UPDATE certificates SET payload = '', sig = '', text_sha256 = NULL, doc_id = '', student_name = '', class_name = '', expired = ?
    WHERE expired IS NULL AND created < ?`).run(now, now - R.certYears * 365 * DAY).changes;
  // 5) Skriveøkter hjemme (en række pr. økt: hvornår eleven skrev hjemme) efter logDays. Et dokument, der endnu ikke er
  //    afleveret, husker de slettede økter (monitor.homeGone), så det aldrig bliver til "i timen", når rækken er væk (placeOf).
  try {
    const home = "(kind = 'hjemme' OR student_id IS NOT NULL) AND ended IS NOT NULL AND ended < ?";
    const lCut = now - R.logDays * DAY;
    const gone = new Set(db.prepare(`SELECT id FROM lessons WHERE ${home}`).all(lCut).map(r => r.id));
    if (gone.size) {
      const upd = db.prepare('UPDATE documents SET monitor = ? WHERE id = ?');
      for (const d of db.prepare('SELECT id, monitor FROM documents WHERE submitted IS NULL').all()) {
        let m;
        try { m = JSON.parse(d.monitor || '{}'); } catch (e) { continue; }
        const hit = (Array.isArray(m.lessons) ? m.lessons : []).map(Number).filter(i => gone.has(i));
        if (!hit.length) continue;
        m.homeGone = [...new Set([...(Array.isArray(m.homeGone) ? m.homeGone.map(Number) : []), ...hit])];
        upd.run(JSON.stringify(m), d.id);
      }
      out.homeLessons = db.prepare(`DELETE FROM lessons WHERE ${home}`).run(lCut).changes;
    }
    // Computerens fingeraftryk bruges kun til at fortsætte en afbrudt økt (få minutter) – derefter nulstilles det
    out.deviceHashes = db.prepare("UPDATE lessons SET device_hash = NULL WHERE device_hash IS NOT NULL AND ended IS NOT NULL AND (end_reason IS NULL OR end_reason != 'drop' OR ended < ?)").run(now - DAY).changes;
  } catch (e) { /* ældre skema */ }
  // 6) Inaktive elever: hjælpemidler, enhedsoplysninger og ekstra tid, når eleven ikke har været forbundet i inactiveDays
  try {
    const iCut = now - R.inactiveDays * DAY;
    const inactive = 'SELECT id FROM students WHERE COALESCE(last_seen, enrolled, created) < ?';
    out.extensions = db.prepare(`DELETE FROM lesson_extensions WHERE ends_at < ? OR student_id IN (${inactive})`).run(now - DAY, iCut).changes;
    out.inactive = db.prepare(`UPDATE students SET aids = NULL, device_info = NULL WHERE (aids IS NOT NULL OR device_info IS NOT NULL) AND id IN (${inactive})`).run(iCut).changes;
    // Hjælpemidler udløber ved skoleårets slutning
    out.aidsExpired = db.prepare('UPDATE students SET aids = NULL, aids_until = NULL WHERE aids IS NOT NULL AND aids_until IS NOT NULL AND aids_until <= ?').run(now).changes;
  } catch (e) { /* ældre skema */ }
  // 7) Revisionssporet efter auditDays. Tabellen kan kun slettes i før meta.audit_purge_before (trigger i db.js).
  try {
    const aCut = now - R.auditDays * DAY;
    db.prepare("INSERT INTO meta (key, value) VALUES ('audit_purge_before', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(aCut));
    out.audit = db.prepare('DELETE FROM audit_log WHERE ts < ?').run(aCut).changes;
  } catch (e) { /* ældre skema */ }
  // 8) "Var det forkert?" (pilot.js – kun dag, art, årsag og bevistype) efter samme frist som revisionssporet
  try { out.feedback = db.prepare('DELETE FROM feedback WHERE day < ?').run(new Date(now - R.auditDays * DAY).toISOString().slice(0, 10)).changes; } catch (e) { /* ingen tabel endnu */ }
  return out;
}

module.exports = { fromEnv, describe, publicInfo, purge, trimVersions, reduceMonitor, DEFAULTS, MAX_VERSIONS, DAY };
