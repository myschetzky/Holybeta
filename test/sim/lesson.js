#!/usr/bin/env node
/*
 * Simulerer en hel lektion med en klasse – fra tom klasse til afsluttet lektion – mod en rigtig HolyMoly-server.
 * Læreren styrer det rigtige dashboard i en browser (Playwright). Eleverne er simulerede elev-apps med
 * simulerede HolyMoly-vagter, der signerer deres beskeder præcis som de rigtige (ECDSA P-256).
 *
 *   npm run simulate            ->  tjekliste i terminalen + skærmbilleder i test/sim/out/
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const WebSocket = require(require.resolve('ws', { paths: [path.join(__dirname, '..', '..', 'server')] }));
const { createServer } = require('../../server/src/index.js');
const D = require('../../shared/doc.js');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { console.error('Kræver Playwright'); process.exit(2); }

const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
let failed = 0;
const check = (ok, text) => { console.log(`  ${ok ? '✓' : '✗'} ${text}`); if (!ok) failed++; };
const step = (t) => console.log('\n' + t);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(f, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await f(); if (v) return v; await sleep(100); } return null; }

function eccBlob(publicKey) {
  const jwk = publicKey.export({ format: 'jwk' });
  const blob = Buffer.alloc(72);
  blob.writeUInt32LE(0x31534345, 0); blob.writeUInt32LE(32, 4);
  Buffer.from(jwk.x, 'base64url').copy(blob, 8); Buffer.from(jwk.y, 'base64url').copy(blob, 40);
  return blob.toString('base64');
}

/** En simuleret elev: elev-app (WebSocket) + HolyMoly-vagt (signerede hjertebanker). */
class Student {
  constructor(base, joinCode, name, opts = {}) { Object.assign(this, { base, joinCode, name, opts, msgs: [], activity: opts.activity || 'docs.google.com – Dansk', violations: [], guardExtra: [] }); }
  async join() {
    const r = await fetch(this.base + '/api/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: this.joinCode, name: this.name }) });
    const en = await r.json();
    this.id = en.studentId;
    this.ws = new WebSocket(this.base.replace('http', 'ws') + '/ws/agent');
    this.seen = [];
    this.ws.on('message', (d, bin) => { if (bin) return; const m = JSON.parse(d.toString()); this.msgs.push(m); if (m.type === 'lesson') this.seen.push(m); });
    await new Promise(res => this.ws.on('open', res));
    this.ws.send(JSON.stringify({ type: 'hello', tokens: [en.token], device: { os: this.opts.os || 'Windows 11', host: 'PC-' + this.name.split(' ')[0], version: '1.3.0' } }));
    const w = await until(() => this.msgs.find(m => m.type === 'welcome'));
    this.statusTimer = setInterval(() => this.status(), 2000);
    this.status();
    if (!this.opts.noGuard) {
      this.kp = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      await this.signed('/api/guard/pair', `v=1\ncode=${w.guardPair[this.id]}\npubblob=${eccBlob(this.kp.publicKey)}\nos=windows\nhost=PC\nkeystore=tpm\nguard=1.3.0\n`);
      this.seq = 0;
      await this.beat();
      this.guardTimer = setInterval(() => this.beat(), 3000);
    }
    return this;
  }
  // Vagten overvåger, når den har hørt om lektionen (her: når appen har fået besked)
  inLesson() { const l = [...this.msgs, ...(this.seen || [])].filter(m => m.type === 'lesson').pop(); return !!(l && l.live); }
  status() { if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ type: 'status', activity: this.activity, violations: this.violations, degraded: [] })); }
  send(m) { this.ws.send(JSON.stringify(m)); }
  async signed(p, body) {
    const sig = crypto.sign('sha256', Buffer.from(body), { key: this.kp.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
    const r = await fetch(this.base + p, { method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-HM-Sig': sig, 'X-HM-Sig-Format': 'p1363' }, body });
    return { status: r.status, text: await r.text() };
  }
  beat() {
    this.seq = Math.max(this.seq + 1, Date.now());
    const lines = ['v=1', 'students=' + this.id, 'seq=' + this.seq, 'ts=' + Date.now(), 'os=windows', 'guard=1.3.0', 'keystore=tpm', 'hosts=1', 'policies=1', 'app=1', 'lesson=' + (this.inLesson() ? 1 : 0), ...this.guardExtra];
    return this.signed('/api/guard/beat', lines.join('\n') + '\n').then(r => { this.lastBeat = r; return r; });
  }
  stopGuard() { clearInterval(this.guardTimer); }
  async waitMsg(f, ms) { return until(() => { const m = this.msgs.find(f); if (m) this.msgs.splice(this.msgs.indexOf(m), 1); return m; }, ms); }
  /** Skriver en tekst i "Skriv i HolyMoly" i menneskeligt tempo (gemmer hvert 2. sek.). */
  async write(title, text, { chunk = 28, jumpTo = 0, stats = {} } = {}) {
    const id = crypto.randomUUID();
    const blocks = (t) => [{ t: 'h1', r: [{ x: title }] }, { t: 'p', r: [{ x: t }] }];
    // jumpTo: efter første gemning dukker resten af teksten op på én gang (fx indsat via et andet program)
    for (let n = chunk; ; n = jumpTo ? Math.max(jumpTo, n + chunk) : n + chunk) {
      const t = text.slice(0, Math.min(n, text.length));
      this.send({ type: 'doc', id, title, blocks: blocks(t), stats: Object.assign({ typed: Math.round(t.length * 1.12) + title.length + 2, deleted: Math.round(t.length * 0.1), keystrokes: t.length + 30, maxCps: 5.5, regularity: 0.62 }, stats) });
      await this.waitMsg(m => m.type === 'doc-saved' && m.id === id);
      if (n >= text.length) break;
      await sleep(2000);
    }
    this.send({ type: 'doc-submit', id, force: true }); // "Aflever alligevel": også uden bevis
    const res = await this.waitMsg(m => m.type === 'doc-result' && m.id === id, 15000);
    return { id, res, blocks: blocks(text) };
  }
  close() { clearInterval(this.statusTimer); clearInterval(this.guardTimer); try { this.ws.close(); } catch (e) { /* */ } }
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-sim-'));
  const srv = createServer({ port: 0, host: '127.0.0.1', dataDir, signupCode: 'skole', quiet: true, publicUrl: 'https://holymoly.test', minProofWords: 10 });
  const port = await srv.listen();
  const base = 'http://127.0.0.1:' + port;
  const students = [];
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const shot = (n) => page.screenshot({ path: path.join(OUT, n + '.png') });

    step('1. Læreren opretter sig og en klasse');
    await page.goto(base + '/login');
    await page.click('#signup-foot a');
    await page.waitForSelector('#signup-submit');
    await page.fill('input[name=name]', 'Mette Lærer');
    await page.fill('input[name=email]', 'mette@skole.dk');
    await page.fill('input[name=password]', 'hemmeligt-kodeord');
    await page.fill('input[name=signupCode]', 'skole');
    await page.click('#signup-submit');
    check(!!(await until(() => page.$('#dlg[open]'))), 'velkomst med vejledning første gang');
    await page.click('#dlg-actions button');
    await page.fill('#new-class input[name=name]', '2.g Dansk');
    await page.click('#new-class button');
    await page.waitForSelector('#join-code');
    const joinCode = (await page.textContent('#join-code')).trim();
    check(/^[2-9A-Z]{4}-[2-9A-Z]{4}$/.test(joinCode), `klassen har en klassekode (${joinCode})`);
    check(await page.isVisible('#room-empty'), 'tom klasse viser klassekoden stort');
    await shot('01-tom-klasse');

    step('2. Eleverne tilmelder sig med klassekoden');
    const names = ['Anna Jensen', 'Bo Nielsen', 'Clara Holm', 'David Ali', 'Emma Sørensen', 'Frederik Lund', 'Gustav Berg', 'Hannah Krogh'];
    for (const n of names) students.push(await new Student(base, joinCode, n, n === 'Gustav Berg' ? { os: 'macOS 15', noGuard: true } : {}).join());
    const [anna, bo, clara, david, emma, , gustav, hannah] = students;
    check(!!(await until(async () => (await page.$$('.desk')).length === names.length)), `alle ${names.length} elever står i klasseværelset med det samme`);
    const overlap = await page.evaluate(() => {
      const r = [...document.querySelectorAll('.desk')].map(d => d.getBoundingClientRect());
      return r.some((a, i) => r.some((b, j) => i < j && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom));
    });
    check(!overlap, 'ingen borde overlapper');
    check(await until(async () => (await page.$$('.desk .lamp.idle')).length >= 7), 'før lektionen: grøn ring (forbundet, intet overvåges)');
    await shot('02-elever-tilmeldt');

    step('2b. Lektionens links (lagt ind før timen)');
    await page.click('#menu-btn');
    await page.click('#menu button[data-act=links]');
    await page.waitForSelector('#dlg[open]');
    await page.fill('#dlg-body input[maxlength="80"]', 'Opgave 3 – Romantikken');
    await page.fill('#dlg-body input[type=url]', 'lex.dk/romantikken');
    await page.click('#dlg-actions button:has-text("Tilføj link")');
    check(!!(await until(async () => /lex\.dk\/romantikken/.test(await page.textContent('#dlg-body')))), 'læreren har lagt et link ind til lektionen');
    await page.fill('#dlg-body input[maxlength="80"]', 'Forbudt');
    await page.fill('#dlg-body input[type=url]', 'https://chatgpt.com/');
    await page.click('#dlg-actions button:has-text("Tilføj link")');
    check(!!(await until(async () => /chatgpt\.com er blokeret/.test(await page.textContent('#dlg-body')))), 'læreren får besked, hvis et link er blokeret af reglerne');
    await page.click('#dlg-body li:has-text("chatgpt.com") button:has-text("Fjern")');
    await page.click('#dlg-actions button:has-text("Færdig")');

    step('3. Læreren starter lektionen');
    await page.click('#lesson-btn');
    await page.click('#dlg-actions .btn.primary');
    check(!!(await until(() => anna.msgs.find(m => m.type === 'lesson' && m.live))), 'elev-appen får besked om lektionen');
    check(!!(await until(async () => (await page.$$('.desk .lamp.green')).length >= 6, 10000)), 'eleverne med vagt er grønne');
    const gusText = () => page.evaluate(() => { const d = [...document.querySelectorAll('.desk')].find(x => x.textContent.includes('Gustav')); return d ? d.querySelector('.lamp').className + ' | ' + d.textContent : ''; });
    const gus = await until(async () => { const t = await gusText(); return /grey/.test(t) && /vagten er ikke tilknyttet/.test(t) ? t : null; });
    check(!!gus, 'Mac uden HolyMoly-vagt er grå med årsag (aldrig grøn)' + (gus ? '' : ' – fik: ' + await gusText()));

    step('4. Snyd i timen');
    clara.activity = 'chatgpt.com – ChatGPT';
    clara.violations = [{ kind: 'site', text: 'AI / chatbots: chatgpt.com', category: 'ai' }];
    clara.status();
    david.guardExtra = ['proc=4321\tpython\tpython', 'conn=4321\t104.18.1.1\t443', 'dns=api.openai.com\t104.18.1.1'];
    emma.guardExtra = ['client=9999\t0\tC:\\Users\\emma\\Downloads\\holymoly-groen.exe'];
    bo.guardExtra = ['proc=777\tRobloxPlayerBeta\tRobloxPlayerBeta'];
    await Promise.all([david.beat(), emma.beat(), bo.beat()]);
    check(/kill=777/.test(bo.lastBeat.text), 'vagten får besked på at lukke spillet (Roblox)');
    bo.guardExtra = [];
    hannah.stopGuard();
    const deskText = (n) => page.evaluate((n) => { const d = [...document.querySelectorAll('.desk')].find(x => x.textContent.includes(n)); return d ? (d.querySelector('.lamp').className + ' ' + d.textContent) : ''; }, n);
    check(!!(await until(async () => /red.*chatgpt/.test(await deskText('Clara')))), 'Clara (ChatGPT) er rød med adressen under navnet');
    check(!!(await until(async () => /red.*python bruger AI/.test(await deskText('David')))), 'David (Python mod OpenAI) er rød');
    check(!!(await until(async () => /red.*Falsk HolyMoly-klient/.test(await deskText('Emma')))), 'Emma (falsk HolyMoly-klient) er rød');
    check(!!(await until(async () => /grey.*vagten svarer ikke/.test(await deskText('Hannah')), 35000)), 'Hannah (vagten stoppet) bliver grå');
    await shot('03-snyd-i-timen');

    const lessonMsg = anna.seen.find(m => m.type === 'lesson' && m.live);
    check(!!lessonMsg && lessonMsg.config.links.length === 1 && /lex\.dk/.test(lessonMsg.config.links[0].url), 'elev-appen får lektionens link');

    step('4b. Ræk hånden op');
    anna.send({ type: 'hand', up: true });
    check(!!(await until(async () => (await page.$$('.desk.hand')).length === 1)), 'læreren ser ✋ på Annas bord');
    await shot('03b-haand-op');
    await page.click('.desk:has-text("Anna Jensen")');
    await page.click('#d-hand');
    check(!!(await anna.waitMsg(m => m.type === 'hand' && m.up === false)), 'læreren tager hånden ned – Annas app får besked');
    check(!!(await until(async () => (await page.$$('.desk.hand')).length === 0)), '✋ forsvinder fra bordet');
    await page.click('#d-close');

    step('5. Gennemgang');
    await page.click('#review-btn');
    const rv = await anna.waitMsg(m => m.type === 'freeze' && m.on && m.mode === 'review');
    check(!!rv && rv.endsAt > Date.now(), 'elevernes skærme går på standby med lektionens sluttid');
    check(!!(await until(async () => (await page.textContent('#review-btn')) === 'Afslut gennemgang')), 'knappen hedder nu "Afslut gennemgang"');
    await page.click('#review-btn');
    check(!!(await anna.waitMsg(m => m.type === 'freeze' && !m.on)), 'gennemgangen afsluttes');

    step('6. Skriftlig opgave med skrive-bevis');
    const essay = 'Romantikken var en periode i kunsten omkring år 1800, hvor følelser og naturen fik en stor plads. Digterne søgte det hele og det uendelige, og Oehlenschlägers digt om guldhornene er et af de første danske eksempler.';
    const [ok, cheat] = await Promise.all([
      anna.write('Romantikken', essay),
      clara.write('Novelleanalyse', essay, { chunk: 28, jumpTo: 400 }), // resten på én gang + rød lampe
    ]);
    check(ok.res.ok && !!ok.res.certId, `Anna får et skrive-bevis (HM-${(ok.res.certId || '').slice(0, 8).toUpperCase()})`);
    check(cheat.res.ok && !cheat.res.certId, 'Clara får IKKE et bevis');
    check(/Rød lampe/.test(cheat.res.reasons.join()) && /(allerede|indsat for hurtigt)/.test(cheat.res.reasons.join()), 'begrundelse: rød lampe + tekst der ikke er tastet');
    await page.click('.desk:has-text("Anna Jensen")');
    await page.click('.tabs button[data-tab=docs]');
    await page.waitForSelector('#d-body li.clickable');
    await page.click('#d-body li.clickable');
    check(!!(await until(async () => /Skrive-bevis HM-/.test(await page.textContent('#d-body')))), 'læreren ser Annas dokument og beviset under Dokumenter');
    await shot('04-dokument-med-bevis');
    await page.click('#d-close');
    // Claras dokument: afspil skriveforløbet og lighed med Annas
    await page.click('.desk:has-text("Clara Holm")');
    await page.click('.tabs button[data-tab=docs]');
    await page.waitForSelector('#d-body li.clickable');
    await page.click('#d-body li.clickable');
    check(!!(await until(async () => /Afspil skriveforløbet/.test(await page.textContent('#d-body')))), 'læreren kan afspille skriveforløbet');
    check(!!(await until(async () => /fælles sætningsdele med Anna Jensen/.test(await page.textContent('#d-body')))), 'ligheden med Annas tekst vises (som oplysning)');
    await page.evaluate(() => document.querySelector('.replay-text').scrollIntoView());
    await shot('04b-afspil-og-lighed');
    await page.click('#d-close');

    step('7. Beviset kan tjekkes af alle');
    const proof = await browser.newPage({ viewport: { width: 900, height: 900 } });
    await proof.goto(base + '/bevis/' + ok.res.certId);
    check(!!(await until(async () => /Beviset findes – tjek at teksten passer/.test(await proof.textContent('#verdict').catch(() => '')))), 'tjek-siden siger "Beviset findes – tjek at teksten passer"');
    await proof.click('#check-wrap details summary');
    await proof.fill('#text', 'Romantikken\n' + essay);
    check(!!(await until(async () => /præcis den/.test(await proof.textContent('#match')))), 'den afleverede tekst passer til beviset');
    await proof.screenshot({ path: path.join(OUT, '05-tjek-bevis.png') });
    await proof.fill('#text', 'Romantikken\n' + essay.replace('1800', '1850'));
    check(!!(await until(async () => /ikke den samme/.test(await proof.textContent('#match')))), 'en ændret tekst afsløres');
    const docx = D.toDocx(ok.blocks, { title: 'Romantikken', mark: { code: 'HM-TEST1234', url: 'https://holymoly.test/bevis/x' }, readOnly: true });
    check(docx[0] === 0x50 && docx[1] === 0x4b, 'Word-filen (.docx) kan laves');
    await proof.close();

    step('8. Lektionen slutter');
    await page.click('#lesson-btn');
    await page.click('#dlg-actions .btn.danger');
    check(!!(await until(async () => /Lektionsrapport/.test(await page.textContent('#dlg-title').catch(() => '')))), 'lektionsrapporten åbner, når lektionen slutter');
    check(!!(await until(async () => /Clara Holm[\s\S]*chatgpt/.test(await page.textContent('#dlg-body')))), 'rapporten viser Claras røde tid og årsag');
    await shot('05b-lektionsrapport');
    await page.click('#dlg-actions .btn.primary');
    check(!!(await until(() => anna.msgs.find(m => m.type === 'lesson' && !m.live))), 'elev-appen får besked: lektionen er slut');
    const noRed = await until(async () => (await page.$$('.desk .lamp.red')).length === 0);
    check(!!noRed, 'ingen røde lamper efter lektionen (intet overvåges)' + (noRed ? '' : ' – røde: ' + await page.evaluate(() => [...document.querySelectorAll('.desk')].filter(d => d.querySelector('.lamp.red')).map(d => d.textContent).join(' / '))));
    await shot('06-efter-lektionen');
    const after = await anna.write('Lektier', 'Det her skrives efter timen og må ikke kunne få et bevis.', { chunk: 100 }).catch(() => null);
    check(!after || !after.res || !after.res.certId, 'uden lektion kan der ikke skrives med bevis');
    check(errors.length === 0, 'ingen fejl i dashboardet' + (errors.length ? ': ' + errors.join('; ') : ''));
  } catch (e) {
    console.error(e);
    failed++;
  } finally {
    for (const s of students) s.close();
    await browser.close();
    await srv.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  console.log(failed ? `\n${failed} tjek fejlede` : `\nHele lektionen gennemført – alle tjek bestået. Skærmbilleder: ${path.relative(process.cwd(), OUT)}/`);
  process.exit(failed ? 1 : 0);
})();
