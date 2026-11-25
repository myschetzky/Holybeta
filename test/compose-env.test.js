'use strict';
// docker compose: alt, hvad serveren læser fra miljøet, skal stå i environment-listen (ellers når det aldrig ind i containeren)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { APPROVAL_FIELDS } = require('../server/src/index.js');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
// Sat i server/Dockerfile (eller kun til lokal brug)
const NOT_IN_COMPOSE = new Set(['DATA_DIR', 'PORT', 'HOST']);

/** Navnene under services.holymoly.environment i compose-filen (læst som tekst). */
function composeEnv(yaml) {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l, i) => /^ {4}environment:\s*$/.test(l) && lines.slice(0, i).some(x => /^ {2}holymoly:\s*$/.test(x)));
  assert.ok(start > 0, 'holymoly har en environment-liste');
  const out = new Map();
  for (const l of lines.slice(start + 1)) {
    if (/^\s*#/.test(l) || !l.trim()) continue;
    const m = l.match(/^ {6}([A-Z][A-Z0-9_]*):\s*(.*)$/);
    if (!m) break;
    out.set(m[1], m[2].trim());
  }
  return out;
}
/** Alle miljøvariabler, som koden i server/src læser. */
function envNamesInCode() {
  const dir = path.join(root, 'server', 'src');
  const names = new Set();
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.js'))) {
    for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/\b(?:process\.)?env\.([A-Z][A-Z0-9_]+)\b/g)) names.add(m[1]);
  }
  for (const [, env] of APPROVAL_FIELDS) names.add(env);
  return names;
}

test('compose: skolens ja, SIMPLE og alle andre variabler når ind i containeren', () => {
  const yaml = read('deploy/docker-compose.yml');
  assert.ok(!/^\s*env_file\s*:/m.test(yaml), 'ingen env_file (alt står i environment-listen)');
  const env = composeEnv(yaml);
  for (const [, name] of APPROVAL_FIELDS) assert.ok(env.has(name), `${name} (skolens ja) står i compose`);
  const missing = [...envNamesInCode()].filter(n => !NOT_IN_COMPOSE.has(n) && !env.has(n));
  assert.deepStrictEqual(missing, [], 'variabler, koden læser, men som mangler i compose');
  // Standarder i beta
  assert.strictEqual(env.get('SIMPLE'), '${SIMPLE:-1}');
  assert.strictEqual(env.get('SCHOOL_OPERATED'), '${SCHOOL_OPERATED:-0}');
  assert.strictEqual(env.get('REQUIRE_GUARD'), '${REQUIRE_GUARD:-0}');
  assert.ok(!/^"?1"?$/.test(env.get('TRUST_PROXY')), 'TRUST_PROXY stoler ikke på alle');
  assert.ok(!/^ENV .*TRUST_PROXY/m.test(read('server/Dockerfile')), 'TRUST_PROXY sættes ikke i Dockerfile');
});

test('.env.beta.example: kun beta-indstillinger, og alle når ind i containeren', () => {
  const env = composeEnv(read('deploy/docker-compose.yml'));
  const ex = read('deploy/.env.beta.example');
  const keys = [...ex.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map(m => m[1]);
  for (const [, name] of APPROVAL_FIELDS) assert.ok(keys.includes(name), `${name} står i .env.beta.example`);
  for (const k of ['SIMPLE', 'SCHOOL_OPERATED', 'REQUIRE_GUARD', 'TRUST_PROXY']) assert.ok(keys.includes(k), k);
  for (const k of keys) assert.ok(!/^(LICENSING|REQUIRE_2FA|SMTP_URL|MAIL_FROM|TRIAL_DAYS|PRICE_|PLATFORM_ADMINS|SALES_EMAIL)/.test(k), `${k} hører ikke til beta`);
  // Variabler til caddy og cloudflared bruges af de andre tjenester – resten skal ind i holymoly
  for (const k of keys.filter(k => !['HM_DOMAIN', 'CLOUDFLARE_TUNNEL_TOKEN'].includes(k))) assert.ok(env.has(k), `${k} står i compose`);
  assert.ok(/^SIMPLE=0$/m.test(read('deploy/.env.example')), 'den fulde udgave slår enkel tilstand fra');
});

/** Starter serveren direkte (som i Docker) og returnerer opstartslinjen. */
function startLine(extraEnv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-start-'));
  const env = Object.assign({}, process.env, { DATA_DIR: dir, PORT: '0', HOST: '127.0.0.1', DATAANSVARLIG: '', DPO_KONTAKT: '', DPIA_DATO: '', LEDELSE_JA_DATO: '', SCHOOL_OPERATED: '', REQUIRE_GUARD: '', TRUST_PROXY: '' }, extraEnv);
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(root, 'server', 'src', 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const done = (v, e) => { clearTimeout(t); p.kill(); if (e) reject(e); else resolve(v); };
    const t = setTimeout(() => done(null, new Error('ingen opstartslinje:\n' + out)), 15000);
    p.stdout.on('data', (d) => { out += d; const m = out.match(/Udgave: .*/); if (m) done(m[0]); });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', () => done(null, new Error('serveren stoppede:\n' + out)));
  });
}

test('opstartslinjen: udgave, server, skolens ja, vagt og nøgle', async () => {
  const beta = await startLine({ SIMPLE: '1', DPIA_DATO: '2026-11-01', REQUIRE_GUARD: '0' });
  assert.match(beta, /^Udgave: beta · Server: testserver · Skolens ja mangler: DATAANSVARLIG, DPO_KONTAKT, LEDELSE_JA_DATO · Vagt: fra · Nøgle: [0-9a-f]{16}$/);
  const school = await startLine({ SIMPLE: '1', SCHOOL_OPERATED: '1', DATAANSVARLIG: 'Testskolen', DPO_KONTAKT: 'dpo@test.dk', DPIA_DATO: '2026-11-01', LEDELSE_JA_DATO: '2026-11-15', REQUIRE_GUARD: '1' });
  assert.match(school, /^Udgave: beta · Server: skolens · Skolens ja: udfyldt · Vagt: til · Nøgle: [0-9a-f]{16}$/);
  // SIMPLE=0 går forud for edition.json; tom SIMPLE (fx "SIMPLE=" i compose) bruger edition.json
  assert.match(await startLine({ SIMPLE: '0' }), /^Udgave: koncept /);
  const edition = JSON.parse(read('server/edition.json'));
  assert.match(await startLine({ SIMPLE: '' }), edition.simple ? /^Udgave: beta / : /^Udgave: koncept /);
});
