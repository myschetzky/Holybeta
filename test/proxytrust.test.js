'use strict';
// TRUST_PROXY: X-Forwarded-* bruges kun fra de proxyer, der står i listen
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createProxyTrust } = require('../server/src/proxytrust.js');
const { createServer } = require('../server/src/index.js');

test('TRUST_PROXY: IP-adresser, net og værtsnavne', async () => {
  const t = createProxyTrust('10.0.0.5, 172.16.0.0/12 fd00::/8,caddy', { lookup: async (h) => (h === 'caddy' ? [{ address: '192.168.7.9', family: 4 }] : []) });
  await t.ready;
  assert.ok(t.trusts('10.0.0.5'));
  assert.ok(t.trusts('::ffff:10.0.0.5'), 'IPv4 skrevet som IPv6-adresse');
  assert.ok(t.trusts('172.20.1.2'));
  assert.ok(t.trusts('fd00::1'));
  assert.ok(t.trusts('192.168.7.9'), 'caddy slås op');
  assert.ok(!t.trusts('10.0.0.6'));
  assert.ok(!t.trusts('8.8.8.8'));
  assert.ok(!t.trusts(''));
  t.stop();
  for (const v of ['', '0', undefined, false]) assert.ok(!createProxyTrust(v).trusts('127.0.0.1'), `"${v}" stoler på ingen`);
  for (const v of ['1', true]) { const a = createProxyTrust(v); assert.ok(a.all && a.trusts('8.8.8.8'), `"${v}" stoler på alle`); }
});

test('TRUST_PROXY: kun en proxy i listen kan gøre forbindelsen til https', async () => {
  const mk = async (trustProxy, quiet = true) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-proxy-'));
    const s = createServer({ port: 0, host: '127.0.0.1', dataDir: dir, quiet, requireGuard: false, trustProxy });
    return { s, b: 'http://127.0.0.1:' + await s.listen() };
  };
  const hsts = async (b) => (await fetch(b + '/', { headers: { 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '1.2.3.4' } })).headers.get('strict-transport-security');
  for (const [v, trusted] of [['127.0.0.1', true], ['localhost', true], ['10.0.0.0/8', false], ['', false], ['1', true], [true, true]]) {
    const { s, b } = await mk(v);
    assert.strictEqual(!!(await hsts(b)), trusted, `TRUST_PROXY="${v}"`);
    await s.close();
  }
  // "1" giver en advarsel i loggen
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    const { s } = await mk('1', false);
    await s.close();
  } finally { console.log = orig; }
  assert.ok(lines.some(l => l.includes('ADVARSEL: TRUST_PROXY=1 stoler på alle')), 'advarsel ved TRUST_PROXY=1');
});
