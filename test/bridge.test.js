'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const WebSocket = require(require.resolve('ws', { paths: [path.join(__dirname, '../server')] }));
const { Bridge } = require('../agent/src/bridge.js');
const R = require('../shared/rules.js').compile();
const { Policy, colorOf } = require('../agent/src/policy.js');

const browserOfProc = (p) => R.browserOf(p.orig) || R.browserOf(p.name);
const connect = (port, origin) => new Promise((resolve) => {
  const ws = new WebSocket('ws://127.0.0.1:' + port + '/', { headers: { Origin: origin } });
  ws.msgs = [];
  ws.on('message', (d) => ws.msgs.push(JSON.parse(d.toString())));
  ws.on('open', () => resolve(ws));
  ws.on('unexpected-response', () => resolve(null));
  ws.on('error', () => resolve(null));
});
const until = async (fn, ms = 2000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await new Promise(r => setTimeout(r, 20)); } return false; };

test('broen accepterer kun rigtige browser-processer – og tager browsernavnet fra processen', async () => {
  let fakeProc = { pid: 1, name: 'chrome', orig: 'chrome' };
  const b = new Bridge({ identifyPeer: async () => fakeProc, browserOfProc });
  const port = await b.start();
  try {
    // Rigtig Chrome – selv om udvidelsen påstår at være "edge", bliver den til "chrome"
    const ok = await connect(port, 'chrome-extension://abc');
    ok.send(JSON.stringify({ type: 'hello', browser: 'edge', version: '1.1.0' }));
    assert.ok(await until(() => b.live().length === 1));
    assert.strictEqual(b.live()[0].browser, 'chrome');

    // Et script (node/python) der sætter Origin-headeren selv, afvises
    fakeProc = { pid: 2, name: 'python3', orig: '' };
    const evil = await connect(port, 'chrome-extension://abc');
    let closed = null;
    evil.on('close', (code) => { closed = code; });
    evil.send(JSON.stringify({ type: 'hello', browser: 'chrome' }));
    evil.send(JSON.stringify({ type: 'tabs', windows: [{ focused: true, active: { url: 'https://docs.google.com', title: 'ChatGPT' } }] }));
    assert.ok(await until(() => closed === 4403), 'falsk klient lukket');
    assert.strictEqual(b.live().length, 1);

    // Firefox-origin fra en Chrome-proces afvises (skal passe sammen)
    fakeProc = { pid: 3, name: 'chrome', orig: 'chrome' };
    const mixed = await connect(port, 'moz-extension://uuid');
    let mixedClosed = null;
    mixed.on('close', (code) => { mixedClosed = code; });
    assert.ok(await until(() => mixedClosed === 4403));
    ok.close();
  } finally { b.stop(); }
});

test('et andet program på HolyMolys port giver rød', () => {
  const p = new Policy();
  p.setRules(R, {});
  const r = p.evaluate({ fg: { app: 'WINWORD' }, bridgeSquatter: 'python3 (port 47811)', now: 1 });
  assert.strictEqual(colorOf(r), 'red');
});
