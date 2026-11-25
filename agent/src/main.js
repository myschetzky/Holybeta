'use strict';
/*
 * HolyMoly elev-app.
 *
 * Princip: Intet overvåges, før læreren har startet en lektion OG appen er åben.
 * Lukker eleven appen i en lektion, ser læreren en grå lampe med besked om det.
 */
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, net, dialog, Notification, systemPreferences, powerMonitor } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const ACRules = require('./rules.js');
const store = require('./store');
const { Connection } = require('./connection');
const { Monitor, killProcess, closeApp, macRedirect } = require('./monitor');
const { Bridge } = require('./bridge');
const { Policy, colorOf } = require('./policy');
const { aiConnections } = require('./netwatch');
const macfilter = require('./macfilter');
const guard = require('./guard');
const { Streamer, screenPermission, screenCount, captureWorks } = require('./capture');
const { Freezer } = require('./freeze');
const { Writer } = require('./writer');
const verified = require('./verified');
const { homeEvent, homeStatus } = require('./homepolicy');
const { createWordMode } = require('./word/app');
let writer = null; // "Skriv i HolyMoly"
let word = null;   // "Skriv i Word" og "Min HolyMoly" (agent/src/word)

// Startet med fejlfinding (fx --remote-debugging-port)? Så kunne et andet program taste i skrivevinduet. Luk.
// Gælder den installerede app. Under udvikling starter ende-til-ende-testen (Playwright) appen med disse flag.
{
  const { debugFlagsUsed, MESSAGE } = require('./debugflags');
  if (app.isPackaged && debugFlagsUsed(process.argv, (s) => app.commandLine.hasSwitch(s))) {
    try { dialog.showErrorBox('HolyMoly', MESSAGE); } catch (e) { /* */ }
    app.exit(1);
    process.exit(1);
  }
}

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

/*
 * Electron-sikkerhed for ALLE vinduer (også dem, der kommer senere): ingen navigation væk fra appens egne sider
 * (fx ved at trække en fil eller et link ind på den frosne skærm – så kunne eleven læse noter i fuld skærm),
 * ingen nye vinduer, ingen <webview>, og ingen tilladelser (kamera, mikrofon, placering, notifikationer …).
 * Appens sider indlæses af hovedprocessen med loadFile – det udløser ikke 'will-navigate'.
 */
app.on('web-contents-created', (_e, wc) => {
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e) => e.preventDefault());
  wc.on('will-redirect', (e) => e.preventDefault());
  wc.on('will-attach-webview', (e) => e.preventDefault());
});
app.whenReady().then(() => {
  const { session } = require('electron');
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
});

/* ---------------- konfiguration ---------------- */
const CONFIG = (() => {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8')); } catch (e) { /* */ }
  // Kun under udvikling: i den færdige app kan eleven ikke pege appen mod en falsk server.
  if (process.env.HM_SERVER_URL && !app.isPackaged) c.serverUrl = process.env.HM_SERVER_URL;
  return c;
})();
function serverUrlOk(u) {
  try {
    const url = new URL(u);
    if (url.protocol === 'https:') return true;
    if (url.protocol === 'http:' && (['localhost', '127.0.0.1', '::1'].includes(url.hostname) || (process.env.HM_ALLOW_INSECURE === '1' && !app.isPackaged))) return true;
  } catch (e) { /* */ }
  return false;
}
/*
 * Serverens adresse – i denne rækkefølge:
 *  1. Sat af skolens IT eller ved første opsætning: ProgramData\HolyMoly\server.txt (Windows) /
 *     /Library/Application Support/HolyMoly/server.txt (Mac). Kun administrator/vagten kan skrive den.
 *  2. Indbygget i appen (agent/config.json, fx den hostede HolyMoly).
 *  3. Ingen? Så spørger appen første gang (kun i den installerede app, når den indbyggede er localhost).
 */
const SERVER_RE = /^(https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?|http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?)$/;
const MACHINE_SERVER_FILE = process.platform === 'win32' ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'HolyMoly', 'server.txt')
  : process.platform === 'darwin' ? '/Library/Application Support/HolyMoly/server.txt' : '';
function normServer(s) {
  let t = String(s || '').trim().toLowerCase().replace(/\/+$/, '');
  // "holymoly.minskole.dk" er nok; "localhost:8080" (test på samme computer) bruger http
  if (t && !/^[a-z]+:\/\//.test(t)) t = (/^(localhost|127\.0\.0\.1)(:|$)/.test(t) ? 'http://' : 'https://') + t;
  try { const u = new URL(t); t = u.origin; } catch (e) { return ''; }
  return SERVER_RE.test(t) ? t : '';
}
function machineServer() {
  try { return MACHINE_SERVER_FILE ? normServer(fs.readFileSync(MACHINE_SERVER_FILE, 'utf8').split(/\r?\n/)[0]) : ''; } catch (e) { return ''; }
}
const BUILT_SERVER = CONFIG.serverUrl || 'http://localhost:8080';
const BUILT_IS_REAL = /^https:\/\//.test(BUILT_SERVER);
let SERVER_URL = machineServer() || BUILT_SERVER;
// Den installerede app uden rigtig server: eleven/IT skriver skolens adresse første gang
const needsServerSetup = () => (app.isPackaged && !BUILT_IS_REAL && !machineServer() && !CONFIG.allowLocalhost)
  // Kun under udvikling/test (ende-til-ende-testen): vis opsætningen, selvom appen ikke er installeret
  || (!app.isPackaged && process.env.HM_TEST_SERVER_SETUP === '1');
// I den installerede app (Windows/Mac) styres HolyMoly af vagten: altid i proceslinjen, kan ikke afsluttes.
const GUARD_MANAGED = app.isPackaged && (process.platform === 'win32' || process.platform === 'darwin') && CONFIG.requireGuard !== false;
const STARTED_FROM_TRAY = process.argv.includes('--tray');

/* ---------------- tilstand ---------------- */
const state = {
  data: { enrollments: [] },
  lesson: null, // {live, className, studentName, teacherName, endsAt, config, solo}
  home: false, // skriveøkt hjemme: ingen adresser, programmer, faner eller skærmbilleder sendes
  rules: ACRules.RULE_DATA,
  watching: false,
  frozen: false,
  freezeMsg: '',
  lastStatus: null,
  lastStatusSent: 0,
  lastDetailSent: 0,
  lastDetailKey: '',
  violationKeys: new Set(),
  lastEvidence: 0,
  lastAppEvent: { key: '', ts: 0 },
  pendingApp: null,
  monitorBroken: false,
  error: '',
};

let win = null;
let tray = null;
let conn = null;
let quitting = false;
const monitor = new Monitor();
const peer = require('./peer');
const BASE_RULES = ACRules.compile();
const bridge = new Bridge({
  allowedIds: CONFIG.extensionIds || [],
  identifyPeer: peer.identifyPeer,
  // Browseren afgøres af processen (originalt filnavn / .app-navn), ikke af hvad udvidelsen påstår
  browserOfProc: (p) => BASE_RULES.browserOf(p.orig) || BASE_RULES.browserOf(p.name),
});
const policy = new Policy();
const freezer = new Freezer();
// Mac: netværksfilteret (systemudvidelse) – ser hvilket program der taler med hvilket værtsnavn
const macFilter = process.platform === 'darwin' ? new macfilter.MacFilter({ log: (m) => console.log(m) }) : null;
let streamer = null;
let evalTimer = null;
let captureTimer = null;

/* ---------------- UI ---------------- */
/** Det eleven skal ordne, før HolyMoly virker (vises som en kort tjekliste). */
function computeNeeds() {
  const needs = [];
  if (state.updateRequired) {
    needs.push({ id: 'update', text: 'HolyMoly skal opdateres', actions: state.downloadUrl ? [{ id: 'download', label: 'Hent opdatering' }] : [] });
  }
  if ((GUARD_MANAGED || guard.installed()) && !(guard.readStatus() || {}).fresh) {
    needs.push({ id: 'guard', text: 'HolyMoly-vagten kører ikke – genstart computeren eller geninstallér HolyMoly', actions: state.downloadUrl ? [{ id: 'download', label: 'Hent HolyMoly' }] : [] });
  }
  const osIssue = osTooOld();
  if (osIssue) needs.push({ id: 'os', text: osIssue, actions: [] });
  const exts = bridge.live();
  if (process.platform === 'win32' && !exts.length) {
    needs.push({ id: 'ext', text: 'Installer HolyMoly i din browser', actions: [{ id: 'ext:chrome', label: 'Chrome' }, { id: 'ext:edge', label: 'Edge' }, { id: 'ext:firefox', label: 'Firefox' }] });
  }
  if (state.minExtensionVersion && exts.some(c => versionLt(c.version, state.minExtensionVersion))) {
    needs.push({ id: 'ext-update', text: 'Browser-udvidelsen skal opdateres (genstart browseren)', actions: [] });
  }
  if (process.platform === 'darwin') {
    if (!screenPermission()) needs.push({ id: 'perm-screen', text: 'Giv adgang til skærmoptagelse', actions: [{ id: 'mac:screen', label: 'Åbn' }] });
    if (!accessibilityOk()) needs.push({ id: 'perm-access', text: 'Giv adgang under Hjælpefunktioner', actions: [{ id: 'mac:accessibility', label: 'Åbn' }] });
    if (monitor.automationDenied.size) needs.push({ id: 'perm-auto', text: 'Giv adgang under Automatisering (browsere)', actions: [{ id: 'mac:automation', label: 'Åbn' }] });
    if (macFilter && CONFIG.requireMacFilter && macFilter.state !== 'ok') {
      needs.push(state.filterBusy
        ? { id: 'mac-filter', text: state.filterMsg || 'Slår netværksfilteret til…', actions: state.filterApproval ? [{ id: 'mac:extensions', label: 'Åbn indstillinger' }] : [] }
        : { id: 'mac-filter', text: state.filterMsg || 'Slå HolyMoly-netværksfilteret til', actions: [{ id: 'mac:filter', label: 'Slå til' }] });
    }
  }
  if (state.lastStatus && state.lastStatus.degraded) {
    for (const d of state.lastStatus.degraded) {
      if (['screen', 'accessibility', 'automation', 'extension_update', 'mac_filter', 'guard'].includes(d.kind)) continue; // vist ovenfor
      needs.push({ id: 'deg:' + d.kind, text: d.text, actions: [] });
    }
  }
  return needs;
}

function osTooOld() {
  const rel = os.release().split('.').map(Number);
  if (process.platform === 'win32' && rel[0] === 10 && (rel[2] || 0) < 19041) return 'Windows skal opdateres (Windows 10 version 2004 eller nyere)';
  if (process.platform === 'darwin' && rel[0] < 21) return 'macOS skal opdateres (macOS 12 eller nyere)';
  return '';
}

function versionLt(a, b) {
  const pa = String(a || '0').split('.').map(Number);
  const pb = String(b || '0').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x < y;
  }
  return false;
}

function uiState() {
  const live = lessonActive();
  return {
    serverSetup: !!state.serverSetup,
    serverHost: (() => { try { return new URL(SERVER_URL).host; } catch (e) { return ''; } })(),
    enrollments: state.data.enrollments.map(e => ({ className: e.className, studentName: e.studentName, teacherName: e.teacherName })),
    conn: conn ? conn.state : 'offline',
    lesson: live ? { className: state.lesson.className, endsAt: state.lesson.endsAt } : null,
    needs: state.data.enrollments.length ? computeNeeds() : [],
    error: state.error,
    version: app.getVersion(),
    hand: live && !!state.hand,
    // "Lektionens links" fra læreren (kun under lektionen)
    links: live ? linksOf(state.lesson).map(l => ({ title: l.title, host: hostOf(l.url) })) : [],
    // Afleveringer fra læreren, som eleven mangler at aflevere
    assignmentsOpen: writer ? writer.openCount() : 0,
    // "Skriv i Word": kun når broen siger supported og Word findes
    word: !!state.wordAvailable,
  };
}
function linksOf(lesson) {
  const list = lesson && lesson.config && Array.isArray(lesson.config.links) ? lesson.config.links : [];
  return list.filter(l => l && typeof l.url === 'string' && /^https?:\/\//i.test(l.url)).slice(0, 20)
    .map(l => ({ title: String(l.title || '').slice(0, 80), url: l.url }));
}
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } }

/* "Ræk hånden op": eleven beder om hjælp – læreren ser ✋ på bordet. */
function setHand(up) {
  up = !!up && lessonActive();
  if (state.hand === up) return;
  state.hand = up;
  if (conn) conn.send({ type: 'hand', up });
  updateTrayMenu();
  pushUi();
}

/* Når alt er klar, lægger vinduet sig selv ned i proceslinjen/menulinjen. */
let autoHidden = false;
let userOpenedAt = 0;
function maybeAutoHide() {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  const s = uiState();
  const ready = s.enrollments.length && s.conn === 'online' && !s.needs.length;
  // Afleveringssiden er åben: eleven er i gang, så vinduet bliver
  if (!ready || Date.now() - userOpenedAt < 15_000 || state.assignmentsPage) return;
  if (autoHidden) return;
  autoHidden = true;
  setTimeout(() => {
    const s2 = uiState();
    if (s2.conn === 'online' && !s2.needs.length && win && !win.isDestroyed() && Date.now() - userOpenedAt >= 15_000 && !state.assignmentsPage) win.hide();
  }, 2500);
}
function pushUi() {
  if (win && !win.isDestroyed()) win.webContents.send('state', uiState());
  updateTray();
  const s = uiState();
  // Mangler noget, vises vinduet igen så eleven kan ordne det
  if (s.enrollments.length && s.needs.length && win && !win.isDestroyed() && !win.isVisible()) { autoHidden = false; win.show(); }
  if (!s.needs.length) maybeAutoHide(); else autoHidden = false;
}

function createWindow() {
  win = new BrowserWindow({
    width: 380, height: 420, minWidth: 340, minHeight: 360, show: false, title: 'HolyMoly',
    backgroundColor: '#f4f5f7', autoHideMenuBar: true, maximizable: false, fullscreenable: false,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, devTools: !app.isPackaged },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    // Startet af opstarten/vagten: vis kun vinduet hvis noget mangler
    const s = uiState();
    if (STARTED_FROM_TRAY && !createWindow.shown && s.enrollments.length && !s.needs.length) { createWindow.shown = true; return; }
    createWindow.shown = true;
    win.show();
  });
  win.on('close', (e) => {
    if (quitting) return;
    // Lukker kun vinduet – appen kører videre i proceslinjen/menulinjen.
    e.preventDefault();
    win.hide();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function trayImage(color) {
  const colors = { green: '#16a34a', grey: '#9ca3af', red: '#dc2626', blue: '#2f5bea' };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><path d="M16 3l11 4v8c0 7-4.6 12.6-11 15-6.4-2.4-11-8-11-15V7z" fill="${colors[color] || colors.grey}"/></svg>`;
  return nativeImage.createFromDataURL('data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')).resize({ width: 18, height: 18 });
}
function updateTray() {
  if (!tray) return;
  const live = lessonActive();
  const color = !live ? 'grey' : ((state.lastStatus && state.lastStatus.color) || 'green');
  try { tray.setImage(trayImage(color)); } catch (e) { /* nogle platforme understøtter ikke SVG */ }
  tray.setToolTip(live ? `HolyMoly – lektion i gang (${state.lesson.className})${state.watching ? ' – læreren ser din skærm' : ''}` : 'HolyMoly – ingen lektion');
}
function createTray() {
  try {
    tray = new Tray(trayImage('grey'));
  } catch (e) {
    try { tray = new Tray(nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png')).resize({ width: 18, height: 18 })); } catch (e2) { return; }
  }
  updateTrayMenu();
  tray.on('click', showWindow);
  updateTray();
}
function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Vis HolyMoly', click: showWindow },
    { label: 'Skriv dokument…', click: () => writer && writer.open() },
    { label: 'Afleveringer…', click: showAssignmentsPage },
    { label: 'Min HolyMoly…', click: () => word && word.mine.open() },
    { label: state.hand ? 'Tag hånden ned' : '✋ Ræk hånden op', enabled: lessonActive(), click: () => setHand(!state.hand) },
    { label: 'Tilføj klasse…', click: () => { showWindow(); win.webContents.send('add-class'); } },
    ...(GUARD_MANAGED ? [] : [{ type: 'separator' }, { label: 'Afslut HolyMoly', click: () => confirmQuit() }]),
  ]));
}

function showWindow() {
  userOpenedAt = Date.now();
  if (!win || win.isDestroyed()) createWindow();
  win.show();
  win.focus();
}

/* ---------------- afleveringssiden i hovedvinduet (agent/renderer/afleveringer.js, agent/src/verified.js) ---------------- */
function showAssignmentsPage() {
  const fresh = !win || win.isDestroyed();
  showWindow();
  if (fresh || win.webContents.isLoading()) win.webContents.once('did-finish-load', () => win.webContents.send('show-assignments'));
  else win.webContents.send('show-assignments');
}
/** Siden åbnet/lukket: vinduet gøres bredt nok til tabellen og bagefter lille igen. */
function setAssignmentsPage(open) {
  state.assignmentsPage = !!open;
  if (!win || win.isDestroyed()) return;
  if (open) {
    userOpenedAt = Date.now();
    win.setMinimumSize(560, 480);
    const [w, h] = win.getSize();
    if (w < 780 || h < 600) win.setSize(Math.max(w, 780), Math.max(h, 600));
  } else {
    win.setMinimumSize(340, 360);
    win.setSize(380, 420);
  }
}
/**
 * "Skriv verificeret aflevering" (aid = 0: uden aflevering).
 * Word kobles på her: har writer en metode startVerified(aid) → { ok, error }, bruges den.
 * Ellers HolyMolys eget skrivevindue: i timen åbnes afleveringen (kladden eller et nyt dokument);
 * uden for timen startes først en skriveøkt – kun når læreren har tilladt, at afleveringen skrives hjemme.
 */
async function startVerifiedWriting(aid) {
  if (!writer) return { ok: false, error: 'HolyMoly er ikke klar endnu. Prøv igen om lidt.' };
  if (typeof writer.startVerified === 'function') return (await writer.startVerified(aid)) || { ok: true };
  aid = Number(aid) || 0;
  // Word findes på computeren: åbn Word med HolyMoly-rammen og muldvarpen (agent/src/word). Ellers HolyMolys skrivevindue.
  if (word) {
    const inf = await word.manager.info().catch(() => ({ available: false }));
    if (inf.available) return (await word.manager.start({ assignmentId: aid })) || { ok: true };
  }
  if (!aid) { writer.open(); return { ok: true }; }
  const a = writer.assignments.find(x => x.id === aid);
  if (!a) return { ok: false, error: 'Afleveringen findes ikke' };
  if (!lessonActive()) {
    if (!a.home) return { ok: false, error: 'Denne aflevering skrives i timen, når din lærer har startet en lektion.' };
    const r = await writer.session(aid, true);
    if (!r.ok) return r;
  }
  writer.openForAssignment(aid, { title: a.title });
  return { ok: true };
}
verified.register({
  ipcMain, shell, lessonActive,
  getWriter: () => writer,
  getWin: () => (win && !win.isDestroyed() ? win : undefined),
  startWriting: startVerifiedWriting,
  onPage: setAssignmentsPage,
});

/* ---------------- lektion ---------------- */
function lessonActive() {
  return !!(state.lesson && state.lesson.live && state.lesson.endsAt > Date.now());
}

function applyLesson(lesson) {
  const wasLive = lessonActive();
  state.lesson = lesson && lesson.live ? lesson : null;
  state.home = !!(state.lesson && state.lesson.solo);
  const live = lessonActive();
  if (writer) writer.lessonChanged(live);
  // Skrivetime: læreren har valgt en opgave – skrivevinduet åbner den (uden at stjæle fokus)
  if (writer) writer.writeLesson(live && state.lesson.write ? state.lesson.write : null);
  if (word) word.manager.lessonChanged();
  if (live !== wasLive) updateTrayMenu();
  if (live) {
    policy.setRules(ACRules.compile(state.rules, state.lesson.config), state.lesson.config);
    // Hemmelig token pr. lektion: kun den rigtige app kan afslutte blokeringen i browseren før tid
    if (!state.extToken || !wasLive) state.extToken = require('node:crypto').randomBytes(24).toString('base64url');
    bridge.setState({ active: true, endsAt: state.lesson.endsAt, rules: state.rules, config: state.lesson.config, token: state.extToken });
    if (macFilter) macFilter.setConfig(filterConfig());
    if (!wasLive) state.lessonStartedAt = Date.now();

    if (!wasLive) {
      monitor.start();
      evalTimer = setInterval(evaluate, 1000);
      // Tjek jævnligt at skærmoptagelse virker (uden at sende billedet)
      state.captureOk = true;
      // Hjemme bruges skærmen aldrig – så tjekkes den heller ikke
      const check = () => { if (!state.home) captureWorks().then((ok) => { state.captureOk = ok; }); };
      check();
      captureTimer = setInterval(check, 15_000);
      // macOS: første kald udløser tilladelses-dialogen til skærmoptagelse
      if (process.platform === 'darwin' && !state.home) require('./capture').grab(0, 64, 10).catch(() => {});
    }
  } else if (wasLive || !live) {
    endMonitoring();
  }
  pushUi();
}

/** Regler til Mac-netværksfilteret for den igangværende lektion. */
function filterConfig() {
  const R = policy.rules;
  const ai = (state.rules.aiEndpoints || []).concat(((state.rules.domains || {}).ai || []).filter(d => !d.includes('/')));
  return {
    active: true, until: state.lesson.endsAt, dropAi: true,
    ai: [...new Set(ai)], block: R ? [...new Set(R.blockedDomainList())] : [],
  };
}

function endMonitoring() {
  if (state.hand) { state.hand = false; updateTrayMenu(); }
  if (macFilter) macFilter.setConfig({ active: false, until: 0, ai: [], block: [] });
  clearInterval(evalTimer);
  clearInterval(captureTimer);
  evalTimer = null;
  monitor.stop();
  bridge.setState({ active: false, token: state.extToken || '' });
  freezer.unfreeze();
  state.frozen = false;
  state.watching = false;
  state.lastStatus = null;
  state.violationKeys.clear();
  if (streamer) streamer.setMode('off');
}

/* Lektionen udløber lokalt selv uden net (fx hvis wifi forsvinder). */
setInterval(() => {
  if (state.lesson && state.lesson.endsAt <= Date.now()) applyLesson(null);
  if (writer) writer.lessonChanged(lessonActive());
}, 5000);

/* ---------------- evaluering ---------------- */
function accessibilityOk() {
  if (process.platform !== 'darwin') return true;
  try { return systemPreferences.isTrustedAccessibilityClient(false); } catch (e) { return true; }
}

function notifyStudent(body) {
  try { if (Notification.isSupported()) new Notification({ title: 'HolyMoly', body, silent: false }).show(); } catch (e) { /* */ }
}

const lastClose = new Map();
function evaluate() {
  if (!lessonActive()) return;
  const exts = bridge.live().map(c => ({ browser: c.browser, windows: c.windows, tabs: c.tabs }));
  const now = Date.now();
  const monitorBroken = monitor.lastFgAt ? now - monitor.lastFgAt > 20_000 : false;
  const net = monitor.net && now - monitor.net.ts < 15_000 ? monitor.net : null;
  const r = policy.evaluate({
    fg: monitor.fg, processes: monitor.processes, extensions: exts, platform: process.platform,
    windows: monitor.windows, macTabs: monitor.macTabs,
    netAi: macFilter ? macFilter.recentAi().map(f => ({ pid: f.pid, host: f.host, bundle: f.app }))
      : (net ? aiConnections(net, policy.rules) : []),
    // Under udvikling (e2e) kan man opføre sig, som om udvidelsen er udgivet: browsere uden den lukkes så
    extensionIds: (process.env.HM_REQUIRE_EXTENSION === '1' && !app.isPackaged) ? ['dev'] : (CONFIG.extensionIds || []),
    selfPids: [process.pid], minExtensionVersion: state.minExtensionVersion, bridgeSquatter: state.bridgeSquatter,
    macFilterRequired: !!CONFIG.requireMacFilter, macFilterState: macFilter ? macFilter.state : 'ok',
    guardRequired: GUARD_MANAGED || guard.installed(), guardStatus: guard.readStatus(), lessonStartedAt: state.lessonStartedAt || 0,
    macFilterTamperAt: macFilter ? macFilter.lastForeignChange : 0,
    extensionVersions: bridge.live().map(c => c.version),
    screenPermission: state.home ? undefined : screenPermission(), accessibility: accessibilityOk(), captureOk: state.home ? undefined : state.captureOk,
    automationDenied: [...monitor.automationDenied], monitorBroken, now,
  });

  // Luk forbudte programmer
  for (const k of r.kill) {
    killProcess(k.pid).then((ok) => {
      if (ok) conn.event({ kind: 'killed', app: k.name, category: k.category, title: `${k.label}: ${k.name} blev lukket` });
    });
  }
  // Browsere HolyMoly ikke kan se ind i (eller uden udvidelse) lukkes
  if (r.closeBrowser && now - (lastClose.get(r.closeBrowser.app) || 0) > 10_000) {
    lastClose.set(r.closeBrowser.app, now);
    const fg = Object.assign({}, monitor.fg);
    closeApp(fg).then((ok) => {
      conn.event({ kind: 'killed', app: fg.app, title: r.closeBrowser.reason + (ok ? '' : ' (kunne ikke lukkes)') });
      notifyStudent(r.closeBrowser.reason);
    });
  }
  // Forbudte sider i andre synlige browservinduer: luk den browser
  for (const c of r.closeOther) {
    if (now - (lastClose.get('pid:' + c.pid) || 0) < 10_000) continue;
    lastClose.set('pid:' + c.pid, now);
    closeApp(c).then((ok) => {
      conn.event({ kind: 'killed', app: c.app, title: c.reason + (ok ? '' : ' (kunne ikke lukkes)') });
      notifyStudent(c.reason);
    });
  }
  // Mac: forbudte sider i baggrundsfaner sendes til blokeringssiden
  for (const b of r.macBlocks) {
    const key = `tab:${b.app}:${b.w}:${b.t}`;
    if (now - (lastClose.get(key) || 0) < 3000) continue;
    lastClose.set(key, now);
    let host = '';
    try { host = new URL(b.url).hostname; } catch (e) { /* */ }
    macRedirect(b.app, new URL('/blokeret.html', SERVER_URL).toString() + '#' + encodeURIComponent(host), b.w, b.t)
      .then((ok) => { if (ok) conn.event({ kind: 'blocked', url: b.url, title: host, blocked: true, detail: { browser: b.app } }); });
  }
  // Mac uden udvidelse (fx Safari): send fanen til blokeringssiden
  if (r.macBlock && now - (lastClose.get('mac:' + r.macBlock.app) || 0) > 3000) {
    lastClose.set('mac:' + r.macBlock.app, now);
    let host = '';
    try { host = new URL(r.macBlock.url).hostname; } catch (e) { /* */ }
    const target = new URL('/blokeret.html', SERVER_URL).toString() + '#' + encodeURIComponent(host);
    macRedirect(r.macBlock.app, target).then(() => {
      const v = r.violations[0];
      policy.noteAttempt(host + (v ? ` (${v.text.split(':')[0]})` : ''));
      conn.event({ kind: 'blocked', url: r.macBlock.url, title: host, category: v ? v.category : '', blocked: true, detail: { browser: r.macBlock.app } });
    });
  }

  if (state.screenLocked) r.degraded.push({ kind: 'locked', text: 'Computeren er låst eller skiftet til en anden bruger' });

  // Nye overtrædelser -> log + skærmbillede som dokumentation
  const keys = new Set(r.violations.map(v => v.kind + '|' + v.text));
  const fresh = r.violations.filter(v => !state.violationKeys.has(v.kind + '|' + v.text));
  state.violationKeys = keys;
  for (const v of fresh) conn.event({ kind: 'violation', title: v.text, category: v.category, url: r.url, app: r.app });
  // Skærmbillede som dokumentation kun, hvis læreren har slået det til for klassen – og eleven får altid besked
  const autoEvidence = !state.home && !!(state.lesson && state.lesson.config && state.lesson.config.autoEvidence);
  if (autoEvidence && fresh.length && now - state.lastEvidence > 20_000 && streamer) {
    state.lastEvidence = now;
    setTimeout(() => {
      streamer.evidence(fresh[0].text, { url: r.url, app: r.app, category: fresh[0].category });
      notifyStudent(`HolyMoly tog et skærmbillede til din lærer, fordi: ${fresh[0].text}`);
    }, 300);
  }
  const degKey = r.degraded.map(d => d.kind).join(',');
  if (degKey !== state.lastDegraded) {
    if (degKey) conn.event({ kind: 'tamper', title: 'Overvågning ikke komplet: ' + r.degraded.map(d => d.text).join(', ') });
    state.lastDegraded = degKey;
  }

  // App-skift til loggen (kun når vinduet har været i front i 2 sek)
  const appKey = (monitor.fg.app || '') + '|' + (policy.rules.browserOf(monitor.fg.app) ? '' : monitor.fg.title || '');
  if (state.home) { state.pendingApp = null; } // hjemme: ingen programskift i loggen
  else if (appKey !== state.lastAppEvent.key) {
    if (!state.pendingApp || state.pendingApp.key !== appKey) state.pendingApp = { key: appKey, ts: now, app: monitor.fg.app, title: monitor.fg.title };
    else if (now - state.pendingApp.ts > 2000) {
      state.lastAppEvent = { key: appKey, ts: now };
      if (state.pendingApp.app) conn.event({ kind: 'app', app: state.pendingApp.app, title: policy.rules.browserOf(state.pendingApp.app) ? '' : state.pendingApp.title });
      state.pendingApp = null;
    }
  }

  const status = {
    activity: state.frozen ? '❄ Skærmen er frosset – ' + r.activity : r.activity,
    url: r.url, app: r.app, violations: r.violations, degraded: r.degraded, frozen: state.frozen,
    ext: { connected: r.extBrowsers.length > 0, browsers: r.extBrowsers },
    screens: screenCount(),
    attempt: r.attempt,
  };
  const key = JSON.stringify([status.activity, status.url, status.violations, status.degraded, status.frozen, status.ext, status.screens, status.attempt]);
  const detailKey = JSON.stringify([r.tabs, r.apps.map(a => a.name)]);
  const changed = !state.lastStatus || key !== state.lastStatus.key;
  if (changed || now - state.lastStatusSent > 5000) {
    // Hjemme: kun "Skriver hjemme", lampen og kategorien – ingen adresse, intet program, ingen faner eller programmer
    const msg = Object.assign({ type: 'status' }, state.home ? homeStatus(status) : status);
    if (!state.home && (detailKey !== state.lastDetailKey || now - state.lastDetailSent > 30_000)) {
      msg.tabs = r.tabs.slice(0, 60);
      msg.apps = r.apps.slice(0, 120).map(a => ({ name: a.name, category: a.category, blocked: a.blocked }));
      if (conn.online) { state.lastDetailKey = detailKey; state.lastDetailSent = now; }
    }
    if (conn.send(msg)) state.lastStatusSent = now;
  }
  state.lastStatus = Object.assign({ key, color: colorOf(r) }, status);
  if (changed) pushUi();
}

/* ---------------- forbindelse ---------------- */
function startConnection() {
  if (conn) conn.stop();
  conn = new Connection({
    serverUrl: SERVER_URL,
    getTokens: () => state.data.enrollments.map(e => e.token),
    // Computerens navn sendes ikke (det er ofte elevens navn) – kun et tilfældigt id for denne installation
    device: { os: osName(), id: state.data.deviceId || '', version: app.getVersion() },
  });
  // Hjemme sendes kun de hændelser, der må sendes – og kun i den form, de må have
  const sendEvent = conn.event.bind(conn);
  conn.event = (item) => {
    const it = state.home ? homeEvent(item) : item;
    if (it) sendEvent(it);
  };
  streamer = new Streamer(conn);
  streamer.onLiveChange = (on) => {
    state.watching = on;
    // Eleven skal vide når læreren kigger med (gennemsigtighed – GDPR)
    if (on) notifyStudent('Din lærer kigger på din skærm lige nu.');
    pushUi();
  };
  conn.on('state', (s) => {
    if (s === 'online') state.error = '';
    if (writer) writer.lessonChanged(lessonActive()); // skrivevinduets lampe: grå med det samme uden forbindelse
    pushUi();
  });
  conn.on('message', (msg) => {
    switch (msg.type) {
      case 'welcome':
        if (msg.rules && typeof msg.rules === 'object' && msg.rules.domains) state.rules = msg.rules;
        state.updateRequired = !!msg.updateRequired;
        // Engangskode så HolyMoly-vagten kan tilknytte sig eleven (vagten taler derefter selv med serveren)
        if (msg.guardPair && Object.keys(msg.guardPair).length) guard.writePairRequest(msg.guardPair);
        state.downloadUrl = /^https:\/\//.test(String(msg.downloadUrl || '')) ? msg.downloadUrl : '';
        state.minExtensionVersion = String(msg.minExtensionVersion || '');
        // Opdatér navne hvis læreren har omdøbt
        for (const en of msg.enrollments || []) {
          const e = state.data.enrollments.find(x => x.studentId === en.studentId);
          if (e) Object.assign(e, { studentName: en.studentName, className: en.className, teacherName: en.teacherName });
        }
        store.save(state.data);
        // Skrivevinduet: lampen venter på serveren, og en afbrudt skriveøkt fortsættes af sig selv
        if (writer) writer.onMessage(msg);
        if (word) word.manager.onMessage(msg);
        pushUi();
        break;
      case 'lesson':
        if (msg.live && !lessonActive()) notifyStudent(`Lektionen ${msg.className || ''} er startet – HolyMoly er aktiv.`);
        if (msg.live) {
          // Hjælpemidler fra læreren (ordforslag, diktering): skrivevinduet tillader dem (de gælder også i øvedokumentet bagefter)
          if (writer) writer.setAids(msg.aids);
          applyLesson({ live: true, className: msg.className, studentName: msg.studentName, teacherName: msg.teacherName, endsAt: Number(msg.endsAt), config: msg.config || {}, solo: msg.solo || null, write: msg.write || null });
          conn.event({ kind: 'info', title: 'HolyMoly forbundet (' + osName() + ')' });
        } else applyLesson(null);
        break;
      case 'config':
        if (state.lesson) { state.lesson.config = msg.config || {}; applyLesson(state.lesson); }
        break;
      case 'rules':
        if (msg.rules && msg.rules.domains) { state.rules = msg.rules; if (state.lesson) applyLesson(state.lesson); }
        break;
      case 'hand':
        // Læreren har set hånden og taget den ned
        if (msg.up === false && state.hand) { state.hand = false; updateTrayMenu(); pushUi(); }
        break;
      case 'doc-saved':
      case 'doc-result':
      case 'assignments':
      case 'assignment-result':
      case 'write-session-result':
      case 'my-lamp': // elevens egen lampe (kun til denne app)
      case 'server-restart': // serveren genstarter: "Skriv bare videre"
        if (writer) writer.onMessage(msg);
        if (word) word.manager.onMessage(msg); // "Skriv i Word" bruger de samme beskeder
        break;
      case 'freeze':
        if (!lessonActive()) break;
        state.frozen = !!msg.on;
        state.freezeMsg = String(msg.message || '');
        // Gennemgang: standby med ur, dato og tid tilbage af lektionen
        freezer.set(state.frozen, state.freezeMsg, {
          mode: msg.mode === 'review' ? 'review' : 'freeze',
          endsAt: Number(msg.endsAt) || (state.lesson ? state.lesson.endsAt : 0),
          startedAt: Number(msg.startedAt) || 0,
        });
        pushUi();
        break;
      case 'stream':
        if (lessonActive() && !state.home) streamer.setMode(msg.mode, msg.screen);
        else streamer.setMode('off');
        break;
      case 'frameAck':
        streamer.ack();
        break;
      case 'screenshot':
        // Læreren har trykket "Tag skærmbillede" – gemmes under elevens hændelser (aldrig hjemme)
        if (lessonActive() && !state.home) {
          streamer.evidence('Skærmbillede taget af læreren', { url: monitor.fg.url || (state.lastStatus && state.lastStatus.url) || '', app: monitor.fg.app }, { width: 1920, quality: 80 });
          notifyStudent('Din lærer tog et skærmbillede af din skærm.');
        }
        break;
      case 'revoked':
      case 'replaced': {
        // Tilmeldingen er ikke længere gyldig på denne computer – fjern den.
        state.data.enrollments = state.data.enrollments.filter(e => e.studentId !== Number(msg.studentId));
        store.save(state.data);
        state.error = msg.type === 'replaced' ? 'Du er blevet logget ind på en anden computer.' : 'Din lærer har givet dig en ny kode. Indtast den for at forbinde igen.';
        if (!state.data.enrollments.length) { conn.stop(); applyLesson(null); }
        pushUi();
        break;
      }
      case 'error':
        state.error = String(msg.message || 'Fejl fra serveren');
        pushUi();
        break;
      default:
        break;
    }
  });
  conn.on('unauthorized', () => {
    state.error = state.error || 'Din kode er ikke længere gyldig. Bed din lærer om en ny kode.';
    pushUi();
  });
  if (state.data.enrollments.length) conn.start();
}

function osName() {
  const p = process.platform;
  return (p === 'win32' ? 'Windows' : p === 'darwin' ? 'macOS' : p === 'linux' ? 'Linux' : p) + ' ' + os.release();
}

/* ---------------- browser-udvidelse ---------------- */
bridge.on('nav', (n) => {
  if (!lessonActive() || state.home) return; // hjemme: ingen navigation til læreren
  conn.event({ kind: n.blocked ? 'blocked' : 'nav', url: n.url, title: n.title, detail: { browser: n.browser } });
});
bridge.on('blocked', (b) => {
  if (!lessonActive()) return;
  if (b.reason === 'iframe') {
    // Indlejret indhold på en ellers tilladt side (fx et Instagram-opslag i en artikel) – ikke elevens forsøg
    conn.event({ kind: 'info', url: b.url, title: 'Indlejret indhold fjernet', category: b.category });
    return;
  }
  let host = b.url;
  try { host = new URL(b.url).hostname.replace(/^www\./, ''); } catch (e) { /* */ }
  const label = (ACRules.CATEGORIES[b.category] || {}).label;
  const text = label ? `${host} (${label})` : host;
  policy.noteAttempt(text || b.category);
  conn.event({ kind: 'blocked', url: b.url, title: text, category: b.category, blocked: true, detail: { reason: b.reason, browser: b.browser } });
});
bridge.on('ext-disconnected', (c) => {
  if (!lessonActive()) return;
  conn.event({ kind: 'tamper', title: `Browser-udvidelsen i ${c.browser} blev afbrudt (lukket browser eller slået fra)` });
});
bridge.on('change', () => pushUi());
if (macFilter) {
  macFilter.on('state', () => pushUi());
  macFilter.on('tamper', (t) => {
    if (lessonActive()) conn.event({ kind: 'tamper', title: 'Et andet program forsøgte at ændre HolyMoly-netværksfilteret', detail: t });
  });
  macFilter.on('flow', (f) => {
    if (!lessonActive()) return;
    const R = policy.rules;
    const browser = R && R.browserOfBundle(f.app);
    if (browser) {
      // Browser (fx Safari) blev stoppet af filteret = et blokeret forsøg
      policy.noteAttempt(f.host);
      conn.event({ kind: 'blocked', url: 'https://' + f.host + '/', title: f.host, blocked: true, detail: { browser: f.app, via: 'netværksfilter' } });
    } else if (f.ai) {
      conn.event({ kind: 'violation', title: `${f.app || 'Ukendt program'} forsøgte at bruge AI (${f.host}) – blokeret`, app: f.app, category: 'ai', blocked: true });
    }
  });
}

/* ---------------- IPC fra vinduet ---------------- */
ipcMain.handle('state:get', () => uiState());

// Første opsætning: skolens HolyMoly-adresse. Tjekkes mod serveren, og vagten (administrator) gemmer den,
// så den bagefter ikke kan ændres uden administrator.
let settingServer = false;
ipcMain.handle('server:set', async (_e, input) => {
  if (!state.serverSetup) return { ok: false, error: 'Serveradressen er allerede sat' };
  if (settingServer) return { ok: false, error: 'Et øjeblik…' };
  const url = normServer(input);
  if (!url) return { ok: false, error: 'Skriv adressen, fx holymoly.minskole.dk (skal være https)' };
  settingServer = true;
  try {
    // Er det en HolyMoly-server?
    let info = null;
    try {
      const res = await net.fetch(url + '/api/info', { signal: AbortSignal.timeout(10_000) });
      info = await res.json().catch(() => null);
    } catch (e) { return { ok: false, error: 'Kan ikke få forbindelse til ' + new URL(url).host + '. Tjek adressen og internettet.' }; }
    if (!info || typeof info !== 'object' || !info.categories) return { ok: false, error: 'Det er ikke en HolyMoly-server. Spørg din lærer om adressen.' };
    if (GUARD_MANAGED || guard.installed()) {
      if (!guard.writeServerRequest(url)) return { ok: false, error: 'HolyMoly-vagten kører ikke – genstart computeren og prøv igen' };
      // Vagten tjekker hvert par sekunder
      const until = Date.now() + 25_000;
      while (Date.now() < until && machineServer() !== url) await new Promise(r => setTimeout(r, 500));
      if (machineServer() !== url) return { ok: false, error: 'HolyMoly-vagten svarede ikke – genstart computeren og prøv igen' };
    }
    SERVER_URL = url;
    state.serverSetup = false;
    state.error = '';
    startConnection();
    pushUi();
    return { ok: true, host: new URL(url).host };
  } finally { settingServer = false; }
});
ipcMain.handle('enroll', (_e, code, name, pin, accept) => enrollWith(code, name ? Object.assign({ name: String(name).slice(0, 80) }, pin ? { pin: String(pin).replace(/\D/g, '').slice(0, 6) } : {}, accept === true ? { accept: true } : {}) : {}));

// UNI-Login: åbner skolens UNI-Login i browseren. Resultatet sendes tilbage til en midlertidig adresse
// på elevens EGEN computer (127.0.0.1:<port>, RFC 8252) – så et login-link, en elev sender til en anden,
// aldrig kan give afsenderen den andens login.
let uniWaiting = null; // { server, resolve }
function stopUniWait(result) {
  const w = uniWaiting;
  uniWaiting = null;
  if (!w) return;
  try { w.server.close(); } catch (e) { /* */ }
  clearTimeout(w.timer);
  w.resolve(result);
}
ipcMain.handle('enroll-unilogin', async (_e, code) => {
  if (!serverUrlOk(SERVER_URL)) return { ok: false, error: 'Appen er sat op med en usikker serveradresse. Kontakt din skoles IT.' };
  stopUniWait(null);
  const appId = require('node:crypto').randomBytes(32).toString('base64url');
  const http = require('node:http');
  const ticket = await new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/unilogin' || u.searchParams.get('app') !== appId || !/^[A-Za-z0-9_-]{20,100}$/.test(u.searchParams.get('ticket') || '')) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Ikke fundet');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", 'Cache-Control': 'no-store' });
      res.end('<!doctype html><meta charset="utf-8"><title>HolyMoly</title><body style="font:18px system-ui;display:grid;place-items:center;height:90vh;margin:0;background:#f4f5f7"><div style="text-align:center"><h1 style="font-size:24px">Du er logget ind ✓</h1><p>Gå tilbage til HolyMoly-appen – den gør resten.</p></div></body>');
      stopUniWait(u.searchParams.get('ticket'));
    });
    server.on('error', () => resolve(null));
    server.listen(0, '127.0.0.1', async () => {
      uniWaiting = { server, resolve, timer: setTimeout(() => stopUniWait(null), 10 * 60_000) };
      const start = new URL('/api/auth/unilogin/start', SERVER_URL);
      start.searchParams.set('role', 'student');
      start.searchParams.set('app', appId);
      start.searchParams.set('port', String(server.address().port));
      try { await shell.openExternal(start.toString()); } catch (e) { stopUniWait(null); }
    });
  });
  if (!ticket) return { ok: false, error: 'UNI-Login blev ikke gennemført. Prøv igen.' };
  return enrollWith(code, { ticket: String(ticket) });
});
ipcMain.handle('enroll-unilogin-cancel', () => { stopUniWait(null); });

async function enrollWith(code, extra) {
  if (!serverUrlOk(SERVER_URL)) return { ok: false, error: 'Appen er sat op med en usikker serveradresse. Kontakt din skoles IT.' };
  const clean = String(code).toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (clean.length !== 8) return { ok: false, error: 'Koden skal have 8 tegn, fx ABCD-2345' };
  try {
    const res = await net.fetch(new URL('/api/enroll', SERVER_URL).toString(), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ code: clean }, extra)),
    });
    const data = await res.json().catch(() => ({}));
    // Klassekode: serveren beder om elevens navn eller UNI-Login (trin 2)
    if (data.needName) {
      return { ok: false, needName: true, error: (extra.name || extra.ticket) ? String(data.error || '') : '', className: String(data.className || ''), teacherName: String(data.teacherName || ''), uniLogin: !!data.uniLogin, uniLoginRequired: !!data.uniLoginRequired, needPin: !!data.needPin, needAccept: !!data.needAccept, pinKnown: !!data.pinKnown };
    }
    if (!res.ok) return { ok: false, error: data.error || 'Serveren svarede med fejl ' + res.status };
    if (typeof data.token !== 'string') return { ok: false, error: 'Uventet svar fra serveren' };
    // Samme klasse igen (ny kode) erstatter den gamle tilmelding
    state.data.enrollments = state.data.enrollments.filter(e => e.studentId !== data.studentId);
    state.data.enrollments.push({ token: data.token, studentId: data.studentId, studentName: data.studentName, className: data.className, teacherName: data.teacherName });
    store.save(state.data);
    state.error = '';
    startConnection();
    pushUi();
    return { ok: true, className: data.className };
  } catch (e) {
    return { ok: false, error: 'Kan ikke få forbindelse til serveren. Tjek internettet og prøv igen.' };
  }
}
ipcMain.handle('action', (_e, id) => {
  if (id === 'write') { if (writer) writer.open(); return; }
  if (id === 'assignments') { showAssignmentsPage(); return; }
  if (id === 'word') return word ? word.manager.start({}) : { ok: false, error: 'Skriv i Word er ikke klar' };
  if (id === 'mine') { if (word) word.mine.open(); return; }
  if (id === 'hand') { setHand(!state.hand); return; }
  // Lektionens links: kun de links læreren har lagt ind for den igangværende lektion
  const lm = /^link:(\d+)$/.exec(String(id));
  if (lm) {
    const l = lessonActive() ? linksOf(state.lesson)[Number(lm[1])] : null;
    if (l) shell.openExternal(l.url).catch(() => {});
    return;
  }
  const links = CONFIG.extensionLinks || {};
  const open = (u) => { if (u && /^https:\/\//.test(u)) shell.openExternal(u); };
  const panes = { 'mac:screen': 'Privacy_ScreenCapture', 'mac:accessibility': 'Privacy_Accessibility', 'mac:automation': 'Privacy_Automation' };
  if (id === 'terms') { if (serverUrlOk(SERVER_URL)) shell.openExternal(new URL('/vilkaar-elev', SERVER_URL).toString()).catch(() => {}); return; }
  if (id === 'download') open(state.downloadUrl);
  else if (id === 'mac:filter' && macFilter && !state.filterBusy) activateFilter();
  else if (id === 'mac:extensions' && process.platform === 'darwin') shell.openExternal('x-apple.systempreferences:com.apple.LoginItems-Settings.extension');
  else if (id.startsWith('ext:')) open(links[id.slice(4)] || links.chrome);
  else if (panes[id] && process.platform === 'darwin') shell.openExternal('x-apple.systempreferences:com.apple.preference.security?' + panes[id]);
});

/** Mac: installerer/slår netværksfilteret til via "HolyMoly Filter.app". */
async function activateFilter() {
  state.filterBusy = true;
  state.filterApproval = false;
  state.filterMsg = 'Slår netværksfilteret til…';
  pushUi();
  const r = await macfilter.activate(process.resourcesPath, (ev) => {
    if (ev.status === 'needs_approval') {
      state.filterApproval = true;
      state.filterMsg = 'Godkend "HolyMoly" under Netværksudvidelser i Systemindstillinger';
      shell.openExternal('x-apple.systempreferences:com.apple.LoginItems-Settings.extension');
      pushUi();
    }
  });
  state.filterBusy = false;
  state.filterApproval = false;
  state.filterMsg = r.ok ? (r.reboot ? 'Genstart Mac\'en for at slå filteret til' : '') : (r.status === 'not_bundled' ? 'Netværksfilteret følger ikke med denne version – kontakt IT' : 'Kunne ikke slå filteret til – prøv igen');
  pushUi();
}

async function confirmQuit() {
  if (GUARD_MANAGED) {
    // Installeret med vagten: HolyMoly kører altid i baggrunden (men overvåger kun i lektioner)
    showWindow();
    await dialog.showMessageBox(win, {
      type: 'info', buttons: ['OK'], title: 'HolyMoly',
      message: 'HolyMoly kører altid i baggrunden.',
      detail: 'Der bliver kun overvåget og blokeret, når din lærer har startet en lektion.',
    });
    return;
  }
  if (lessonActive()) {
    showWindow();
    await dialog.showMessageBox(win, {
      type: 'info', buttons: ['OK'], title: 'HolyMoly',
      message: 'HolyMoly kan ikke afsluttes mens lektionen er i gang.',
      detail: `Lektionen slutter kl. ${new Date(state.lesson.endsAt).toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' })}. Derefter kan du lukke appen.`,
    });
    return;
  }
  quitting = true;
  app.quit();
}

/* ---------------- livscyklus ---------------- */
// Vagten/opstarten prøver løbende at starte HolyMoly med --tray; det må ikke åbne vinduet igen
app.on('second-instance', (_e, argv) => { if (!argv.includes('--tray')) showWindow(); });
app.on('window-all-closed', (e) => { /* bliv kørende i baggrunden */ });
app.on('activate', showWindow);
let systemShutdown = false;
app.on('before-quit', (e) => {
  // I lektionen kan appen ikke lukkes fra menuen/Cmd+Q – kun når computeren slukkes.
  if (lessonActive() && !systemShutdown && !quitting) { e.preventDefault(); confirmQuit(); return; }
  quitting = true;
  if (conn && conn.online && lessonActive() && !state.byeSent) {
    e.preventDefault();
    state.byeSent = true;
    conn.send({ type: 'bye', reason: systemShutdown ? 'shutdown' : 'quit' });
    setTimeout(() => { freezer.unfreeze(); app.quit(); }, 400);
    return;
  }
  freezer.unfreeze();
  monitor.stop();
  bridge.stop();
  if (word) word.manager.stop(); // Word og elevens dokument forbliver åbne
  if (conn) conn.stop();
});

app.whenReady().then(async () => {
  if (process.platform === 'darwin' && app.dock) app.dock.setIcon(path.join(__dirname, '..', 'assets', 'icon.png'));
  state.data = store.load();
  try { await bridge.start(); } catch (e) { state.error = 'Kunne ikke starte forbindelsen til browser-udvidelsen: ' + e.message; }
  // Har et andet program taget HolyMolys port? Så ville browser-udvidelsen tale med det i stedet.
  for (const p of bridge.squatted) {
    const who = await peer.identifyListener(p).catch(() => null);
    if (who && who.pid !== process.pid && !/holymoly/i.test(who.name + who.orig)) {
      state.bridgeSquatter = `${who.name || 'ukendt program'} (port ${p})`;
      break;
    }
  }
  createWindow();
  writer = new Writer({
    send: (m) => !!(conn && conn.send(m)),
    lessonActive,
    online: () => !!(conn && conn.online),
    lastRecv: () => (conn && conn.lastRecv) || 0,
    get serverUrl() { return SERVER_URL; },
    studentName: () => (state.data.enrollments[0] || {}).studentName || '',
    onAssignments: (list) => {
      const open = list.filter(x => !x.submission).length;
      if (open > (state.assignmentsOpen || 0) && state.assignmentsOpen != null) notifyStudent(`Du har ${open === 1 ? 'en ny aflevering' : open + ' afleveringer'} i HolyMoly.`);
      state.assignmentsOpen = open;
      updateTrayMenu();
      pushUi();
    },
  });
  // "Skriv i Word" (Windows): samme forbindelse og lektion som skrivevinduet
  word = createWordMode({
    send: (m) => !!(conn && conn.send(m)), lessonActive, online: () => !!(conn && conn.online),
    serverUrl: () => SERVER_URL, writer: () => writer,
  });
  // Afleveringssiden (verified.js): Word-dokumenter står også under "Verificerede afleveringer" og kan vedhæftes med "Aflever"
  if (writer) {
    writer.verifiedDocs = () => word.manager.list().map(d => ({
      id: d.id, title: d.title, words: d.words, certId: d.certId, label: d.label, submitted: d.submitted,
      path: d.sealedPath || d.path || '', source: 'word', updated: d.updated, created: d.created, assignmentId: d.assignmentId,
    }));
    writer.attachVerified = (aid, docId) => (word.manager.get(String(docId)) ? word.manager.attach(docId, aid) : writer.attach(aid, docId));
  }
  word.manager.info().then((i) => { state.wordAvailable = i.available; pushUi(); }).catch(() => {});
  createTray();
  state.serverSetup = needsServerSetup();
  if (state.serverSetup) { /* venter på skolens adresse (første opsætning i vinduet) */ }
  else if (!serverUrlOk(SERVER_URL)) state.error = 'Serveradressen er ikke sikker (https). Kontakt din skoles IT.';
  else startConnection();
  powerMonitor.on('shutdown', () => { systemShutdown = true; });
  if (macFilter) macFilter.start();
  if (win) win.on('session-end', () => { systemShutdown = true; });
  if (process.platform === 'darwin') {
    // Spørg om tilladelse til Hjælpefunktioner (bruges til vinduestitler)
    try { systemPreferences.isTrustedAccessibilityClient(true); } catch (e) { /* */ }
  }
  monitor.on('monitor-restart', () => { if (lessonActive()) conn.event({ kind: 'tamper', title: 'Vinduesovervågningen blev stoppet og genstartet' }); });
  // Skiftede eleven virtuelt skrivebord væk fra en frossen skærm/gennemgang? Så følger skærmen med.
  let lastDeskEvent = 0;
  monitor.on('own-windows', (list) => {
    if (freezer.checkDesktops(list) && lessonActive() && Date.now() - lastDeskEvent > 30_000) {
      lastDeskEvent = Date.now();
      conn.event({ kind: 'info', title: 'Eleven skiftede skrivebord, mens skærmen var frosset – skærmen fulgte med' });
    }
  });
  // Låst computer eller "Skift bruger": HolyMoly kan ikke se den anden session – læreren ser grå med årsagen
  powerMonitor.on('lock-screen', () => { state.screenLocked = true; evaluate(); });
  powerMonitor.on('unlock-screen', () => { state.screenLocked = false; evaluate(); });
  pushUi();
});
