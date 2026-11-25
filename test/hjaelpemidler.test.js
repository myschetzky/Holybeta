'use strict';
// Hjælpemidler: autotyper-tjekket bevares med ordforslag (kun diktering lemper tempoet), eleven ser dem i skrivevinduet,
// hver ændring står i revisionssporet, de udløber ved skoleårets slutning, og de sættes i elevskuffen ved "+ tid".
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require(require.resolve('ws', { paths: [path.join(__dirname, '..', 'server')] }));
const D = require('../shared/doc.js');
const dbm = require('../server/src/db.js');
const RET = require('../server/src/retention.js');
const { createServer } = require('../server/src/index.js');

const TEXT = 'Romantikken var en periode i kunsten hvor følelser og natur fik en stor plads. '.repeat(9).trim();
const base = { typed: TEXT.length + 40, keystrokes: 900 };
const cats = (stats, aids) => D.evaluateStats(TEXT, Object.assign({}, base, stats), { aids }).cats;

test('autotyper-tjekket: ordforslag lemper kun byger – diktering lemper tempoet', () => {
  const autotyper = [{ regularity: 0.05 }, { fastShare: 0.6 }];
  for (const s of autotyper) {
    assert.deepStrictEqual(cats(s, []), ['tempo'], JSON.stringify(s));
    assert.deepStrictEqual(cats(s, ['ordforslag']), ['tempo'], 'ordforslag giver ikke frikort: ' + JSON.stringify(s));
    assert.deepStrictEqual(cats(s, ['diktering']), [], 'diktering: ' + JSON.stringify(s));
  }
  assert.deepStrictEqual(cats({ burst: 50 }, ['ordforslag']), [], 'byger: ordforslag sætter hele ord ind');
  // Word med tastetryk: taster fra et program (autotyper/makro) – kun diktering gør det til en note
  const word = (aids) => D.evaluateStats(TEXT, { keys: true, typed: TEXT.length + 40, keystrokes: 900, injected: 400 }, { word: true, aids }).cats;
  assert.deepStrictEqual(word(['ordforslag']), ['tempo']);
  assert.deepStrictEqual(word(['diktering']), []);
  // Uanset hjælpemidler: hurtigere end et menneske er altid en grund
  assert.deepStrictEqual(cats({ maxCps: 40 }, ['ordforslag', 'diktering']), ['tempo']);
});

test('skoleårets slutning: hjælpemidlerne udløber 31. juli', () => {
  assert.strictEqual(new Date(dbm.schoolYearEnd(Date.UTC(2026, 10, 25))).toISOString(), '2027-07-31T22:00:00.000Z');
  assert.strictEqual(new Date(dbm.schoolYearEnd(Date.UTC(2027, 2, 1))).toISOString(), '2027-07-31T22:00:00.000Z');
  assert.strictEqual(new Date(dbm.schoolYearEnd(Date.UTC(2027, 7, 2))).toISOString(), '2028-07-31T22:00:00.000Z');
  const until = Date.UTC(2027, 6, 31, 22);
  assert.deepStrictEqual(dbm.activeAids({ aids: '["ordforslag"]', aids_until: until }, until - 1), ['ordforslag']);
  assert.deepStrictEqual(dbm.activeAids({ aids: '["ordforslag"]', aids_until: until }, until), []);
  assert.deepStrictEqual(dbm.activeAids({ aids: null }), []);
});

test('serveren: PUT sætter udløb og revisionsspor; udløbne hjælpemidler tæller ikke og slettes af oprydningen', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-aids-'));
  const srv = createServer({ port: 0, host: '127.0.0.1', dataDir: dir, signupCode: 'k', quiet: true, requireGuard: false });
  const url = 'http://127.0.0.1:' + await srv.listen();
  let ck = '';
  const call = async (method, p, body) => {
    const r = await fetch(url + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, ck ? { Cookie: ck } : {}), body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) ck = sc.split(';')[0];
    return Object.assign(await r.json().catch(() => ({})), { _status: r.status });
  };
  try {
    await call('POST', '/api/register', { email: 'l@x.dk', name: 'Mette', password: 'tavle-kridt-1234', signupCode: 'k' });
    const cls = await call('POST', '/api/classes', { name: '2.g' });
    const en = await (await fetch(url + '/api/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: cls.joinCode, name: 'Anna' }) })).json();
    const s = await call('PUT', `/api/students/${en.studentId}/aids`, { aids: ['ordforslag'] });
    assert.deepStrictEqual(s.aids, ['ordforslag']);
    assert.strictEqual(s.aidsUntil, dbm.schoolYearEnd(), 'gælder til skoleårets slutning');
    assert.strictEqual(srv.db.prepare('SELECT aids_until FROM students WHERE id = ?').get(en.studentId).aids_until, dbm.schoolYearEnd());
    const audit = srv.db.prepare('SELECT action, teacher_id FROM audit_log WHERE student_id = ?').all(en.studentId);
    assert.deepStrictEqual(audit.map(a => a.action), ['ændrede hjælpemidler'], 'revisionssporet');
    // Eleven får dem i lesson-beskeden
    const ag = new WebSocket(url.replace('http', 'ws') + '/ws/agent');
    const msgs = [];
    ag.on('message', (d, bin) => { if (!bin) msgs.push(JSON.parse(d.toString())); });
    await new Promise(r => ag.on('open', r));
    const wait = async (f) => { for (let i = 0; i < 200; i++) { const m = msgs.find(f); if (m) { msgs.splice(msgs.indexOf(m), 1); return m; } await new Promise(r => setTimeout(r, 20)); } throw new Error('ingen besked'); };
    ag.send(JSON.stringify({ type: 'hello', tokens: [en.token], device: { os: 'Linux', host: 'PC', version: '1.3.0' } }));
    await wait(m => m.type === 'welcome');
    await call('POST', `/api/classes/${cls.id}/lesson`, { action: 'start', minutes: 45 });
    assert.deepStrictEqual((await wait(m => m.type === 'lesson' && m.live)).aids, ['ordforslag']);
    ag.close();
    // Skoleåret er slut: hjælpemidlerne tæller ikke længere – i dashboardet, hos appen og i vurderingen
    srv.db.prepare('UPDATE students SET aids_until = ? WHERE id = ?').run(Date.now() - 1000, en.studentId);
    const c = await call('GET', '/api/classes/' + cls.id);
    assert.deepStrictEqual(c.students.find(x => x.id === en.studentId).aids, []);
    assert.deepStrictEqual(srv.hub._aidsOf(en.studentId), []);
    assert.deepStrictEqual(srv.docs.aidsOf(en.studentId), []);
    // Natlig oprydning sletter dem helt
    const out = RET.purge(srv.db, RET.fromEnv({}));
    assert.strictEqual(out.aidsExpired, 1);
    assert.deepStrictEqual({ ...srv.db.prepare('SELECT aids, aids_until FROM students WHERE id = ?').get(en.studentId) }, { aids: null, aids_until: null });
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dashboard og elev-app: "Hjælpemidler" i elevskuffen ved "+ tid", ikke i redigeringen – og eleven ser dem i skrivevinduet', () => {
  const pub = (f) => fs.readFileSync(path.join(__dirname, '..', 'server', 'public', f), 'utf8');
  const idx = pub('index.html');
  assert.match(idx, /<button class="btn" id="d-extra" hidden>\+ tid<\/button>\s*<button class="btn" id="d-aids"[^>]*>Hjælpemidler<\/button>/);
  const app = pub('app.js');
  const edit = app.slice(app.indexOf('async function editStudent('), app.indexOf('async function', app.indexOf('async function editStudent(') + 10));
  assert.ok(!/aidBox|Hjælpemidler'|\/aids`/.test(edit), 'ikke i redigeringstilstanden');
  assert.match(app, /async function editAids\(id\)/);
  assert.match(app, /\$\('#d-aids'\)\.addEventListener\('click', \(\) => \{ if \(state\.open != null\) editAids\(state\.open\); \}\);/);
  assert.match(app, /\$\('#d-aids'\)\.textContent = aidsLabel\(s\);/);
  // Elev-appen: skrivevinduet viser hjælpemidlerne
  const ag = (f) => fs.readFileSync(path.join(__dirname, '..', 'agent', 'renderer', f), 'utf8');
  assert.match(ag('write.html'), /<span id="aids" class="aids"[^>]*hidden><\/span>/);
  const js = ag('write.js');
  assert.match(js, /'Hjælpemidler: ' \+ names\.join\(' og '\)/);
  assert.match(js, /window\.hmw\.onAids\(\(list\) => \{ aids = Array\.isArray\(list\) \? list : \[\]; showAids\(\);/);
});
