'use strict';
/*
 * "Min HolyMoly" – elevens dokumenter fra både skrivevinduet ("Skriv i HolyMoly") og Word ("Skriv i Word")
 * i én liste med status og de knapper, der giver mening. Ren logik (ingen Electron).
 */

/**
 * input: { writerDocs: [{ id, title, submitted, certId, label, words, updated, assignmentId }],
 *          wordDocs: WordManager.list(), assignments: [{ id, title, due, submission: { docId } }] }
 * Returnerer listen sorteret med den senest ændrede først.
 */
function items(input) {
  const asg = Array.isArray(input.assignments) ? input.assignments : [];
  const attachedTo = (id) => { const a = asg.find(x => x.submission && x.submission.docId === id); return a ? a.title : ''; };
  const out = [];
  for (const d of input.wordDocs || []) {
    const done = !!d.submitted;
    const status = !done ? (d.open ? 'Åben i Word' : 'Påbegyndt i Word')
      : d.certId ? d.label + (d.sealedPath && d.verified ? ' · forseglet' : '')
      : 'Afsluttet uden mærke';
    out.push({
      key: 'word:' + d.id, id: d.id, source: 'word', sourceText: 'Word', title: d.title || 'Uden titel', words: Number(d.words) || 0,
      updated: Number(d.updated) || 0, status, kind: !done ? 'kladde' : d.certId ? 'maerke' : 'uden', note: d.sealError || '',
      attachedTo: attachedTo(d.id), assignmentId: Number(d.assignmentId) || 0,
      actions: [!done && !d.open ? 'continue' : null, 'folder', done ? 'attach' : null].filter(Boolean),
    });
  }
  for (const d of input.writerDocs || []) {
    const done = !!d.submitted;
    out.push({
      key: 'holymoly:' + d.id, id: d.id, source: 'holymoly', sourceText: 'HolyMoly', title: d.title || 'Uden titel', words: Number(d.words) || 0,
      updated: Number(d.updated || d.submitted) || 0, status: !done ? 'Kladde i HolyMoly' : d.certId ? (d.label || 'Med mærke') : 'Afsluttet uden mærke',
      kind: !done ? 'kladde' : d.certId ? 'maerke' : 'uden', note: '', attachedTo: attachedTo(d.id), assignmentId: Number(d.assignmentId) || 0,
      actions: ['writer', done ? 'attach' : null].filter(Boolean),
    });
  }
  return out.sort((a, b) => b.updated - a.updated);
}

/** Afleveringer, et afsluttet dokument kan vedhæftes (dem, der allerede har dokumentet, står som "nu"). */
function attachTargets(assignments, item, now = Date.now()) {
  if (!item || !item.actions.includes('attach')) return [];
  return (assignments || []).map(a => ({
    id: a.id, title: a.title, current: !!(a.submission && a.submission.docId === item.id),
    late: !!(a.due && now > a.due), text: a.title + (a.due ? ' (frist ' + new Date(a.due).toLocaleDateString('da-DK') + ')' : ''),
  }));
}

const ACTION_TEXT = { continue: 'Fortsæt i Word', folder: 'Åbn mappe', attach: 'Vedhæft til aflevering', writer: 'Åbn i HolyMoly' };

module.exports = { items, attachTargets, ACTION_TEXT };
