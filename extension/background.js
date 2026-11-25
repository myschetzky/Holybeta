/*
 * HolyMoly browser-udvidelse (service worker).
 *
 * Gør kun noget, når HolyMoly-appen på computeren siger at en lektion er i gang.
 * Blokeringen fortsætter til lektionens sluttidspunkt, selv hvis appen lukkes,
 * så det ikke hjælper at lukke appen (det kan læreren desuden se).
 */
'use strict';
// Chrome: service worker (importScripts). Firefox: baggrundsside hvor rules.js allerede er indlæst.
if (typeof importScripts === 'function' && typeof ACRules === 'undefined') importScripts('rules.js');

const PORTS = [47811, 47812, 47813, 47814, 47815];
const BLOCKED_PAGE = chrome.runtime.getURL('blocked.html');
const RULE_ID_BASE = 1000;

let ws = null;
let connecting = false;
let compiled = null;
let current = { active: false };
// Blokeringssiden har en tilfældig adresse pr. session (use_dynamic_url) – genkend den på stien og afsenderen
function isBlockedPage(sender) {
  try { return sender.id === chrome.runtime.id && new URL(sender.url).pathname === '/blocked.html'; } catch (e) { return false; }
}
const redirected = new Map(); // fane-id -> { url, category, ts }: faner vi selv har sendt til blokeringssiden
let pingTimer = null;
let tabsTimer = null;
const lastNav = new Map(); // tabId -> url

function browserName() {
  const ua = navigator.userAgent;
  const brands = (navigator.userAgentData && navigator.userAgentData.brands || []).map(b => b.brand);
  if (/Edg\//.test(ua) || brands.includes('Microsoft Edge')) return 'edge';
  if (/OPR\//.test(ua) || brands.includes('Opera') || brands.includes('Opera GX')) return 'opera';
  if (brands.includes('Brave') || (navigator.brave)) return 'brave';
  if (/Vivaldi/.test(ua)) return 'vivaldi';
  if (/Firefox\//.test(ua)) return 'firefox';
  if (brands.includes('Google Chrome')) return 'chrome';
  if (brands.includes('Chromium')) return 'chrome';
  return 'chrome';
}

/* ---------------- tilstand ---------------- */
async function loadState() {
  const { hm } = await chrome.storage.local.get('hm');
  if (hm && hm.active && hm.endsAt > Date.now()) await applyState(hm, false);
  else await applyState({ active: false }, false);
}

async function applyState(s, persist = true) {
  const active = !!(s && s.active && s.endsAt > Date.now() && s.rules);
  if (active) {
    current = { active: true, endsAt: s.endsAt, rules: s.rules, config: s.config || {}, token: String(s.token || '') };
    compiled = ACRules.compile(current.rules, current.config);
    if (persist) await chrome.storage.local.set({ hm: current });
    chrome.alarms.create('lesson-end', { when: current.endsAt + 1000 });
    await updateDnr();
    await sweepTabs();
    chrome.action.setBadgeText({ text: 'ON' });
    chrome.action.setBadgeBackgroundColor({ color: '#16a34a' });
  } else {
    current = { active: false };
    compiled = null;
    await chrome.storage.local.remove('hm');
    chrome.alarms.clear('lesson-end');
    await clearDnr();
    chrome.action.setBadgeText({ text: '' });
  }
}

/* ---------------- netværksblokering (declarativeNetRequest) ---------------- */
async function clearDnr() {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  if (existing.length) await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: existing.map(r => r.id) });
}

function chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function updateDnr() {
  const domains = [...new Set(compiled.blockedDomainList())];
  const allowed = (current.config.allowed || []).map(ACRules.normHost).filter(Boolean);
  const rules = [];
  let id = RULE_ID_BASE;
  const cond = (c) => { if (allowed.length) { c.excludedRequestDomains = allowed; c.excludedInitiatorDomains = allowed; } return c; };
  const sub = ['sub_frame', 'xmlhttprequest', 'websocket', 'script', 'image', 'media', 'object', 'other', 'ping', 'stylesheet', 'font'];
  for (const part of chunk(domains, 400)) {
    // Hovedside -> vores blokeringsside (med den oprindelige adresse i #)
    rules.push({
      id: id++, priority: 1,
      action: { type: 'redirect', redirect: { regexSubstitution: BLOCKED_PAGE + '#\\0' } },
      condition: cond({ regexFilter: '^https?://.*$', requestDomains: part, resourceTypes: ['main_frame'] }),
    });
    // Alt andet fra de domæner (indlejrede rammer, API-kald, websockets)
    rules.push({
      id: id++, priority: 1, action: { type: 'block' },
      condition: cond({ requestDomains: part, resourceTypes: sub }),
    });
  }
  // Prøvetilstand: kun tilladte sider må åbnes som hovedside
  if (compiled.examMode) {
    const examAllowed = compiled.examAllowedList();
    rules.push({
      id: id++, priority: 1,
      action: { type: 'redirect', redirect: { regexSubstitution: BLOCKED_PAGE + '#\\0' } },
      condition: { regexFilter: '^https?://.*$', excludedRequestDomains: examAllowed.length ? examAllowed : ['invalid.invalid'], resourceTypes: ['main_frame'] },
    });
  }
  // Google Translate-proxy (chatgpt-com.translate.goog osv.)
  const encoded = ACRules.googEncodedHosts(domains.filter(d => d.includes('.')));
  for (const part of chunk(encoded, 40)) {
    const regexFilter = '^https?://(' + part.map(reEscape).join('|') + ')\\.translate\\.goog/';
    if (chrome.declarativeNetRequest.isRegexSupported) {
      const ok = await chrome.declarativeNetRequest.isRegexSupported({ regex: regexFilter });
      if (!ok.isSupported) continue;
    }
    rules.push({ id: id++, priority: 2, action: { type: 'redirect', redirect: { regexSubstitution: BLOCKED_PAGE + '#\\0' } }, condition: { regexFilter: regexFilter + '.*', resourceTypes: ['main_frame'] } });
    rules.push({ id: id++, priority: 2, action: { type: 'block' }, condition: { regexFilter, resourceTypes: sub } });
  }
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: existing.map(r => r.id), addRules: rules });
  } catch (e) {
    console.warn('DNR-fejl', e);
  }
}

/* ---------------- faner ---------------- */
function blockedUrl(url) { return BLOCKED_PAGE + '#' + url; }

async function sweepTabs() {
  if (!compiled) return;
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) checkTab(t.id, t.url, t.title);
}

function checkTab(tabId, url, title) {
  if (!compiled || !url || /^(chrome|moz)-extension:\/\//.test(url)) return false;
  if (!/^https?:/i.test(url)) return false;
  const r = compiled.classifyUrl(url);
  if (r && r.blocked) {
    // Blokeringssiden melder selv forsøget til appen.
    chrome.tabs.update(tabId, { url: blockedUrl(url) }).catch(() => {});
    return true;
  }
  return false;
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (!current.active) return;
  if (info.url) checkTab(tabId, info.url, tab.title);
  if (info.status === 'complete' || info.title) {
    const url = tab.url || '';
    if (/^https?:/i.test(url) && lastNav.get(tabId) !== url + '|' + (tab.title || '')) {
      const prev = lastNav.get(tabId) || '';
      lastNav.set(tabId, url + '|' + (tab.title || ''));
      // Log kun første gang en adresse ses i fanen (titel-opdateringer logges ikke igen)
      if (!prev.startsWith(url + '|')) report({ type: 'nav', url, title: tab.title || '' });
    }
  }
  scheduleTabs();
});
chrome.tabs.onRemoved.addListener((tabId) => { lastNav.delete(tabId); scheduleTabs(); });
chrome.tabs.onActivated.addListener(scheduleTabs);
chrome.tabs.onCreated.addListener(scheduleTabs);
chrome.windows.onFocusChanged.addListener(scheduleTabs);
chrome.windows.onRemoved.addListener(scheduleTabs);

function scheduleTabs() {
  clearTimeout(tabsTimer);
  tabsTimer = setTimeout(sendTabs, 250);
}

async function sendTabs() {
  // Faner deles kun under en lektion (privatliv)
  if (!ws || ws.readyState !== 1 || !current.active) return;
  const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['normal', 'popup', 'app'] });
  const windows = [];
  const tabs = [];
  for (const w of wins) {
    const active = (w.tabs || []).find(t => t.active);
    windows.push({ focused: w.focused, incognito: w.incognito, type: w.type, active: active ? { url: active.url || active.pendingUrl || '', title: active.title || '' } : null });
    for (const t of w.tabs || []) if (tabs.length < 100) tabs.push({ url: t.url || t.pendingUrl || '', title: t.title || '', active: t.active && w.focused });
  }
  send({ type: 'tabs', windows, tabs });
}

/* ---------------- forbindelse til appen ---------------- */
function send(msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}
function report(msg) {
  send(msg);
}

async function connect() {
  if (connecting || (ws && ws.readyState <= 1)) return;
  connecting = true;
  for (const port of PORTS) {
    const sock = await tryPort(port);
    if (sock) { attach(sock); connecting = false; return; }
  }
  connecting = false;
}

function tryPort(port) {
  return new Promise((resolve) => {
    let done = false;
    let sock;
    try { sock = new WebSocket('ws://127.0.0.1:' + port + '/'); } catch (e) { return resolve(null); }
    const t = setTimeout(() => { if (!done) { done = true; try { sock.close(); } catch (e) { /* */ } resolve(null); } }, 1500);
    sock.onopen = () => { if (done) return; done = true; clearTimeout(t); resolve(sock); };
    sock.onerror = () => { if (done) return; done = true; clearTimeout(t); resolve(null); };
  });
}

function attach(sock) {
  ws = sock;
  ws.onmessage = async (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch (err) { return; }
    if (msg.type === 'state') {
      if (msg.active) {
        await applyState(msg);
      } else if (current.active && current.token && msg.token !== current.token) {
        // Kun den app der startede blokeringen kan stoppe den før tid (ellers stopper den ved lektionens slut)
        return;
      } else {
        await applyState({ active: false });
      }
      scheduleTabs();
    }
  };
  ws.onclose = () => {
    ws = null;
    clearInterval(pingTimer);
    setTimeout(connect, 3000);
  };
  chrome.extension.isAllowedIncognitoAccess((incognitoAllowed) => {
    send({ type: 'hello', browser: browserName(), version: chrome.runtime.getManifest().version, incognitoAllowed });
    scheduleTabs();
  });
  // Holder service workeren i live og fortæller appen at vi stadig er her.
  clearInterval(pingTimer);
  pingTimer = setInterval(() => { send({ type: 'ping' }); sendTabs(); }, 15_000);
}

/* ---------------- beskeder fra content scripts ---------------- */
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'blocked' && sender.tab) {
    const url = String(msg.url || '').slice(0, 2000);
    if (msg.top) {
      // Fanen sendes til blokeringssiden, som melder forsøget (med årsag i adressen).
      // Vi husker selv, at vi sendte netop denne fane derhen (så blokeringssiden ikke kan bruges til falske forsøg).
      redirected.set(sender.tab.id, { url, category: String(msg.category || ''), ts: Date.now() });
      chrome.tabs.update(sender.tab.id, { url: blockedUrl(url) + '#hm:' + encodeURIComponent(String(msg.reason || '')) + '|' + encodeURIComponent(String(msg.category || '')) }).catch(() => {});
    } else {
      // Indlejret ramme: logges som ramme (ikke som et forsøg eleven selv har gjort)
      report({ type: 'blocked', url, title: String(msg.title || '').slice(0, 300), category: String(msg.category || ''), reason: 'iframe' });
    }
  } else if (msg.type === 'blockedPage' && isBlockedPage(sender) && sender.frameId === 0) {
    // Kun blokeringssiden som hovedside – en hjemmeside kan ikke "plante" forsøg via en iframe.
    // Adressen vurderes her igen (siden kan ikke selv bestemme kategori eller at noget var forbudt).
    const url = String(msg.url || '').slice(0, 2000);
    const mine = sender.tab && redirected.get(sender.tab.id);
    if (sender.tab) redirected.delete(sender.tab.id);
    if (!current.active) return;
    if (mine && mine.url === url && Date.now() - mine.ts < 60_000) {
      // Vi sendte selv fanen hertil (fx indhold genkendt som Instagram)
      report({ type: 'blocked', url, title: '', category: mine.category, reason: String(msg.reason || '').slice(0, 60) });
    } else {
      // Netværksblokering (adressen selv er forbudt) – vurderes her igen
      const r = compiled ? compiled.classifyUrl(url) : null;
      if (r && r.blocked) report({ type: 'blocked', url, title: '', category: r.category, reason: String(msg.reason || '').slice(0, 60) });
    }
  } else if (msg.type === 'status') {
    respond({ active: current.active, connected: !!(ws && ws.readyState === 1), endsAt: current.endsAt || 0 });
  }
});

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === 'lesson-end') await applyState({ active: false });
  if (a.name === 'keepalive') { connect(); if (current.active && current.endsAt < Date.now()) await applyState({ active: false }); }
});

chrome.runtime.onInstalled.addListener(() => chrome.alarms.create('keepalive', { periodInMinutes: 0.5 }));
chrome.runtime.onStartup.addListener(() => chrome.alarms.create('keepalive', { periodInMinutes: 0.5 }));

loadState().then(connect);
