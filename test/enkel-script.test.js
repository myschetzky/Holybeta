'use strict';
// npm run enkel: udskriver opsætningskoden til den første lærer og advarer, hvis skolens ja mangler
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function run(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-enkel-'));
  const clean = Object.assign({}, process.env);
  for (const k of ['DATAANSVARLIG', 'DPO_KONTAKT', 'DPIA_DATO', 'LEDELSE_JA_DATO', 'SIMPLE', 'TEACHER_SIGNUP_CODE']) delete clean[k];
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'scripts', 'enkel.js')], {
    env: Object.assign(clean, { PORT: '0', HOST: '127.0.0.1', DATA_DIR: dir }, env), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Ingen udskrift: ' + out)); }, 10_000);
    const iv = setInterval(() => {
      if (!/Stop med Ctrl\+C[\s\S]*\n\n/.test(out)) return;
      clearInterval(iv); clearTimeout(timer);
      child.kill();
      child.on('exit', () => { fs.rmSync(dir, { recursive: true, force: true }); resolve(out); });
    }, 50);
  });
}

test('npm run enkel: opsætningskode og advarsel om skolens ja', async () => {
  let out = await run({});
  assert.match(out, /Opsætningskode til første lærer: [A-Z0-9]{4}-[A-Z0-9]{4}/);
  assert.match(out, /ADVARSEL: Skolens ja mangler/);
  assert.match(out, /DATAANSVARLIG, DPO_KONTAKT, DPIA_DATO, LEDELSE_JA_DATO/);
  out = await run({ DATAANSVARLIG: 'Testskolen', DPO_KONTAKT: 'dpo@kommune.dk', DPIA_DATO: '2026-11-01', LEDELSE_JA_DATO: '2026-11-15' });
  assert.match(out, /Opsætningskode til første lærer/);
  assert.doesNotMatch(out, /ADVARSEL: Skolens ja mangler/);
});

test('npm run enkel -- godkend <brugernavn>: godkender en ventende lærer', () => {
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-enkel-'));
  const db = require('../server/src/db.js').open(dir);
  db.prepare('INSERT INTO teachers (email, name, pass_hash, created) VALUES (?,?,?,?)').run('jens', 'Jens', 'x', Date.now());
  db.close();
  const run = (...a) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'scripts', 'enkel.js'), ...a], { env: Object.assign({}, process.env, { DATA_DIR: dir }), encoding: 'utf8' });
  let r = run('godkend', 'jens');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /Jens \(jens\) er godkendt/);
  r = run('godkend', 'ukendt');
  assert.strictEqual(r.status, 1);
  const db2 = require('../server/src/db.js').open(dir);
  assert.ok(db2.prepare("SELECT approved FROM teachers WHERE email = 'jens'").get().approved);
  db2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
