'use strict';
/*
 * Unilogin (STIL's "Unilogin Broker") via OpenID Connect – Authorization Code Flow med PKCE (S256), fortrolig klient.
 * Se docs/UNILOGIN.md for tilslutningen hos STIL (udbyder, tilslutningsaftale, dataaftaler, priser).
 *
 * Brokeren (produktion): https://broker.unilogin.dk/auth/realms/broker  (OIO OIDC, Keycloak)
 *   - id_token: sub, uniid, aktoer_gruppe, institution_ids, unilogin_loa (ingen e-mail)
 *   - userinfo: inst_brugere [{ instnr, instnavn, (roller / ansat_roller / elev_roller ...) }]
 *     Navn og roller kun med en dataaftale med den enkelte skole ("udvidet brugerinformation").
 *
 * Miljøvariabler:
 *   UNILOGIN_ISSUER         standard https://broker.unilogin.dk/auth/realms/broker
 *   UNILOGIN_CLIENT_ID      klient-id fra udbyderportal.stil.dk
 *   UNILOGIN_CLIENT_SECRET  klient-hemmelighed
 *   UNILOGIN_REDIRECT_URI   https://<jeres domæne>/api/auth/unilogin/callback (registreret hos STIL)
 *   UNILOGIN_SCOPE          standard "openid" (brokeren styrer selv, hvilke claims klienten får)
 *   UNILOGIN_ROLE_CLAIM     claim med brugertypen, standard "aktoer_gruppe"
 *   UNILOGIN_TEACHER_ROLES  hvilke roller/brugertyper der er lærere (regex)
 *   UNILOGIN_ID_CLAIM       claim med UNI-ID, standard "uniid"
 *   UNILOGIN_ACR            valgfrit sikringsniveau, fx "https://data.gov.dk/concept/core/nsis/loa/Substantial"
 *
 * Alt der kommer tilbage, tjekkes: state (engangs), PKCE, nonce, id_token-signatur (JWKS), issuer, audience og udløb.
 */
const crypto = require('node:crypto');

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function configFromEnv(env = process.env) {
  const c = {
    issuer: String(env.UNILOGIN_ISSUER || 'https://broker.unilogin.dk/auth/realms/broker').replace(/\/+$/, ''),
    clientId: String(env.UNILOGIN_CLIENT_ID || ''),
    clientSecret: String(env.UNILOGIN_CLIENT_SECRET || ''),
    redirectUri: String(env.UNILOGIN_REDIRECT_URI || ''),
    scope: String(env.UNILOGIN_SCOPE || 'openid'),
    roleClaim: String(env.UNILOGIN_ROLE_CLAIM || 'aktoer_gruppe'),
    teacherRoles: new RegExp(env.UNILOGIN_TEACHER_ROLES || 'l(æ|ae)rer|teacher|p(æ|ae)dagog|ansat|medarbejder|employee|staff', 'i'),
    idClaim: String(env.UNILOGIN_ID_CLAIM || 'uniid'),
    acr: String(env.UNILOGIN_ACR || ''),
  };
  c.enabled = !!(c.issuer && c.clientId && c.redirectUri);
  return c;
}

class UniLogin {
  constructor(cfg, opts = {}) {
    this.cfg = cfg;
    this.fetch = opts.fetch || globalThis.fetch;
    this.meta = null;
    this.metaAt = 0;
    this.jwks = null;
    this.jwksAt = 0;
    this.pending = new Map(); // state -> { verifier, nonce, role, app, exp }
  }

  get enabled() { return this.cfg.enabled; }

  async metadata() {
    if (this.meta && Date.now() - this.metaAt < 3600_000) return this.meta;
    const r = await this.fetch(this.cfg.issuer + '/.well-known/openid-configuration');
    if (!r.ok) throw new Error('UNI-Login svarer ikke (metadata ' + r.status + ')');
    const m = await r.json();
    if (String(m.issuer).replace(/\/+$/, '') !== this.cfg.issuer) throw new Error('UNI-Login: forkert issuer i metadata');
    for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) if (!/^https:\/\//.test(m[k] || '') && !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(m[k] || '')) throw new Error('UNI-Login: usikker adresse i metadata');
    this.meta = m;
    this.metaAt = Date.now();
    return m;
  }

  async keys(force) {
    if (!force && this.jwks && Date.now() - this.jwksAt < 3600_000) return this.jwks;
    const m = await this.metadata();
    const r = await this.fetch(m.jwks_uri);
    if (!r.ok) throw new Error('UNI-Login: kan ikke hente nøgler');
    this.jwks = (await r.json()).keys || [];
    this.jwksAt = Date.now();
    return this.jwks;
  }

  /**
   * Starter login. Returnerer { url, state }: url er adressen brugeren sendes til.
   * extra gemmes sammen med forsøget (fx elev-appens lokale port) og gives tilbage af finish().
   */
  async start(role, extra = {}) {
    const m = await this.metadata();
    const state = b64url(crypto.randomBytes(24));
    const nonce = b64url(crypto.randomBytes(24));
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    // Rydder gamle forsøg op og begrænser antallet
    const now = Date.now();
    for (const [k, v] of this.pending) if (v.exp < now) this.pending.delete(k);
    // Mange samtidige forsøg: de ældste smides ud (i stedet for at lukke for alle logins)
    while (this.pending.size >= 5000) this.pending.delete(this.pending.keys().next().value);
    this.pending.set(state, Object.assign({}, extra, { verifier, nonce, role, exp: now + 10 * 60_000 }));
    const u = new URL(m.authorization_endpoint);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', this.cfg.clientId);
    u.searchParams.set('redirect_uri', this.cfg.redirectUri);
    u.searchParams.set('scope', this.cfg.scope);
    u.searchParams.set('state', state);
    u.searchParams.set('nonce', nonce);
    u.searchParams.set('code_challenge', challenge);
    u.searchParams.set('code_challenge_method', 'S256');
    if (this.cfg.acr) u.searchParams.set('acr_values', this.cfg.acr);
    return { url: u.toString(), state };
  }

  /** Afslutter login: tjekker alt og returnerer { role, app, uniId, name, roles } */
  async finish(code, state) {
    const p = this.pending.get(String(state || ''));
    this.pending.delete(String(state || '')); // engangs
    if (!p || p.exp < Date.now()) throw new Error('Login-forsøget er udløbet – prøv igen');
    if (!code) throw new Error('UNI-Login afbrudt');
    const m = await this.metadata();
    const body = new URLSearchParams({ grant_type: 'authorization_code', code: String(code), redirect_uri: this.cfg.redirectUri, code_verifier: p.verifier, client_id: this.cfg.clientId });
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    if (this.cfg.clientSecret) headers.Authorization = 'Basic ' + Buffer.from(encodeURIComponent(this.cfg.clientId) + ':' + encodeURIComponent(this.cfg.clientSecret)).toString('base64');
    const r = await this.fetch(m.token_endpoint, { method: 'POST', headers, body });
    const tok = await r.json().catch(() => ({}));
    if (!r.ok || !tok.id_token) throw new Error('UNI-Login: login kunne ikke bekræftes');
    const claims = await this.verifyIdToken(tok.id_token, p.nonce);
    const uniId = String(claims[this.cfg.idClaim] || claims.sub || '').slice(0, 200);
    if (!uniId) throw new Error('UNI-Login: mangler bruger-id');
    // Institutioner (og evt. navn og roller) fra userinfo – brokeren giver instnr/instnavn uden dataaftale
    const info = await this.userinfo(m, tok.access_token, claims.sub);
    const pick = (o) => String(o.name || [o.given_name, o.family_name].filter(Boolean).join(' ') || '').trim();
    const name = (pick(claims) || pick(info)).slice(0, 80);
    const arr = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);
    const str = (x) => (typeof x === 'string' ? x : JSON.stringify(x));
    const roles = arr(this.cfg.roleClaim ? (claims[this.cfg.roleClaim] ?? info[this.cfg.roleClaim]) : null).map(str);
    const institutions = new Map();
    for (const nr of arr(claims.institution_ids ?? info.institution_ids)) institutions.set(String(nr), { nr: String(nr), name: '', roles: [] });
    for (const ib of arr(info.inst_brugere ?? info.instbrugere ?? info['dk:unilogin:instbrugere'])) {
      if (!ib || typeof ib !== 'object') continue;
      const nr = String(ib.instnr ?? ib.inTnr ?? '').slice(0, 20);
      if (!nr) continue;
      const r = [...arr(ib.roller), ...arr(ib.ansat_roller), ...arr(ib.elev_roller), ...arr(ib.ekstern_roller)].map(str).slice(0, 20);
      institutions.set(nr, { nr, name: String(ib.instnavn ?? ib.inTnavn ?? '').slice(0, 120), roles: r });
      roles.push(...r);
    }
    return {
      role: p.role, app: p.app || '', port: p.port || 0, linkTo: p.linkTo || null, uniId, name, roles,
      isTeacher: roles.some(x => this.cfg.teacherRoles.test(x)),
      institutions: [...institutions.values()].filter(i => /^[0-9A-Za-z]{1,20}$/.test(i.nr)).slice(0, 20),
      loa: String(claims.unilogin_loa || claims.acr || ''),
    };
  }

  /** Userinfo fra brokeren (institutioner m.m.). Fejler den, fortsætter login med det, id_token gav. */
  async userinfo(m, accessToken, sub) {
    if (!m.userinfo_endpoint || !accessToken) return {};
    try {
      const r = await this.fetch(m.userinfo_endpoint, { headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/json' } });
      if (!r.ok) return {};
      const ct = String((r.headers && r.headers.get && r.headers.get('content-type')) || '');
      if (!/json/.test(ct)) return {}; // signeret userinfo (JWT) understøttes ikke – bed om JSON i udbyderportalen
      const u = await r.json();
      if (!u || typeof u !== 'object' || (u.sub && sub && u.sub !== sub)) return {};
      return u;
    } catch (e) { return {}; }
  }

  async verifyIdToken(jwt, nonce) {
    const parts = String(jwt).split('.');
    if (parts.length !== 3) throw new Error('UNI-Login: ugyldigt id_token');
    let header, claims;
    try { header = JSON.parse(Buffer.from(parts[0], 'base64url')); claims = JSON.parse(Buffer.from(parts[1], 'base64url')); } catch (e) { throw new Error('UNI-Login: ugyldigt id_token'); }
    const algs = { RS256: ['sha256', null], PS256: ['sha256', 'pss'], ES256: ['sha256', 'ec'] };
    if (!algs[header.alg]) throw new Error('UNI-Login: ukendt signatur-algoritme');
    const pick = (keys) => keys.find(k => (!header.kid || k.kid === header.kid) && (!k.use || k.use === 'sig'));
    let jwk = pick(await this.keys());
    if (!jwk) jwk = pick(await this.keys(true)); // nøgle-rotation
    if (!jwk) throw new Error('UNI-Login: ukendt nøgle');
    const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    const data = Buffer.from(parts[0] + '.' + parts[1]);
    const sig = Buffer.from(parts[2], 'base64url');
    const opts = header.alg === 'PS256' ? { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }
      : header.alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key;
    if (!crypto.verify('sha256', data, opts, sig)) throw new Error('UNI-Login: forkert signatur');
    const now = Math.floor(Date.now() / 1000);
    if (String(claims.iss).replace(/\/+$/, '') !== this.cfg.issuer) throw new Error('UNI-Login: forkert udsteder');
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(this.cfg.clientId)) throw new Error('UNI-Login: forkert modtager');
    if (!(claims.exp > now - 60)) throw new Error('UNI-Login: login er udløbet');
    if (claims.nbf && claims.nbf > now + 60) throw new Error('UNI-Login: login er ikke gyldigt endnu');
    if (claims.nonce !== nonce) throw new Error('UNI-Login: forkert nonce');
    return claims;
  }
}

module.exports = { UniLogin, configFromEnv };
