'use strict';
// Tjek-siden: upload først, mange filer (og Lectios zip) og opslag på egen server ud fra tekstens sha256.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const WebSocket = require(require.resolve('ws', { paths: [path.join(__dirname, '..', 'server')] }));
const { createServer } = require('../server/src/index.js');
const D = require('../shared/doc.js');

const blocksOf = (text) => [{ t: 'p', r: [{ x: text }] }];
const inflateRaw = async (b) => new Uint8Array(zlib.inflateRawSync(b));

test('zipNames og docxFooter: filerne i en zip og mærket i sidefoden', async () => {
  const docx = D.toDocx(blocksOf('Fem ord står i teksten.'), { title: 'X', mark: { code: 'HM-ABCD1234', url: 'https://holymoly.test/bevis/abcd1234abcd1234', place: 'klasse', observed: ['skrivevindue'] } });
  const names = D.zipNames(docx);
  assert.ok(names.includes('word/document.xml') && names.includes('word/footer1.xml'), names.join());
  const foot = D.docxFooter(new TextDecoder().decode(await D.readZipEntry(docx, 'word/footer1.xml', inflateRaw)));
  assert.deepStrictEqual(foot, { mark: '✓ Tastet i HolyMoly – intet indsat · i timen · kun skrivevinduet', code: 'HM-ABCD1234', url: 'https://holymoly.test/bevis/abcd1234abcd1234' });
  assert.deepStrictEqual(D.docxFooter('<w:p><w:r><w:t>Ingenting</w:t></w:r></w:p>'), { mark: '', code: '', url: '' });
  assert.throws(() => D.zipNames(new Uint8Array(40)), /ikke en zip/);
  // "Tjek altid teksten på linket" står på alle mærker – ikke kun fra en testserver
  assert.match(D.LIMIT_TEXT, /Tjek altid teksten på linket\.$/);
  assert.ok(!/Tjek altid/.test(D.TEST_TEXT));
  assert.match(D.footerLines({ code: 'HM-X', url: 'u', place: 'klasse', observed: ['skrivevindue'] }, 3)[2], /Tjek altid teksten på linket\. 3 ord\./);
});

test('tjek-siden: input multiple, zip og opslag via /api/bevis/find', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'server/public/bevis.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'server/public/bevis.js'), 'utf8');
  assert.match(html, /<input type="file" id="file" multiple accept="[^"]*\.zip/);
  assert.match(html, /<input type="file" id="many" multiple accept="[^"]*\.zip/);
  assert.match(html, /<th scope="col">Teksten passer<\/th><th scope="col">Udstedt af denne server<\/th>/);
  assert.match(js, /fetch\('\/api\/bevis\/find', \{ method: 'POST'/);
  assert.match(js, /HMDoc\.zipNames/);
  assert.match(js, /Sidefoden peger på en anden server/);
  // Uden id: upload først (ikke "aldrig udstedt her")
  assert.match(js, /if \(!id\) \{ \$\('loading'\)\.hidden = true; \$\('find'\)\.hidden = false; return; \}/);
});

test('POST /api/bevis/find: kun kode, dato og mærke offentligt – navn kun til elevens egen lærer, og opslag er begrænset', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-find-'));
  const srv = createServer({ port: 0, host: '127.0.0.1', dataDir: dir, signupCode: 'k', quiet: true, requireGuard: false, minProofWords: 10, publicUrl: 'https://holymoly.test' });
  const base = 'http://127.0.0.1:' + await srv.listen();
  let ck = '';
  const call = async (method, p, body, cookie = ck) => {
    const r = await fetch(base + p, { method, headers: Object.assign({ 'Content-Type': 'application/json', Origin: base }, cookie ? { Cookie: cookie } : {}), body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc && cookie === ck) ck = sc.split(';')[0];
    return Object.assign(await r.json().catch(() => ({})), { _status: r.status });
  };
  let ws;
  try {
    await call('POST', '/api/register', { email: 'l@x.dk', name: 'Mette', password: 'tavle-kridt-1234', signupCode: 'k' });
    const mette = ck;
    const cls = await call('POST', '/api/classes', { name: '2.g' });
    const en = await (await fetch(base + '/api/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: cls.joinCode, name: 'Anna Jensen' }) })).json();
    ws = new WebSocket(base.replace('http', 'ws') + '/ws/agent');
    const msgs = [];
    ws.on('message', (d, bin) => { if (!bin) msgs.push(JSON.parse(d.toString())); });
    await new Promise(r => ws.on('open', r));
    const wait = async (f) => { for (let i = 0; i < 200; i++) { const m = msgs.find(f); if (m) { msgs.splice(msgs.indexOf(m), 1); return m; } await new Promise(r => setTimeout(r, 20)); } throw new Error('ingen besked'); };
    ws.send(JSON.stringify({ type: 'hello', tokens: [en.token], device: { os: 'Linux', host: 'PC', version: '1.3.0' } }));
    await wait(m => m.type === 'welcome');
    await call('POST', `/api/classes/${cls.id}/lesson`, { action: 'start', minutes: 45 });
    await wait(m => m.type === 'lesson' && m.live);
    ws.send(JSON.stringify({ type: 'status', activity: 'HolyMoly – Skriv', violations: [], degraded: [] }));
    await new Promise(r => setTimeout(r, 100));
    const id = crypto.randomUUID();
    const stats = { typed: 200, keystrokes: 180, maxCps: 5, regularity: 0.6 };
    const t = 'Romantikken var en periode i kunsten, hvor følelser og natur fik plads.';
    ws.send(JSON.stringify({ type: 'doc', id, title: 'Stil', blocks: blocksOf(t), stats }));
    assert.strictEqual((await wait(m => m.type === 'doc-saved')).ok, true);
    await new Promise(r => setTimeout(r, 1100));
    ws.send(JSON.stringify({ type: 'doc-submit', id, title: 'Stil', blocks: blocksOf(t), stats }));
    const res = await wait(m => m.type === 'doc-result');
    assert.ok(res.certId, JSON.stringify(res));
    const sha = (await call('GET', '/api/bevis/' + res.certId, null, '')).payload.sha256;
    // Samme tekst i en .docx (læst som i browseren) giver samme sha256
    const docx = D.toDocx(blocksOf(t), { title: 'Stil' });
    const variants = D.docxText(new TextDecoder().decode(await D.readZipEntry(docx, 'word/document.xml', inflateRaw))).variants;
    assert.ok(variants.map(v => crypto.createHash('sha256').update(v, 'utf8').digest('hex')).includes(sha));

    // Offentligt (ikke logget ind): kun kode, dato og mærke
    const other = crypto.createHash('sha256').update('noget andet').digest('hex');
    const pub = await call('POST', '/api/bevis/find', { sha256: [other, sha] }, '');
    assert.strictEqual(pub._status, 200);
    assert.strictEqual(pub.found.length, 1);
    const hit = pub.found[0];
    assert.deepStrictEqual(Object.keys(hit).sort(), ['code', 'date', 'green', 'mark', 'sha256']);
    assert.strictEqual(hit.code, 'HM-' + res.certId.slice(0, 8).toUpperCase());
    assert.match(hit.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(hit.mark, /^✓ Tastet i HolyMoly – intet indsat · i timen/);
    assert.ok(!JSON.stringify(pub).includes('Anna'));
    assert.ok(!JSON.stringify(pub).includes(res.certId), 'det fulde id (linket) gives ikke offentligt');
    // Elevens egen lærer får navn og link
    const own = await call('POST', '/api/bevis/find', { sha256: [sha] }, mette);
    assert.strictEqual(own.found[0].student, 'Anna Jensen');
    assert.strictEqual(own.found[0].id, res.certId);
    // En anden lærer får intet navn
    ck = '';
    await call('POST', '/api/register', { email: 'b@x.dk', name: 'B', password: 'tavle-kridt-1234', signupCode: 'k' });
    const notMine = await call('POST', '/api/bevis/find', { sha256: [sha] });
    assert.strictEqual(notMine.found.length, 1);
    assert.strictEqual(notMine.found[0].student, undefined);
    // Ugyldige forespørgsler
    assert.strictEqual((await call('POST', '/api/bevis/find', { sha256: 'x' }, ''))._status, 400);
    assert.deepStrictEqual((await call('POST', '/api/bevis/find', { sha256: ['ikke-hex'] }, '')).found, []);
    // Rate limit pr. IP: en hel klasses filer går igennem, men ikke tusindvis af gæt
    let limited = false;
    for (let i = 0; i < 130 && !limited; i++) limited = (await call('POST', '/api/bevis/find', { sha256: [other] }, ''))._status === 429;
    assert.ok(limited, 'opslaget er rate-limitet');
  } finally {
    if (ws) ws.close();
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
