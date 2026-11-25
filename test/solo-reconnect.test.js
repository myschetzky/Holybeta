'use strict';
// Skriveøkt hjemme, der afbrydes: økten venter på eleven (samme lessons.id), kan fortsættes kort efter fra samme computer,
// og aldrig fra en anden. Fristen er skaleret ned (soloGraceMs) – 1 sek. afbrydelse af 2 svarer til 60 af 120 sek.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require(require.resolve('ws', { paths: [path.join(__dirname, '../server')] }));
const { createServer } = require('../server/src/index.js');
const { sha256 } = require('../server/src/util.js');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const blocksOf = (text) => [{ t: 'h1', r: [{ x: 'Stil' }] }, { t: 'p', r: [{ x: text }] }];
const STATS = { typed: 400, keystrokes: 380, maxCps: 5, regularity: 0.6 };
const TEXT = 'Jeg skriver hjemme om romantikken og digterne i Danmark omkring år 1800 og deres syn på naturen.';

function client(base) {
  let ck = '';
  return async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, ck ? { Cookie: ck } : {}), body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) ck = sc.split(';')[0];
    return Object.assign(await r.json().catch(() => ({})), { _status: r.status });
  };
}
async function agent(base, token) {
  const w = new WebSocket(base.replace('http', 'ws') + '/ws/agent');
  w.msgs = [];
  w.on('message', (d, bin) => { if (!bin) w.msgs.push(JSON.parse(d.toString())); });
  w.wait = async (f, ms = 3000) => {
    for (let t = 0; t < ms; t += 20) { const m = w.msgs.find(f); if (m) { w.msgs.splice(w.msgs.indexOf(m), 1); return m; } await sleep(20); }
    throw new Error('ingen besked – fik: ' + JSON.stringify(w.msgs.map(m => m.type)));
  };
  await new Promise((res, rej) => { w.on('open', res); w.on('error', rej); });
  w.send(JSON.stringify({ type: 'hello', tokens: [token], device: { os: 'Linux', version: '1.3.0' } }));
  await w.wait(m => m.type === 'welcome');
  return w;
}
const gone = (w) => new Promise(r => { w.once('close', r); w.terminate(); }); // forbindelsen forsvinder (intet 'bye')
// Lad som om eleven har skrevet i 20 min. (så et par sekunders grå tid ikke fylder i en kort test)
const longWriting = (srv, id) => srv.db.prepare("UPDATE documents SET monitor = json_set(monitor, '$.greenMs', 1200000) WHERE id = ?").run(id);

test('skriveøkt: afbrydelse og genforbindelse giver samme lessons.id og et bevis – resume kun fra samme computer', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-solo-reconnect-'));
  const GRACE = 2000;
  const srv = createServer({ port: 0, host: '127.0.0.1', dataDir: dir, signupCode: 'k', quiet: true, requireGuard: false, publicUrl: 'https://holymoly.test', minProofWords: 10, soloGraceMs: GRACE, staleMs: 2000 });
  const base = 'http://127.0.0.1:' + await srv.listen();
  try {
    const A = client(base);
    await A('POST', '/api/register', { email: 'l@x.dk', name: 'Mette', password: 'tavle-kridt-1234', signupCode: 'k' });
    const cls = await A('POST', '/api/classes', { name: '2.g Dansk' });
    const home = await A('POST', `/api/classes/${cls.id}/assignments`, { title: 'Stil hjemme', home: true, due: Date.now() + 86400_000 });
    const en = await (await fetch(base + '/api/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: cls.joinCode, name: 'Anna Jensen' }) })).json();
    const sid = en.studentId;

    // Skriveøkten starter og gemmer computeren (sha256 af tokenet, 16 tegn)
    let ag = await agent(base, en.token);
    ag.send(JSON.stringify({ type: 'write-session', assignmentId: home.id, on: true }));
    assert.strictEqual((await ag.wait(m => m.type === 'write-session-result')).ok, true);
    await ag.wait(m => m.type === 'lesson' && m.live && m.solo);
    const lessonId = srv.hub.solo.get(sid).id;
    const row = srv.db.prepare('SELECT * FROM lessons WHERE id = ?').get(lessonId);
    assert.strictEqual(row.kind, 'hjemme');
    assert.strictEqual(row.assignment_id, home.id);
    assert.strictEqual(row.device_hash, sha256(en.token).slice(0, 16));
    ag.send(JSON.stringify({ type: 'status', activity: 'HolyMoly – Skriv', violations: [], degraded: [] }));
    await sleep(100);
    const id = crypto.randomUUID();
    ag.send(JSON.stringify({ type: 'doc', id, title: 'Stil', blocks: blocksOf(TEXT), stats: STATS }));
    assert.strictEqual((await ag.wait(m => m.type === 'doc-saved')).ok, true);
    longWriting(srv, id);

    // 1. Forbindelsen forsvinder midt i økten: økten venter (ikke afsluttet), og eleven er stadig "hjemme"
    await gone(ag);
    await sleep(100);
    assert.ok(srv.hub.solo.get(sid).pausedAt > 0, 'økten venter på eleven');
    assert.strictEqual(srv.db.prepare('SELECT ended FROM lessons WHERE id = ?').get(lessonId).ended, null);
    assert.strictEqual(srv.hub.isHome(sid), true, 'hjemme-privatlivet gælder stadig');
    await sleep(GRACE / 2);

    // Eleven forbinder igen inden fristen med samme token: samme lessons.id, og aflevering giver et bevis
    ag = await agent(base, en.token);
    const l = await ag.wait(m => m.type === 'lesson' && m.live);
    assert.deepStrictEqual(l.solo, { assignmentId: home.id, title: 'Stil hjemme' });
    assert.strictEqual(srv.hub.solo.get(sid).id, lessonId, 'samme lessons.id');
    assert.strictEqual(srv.hub.solo.get(sid).pausedAt, 0);
    // Appen sender resume af sig selv ved 'welcome': økten kører allerede
    ag.send(JSON.stringify({ type: 'write-session', assignmentId: home.id, on: true, resume: true }));
    const again = await ag.wait(m => m.type === 'write-session-result');
    assert.strictEqual(again.ok, true);
    assert.strictEqual(again.resume, true);
    ag.send(JSON.stringify({ type: 'status', activity: 'HolyMoly – Skriv', violations: [], degraded: [] }));
    await sleep(100);
    ag.send(JSON.stringify({ type: 'doc-submit', id, title: 'Stil', blocks: blocksOf(TEXT + ' Slut.'), stats: STATS }));
    const res = await ag.wait(m => m.type === 'doc-result');
    assert.ok(res.ok && res.certId, JSON.stringify(res));
    assert.strictEqual(res.kind, 'hjemme');
    assert.deepStrictEqual(JSON.parse(srv.db.prepare('SELECT monitor FROM documents WHERE id = ?').get(id).monitor).lessons, [lessonId], 'kun én lektion i beviset');

    // 2. Eleven kommer først igen efter fristen: økten er sluttet med end_reason 'drop' – og kan fortsættes kort efter
    await gone(ag);
    await sleep(GRACE + 700);
    assert.ok(!srv.hub.solo.has(sid));
    let ended = srv.db.prepare('SELECT ended, end_reason FROM lessons WHERE id = ?').get(lessonId);
    assert.strictEqual(ended.end_reason, 'drop');
    assert.ok(ended.ended > 0);
    ag = await agent(base, en.token);
    await ag.wait(m => m.type === 'lesson' && !m.live);
    const quota = JSON.stringify(srv.hub.soloQuota.get(sid));
    ag.send(JSON.stringify({ type: 'write-session', assignmentId: home.id, on: true, resume: true }));
    const resumed = await ag.wait(m => m.type === 'write-session-result');
    assert.strictEqual(resumed.ok, true, JSON.stringify(resumed));
    await ag.wait(m => m.type === 'lesson' && m.live && m.solo);
    assert.strictEqual(srv.hub.solo.get(sid).id, lessonId, 'samme lessons.id efter resume');
    assert.deepStrictEqual({ ...srv.db.prepare('SELECT ended, end_reason FROM lessons WHERE id = ?').get(lessonId) }, { ended: null, end_reason: null });
    assert.strictEqual(JSON.stringify(srv.hub.soloQuota.get(sid)), quota, 'resume tæller ikke i kvoten');

    // 3. Samme med et andet token (eleven er logget ind på en anden computer): resume afvises
    await gone(ag);
    await sleep(GRACE + 700);
    assert.strictEqual(srv.db.prepare('SELECT end_reason FROM lessons WHERE id = ?').get(lessonId).end_reason, 'drop');
    const other = crypto.randomBytes(24).toString('base64url');
    srv.db.prepare('UPDATE students SET device_token_hash = ? WHERE id = ?').run(sha256(other), sid);
    ag = await agent(base, other);
    await ag.wait(m => m.type === 'lesson' && !m.live);
    ag.send(JSON.stringify({ type: 'write-session', assignmentId: home.id, on: true, resume: true }));
    const refused = await ag.wait(m => m.type === 'write-session-result');
    assert.strictEqual(refused.ok, false);
    assert.match(refused.error, /samme computer/);
    assert.ok(!srv.hub.solo.has(sid));

    // 4. En økt, der venter på eleven, slutter, hvis eleven forbinder fra en anden computer
    srv.hub.soloQuota.clear();
    ag.send(JSON.stringify({ type: 'write-session', assignmentId: home.id, on: true }));
    assert.strictEqual((await ag.wait(m => m.type === 'write-session-result')).ok, true);
    const second = srv.hub.solo.get(sid).id;
    assert.notStrictEqual(second, lessonId);
    await gone(ag);
    const third = crypto.randomBytes(24).toString('base64url');
    srv.db.prepare('UPDATE students SET device_token_hash = ? WHERE id = ?').run(sha256(third), sid);
    ag = await agent(base, third);
    await ag.wait(m => m.type === 'lesson' && !m.live);
    assert.ok(!srv.hub.solo.has(sid));
    assert.strictEqual(srv.db.prepare('SELECT end_reason FROM lessons WHERE id = ?').get(second).end_reason, 'computer');

    // 5. Lukker eleven appen (bye), slutter økten med det samme
    srv.hub.soloQuota.clear();
    ag.send(JSON.stringify({ type: 'write-session', assignmentId: home.id, on: true }));
    assert.strictEqual((await ag.wait(m => m.type === 'write-session-result')).ok, true);
    const fourth = srv.hub.solo.get(sid).id;
    ag.send(JSON.stringify({ type: 'bye', reason: 'quit' }));
    await sleep(50);
    await gone(ag);
    await sleep(100);
    assert.ok(!srv.hub.solo.has(sid));
    assert.strictEqual(srv.db.prepare('SELECT end_reason FROM lessons WHERE id = ?').get(fourth).end_reason, 'lukket');
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
