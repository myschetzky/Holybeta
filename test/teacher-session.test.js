'use strict';
// Lærerens WebSocket lukkes (4401), når login-sessionen ophører: logout, ny adgangskode eller udløb
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require(require.resolve('ws', { paths: [path.join(__dirname, '..', 'server')] }));
const { createServer } = require('../server/src/index.js');

function client(base) {
  let ck = '';
  return {
    get cookie() { return ck; },
    async call(method, p, body) {
      const r = await fetch(base + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, ck ? { Cookie: ck } : {}), body: body ? JSON.stringify(body) : undefined });
      const sc = r.headers.get('set-cookie'); if (sc) ck = sc.split(';')[0].endsWith('=') ? '' : sc.split(';')[0];
      const text = await r.text();
      try { return Object.assign(JSON.parse(text), { _status: r.status }); } catch (e) { return { _status: r.status, _text: text }; }
    },
  };
}
/** Åbner klasseværelset og returnerer et løfte om lukkekoden (og hvor længe der gik). */
async function room(base, cookie, classId) {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws/teacher?classId=' + classId, { headers: { Cookie: cookie, Origin: base } });
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  ws.closed = new Promise((r) => ws.on('close', (code) => r({ code, at: Date.now() })));
  return ws;
}
const within = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r({ code: 'timeout' }), ms))]);

test('lærer-WebSocket: lukkes ved ny adgangskode, logout og udløbet session', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-tsess-'));
  const srv = createServer({ port: 0, host: '127.0.0.1', dataDir: dir, quiet: true, requireGuard: false, signupCode: 'k' });
  const base = 'http://127.0.0.1:' + await srv.listen();
  try {
    const A = client(base), B = client(base);
    let r = await A.call('POST', '/api/register', { email: 'mette@skole.dk', name: 'Mette', password: 'tavle-kridt-1234', signupCode: 'k' });
    assert.strictEqual(r._status, 200);
    r = await B.call('POST', '/api/login', { email: 'mette@skole.dk', password: 'tavle-kridt-1234' });
    assert.ok(r.ok);
    const cls = await A.call('POST', '/api/classes', { name: '2.g' });

    // Ny adgangskode i A: B's klasseværelse lukkes inden for 1 sek. – A's eget bliver åbent
    const wsA = await room(base, A.cookie, cls.id);
    const wsB = await room(base, B.cookie, cls.id);
    const t0 = Date.now();
    r = await A.call('POST', '/api/account/password', { current: 'tavle-kridt-1234', password: 'blyant-viskelaeder-99' });
    assert.ok(r.ok);
    const closedB = await within(wsB.closed, 1000);
    assert.strictEqual(closedB.code, 4401, 'den anden session lukkes med 4401');
    assert.ok(closedB.at - t0 < 1000);
    assert.strictEqual((await within(wsA.closed, 200)).code, 'timeout', 'sessionen, der skiftede adgangskode, beholder forbindelsen');

    // Logout i A: A's klasseværelse lukkes
    r = await A.call('POST', '/api/logout', {});
    assert.ok(r.ok);
    assert.strictEqual((await within(wsA.closed, 1000)).code, 4401, 'logout lukker forbindelsen');

    // Udløbet session: heartbeat lukker forbindelsen
    const C = client(base);
    await C.call('POST', '/api/login', { email: 'mette@skole.dk', password: 'blyant-viskelaeder-99' });
    const wsC = await room(base, C.cookie, cls.id);
    srv.hub.heartbeat();
    assert.strictEqual((await within(wsC.closed, 200)).code, 'timeout', 'en gyldig session lukkes ikke');
    srv.db.prepare('UPDATE sessions SET expires = ?').run(Date.now() - 1000);
    srv.hub.heartbeat();
    assert.strictEqual((await within(wsC.closed, 1000)).code, 4401, 'en udløbet session lukkes af heartbeat');

    // Den absolutte grænse (SESSION_MAX_HOURS) gælder også, selv om sessionen er forlænget
    const D = client(base);
    await D.call('POST', '/api/login', { email: 'mette@skole.dk', password: 'blyant-viskelaeder-99' });
    const wsD = await room(base, D.cookie, cls.id);
    srv.db.prepare('UPDATE sessions SET created = ?').run(Date.now() - 25 * 3600_000);
    srv.hub.heartbeat();
    assert.strictEqual((await within(wsD.closed, 1000)).code, 4401, 'for gammel session lukkes');
  } finally { await srv.close(); }
});

test('dashboardet viser "Du er logget ud. Log ind igen." ved 4401', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'public', 'app.js'), 'utf8');
  assert.match(src, /e\.code === 4401/);
  assert.ok(src.includes('Du er logget ud. Log ind igen.'));
});
