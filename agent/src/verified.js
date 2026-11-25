'use strict';
/*
 * Hovedvinduets afleveringsside: ipc til siden (agent/renderer/afleveringer.js).
 *
 *   verified:overview  → { lesson, now, assignments, docs }   afleveringerne (med mærket på det afleverede) og elevens afsluttede dokumenter
 *   verified:list      → [doc]                                 kun dokumenter med mærke (certId)
 *   verified:write     { assignmentId } → { ok, error }        "Skriv verificeret aflevering" (main.js: startVerifiedWriting)
 *   verified:attach    { assignmentId, docId } → { ok, error } samme vej som skrivevinduets afleveringsdialog (writer.attach)
 *   verified:open      docId → { ok, error }                   skrivevinduet åbner dokumentet / Word-fil: vis i mappe
 *   verified:docx      docId → { ok, name }                    "Hent Word-fil" (writer.exportDocx)
 *   verified:page      open                                    siden er åbnet/lukket (hovedvinduet gøres bredere)
 *
 * Word-delen kan udvide dokumentlisten på to måder (begge er valgfrie):
 *   - felter på writer._summary()-elementerne: path (Word-filen på computeren), source: 'word', updated/created
 *   - writer.verifiedDocs() → [{ id, title, words, certId, label, submitted, path, source }] (flettes ind efter id)
 * og vedhæftning af egne dokumenter med writer.attachVerified(aid, docId) (ellers writer.attach).
 */
const V = require('./assignments-view.js');
const D = require('./doc.js');

/** Rå dokumentliste fra skrivevinduet (+ evt. Word-delen), med datoer og sti, som _summary ikke har. */
function rawDocs(writer) {
  if (!writer) return [];
  const list = typeof writer._summary === 'function' ? writer._summary() : [];
  const out = list.map((s) => {
    const raw = typeof writer._get === 'function' ? writer._get(s.id) : null;
    return Object.assign({ updated: raw && raw.updated, created: raw && raw.created, path: raw && raw.path, source: raw && raw.source }, s);
  });
  if (typeof writer.verifiedDocs === 'function') {
    try { for (const d of writer.verifiedDocs() || []) if (d && d.id && !out.some(x => x.id === d.id)) out.push(d); } catch (e) { /* Word-delen svarede ikke */ }
  }
  return out;
}

/** Afleveringerne med mærket på det afleverede dokument (submission.label), så siden kan skrive 'Afleveret ✓ {mærke}'. */
function assignmentsWithLabels(writer, docs) {
  const byId = new Map(docs.map(d => [String(d.id), d]));
  return ((writer && writer.assignments) || []).map((a) => {
    if (!a.submission) return Object.assign({}, a);
    const d = byId.get(String(a.submission.docId));
    const label = a.submission.certified ? ((d && d.label) || D.label()) : '';
    return Object.assign({}, a, { submission: Object.assign({}, a.submission, { label }) });
  });
}

/**
 * opts: { ipcMain, shell, getWriter() -> Writer, getWin() -> BrowserWindow, lessonActive() -> bool,
 *         startWriting(aid) -> Promise<{ ok, error }>, onPage(open) }
 */
function register(opts) {
  const { ipcMain } = opts;
  const w = () => opts.getWriter();
  const noWriter = { ok: false, error: 'HolyMoly er ikke klar endnu. Prøv igen om lidt.' };

  ipcMain.handle('verified:overview', () => {
    const docs = rawDocs(w());
    return {
      lesson: !!(opts.lessonActive && opts.lessonActive()),
      now: Date.now(),
      assignments: assignmentsWithLabels(w(), V.normalizeDocs(docs)),
      docs: V.normalizeDocs(docs),
    };
  });
  ipcMain.handle('verified:list', () => V.verified(rawDocs(w())));

  ipcMain.handle('verified:write', async (_e, input) => {
    if (!w()) return noWriter;
    try {
      const r = await opts.startWriting(Number(input && input.assignmentId) || 0);
      return { ok: !!(r && r.ok), error: String((r && r.error) || '') };
    } catch (e) { return { ok: false, error: 'Kunne ikke åbne skrivevinduet' }; }
  });

  ipcMain.handle('verified:attach', async (_e, input) => {
    const writer = w();
    if (!writer) return noWriter;
    const aid = Number(input && input.assignmentId) || 0;
    const docId = String((input && input.docId) || '').slice(0, 80);
    if (!aid || !docId) return { ok: false, error: 'Vælg et dokument' };
    const fn = typeof writer.attachVerified === 'function' ? writer.attachVerified.bind(writer) : writer.attach.bind(writer);
    const r = await fn(aid, docId);
    return { ok: !!(r && r.ok), error: String((r && r.error) || ''), at: Date.now(), receipt: (r && r.receipt) || null };
  });

  ipcMain.handle('verified:open', (_e, id) => {
    const writer = w();
    if (!writer) return noWriter;
    const d = V.normalizeDocs(rawDocs(writer)).find(x => x.id === String(id || ''));
    if (!d) return { ok: false, error: 'Dokumentet findes ikke' };
    if (d.source === 'word') {
      if (!d.path) return { ok: false, error: 'HolyMoly kender ikke Word-filens placering' };
      opts.shell.showItemInFolder(d.path);
      return { ok: true };
    }
    return writer.openDoc(d.id);
  });

  ipcMain.handle('verified:docx', (_e, id) => {
    const writer = w();
    if (!writer) return noWriter;
    return writer.exportDocx(String(id || ''), opts.getWin ? opts.getWin() : undefined);
  });

  ipcMain.handle('verified:page', (_e, open) => { if (opts.onPage) opts.onPage(!!open); });
}

module.exports = { register, rawDocs, assignmentsWithLabels };
