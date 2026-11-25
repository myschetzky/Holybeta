'use strict';
// Hjemmeskrivning: fra som standard, relativ tid i afspilningen, intet fokus-mål hjemme og "hjemme, uden opsyn" som et lavere niveau
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const dbm = require('../server/src/db.js');
const { DocStore } = require('../server/src/docs.js');
const D = require('../shared/doc.js');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('mærket: "hjemme, uden opsyn" og aldrig grønt hjemme', () => {
  const both = ['skrivevindue', 'vagt'];
  assert.strictEqual(D.label('hjemme', { observed: both }), '✓ Tastet i HolyMoly – intet indsat · hjemme, uden opsyn');
  assert.strictEqual(D.label('klasse', { observed: both }), '✓ Tastet i HolyMoly – intet indsat · i timen');
  assert.strictEqual(D.markGreen({ place: 'klasse', observed: both }), true);
  assert.strictEqual(D.markGreen({ place: 'hjemme', observed: both }), false, 'hjemme er et lavere niveau');
  assert.strictEqual(D.markGreen({ place: 'lektion og hjemme', observed: both }), false);
  // Tjek-siden siger det samme
  assert.match(read('server/public/bevis.js'), /hjemme: 'Hjemme, uden opsyn/);
  assert.strictEqual(read('agent/src/doc.js'), read('shared/doc.js'), 'npm run sync');
});

test('"Må skrives hjemme" er slået fra som standard', () => {
  const app = read('server/public/app.js');
  assert.match(app, /const home = h\('input', \{ type: 'checkbox', checked: a \? !!a\.home : false \}\)/);
  assert.match(read('server/src/index.js'), /return \{ title, description, due, home: !!b\.home \};/);
});

test('afspilning af et dokument skrevet hjemme viser relativ tid – ikke klokkeslæt', () => {
  assert.match(read('server/src/index.js'), /versions: docs\.versions\(mm\[1\]\), home: \/hjemme\/\.test\(String\(d\.place \|\| ''\)\)/);
  const app = read('server/public/app.js');
  assert.match(app, /const at = \(i\) => \(r\.home \? `minut \$\{Math\.round\(rel\[i\] \/ 60_000\)\}` : fmtTime\(v\[i\]\.ts\)\);/);
  assert.match(app, /when\.textContent = `\$\{at\(i\)\} · /);
});

test('focusLostMs måles ikke i en skriveøkt hjemme', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-hjemme-'));
  const db = dbm.open(dir);
  try {
    db.prepare("INSERT INTO teachers (id, email, name, pass_hash, created) VALUES (1, 'l@x.dk', 'Mette', 'x', 0)").run();
    db.prepare("INSERT INTO classes (id, teacher_id, name, created) VALUES (1, 1, '2.g', 0)").run();
    db.prepare("INSERT INTO students (id, class_id, name, created, enrolled) VALUES (1, 1, 'Anna', 0, 1)").run();
    db.prepare("INSERT INTO lessons (id, class_id, started, ends_at) VALUES (1, 1, 0, 9e15)").run();
    db.prepare("INSERT INTO lessons (id, class_id, started, ends_at, student_id, kind) VALUES (2, 1, 0, 9e15, 1, 'hjemme')").run();
    const docs = new DocStore(db, dir);
    const anna = { id: 1, class_id: 1 };
    const id = crypto.randomUUID();
    const green = { color: 'green', violations: [] };
    const save = (lesson, focusLostMs, t) => assert.ok(docs.save(anna, { id, title: 'R', blocks: [{ t: 'p', r: [{ x: 'Tekst ' + t }] }], stats: { typed: 50, focusLostMs } }, green, lesson, t).ok);
    const focus = () => JSON.parse(db.prepare('SELECT stats FROM documents WHERE id = ?').get(id).stats).focusLostMs;
    save(2, 600_000, 1_000_000);
    assert.strictEqual(focus(), 0, 'hjemme: intet fokus-mål');
    save(1, 650_000, 1_005_000);
    assert.strictEqual(focus(), 650_000, 'i timen måles fokus som før');
    save(2, 900_000, 1_010_000);
    assert.strictEqual(focus(), 650_000, 'hjemme lægges intet til');
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
