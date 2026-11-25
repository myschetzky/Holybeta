'use strict';
// UNI-Login (OpenID Connect) mod en simuleret UNI-Login-udbyder med rigtige RS256-signerede tokens
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { createServer } = require('../server/src/index.js');

function mockProvider() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const evil = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const jwk = Object.assign(publicKey.export({ format: 'jwk' }), { kid: 'k1', use: 'sig', alg: 'RS256' });
  const codes = new Map();
  const P = { user: null, signWith: privateKey, good: privateKey, base: '', tokens: new Map() };
  const sign = (claims, key) => {
    const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' })).toString('base64url');
    const b = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return h + '.' + b + '.' + crypto.sign('sha256', Buffer.from(h + '.' + b), key).toString('base64url');
  };
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, P.base);
    const json = (o, s = 200) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u.pathname === '/.well-known/openid-configuration') return json({ issuer: P.base, authorization_endpoint: P.base + '/auth', token_endpoint: P.base + '/token', jwks_uri: P.base + '/jwks', userinfo_endpoint: P.base + '/userinfo' });
    // Som STIL's broker: institutioner (instnr/instnavn) i userinfo
    if (u.pathname === '/userinfo') {
      const at = String(req.headers.authorization || '').replace(/^Bearer /, '');
      const usr = P.tokens.get(at);
      if (!usr) return json({ error: 'invalid_token' }, 401);
      return json({ sub: 'sub-' + usr.uniid, inst_brugere: (usr.inst || []).map(i => ({ instnr: i.nr, instnavn: i.name })) });
    }
    if (u.pathname === '/jwks') return json({ keys: [jwk] });
    if (u.pathname === '/auth') {
      // "Brugeren logger ind": udbyderen sender en kode tilbage
      assert.strictEqual(u.searchParams.get('code_challenge_method'), 'S256');
      const code = crypto.randomBytes(8).toString('hex');
      codes.set(code, { nonce: u.searchParams.get('nonce'), challenge: u.searchParams.get('code_challenge'), user: P.user, aud: u.searchParams.get('client_id') });
      res.writeHead(302, { Location: u.searchParams.get('redirect_uri') + '?code=' + code + '&state=' + u.searchParams.get('state') });
      return res.end();
    }
    if (u.pathname === '/token' && req.method === 'POST') {
      let body = ''; for await (const c of req) body += c;
      const f = new URLSearchParams(body);
      const c = codes.get(f.get('code')); codes.delete(f.get('code'));
      if (!c) return json({ error: 'invalid_grant' }, 400);
      // PKCE: verifier skal passe til challenge
      if (crypto.createHash('sha256').update(f.get('code_verifier')).digest('base64url') !== c.challenge) return json({ error: 'invalid_grant' }, 400);
      if (req.headers.authorization !== 'Basic ' + Buffer.from('holymoly:hemmelig').toString('base64')) return json({ error: 'invalid_client' }, 401);
      const now = Math.floor(Date.now() / 1000);
      const at = crypto.randomBytes(16).toString('hex');
      P.tokens.set(at, c.user);
      const { inst, ...claims } = c.user;
      return json({ access_token: at, id_token: sign(Object.assign({ iss: P.base, aud: c.aud, iat: now, exp: now + 300, nonce: c.nonce, sub: 'sub-' + c.user.uniid, institution_ids: (inst || []).map(i => i.nr) }, claims), P.signWith) });
    }
    res.writeHead(404); res.end();
  });
  return { P, srv, evil };
}

test('UNI-Login: lærer- og elev-login, elev-appen og forfalskninger', async () => {
  const mp = mockProvider();
  await new Promise(r => mp.srv.listen(0, '127.0.0.1', r));
  mp.P.base = 'http://127.0.0.1:' + mp.srv.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-uni-'));
  const uniCfg = { enabled: true, issuer: mp.P.base, clientId: 'holymoly', clientSecret: 'hemmelig', redirectUri: '', scope: 'openid', roleClaim: 'roller', teacherRoles: /l(æ|ae)rer/i, idClaim: 'uniid' };
  const srv = createServer({ port: 0, host: '127.0.0.1', dataDir: dir, signupCode: 'k', quiet: true, uniLogin: uniCfg });
  const port = await srv.listen();
  const base = 'http://127.0.0.1:' + port;
  uniCfg.redirectUri = base + '/api/auth/unilogin/callback';

  // Hele login-turen: start -> "UNI-Login" -> tilbage til HolyMoly. Returnerer det sidste svar.
  // Browserens "cookie" for forsøget (hm_oidc) følger med tilbage – som i en rigtig browser.
  async function login(query, user, { tamper, otherBrowser } = {}) {
    mp.P.user = user;
    const s = await fetch(base + '/api/auth/unilogin/start?' + query, { redirect: 'manual' });
    assert.strictEqual(s.status, 302);
    const oidc = (s.headers.get('set-cookie') || '').split(';')[0];
    assert.match(oidc, /^hm_oidc=/);
    const a = await fetch(s.headers.get('location'), { redirect: 'manual' });
    let cb = a.headers.get('location');
    if (tamper) cb = tamper(cb);
    const r = await fetch(cb, { redirect: 'manual', headers: otherBrowser ? {} : { Cookie: oidc } });
    return { r, cb, oidc };
  }
  const cookieOf = (r, name) => (r.headers.getSetCookie() || []).map(c => c.split(';')[0]).find(c => c.startsWith(name + '=') && c.length > name.length + 1);
  try {
    assert.strictEqual((await (await fetch(base + '/api/info')).json()).uniLogin, true);

    // 1) Lærer med lærer-rolle: konto oprettes og logges ind
    let { r, cb, oidc } = await login('role=teacher', { uniid: 'L100', name: 'Mette Lærer', roller: ['Lærer'] });
    assert.strictEqual(r.status, 302);
    assert.strictEqual(r.headers.get('location'), '/');
    const cookie = cookieOf(r, 'hm_session');
    const me = await (await fetch(base + '/api/me', { headers: { Cookie: cookie } })).json();
    assert.strictEqual(me.name, 'Mette Lærer');

    // Samme svar kan ikke bruges igen (state er engangs)
    const again = await fetch(cb, { redirect: 'manual', headers: { Cookie: oidc } });
    assert.match(decodeURIComponent(again.headers.get('set-cookie')), /udløbet/);

    // 1b) Login-CSRF: et login-link (fra en andens forsøg) kan ikke afsluttes i en anden browser
    ({ r } = await login('role=teacher', { uniid: 'L100', name: 'Mette Lærer', roller: ['Lærer'] }, { otherBrowser: true }));
    assert.match(decodeURIComponent(r.headers.get('set-cookie')), /ikke startet i denne browser/);
    // Teksten står ikke i adressen (så ingen kan lave et ægte login-link med deres egen besked)
    assert.strictEqual(r.headers.get('location'), '/login?fejl=1');
    assert.match(r.headers.get('set-cookie'), /hm_loginmsg=[^;]*; Path=\/login; Max-Age=120/);
    assert.ok(!cookieOf(r, 'hm_session'), 'ingen session til den forkerte browser');

    // 2) En elev kan ikke logge ind som lærer
    ({ r } = await login('role=teacher', { uniid: 'E200', name: 'Anna Jensen', roller: ['Elev'] }));
    assert.match(decodeURIComponent(r.headers.get('set-cookie')), /ikke en lærer-konto/);

    // 3) Forfalsket token (signeret med en anden nøgle) afvises
    mp.P.signWith = mp.evil;
    ({ r } = await login('role=teacher', { uniid: 'L100', name: 'Mette Lærer', roller: ['Lærer'] }));
    assert.match(decodeURIComponent(r.headers.get('set-cookie')), /forkert signatur/);
    mp.P.signWith = mp.P.good;
  } catch (e) { await srv.close(); await new Promise(r2 => mp.srv.close(r2)); throw e; }

  const base2 = base;
  const login2 = async (query, user) => (await login(query, user)).r;
  try {
    // Læreren logger ind igen (samme UNI-ID = samme konto) og opretter en klasse
    let r = await login2('role=teacher', { uniid: 'L100', name: 'Mette Lærer', roller: ['Lærer'] });
    const ck = cookieOf(r, 'hm_session');
    const api = async (method, p, body) => (await fetch(base2 + p, { method, headers: { 'Content-Type': 'application/json', Cookie: ck }, body: body ? JSON.stringify(body) : undefined })).json();
    const cls = await api('POST', '/api/classes', { name: '2.g Dansk' });
    const enroll = async (body) => { const x = await fetch(base2 + '/api/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return Object.assign(await x.json(), { _status: x.status }); };

    // 4) Med UNI-Login slået til kan en elev ikke bare skrive et navn
    let e = await enroll({ code: cls.joinCode, name: 'Falsk Navn' });
    assert.strictEqual(e.needName, true);
    assert.strictEqual(e.uniLoginRequired, true);

    // 5) Elev-appen: åbner UNI-Login i browseren; resultatet sendes til appen på elevens EGEN computer (127.0.0.1)
    const app = crypto.randomBytes(32).toString('base64url');
    const page = await login2('role=student&app=' + app + '&port=49152', { uniid: 'E200', name: 'Anna Jensen', roller: ['Elev'] });
    assert.strictEqual(page.status, 302);
    const back = new URL(page.headers.get('location'));
    assert.strictEqual(back.host, '127.0.0.1:49152', 'resultatet går kun til den computer, der startede login');
    assert.strictEqual(back.searchParams.get('app'), app);
    const res1 = { ticket: back.searchParams.get('ticket') };
    // Der er ingen måde at hente resultatet fra serveren på (en klassekammerat kan ikke "fange" det)
    assert.notStrictEqual((await fetch(base2 + '/api/auth/unilogin/app-result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app }) })).status, 200);
    // Ugyldig port/engangs-id afvises
    assert.strictEqual((await fetch(base2 + '/api/auth/unilogin/start?role=student&app=' + app + '&port=80', { redirect: 'manual' })).status, 400);
    e = await enroll({ code: cls.joinCode, ticket: res1.ticket });
    assert.strictEqual(e._status, 200);
    assert.strictEqual(e.studentName, 'Anna Jensen', 'navnet kommer fra UNI-Login');
    assert.strictEqual((await enroll({ code: cls.joinCode, ticket: res1.ticket }))._status, 400, 'billetten er engangs');

    // 6) Ny computer: samme UNI-Login = samme elev (ingen dublet)
    const app2 = crypto.randomBytes(32).toString('base64url');
    const p2 = await login2('role=student&app=' + app2 + '&port=50000', { uniid: 'E200', name: 'Anna Jensen', roller: ['Elev'] });
    const t2 = { ticket: new URL(p2.headers.get('location')).searchParams.get('ticket') };
    const e2 = await enroll({ code: cls.joinCode, ticket: t2.ticket });
    assert.strictEqual(e2.studentId, e.studentId);
    const c = await api('GET', '/api/classes/' + cls.id);
    assert.strictEqual(c.students.length, 1);

    // 7) Elev-login på hjemmesiden: eleven ser sine klasser
    r = await login2('role=student', { uniid: 'E200', name: 'Anna Jensen', roller: ['Elev'] });
    assert.strictEqual(r.headers.get('location'), '/elev');
    const sck = cookieOf(r, 'hm_student');
    await api('POST', `/api/classes/${cls.id}/assignments`, { title: 'Novelleanalyse', due: Date.now() + 86400_000 });
    const sme = await (await fetch(base2 + '/api/student/me', { headers: { Cookie: sck } })).json();
    assert.strictEqual(sme.name, 'Anna Jensen');
    assert.strictEqual(sme.assignments.length, 1, 'eleven ser sine afleveringer på hjemmesiden');
    assert.strictEqual(sme.assignments[0].className, '2.g Dansk');
    assert.strictEqual(sme.assignments[0].submission, null);
    assert.deepStrictEqual(sme.classes.map(x => x.name), ['2.g Dansk']);
    // Elev-cookien giver ikke adgang til lærer-API'et
    assert.strictEqual((await fetch(base2 + '/api/classes', { headers: { Cookie: sck } })).status, 401);

    // 8) Skolens institutionsnummer: lærere fra institutionen kobles automatisk på skolen
    const AGY = [{ nr: '751002', name: 'Aarhus Gymnasium' }];
    r = await login2('role=teacher', { uniid: 'L100', name: 'Mette Lærer', roller: ['Lærer'], inst: AGY });
    const ck8 = cookieOf(r, 'hm_session');
    const api8 = async (method, p, body) => { const x = await fetch(base2 + p, { method, headers: { 'Content-Type': 'application/json', Cookie: ck8 }, body: body ? JSON.stringify(body) : undefined }); return Object.assign(await x.json(), { _status: x.status }); };
    assert.deepStrictEqual((await api8('GET', '/api/me')).uniInstitutions, [{ nr: '751002', name: 'Aarhus Gymnasium' }]);
    assert.strictEqual((await api8('POST', '/api/school/create', { name: 'Aarhus Gymnasium' }))._status, 200);
    assert.strictEqual((await api8('PATCH', '/api/school', { instNr: '999999' }))._status, 403, 'kun et nummer fra ens eget Unilogin');
    assert.strictEqual((await api8('PATCH', '/api/school', { instNr: '751002' }))._status, 200);
    assert.strictEqual((await api8('GET', '/api/school')).instNr, '751002');
    // En ny lærer fra samme institution kommer automatisk med – en fra en anden institution gør ikke
    r = await login2('role=teacher', { uniid: 'L300', name: 'Jonas Lærer', roller: ['Lærer'], inst: AGY });
    let me3 = await (await fetch(base2 + '/api/me', { headers: { Cookie: cookieOf(r, 'hm_session') } })).json();
    assert.strictEqual(me3.school.name, 'Aarhus Gymnasium');
    assert.strictEqual(me3.school.role, 'teacher');
    r = await login2('role=teacher', { uniid: 'L400', name: 'Sara Lærer', roller: ['Lærer'], inst: [{ nr: '280001', name: 'Odense Katedralskole' }] });
    me3 = await (await fetch(base2 + '/api/me', { headers: { Cookie: cookieOf(r, 'hm_session') } })).json();
    assert.strictEqual(me3.school, null);
  } finally {
    await srv.close();
    await new Promise(r => mp.srv.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
