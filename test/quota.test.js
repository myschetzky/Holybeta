'use strict';
// Diskkvote pr. elev: højst 30 åbne dokumenter, højst 10 MB og højst 3.000 nye tegn pr. gemning
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const dbm = require('../server/src/db.js');
const { DocStore } = require('../server/src/docs.js');

const green = { color: 'green', violations: [] };
const blocksOf = (text) => [{ t: 'p', r: [{ x: text }] }];
const meta = { studentName: 'Anna', className: '2.g', teacherName: 'Mette', issuer: '' };

function setup(opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-quota-'));
  const db = dbm.open(dir);
  db.prepare("INSERT INTO teachers (id, email, name, pass_hash, created) VALUES (1, 'l@x.dk', 'Mette', 'x', 0)").run();
  db.prepare("INSERT INTO classes (id, teacher_id, name, created) VALUES (1, 1, '2.g', 0)").run();
  db.prepare("INSERT INTO students (id, class_id, name, created, enrolled) VALUES (1, 1, 'Anna', 0, 1), (2, 1, 'Bo', 0, 1)").run();
  const done = () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { db, docs: new DocStore(db, dir, opts), anna: { id: 1, class_id: 1 }, bo: { id: 2, class_id: 1 }, done };
}
const save = (docs, st, id, text, t) => docs.save(st, { id, title: 'R', blocks: blocksOf(text), stats: { typed: text.length + 5 } }, green, 1, t);

test('kvote: højst 30 åbne dokumenter pr. elev', () => {
  const { docs, anna, bo, done } = setup();
  try {
    const ids = [];
    for (let i = 0; i < 30; i++) { const id = crypto.randomUUID(); ids.push(id); assert.ok(save(docs, anna, id, 'Hej', 1_000_000 + i).ok); }
    const r = save(docs, anna, crypto.randomUUID(), 'Hej', 2_000_000);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'Du har for mange åbne dokumenter. Aflever eller slet nogle først.');
    // De åbne dokumenter kan stadig gemmes, og en anden elev rammes ikke
    assert.ok(save(docs, anna, ids[0], 'Hej igen', 2_100_000).ok);
    assert.ok(save(docs, bo, crypto.randomUUID(), 'Hej', 2_100_000).ok);
    // Afleveret eller slettet: så er der plads igen
    docs.submit(anna, ids[1], Object.assign({ force: true }, meta), 2_200_000);
    assert.ok(save(docs, anna, crypto.randomUUID(), 'Hej', 2_300_000).ok);
    assert.strictEqual(save(docs, anna, crypto.randomUUID(), 'Hej', 2_400_000).ok, false);
    assert.ok(docs.deleteDraft(ids[2], anna.id).ok);
    assert.ok(save(docs, anna, crypto.randomUUID(), 'Hej', 2_500_000).ok);
  } finally { done(); }
});

test('kvote: højst 10 MB pr. elev (dokumenter og afspilning)', () => {
  const { docs, anna, bo, done } = setup({ quotaBytes: 20_000 });
  try {
    // Hver gemning: 2.500 nye tegn hvert 3. minut (ingen flag om tempo – kun pladsen tæller her)
    const id = crypto.randomUUID();
    let text = '';
    let t = 1_000_000;
    let r;
    for (let i = 0; i < 20; i++) {
      text += 'a'.repeat(2500);
      r = save(docs, anna, id, text, t);
      if (!r.ok) break;
      t += 180_000;
    }
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'Der er ikke mere plads til dine dokumenter. Tal med din lærer.');
    // Dokumentet er ikke ændret, og der er ingen ny version
    const before = docs.versions(id).length;
    assert.strictEqual(save(docs, anna, id, text, t + 1000).ok, false);
    assert.strictEqual(docs.versions(id).length, before);
    // At gøre teksten kortere går altid
    assert.ok(save(docs, anna, id, 'kort', t + 2000).ok);
    // Bo har sin egen kvote
    assert.ok(save(docs, bo, crypto.randomUUID(), 'Hej', t).ok);
  } finally { done(); }
  // Standarden er 10 MB
  const s = setup();
  try { assert.strictEqual(s.docs.quotaBytes, 10 * 1024 * 1024); assert.strictEqual(s.docs.maxOpenDocs, 30); } finally { s.done(); }
});

test('kvote: vækst over 3.000 tegn siden sidste gemning afvises, og der gemmes ingen version', () => {
  const { docs, anna, done } = setup();
  try {
    const id = crypto.randomUUID();
    assert.ok(save(docs, anna, id, 'Begyndelsen.', 1_000_000).ok);
    const n = docs.versions(id).length;
    const r = save(docs, anna, id, 'Begyndelsen. ' + 'x'.repeat(3001), 1_400_000);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /højst 3\.000 nye tegn/);
    assert.strictEqual(docs.versions(id).length, n, 'ingen ny version');
    assert.strictEqual(docs.full(id).words, 1, 'teksten hos serveren er uændret');
    // Et nyt dokument med over 3.000 tegn første gang afvises også
    assert.strictEqual(save(docs, anna, crypto.randomUUID(), 'y'.repeat(3001), 1_500_000).ok, false);
    // 3.000 tegn er lige netop i orden
    assert.ok(save(docs, anna, id, 'Begyndelsen.' + 'z'.repeat(3000), 1_600_000).ok);
  } finally { done(); }
});
