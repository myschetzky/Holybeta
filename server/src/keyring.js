'use strict';
/*
 * Nøglesikkerhed: nøgleringen (trusted_keys) og den krypterede backup ud af huset.
 *
 * Nøgleringen: én række pr. signeringsnøgle, serveren har brugt (keyId -> offentlig nøgle, gyldig fra/til).
 * Kun den aktive nøgle (proof-key.pem) kan signere. Gamle nøgler ligger kun som offentlige nøgler og kan kun verificere.
 * Et bevis er gyldigt, når signaturen passer med nøglen for dets keyId, og det er udstedt, mens nøglen var gyldig
 * (og før en eventuel "kompromitteret fra"-dato). Samme tabel bruges senere ved flytning til hostet drift.
 *
 * Den krypterede backup (npm run enkel -- backup-ud <mål>): én fil med databasen, proof-key.pem og totp.key.
 * Krypteret med AES-256-GCM og en nøgle afledt af adgangsfrasen i BACKUP_PASSPHRASE (scrypt). Ingen eksterne værktøjer.
 * Filformat: MAGIC (8 byte) | salt (16) | iv (12) | tag (16) | krypteret indhold. Headeren (MAGIC+salt+iv) er AAD.
 * Indholdet: 4 byte længde | manifest (JSON: { v, created, keyId, files: [{ name, size, sha256 }] }) | filerne efter hinanden.
 */
const crypto = require('node:crypto');

const MAGIC = Buffer.from('HMBAK01\n', 'ascii');
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
const MIN_PASSPHRASE = 12;
const FILES = ['holymoly.db', 'proof-key.pem', 'totp.key'];

/* ---------------------------------------------------------------- nøgleringen ---------------------------------------------------------------- */
function ensureTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS trusted_keys (
    key_id TEXT PRIMARY KEY,
    public_pem TEXT NOT NULL,
    valid_from INTEGER NOT NULL,
    valid_to INTEGER,
    compromised_from INTEGER,
    note TEXT
  )`);
}

/** keyId: de første 16 hex-tegn af sha256 over den offentlige nøgle (DER). */
function keyIdOf(publicKey) {
  return crypto.createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
}

/**
 * Den aktive nøgle står i nøgleringen. Serverens første nøgle er gyldig fra begyndelsen (så alle eksisterende beviser
 * stadig er gyldige); en nøgle, der kommer til senere, er gyldig fra nu.
 * Er den aktive nøgle udskiftet (valid_to) eller kompromitteret, må den ikke signere: fejl.
 */
function registerActive(db, publicKey, now = Date.now()) {
  ensureTable(db);
  const id = keyIdOf(publicKey);
  const row = db.prepare('SELECT * FROM trusted_keys WHERE key_id = ?').get(id);
  if (!row) {
    const first = !db.prepare('SELECT 1 AS x FROM trusted_keys LIMIT 1').get();
    const from = first ? 0 : now;
    db.prepare('INSERT INTO trusted_keys (key_id, public_pem, valid_from) VALUES (?,?,?)').run(id, publicKey.export({ type: 'spki', format: 'pem' }), from);
    return id;
  }
  if (row.valid_to != null || row.compromised_from != null) {
    throw new Error(`Signeringsnøglen ${id} er ${row.compromised_from != null ? 'kompromitteret' : 'udskiftet'} og må ikke signere. `
      + 'Læg den aktive proof-key.pem tilbage, eller lav en ny med "npm run enkel -- ny-noegle".');
  }
  return id;
}

/** Må nøglen signere lige nu? Kun en nøgle i nøgleringen uden valid_to og uden compromised_from (fx ikke efter et nøgleskifte). */
function canSign(db, keyId) {
  ensureTable(db);
  const r = db.prepare('SELECT valid_to, compromised_from FROM trusted_keys WHERE key_id = ?').get(String(keyId || ''));
  return !!r && r.valid_to == null && r.compromised_from == null;
}

/** Nøglen til et keyId: { keyId, publicKey, pem, validFrom, validTo, compromisedFrom } eller null. */
function lookup(db, keyId) {
  ensureTable(db);
  const r = db.prepare('SELECT * FROM trusted_keys WHERE key_id = ?').get(String(keyId || ''));
  if (!r) return null;
  return { keyId: r.key_id, pem: r.public_pem, publicKey: crypto.createPublicKey(r.public_pem), validFrom: r.valid_from, validTo: r.valid_to, compromisedFrom: r.compromised_from };
}
function list(db) {
  ensureTable(db);
  return db.prepare('SELECT key_id AS keyId, valid_from AS validFrom, valid_to AS validTo, compromised_from AS compromisedFrom, note FROM trusted_keys ORDER BY valid_from').all();
}

/**
 * Verificér en signeret tekst med nøgleringen. p: den parsede payload (keyId, submitted). Ældre beviser uden keyId
 * prøves mod alle nøgler. Returnerer { valid, key } (key: nøglen, der passede, eller null).
 * Tidsrummet: udstedt (submitted, ellers created) inden for [valid_from, valid_to] – og før compromised_from.
 */
function verify(db, payloadText, sigB64, p, created) {
  ensureTable(db);
  const keys = p && p.keyId ? [lookup(db, p.keyId)].filter(Boolean) : db.prepare('SELECT key_id FROM trusted_keys').all().map(r => lookup(db, r.key_id));
  const at = Number(p && p.submitted) || Number(created) || 0;
  const sig = Buffer.from(String(sigB64 || ''), 'base64');
  for (const k of keys) {
    let ok = false;
    try { ok = crypto.verify(null, Buffer.from(String(payloadText)), k.publicKey, sig); } catch (e) { ok = false; }
    if (!ok) continue;
    const inTime = at >= Number(k.validFrom) - 60_000 && (k.validTo == null || at <= Number(k.validTo)) && (k.compromisedFrom == null || at < Number(k.compromisedFrom));
    return { valid: inTime, key: k };
  }
  return { valid: false, key: keys[0] || null };
}

/**
 * Nøgleskifte (npm run enkel -- ny-noegle): den gamle nøgle får valid_to = nu (og evt. compromised_from) og beholdes
 * kun som offentlig nøgle. Returnerer { privatePem, oldId, newId }. Kalderen skriver privatePem til proof-key.pem.
 */
function rotate(db, oldPublicKey, opts = {}) {
  ensureTable(db);
  const now = Number(opts.now) || Date.now();
  let oldId = null;
  if (oldPublicKey) {
    oldId = keyIdOf(oldPublicKey);
    if (!db.prepare('SELECT 1 AS x FROM trusted_keys WHERE key_id = ?').get(oldId)) registerActive(db, oldPublicKey, now);
    db.prepare('UPDATE trusted_keys SET valid_to = COALESCE(valid_to, ?), compromised_from = COALESCE(?, compromised_from), note = ? WHERE key_id = ?')
      .run(now, opts.compromisedFrom != null ? Number(opts.compromisedFrom) : null, opts.compromisedFrom != null ? 'kompromitteret' : 'udskiftet', oldId);
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const newId = keyIdOf(publicKey);
  db.prepare('INSERT INTO trusted_keys (key_id, public_pem, valid_from) VALUES (?,?,?)').run(newId, publicKey.export({ type: 'spki', format: 'pem' }), now);
  return { privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }), oldId, newId };
}

/* ---------------------------------------------------------------- krypteret backup ---------------------------------------------------------------- */
function checkPassphrase(pass) {
  const p = String(pass || '');
  if (p.length < MIN_PASSPHRASE) throw new Error(`BACKUP_PASSPHRASE mangler eller er for kort (mindst ${MIN_PASSPHRASE} tegn).`);
  return p;
}

/** files: [{ name, data: Buffer }] -> én krypteret Buffer. */
function encrypt(files, passphrase, meta = {}) {
  const pass = checkPassphrase(passphrase);
  const manifest = { v: 1, created: Date.now(), keyId: meta.keyId || null, files: files.map(f => ({ name: f.name, size: f.data.length, sha256: crypto.createHash('sha256').update(f.data).digest('hex') })) };
  const mj = Buffer.from(JSON.stringify(manifest), 'utf8');
  const len = Buffer.alloc(4); len.writeUInt32BE(mj.length);
  const plain = Buffer.concat([len, mj, ...files.map(f => f.data)]);
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(pass, salt, 32, SCRYPT);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.concat([MAGIC, salt, iv]));
  const enc = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), enc]);
}

/** Buffer -> { manifest, files: [{ name, data }] }. Forkert adgangsfrase eller ændret fil: fejl. */
function decrypt(buf, passphrase) {
  const pass = checkPassphrase(passphrase);
  if (!Buffer.isBuffer(buf) || buf.length < MAGIC.length + 44 || !buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Filen er ikke en HolyMoly-backup.');
  let o = MAGIC.length;
  const salt = buf.subarray(o, o += 16), iv = buf.subarray(o, o += 12), tag = buf.subarray(o, o += 16);
  const key = crypto.scryptSync(pass, salt, 32, SCRYPT);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAAD(Buffer.concat([MAGIC, salt, iv]));
  d.setAuthTag(tag);
  let plain;
  try { plain = Buffer.concat([d.update(buf.subarray(o)), d.final()]); } catch (e) { throw new Error('Forkert adgangsfrase, eller filen er ændret.'); }
  const n = plain.readUInt32BE(0);
  const manifest = JSON.parse(plain.subarray(4, 4 + n).toString('utf8'));
  const files = [];
  let at = 4 + n;
  for (const f of manifest.files) {
    if (!FILES.includes(f.name)) throw new Error('Ukendt fil i backuppen: ' + f.name);
    const data = plain.subarray(at, at += f.size);
    if (crypto.createHash('sha256').update(data).digest('hex') !== f.sha256) throw new Error('Filen ' + f.name + ' i backuppen er ødelagt.');
    files.push({ name: f.name, data });
  }
  return { manifest, files };
}

module.exports = { ensureTable, keyIdOf, registerActive, canSign, lookup, list, verify, rotate, encrypt, decrypt, checkPassphrase, FILES, MAGIC, MIN_PASSPHRASE };
