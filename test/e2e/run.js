'use strict';
/*
 * Ende-til-ende-test på Linux under Xvfb (npm run e2e):
 *  server + den rigtige Electron elev-app + Chromium med HolyMoly-udvidelsen + lærer-dashboardet.
 * Gemmer skærmbilleder i test-results/.
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { chromium, _electron } = require('playwright');
const WebSocket = require(require.resolve('ws', { paths: [path.join(__dirname, '../../server')] }));
const { createServer } = require('../../server/src/index.js');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'test-results');
fs.mkdirSync(OUT, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-e2e-'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const step = (s) => console.log('▶', s);
let failures = 0;
function check(cond, msg) {
  console.log(cond ? '  ✓' : '  ✗', msg);
  if (!cond) failures++;
}
async function until(fn, ms = 10_000, every = 200) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const v = await fn(); if (v) return v; } catch (e) { /* prøv igen */ }
    await sleep(every);
  }
  return null;
}

(async () => {
  // Vindueshåndtering, så "aktivt vindue" findes ligesom på en rigtig computer
  const wm = spawn('openbox', [], { stdio: 'ignore' });
  await sleep(500);

  step('Starter server');
  const srv = createServer({ port: 0, host: '127.0.0.1', dataDir: path.join(tmp, 'data'), signupCode: 'skole', quiet: true, requireGuard: false });
  const port = await srv.listen();
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  const api = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, cookie ? { Cookie: cookie } : {}), body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return r.json();
  };

  // En "proxy-kopi" af Instagram på et ukendt domæne – skal fanges på indholdet
  const fake = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (req.url.startsWith('/insta')) res.end('<html><head><meta property="og:site_name" content="Instagram"><title>Feed</title></head><body><h1>Feed</h1></body></html>');
    else res.end('<html><head><title>Dansk stil</title></head><body><h1>Min danske stil</h1><p>Lorem ipsum.</p></body></html>');
  }).listen(0, '127.0.0.1');
  await new Promise(r => fake.once('listening', r));
  const fakeBase = `http://127.0.0.1:${fake.address().port}`;

  step('Lærer opretter klasse og elever');
  await api('POST', '/api/register', { email: 'mette@skole.dk', name: 'Mette Lærer', password: 'tavle-kridt-hemmelig', signupCode: 'skole' });
  const cls = await api('POST', '/api/classes', { name: '2.g Dansk' });
  const names = ['Anna Jensen', 'Bo Nielsen', 'Clara Holm', 'David Ali', 'Emma Sørensen', 'Frederik Lund', 'Gustav Berg', 'Hannah Krogh', 'Ida Mølgaard', 'Jonas Friis', 'Karla Dam', 'Lucas Bech'];
  const { students } = await api('POST', `/api/classes/${cls.id}/students`, { names });
  check(students.length === names.length, 'elever oprettet med koder');
  const anna = students[0];

  step('Elev-appen startes første gang og spørger om skolens adresse');
  const agentHome = path.join(tmp, 'agent-home');
  const electronApp = await _electron.launch({
    executablePath: path.join(ROOT, 'agent/node_modules/electron/dist/electron'),
    args: [path.join(ROOT, 'agent'), '--no-sandbox'],
    // Den indbyggede adresse peger ingen steder hen – eleven skal skrive skolens adresse (som i den installerede app)
    env: Object.assign({}, process.env, { HM_SERVER_URL: 'http://127.0.0.1:9', HM_TEST_SERVER_SETUP: '1', HM_REQUIRE_EXTENSION: '1', HOME: agentHome, XDG_CONFIG_HOME: path.join(agentHome, '.config') }),
  });
  const agentWin = await electronApp.firstWindow();
  await agentWin.waitForSelector('#server', { state: 'visible' });
  check(!(await agentWin.isVisible('#code')), 'klassekoden spørges der først om, når adressen er sat');
  await agentWin.screenshot({ path: path.join(OUT, '00-elev-app-adresse.png') });
  await agentWin.fill('#server', fakeBase.replace('http://', ''));
  await agentWin.click('#setup-submit');
  const notHm = await until(async () => (await agentWin.isVisible('#setup-error')) && agentWin.textContent('#setup-error'), 15_000);
  check(/ikke en HolyMoly-server/.test(notHm || ''), 'en adresse, der ikke er en HolyMoly-server, afvises: ' + JSON.stringify(notHm));
  await agentWin.fill('#server', 'http://eksempel.dk');
  await agentWin.click('#setup-submit');
  const insecure = await until(async () => { const t = await agentWin.textContent('#setup-error'); return t !== notHm && t; }, 8000);
  check(/https/.test(insecure || ''), 'en adresse uden https afvises: ' + JSON.stringify(insecure));
  await agentWin.fill('#server', base.replace('http://', ''));
  await agentWin.click('#setup-submit');

  step('Eleven taster sin kode');
  await agentWin.waitForSelector('#code', { state: 'visible' });
  check(!(await agentWin.isVisible('#server')), 'adressen er gemt, og skærmen med klassekoden vises');
  await agentWin.screenshot({ path: path.join(OUT, '01-elev-app-kode.png') });
  await agentWin.fill('#code', anna.inviteCode.replace('-', '').toLowerCase());
  await agentWin.click('#enroll-submit');
  await agentWin.waitForSelector('#status', { state: 'visible' });
  const connected = await until(() => agentWin.evaluate(() => document.getElementById('state-text').textContent === 'Forbundet'));
  await agentWin.screenshot({ path: path.join(OUT, '01b-elev-app-forbundet.png') });
  check(connected, 'elev-appen er forbundet');
  check(!(await agentWin.textContent('#state-text')).includes('lektion'), 'ingen lektion – intet overvåges');
  const winVisible = () => electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(w => w.isVisible() && !w.webContents.getURL().includes('freeze')).length > 0);
  check(await until(async () => !(await winVisible()), 10_000), 'elev-appen lægger sig selv ned i proceslinjen når alt er klar');

  step('Andre elever (simuleret) forbinder');
  const fakeAgents = [];
  for (const [i, s] of students.slice(1).entries()) {
    if (i >= 9) break; // et par elever er ikke forbundet -> grå
    const r = await fetch(base + '/api/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: s.inviteCode }) }).then(r => r.json());
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws/agent');
    await new Promise(r => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'hello', tokens: [r.token], device: { os: 'Windows 11', host: 'PC-' + i } }));
    fakeAgents.push({ ws, s, i });
  }

  step('Browser med HolyMoly-udvidelsen startes');
  const browser = await chromium.launchPersistentContext(path.join(tmp, 'chrome-profile'), {
    headless: false, viewport: { width: 1100, height: 700 },
    args: [`--disable-extensions-except=${path.join(ROOT, 'extension')}`, `--load-extension=${path.join(ROOT, 'extension')}`, '--no-first-run', '--window-position=0,0'],
  });
  const page = browser.pages()[0] || await browser.newPage();
  await page.goto(fakeBase + '/stil');
  await sleep(3000); // udvidelsen forbinder til appen

  step('Læreren starter lektionen');
  // Testmiljøets egen arbejdsproces hedder "claude" (står på AI-listen) – tillad den, ellers lukker appen den.
  await api('PATCH', `/api/classes/${cls.id}`, { config: { allowedApps: ['claude'], killApps: true } });
  // Et "spil" der skal lukkes automatisk
  fs.copyFileSync('/bin/sleep', path.join(tmp, 'steam'));
  fs.chmodSync(path.join(tmp, 'steam'), 0o755);
  const game = spawn(path.join(tmp, 'steam'), ['600'], { stdio: 'ignore' });
  let gameExit = null;
  game.on('exit', (code, sig) => { gameExit = sig || code; });
  await api('POST', `/api/classes/${cls.id}/lesson`, { action: 'start', minutes: 45 });
  const live = await until(() => agentWin.evaluate(() => document.getElementById('state-text').textContent.includes('lektion til kl.')));
  check(live, 'elev-appen viser "Forbundet · lektion til kl. …"');
  // Simulerede elever sender status
  const activities = [
    ['docs.google.com – Dansk stil', [], [], '#fff', 'Dansk stil', 'Romantikken var en periode …'],
    ['chatgpt.com – ChatGPT', [{ kind: 'site', text: 'AI / chatbots: chatgpt.com', category: 'ai' }], [], '#212121', 'ChatGPT', 'Skriv en analyse af …'],
    ['lectio.dk – Opgaver', [], [], '#f3f6fb', 'Lectio – Opgaver', 'Aflevering: Dansk stil'],
    ['Microsoft Word – Analyse.docx', [], [], '#fff', 'Analyse.docx', 'Indledning'],
    ['Discord – #general', [{ kind: 'app', text: 'Sociale medier og chat: Discord', category: 'social' }], [], '#313338', '#general', 'lol'],
    ['docs.google.com – Noter', [], [], '#fff', 'Noter', 'Fysik: Newtons love'],
    ['Pages – Stil', [], [{ kind: 'screen', text: 'Mangler tilladelse til skærmoptagelse' }], '#fff', 'Pages', ''],
    ['ordnet.dk – Den Danske Ordbog', [], [], '#fff', 'Den Danske Ordbog', 'romantik'],
    ['lex.dk – Romantikken', [], [], '#fff', 'lex.dk', 'Romantikken'],
  ];
  // Små "skærmbilleder" til de simulerede elevers live-feed
  const shotBrowser = await chromium.launch();
  const shotPage = await shotBrowser.newPage({ viewport: { width: 480, height: 300 } });
  const screens = [];
  for (const [, , , bg, title, body] of activities) {
    const dark = bg === '#212121' || bg === '#313338';
    await shotPage.setContent(`<body style="margin:0;font:14px sans-serif;background:${bg};color:${dark ? '#eee' : '#222'}"><div style="height:28px;background:${dark ? '#111' : '#e8eaed'}"></div><div style="padding:18px"><h2 style="margin:0 0 10px">${title}</h2><p>${body}</p><div style="height:8px;background:${dark ? '#444' : '#ddd'};margin:8px 0;width:80%"></div><div style="height:8px;background:${dark ? '#444' : '#ddd'};margin:8px 0;width:65%"></div></div></body>`);
    screens.push(await shotPage.screenshot({ type: 'jpeg', quality: 70 }));
  }
  await shotBrowser.close();
  const feedFrame = (jpg) => { const h = Buffer.from(JSON.stringify({ kind: 'feed' })); const b = Buffer.alloc(5 + h.length + jpg.length); b[0] = 1; b.writeUInt32BE(h.length, 1); h.copy(b, 5); jpg.copy(b, 5 + h.length); return b; };
  const statusTimer = setInterval(() => {
    for (const a of fakeAgents) {
      const [activity, violations, degraded] = activities[a.i] || ['docs.google.com', [], []];
      if (a.ws.readyState !== 1) continue;
      a.ws.send(JSON.stringify({ type: 'status', activity, violations, degraded }));
      void feedFrame; // ingen billeder uden at læreren klikker
    }
  }, 2000);

  check(await until(() => gameExit !== null, 15_000), 'forbudt program ("steam") lukkes automatisk');

  step('Blokering i browseren');
  const blockedHere = async (url) => {
    try { await page.goto(url, { timeout: 8000 }); } catch (e) { /* redirect afbryder navigationen */ }
    return until(() => page.url().startsWith('chrome-extension://') && page.url().includes('blocked.html'), 8000);
  };
  check(await blockedHere('https://chatgpt.com/'), 'chatgpt.com blokeres');
  await page.screenshot({ path: path.join(OUT, '02-blokeret-side.png') });
  check(await blockedHere('https://chatgpt-com.translate.goog/?_x_tr_sl=en&_x_tr_tl=da'), 'ChatGPT via Google Translate-proxy blokeres');
  check(await blockedHere('https://www.instagram.com/'), 'instagram.com blokeres');
  check(await blockedHere(fakeBase + '/insta'), 'Instagram-kopi på ukendt domæne blokeres (genkendt på indholdet)');
  check(await blockedHere(fakeBase + '/go?u=' + Buffer.from('https://www.tiktok.com/').toString('base64')), 'base64-skjult TikTok-adresse blokeres');
  // En sen omdirigering fra den forrige (blokerede) side kan afbryde navigationen – prøv igen. Bliver siden
  // faktisk blokeret, fanger tjekket nedenfor det.
  for (let i = 0; i < 3; i++) {
    try { await page.goto(fakeBase + '/stil', { timeout: 8000 }); break; } catch (e) { await sleep(700); }
  }
  check(!page.url().includes('blocked.html'), 'almindelig side er ikke blokeret');

  step('Lærer-dashboardet');
  const tb = await chromium.launch();
  const tctx = await tb.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const t = await tctx.newPage();
  await t.goto(base + '/login');
  await t.fill('input[name=email]', 'mette@skole.dk');
  await t.fill('input[name=password]', 'tavle-kridt-hemmelig');
  await t.click('#auth-submit');
  // Første gang: velkomst med vejledning og farver
  await t.waitForSelector('#dlg[open]');
  check(/Sådan kommer eleverne i gang/.test(await t.textContent('#dlg')), 'velkomst med vejledning første gang læreren logger ind');
  await t.click('#dlg-actions button');
  await t.waitForSelector('.class-card');
  await t.click('.class-card');
  await t.waitForSelector('.desk');
  // Ryk bordene ud som et klasseværelse
  await until(() => t.evaluate(() => document.querySelectorAll('.lamp.green').length >= 4), 15_000);
  const annaGreen = await until(() => t.evaluate((id) => {
    const d = document.querySelector(`.desk[data-id="${id}"] .lamp`);
    return d && (d.classList.contains('green') || d.classList.contains('red'));
  }, anna.id), 15_000);
  check(annaGreen, 'Anna (rigtig app) har grøn/rød lampe hos læreren');
  const annaAct = await t.textContent(`.desk[data-id="${anna.id}"] .act`);
  console.log('    Annas aktivitet:', JSON.stringify(annaAct), '| flag:', JSON.stringify(await t.textContent(`.desk[data-id="${anna.id}"] .flag`)));
  check(!/[a-p]{32}/.test(annaAct), 'ingen udvidelses-id i aktiviteten (læreren ser læsbar tekst)');
  check(/Forsøgte|127\.0\.0\.1|Dansk stil|Chromium/i.test(annaAct + (await t.textContent(`.desk[data-id="${anna.id}"] .flag`))), 'aktivitet/forsøg vises under navnet');
  check(await t.evaluate(() => document.querySelectorAll('.lamp.red').length >= 2), 'røde lamper for elever med bekræftet forbudt aktivitet');
  check(await t.evaluate(() => document.querySelectorAll('.lamp.grey').length >= 3), 'grå lamper for ikke-forbundne og for elev uden skærmtilladelse');
  check(await t.evaluate(() => document.querySelectorAll('.lamp.yellow').length === 0), 'ingen andre farver end grøn/rød/grå');
  check(await t.evaluate(() => document.querySelectorAll('.desk img').length === 0), 'ingen skærmbilleder på bordene – kun tekst');
  await sleep(2500);
  await t.screenshot({ path: path.join(OUT, '03-klasseværelse.png') });

  step('Live-skærm, web-log og frys');
  await t.click(`.desk[data-id="${anna.id}"]`);
  const gotFrame = await until(() => t.evaluate(() => { const i = document.getElementById('d-screen'); return i.getAttribute('src') && i.naturalWidth > 0; }), 15_000);
  check(gotFrame, 'live-billede af elevens skærm');
  await page.bringToFront();
  await sleep(2000);
  await t.screenshot({ path: path.join(OUT, '04-live-skaerm.png') });
  await t.click('#d-shot');
  const shotOk = await until(() => t.evaluate(() => [...document.querySelectorAll('#d-body .evidence')].some(i => i.naturalWidth > 0)), 15_000);
  check(shotOk, 'læreren tager et skærmbillede, og det gemmes under Hændelser');
  await t.click('.tabs button[data-tab="web"]');
  await until(() => t.evaluate(() => document.querySelectorAll('#d-body .list li').length > 3), 8000);
  const webLog = await t.textContent('#d-body');
  check(/chatgpt\.com/.test(webLog) && /Blokeret/.test(webLog), 'web-loggen viser blokerede forsøg');
  // Dataminimering: for tilladte sider gemmes kun værtsnavnet – ikke titlen
  check(/127\.0\.0\.1/.test(webLog), 'web-loggen viser besøgte sider (kun værtsnavn)');
  check(!/Dansk stil/.test(webLog), 'web-loggen gemmer ikke titlen på en tilladt side');
  await t.screenshot({ path: path.join(OUT, '05-weblog.png') });
  await t.click('.tabs button[data-tab="alerts"]');
  await sleep(1500);
  await t.screenshot({ path: path.join(OUT, '06-haendelser.png') });

  await t.click('#d-freeze');
  await t.fill('#dlg input', 'Kig op på tavlen');
  await t.click('#dlg-actions .btn.primary');
  const frozenWin = await until(async () => {
    for (const w of electronApp.windows()) if ((await w.url()).includes('freeze.html')) return w;
    return null;
  }, 8000);
  check(!!frozenWin, 'elevens skærm fryses (fuldskærmsvindue)');
  if (frozenWin) {
    await sleep(800);
    check((await frozenWin.textContent('#msg')) === 'Kig op på tavlen', 'lærerens besked vises på den frosne skærm');
    // Den frosne skærm kan ikke ledes væk (som når man trækker en fil/et link ind på den) eller åbne vinduer
    const opened = await frozenWin.evaluate(() => { const w = window.open('https://example.com/'); location.href = 'file:///etc/hostname'; return !!w; }).catch(() => true);
    await sleep(800);
    check(!opened && (await frozenWin.url()).includes('freeze.html'), 'den frosne skærm kan ikke navigeres væk eller åbne vinduer');
  }
  check(await until(() => t.evaluate((id) => document.querySelector(`.desk[data-id="${id}"]`).classList.contains('frozen'), anna.id), 5000), 'læreren ser ❄ på elevens bord');
  await sleep(2500);
  await t.screenshot({ path: path.join(OUT, '07-frosset.png') });
  await t.click('#d-freeze');
  check(await until(async () => !(await Promise.all(electronApp.windows().map(w => w.url()))).some(u => u.includes('freeze.html')), 8000), 'skærmen optøs igen');

  await electronApp.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find(x => !x.webContents.getURL().includes('freeze')); w.show(); });
  await sleep(800);
  await agentWin.screenshot({ path: path.join(OUT, '08-elev-app-lektion.png') });

  step('Et browservindue HolyMoly ikke kan se ind i bliver lukket');
  const sneaky = await chromium.launch({ headless: false, args: ['--window-position=40,40'] });
  const sp = await (await sneaky.newContext({ viewport: { width: 900, height: 600 } })).newPage();
  await sp.goto(fakeBase + '/stil?hemmelig');
  await sp.evaluate(() => { document.title = 'Hemmelig side'; });
  const closed = await until(() => !sneaky.isConnected(), 20_000, 500);
  check(closed, 'det ukendte browservindue blev lukket af HolyMoly');
  if (!closed) await sneaky.close().catch(() => {});
  await page.bringToFront();

  step('Eleven forsøger at afslutte appen midt i lektionen');
  await t.click('#d-close');
  await electronApp.evaluate(({ app }) => app.quit()).catch(() => {});
  await sleep(2000);
  const stillUp = await t.evaluate((id) => !document.querySelector(`.desk[data-id="${id}"] .lamp`).classList.contains('grey'), anna.id);
  check(stillUp, 'appen kan ikke afsluttes i lektionen');

  step('Eleven dræber appen (Jobliste/Aktivitetsovervågning)');
  electronApp.process().kill('SIGKILL');
  const grey = await until(() => t.evaluate((id) => {
    const d = document.querySelector(`.desk[data-id="${id}"]`);
    return d.querySelector('.lamp').classList.contains('grey') && d.querySelector('.act').textContent;
  }, anna.id), 45_000);
  check(grey && /afbrudt|lukkede/.test(grey), 'læreren ser grå lampe + "' + grey + '"');
  await t.screenshot({ path: path.join(OUT, '09-elev-lukkede-app.png') });

  step('Blokeringen fortsætter selv om appen er lukket (til lektionen slutter)');
  check(await blockedHere('https://www.tiktok.com/'), 'tiktok.com blokeres stadig');

  step('Lektionen afsluttes -> alt slukkes');
  await api('POST', `/api/classes/${cls.id}/lesson`, { action: 'stop' });
  clearInterval(statusTimer);

  for (const a of fakeAgents) a.ws.close();
  await browser.close();
  await tb.close();
  await srv.close();
  fake.close();
  wm.kill();
  console.log(failures ? `\n${failures} fejl` : '\nAlle E2E-tjek bestået');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
