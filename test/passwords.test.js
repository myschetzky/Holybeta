'use strict';
// Blokliste for adgangskoder (NIST SP 800-63B-4): almindelige, ord + tal/år, rækker og lærerens egne ord
const test = require('node:test');
const assert = require('node:assert');
const { weakReason } = require('../server/src/passwords.js');

const ctx = { email: 'mette.holm@aarhus-gym.dk', name: 'Mette Holm', school: 'Aarhus Gymnasium' };

test('afviser almindelige og lette adgangskoder', () => {
  const weak = [
    'password123', 'Password1234', 'kodeord1234', 'Kodeord!!', 'adgangskode1', 'hemmeligt123', 'Hemmelighed2024',
    'Sommer2024!', 'vinter2025', 'Efterår2023', '1234567890', '0987654321', 'qwertyuiop', 'QWERTYUIOPÅ', 'asdfghjklæø',
    'aaaaaaaaaaaa', 'abababababab', 'abcabcabcabc', '!!!!!!!!!!!!', 'iloveyou123', 'Danmark2024', 'fodbold1234',
    'københavn123', 'qwerty12345', '1q2w3e4r5t', 'HolyMoly2026', 'holy-moly-2026',
  ];
  for (const pw of weak) assert.ok(weakReason(pw, ctx), 'skulle afvises: ' + pw);
});

test('afviser lærerens eget navn, e-mail og skole', () => {
  for (const pw of ['mette.holm', 'MetteHolm2024', 'mette-mette-1', 'holm-holm-holm', 'aarhusgymnasium', 'AarhusGymnasium1', 'mette.holm@aarhus', 'holymoly.mette'])
    assert.match(weakReason(pw, ctx) || '', /navn/, 'skulle afvises: ' + pw);
});

test('godtager gode adgangskoder – også lange sætninger og æøå', () => {
  const good = [
    'tavle-kridt-1234', 'korrekt hest batteri hæfteklamme', 'Blåbær-Tog-77', 'nyt-kodeord-123', 'kodeord-boss1',
    'demo-kodeord', 'mette elsker blåbærtærte', 'R7#kQ9!mZ2', 'sommerfugle i maven', 'xk4-pl9-vv2-mq8',
  ];
  for (const pw of good) assert.strictEqual(weakReason(pw, ctx), null, 'skulle godtages: ' + pw);
});

test('uden kontekst virker reglerne stadig', () => {
  assert.ok(weakReason('kodeord1234'));
  assert.strictEqual(weakReason('tavle-kridt-1234'), null);
});

test('scrypt med OWASP-styrke; gamle hashes virker og opgraderes', async () => {
  const crypto = require('node:crypto');
  const U = require('../server/src/util.js');
  const h = U.hashPassword('tavle-kridt-1234');
  assert.match(h, /^scrypt\$N=16384,r=8,p=5\$/);
  assert.ok(U.verifyPassword('tavle-kridt-1234', h));
  assert.ok(!U.verifyPassword('tavle-kridt-1235', h));
  assert.strictEqual(U.needsRehash(h), false);
  // Gammelt format fra før (N=2^14, r=8, p=1)
  const salt = crypto.randomBytes(16);
  const legacy = 'scrypt$' + salt.toString('base64') + '$' + crypto.scryptSync('gammel-kode-123', salt, 64, { N: 16384, r: 8, p: 1 }).toString('base64');
  assert.ok(U.verifyPassword('gammel-kode-123', legacy), 'gamle hashes virker stadig');
  assert.strictEqual(U.needsRehash(legacy), true, 'og skal opgraderes');
  // Ødelagte/urimelige parametre afvises i stedet for at bruge al hukommelsen
  for (const bad of ['scrypt$N=1048577,r=8,p=1$a$b', 'scrypt$N=4194304,r=8,p=1$a$b', 'scrypt$N=16384,r=99,p=1$a$b', 'scrypt$N=16000,r=8,p=1$a$b', 'bcrypt$x$y', ''])
    assert.strictEqual(U.verifyPassword('x', bad), false, bad);
});

test('login opgraderer en gammel hash', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
  const { createServer } = require('../server/src/index.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-pw-'));
  const s = createServer({ port: 0, host: '127.0.0.1', dataDir: dir, signupCode: 'k', quiet: true, requireGuard: false });
  const b = 'http://127.0.0.1:' + await s.listen();
  try {
    const post = (p, body) => fetch(b + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    await post('/api/register', { email: 'gammel@skole.dk', name: 'G', password: 'tavle-kridt-1234', signupCode: 'k' });
    const salt = crypto.randomBytes(16);
    const legacy = 'scrypt$' + salt.toString('base64') + '$' + crypto.scryptSync('tavle-kridt-1234', salt, 64, { N: 16384, r: 8, p: 1 }).toString('base64');
    s.db.prepare('UPDATE teachers SET pass_hash = ?').run(legacy);
    assert.strictEqual((await post('/api/login', { email: 'gammel@skole.dk', password: 'forkert-kode-1' })).status, 401);
    assert.strictEqual(s.db.prepare('SELECT pass_hash FROM teachers').get().pass_hash, legacy, 'forkert adgangskode ændrer intet');
    assert.strictEqual((await post('/api/login', { email: 'gammel@skole.dk', password: 'tavle-kridt-1234' })).status, 200);
    assert.match(s.db.prepare('SELECT pass_hash FROM teachers').get().pass_hash, /^scrypt\$N=16384,r=8,p=5\$/, 'opgraderet ved rigtigt login');
    assert.strictEqual((await post('/api/login', { email: 'gammel@skole.dk', password: 'tavle-kridt-1234' })).status, 200, 'og virker bagefter');
  } finally {
    await s.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* Windows */ }
  }
});
