'use strict';
/*
 * To-faktor-login (2FA) med en godkendelses-app (RFC 6238 TOTP: Microsoft/Google Authenticator, 1Password …)
 * + engangs-reservekoder. Hemmeligheden gemmes krypteret (AES-256-GCM) med en nøgle i data-mappen, så en
 * kopi af databasen alene ikke er nok til at lave koder.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) {
    val = (val << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function unbase32(s) {
  const clean = String(s).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, val = 0;
  const out = [];
  for (const ch of clean) {
    val = (val << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

const STEP = 30;
function hotp(key, counter) {
  const c = Buffer.alloc(8);
  c.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(c).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}
const stepNow = (now = Date.now()) => Math.floor(now / 1000 / STEP);

/**
 * Tjekker en 6-cifret kode (±1 tidstrin for urforskel). Returnerer det brugte tidstrin, eller -1.
 * `lastStep`: det senest brugte trin – samme kode kan ikke bruges to gange (genafspilning).
 */
function verify(secretB32, code, lastStep = 0, now = Date.now()) {
  const c = String(code || '').replace(/\D/g, '');
  if (c.length !== 6) return -1;
  const key = unbase32(secretB32);
  const s = stepNow(now);
  for (const d of [0, -1, 1]) {
    const step = s + d;
    if (step <= lastStep) continue;
    const want = hotp(key, step);
    if (crypto.timingSafeEqual(Buffer.from(want), Buffer.from(c))) return step;
  }
  return -1;
}

const newSecret = () => base32(crypto.randomBytes(20));
const otpauthUrl = (secret, account, issuer = 'HolyMoly') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP}`;

/** Reservekoder: 10 stk. à 10 tegn (fx "K7QF-M2XP-9A"), gemt som hash. */
const BC = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
function backupCodes(n = 10) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const b = crypto.randomBytes(10);
    let s = '';
    for (let j = 0; j < 10; j++) s += BC[b[j] % BC.length];
    out.push(s.slice(0, 5) + '-' + s.slice(5));
  }
  return out;
}
const normBackup = (c) => String(c || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
const hashBackup = (c) => crypto.createHash('sha256').update('hm-backup:' + normBackup(c)).digest('hex');

/** Kryptering af hemmeligheden med en nøgle, der ligger i data-mappen (oprettes første gang). */
function secretBox(dataDir) {
  const f = path.join(dataDir, 'totp.key');
  let key;
  try { key = Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'base64'); } catch (e) { /* ny */ }
  if (!key || key.length !== 32) {
    key = crypto.randomBytes(32);
    fs.writeFileSync(f, key.toString('base64'), { mode: 0o600 });
  }
  return {
    seal(text) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
      return 'v1.' + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
    },
    open(sealed) {
      try {
        const b = Buffer.from(String(sealed).replace(/^v1\./, ''), 'base64');
        const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
        d.setAuthTag(b.subarray(12, 28));
        return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
      } catch (e) { return null; }
    },
  };
}

module.exports = { base32, unbase32, hotp, verify, newSecret, otpauthUrl, backupCodes, hashBackup, normBackup, secretBox, stepNow, STEP };
