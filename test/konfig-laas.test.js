'use strict';
// Låst konfiguration: fingeraftrykket af skolens ja (configlock.js), "ændret siden DPIA", blokering kun ved nye
// overvågningsfunktioner, "enkel -- bekraeft-ja" og elevernes accept, der skal gentages, når funktionerne ændres.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const WebSocket = require(require.resolve('ws', { paths: [path.join(__dirname, '..', 'server')] }));
const { createServer } = require('../server/src/index.js');
const CL = require('../server/src/configlock.js');

const APPROVAL = { controller: 'Testskolen', dpo: 'dpo@kommune.dk', dpiaDate: '2026-11-01', approvedDate: '2026-11-15' };
const ENV_APPROVAL = { DATAANSVARLIG: APPROVAL.controller, DPO_KONTAKT: APPROVAL.dpo, DPIA_DATO: APPROVAL.dpiaDate, LEDELSE_JA_DATO: APPROVAL.approvedDate };

function client(base) {
  let ck = '';
  return async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, ck ? { Cookie: ck } : {}), body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) ck = sc.split(';')[0];
    const text = await r.text();
    try { return Object.assign(JSON.parse(text), { _status: r.status }); } catch (e) { return { _status: r.status, _text: text }; }
  };
}
async function start(dir, extra) {
  const srv = createServer(Object.assign({ port: 0, host: '127.0.0.1', dataDir: dir, quiet: true, requireGuard: false, simple: true, schoolApproval: APPROVAL, dbaDate: '2026-11-20', betaFeatures: '' }, extra));
  const base = 'http://127.0.0.1:' + await srv.listen();
  return { srv, base };
}
async function agent(base, token) {
  const w = new WebSocket(base.replace('http', 'ws') + '/ws/agent');
  w.msgs = [];
  w.on('message', (d, bin) => { if (!bin) w.msgs.push(JSON.parse(d.toString())); });
  w.wait = async (f) => { for (let i = 0; i < 200; i++) { const m = w.msgs.find(f); if (m) { w.msgs.splice(w.msgs.indexOf(m), 1); return m; } await new Promise(r => setTimeout(r, 20)); } throw new Error('ingen besked'); };
  await new Promise(r => w.on('open', r));
  w.send(JSON.stringify({ type: 'hello', tokens: [token], device: { os: 'Linux', host: 'PC', version: '1.3.0' } }));
  return w;
}

test('configlock: fingeraftryk uden hemmeligheder; ændringer og blokering kun ved nye overvågningsfunktioner', () => {
  const f = { liveScreen: false, screenshot: false, autoEvidence: false, similar: false, hand: true, writeLesson: true, word: false };
  const R = { draftDays: 60, logDays: 30 };
  const a = CL.snapshot({ features: f, retention: R, requireGuard: false, keyId: 'abcd' });
  assert.deepStrictEqual(Object.keys(a), ['features', 'retention', 'requireGuard', 'keyId']);
  const stored = { config: a };
  assert.deepStrictEqual(CL.changes(stored, a), []);
  const b = CL.snapshot({ features: Object.assign({}, f, { word: true, hand: false }), retention: Object.assign({}, R, { logDays: 14 }), requireGuard: true, keyId: 'ef01' });
  assert.deepStrictEqual(CL.changes(stored, b), ['hand', 'word', 'frister', 'vagt', 'nøgle']);
  assert.deepStrictEqual(CL.blocking(stored, b), ['word'], 'kun en overvågningsfunktion, der er slået til, blokerer');
  // At slå en overvågningsfunktion fra, eller ændre frister, blokerer aldrig
  const c = CL.snapshot({ features: f, retention: { draftDays: 10, logDays: 5 }, requireGuard: false, keyId: 'abcd' });
  assert.deepStrictEqual(CL.blocking({ config: b }, c), []);
  assert.notStrictEqual(CL.featuresHash(f), CL.featuresHash(b.features));
});

test('serveren: ændret siden DPIA i startlinjen, /healthz?deep=1, /api/info og beta-forsiden – og blokering, til bekraeft-ja er kørt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-konfig-'));
  let { srv, base } = await start(dir);
  try {
    // Første start med skolens ja: konfigurationen registreres (og står i revisionssporet)
    const stored = CL.read(srv.db);
    assert.ok(stored && stored.hash, 'fingeraftrykket er gemt');
    assert.deepStrictEqual(Object.keys(stored.config), ['features', 'retention', 'requireGuard', 'keyId']);
    assert.ok(!/BEGIN|PRIVATE|password|token/i.test(JSON.stringify(stored)), 'ingen hemmeligheder');
    assert.ok(srv.db.prepare("SELECT 1 FROM audit_log WHERE action = 'konfiguration registreret ved skolens ja'").get());
    let call = client(base);
    assert.deepStrictEqual((await call('GET', '/api/info')).configChanged, []);
    assert.doesNotMatch(srv.startupLine(), /ændret siden DPIA/);
    // En lærer og en elev, der accepterer vilkårene
    const setup = srv.setupCode();
    await call('POST', '/api/register', { email: 'mette', name: 'Mette', password: 'tavle-kridt-1234', acceptTerms: true, signupCode: setup });
    const cls = await call('POST', '/api/classes', { name: '2.g' });
    const en = await client(base)('POST', '/api/enroll', { code: cls.joinCode, name: 'Anna Jensen', pin: '4821', accept: true });
    assert.ok(en.token, JSON.stringify(en));
    let ag = await agent(base, en.token);
    assert.strictEqual((await ag.wait(m => m.type === 'welcome')).enrollments[0].termsChanged, false);
    ag.close();
    await srv.close();

    // Ændrede frister: vises, men blokerer ikke
    ({ srv, base } = await start(dir, { retentionDays: 14 }));
    call = client(base);
    assert.deepStrictEqual((await call('GET', '/api/info')).configChanged, ['frister']);
    assert.strictEqual((await call('GET', '/api/info')).lessonBlocked, false);
    await srv.close();

    // En ny overvågningsfunktion (live-skærm): nye lektioner blokeres
    ({ srv, base } = await start(dir, { betaFeatures: 'liveScreen' }));
    call = client(base);
    const info = await call('GET', '/api/info');
    assert.deepStrictEqual(info.configChanged, ['liveScreen']);
    assert.strictEqual(info.lessonBlockedReason, 'config');
    assert.match(srv.startupLine(), /ændret siden DPIA: liveScreen/);
    const hz = await fetch(base + '/healthz?deep=1');
    assert.strictEqual(hz.status, 503);
    assert.match(await hz.text(), /ændret siden DPIA: liveScreen/);
    assert.strictEqual((await fetch(base + '/healthz')).status, 200, 'uden deep: ikke en fejl');
    await call('POST', '/api/login', { email: 'mette', password: 'tavle-kridt-1234' });
    const r = await call('POST', `/api/classes/${cls.id}/lesson`, { action: 'start', minutes: 45 });
    assert.strictEqual(r._status, 409);
    assert.strictEqual(r.needs, 'config');
    assert.match(r.error, /liveScreen er slået til.*bekraeft-ja/);
    // Eleven har accepteret med andre funktioner: appen beder om en ny accept
    ag = await agent(base, en.token);
    assert.strictEqual((await ag.wait(m => m.type === 'welcome')).enrollments[0].termsChanged, true);
    ag.send(JSON.stringify({ type: 'accept-terms' }));
    assert.strictEqual((await ag.wait(m => m.type === 'terms-accepted')).ok, true);
    ag.close();
    ag = await agent(base, en.token);
    assert.strictEqual((await ag.wait(m => m.type === 'welcome')).enrollments[0].termsChanged, false, 'accepteret igen');
    ag.close();

    // Skolen siger ja til ændringen: bekraeft-ja (samme miljø som serveren). Blokeringen hæves uden genstart.
    const env = Object.assign({}, process.env, ENV_APPROVAL, { DATA_DIR: dir, BETA_FEATURES: 'liveScreen', REQUIRE_GUARD: '0' });
    for (const k of ['LOG_RETENTION_DAYS', 'DRAFT_DAYS', 'VERSIONS_DAYS', 'DOC_RETENTION_DAYS', 'CERT_YEARS', 'INACTIVE_STUDENT_DAYS', 'AUDIT_DAYS', 'BACKUP_DAYS']) delete env[k];
    const p = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'scripts', 'enkel.js'), 'bekraeft-ja'], { env, encoding: 'utf8' });
    assert.strictEqual(p.status, 0, p.stderr);
    assert.match(p.stdout, /Skolens ja gælder nu også: liveScreen/);
    assert.deepStrictEqual((await call('GET', '/api/info')).configChanged, []);
    assert.strictEqual((await call('POST', `/api/classes/${cls.id}/lesson`, { action: 'start', minutes: 45 })).lesson.live, true);
    assert.ok(srv.db.prepare("SELECT 1 FROM audit_log WHERE action = 'bekræftede konfigurationen ved skolens ja: liveScreen'").get(), 'revisionssporet');
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sider og app: beta-forsiden, /privatliv og /vilkaar-elev viser konfigurationen; elev-appen kan bekræfte vilkårene', () => {
  const pub = (f) => fs.readFileSync(path.join(__dirname, '..', 'server', 'public', f), 'utf8');
  assert.match(pub('forside-beta.html'), /<li data-key="KONFIG">/);
  const site = pub('site.js');
  assert.match(site, /'Ændret siden DPIA: '/);
  assert.match(site, /fillFeatures\(i\.features\)/);
  for (const f of ['privatliv.html', 'vilkaar-elev.html']) {
    assert.match(pub(f), /data-features hidden/, f);
    assert.match(pub(f), /data-feature="word"/, f);
  }
  const main = fs.readFileSync(path.join(__dirname, '..', 'agent', 'src', 'main.js'), 'utf8');
  assert.match(main, /state\.termsChanged = \(msg\.enrollments \|\| \[\]\)\.some\(en => en && en\.termsChanged === true\);/);
  assert.match(main, /\{ id: 'terms:accept', label: 'Jeg har læst dem' \}/);
  assert.match(main, /conn\.send\(\{ type: 'accept-terms' \}\)/);
});
