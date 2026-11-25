#!/usr/bin/env node
/*
 * HolyMoly-demo: rigtig server på http://localhost:8080 med en klasse af simulerede elever.
 * Hver elev har en simuleret elev-app (WebSocket) og en simuleret vagt der signerer sine beskeder
 * præcis som den rigtige (ECDSA P-256, Windows-format) – så alle lamper og fund kan ses i dashboardet.
 *
 *   npm run demo          ->  log ind som demo@holymoly.dk / demo-kodeord
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const WebSocket = require(require.resolve('ws', { paths: [path.join(__dirname, '..', 'server')] }));
const { createServer } = require('../server/src/index.js');

const PORT = Number(process.env.PORT || 8080);
const BASE = `http://localhost:${PORT}`;
const EMAIL = 'demo@holymoly.dk';
const PASSWORD = 'demo-kodeord';

// Elever og hvad de laver i demoen
const STUDENTS = [
  { name: 'Anna Jensen', activity: 'docs.google.com – Dansk stil' },
  { name: 'Bo Nielsen', activity: 'lectio.dk – Opgaver' },
  { name: 'Clara Holm', activity: 'chatgpt.com – ChatGPT', violations: [{ kind: 'site', text: 'AI / chatbots: chatgpt.com', category: 'ai' }] },
  { name: 'David Ali', activity: 'Microsoft Word – Analyse.docx', guardExtra: ['proc=4321\tpython\tpython', 'conn=4321\t104.18.1.1\t443', 'dns=api.openai.com\t104.18.1.1'] },
  { name: 'Emma Sørensen', activity: 'docs.google.com – Noter', guardExtra: ['client=9999\t0\tC:\\Users\\emma\\Downloads\\holymoly-grøn.exe'] },
  { name: 'Frederik Lund', activity: 'Microsoft Word – Fysikrapport.docx' },
  { name: 'Gustav Berg', activity: 'Pages – Stil', os: 'macOS 15', noGuard: true },
  { name: 'Hannah Krogh', activity: 'ordnet.dk – Den Danske Ordbog', guardStops: true },
  { name: 'Ida Mølgaard', activity: 'GeoGebra Classic 6', guardExtra: ['proc=777\tRobloxPlayerBeta\tRobloxPlayerBeta'] },
  { name: 'Jonas Friis', activity: 'lex.dk – Romantikken' },
  { name: 'Karla Dam', activity: 'docs.google.com – Dansk opgave', joinsLater: 20_000 }, // tilmelder sig selv med klassekoden efter 20 sek.
  { name: 'Lucas Bech', activity: 'docs.google.com – Dansk', tamper: 'hosts-filen blev ændret under lektionen - sat på plads igen' },
];

function eccBlob(publicKey) {
  const jwk = publicKey.export({ format: 'jwk' });
  const blob = Buffer.alloc(72);
  blob.writeUInt32LE(0x31534345, 0); blob.writeUInt32LE(32, 4);
  Buffer.from(jwk.x, 'base64url').copy(blob, 8); Buffer.from(jwk.y, 'base64url').copy(blob, 40);
  return blob.toString('base64');
}

async function signedPost(p, body, privateKey) {
  const sig = crypto.sign('sha256', Buffer.from(body), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-HM-Sig': sig, 'X-HM-Sig-Format': 'p1363' }, body });
  return { status: r.status, text: await r.text() };
}

(async () => {
  const dataDir = process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'holymoly-demo-'));
  const srv = createServer({ port: PORT, host: '127.0.0.1', dataDir, signupCode: 'demo', quiet: true });
  await srv.listen();
  let cookie = '';
  const call = async (method, p, body) => {
    const r = await fetch(BASE + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, cookie ? { Cookie: cookie } : {}), body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return r.json();
  };
  await call('POST', '/api/register', { email: EMAIL, name: 'Mette Lærer', password: PASSWORD, signupCode: 'demo' });
  const cls = await call('POST', '/api/classes', { name: '2.g Dansk' });
  await call('POST', `/api/classes/${cls.id}/lesson`, { action: 'start', minutes: 90 });

  // Eleverne tilmelder sig selv med klassekoden og deres navn (som i appen)
  const join = (name) => fetch(BASE + '/api/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: cls.joinCode, name }) }).then(r => r.json());
  async function student(i, spec) {
    const en = await join(spec.name);
    const st = { id: en.studentId };
    // Elev-appen
    const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws/agent');
    const msgs = [];
    ws.on('message', (d, bin) => { if (!bin) msgs.push(JSON.parse(d.toString())); });
    await new Promise(r => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'hello', tokens: [en.token], device: { os: spec.os || 'Windows 11', host: 'PC-' + (i + 1), version: '1.3.0' } }));
    while (!msgs.find(m => m.type === 'welcome')) await new Promise(r => setTimeout(r, 20));
    const code = msgs.find(m => m.type === 'welcome').guardPair[st.id];
    setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'status', activity: spec.activity, violations: spec.violations || [], degraded: [] })), 2000);
    ws.send(JSON.stringify({ type: 'status', activity: spec.activity, violations: spec.violations || [], degraded: [] }));
    if (spec.noGuard) return;
    // Vagten: parring + signerede hjertebanker
    const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    await signedPost('/api/guard/pair', `v=1\ncode=${code}\npubblob=${eccBlob(kp.publicKey)}\nos=windows\nhost=PC-${i + 1}\nkeystore=tpm\nguard=1.3.0\n`, kp.privateKey);
    let seq = 0;
    const beat = () => {
      const lines = ['v=1', 'students=' + st.id, 'seq=' + Math.max(++seq, Date.now()), 'ts=' + Date.now(), 'os=windows', 'guard=1.3.0', 'keystore=tpm', 'hosts=1', 'policies=1', 'app=1', 'lesson=1'];
      if (spec.tamper) lines.push(`tamper=${Date.now() - 10_000}\t${spec.tamper}`);
      lines.push(...(spec.guardExtra || []));
      seq = Number(lines[2].slice(4));
      return signedPost('/api/guard/beat', lines.join('\n') + '\n', kp.privateKey);
    };
    await beat();
    const t = setInterval(beat, 3000);
    if (spec.guardStops) setTimeout(() => clearInterval(t), 4000);
  }
  for (const [i, spec] of STUDENTS.entries()) {
    if (spec.joinsLater) setTimeout(() => student(i, spec).catch(console.error), spec.joinsLater);
    else await student(i, spec);
  }
  console.log(`\nHolyMoly-demo kører på ${BASE}\n  Log ind: ${EMAIL} / ${PASSWORD}\n  Klassekode: ${cls.joinCode} (Karla Dam tilmelder sig selv om 20 sek.)\n  (data: ${dataDir})\n`);
})().catch((e) => { console.error(e); process.exit(1); });
