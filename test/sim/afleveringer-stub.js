'use strict';
/*
 * Attrap af hovedvinduets bro window.hm til afleveringssiden (agent/renderer/afleveringer.js) – uden Electron.
 * Bruges af scripts/a11y.js og til skærmbilleder (node test/sim/afleveringer-shot.js).
 * Køres i siden via page.addInitScript(stub). Ukendte funktioner på broen er tomme.
 */
module.exports = function stub() {
  const now = Date.now();
  const H = 3600_000;
  const MARK = '\u2713 Tastet i HolyMoly \u2013 intet indsat';
  const assignments = [
    { id: 7, title: 'Novelleanalyse', className: '2.g Dansk', description: 'Skriv en analyse af "Rejsen" af Kirsten Thorup.', due: now + 30 * H, home: true, submission: null },
    { id: 8, title: 'Digtanalyse', className: '2.g Dansk', description: '', due: now + 6 * 24 * H, home: false, submission: { docId: 'd2', title: 'Digtanalyse – Søvnen', submitted: now - 2 * H, certified: true, label: MARK + ' \u00b7 i timen' } },
    { id: 9, title: 'Kronik om sociale medier', className: '2.g Samfundsfag', description: '', due: 0, home: true, submission: null },
    { id: 5, title: 'Sagprosa: Reklamer', className: '2.g Dansk', description: '', due: now - 3 * 24 * H, home: true, submission: { docId: 'd4', title: 'Reklameanalyse', submitted: now - 4 * 24 * H, certified: false, label: '' } },
    { id: 4, title: 'Argumenterende tekst', className: '2.g Dansk', description: '', due: now - 9 * 24 * H, home: false, submission: null },
  ];
  const docs = [
    { id: 'd1', title: 'Novelleanalyse – kladde 2', words: 812, date: now - 26 * H, submitted: now - 26 * H, certId: 'abc12345', label: MARK + ' \u00b7 hjemme', assignmentId: 7, source: 'holymoly', path: '', canOpen: true, canDocx: true },
    { id: 'd2', title: 'Digtanalyse – Søvnen', words: 655, date: now - 2 * H, submitted: now - 2 * H, certId: 'def67890', label: MARK + ' \u00b7 i timen', assignmentId: 8, source: 'holymoly', path: '', canOpen: true, canDocx: true },
    { id: 'd3', title: 'Kronik (Word)', words: 1040, date: now - 50 * H, submitted: now - 50 * H, certId: 'w0rd0001', label: MARK + ' \u00b7 hjemme', assignmentId: 0, source: 'word', path: 'C:\\Users\\elev\\Documents\\Kronik.docx', canOpen: true, canDocx: false },
    { id: 'd4', title: 'Reklameanalyse', words: 430, date: now - 4 * 24 * H, submitted: now - 4 * 24 * H, certId: '', label: '', assignmentId: 5, source: 'holymoly', path: '', canOpen: true, canDocx: true },
  ];
  window.__calls = [];
  const state = { serverSetup: false, enrollments: [{ className: '2.g Dansk', studentName: 'Anna Jensen', teacherName: 'Mette' }], conn: 'online', lesson: null, needs: [], error: '', hand: false, links: [], assignmentsOpen: 2 };
  const base = {
    getState: async () => state,
    onState: () => {}, onAddClass: () => {}, onShowAssignments: (cb) => { window.__showAssignments = cb; },
    verified: {
      overview: async () => ({ lesson: false, now: Date.now(), assignments, docs }),
      list: async () => docs.filter(d => d.certId),
      write: async (aid) => { window.__calls.push(['write', aid]); return { ok: true }; },
      attach: async (aid, docId) => { window.__calls.push(['attach', aid, docId]); return { ok: true, at: Date.now() }; },
      open: async (id) => { window.__calls.push(['open', id]); return { ok: true }; },
      docx: async (id) => { window.__calls.push(['docx', id]); return { ok: true, name: 'Dokument.docx' }; },
      page: async (open) => { window.__calls.push(['page', open]); },
    },
  };
  window.hm = new Proxy(base, { get: (t, k) => (k in t ? t[k] : () => Promise.resolve(null)) });
};
