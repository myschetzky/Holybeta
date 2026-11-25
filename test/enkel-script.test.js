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

test('npm run enkel -- overdrag: registrerer, at skolens IT har overtaget driften', () => {
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-enkel-'));
  const run = (...a) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'scripts', 'enkel.js'), ...a], { env: Object.assign({}, process.env, { DATA_DIR: dir, SCHOOL_OPERATED: '1' }), encoding: 'utf8' });
  let r = run('overdrag');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /overdraget til skolen/);
  r = run('overdrag');
  assert.match(r.stdout, /blev overdraget til skolen \d{4}-\d{2}-\d{2}/, 'anden gang: datoen for overdragelsen');
  const db = require('../server/src/db.js').open(dir);
  assert.ok(Number(db.prepare("SELECT value FROM meta WHERE key = 'school_operated_since'").get().value) > 0);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('npm run enkel -- aktive: exit 1, når lektioner, skriveøkter eller ekstra tid er i gang (til scripts/opdater.sh)', () => {
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-enkel-'));
  const run = () => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'scripts', 'enkel.js'), 'aktive'], { env: Object.assign({}, process.env, { DATA_DIR: dir }), encoding: 'utf8' });
  let r = run();
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /Ingen database/);
  const db = require('../server/src/db.js').open(dir);
  db.prepare('INSERT INTO teachers (id, email, name, pass_hash, created) VALUES (1, ?, ?, ?, ?)').run('jens', 'Jens', 'x', Date.now());
  db.prepare("INSERT INTO classes (id, teacher_id, name, created) VALUES (1, 1, '2.g', ?)").run(Date.now());
  db.prepare("INSERT INTO students (id, class_id, name, created) VALUES (1, 1, 'Anna', ?)").run(Date.now());
  // Slut eller udløbet tæller ikke
  db.prepare('INSERT INTO lessons (class_id, started, ends_at, ended) VALUES (1, 0, ?, ?)').run(Date.now() + 3600_000, Date.now());
  db.prepare('INSERT INTO lessons (class_id, started, ends_at) VALUES (1, 0, ?)').run(Date.now() - 1000);
  r = run();
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Ingen lektioner eller skriveøkter i gang/);
  const l = db.prepare('INSERT INTO lessons (class_id, started, ends_at) VALUES (1, 0, ?)').run(Date.now() + 3600_000);
  db.prepare("INSERT INTO lessons (class_id, started, ends_at, student_id, kind) VALUES (1, 0, ?, 1, 'hjemme')").run(Date.now() + 3600_000);
  r = run();
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /I gang: 1 lektion, 1 skriveøkt\./);
  db.prepare('UPDATE lessons SET ended = ? WHERE ended IS NULL').run(Date.now());
  db.prepare('INSERT INTO lesson_extensions (lesson_id, student_id, ends_at) VALUES (?, 1, ?)').run(Number(l.lastInsertRowid), Date.now() + 600_000);
  r = run();
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /I gang: 1 elev med ekstra tid\./);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('scripts/opdater.sh: bygger først, tjekker "aktive" (medmindre --force) og genstarter til sidst', () => {
  const { spawnSync } = require('node:child_process');
  const file = path.join(__dirname, '..', 'scripts', 'opdater.sh');
  const src = fs.readFileSync(file, 'utf8');
  assert.strictEqual(spawnSync('sh', ['-n', file]).status, 0, 'gyldig sh');
  assert.ok(fs.statSync(file).mode & 0o100, 'kan køres');
  const at = (s) => { const i = src.indexOf(s); assert.ok(i >= 0, s); return i; };
  assert.ok(at('git pull --ff-only') < at('build holymoly'));
  assert.ok(at('build holymoly') < at('enkel.js aktive'));
  assert.ok(at('enkel.js aktive') < at('up -d holymoly'));
  assert.match(src, /--force/);
});
