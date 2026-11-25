/*
 * Elevens afleveringsside i hovedvinduet: sortering, status og filtrering – rene funktioner uden Electron og DOM.
 * Bruges af hovedprocessen (agent/src/verified.js) og af siden (agent/renderer/afleveringer.js via <script>).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HMAssignmentsView = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const UNMARKED_NOTE = 'Afleveringer uden mærke er ikke bevis for snyd.';
  const MARK = '✓ Tastet i HolyMoly – intet indsat'; // samme som D.MARK (shared/doc.js)

  const num = (x) => Number(x) || 0;
  const str = (x, max) => String(x == null ? '' : x).slice(0, max || 200);
  const byTitle = (a, b) => str(a.title).localeCompare(str(b.title), 'da');

  /** Fristen er passeret (en aflevering uden frist er altid åben). */
  function isPast(a, now) { return !!(a && num(a.due) && num(a.due) <= now); }

  /**
   * Deler afleveringerne som lærerens side: 'Åbne' (frist ikke passeret eller ingen frist, tidligste frist først, uden frist sidst)
   * og de passerede (nyeste frist først). Overskriften på det andet kort er 'Afleveret', når eleven har afleveret dem alle,
   * ellers 'Fristen er overskredet'.
   */
  function split(list, now) {
    const all = (Array.isArray(list) ? list : []).filter(a => a && num(a.id));
    const open = all.filter(a => !isPast(a, now)).sort((x, y) => (num(x.due) || 9e15) - (num(y.due) || 9e15) || byTitle(x, y));
    const past = all.filter(a => isPast(a, now)).sort((x, y) => num(y.due) - num(x.due) || byTitle(x, y));
    const pastTitle = past.length && past.every(a => a.submission) ? 'Afleveret' : 'Fristen er overskredet';
    return { open, past, pastTitle, missing: all.filter(a => !a.submission).length };
  }

  /** 'Klasse · må skrives hjemme' / 'Klasse · skrives i timen' (som lærerens tabel). */
  function where(a) {
    const kind = a && a.home ? 'må skrives hjemme' : 'skrives i timen';
    return a && a.className ? `${a.className} · ${kind}` : kind.charAt(0).toUpperCase() + kind.slice(1);
  }

  /**
   * Status for én række. tone: 'ok' (afleveret med mærke), 'neutral' (grå – uden mærke eller fristen overskredet) eller 'todo'.
   * submission.label: mærket på det afleverede dokument (fra hovedprocessen). Mangler det, bruges grundmærket.
   */
  function status(a, now) {
    const s = a && a.submission;
    if (s && s.certified) {
      const label = str(s.label || MARK, 160).replace(/^✓\s*/, '');
      return { key: 'done', text: `Afleveret ✓ ${label}`, tone: 'ok' };
    }
    if (s) return { key: 'done-unmarked', text: 'Afleveret uden mærke', tone: 'neutral' };
    if (isPast(a, now)) return { key: 'late', text: 'Fristen er overskredet', tone: 'neutral' };
    return { key: 'missing', text: 'Mangler', tone: 'todo' };
  }

  /**
   * Elevens dokumenter som de vises på siden. items: writer._summary() (evt. udvidet af Word-delen).
   * Felter, der kan mangle: words, label, submitted/updated/created, path (en Word-fil på computeren), source ('word').
   */
  function normalizeDocs(items) {
    const seen = new Set();
    const out = [];
    for (const d of Array.isArray(items) ? items : []) {
      if (!d || !d.id || seen.has(String(d.id))) continue;
      seen.add(String(d.id));
      const path = typeof d.path === 'string' && d.path ? d.path.slice(0, 1000) : '';
      const word = !!path || d.source === 'word';
      const certId = d.certId ? str(d.certId, 80) : '';
      out.push({
        id: str(d.id, 80), title: str(d.title, 200), words: Math.max(0, Math.round(num(d.words))),
        date: num(d.submitted) || num(d.updated) || num(d.created), submitted: num(d.submitted),
        certId, label: certId ? str(d.label || MARK, 160) : '', assignmentId: num(d.assignmentId),
        source: word ? 'word' : 'holymoly', path,
        // Åbn: HolyMoly-dokumenter i skrivevinduet; Word-dokumenter vises i mappen (kun når stien er kendt)
        canOpen: word ? !!path : true,
        // "Hent Word-fil" findes for HolyMolys egne dokumenter (writer.exportDocx); en Word-fil ligger allerede på computeren
        canDocx: !word,
      });
    }
    return out;
  }

  /** Dokumenter med mærke (certId), nyeste først. */
  function verified(docs) {
    return normalizeDocs(docs).filter(d => d.certId).sort((x, y) => y.date - x.date || byTitle(x, y));
  }

  /**
   * Dokumenter, der kan afleveres (afsluttede): { marked, unmarked }. Kladder kan ikke afleveres (serveren kræver et afsluttet dokument).
   * Dokumenter, der allerede er afleveret til en anden aflevering, sorteres fra (serveren afviser dem).
   */
  function forAttach(docs, assignments, assignmentId) {
    const taken = new Set((Array.isArray(assignments) ? assignments : [])
      .filter(a => a && a.submission && num(a.id) !== num(assignmentId)).map(a => str(a.submission.docId, 80)));
    // Dokumenter skrevet til netop denne aflevering først, derefter nyeste først
    const mine = (d) => (d.assignmentId === num(assignmentId) ? 0 : 1);
    const all = normalizeDocs(docs).filter(d => d.submitted && !taken.has(d.id)).sort((x, y) => mine(x) - mine(y) || y.date - x.date || byTitle(x, y));
    return { marked: all.filter(d => d.certId), unmarked: all.filter(d => !d.certId) };
  }

  /**
   * Afleveringer, eleven kan vælge under "Skriv verificeret aflevering": de åbne. Hver får { canWrite, why }:
   * uden for timen kan kun afleveringer, der må skrives hjemme, startes.
   */
  function writable(list, { lesson = false, now = Date.now() } = {}) {
    return split(list, now).open.map(a => {
      const canWrite = !!lesson || !!a.home;
      return { id: num(a.id), title: str(a.title), where: where(a), due: num(a.due), submitted: !!a.submission, canWrite, why: canWrite ? '' : 'Skrives i timen, når din lærer har startet en lektion' };
    });
  }

  const pad = (n) => String(n).padStart(2, '0');
  /** 10.14 (dansk klokkeslæt) */
  function hhmm(ts) { const d = new Date(ts); return `${pad(d.getHours())}.${pad(d.getMinutes())}`; }
  const DAYS = ['søn.', 'man.', 'tirs.', 'ons.', 'tors.', 'fre.', 'lør.'];
  const MONTHS = ['jan.', 'feb.', 'mar.', 'apr.', 'maj', 'jun.', 'jul.', 'aug.', 'sep.', 'okt.', 'nov.', 'dec.'];
  /** 'ons. 25. nov. kl. 10.14' – fristen. Uden frist: '–'. */
  function fmtDue(ts) {
    if (!num(ts)) return '–';
    const d = new Date(ts);
    return `${DAYS[d.getDay()]} ${d.getDate()}. ${MONTHS[d.getMonth()]} kl. ${hhmm(ts)}`;
  }
  /** '25. nov. 2026' – dokumentets dato. */
  function fmtDate(ts) {
    if (!num(ts)) return '–';
    const d = new Date(ts);
    return `${d.getDate()}. ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  }
  /**
   * Kvitteringen fra serveren (assignment-result): serverens tid, opgave, ordantal, mærke, bevis-kode og
   * hvilken aflevering den erstatter. Ingen ny signatur – kun det, serveren har registreret.
   */
  function receiptText(rc) {
    if (!rc || !num(rc.at)) return '';
    const parts = [`Afleveret til "${str(rc.assignment, 200)}" ${fmtDue(rc.at)} (serverens tid)`];
    parts.push(`${num(rc.words)} ord`);
    parts.push(rc.code ? `${str(rc.mark, 160)} · ${str(rc.code, 20)}` : 'uden mærke');
    if (rc.late) parts.push('efter fristen');
    if (num(rc.replaces)) parts.push(`erstatter afleveringen fra ${fmtDue(rc.replaces)}`);
    return 'Kvittering: ' + parts.join(' · ') + '.';
  }
  /** Resultatet af en aflevering: kvitteringen (eller 'Afleveret kl. 10.14' fra en ældre server) – eller serverens fejltekst. */
  function attachResult(r, now) {
    if (r && r.ok) return { ok: true, text: receiptText(r.receipt) || `Afleveret kl. ${hhmm(now)}` };
    return { ok: false, text: str((r && r.error) || 'Kunne ikke aflevere. Prøv igen.', 300) };
  }

  return { UNMARKED_NOTE, MARK, isPast, split, where, status, normalizeDocs, verified, forAttach, writable, hhmm, fmtDue, fmtDate, attachResult, receiptText };
});
