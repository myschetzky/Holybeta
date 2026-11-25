'use strict';
// Hjemme-privatliv håndhæves i serveren (hub.policyFor) og i elevens app (agent/src/homepolicy.js):
// det, læreren ikke må se, bliver ikke sendt og ikke gemt.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require(require.resolve('ws', { paths: [path.join(__dirname, '../server')] }));
const { createServer } = require('../server/src/index.js');
const G = require('../server/src/guardapi.js');
const R = require('../shared/rules.js');
const H = require('../agent/src/homepolicy.js');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
function frame(header, payload) {
  const h = Buffer.from(JSON.stringify(header));
  const b = Buffer.alloc(5 + h.length + payload.length);
  b[0] = 1; b.writeUInt32BE(h.length, 1); h.copy(b, 5); payload.copy(b, 5 + h.length);
  return b;
}
function ws(url, headers) {
  const w = new WebSocket(url, { headers });
  w.msgs = []; w.bins = [];
  w.on('message', (d, bin) => { if (bin) w.bins.push(d); else w.msgs.push(JSON.parse(d.toString())); });
  w.wait = async (f, ms = 3000) => {
    for (let t = 0; t < ms; t += 20) { const m = w.msgs.find(f); if (m) { w.msgs.splice(w.msgs.indexOf(m), 1); return m; } await sleep(20); }
    throw new Error('ingen besked – fik: ' + JSON.stringify(w.msgs.map(m => m.type)));
  };
  return new Promise((res, rej) => { w.on('open', () => res(w)); w.on('error', rej); });
}
const blocks = (text) => [{ t: 'h1', r: [{ x: 'Stil' }] }, { t: 'p', r: [{ x: text }] }];

test('hjemme: fast profil, ingen nav/app, kun værtsnavne, kun farve og kategori og ingen billeder', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-homepol-'));
  const srv = createServer({ port: 0, host: '127.0.0.1', dataDir: dir, signupCode: 'k', quiet: true, requireGuard: false });
  const port = await srv.listen();
  const base = 'http://127.0.0.1:' + port;
  let ck = '';
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, ck ? { Cookie: ck } : {}), body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) ck = sc.split(';')[0];
    return Object.assign(await r.json().catch(() => ({})), { _status: r.status });
  };
  try {
    await call('POST', '/api/register', { email: 'l@x.dk', name: 'Mette', password: 'tavle-kridt-1234', signupCode: 'k' });
    const cls = await call('POST', '/api/classes', { name: '2.g Dansk' });
    // Klassen har automatiske skærmbilleder, lukning af programmer og egne blokeringer slået til
    await call('PATCH', `/api/classes/${cls.id}`, { config: { autoEvidence: true, killApps: true, extraBlocked: ['minlaerer-blokerer.dk'] } });
    const asg = await call('POST', `/api/classes/${cls.id}/assignments`, { title: 'Stil hjemme', home: true, due: Date.now() + 86400_000 });
    const en = await (await fetch(base + '/api/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: cls.joinCode, name: 'Anna Jensen' }) })).json();
    const sid = en.studentId;

    const agent = await ws(base.replace('http', 'ws') + '/ws/agent');
    // En gammel app sender stadig computerens navn – det gemmes ikke
    agent.send(JSON.stringify({ type: 'hello', tokens: [en.token], device: { os: 'Windows 11', host: 'ANNA-JENSENS-PC', id: 'Ab3dEf6hIj9k', version: '1.3.0' } }));
    await agent.wait(m => m.type === 'welcome');
    const info = JSON.parse(srv.db.prepare('SELECT device_info FROM students WHERE id = ?').get(sid).device_info);
    assert.deepStrictEqual(info, { os: 'Windows 11', id: 'Ab3dEf6hIj9k', version: '1.3.0' });
    assert.doesNotMatch(JSON.stringify((await call('GET', `/api/classes/${cls.id}`)).students), /ANNA-JENSENS-PC/);

    const teacher = await ws(base.replace('http', 'ws') + '/ws/teacher?classId=' + cls.id, { Cookie: ck, Origin: base });
    await teacher.wait(m => m.type === 'snapshot');

    // Skriveøkt hjemme
    agent.send(JSON.stringify({ type: 'write-session', assignmentId: asg.id, on: true }));
    assert.strictEqual((await agent.wait(m => m.type === 'write-session-result')).ok, true);
    const lesson = await agent.wait(m => m.type === 'lesson' && m.live && m.solo);
    assert.strictEqual(lesson.config.autoEvidence, false);
    assert.strictEqual(lesson.config.killApps, false);
    assert.deepStrictEqual(lesson.config.categories, ['ai', 'remote', 'vm']);
    assert.deepStrictEqual(lesson.config.extraBlocked, [], 'lærerens egne blokeringer gælder ikke hjemme');
    const pol = srv.hub.policyFor(sid);
    assert.strictEqual(pol.kind, 'hjemme');
    assert.deepStrictEqual(pol.observed, ['skrivevindue']);
    // Profilen giver kun ai/remote/vm som blokeret
    const RC = R.compile(R.RULE_DATA, lesson.config);
    assert.ok(RC.classifyUrl('https://chatgpt.com/c/1').blocked);
    assert.ok(!(RC.classifyUrl('https://www.tiktok.com/') || {}).blocked, 'sociale medier blokeres ikke hjemme');
    assert.ok(!(RC.classifyUrl('https://minlaerer-blokerer.dk/') || {}).blocked);

    // Appen (en gammel eller ændret en) sender alt muligt – serveren gemmer kun det, der må gemmes
    agent.send(JSON.stringify({ type: 'status', activity: 'Chrome – Min dagbog – privat', url: 'https://privat.dk/dagbog/side?x=1', app: 'chrome',
      violations: [{ kind: 'site', text: 'AI / chatbots: chatgpt.com', category: 'ai' }, { kind: 'site', text: 'Sociale medier: tiktok.com', category: 'social' }],
      degraded: [], tabs: [{ url: 'https://privat.dk/x', title: 'Privat', active: true }], apps: [{ name: 'Spotify', category: '' }] }));
    const red = await teacher.wait(m => m.type === 'student' && m.student.studentId === sid && m.student.color === 'red');
    assert.strictEqual(red.student.url, '');
    assert.strictEqual(red.student.app, '');
    assert.strictEqual(red.student.activity, '', 'kun farve og kategori – ikke "Skriver hjemme"');
    assert.deepStrictEqual(red.student.violations.map(v => v.text), ['AI / chatbots'], 'kun kategorien – og kun ai/remote/vm');
    const v = srv.hub.studentView(sid);
    assert.strictEqual(v.url, '');
    assert.strictEqual(v.app, '');
    assert.strictEqual(v.activity, '');
    assert.strictEqual(srv.hub.detail.get(sid), undefined);

    agent.send(JSON.stringify({ type: 'events', seq: 1, items: [
      { kind: 'nav', url: 'https://privat.dk/dagbog/side', title: 'Min dagbog' },
      { kind: 'app', app: 'Spotify', title: 'Spotify – Min playliste' },
      { kind: 'violation', title: 'AI / chatbots: chatgpt.com', category: 'ai', url: 'https://chatgpt.com/c/hemmelig-samtale', app: 'chrome' },
      { kind: 'blocked', url: 'https://chatgpt.com/c/123?q=min+tekst', title: 'chatgpt.com (AI / chatbots)', category: 'ai', blocked: true, detail: { browser: 'chrome' } },
      { kind: 'info', title: 'HolyMoly forbundet (Windows 11)' },
    ] }));
    await agent.wait(m => m.type === 'ack');
    // Billeder smides væk – live og skærmbillede
    agent.send(frame({ kind: 'live', screen: 0, screens: 1 }, JPEG));
    agent.send(frame({ kind: 'evidence', reason: 'Overtrædelse' }, JPEG));
    await sleep(200);

    const events = srv.db.prepare("SELECT kind, url, title, app, detail FROM events WHERE student_id = ? AND kind NOT IN ('system', 'teacher')").all(sid);
    for (const e of events) {
      assert.ok(['info', 'blocked', 'violation'].includes(e.kind), 'kind ' + e.kind);
      if (e.url) assert.doesNotMatch(e.url, /[/?]/, 'kun værtsnavn: ' + e.url);
      assert.strictEqual(e.app, null);
      assert.strictEqual(e.detail, null);
    }
    assert.ok(!events.some(e => e.kind === 'nav' || e.kind === 'app'));
    assert.doesNotMatch(JSON.stringify(events), /dagbog|Spotify|hemmelig|min\+tekst|playliste/);
    const vio = events.find(e => e.kind === 'violation');
    assert.deepStrictEqual([vio.url, vio.title], ['chatgpt.com', 'AI / chatbots']);
    assert.strictEqual(teacher.bins.length, 0, 'ingen billeder til læreren');
    assert.strictEqual(srv.db.prepare('SELECT COUNT(*) AS n FROM evidence').get().n, 0);
    assert.ok(!agent.msgs.some(m => m.type === 'stream' && m.mode !== 'off'));

    // Vagten følger samme profil: lukker intet og blokerer kun ai/remote/vm
    const rep = G.parseLines(['proc=777\tRobloxPlayerBeta\tRobloxPlayerBeta', 'proc=42\tpython\tpython', 'conn=42\t104.18.1.1\t443', 'dns=api.openai.com\t104.18.1.1'].join('\n'));
    const gr = srv.hub.guardBeat([{ id: sid, class_id: cls.id }], rep);
    assert.deepStrictEqual(gr.kill, [], 'hjemme lukkes ingen programmer');
    assert.ok(gr.blocked.includes('chatgpt.com'));
    assert.ok(!gr.blocked.includes('tiktok.com'));
    assert.ok(!gr.blocked.includes('minlaerer-blokerer.dk'));
    assert.deepStrictEqual(srv.hub.studentView(sid).violations.map(x => x.text), ['AI / chatbots'], 'vagtens fund også kun som kategori');

    // Fokus-noten droppes hjemme: tid uden for skrivevinduet er elevens egen sag
    const docId = crypto.randomUUID();
    agent.send(JSON.stringify({ type: 'status', activity: 'x', violations: [], degraded: [] }));
    await sleep(50);
    agent.send(JSON.stringify({ type: 'doc', id: docId, title: 'Stil', blocks: blocks('Hjemme skriver jeg om romantikken og naturen.'), stats: { typed: 80, keystrokes: 70, maxCps: 5, regularity: 0.6, focusLostMs: 10 * 60_000 } }));
    assert.strictEqual((await agent.wait(m => m.type === 'doc-saved')).ok, true);
    const homeNotes = srv.docs.evaluate(srv.docs.q.get.get(docId)).notes.join(' ');
    assert.doesNotMatch(homeNotes, /ikke i fokus/);

    // Skriveøkten slutter, en lektion starter: så gælder klassens profil igen, og fokus-noten er der
    agent.send(JSON.stringify({ type: 'write-session', assignmentId: asg.id, on: false }));
    await agent.wait(m => m.type === 'lesson' && !m.live);
    await call('POST', `/api/classes/${cls.id}/lesson`, { action: 'start', minutes: 45 });
    const cl = await agent.wait(m => m.type === 'lesson' && m.live && !m.solo);
    assert.strictEqual(cl.config.autoEvidence, true);
    assert.strictEqual(srv.hub.policyFor(sid).kind, 'klasse');
    const docId2 = crypto.randomUUID();
    agent.send(JSON.stringify({ type: 'status', activity: 'x', violations: [], degraded: [] }));
    await sleep(1600);
    agent.send(JSON.stringify({ type: 'doc', id: docId2, title: 'Stil', blocks: blocks('I timen skriver jeg om romantikken og naturen.'), stats: { typed: 80, keystrokes: 70, maxCps: 5, regularity: 0.6, focusLostMs: 10 * 60_000 } }));
    assert.strictEqual((await agent.wait(m => m.type === 'doc-saved')).ok, true);
    assert.match(srv.docs.evaluate(srv.docs.q.get.get(docId2)).notes.join(' '), /ikke i fokus/);
    agent.close(); teacher.close();
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hjemme i elevens app: hændelser og status uden adresser, programmer og faner', () => {
  assert.strictEqual(H.homeEvent({ kind: 'nav', url: 'https://privat.dk/side', title: 'Privat' }), null);
  assert.strictEqual(H.homeEvent({ kind: 'app', app: 'Spotify', title: 'Spotify' }), null);
  assert.deepStrictEqual(H.homeEvent({ kind: 'blocked', url: 'https://chatgpt.com/c/1?q=x', title: 'chatgpt.com (AI / chatbots)', category: 'ai', blocked: true, detail: { browser: 'chrome' } }),
    { kind: 'blocked', url: 'chatgpt.com', title: 'AI / chatbots', category: 'ai', blocked: true });
  assert.deepStrictEqual(H.homeEvent({ kind: 'violation', title: 'Spil: Steam', category: 'games', url: 'https://x.dk/a', app: 'steam' }),
    { kind: 'violation', url: 'x.dk', title: 'Blokeret', category: 'games', blocked: false });
  assert.strictEqual(H.homeEvent({ kind: 'info', title: 'HolyMoly forbundet (Windows 11)' }).title, 'HolyMoly forbundet (Windows 11)');

  const st = H.homeStatus({ activity: 'Chrome – Min dagbog', url: 'https://privat.dk/x', app: 'chrome', frozen: false, attempt: { text: 'chatgpt.com (AI)' },
    violations: [{ kind: 'site', text: 'AI / chatbots: chatgpt.com', category: 'ai' }, { kind: 'app', text: 'Spil: Steam', category: 'games' }, { kind: 'bridge_tamper', text: 'Et andet program …', category: '' }],
    degraded: [{ kind: 'monitor', text: 'HolyMoly kan ikke se det aktive vindue' }], ext: { connected: false, browsers: [] }, screens: 2 });
  assert.deepStrictEqual(st, {
    activity: 'Skriver hjemme', url: '', app: '', violations: [{ kind: 'site', text: 'AI / chatbots', category: 'ai' }],
    degraded: [{ kind: 'monitor', text: 'HolyMoly kan ikke se det aktive vindue' }], ext: { connected: false, browsers: [] }, screens: 2,
  });
  assert.ok(!('tabs' in st) && !('apps' in st) && !('attempt' in st));
});

test('hjemme i elevens app: main.js bruger hjemme-profilen og sender ikke computerens navn', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'agent', 'src', 'main.js'), 'utf8');
  assert.match(src, /state\.home = !!\(state\.lesson && state\.lesson\.solo\)/);
  assert.match(src, /solo: msg\.solo \|\| null/);
  assert.match(src, /bridge\.on\('nav', \(n\) => \{\n\s*if \(!lessonActive\(\) \|\| state\.home\) return;/);
  assert.match(src, /const autoEvidence = !state\.home &&/);
  assert.match(src, /state\.home \? homeStatus\(status\) : status/);
  assert.match(src, /if \(!state\.home && \(detailKey/);
  assert.doesNotMatch(src, /hostname\(\)/, 'computerens navn sendes ikke');
  assert.match(src, /id: state\.data\.deviceId/);
  for (const f of ['agent/guard/mac/guard.sh', 'agent/guard/windows/guard.ps1']) {
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), /\\nhost=|`nhost=/, f);
  }
});

test('regler: categories som liste blokerer præcis de kategorier', () => {
  const C = R.compile(R.RULE_DATA, { categories: ['ai', 'remote', 'vm'] });
  assert.ok(C.classifyUrl('https://claude.ai/').blocked);
  assert.ok(!(C.classifyUrl('https://www.youtube.com/') || {}).blocked);
  // Objekt-formen virker som før
  const O = R.compile(R.RULE_DATA, { categories: { video: false } });
  assert.ok(!(O.classifyUrl('https://www.youtube.com/') || {}).blocked);
  assert.ok(O.classifyUrl('https://claude.ai/').blocked);
});
