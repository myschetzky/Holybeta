'use strict';
/*
 * Policy: samler det aktive vindue, kørende programmer og browser-udvidelsens
 * oplysninger til én status. Ren logik uden Electron, så den kan testes.
 *
 * Kun tre tilstande hos læreren – ingen gætterier:
 *   GRØN – HolyMoly har bekræftet hvad der er fremme, og det er tilladt.
 *   RØD  – bekræftet forbudt: adressen på den aktive fane eller programmet i forgrunden.
 *   GRÅ  – overvågningen er ikke komplet (appen lukket, intet live-billede, manglende
 *          tilladelse). Det er "degraded" herunder; serveren viser det som grå.
 *
 * Situationer HolyMoly ikke kan se ind i (fx en browser uden udvidelsen og uden læsbar
 * adresse) bliver ikke farvet – de bliver lukket.
 */

const BROWSER_NAMES = { chrome: 'Chrome', edge: 'Edge', brave: 'Brave', firefox: 'Firefox', opera: 'Opera', vivaldi: 'Vivaldi', arc: 'Arc', safari: 'Safari', other: 'Browser' };
// Browsere hvor HolyMoly-udvidelsen findes (Chromium). Safari på Mac styres via AppleScript.
const EXTENSION_BROWSERS = new Set(['chrome', 'edge', 'brave', 'opera', 'vivaldi', 'arc', 'firefox']);
const KILL_CATEGORIES = new Set(['ai', 'social', 'games', 'video', 'homework', 'remote', 'custom', 'vm']);
const RED_APP_CATEGORIES = new Set(['ai', 'social', 'games', 'video', 'homework', 'remote', 'custom', 'translate', 'vm']);
const SELF_NAMES = new Set(['holymoly', 'holymoly helper', 'holymoly helper (renderer)', 'holymoly helper (gpu)', 'electron']);
const NEVER_KILL = new Set(['explorer', 'finder', 'dock', 'loginwindow', 'systemuiserver', 'windowserver', 'holymoly', 'electron', 'svchost', 'csrss', 'winlogon', 'lsass', 'services', 'system', 'smss', 'wininit', 'dwm', 'launchd', 'kernel_task', 'systemd', 'init', 'xorg', 'gnome-shell', 'kwin_x11', 'kwin_wayland', 'plasmashell']);
const NO_EXTENSION_GRACE_MS = 8000; // tid til at udvidelsen når at forbinde efter browseren startes
const UNSEEN_WINDOW_GRACE_MS = 5000; // tid før et browservindue uden læsbar adresse lukkes
const ATTEMPT_SHOW_MS = 5 * 60_000;

const norm = (s) => String(s || '').toLowerCase().replace(/[​-‏⁠﻿]/g, '').replace(/\s+/g, ' ').trim();
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } };

/** Fjerner " - Google Chrome", " — Mozilla Firefox" osv. fra en vinduestitel. */
function stripBrowserSuffix(title) {
  return String(title || '')
    .replace(/[​-‏⁠﻿]/g, '')
    .replace(/\s+[-—–]\s+(Google Chrome|Chromium|Mozilla Firefox|Firefox|Brave|Opera|Vivaldi|Microsoft\s*Edge|Arc|Safari)\b.*$/i, '')
    .replace(/\s+[-—–]\s+[^-—–]+\s+[-—–]\s+Microsoft\s*Edge$/i, '')
    .replace(/\s+[-—–]\s+(Personal|Personlig|Work|Arbejde|Profile \d+|Profil \d+)$/i, '')
    .trim();
}

function isIncognitoTitle(title) {
  return /(\(Incognito\)|\(Inkognito\)|InPrivate|Private Browsing|Privat browsing|\(Private\)|Privat vindue)/i.test(String(title || ''));
}

/** com.microsoft.Word -> Word */
function prettyBundle(id) {
  const last = String(id || '').split('.').filter(Boolean).pop() || '';
  return last ? last.charAt(0).toUpperCase() + last.slice(1) : '';
}

function prettyApp(name) {
  const n = String(name || '').replace(/\.exe$/i, '');
  return n.charAt(0).toUpperCase() + n.slice(1);
}

/** Adresselinjen viser ofte "chatgpt.com/c/…" uden https:// */
function normalizeAddress(v) {
  const s = String(v || '').trim();
  if (!s || /\s/.test(s)) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/|$)/i.test(s)) return 'https://' + s;
  return '';
}

class Policy {
  constructor() {
    this.rules = null;
    this.config = {};
    this.noExtSince = new Map(); // browser -> ts
    this.unseenKey = '';
    this.unseenSince = 0;
    this.lastUrlByWindow = new Map(); // vindues-nøgle -> sidste bekræftede adresse
    this.lastAttempt = null;
    this.killed = new Map();
  }

  setRules(compiled, config) {
    this.rules = compiled;
    this.config = config || {};
  }

  noteAttempt(text, ts = Date.now()) {
    this.lastAttempt = { text, ts };
  }

  /**
   * input = { fg:{app,title,url,editing,hwnd,pid,cls}, processes:[{name,pid}], extensions:[{browser,windows,tabs}],
   *           screenPermission, accessibility, automationDenied:[browser], monitorBroken, platform, now }
   */
  evaluate(input) {
    const now = input.now || Date.now();
    const R = this.rules;
    const out = { activity: '', url: '', app: '', violations: [], degraded: [], kill: [], closeBrowser: null, closeOther: [], macBlock: null, macBlocks: [], tabs: [], apps: [], extBrowsers: [], netAi: [], notice: '', attempt: null };
    if (!R) return out;
    const fg = input.fg || {};
    const red = (kind, text, category) => {
      if (!out.violations.some(v => v.kind === kind && v.text === text)) out.violations.push({ kind, text, category: category || '' });
    };
    const grey = (kind, text) => { if (!out.degraded.some(d => d.kind === kind)) out.degraded.push({ kind, text }); };

    const exts = input.extensions || [];
    const extensionRequired = Array.isArray(input.extensionIds) && input.extensionIds.length > 0
      && (input.profile || this.config.profile) !== 'skriv';
    out.extBrowsers = [...new Set(exts.map(e => e.browser))];
    for (const e of exts) {
      for (const t of e.tabs || []) {
        const r = R.classifyUrl(t.url);
        out.tabs.push({ url: t.url, title: t.title, active: t.active, browser: e.browser, blocked: !!(r && r.blocked) });
      }
    }
    for (const b of out.extBrowsers) this.noExtSince.delete(b);

    // Dialogbokse (Gem som, Åbn fil, Udskriv …) ejes af browseren, men er ikke browservinduer.
    const isDialog = !!fg.cls && !/^(Chrome_WidgetWin_\d+|MozillaWindowClass)$/.test(fg.cls);
    // Omdøbte programmer: brug originalt filnavn (Windows) / bundle-id (Mac)
    const browserOfProc = (app, orig, bundle) => (bundle && R.browserOfBundle(bundle)) || R.browserOf(orig) || R.browserOf(app);
    let browser = isDialog ? null : browserOfProc(fg.app, fg.orig, fg.bundle);
    // Ukendt program med en adresselinje (læst via UI Automation) = en browser vi ikke kender
    if (!browser && !isDialog && fg.cls && /address|adresse|adressfeld|url|location/i.test(fg.addr || '') && normalizeAddress(fg.url)) browser = 'other';
    out.app = fg.app || '';
    let unseen = false;

    if (browser) {
      const bname = BROWSER_NAMES[browser] || prettyApp(fg.app);
      const mine = exts.filter(e => e.browser === browser);
      const title = stripBrowserSuffix(fg.title);
      const winKey = (fg.hwnd || fg.pid || '') + '|' + browser;

      // 1) Adressen direkte fra browseren (Windows: adresselinjen, Mac: AppleScript)
      let url = normalizeAddress(fg.url);
      if (url) this.lastUrlByWindow.set(winKey, url);
      else if (fg.editing) url = this.lastUrlByWindow.get(winKey) || ''; // eleven skriver i adresselinjen
      // 2) Ellers: den fane udvidelsen ser, hvis vinduets titel passer
      let tabTitle = title;
      if (!url && mine.length) {
        const match = findTab(mine, title);
        if (match) { url = match.url || 'about:blank'; tabTitle = match.title || title; }
      }
      if (this.lastUrlByWindow.size > 200) this.lastUrlByWindow.clear();

      // Browsere med udvidelse SKAL have den installeret – ellers lukkes de (efter kort tid).
      // Kun når udvidelsen findes (appen kender dens id), og ikke i profilen 'skriv'.
      const needsExtension = EXTENSION_BROWSERS.has(browser) && extensionRequired;
      const unsupported = browser === 'other';
      if (unsupported) {
        out.closeBrowser = { app: fg.app, pid: fg.pid, reason: `${bname} kan ikke bruges i lektionen – brug Chrome, Edge, Firefox eller Safari` };
      } else if (needsExtension && !mine.length) {
        if (!this.noExtSince.has(browser)) this.noExtSince.set(browser, now);
        if (now - this.noExtSince.get(browser) > NO_EXTENSION_GRACE_MS) {
          out.closeBrowser = { app: fg.app, pid: fg.pid, reason: `${bname} blev lukket, fordi HolyMoly-udvidelsen ikke er installeret` };
        }
      }

      if (url) {
        out.url = url;
        // En udvidelses egen side (fx HolyMolys "Blokeret"-side) har et id som "værtsnavn" – vis det ikke for læreren
        const extPage = /^(chrome|moz|safari-web)-extension:\/\//i.test(url);
        const host = extPage ? 'Udvidelsesside' : hostOf(url);
        out.activity = (host ? host + ' – ' : '') + (tabTitle || '');
        const r = R.classifyUrl(url);
        if (r && r.blocked) {
          red('site', `${r.label}: ${host}`, r.category);
          if (!mine.length) {
            // Ingen udvidelse til at blokere: HolyMoly lukker selv siden
            if (input.platform === 'darwin' && fg.url) out.macBlock = { app: fg.app, url };
            else if (!out.closeBrowser) out.closeBrowser = { app: fg.app, pid: fg.pid, reason: `${bname} blev lukket: ${r.label} (${host})` };
          }
        }
      } else {
        out.activity = `${bname}: ${title || '…'}`;
        if (input.platform === 'darwin' && (input.automationDenied || []).includes(browser)) {
          grey('automation', `Mangler tilladelse til at læse adressen i ${bname}`);
        } else if (title && !out.closeBrowser && extensionRequired) {
          // Et browservindue hvor adressen ikke kan læses (fx inkognito uden udvidelse)
          unseen = true;
          const key = browser + '|' + norm(title);
          if (this.unseenKey !== key) { this.unseenKey = key; this.unseenSince = now; }
          if (now - this.unseenSince > UNSEEN_WINDOW_GRACE_MS) {
            out.closeBrowser = { app: fg.app, pid: fg.pid, reason: isIncognitoTitle(fg.title) ? `Inkognito-vindue i ${bname} blev lukket` : `Et vindue i ${bname} som HolyMoly ikke kunne se blev lukket` };
          }
        }
      }
    } else if (isDialog && browserOfProc(fg.app, fg.orig, fg.bundle)) {
      out.activity = `${prettyApp(fg.app)}: ${fg.title || 'dialog'}`;
    } else if (fg.app) {
      out.activity = prettyApp(fg.app) + (fg.title && norm(fg.title) !== norm(fg.app) ? ' – ' + fg.title : '');
      const byName = (fg.orig && R.classifyApp(fg.orig)) || R.classifyApp(fg.app); // procesnavnet er et hårdt bevis
      if (byName && byName.blocked && RED_APP_CATEGORIES.has(byName.category)) {
        red('app', `${byName.label}: ${prettyApp(fg.app)}`, byName.category);
      } else if (/^applicationframehost$/i.test(String(fg.app).replace(/\.exe$/i, ''))) {
        // Windows Store-apps (Instagram, TikTok …) kører alle under ApplicationFrameHost – titlen ER appens navn.
        const byTitle = R.classifyApp(fg.app, fg.title);
        if (byTitle && byTitle.blocked && RED_APP_CATEGORIES.has(byTitle.category)) red('app', `${byTitle.label}: ${fg.title}`, byTitle.category);
      }
    } else {
      out.activity = 'Skrivebord';
    }
    if (!unseen) { this.unseenKey = ''; this.unseenSince = 0; }
    // Kun teksten til læreren: en udvidelsesadresse (fx når HolyMolys "Blokeret"-side endnu ikke har fået sin titel,
    // og vinduets titel er adressen) vises som "Udvidelsesside". Titlen bruges IKKE som adresse – en hjemmeside kan
    // selv sætte sin titel til "chrome-extension://…".
    out.activity = out.activity.replace(/\b(?:chrome|moz|safari-web)-extension:\/\/\S*/gi, 'Udvidelsesside');

    // Mac: Apple Intelligence / Skriveværktøjer åbnet i et ellers tilladt program
    for (const wn of fg.windowNames || []) {
      if (R.isAiWindow(wn)) red('ai_tool', `AI-værktøj i ${prettyApp(fg.app)}: ${wn}`, 'ai');
    }

    // Windows: andre synlige browservinduer (fx på skærm 2 eller bag et andet vindue)
    for (const w of input.windows || []) {
      if (fg.hwnd && w.hwnd === fg.hwnd) continue;
      const wb = browserOfProc(w.app, w.orig, '');
      const url = normalizeAddress(w.url);
      if (!wb || !url) continue;
      const r = R.classifyUrl(url);
      if (r && r.blocked) {
        const host = hostOf(url);
        red('site_window', `${r.label}: ${host} (i et andet vindue)`, r.category);
        out.closeOther.push({ app: w.app, pid: w.pid, reason: `${BROWSER_NAMES[wb] || w.app} blev lukket: ${r.label} (${host}) i et andet vindue` });
      }
    }

    // Mac: alle faner i Safari/Chrome/… (også dem der ikke er i front)
    for (const t of input.macTabs || []) {
      const r = R.classifyUrl(t.url);
      if (r && r.blocked) {
        const host = hostOf(t.url);
        red('site_tab', `${r.label}: ${host} (i en anden fane)`, r.category);
        out.macBlocks.push({ app: t.app, w: t.w, t: t.t, url: t.url });
      }
    }

    // Netværk: programmer (ikke browsere) der taler med en AI-tjeneste – fx Word med Copilot,
    // et Python-script mod api.openai.com eller en ukendt AI-app.
    const procByPid = new Map((input.processes || []).map(p => [p.pid, p]));
    for (const c of input.netAi || []) {
      const p = procByPid.get(c.pid) || {};
      const name = p.name || prettyBundle(c.bundle) || ('proces ' + c.pid);
      const lname = String(p.name || '').toLowerCase().replace(/\.exe$/, '');
      if (SELF_NAMES.has(lname) || browserOfProc(p.name, p.orig, c.bundle) || (input.selfPids || []).includes(c.pid)) continue;
      out.netAi.push({ pid: c.pid, name, host: c.host });
      red('ai_net', `${prettyApp(name)} bruger AI (${c.host})`, 'ai');
    }

    // Kørende programmer (også i baggrunden): vises for læreren, forbudte lukkes
    const seen = new Set();
    for (const p of input.processes || []) {
      const name = String(p.name || '');
      const key = name.toLowerCase().replace(/\.exe$/, '');
      if (!key || seen.has(key + ':' + p.pid)) continue;
      seen.add(key + ':' + p.pid);
      const r = (p.orig && R.classifyApp(p.orig)) || R.classifyApp(name);
      if (!r) continue;
      out.apps.push({ name, category: r.category, blocked: r.blocked, pid: p.pid });
      if (r.blocked && this.config.killApps && KILL_CATEGORIES.has(r.category) && !NEVER_KILL.has(key) && !browserOfProc(name, p.orig, '')) {
        const last = this.killed.get(p.pid);
        if (!last || now - last > 15_000) {
          this.killed.set(p.pid, now);
          out.kill.push({ pid: p.pid, name, category: r.category, label: r.label });
        }
      }
    }
    if (this.killed.size > 500) for (const [pid, ts] of this.killed) if (now - ts > 60_000) this.killed.delete(pid);
    const uniq = new Map();
    for (const a of out.apps) if (!uniq.has(a.name.toLowerCase())) uniq.set(a.name.toLowerCase(), a);
    out.apps = [...uniq.values()];

    // Uden disse kan HolyMoly ikke se skærmen -> grå hos læreren
    if (input.screenPermission === false) grey('screen', 'Mangler tilladelse til skærmoptagelse');
    else if (input.captureOk === false) grey('capture', 'Skærmen kan ikke optages');
    if (input.accessibility === false) grey('accessibility', 'Mangler tilladelse under Hjælpefunktioner');
    if (input.monitorBroken) grey('monitor', 'HolyMoly kan ikke se det aktive vindue');
    // HolyMoly-vagten (administrator-/root-tjenesten) skal køre – ellers er overvågningen ikke komplet
    if (input.guardRequired && !(input.guardStatus && input.guardStatus.fresh)) grey('guard', 'HolyMoly-vagten kører ikke');
    // Vagten har opdaget og rettet manipulation under lektionen (fx ændret hosts-fil, slået låsning fra, lukket HolyMoly)
    if (input.guardStatus && Array.isArray(input.guardStatus.tamper)) {
      const since = Math.max(now - 5 * 60_000, input.lessonStartedAt || 0);
      const recent = input.guardStatus.tamper.filter(t => t.ts >= since && t.ts <= now + 60_000);
      if (recent.length) red('guard_tamper', 'Forsøg på at slå HolyMoly fra: ' + recent[recent.length - 1].what, '');
    }
    // Et andet program har taget HolyMolys port til browser-udvidelsen = forsøg på at narre udvidelsen
    if (input.bridgeSquatter) red('bridge_tamper', `Et andet program udgiver sig for at være HolyMoly: ${input.bridgeSquatter}`, '');
    // Mac: netværksfilteret skal være slået til (hvis skolen kræver det)
    if (input.macFilterRequired && input.macFilterState !== 'ok') {
      grey('mac_filter', input.macFilterState === 'unverified' ? 'Netværksfilteret kunne ikke bekræftes' : 'Netværksfilteret er ikke slået til');
    }
    // Et andet program har forsøgt at ændre filterets regler = bevidst manipulation
    if (input.macFilterTamperAt && now - input.macFilterTamperAt < 5 * 60_000) {
      red('filter_tamper', 'Forsøg på at ændre HolyMoly-netværksfilteret', '');
    }
    if (input.minExtensionVersion && (input.extensionVersions || []).some(v => versionLt(v, input.minExtensionVersion))) {
      grey('extension_update', 'Browser-udvidelsen skal opdateres');
    }

    if (this.lastAttempt && now - this.lastAttempt.ts < ATTEMPT_SHOW_MS) out.attempt = this.lastAttempt;
    return out;
  }
}

function findTab(exts, title) {
  const nt = norm(title);
  let best = null;
  for (const e of exts) {
    for (const w of e.windows || []) {
      const a = w.active;
      if (!a) continue;
      const at = norm(a.title);
      const candidates = [at, norm(a.url), norm(hostOf(a.url))].filter(Boolean);
      for (const c of candidates) {
        if (nt === c || (c.length >= 4 && (nt.startsWith(c) || (c.startsWith(nt) && nt.length >= 8)))) {
          if (!best || (w.focused && !best.focused)) best = Object.assign({ focused: w.focused }, a);
        }
      }
      if (!nt && !at) best = best || a;
    }
  }
  return best;
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

/** Farven hos læreren (serveren gør det samme): grå > rød > grøn. */
function colorOf(out) {
  if (out.degraded && out.degraded.length) return 'grey';
  if (out.violations && out.violations.length) return 'red';
  return 'green';
}

module.exports = { Policy, stripBrowserSuffix, findTab, isIncognitoTitle, colorOf, normalizeAddress, versionLt, EXTENSION_BROWSERS };
