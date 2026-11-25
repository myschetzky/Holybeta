'use strict';
const test = require('node:test');
const assert = require('node:assert');
const R = require('../shared/rules.js');
const { Policy, stripBrowserSuffix, colorOf, normalizeAddress } = require('../agent/src/policy.js');

function mk(config = { killApps: true }) {
  const p = new Policy();
  p.setRules(R.compile(R.RULE_DATA, config), config);
  return p;
}
const ext = (title, url, browser = 'chrome') => ({ browser, windows: [{ focused: true, active: { title, url } }], tabs: [{ title, url, active: true }] });
const WIN = 'Chrome_WidgetWin_1';
const ev = (p, input) => p.evaluate(Object.assign({ platform: 'win32', now: 1000 }, input));
const color = (r) => colorOf(r);

/* ------------------------------ GRØN ------------------------------ */

test('grøn: Google Docs i Chrome (adresse fra adresselinjen + udvidelse)', () => {
  const r = ev(mk(), { fg: { app: 'chrome', title: 'Dansk stil - Google Docs - Google Chrome', url: 'docs.google.com/document/d/1/edit', cls: WIN }, extensions: [ext('Dansk stil - Google Docs', 'https://docs.google.com/document/d/1/edit')] });
  assert.strictEqual(color(r), 'green');
  assert.match(r.activity, /docs\.google\.com/);
});

test('udvidelsens egen side vises læsbart for læreren – ikke som et id', () => {
  const id = 'kkcfnaobobnehdpcjjpnajbledckkhmi';
  const r = ev(mk(), { fg: { app: 'chrome', title: 'Blokeret – HolyMoly - Google Chrome', cls: WIN }, extensions: [ext('Blokeret – HolyMoly', `chrome-extension://${id}/blocked.html`)] });
  assert.strictEqual(r.activity, 'Udvidelsesside – Blokeret – HolyMoly');
  assert.doesNotMatch(r.activity, new RegExp(id));
  // Før siden har fået sin titel, er vinduets titel adressen – heller ikke den må vises
  const r2 = ev(mk(), { fg: { app: 'chrome', title: `chrome-extension://${id}/blocked.html#http://x/go?u=abc - Google Chrome`, cls: WIN }, extensions: [ext('Blokeret – HolyMoly', `chrome-extension://${id}/blocked.html#http://x/go?u=abc`)] });
  assert.doesNotMatch(r2.activity, new RegExp(id), r2.activity);
  assert.match(r2.activity, /Udvidelsesside/);
});

test('grøn: Safari på Mac – adressen kommer fra Safari selv', () => {
  const r = ev(mk(), { platform: 'darwin', fg: { app: 'Safari', title: 'Lectio', url: 'https://www.lectio.dk/lectio/1/forside.aspx' } });
  assert.strictEqual(color(r), 'green');
  assert.strictEqual(r.closeBrowser, null);
});

test('grøn: Word, Pages, GeoGebra, Finder – og ukendte programmer vises bare med navn', () => {
  for (const app of ['WINWORD', 'Pages', 'GeoGebra Classic 6', 'Finder', 'Microsoft Word', 'SomeIndieTool']) {
    const r = ev(mk(), { fg: { app, title: 'x' } });
    assert.strictEqual(color(r), 'green', app);
  }
  assert.match(ev(mk(), { fg: { app: 'SomeIndieTool', title: 'x' } }).activity, /SomeIndieTool/);
});

/* ------------------------------ RØD (kun bekræftet) ------------------------------ */

test('rød: ChatGPT i adresselinjen – også i inkognito og anden profil', () => {
  const r = ev(mk(), { fg: { app: 'chrome', title: 'ChatGPT - Google Chrome (Incognito)', url: 'chatgpt.com/c/123', cls: WIN }, extensions: [ext('Andet', 'https://docs.google.com/')] });
  assert.strictEqual(color(r), 'red');
  assert.strictEqual(r.violations[0].kind, 'site');
});

test('rød: Instagram i Safari på Mac – HolyMoly lukker siden', () => {
  const r = ev(mk(), { platform: 'darwin', fg: { app: 'Safari', title: 'Instagram', url: 'https://www.instagram.com/' } });
  assert.strictEqual(color(r), 'red');
  assert.strictEqual(r.macBlock.app, 'Safari');
});

test('rød: spil/Discord i forgrunden og Instagram-appen på Windows', () => {
  assert.strictEqual(color(ev(mk(), { fg: { app: 'RobloxPlayerBeta', title: 'Roblox' } })), 'red');
  assert.strictEqual(color(ev(mk(), { fg: { app: 'Discord', title: '#general' } })), 'red');
  assert.strictEqual(color(ev(mk(), { fg: { app: 'ApplicationFrameHost', title: 'Instagram' } })), 'red');
  assert.strictEqual(color(ev(mk({ extraBlockedApps: ['someindietool'] }), { fg: { app: 'SomeIndieTool' } })), 'red');
});

/* ------------------------------ GRÅ (overvågning ikke komplet) ------------------------------ */

test('grå: manglende tilladelser på Mac', () => {
  assert.strictEqual(color(ev(mk(), { platform: 'darwin', fg: { app: 'Pages' }, screenPermission: false })), 'grey');
  assert.strictEqual(color(ev(mk(), { platform: 'darwin', fg: {}, accessibility: false })), 'grey');
  assert.strictEqual(color(ev(mk(), { platform: 'darwin', fg: { app: 'Google Chrome', title: 'x' }, extensions: [], automationDenied: ['chrome'] })), 'grey');
  assert.strictEqual(color(ev(mk(), { fg: { app: 'WINWORD', title: 'x' }, captureOk: false })), 'grey');
});

/* ------------------------------ håndhævelse i stedet for gæt ------------------------------ */

test('browser uden udvidelse lukkes efter kort tid', () => {
  const p = mk();
  const input = (now) => ({ now, fg: { app: 'msedge', title: 'Forside - Microsoft Edge', url: 'www.dr.dk', cls: WIN }, extensions: [ext('x', 'https://x.dk', 'chrome')] });
  const r1 = ev(p, input(1000));
  assert.strictEqual(color(r1), 'green'); // adressen kan læses og er tilladt
  assert.strictEqual(r1.closeBrowser, null);
  assert.match(ev(p, input(10_000)).closeBrowser.reason, /udvidelsen ikke er installeret/);
});

test('Firefox uden udvidelse og ukendte browsere lukkes, forbudt side i browser uden udvidelse lukkes med det samme', () => {
  // Firefox uden udvidelse: lukkes efter 8 sek. (med udvidelsen er Firefox tilladt)
  const pf = mk();
  const ff = (now, exts) => ev(pf, { now, fg: { app: 'firefox', title: 'x — Mozilla Firefox', url: 'www.dr.dk', cls: 'MozillaWindowClass' }, extensions: exts });
  assert.strictEqual(ff(1000, []).closeBrowser, null);
  assert.ok(ff(10_000, []).closeBrowser);
  assert.strictEqual(ff(20_000, [ext('DR', 'https://www.dr.dk/', 'firefox')]).closeBrowser, null);
  // Ukendte browsere (fx Tor) lukkes med det samme
  assert.ok(ev(mk(), { fg: { app: 'tor browser', title: 'x', cls: 'MozillaWindowClass' } }).closeBrowser);
  const r = ev(mk(), { fg: { app: 'brave', title: 'TikTok - Brave', url: 'www.tiktok.com/foryou', cls: WIN }, extensions: [] });
  assert.strictEqual(color(r), 'red');
  assert.match(r.closeBrowser.reason, /TikTok|tiktok/i);
});

test('vindue uden læsbar adresse (fx inkognito uden udvidelse) lukkes efter 5 sek.', () => {
  const p = mk();
  const input = (now) => ({ now, fg: { app: 'chrome', title: 'Hemmelig - Google Chrome (Incognito)', url: '', cls: WIN }, extensions: [ext('Dansk stil', 'https://docs.google.com/')] });
  assert.strictEqual(ev(p, input(1000)).closeBrowser, null);
  assert.match(ev(p, input(7000)).closeBrowser.reason, /Inkognito/);
});

/* ------------------------------ INGEN falske positiver ------------------------------ */

test('ikke rød: side der HEDDER ChatGPT, Wikipedia om TikTok, Word-dokument om Instagram', () => {
  assert.strictEqual(color(ev(mk(), { fg: { app: 'chrome', title: 'ChatGPT - Google Chrome', url: 'wiki.minskole.dk/chatgpt', cls: WIN }, extensions: [ext('ChatGPT', 'https://wiki.minskole.dk/chatgpt')] })), 'green');
  assert.strictEqual(color(ev(mk(), { fg: { app: 'chrome', title: 'TikTok - Wikipedia - Google Chrome', url: 'da.wikipedia.org/wiki/TikTok', cls: WIN }, extensions: [ext('TikTok - Wikipedia', 'https://da.wikipedia.org/wiki/TikTok')] })), 'green');
  assert.strictEqual(color(ev(mk(), { fg: { app: 'WINWORD', title: 'Instagram - analyse.docx - Word' } })), 'green');
});

test('ikke rød: blokeret forsøg (det lykkedes jo ikke) – vises kun som tekst', () => {
  const p = mk();
  p.noteAttempt('chatgpt.com (AI / chatbots)', 500);
  const r = ev(p, { fg: { app: 'WINWORD', title: 'x' } });
  assert.strictEqual(color(r), 'green');
  assert.strictEqual(r.attempt.text, 'chatgpt.com (AI / chatbots)');
});

test('ikke rød: VPN, fjernstyring og IT-værktøjer i baggrunden', () => {
  const r = ev(mk(), { fg: { app: 'WINWORD', title: 'x' }, processes: [{ name: 'nordvpn', pid: 2 }, { name: 'TeamViewer_Service', pid: 3 }, { name: 'msrdc', pid: 4 }, { name: 'meshagent', pid: 5 }] });
  assert.strictEqual(color(r), 'green');
  assert.ok(!r.kill.some(k => k.name === 'nordvpn'), 'VPN lukkes ikke');
});

test('ikke rød: programmer med "farlige" navne', () => {
  for (const app of ['Origin64', 'gamingservices', 'Outline', 'torrent-helper', 'Taskmgr', 'msedgewebview2', 'NordVPN']) {
    assert.strictEqual(color(ev(mk(), { fg: { app, title: '' } })), 'green', app);
  }
});

test('ikke lukning: "Gem som"-dialog i Chrome og kortvarigt vindues-skift', () => {
  const p = mk();
  for (const now of [1000, 9000, 20000]) {
    const r = ev(p, { now, fg: { app: 'chrome', title: 'Gem som', cls: '#32770' }, extensions: [ext('Stil', 'https://docs.google.com/')] });
    assert.strictEqual(r.closeBrowser, null);
    assert.strictEqual(color(r), 'green');
  }
  const r = ev(mk(), { now: 1000, fg: { app: 'chrome', title: 'Ny side - Google Chrome', url: '', cls: WIN }, extensions: [ext('Gammel side', 'https://docs.google.com/')] });
  assert.strictEqual(r.closeBrowser, null);
});

test('eleven skriver i adresselinjen: sidste bekræftede adresse bruges', () => {
  const p = mk();
  ev(p, { fg: { app: 'chrome', title: 'Stil - Google Chrome', url: 'docs.google.com/x', hwnd: 7, cls: WIN }, extensions: [ext('Stil', 'https://docs.google.com/x')] });
  const r = ev(p, { fg: { app: 'chrome', title: 'Stil - Google Chrome', url: '', editing: true, hwnd: 7, cls: WIN }, extensions: [ext('Stil', 'https://docs.google.com/x')] });
  assert.strictEqual(r.url, 'https://docs.google.com/x');
});

/* ------------------------------ andet ------------------------------ */

test('lukning af forbudte programmer', () => {
  const p = mk();
  const r = ev(p, { fg: {}, processes: [{ name: 'RobloxPlayerBeta', pid: 11 }, { name: 'steam', pid: 12 }, { name: 'explorer', pid: 13 }, { name: 'chrome', pid: 14 }] });
  assert.deepStrictEqual(r.kill.map(k => k.pid).sort(), [11, 12]);
  assert.strictEqual(ev(p, { now: 2000, fg: {}, processes: [{ name: 'RobloxPlayerBeta', pid: 11 }] }).kill.length, 0);
  assert.strictEqual(ev(mk({ killApps: false }), { fg: {}, processes: [{ name: 'steam', pid: 5 }] }).kill.length, 0);
});

test('prøvetilstand: kun tilladte sider', () => {
  const p = mk({ examMode: true, examAllowed: ['ordnet.dk'] });
  const at = (url) => color(ev(p, { fg: { app: 'chrome', title: 'x - Google Chrome', url, cls: WIN }, extensions: [ext('x', 'https://' + url)] }));
  assert.strictEqual(at('ordnet.dk/ddo'), 'green');
  assert.strictEqual(at('www.dr.dk/'), 'red');
  assert.strictEqual(at('accounts.google.com/'), 'green');
});

test('hjælpefunktioner', () => {
  assert.strictEqual(normalizeAddress('chatgpt.com/c/1'), 'https://chatgpt.com/c/1');
  assert.strictEqual(normalizeAddress('chatgpt'), '');
  assert.strictEqual(normalizeAddress('hvad er chatgpt'), '');
  assert.strictEqual(normalizeAddress('chrome://newtab/'), 'chrome://newtab/');
  assert.strictEqual(stripBrowserSuffix('Forside - Google Chrome for Testing'), 'Forside');
  assert.strictEqual(stripBrowserSuffix('Forside - Personlig - Microsoft​ Edge'), 'Forside');
  assert.strictEqual(stripBrowserSuffix('Forside — Mozilla Firefox'), 'Forside');
});

/* ------------------------------ netværk, vinduer, omdøbte programmer ------------------------------ */
const { aiConnections } = require('../agent/src/netwatch.js');

test('netværk: Word/Python med forbindelse til AI giver rød – lagring gør ikke', () => {
  const C = R.compile();
  const net = {
    conns: [[100, '20.1.1.1', 443], [200, '104.18.33.45', 443], [300, '13.107.42.12', 443], [400, '104.16.1.1', 443]],
    dns: [['copilot.microsoft.com', '20.1.1.1'], ['api.openai.com', '104.18.33.45'], ['onedrive.live.com', '13.107.42.12'],
      ['chatgpt.com', '104.16.1.1'], ['www.dr.dk', '104.16.1.1']], // delt CDN-adresse -> tvetydig
  };
  const found = aiConnections(net, C);
  assert.deepStrictEqual(found.map(f => f.pid).sort(), [100, 200]);
  const r = ev(mk(), { fg: { app: 'WINWORD', title: 'Stil.docx - Word' }, processes: [{ name: 'WINWORD', pid: 100 }, { name: 'python', pid: 200 }, { name: 'OneDrive', pid: 300 }, { name: 'chrome', pid: 400 }], netAi: found });
  assert.strictEqual(color(r), 'red');
  assert.deepStrictEqual(r.violations.map(v => v.text).sort(), ['Python bruger AI (api.openai.com)', 'WINWORD bruger AI (copilot.microsoft.com)']);
});

test('netværk: browsere og HolyMoly selv ignoreres, tvetydige adresser giver aldrig rød', () => {
  const C = R.compile();
  const found = aiConnections({ conns: [[1, '1.1.1.1', 443], [2, '2.2.2.2', 443]], dns: [['chatgpt.com', '1.1.1.1'], ['chatgpt.com', '2.2.2.2'], ['example.com', '2.2.2.2']] }, C);
  assert.deepStrictEqual(found.map(f => f.pid), [1]);
  const r = ev(mk(), { fg: { app: 'WINWORD' }, processes: [{ name: 'chrome', pid: 1 }, { name: 'HolyMoly', pid: 9 }], netAi: [{ pid: 1, host: 'chatgpt.com' }, { pid: 9, host: 'api.openai.com' }] });
  assert.strictEqual(color(r), 'green');
});

test('ChatGPT i et andet synligt browservindue (skærm 2) giver rød og lukkes', () => {
  const r = ev(mk(), { fg: { app: 'WINWORD', title: 'Stil.docx - Word', hwnd: '1' }, windows: [{ hwnd: '2', pid: 55, app: 'msedge', orig: 'msedge', title: 'ChatGPT', url: 'chatgpt.com' }] });
  assert.strictEqual(color(r), 'red');
  assert.strictEqual(r.closeOther[0].pid, 55);
});

test('Mac: ChatGPT i en baggrundsfane i Safari sendes til blokeringssiden', () => {
  const r = ev(mk(), { platform: 'darwin', fg: { app: 'Pages', title: 'Stil' }, macTabs: [{ app: 'Safari', w: 1, t: 3, url: 'https://chatgpt.com/' }, { app: 'Safari', w: 1, t: 1, url: 'https://www.lectio.dk/' }] });
  assert.strictEqual(color(r), 'red');
  assert.deepStrictEqual(r.macBlocks.map(b => b.t), [3]);
});

test('omdøbte programmer genkendes på originalt filnavn / bundle-id', () => {
  // chrome.exe omdøbt til noter.exe
  const r = ev(mk(), { fg: { app: 'noter', orig: 'chrome', title: 'Instagram - Google Chrome', url: 'www.instagram.com', cls: WIN }, extensions: [] });
  assert.strictEqual(color(r), 'red');
  // Roblox omdøbt
  const r2 = ev(mk(), { fg: {}, processes: [{ name: 'matematik', orig: 'RobloxPlayerBeta', pid: 7 }] });
  assert.deepStrictEqual(r2.kill.map(k => k.pid), [7]);
  // Mac: omdøbt Chrome
  const r3 = ev(mk(), { platform: 'darwin', fg: { app: 'Noter', bundle: 'com.google.Chrome', title: 'TikTok', url: 'https://www.tiktok.com/' } });
  assert.strictEqual(color(r3), 'red');
});

test('virtuelle maskiner og Apple Skriveværktøjer', () => {
  assert.strictEqual(color(ev(mk(), { fg: { app: 'VirtualBoxVM', title: 'Windows 11' } })), 'red');
  assert.deepStrictEqual(ev(mk(), { fg: {}, processes: [{ name: 'prl_client_app', pid: 3 }] }).kill.map(k => k.pid), [3]);
  const r = ev(mk(), { platform: 'darwin', fg: { app: 'Pages', title: 'Stil', windowNames: ['Stil', 'Skriveværktøjer'] } });
  assert.strictEqual(color(r), 'red');
  assert.match(r.violations[0].text, /Skriveværktøjer/);
});

test('ukendt browser genkendes på adresselinjen, uanset programnavn', () => {
  const r = ev(mk(), { fg: { app: 'mitprogram', title: 'ChatGPT', url: 'chatgpt.com', addr: 'Address and search bar', cls: WIN } });
  assert.strictEqual(color(r), 'red');
  assert.ok(r.closeBrowser, 'ukendte browsere lukkes');
  // Et Electron-program med et søgefelt er IKKE en browser
  const r2 = ev(mk(), { fg: { app: 'Code', title: 'main.js', url: '', addr: 'Search', cls: WIN } });
  assert.strictEqual(r2.closeBrowser, null);
  assert.strictEqual(color(r2), 'green');
  // Kendte forks: Yandex (browser.exe), Whale, Slimjet
  for (const app of ['browser', 'whale', 'slimjet']) assert.ok(ev(mk(), { fg: { app, title: 'x', cls: WIN } }).closeBrowser, app);
});

test('HolyMoly-vagten: kører den ikke -> grå; manipulation under lektionen -> rød', () => {
  const now = 10_000_000;
  const base = { fg: { app: 'WINWORD', title: 'x' }, now, guardRequired: true, lessonStartedAt: now - 60_000 };
  assert.strictEqual(color(ev(mk(), Object.assign({}, base, { guardStatus: null }))), 'grey');
  assert.strictEqual(color(ev(mk(), Object.assign({}, base, { guardStatus: { fresh: false, tamper: [] } }))), 'grey');
  assert.strictEqual(color(ev(mk(), Object.assign({}, base, { guardStatus: { fresh: true, tamper: [] } }))), 'green');
  const r = ev(mk(), Object.assign({}, base, { guardStatus: { fresh: true, tamper: [{ ts: now - 30_000, what: 'hosts-filen blev ændret under lektionen - sat på plads igen' }] } }));
  assert.strictEqual(color(r), 'red');
  assert.match(r.violations[0].text, /hosts-filen/);
  // Manipulation FØR lektionen (fx derhjemme) tæller ikke
  assert.strictEqual(color(ev(mk(), Object.assign({}, base, { guardStatus: { fresh: true, tamper: [{ ts: now - 120_000, what: 'x' }] } }))), 'green');
});
