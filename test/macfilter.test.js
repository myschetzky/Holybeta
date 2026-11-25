'use strict';
const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const R = require('../shared/rules.js');
const { MacFilter } = require('../agent/src/macfilter.js');
const { Policy, colorOf } = require('../agent/src/policy.js');

/** Falsk systemudvidelse med samme protokol som macos/Extension/ControlServer.swift */
function fakeExtension() {
  const clients = new Map();
  let next = 1;
  const configs = [];
  const server = net.createServer((sock) => {
    const id = next++;
    clients.set(id, sock);
    sock.setEncoding('utf8');
    let buf = '';
    sock.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (m.type === 'config') {
          configs.push({ by: id, m });
          for (const c of clients.values()) c.write(JSON.stringify({ type: 'state', active: m.active, until: m.until, by: id }) + '\n');
        }
      }
    });
    sock.on('close', () => clients.delete(id));
    sock.on('error', () => {});
    sock.write(JSON.stringify({ type: 'hello', version: '1.0.0', conn: id, pid: 1 }) + '\n');
  });
  return {
    server, configs,
    listen: () => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port))),
    flow: (f) => { for (const c of clients.values()) c.write(JSON.stringify(Object.assign({ type: 'flow', ts: Date.now() }, f)) + '\n'); },
    close: () => { for (const c of clients.values()) c.destroy(); return new Promise(r => server.close(r)); },
  };
}
const until = async (fn, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await new Promise(r => setTimeout(r, 20)); } return false; };

test('forbinder, sender regler og modtager AI-forbindelser', async () => {
  const fx = fakeExtension();
  const port = await fx.listen();
  const mf = new MacFilter({ port, verify: async () => ({ ok: true }) });
  mf.start();
  try {
    assert.ok(await until(() => mf.state === 'ok'), 'tilstand ok');
    mf.setConfig({ active: true, until: Date.now() + 60_000, ai: ['openai.com'], block: ['tiktok.com'], dropAi: true });
    assert.ok(await until(() => fx.configs.length === 1));
    assert.deepStrictEqual(fx.configs[0].m.ai, ['openai.com']);
    fx.flow({ app: 'com.microsoft.Word', pid: 321, host: 'copilot.microsoft.com', rule: 'copilot.microsoft.com', ai: true, blocked: true });
    assert.ok(await until(() => mf.recentAi().length === 1));
    assert.strictEqual(mf.recentAi()[0].app, 'com.microsoft.Word');
    assert.strictEqual(mf.lastForeignChange, 0, 'egne ændringer er ikke manipulation');
  } finally { mf.stop(); await fx.close(); }
});

test('et andet program der ændrer filteret opdages og reglerne gendannes', async () => {
  const fx = fakeExtension();
  const port = await fx.listen();
  const mf = new MacFilter({ port, verify: async () => ({ ok: true }) });
  let tamper = null;
  mf.on('tamper', (t) => { tamper = t; });
  mf.start();
  try {
    await until(() => mf.state === 'ok');
    mf.setConfig({ active: true, until: Date.now() + 60_000, ai: [], block: [], exempt: [], dropAi: true });
    await until(() => fx.configs.length === 1);
    // "Eleven" forbinder selv og prøver at slå filteret fra
    const evil = net.connect(port, '127.0.0.1');
    await new Promise(r => evil.on('connect', r));
    evil.write(JSON.stringify({ type: 'config', active: false, until: 0 }) + '\n');
    assert.ok(await until(() => tamper !== null), 'manipulation opdaget');
    assert.ok(await until(() => fx.configs.length >= 3 && fx.configs[fx.configs.length - 1].m.active === true), 'regler gendannet');
    evil.destroy();
  } finally { mf.stop(); await fx.close(); }
});

test('en falsk lytter (ikke systemudvidelsen) godkendes ikke', async () => {
  const fx = fakeExtension();
  const port = await fx.listen();
  const mf = new MacFilter({ port, verify: async () => ({ ok: false, reason: 'forkert proces: /tmp/fake' }) });
  mf.start();
  try {
    assert.ok(await until(() => mf.state === 'unverified'));
    mf.setConfig({ active: true, until: Date.now() + 60_000, ai: [], block: [], exempt: [], dropAi: true });
    await new Promise(r => setTimeout(r, 200));
    assert.strictEqual(fx.configs.length, 0, 'reglerne sendes ikke til en falsk lytter');
  } finally { mf.stop(); await fx.close(); }
});

test('policy: Mac-filterets AI-forbindelser, krav om filter og manipulation', () => {
  const p = new Policy();
  p.setRules(R.compile(R.RULE_DATA, {}), {});
  const base = { platform: 'darwin', fg: { app: 'Pages', title: 'Stil' }, now: 1_000_000 };
  // Word bruger Copilot -> rød; Safari -> ikke rød (blokeret forsøg)
  const r = p.evaluate(Object.assign({}, base, { netAi: [
    { pid: 10, host: 'copilot.microsoft.com', bundle: 'com.microsoft.Word' },
    { pid: 11, host: 'chatgpt.com', bundle: 'com.apple.Safari' },
  ] }));
  assert.strictEqual(colorOf(r), 'red');
  assert.deepStrictEqual(r.violations.map(v => v.text), ['Word bruger AI (copilot.microsoft.com)']);
  // Et program der bare KALDER sig dk.holymoly.* er ikke HolyMoly (det rigtige undtages af filteret selv)
  const fake = p.evaluate(Object.assign({}, base, { netAi: [{ pid: 13, host: 'api.openai.com', bundle: 'dk.holymoly.x' }] }));
  assert.strictEqual(colorOf(fake), 'red');
  // Skolen kræver filteret, men det kører ikke -> grå
  assert.strictEqual(colorOf(p.evaluate(Object.assign({}, base, { macFilterRequired: true, macFilterState: 'missing' }))), 'grey');
  assert.strictEqual(colorOf(p.evaluate(Object.assign({}, base, { macFilterRequired: true, macFilterState: 'ok' }))), 'green');
  // Nogen har prøvet at ændre filteret -> rød i 5 minutter
  assert.strictEqual(colorOf(p.evaluate(Object.assign({}, base, { macFilterTamperAt: base.now - 60_000 }))), 'red');
  assert.strictEqual(colorOf(p.evaluate(Object.assign({}, base, { macFilterTamperAt: base.now - 10 * 60_000 }))), 'green');
});
