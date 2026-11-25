'use strict';
// Nøglesikkerhed: ingen nøgle i klartekst i backup/, krypteret backup ud af huset (backup-ud), gendannelsestest
// (gendan-test) og nøgleringen trusted_keys med nøgleskifte (ny-noegle): gamle beviser holder, gamle nøgler signerer aldrig.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const dbm = require('../server/src/db.js');
const { DocStore } = require('../server/src/docs.js');
const { createServer } = require('../server/src/index.js');
const KR = require('../server/src/keyring.js');

const SENT = 'Romantikken var en periode i kunsten hvor følelser og natur fik en stor plads. ';
const LONG = SENT.repeat(9).trim();
const green = { color: 'green', violations: [] };
const meta = { studentName: 'Anna Jensen', className: '2.g Dansk', teacherName: 'Mette', issuer: 'https://holymoly.test' };
const PASS = 'korrekt-hest-batteri-hæfteklamme';
const ENKEL = path.join(__dirname, '..', 'scripts', 'enkel.js');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-noegle-'));
  const db = dbm.open(dir);
  db.prepare("INSERT INTO teachers (id, email, name, pass_hash, created) VALUES (1, 'l@x.dk', 'Mette', 'x', 0)").run();
  db.prepare("INSERT INTO classes (id, teacher_id, name, created) VALUES (1, 1, '2.g Dansk', 0)").run();
  db.prepare("INSERT INTO students (id, class_id, name, created, enrolled) VALUES (1, 1, 'Anna Jensen', 0, 1)").run();
  return { dir, db, docs: new DocStore(db, dir), anna: { id: 1, class_id: 1 } };
}
/** Et ærligt skriveforløb (de sidste ti minutter) og en aflevering nu. */
function certify(docs, anna) {
  const id = crypto.randomUUID();
  let t = Date.now() - 600_000;
  for (let n = 40; ; n += 40) {
    const text = LONG.slice(0, Math.min(n, LONG.length));
    const r = docs.save(anna, { id, title: 'R', blocks: [{ t: 'p', r: [{ x: text }] }], stats: { typed: Math.round(text.length * 1.15) + 12, deleted: Math.round(text.length * 0.1), keystrokes: text.length + 20, maxCps: 6, regularity: 0.7 } }, green, 1, t);
    assert.ok(r.ok, r.error);
    if (n >= LONG.length) break;
    t += 5000;
  }
  return docs.submit(anna, id, meta, Date.now());
}
const enkel = (args, env) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', ENKEL, ...args], { env: Object.assign({}, process.env, env), encoding: 'utf8' });

test('backup/: databasen kopieres hver nat, men signeringsnøglen ligger aldrig i klartekst der', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-noegle-bak-'));
  const srv = createServer({ port: 0, host: '127.0.0.1', dataDir: dir, signupCode: 'k', quiet: true, requireGuard: false });
  try {
    // En gammel klartekst-kopi fra en tidligere version slettes ved næste backup
    fs.mkdirSync(path.join(dir, 'backup'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'backup', 'proof-key.pem'), 'gammel kopi');
    const file = srv.backup(true);
    assert.ok(file && fs.existsSync(file));
    assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'backup')).filter(n => !/^holymoly-\d{4}-\d{2}-\d{2}\.db$/.test(n)), []);
    for (const n of fs.readdirSync(path.join(dir, 'backup'))) assert.ok(!fs.readFileSync(path.join(dir, 'backup', n)).includes('PRIVATE KEY'), n);
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'index.js'), 'utf8');
    assert.ok(!/copyFileSync\([^)]*proof-key/.test(src), 'nøglen kopieres ikke');
  } finally { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('krypteringen: AES-256-GCM med scrypt-afledt nøgle; forkert frase, ændret fil og kort frase afvises', () => {
  const files = [{ name: 'holymoly.db', data: Buffer.from('SQLite format 3\0 data') }, { name: 'proof-key.pem', data: Buffer.from('-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----\n') }];
  const enc = KR.encrypt(files, PASS, { keyId: 'abcd' });
  assert.ok(enc.subarray(0, 8).equals(KR.MAGIC));
  assert.ok(!enc.includes('PRIVATE KEY') && !enc.includes('SQLite'), 'intet i klartekst');
  const dec = KR.decrypt(enc, PASS);
  assert.deepStrictEqual(dec.files.map(f => [f.name, f.data.toString()]), files.map(f => [f.name, f.data.toString()]));
  assert.strictEqual(dec.manifest.keyId, 'abcd');
  assert.throws(() => KR.decrypt(enc, PASS + 'x'), /Forkert adgangsfrase/);
  const bad = Buffer.from(enc); bad[bad.length - 1] ^= 1;
  assert.throws(() => KR.decrypt(bad, PASS), /Forkert adgangsfrase, eller filen er ændret/);
  assert.throws(() => KR.encrypt(files, 'kort'), /BACKUP_PASSPHRASE/);
  assert.throws(() => KR.decrypt(Buffer.from('noget andet'), PASS), /ikke en HolyMoly-backup/);
});

test('backup-ud og gendan-test: én krypteret fil med database og nøgle, der kan gendannes og verificere det nyeste bevis', () => {
  const { dir, db, docs, anna } = setup();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-noegle-nas-'));
  try {
    const r = certify(docs, anna);
    assert.ok(r.certId, JSON.stringify(r.reasons));
    let p = enkel(['backup-ud', out], { DATA_DIR: dir, BACKUP_PASSPHRASE: '' });
    assert.strictEqual(p.status, 1);
    assert.match(p.stderr, /BACKUP_PASSPHRASE mangler/);
    p = enkel(['backup-ud', out], { DATA_DIR: dir, BACKUP_PASSPHRASE: PASS });
    assert.strictEqual(p.status, 0, p.stderr);
    const files = fs.readdirSync(out).filter(n => n.endsWith('.hmbak'));
    assert.strictEqual(files.length, 1);
    assert.match(files[0], /^holymoly-backup-\d{4}-\d{2}-\d{2}\.hmbak$/);
    const file = path.join(out, files[0]);
    const raw = fs.readFileSync(file);
    assert.ok(!raw.includes('PRIVATE KEY') && !raw.includes('Anna Jensen'), 'krypteret');
    assert.strictEqual(fs.statSync(file).mode & 0o077, 0, 'kun ejeren kan læse filen');
    const dec = KR.decrypt(raw, PASS);
    assert.deepStrictEqual(dec.files.map(f => f.name).sort(), ['holymoly.db', 'proof-key.pem', 'totp.key'].filter(n => fs.existsSync(path.join(dir, n))).sort());
    assert.ok(dec.files.find(f => f.name === 'proof-key.pem').data.equals(fs.readFileSync(path.join(dir, 'proof-key.pem'))));
    p = enkel(['gendan-test', file], { BACKUP_PASSPHRASE: PASS });
    assert.strictEqual(p.status, 0, p.stderr);
    assert.match(p.stdout, /1 beviser/);
    assert.match(p.stdout, new RegExp(`Det nyeste bevis HM-${r.certId.slice(0, 8).toUpperCase()} .* er gyldigt med nøgle ${docs.keyId}`));
    assert.match(p.stdout, /Gendannelsestesten bestod/);
    // Med en mappe: filerne beholdes til en rigtig gendannelse
    const keep = path.join(out, 'gendannet');
    p = enkel(['gendan-test', file, keep], { BACKUP_PASSPHRASE: PASS });
    assert.strictEqual(p.status, 0, p.stderr);
    assert.ok(fs.readFileSync(path.join(keep, 'proof-key.pem')).equals(fs.readFileSync(path.join(dir, 'proof-key.pem'))));
    assert.ok(fs.existsSync(path.join(keep, 'holymoly.db')));
    p = enkel(['gendan-test', file], { BACKUP_PASSPHRASE: 'en-helt-anden-frase' });
    assert.strictEqual(p.status, 1);
    assert.match(p.stderr, /Gendannelsestesten fejlede: Forkert adgangsfrase/);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(out, { recursive: true, force: true }); }
});

test('nøgleringen: ny-noegle – gamle beviser holder, den gamle nøgle signerer aldrig igen, og kompromitterede beviser er ugyldige', () => {
  const { dir, db, docs, anna } = setup();
  try {
    assert.deepStrictEqual(KR.list(db).map(k => k.keyId), [docs.keyId], 'den aktive nøgle står i nøgleringen');
    const old = certify(docs, anna);
    assert.ok(old.certId);
    const oldId = docs.keyId;
    const oldPem = fs.readFileSync(path.join(dir, 'proof-key.pem'));
    const p = enkel(['ny-noegle'], { DATA_DIR: dir });
    assert.strictEqual(p.status, 0, p.stderr);
    assert.match(p.stdout, /Ny signeringsnøgle: [0-9a-f]{16}\./);
    assert.match(p.stdout, new RegExp(`Den gamle nøgle \\(${oldId}\\) kan nu kun verificere`));
    assert.ok(!fs.readFileSync(path.join(dir, 'proof-key.pem')).equals(oldPem), 'ny privat nøgle');
    assert.ok(fs.existsSync(path.join(dir, 'proof-keys', oldId + '.pub.pem')), 'den gamle offentlige nøgle i proof-keys/');
    assert.ok(!fs.readFileSync(path.join(dir, 'proof-keys', oldId + '.pub.pem'), 'utf8').includes('PRIVATE'));
    // Den kørende server (gammel nøgle i hukommelsen) udsteder ikke flere beviser, før den er genstartet
    const refused = certify(docs, anna);
    assert.strictEqual(refused.ok, false);
    assert.match(refused.error, /genstartes/);
    // Efter genstart: ny nøgle. Det gamle bevis er stadig gyldigt (med den gamle offentlige nøgle)
    const docs2 = new DocStore(db, dir);
    assert.notStrictEqual(docs2.keyId, oldId);
    const c = docs2.certificate(old.certId);
    assert.strictEqual(c.valid, true);
    assert.strictEqual(c.payload.keyId, oldId);
    assert.strictEqual(c.publicKey, KR.lookup(db, oldId).pem, 'tjek-siden viser bevisets egen nøgle');
    assert.strictEqual(docs2.findBySha([c.payload.sha256]).length, 1, 'tjek-siden finder det gamle bevis');
    const neu = certify(docs2, anna);
    assert.ok(neu.certId);
    assert.strictEqual(docs2.certificate(neu.certId).valid, true);
    assert.strictEqual(docs2.certificate(neu.certId).payload.keyId, docs2.keyId);
    // Et bevis signeret med den gamle nøgle EFTER skiftet er ugyldigt (fx med en lækket kopi af den gamle nøgle)
    const ring = KR.list(db);
    const retiredAt = ring.find(k => k.keyId === oldId).validTo;
    assert.ok(retiredAt > 0);
    const forge = (submitted) => {
      const payload = JSON.stringify({ v: 3, id: crypto.randomBytes(12).toString('base64url'), sha256: 'x'.repeat(64), words: 100, submitted, kind: 'klasse', observed: ['skrivevindue'], test: false, checks: [], issuer: '', keyId: oldId });
      const id = JSON.parse(payload).id;
      db.prepare('INSERT INTO certificates (id, doc_id, payload, sig, created, student_name, class_name, text_sha256) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, '', payload, crypto.sign(null, Buffer.from(payload), crypto.createPrivateKey(oldPem)).toString('base64'), submitted, '', '', 'x'.repeat(64));
      return id;
    };
    assert.strictEqual(docs2.certificate(forge(retiredAt + 3600_000)).valid, false, 'efter skiftet');
    assert.strictEqual(docs2.certificate(forge(retiredAt - 3600_000)).valid, true, 'før skiftet');
    // Den gamle private nøgle lagt tilbage: serveren nægter at starte med den
    fs.writeFileSync(path.join(dir, 'proof-key.pem'), oldPem);
    assert.throws(() => new DocStore(db, dir), /er udskiftet og må ikke signere/);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('nøgleringen: --kompromitteret DATO gør beviser fra den dato ugyldige, men ikke ældre', () => {
  const { dir, db, docs, anna } = setup();
  try {
    const before = certify(docs, anna);
    assert.ok(before.certId);
    const oldId = docs.keyId;
    // Kompromitteret fra i morgen: beviset fra i dag holder
    const tomorrow = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
    const p = enkel(['ny-noegle', '--kompromitteret', tomorrow], { DATA_DIR: dir });
    assert.strictEqual(p.status, 0, p.stderr);
    assert.match(p.stdout, new RegExp(`Beviser udstedt fra ${tomorrow} med den er ugyldige`));
    const k = KR.lookup(db, oldId);
    assert.strictEqual(k.compromisedFrom, Date.parse(tomorrow + 'T00:00:00Z'));
    const docs2 = new DocStore(db, dir);
    assert.strictEqual(docs2.certificate(before.certId).valid, true);
    // Kompromitteret fra i går: beviset fra i dag er ugyldigt
    db.prepare('UPDATE trusted_keys SET compromised_from = ? WHERE key_id = ?').run(Date.now() - 86400_000, oldId);
    assert.strictEqual(docs2.certificate(before.certId).valid, false);
    assert.strictEqual(docs2.findBySha([docs2.certificate(before.certId).payload.sha256]).length, 0, 'tjek-siden finder det ikke');
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
