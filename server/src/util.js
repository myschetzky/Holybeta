'use strict';
const crypto = require('node:crypto');

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

// Uden 0/O/1/I/L for at undgå forvekslinger når eleven taster koden.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
function inviteCode() {
  const bytes = crypto.randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return s.slice(0, 4) + '-' + s.slice(4);
}
function normalizeCode(c) {
  const s = String(c || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (s.length !== 8) return null;
  return s.slice(0, 4) + '-' + s.slice(4);
}

/*
 * Adgangskoder: scrypt med OWASP's anbefalede styrke (Password Storage Cheat Sheet: N=2^17, r=8, p=1 – eller
 * tilsvarende N=2^14, r=8, p=5, som bruger 16 MiB i stedet for 128 MiB pr. login). Parametrene står i hashen,
 * så de kan skrues op senere; gamle hashes ("scrypt$salt$hash" = N=2^14, r=8, p=1) opgraderes ved næste login.
 */
const SCRYPT = { N: 16384, r: 8, p: 5 };
const SCRYPT_LEGACY = { N: 16384, r: 8, p: 1 };
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, SCRYPT);
  return `scrypt$N=${SCRYPT.N},r=${SCRYPT.r},p=${SCRYPT.p}$` + salt.toString('base64') + '$' + hash.toString('base64');
}
/** Parametre og dele af en gemt hash – eller null. */
function parseHash(stored) {
  const parts = String(stored).split('$');
  if (parts[0] !== 'scrypt') return null;
  if (parts.length === 3) return { params: SCRYPT_LEGACY, salt: parts[1], hash: parts[2] };
  if (parts.length !== 4) return null;
  const m = /^N=(\d+),r=(\d+),p=(\d+)$/.exec(parts[1]);
  if (!m) return null;
  const params = { N: Number(m[1]), r: Number(m[2]), p: Number(m[3]) };
  // Fornuftige grænser (en ødelagt værdi må ikke kunne lægge serveren ned)
  if (params.N < 2 || params.N > 2 ** 20 || (params.N & (params.N - 1)) || params.r < 1 || params.r > 32 || params.p < 1 || params.p > 16) return null;
  return { params, salt: parts[2], hash: parts[3] };
}
function verifyPassword(pw, stored) {
  try {
    const h = parseHash(stored);
    if (!h) return false;
    const expected = Buffer.from(h.hash, 'base64');
    const actual = crypto.scryptSync(pw, Buffer.from(h.salt, 'base64'), expected.length, Object.assign({ maxmem: 256 * 1024 * 1024 }, h.params));
    return crypto.timingSafeEqual(expected, actual);
  } catch (e) {
    return false;
  }
}
/** Er hashen svagere end den nuværende standard? (gemmes igen ved næste rigtige login) */
function needsRehash(stored) {
  const h = parseHash(stored);
  return !h || h.params.N * h.params.r * h.params.p < SCRYPT.N * SCRYPT.r * SCRYPT.p;
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(v); } catch (e) { /* ugyldig kodning – ignorér cookien */ }
  }
  return out;
}

/** Simpel token-bucket rate limiter pr. nøgle (fx IP). */
class RateLimiter {
  constructor(capacity, refillPerSec) {
    this.capacity = capacity;
    this.refill = refillPerSec;
    this.buckets = new Map();
    setInterval(() => {
      const now = Date.now();
      for (const [k, b] of this.buckets) if (now - b.t > 3600_000) this.buckets.delete(k);
    }, 600_000).unref();
  }
  take(key, n = 1) {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b) {
      // Loft på antal nøgler, så mange forskellige (fx opdigtede e-mails) ikke kan fylde hukommelsen
      if (this.buckets.size >= 50_000) this.buckets.delete(this.buckets.keys().next().value);
      b = { tokens: this.capacity, t: now };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(this.capacity, b.tokens + ((now - b.t) / 1000) * this.refill);
    b.t = now;
    if (b.tokens < n) return false;
    b.tokens -= n;
    return true;
  }
  /** Giver forsøget tilbage (fx når en to-faktor-kode var rigtig – kun forkerte forsøg skal tælle). */
  refund(key, n = 1) {
    const b = this.buckets.get(key);
    if (b) b.tokens = Math.min(this.capacity, b.tokens + n);
  }
}

function str(v, max) {
  if (v == null) return '';
  let s = String(v);
  // Fjern kontroltegn
  s = s.replace(/[\u0000-\u001f\u007f]/g, ' ');
  return s.length > max ? s.slice(0, max) : s;
}

function clampNum(v, min, max, dflt) {
  if (v == null || v === '') return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

/* Binære frames: [0x01][uint32 headerLen][header JSON][payload] */
function encodeFrame(header, payload) {
  const h = Buffer.from(JSON.stringify(header), 'utf8');
  const out = Buffer.allocUnsafe(5 + h.length + payload.length);
  out[0] = 1;
  out.writeUInt32BE(h.length, 1);
  h.copy(out, 5);
  payload.copy(out, 5 + h.length);
  return out;
}
function decodeFrame(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 5 || buf[0] !== 1) return null;
  const hl = buf.readUInt32BE(1);
  if (hl > 4096 || 5 + hl > buf.length) return null;
  let header;
  try { header = JSON.parse(buf.subarray(5, 5 + hl).toString('utf8')); } catch (e) { return null; }
  if (!header || typeof header !== 'object') return null;
  return { header, payload: buf.subarray(5 + hl) };
}
function isJpeg(buf) {
  return buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

module.exports = {
  sha256, randomToken, inviteCode, normalizeCode, hashPassword, verifyPassword, needsRehash,
  parseCookies, RateLimiter, str, clampNum, encodeFrame, decodeFrame, isJpeg,
};
