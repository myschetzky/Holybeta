'use strict';
// Sikkerhedslog til skolens administrator (OWASP A09)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../server/src/index.js');

function client(base) {
  let ck = '';
  return async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, ck ? { Cookie: ck } : {}), body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) ck = sc.split(';')[0];
    return Object.assign(await r.json().catch(() => ({})), { _status: r.status });
  };
}

test('sikkerhedsloggen: logins, fejl, ændringer og administratorhandlinger – kun for skolens administrator', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-seclog-'));
  const mails = [];
  const s = createServer({ port: 0, host: '127.0.0.1', dataDir: dir, quiet: true, requireGuard: false, licensing: true, verifyEmail: false,
    mailSend: async (m) => { mails.push(m); }, publicUrl: 'https://holymoly.test' });
  const b = 'http://127.0.0.1:' + await s.listen();
  try {
    const A = client(b);
    assert.strictEqual((await A('POST', '/api/register', { email: 'admin@skole.dk', name: 'Ada Admin', password: 'tavle-kridt-1234', schoolName: 'Log Skole', acceptTerms: true }))._status, 200);
    // Forkert adgangskode og rigtigt login
    assert.strictEqual((await client(b)('POST', '/api/login', { email: 'admin@skole.dk', password: 'forkert-kode-99' }))._status, 401);
    assert.strictEqual((await A('POST', '/api/login', { email: 'admin@skole.dk', password: 'tavle-kridt-1234' }))._status, 200);
    // Ukendt e-mail logges ikke (ingen skole at vise det for – og ingen oplysning om, hvem der findes)
    await client(b)('POST', '/api/login', { email: 'findes.ikke@skole.dk', password: 'forkert-kode-99' });
    // Invitation + kollega slutter sig til
    assert.deepStrictEqual((await A('POST', '/api/school/invites', { emails: ['kollega@skole.dk'] })).sent, ['kollega@skole.dk']);
    const tok = /invitation=([A-Za-z0-9_-]+)/.exec(mails.find(m => m.to === 'kollega@skole.dk').text)[1];
    const K = client(b);
    assert.strictEqual((await K('POST', '/api/register', { email: 'kollega@skole.dk', name: 'Karl Kollega', password: 'tavle-kridt-5678', invite: tok, acceptTerms: true }))._status, 200);
    // Kollegaen skifter adgangskode; administratoren gør ham til administrator og tilbage
    assert.strictEqual((await K('POST', '/api/account/password', { current: 'tavle-kridt-5678', password: 'kridt-tavle-9999' }))._status, 200);
    const kid = s.db.prepare("SELECT id FROM teachers WHERE email = 'kollega@skole.dk'").get().id;
    await A('PATCH', '/api/school/teachers/' + kid, { role: 'admin' });
    await A('PATCH', '/api/school/teachers/' + kid, { role: 'teacher' });

    // Kun administratoren kan se loggen
    assert.strictEqual((await K('GET', '/api/school/security-log'))._status, 403);
    const log = await A('GET', '/api/school/security-log');
    assert.strictEqual(log._status, 200);
    assert.strictEqual(log.keepDays, 90);
    const texts = log.entries.map(e => `${e.kind}: ${e.text}`);
    const has = (re) => assert.ok(texts.some(t => re.test(t)), `mangler ${re} i:\n${texts.join('\n')}`);
    has(/^login-fail: Ada Admin: forkert adgangskode$/);
    has(/^login: Ada Admin loggede ind \(adgangskode, uden to-faktor\)$/);
    has(/^admin: Ada Admin inviterede kollega@skole\.dk som lærer$/);
    has(/^admin: Karl Kollega sluttede sig til skolen via en invitation$/);
    has(/^account: Karl Kollega: Adgangskoden til din HolyMoly-konto blev ændret$/);
    has(/^admin: Ada Admin gjorde Karl Kollega til administrator$/);
    has(/^admin: Ada Admin gjorde Karl Kollega til lærer$/);
    assert.ok(!texts.some(t => /findes\.ikke/.test(t)), 'ukendte e-mails logges ikke');
    assert.ok(log.entries.every(e => e.ip === '127.0.0.1' || e.ip === '::ffff:127.0.0.1'), 'IP-adressen gemmes');
    assert.ok(log.entries[0].ts >= log.entries[log.entries.length - 1].ts, 'nyeste først');

    // En anden skoles administrator ser intet herfra
    const O = client(b);
    await O('POST', '/api/register', { email: 'other@anden.dk', name: 'Olga', password: 'tavle-kridt-1234', schoolName: 'Anden Skole', acceptTerms: true });
    const other = await O('GET', '/api/school/security-log');
    assert.ok(other.entries.every(e => !/Ada|Karl/.test(e.text)), 'kun egen skoles hændelser');

    // Slettes efter 90 dage
    s.db.prepare('UPDATE security_log SET ts = ? WHERE text LIKE ?').run(Date.now() - 91 * 86400_000, '%forkert adgangskode%');
    s.retention();
    assert.ok(!(await A('GET', '/api/school/security-log')).entries.some(e => e.kind === 'login-fail'), 'gamle hændelser slettet');
  } finally {
    await s.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* Windows */ }
  }
});
