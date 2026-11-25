'use strict';
// Sletning efter ophør (databehandleraftalen): varsler 30 og 7 dage før, aldrig uden varsel, fakturagrundlag bevares
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../server/src/index.js');

const DAY = 86400_000;

test('skolens data slettes efter ophør – med varsel, og kun på licens-servere', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-purge-'));
  const mails = [];
  const s = createServer({ port: 0, host: '127.0.0.1', dataDir: dir, quiet: true, requireGuard: false, licensing: true,
    mailSend: async (m) => { mails.push(m); }, publicUrl: 'https://holymoly.test', trialDays: 30 });
  const b = 'http://127.0.0.1:' + await s.listen();
  try {
    const reg = (email, schoolName) => fetch(b + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, name: 'Admin', password: 'tavle-kridt-1234', schoolName, acceptTerms: true }) }).then(r => r.json());
    await reg('a@skole-a.dk', 'Skole A');
    await reg('b@skole-b.dk', 'Skole B');
    await reg('c@skole-c.dk', 'Skole C');
    const school = (name) => s.db.prepare('SELECT * FROM schools WHERE name = ?').get(name);
    const A = school('Skole A'), B = school('Skole B'), C = school('Skole C');
    const now = Date.now();
    // A: udløbet for længe siden, aldrig varslet. B: udløbet for 65 dage siden (sletning om 25). C: aktiv licens.
    s.db.prepare('UPDATE schools SET trial_ends = ? WHERE id = ?').run(now - 200 * DAY, A.id);
    s.db.prepare('UPDATE schools SET trial_ends = ? WHERE id = ?').run(now - 65 * DAY, B.id);
    s.db.prepare('UPDATE schools SET trial_ends = ?, license_until = ? WHERE id = ?').run(now - 300 * DAY, now + 100 * DAY, C.id);
    const aTeacher = s.db.prepare('SELECT id FROM teachers WHERE school_id = ?').get(A.id).id;
    s.db.prepare("INSERT INTO classes (teacher_id, name, created) VALUES (?, '1.a', ?)").run(aTeacher, now);
    s.db.prepare("INSERT INTO license_orders (school_id, teacher_id, school_name, created, students, amount, details) VALUES (?,?,?,?,?,?,?)").run(A.id, aTeacher, 'Skole A', now - 400 * DAY, 100, 12900, '{"cvr":"12345678"}');
    mails.length = 0;

    s.retention();
    // A slettes IKKE uden varsel – får 7-dages-varslet nu
    assert.ok(school('Skole A'), 'ingen sletning uden varsel');
    const mailA = mails.find(m => m.to === 'a@skole-a.dk');
    assert.ok(mailA, 'administratoren får varsel');
    assert.match(mailA.subject, /slettes om 7 dage/);
    assert.match(mailA.text, /bestil en licens/);
    // B: 30-dages-varslet (25 dage tilbage)
    assert.match(mails.find(m => m.to === 'b@skole-b.dk').subject, /slettes om 25 dage/);
    assert.ok(!mails.some(m => m.to === 'c@skole-c.dk'), 'aktiv licens: ingen besked');

    // Samme varsel sendes ikke igen
    mails.length = 0;
    s.retention();
    assert.strictEqual(mails.length, 0, 'ingen gentagne varsler');

    // 7 dage efter varslet: A slettes – klasser og lærere med – men bestillingen (fakturagrundlag) bevares
    const notice = school('Skole A').purge_notice.split(':');
    s.db.prepare('UPDATE schools SET purge_notice = ? WHERE id = ?').run(`${notice[0]}:7:${now - 7 * DAY - 1000}`, A.id);
    s.retention();
    assert.strictEqual(school('Skole A'), undefined, 'skolen er slettet');
    assert.strictEqual(s.db.prepare('SELECT COUNT(*) AS n FROM teachers WHERE email = ?').get('a@skole-a.dk').n, 0);
    assert.strictEqual(s.db.prepare('SELECT COUNT(*) AS n FROM classes WHERE teacher_id = ?').get(aTeacher).n, 0);
    const order = s.db.prepare("SELECT * FROM license_orders WHERE school_name = 'Skole A'").get();
    assert.ok(order && order.school_id === null && /12345678/.test(order.details), 'bestillingen bevares (bogføringsloven)');
    assert.ok(school('Skole B') && school('Skole C'), 'de andre skoler er urørte');

    // B fornyer: fristen starter forfra, og intet slettes
    s.db.prepare('UPDATE schools SET license_until = ? WHERE id = ?').run(now + 365 * DAY, B.id);
    mails.length = 0;
    s.retention();
    assert.ok(school('Skole B'));
    assert.strictEqual(mails.length, 0);
  } finally {
    await s.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* Windows */ }
  }
});

test('uden licens-styring (skolens egen server) slettes intet', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-purge2-'));
  const s = createServer({ port: 0, host: '127.0.0.1', dataDir: dir, signupCode: 'k', quiet: true, requireGuard: false });
  await s.listen();
  try {
    s.db.prepare('INSERT INTO schools (name, created, trial_ends, seats) VALUES (?,?,?,0)').run('Egen skole', 0, 1);
    s.retention();
    assert.ok(s.db.prepare("SELECT 1 FROM schools WHERE name = 'Egen skole'").get());
  } finally {
    await s.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* Windows */ }
  }
});
