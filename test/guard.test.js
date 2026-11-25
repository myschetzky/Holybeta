'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const guard = require('../agent/src/guard.js');

test('vagt-anmodning og -status (elev-appens side)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-guard-'));
  try {
    assert.strictEqual(guard.installed(dir), false);
    fs.mkdirSync(path.join(dir, 'requests'));
    assert.strictEqual(guard.installed(dir), true);
    const hosts = guard.expandHosts(['chatgpt.com', 'www.instagram.com', 'bad host', '10.0.0.1 bank.dk', 'brave.com/leo']);
    assert.ok(hosts.includes('chatgpt.com') && hosts.includes('www.chatgpt.com') && hosts.includes('api.chatgpt.com'));
    assert.ok(hosts.includes('instagram.com'));
    assert.ok(!hosts.some(h => /\s|\//.test(h)), 'kun gyldige værtsnavne');
    assert.ok(guard.writePairRequest({ 12: 'a'.repeat(32), x: 'ugyldig', 13: 'kort' }, dir));
    const body = fs.readFileSync(path.join(dir, 'requests', 'pair.txt'), 'utf8');
    assert.strictEqual(body, 'pair=12\t' + 'a'.repeat(32) + '\n', 'kun gyldige koder skrives');
    // Status: frisk / forældet / med BOM fra PowerShell
    fs.writeFileSync(path.join(dir, 'guard-status.json'), '﻿' + JSON.stringify({ ts: 1000, version: '1.2.0', hostsActive: true, tamper: [{ ts: 900, what: 'x' }] }));
    assert.strictEqual(guard.readStatus(dir, 2000).fresh, true);
    assert.strictEqual(guard.readStatus(dir, 2000).tamper[0].what, 'x');
    assert.strictEqual(guard.readStatus(dir, 100_000).fresh, false);
    assert.strictEqual(guard.readStatus(path.join(dir, 'findes-ikke'), 2000), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('basislisten er genereret og i sync', () => {
  const { execFileSync } = require('node:child_process');
  const file = path.join(__dirname, '../agent/guard/baseline-hosts.txt');
  const before = fs.readFileSync(file, 'utf8');
  execFileSync(process.execPath, [path.join(__dirname, '../scripts/build-guard-lists.js')]);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before, 'kør npm run sync');
  assert.match(before, /^chatgpt\.com$/m);
});
