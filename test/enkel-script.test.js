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
