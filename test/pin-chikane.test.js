'use strict';
// Elevkoden må ikke kunne bruges til chikane: grænser pr. IP og pr. klasse, låsen gælder kun nye computere,
// samme svar uanset om navnet findes, og elevens egen app får en fast besked.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require(require.resolve('ws', { paths: [path.join(__dirname, '..', 'server')] }));
const { createServer } = require('../server/src/index.js');

const APPROVAL = { controller: 'Testskolen', dpo: 'dpo@kommune.dk', dpiaDate: '2026-11-01', approvedDate: '2026-11-15' };

test('elevkoden: ingen udelukkelse af den rigtige computer, samme svar for alle navne og besked til eleven', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-pin-'));
  const srv = createServer({ port: 0, host: '127.0.0.1', dataDir: dir, quiet: true, requireGuard: false, simple: true, schoolApproval: APPROVAL });
  const base = 'http://127.0.0.1:' + await srv.listen();
  let ck = '';
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, ck ? { Cookie: ck } : {}), body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) ck = sc.split(';')[0];
    return Object.assign(await r.json().catch(() => ({})), { _status: r.status });
  };
  let ag;
  try {
    assert.strictEqual((await call('POST', '/api/register', { email: 'mette', name: 'Mette', password: 'tavle-kridt-1234', acceptTerms: true, signupCode: srv.setupCode() })).ok, true);
    const cls = await call('POST', '/api/classes', { name: '2.g' });
    const enroll = async (body) => {
      const r = await fetch(base + '/api/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ accept: true, code: cls.joinCode }, body)) });
      return Object.assign(await r.json().catch(() => ({})), { _status: r.status });
    };
    const anna = await enroll({ name: 'Anna Jensen', pin: '4821' });
    assert.ok(anna.token);

    // Annas app er forbundet
    ag = new WebSocket(base.replace('http', 'ws') + '/ws/agent');
    const msgs = [];
    ag.on('message', (d, bin) => { if (!bin) msgs.push(JSON.parse(d.toString())); });
    await new Promise(r => ag.on('open', r));
    ag.send(JSON.stringify({ type: 'hello', tokens: [anna.token], device: { os: 'Windows 11', host: 'PC', version: '1.3.0' } }));
    for (let i = 0; i < 100 && !msgs.some(m => m.type === 'welcome'); i++) await new Promise(r => setTimeout(r, 20));

    // En klassekammerat prøver Annas navn med forkerte koder, indtil koden er låst
    const wrong = await enroll({ name: 'Anna Jensen', pin: '1357' });
    assert.strictEqual(wrong._status, 401);
    srv.db.prepare('UPDATE students SET pin_fails = 10 WHERE id = ?').run(anna.studentId);
    const locked = await enroll({ name: 'Anna Jensen', pin: '4821' });
    // Samme svar for forkert kode og låst kode – svaret afslører ikke, hvordan det står til
    assert.strictEqual(locked._status, wrong._status);
    assert.strictEqual(locked.error, wrong.error);
    assert.ok(!locked.token, 'en ny computer kommer ikke ind, når koden er låst');
    // Annas egen app har fået den faste besked
    for (let i = 0; i < 100 && !msgs.some(m => m.type === 'notice'); i++) await new Promise(r => setTimeout(r, 20));
    assert.deepStrictEqual(msgs.find(m => m.type === 'notice'), { type: 'notice', kind: 'pin-attempt' });
    // Annas egen computer kommer stadig ind uden kode (samme nøgle – intet tilbagekaldes)
    const own = await enroll({ name: 'Anna Jensen', known: [anna.token] });
    assert.strictEqual(own.token, anna.token);
    assert.strictEqual(own.studentId, anna.studentId);
    // En forkert nøgle hjælper ikke
    assert.ok(!(await enroll({ name: 'Anna Jensen', pin: '4821', known: ['x'.repeat(43)] })).token);

    // Pr. klasse: én elev kan ikke prøve løs på hele klassens koder – og grænsen gælder alle navne
    for (const n of ['Bo', 'Carl', 'Dorte', 'Emil']) assert.ok((await enroll({ name: n + ' Hansen', pin: '7391' })).token);
    let limited = null;
    for (let i = 0; i < 40 && !limited; i++) {
      const r = await enroll({ name: ['Bo', 'Carl', 'Dorte', 'Emil'][i % 4] + ' Hansen', pin: String(2000 + i) });
      if (r._status === 429) limited = r;
    }
    assert.ok(limited, 'forkerte forsøg i klassen er begrænset');
    const newName = await enroll({ name: 'Findes Ikke', pin: '7391' });
    assert.strictEqual(newName._status, 429, 'samme svar for et navn, der ikke findes');
    assert.strictEqual(newName.error, limited.error);

    // Appen sender sine nøgler med, og viser beskeden som en fast tekst
    const main = fs.readFileSync(path.join(__dirname, '..', 'agent/src/main.js'), 'utf8');
    assert.match(main, /known: state\.data\.enrollments\.map\(e => e\.token\)/);
    assert.match(main, /if \(msg\.kind === 'pin-attempt'\) notifyStudent\(PIN_ATTEMPT_TEXT\)/);
  } finally {
    if (ag) ag.close();
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
