'use strict';
// Små tjek af dashboardets kode (uden browser): standarder og tekster, som designdommen kræver
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const pub = (f) => fs.readFileSync(path.join(__dirname, '..', 'server', 'public', f), 'utf8');

test('afleveringsdialogen: "Må skrives hjemme" er fra som standard', () => {
  const src = pub('app.js');
  const m = src.match(/const home = h\('input', \{ type: 'checkbox', checked: ([^}]+) \}\)/);
  assert.ok(m, 'afkrydsningsfeltet til "Må skrives hjemme" findes');
  assert.strictEqual(m[1].trim(), 'a ? !!a.home : false');
});

test('enkel tilstand: banner for ventende lærere, "Vis kode" og ventesiden', () => {
  const src = pub('account.js');
  assert.ok(src.includes('Ny lærer venter: ${t.name} (oprettet ${when(t.created)})'), 'banneret med navn og tidspunkt');
  assert.ok(src.includes("text: 'Godkend'") && src.includes("text: 'Afvis'"));
  assert.ok(src.includes("text: 'Vis kode'"), 'lærerkoden vises først efter et klik');
  assert.ok(src.includes("me.needs === 'approval'"), 'ventesiden for en ny lærer');
  assert.match(pub('app.js'), /HM\.pendingTeachersBanner\(me\)/, 'banneret står på siden med klasserne');
});

/** Kører site.js med en lille falsk DOM og et svar fra /api/info. Returnerer #approval-boksen. */
async function runSite(info) {
  const vm = require('node:vm');
  const mkEl = () => ({ children: [], hidden: true, setAttribute() {}, append(...k) { this.children.push(...k); }, replaceChildren(...k) { this.children = k; }, addEventListener() {}, classList: { toggle() {} } });
  const box = mkEl();
  const document = {
    querySelector: () => null, querySelectorAll: () => [],
    getElementById: (id) => (id === 'approval' ? box : null),
    createElement: () => mkEl(), createTextNode: (t) => ({ text: t }),
  };
  const fetch = async (u) => ({ json: async () => (u === '/api/info' ? info : { perStudent: 1, minimum: 1, trialDays: 30 }) });
  const ctx = { window: {}, document, fetch, addEventListener() {}, scrollY: 0, Node: function () {} };
  vm.runInNewContext(pub('site.js'), ctx);
  for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r));
  const text = (n) => (n.text != null ? n.text : (n.textContent || '') + (n.children || []).map(text).join(''));
  return { hidden: box.hidden, text: box.children.map(text).join('') };
}

test('/privatliv: skolens ja vises (fillApproval kaldes i sit eget scope)', async () => {
  const full = await runSite({ simple: true, lessonBlocked: false, approvalMissing: [], approval: { controller: 'Testskolen', dpo: 'dpo@kommune.dk', dpiaDate: '2026-11-01', approvedDate: '2026-11-15' } });
  assert.strictEqual(full.hidden, false);
  assert.match(full.text, /Ansvarlig for denne server: Testskolen\. Databeskyttelsesrådgiver: dpo@kommune\.dk/);
  const missing = await runSite({ simple: true, lessonBlocked: true, approvalMissing: ['DPIA_DATO'], approval: null });
  assert.strictEqual(missing.hidden, false);
  assert.match(missing.text, /Skolen har ikke givet sit ja endnu/);
  assert.doesNotMatch(missing.text, /DPIA_DATO/, 'ingen variabelnavne på siden');
});

test('klasseværelset: start-knappen er slået fra uden skolens ja, og feltnavnene står ikke i dialogen', () => {
  const src = pub('app.js');
  assert.ok(src.includes('Lektioner kan ikke startes endnu – skolen har ikke givet sit ja. Eleverne kan godt tilmelde sig.'));
  assert.match(src, /btn\.disabled = !!state\.info\.lessonBlocked/);
  assert.ok(src.includes("'Venter på skolens ja'"));
  assert.doesNotMatch(src, /text: r\.approval/, 'serverens besked med variabelnavne vises ikke for læreren');
});

/** Kører room-write.js med en lille falsk DOM og returnerer HM.room.write(ctx). */
function roomWrite(state) {
  const vm = require('node:vm');
  const window = {};
  vm.runInNewContext(pub('room-write.js'), { window, setInterval: () => 0, clearInterval() {}, Date });
  const dialogs = [];
  const text = (n) => (n == null ? '' : typeof n === 'string' ? n : (n.text || '') + (n.kids || []).map(text).join(''));
  const h = (tag, attrs, ...kids) => ({ tag, text: (attrs || {}).text, kids: kids.flat() });
  const ctx = { state, classId: 1, h, $: () => null, api: async () => ({}), toast() {}, updateLessonUi() {},
    dialog: async (d) => { dialogs.push({ title: d.title, body: (Array.isArray(d.body) ? d.body : [d.body]).map(text), actions: [...d.actions].map(a => a.label).join(' | ') }); return 'keep'; } };
  return { rw: window.HM.room.write(ctx), dialogs };
}

test('skrivetime og ekstra tid i klasseværelset (room-write.js)', async () => {
  const until = Date.now() + 3600_000;
  const kl = new Date(until).toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' }).replace(':', '.');
  const state = {
    info: { features: { liveScreen: false, screenshot: false, writeLesson: true } },
    students: new Map([[1, { name: 'Anna' }], [2, { name: 'Bo' }], [3, { name: 'Carl' }]]), views: new Map(), open: null,
    lesson: { live: true, endsAt: Date.now() + 600_000, write: { assignmentId: 7, title: 'Novelleanalyse' }, extra: [{ studentId: 1, until }, { studentId: 2, until: until - 60_000 }] },
  };
  const { rw, dialogs } = roomWrite(state);
  assert.strictEqual(rw.pillText(state.lesson, 52), 'Skrivetime · Novelleanalyse · 52 min tilbage');
  assert.strictEqual(rw.pillText({ live: true }, 30), 'Lektion · 30 min tilbage');
  assert.strictEqual(rw.watchType(), 'follow', 'uden live-skærm følger dashboardet kun faner og hændelser');
  assert.strictEqual(rw.hasExtra(), true);
  assert.strictEqual(JSON.stringify(await rw.stopDialog()), JSON.stringify({ all: false }));
  assert.strictEqual(dialogs[0].body[0], `2 elever har ekstra tid til kl. ${kl}: Anna, Bo.`);
  assert.strictEqual(dialogs[0].actions, 'Annuller | Afslut for alle | Afslut, men lad dem skrive færdig');
  state.info.features.liveScreen = true;
  assert.strictEqual(roomWrite(state).rw.watchType(), 'watch');

  // Dialogen og knapperne findes i dashboardet
  const src = pub('room-write.js');
  for (const t of ['Skal eleverne skrive en opgave?', "'Start skrivetime'", "'+ tid'", 'Afslut for alle']) assert.ok(src.includes(t), t);
  assert.match(pub('index.html'), /<button class="btn" id="d-extra" hidden>\+ tid<\/button>/);
  assert.match(pub('index.html'), /<script src="\/room-write\.js"><\/script>/);
  assert.match(pub('app.js'), /rw \? rw\.watchType\(\) : 'watch'/);
  assert.match(pub('app.js'), /action: 'stop', all: choice\.all/);
});
