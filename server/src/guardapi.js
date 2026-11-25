'use strict';
/*
 * Serverens side af HolyMoly-vagten (SYSTEM-/root-tjenesten på elevens computer).
 *
 * Vagten taler DIREKTE med serveren – ikke gennem elev-appen – og hver besked er signeret
 * med vagtens egen nøgle (Windows: i computerens TPM-chip, kun brugbar for SYSTEM;
 * Mac: en nøgle kun root kan læse). Elev-programmer kan derfor ikke forfalske vagtens beskeder.
 *
 * Protokol: simple linjer "nøgle=værdi" (let at lave i PowerShell og bash), signeret med ECDSA P-256.
 *
 *   POST /api/guard/pair   (signeret med den nye nøgle – bevis for at vagten har den)
 *     v=1  code=<parringskode>  pub=<SPKI DER base64> | pubblob=<Windows ECCPUBLICBLOB base64>
 *     os=…  host=…  keystore=tpm|software|file
 *   POST /api/guard/beat   header X-HM-Student, X-HM-Sig, X-HM-Sig-Format (der|p1363)
 *     v=1  student=  seq=  ts=  os=  guard=  hosts=0|1  policies=0|1  blockhash=
 *     tamper=<ts>\t<tekst>        (gentages)
 *     proc=<pid>\t<navn>\t<originalt navn>      (kun under lektion)
 *     conn=<pid>\t<ip>\t<port>                 (kun under lektion)
 *     dns=<navn>\t<ip>                         (kun under lektion)
 *     client=<pid>\t<ægte 0|1>\t<sti>          (programmer forbundet til HolyMoly-serveren)
 *     app=<0|1>                                (kører den ægte HolyMoly-app?)
 *   Svar (text/plain):  ok=1  lesson=0|1  until=  next=<sek>  block=<vært>…  blockhash=  kill=<pid>…
 */
const crypto = require('node:crypto');
const { aiConnections } = require('../../shared/netwatch.js');

const MAX_BODY = 512 * 1024;
const KILL_CATEGORIES = new Set(['ai', 'social', 'games', 'video', 'homework', 'remote', 'custom', 'vm']);
const NEVER_KILL = new Set(['explorer', 'finder', 'dock', 'loginwindow', 'systemuiserver', 'windowserver', 'holymoly',
  'holymoly helper', 'electron', 'svchost', 'csrss', 'winlogon', 'lsass', 'services', 'system', 'smss', 'wininit', 'dwm',
  'launchd', 'kernel_task', 'powershell', 'pwsh', 'bash', 'zsh', 'sh']);
const PREFIXES = ['', 'www.', 'm.', 'api.', 'chat.', 'app.', 'web.', 'mobile.', 'login.', 'auth.'];
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function parseLines(text) {
  const out = { _multi: {} };
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\r$/, '');
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    const v = line.slice(i + 1);
    if (['tamper', 'proc', 'conn', 'dns', 'client', 'note'].includes(k)) (out._multi[k] = out._multi[k] || []).push(v);
    else out[k] = v;
  }
  return out;
}

/** Windows' ECCPUBLICBLOB (magic "ECS1", 32 byte X, 32 byte Y) -> SPKI PEM. */
function pemFromEccBlob(buf) {
  if (buf.length !== 72 || buf.readUInt32LE(0) !== 0x31534345 || buf.readUInt32LE(4) !== 32) throw new Error('ugyldig nøgle');
  const jwk = { kty: 'EC', crv: 'P-256', x: buf.subarray(8, 40).toString('base64url'), y: buf.subarray(40, 72).toString('base64url') };
  return crypto.createPublicKey({ key: jwk, format: 'jwk' }).export({ type: 'spki', format: 'pem' });
}

function pemFromSpki(b64) {
  const key = crypto.createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails.namedCurve !== 'prime256v1') throw new Error('kræver P-256');
  return key.export({ type: 'spki', format: 'pem' });
}

function verifySig(pem, body, sigB64, format) {
  try {
    return crypto.verify('sha256', Buffer.from(body), { key: pem, dsaEncoding: format === 'p1363' ? 'ieee-p1363' : 'der' }, Buffer.from(String(sigB64 || ''), 'base64'));
  } catch (e) { return false; }
}

function expandHosts(domains, max = 20000) {
  const out = new Set();
  for (const raw of domains) {
    const d = String(raw || '').toLowerCase().trim().replace(/^\*\./, '').replace(/^www\./, '');
    if (!HOST_RE.test(d) || d.length > 240) continue;
    for (const p of PREFIXES) { if (out.size >= max) break; out.add(p + d); }
  }
  return [...out].sort();
}

/**
 * Vurderer vagtens rapport ud fra klassens regler.
 * Returnerer { violations: [{kind,text}], kill: [pid], procs: n }
 */
function classifyReport(rep, R, opts = {}) {
  const violations = [];
  const kill = [];
  const red = (kind, text) => { if (!violations.some(v => v.text === text)) violations.push({ kind, text, category: kind === 'guard_ai' ? 'ai' : '' }); };
  const procs = new Map();
  for (const line of rep._multi.proc || []) {
    const [pid, name = '', orig = ''] = line.split('\t');
    const n = Number(pid);
    if (n > 0) procs.set(n, { name: name.slice(0, 120), orig: orig.slice(0, 120) });
  }
  // Forbudte programmer: vagten lukker dem (som SYSTEM/root kan den lukke alt)
  const now = opts.now || Date.now();
  const seen = opts.seenForbidden || new Map(); // navn -> første gang set
  const stillRunning = new Set();
  for (const [pid, p] of procs) {
    const key = (p.orig || p.name).toLowerCase().replace(/\.exe$/, '');
    if (!key || NEVER_KILL.has(key) || NEVER_KILL.has(p.name.toLowerCase().replace(/\.exe$/, ''))) continue;
    if (R.browserOf(p.orig) || R.browserOf(p.name)) continue;
    const r = (p.orig && R.classifyApp(p.orig)) || R.classifyApp(p.name);
    if (!r || !r.blocked || !KILL_CATEGORIES.has(r.category)) continue;
    if (opts.killApps !== false) kill.push(pid);
    stillRunning.add(key);
    if (!seen.has(key)) seen.set(key, now);
    // Kører det stadig efter 20 sek, selv om det skulle være lukket = nogen forhindrer HolyMoly i at lukke det
    if (opts.killApps !== false && now - seen.get(key) > 20_000) red('guard_proc', `${r.label}: ${p.orig || p.name} kører trods blokering`);
  }
  for (const k of [...seen.keys()]) if (!stillRunning.has(k)) seen.delete(k);

  // Programmer (ikke browsere) der taler med AI-tjenester. HolyMoly selv taler aldrig med AI, så et program,
  // der blot hedder "holymoly…", er ikke undtaget.
  const net = {
    conns: (rep._multi.conn || []).map(l => l.split('\t')).map(([pid, ip, port]) => [Number(pid), ip, Number(port)]),
    dns: (rep._multi.dns || []).map(l => l.split('\t')).filter(a => a.length >= 2),
  };
  for (const c of aiConnections(net, R)) {
    const p = procs.get(c.pid) || { name: 'proces ' + c.pid, orig: '' };
    if (R.browserOf(p.orig) || R.browserOf(p.name)) continue;
    red('guard_ai', `${p.orig || p.name} bruger AI (${c.host})`);
  }

  // Hvem er forbundet til HolyMoly-serveren?
  let genuine = 0;
  for (const line of rep._multi.client || []) {
    const [pid, ok, path = ''] = line.split('\t');
    const exe = path.split(/[\\/]/).pop().replace(/\.(exe|app)$/i, '');
    if (ok === '1') genuine++;
    // En browser på HolyMoly-serveren er ikke en falsk klient (fx tjek-siden for skrive-beviser eller elev-login)
    else if (R.browserOf(exe) || R.browserOf(path)) continue;
    else red('fake_client', `Falsk HolyMoly-klient: ${path.split(/[\\/]/).pop() || 'proces ' + pid} er forbundet til HolyMoly`);
  }
  if (opts.trayConnected && rep.app === '0') red('fake_client', 'Forbindelsen til HolyMoly kommer ikke fra HolyMoly-appen');

  // hosts=0 (fx antivirus der beskytter hosts-filen) er ikke elevens skyld -> grå, ikke rød (se hub._guardView)
  for (const t of rep._multi.tamper || []) {
    const [ts, text = ''] = t.split('\t');
    if (Number(ts) >= (opts.lessonStarted || 0) && now - Number(ts) < 5 * 60_000) red('guard_tamper', 'Forsøg på at slå HolyMoly fra: ' + text.slice(0, 160));
  }
  return { violations, kill: [...new Set(kill)].slice(0, 200), genuine, seenForbidden: seen };
}

module.exports = { parseLines, pemFromEccBlob, pemFromSpki, verifySig, expandHosts, classifyReport, MAX_BODY };
