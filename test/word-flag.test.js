'use strict';
// "Skriv i Word" bag serverflaget (BETA_FEATURES=word) og et Word-mærke, der ikke lover mere end der er målt.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const WebSocket = require(require.resolve('ws', { paths: [path.join(__dirname, '..', 'server')] }));
const { createServer } = require('../server/src/index.js');
const { WordManager } = require('../agent/src/word/manager.js');
const { FakeWordBridge } = require('../agent/src/word/bridge-fake.js');
const D = require('../shared/doc.js');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const APPROVAL = { controller: 'Testskolen', dpo: 'dpo@kommune.dk', dpiaDate: '2026-11-01', approvedDate: '2026-11-15' };

async function features(opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-wordflag-'));
  const srv = createServer(Object.assign({ port: 0, host: '127.0.0.1', dataDir: dir, quiet: true, requireGuard: false, schoolApproval: APPROVAL, dbaDate: '2026-11-20' }, opts));
  const port = await srv.listen();
  try { return (await (await fetch(`http://127.0.0.1:${port}/api/info`)).json()).features; } finally { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

test('flaget: Word er slået fra i enkel tilstand, til med BETA_FEATURES=word, og til i den fulde udgave', async () => {
  assert.strictEqual((await features({ simple: true })).word, false, 'beta: fra som standard');
  assert.strictEqual((await features({ simple: true, betaFeatures: 'word' })).word, true, 'BETA_FEATURES=word');
  assert.strictEqual((await features({ simple: true, betaFeatures: 'liveScreen, word' })).word, true);
  assert.strictEqual((await features({ simple: false })).word, true, 'koncept/fuld udgave');
});

test('serveren: Word-gemninger og Word-afleveringer afvises, når flaget er fra; welcome fortæller appen det', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-wordflag-srv-'));
  const srv = createServer({ port: 0, host: '127.0.0.1', dataDir: dir, signupCode: 'k', quiet: true, requireGuard: false, publicUrl: 'https://holymoly.test', minProofWords: 5 });
  const base = 'http://127.0.0.1:' + await srv.listen();
  let ck = '';
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, ck ? { Cookie: ck } : {}), body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) ck = sc.split(';')[0];
    return Object.assign(await r.json().catch(() => ({})), { _status: r.status });
  };
  const connect = async (token) => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws/agent');
    ws.msgs = [];
    ws.on('message', (d, bin) => { if (!bin) ws.msgs.push(JSON.parse(d.toString())); });
    ws.wait = async (f) => { for (let i = 0; i < 200; i++) { const m = ws.msgs.find(f); if (m) { ws.msgs.splice(ws.msgs.indexOf(m), 1); return m; } await sleep(20); } throw new Error('ingen besked'); };
    await new Promise(r => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'hello', tokens: [token], device: { os: 'Windows', host: 'PC', version: '1.3.0' } }));
    return ws;
  };
  try {
    await call('POST', '/api/register', { email: 'l@x.dk', name: 'Mette', password: 'tavle-kridt-1234', signupCode: 'k' });
    const cls = await call('POST', '/api/classes', { name: '2.g Dansk' });
    const en = await (await fetch(base + '/api/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: cls.joinCode, name: 'Anna Jensen' }) })).json();
    let ag = await connect(en.token);
    assert.deepStrictEqual((await ag.wait(m => m.type === 'welcome')).features, { word: true }, 'den fulde udgave: Word er tilladt');
    ag.close();
    // Flaget slås fra (som i beta uden BETA_FEATURES=word)
    srv.hub.features.word = false;
    ag = await connect(en.token);
    assert.deepStrictEqual((await ag.wait(m => m.type === 'welcome')).features, { word: false });
    await call('POST', `/api/classes/${cls.id}/lesson`, { action: 'start', minutes: 45 });
    await ag.wait(m => m.type === 'lesson' && m.live);
    const id = crypto.randomUUID();
    ag.send(JSON.stringify({ type: 'doc', id, title: 'Romantikken', blocks: [], stats: {}, source: 'word' }));
    const saved = await ag.wait(m => m.type === 'doc-saved');
    assert.strictEqual(saved.ok, false);
    assert.match(saved.error, /Skriv i Word er slået fra på skolens server/);
    assert.strictEqual(srv.db.prepare('SELECT COUNT(*) AS n FROM documents').get().n, 0, 'intet gemt');
    ag.send(JSON.stringify({ type: 'doc-submit', id, title: 'Romantikken', blocks: [{ t: 'p', r: [{ x: 'Ja nej' }] }], stats: {}, source: 'word' }));
    const res = await ag.wait(m => m.type === 'doc-result');
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /slået fra/);
    // Skrivevinduet virker som før
    ag.send(JSON.stringify({ type: 'doc', id: crypto.randomUUID(), title: 'Romantikken', blocks: [], stats: {} }));
    assert.strictEqual((await ag.wait(m => m.type === 'doc-saved')).ok, true);
    ag.close();
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('elev-appen: uden serverens ja er Word ikke tilgængeligt, og "Skriv verificeret aflevering" bruger skrivevinduet', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-wordflag-app-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let allowed = false;
  const mgr = new WordManager({ bridge: new FakeWordBridge(), autoTick: false, send: () => true, lessonActive: () => true, online: () => true, serverUrl: 'https://holymoly.test', dir: path.join(dir, 'docs'), dataDir: path.join(dir, 'data'), allowed: () => allowed });
  assert.deepStrictEqual(await mgr.info(), { supported: true, word: true, allowed: false, available: false });
  assert.match((await mgr.start({})).error, /slået fra på skolens server/);
  assert.strictEqual(mgr.s, null, 'intet Word åbnet');
  allowed = true;
  assert.strictEqual((await mgr.info()).available, true);
  // main.js: skjult indtil welcome.features.word, og startVerifiedWriting spørger info().available (falder tilbage til skrivevinduet)
  const main = fs.readFileSync(path.join(__dirname, '..', 'agent', 'src', 'main.js'), 'utf8');
  assert.match(main, /wordAllowed: false,/);
  assert.match(main, /state\.wordAllowed = !msg\.features \|\| msg\.features\.word !== false;/);
  assert.match(main, /allowed: \(\) => !!state\.wordAllowed/);
  assert.match(main, /if \(inf\.available\) return \(await word\.manager\.start\(\{ assignmentId: aid \}\)\)/);
});

test('Word-mærket: "Tastet … intet indsat" kun med talte tastetryk – ellers "tekstvækst målt"', () => {
  assert.strictEqual(D.label('lektion', { observed: ['word', 'taster', 'vagt'] }), '✓ Tastet i Word via HolyMoly – intet indsat · i timen');
  assert.strictEqual(D.label('lektion', { observed: ['word', 'vagt'] }), '✓ Skrevet i Word via HolyMoly – tekstvækst målt · i timen');
  assert.strictEqual(D.label('hjemme', { observed: ['word'] }), '✓ Skrevet i Word via HolyMoly – tekstvækst målt · hjemme, uden opsyn · kun Word');
  assert.strictEqual(D.WORD_MARK_GROWTH, '✓ Skrevet i Word via HolyMoly – tekstvækst målt');
  assert.ok(!/intet indsat|Tastet/.test(D.WORD_MARK_GROWTH), 'lover ikke mere, end der er målt');
  // Elev-appens kopi af shared/doc.js er den samme
  assert.strictEqual(require('../agent/src/doc.js').WORD_MARK_GROWTH, D.WORD_MARK_GROWTH);
  // Tjek-siden: Word er et lavere niveau end skrivevinduet
  const bevis = fs.readFileSync(path.join(__dirname, '..', 'server', 'public', 'bevis.js'), 'utf8');
  assert.match(bevis, /lavere niveau end skrivevinduet/);
});
