'use strict';
// /healthz: database, skriveprøve og signeringsnøgle; ?deep=1 også backup og fri disk
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../server/src/index.js');

async function get(b, p) {
  const r = await fetch(b + p);
  return { status: r.status, text: await r.text() };
}

test('/healthz svarer ok, når alt virker, og 503 med det, der fejler', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-health-'));
  const srv = createServer({ port: 0, host: '127.0.0.1', dataDir: dir, quiet: true, requireGuard: false, signupCode: 'k' });
  const b = 'http://127.0.0.1:' + await srv.listen();
  try {
    assert.deepStrictEqual(await get(b, '/healthz'), { status: 200, text: 'ok' });
    assert.deepStrictEqual(await get(b, '/healthz?deep=1'), { status: 200, text: 'ok' }, 'backup findes fra start, og der er plads');
    assert.ok(srv.db.prepare("SELECT value FROM meta WHERE key = 'healthz'").get(), 'skriveprøven er gemt');

    // Backuppen er mere end 36 timer gammel
    const bdir = path.join(dir, 'backup');
    const old = (Date.now() - 40 * 3600_000) / 1000;
    for (const n of fs.readdirSync(bdir)) fs.utimesSync(path.join(bdir, n), old, old);
    assert.deepStrictEqual(await get(b, '/healthz?deep=1'), { status: 503, text: 'fejl: backup' });
    assert.strictEqual((await get(b, '/healthz')).status, 200, 'uden deep tjekkes backuppen ikke');

    // Signeringsnøglen er væk fra disken (næste genstart ville fejle)
    const key = path.join(dir, 'proof-key.pem');
    fs.renameSync(key, key + '.væk');
    assert.deepStrictEqual(await get(b, '/healthz'), { status: 503, text: 'fejl: nøgle' });
    fs.renameSync(key + '.væk', key);

    // Svaret siger intet om lektioner eller version
    const t = (await get(b, '/healthz?deep=1')).text;
    assert.ok(!/\d/.test(t), 'ingen tal i svaret');
  } finally { await srv.close(); }

  // Databasen er lukket
  const srv2 = createServer({ port: 0, host: '127.0.0.1', dataDir: dir, quiet: true, requireGuard: false, signupCode: 'k' });
  const b2 = 'http://127.0.0.1:' + await srv2.listen();
  try {
    srv2.db.close();
    assert.deepStrictEqual(await get(b2, '/healthz'), { status: 503, text: 'fejl: database' });
  } finally {
    clearInterval(srv2.hub.timer);
    await new Promise((r) => srv2.server.close(r)); // databasen er allerede lukket
  }
});

test('/healthz?deep=1: for lidt fri plads på disken', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-health-'));
  const srv = createServer({ port: 0, host: '127.0.0.1', dataDir: dir, quiet: true, requireGuard: false, signupCode: 'k', minFreeBytes: Number.MAX_SAFE_INTEGER });
  const b = 'http://127.0.0.1:' + await srv.listen();
  try {
    assert.deepStrictEqual(await get(b, '/healthz'), { status: 200, text: 'ok' });
    assert.deepStrictEqual(await get(b, '/healthz?deep=1'), { status: 503, text: 'fejl: disk' });
  } finally { await srv.close(); }
});
