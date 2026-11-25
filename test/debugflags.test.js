'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { debugFlagsUsed, BAD_SWITCHES, MESSAGE } = require('../agent/src/debugflags.js');

test('elev-appen nægter at starte med fejlfindingsflag', () => {
  const none = () => false;
  for (const a of ['--remote-debugging-port=9222', '--remote-debugging-pipe', '--inspect', '--inspect=0', '--inspect-brk=9229', '--js-flags=--allow-natives-syntax', '--INSPECT']) {
    assert.ok(debugFlagsUsed(['/opt/HolyMoly/holymoly', a], none), a);
  }
  // Chromium-flag, der kun ses gennem app.commandLine
  for (const s of BAD_SWITCHES) assert.ok(debugFlagsUsed(['holymoly'], (x) => x === s), s);
  // Almindelige starter
  assert.ok(!debugFlagsUsed(['holymoly'], none));
  assert.ok(!debugFlagsUsed(['holymoly', '--tray', '--no-sandbox', 'holymoly://join'], none));
  // Dialogen fra planen
  assert.strictEqual(MESSAGE, 'HolyMoly er startet med fejlfinding slået til og lukker. Start HolyMoly almindeligt.');
});

test('main.js tjekker flagene, før appen er klar', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'agent', 'src', 'main.js'), 'utf8');
  const check = src.indexOf('debugFlagsUsed(process.argv');
  assert.ok(check > 0);
  assert.ok(check < src.indexOf('app.whenReady('), 'tjekket ligger før app.whenReady');
  assert.ok(check < src.indexOf('requestSingleInstanceLock'), 'og før single-instance-låsen');
});
