'use strict';
/*
 * Ser hvad der foregår på computeren – kun mens en lektion er i gang.
 * Bruger kun værktøjer der følger med styresystemet (ingen native moduler).
 *
 *  Windows: én vedvarende PowerShell-proces (user32 + UI Automation + NetTCPIP/DnsClient):
 *    - forgrundsvinduet (program, titel, vinduesklasse, adressen i adresselinjen)
 *    - ALLE synlige browservinduer med deres adresse (også på skærm 2, også inkognito)
 *    - programmernes originale filnavn (fanger omdøbte programmer, fx chrome.exe -> noter.exe)
 *    - netværksforbindelser pr. program + DNS-cache (hvilket program taler med hvilket værtsnavn)
 *  macOS: osascript (System Events + browserens egen AppleScript) og ps
 *  Linux: xprop + /proc (kun til udvikling/test)
 */
const { EventEmitter } = require('node:events');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');

const WIN_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @"
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;
public class HMWin {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  public static List<IntPtr> TopWindows() {
    var list = new List<IntPtr>();
    EnumWindows((h, p) => { if (IsWindowVisible(h) && !IsIconic(h)) list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }
  // Virtuelle skriveborde (Win+Ctrl+→): er et vindue på det skrivebord, eleven ser lige nu? (dokumenteret COM-interface)
  static IVirtualDesktopManager vdm;
  public static int OnCurrentDesktop(IntPtr h) {
    try {
      if (vdm == null) vdm = (IVirtualDesktopManager)new CVirtualDesktopManager();
      int on; return vdm.IsWindowOnCurrentVirtualDesktop(h, out on) == 0 ? (on != 0 ? 1 : 0) : -1;
    } catch { return -1; }
  }
  public static string Text(IntPtr h) { var sb = new StringBuilder(1024); GetWindowText(h, sb, 1024); return sb.ToString(); }
  public static string Cls(IntPtr h) { var sb = new StringBuilder(256); GetClassName(h, sb, 256); return sb.ToString(); }
  public static uint Pid(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
}
[ComImport, Guid("a5cd92ff-29be-454c-8d04-d82879fb3f1b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IVirtualDesktopManager {
  [PreserveSig] int IsWindowOnCurrentVirtualDesktop(IntPtr h, out int on);
  [PreserveSig] int GetWindowDesktopId(IntPtr h, out Guid id);
  [PreserveSig] int MoveWindowToDesktop(IntPtr h, ref Guid id);
}
[ComImport, Guid("aa509086-5ca9-4c25-8f95-589d3c07b48a")] public class CVirtualDesktopManager {}
"@
$selfPid = __HM_PID__
$AE = [System.Windows.Automation.AutomationElement]
$editCond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
$editCache = @{}
$pidCache = @{}
$pathCache = @{}
$notBrowser = @{}
$browserRe = '^(chrome|msedge|brave|vivaldi|opera|firefox|arc|thorium|chromium|iexplore|waterfox|librewolf|floorp|zen)$'
$classRe = '^(Chrome_WidgetWin_\\d+|MozillaWindowClass)$'

function Orig($path) {
  if (-not $path) { return '' }
  if ($pathCache.ContainsKey($path)) { return $pathCache[$path] }
  $o = ''
  try { $o = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($path).OriginalFilename } catch {}
  if (-not $o) { $o = '' }
  $o = ($o -replace '\\.(exe|mui)$', '')
  $pathCache[$path] = $o
  return $o
}
function ProcInfo($procId) {
  $k = [string]$procId
  if ($pidCache.ContainsKey($k)) { return $pidCache[$k] }
  $info = @{ n = ''; o = '' }
  try { $p = Get-Process -Id $procId -ErrorAction Stop; $info.n = $p.ProcessName; $info.o = Orig $p.Path } catch {}
  $pidCache[$k] = $info
  return $info
}
function ReadUrl($h) {
  $key = [string]$h
  $r = @{ url = ''; editing = $false; name = '' }
  try {
    $edit = $editCache[$key]
    if (-not $edit) {
      $edit = $AE::FromHandle($h).FindFirst([System.Windows.Automation.TreeScope]::Descendants, $editCond)
      if ($edit) { $editCache[$key] = $edit }
    }
    if ($edit) {
      $r.name = [string]$edit.Current.Name
      $r.editing = [bool]$edit.Current.HasKeyboardFocus
      $vp = $null
      if ($edit.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) { $r.url = $vp.Current.Value }
    }
  } catch { $editCache.Remove($key) }
  if ($r.editing) { $r.url = '' }
  return $r
}
function IsBrowser($info, $cls) {
  return (($info.n -match $browserRe) -or ($info.o -match $browserRe)) -and ($cls -match $classRe)
}

$i = 0
while ($true) {
  $h = [HMWin]::GetForegroundWindow()
  $title = [HMWin]::Text($h)
  $cls = [HMWin]::Cls($h)
  $fpid = [HMWin]::Pid($h)
  $info = ProcInfo $fpid
  $u = @{ url = ''; editing = $false; name = '' }
  if (IsBrowser $info $cls) { $u = ReadUrl $h }
  elseif ($cls -match $classRe -and -not $notBrowser.ContainsKey([string]$h)) {
    # Ukendt program med browser-vinduesklasse: har det en adresselinje, er det en browser – uanset navnet.
    # Tjekkes kun én gang pr. vindue, så almindelige Electron-programmer (VS Code, Teams …) ikke sløves.
    $u = ReadUrl $h
    if ($u.name -notmatch '(?i)address|adresse|adressfeld|adresí|url|location') { $notBrowser[[string]$h] = 1; $u = @{ url = ''; editing = $false; name = '' } }
    if ($notBrowser.Count -gt 500) { $notBrowser.Clear() }
  }
  [Console]::Out.WriteLine((@{ t = 'fg'; title = $title; pid = $fpid; app = $info.n; orig = $info.o; cls = $cls; hwnd = [string]$h; url = $u.url; editing = $u.editing; addr = $u.name } | ConvertTo-Json -Compress))

  # HolyMolys egne vinduer: er de på det skrivebord, eleven ser? (frys/gennemgang flyttes med, hvis eleven skifter skrivebord)
  $own = @()
  foreach ($w in [HMWin]::TopWindows()) {
    if ([HMWin]::Pid($w) -ne $selfPid) { continue }
    $own += ,@([string]$w, [HMWin]::OnCurrentDesktop($w))
    if ($own.Count -ge 12) { break }
  }
  [Console]::Out.WriteLine((@{ t = 'own'; list = $own } | ConvertTo-Json -Compress -Depth 3))

  # Alle synlige browservinduer (også dem der ikke er i forgrunden, fx på skærm 2)
  if ($i % 3 -eq 0) {
    $wins = @()
    foreach ($w in [HMWin]::TopWindows()) {
      if ($w -eq $h) { continue }
      $wc = [HMWin]::Cls($w)
      if ($wc -notmatch $classRe) { continue }
      $wt = [HMWin]::Text($w)
      if (-not $wt) { continue }
      $wp = [HMWin]::Pid($w)
      $wi = ProcInfo $wp
      if (-not (IsBrowser $wi $wc)) { continue }
      $wu = ReadUrl $w
      $wins += @{ hwnd = [string]$w; pid = $wp; app = $wi.n; orig = $wi.o; title = $wt; url = $wu.url }
      if ($wins.Count -ge 20) { break }
    }
    [Console]::Out.WriteLine((@{ t = 'wins'; list = @($wins) } | ConvertTo-Json -Compress -Depth 3))
  }

  # Kørende programmer (med originalt filnavn)
  if ($i % 8 -eq 0) {
    $procs = Get-Process | Where-Object { $_.Id -ne 0 } | ForEach-Object { @{ n = $_.ProcessName; p = $_.Id; o = (Orig $_.Path) } }
    [Console]::Out.WriteLine((@{ t = 'ps'; list = @($procs) } | ConvertTo-Json -Compress -Depth 3))
    if ($pidCache.Count -gt 2000) { $pidCache.Clear() }
    if ($editCache.Count -gt 100) { $editCache.Clear() }
  }

  # Netværk: hvilke programmer taler med hvilke værtsnavne (DNS-cachen)
  if ($i % 6 -eq 1) {
    $conns = @(Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue | Where-Object { $_.RemoteAddress -notmatch '^(127\\.|::1|0\\.0\\.0\\.0|::$|169\\.254\\.)' } | ForEach-Object { ,@([int]$_.OwningProcess, [string]$_.RemoteAddress, [int]$_.RemotePort) })
    $dns = @(Get-DnsClientCache -ErrorAction SilentlyContinue | Where-Object { $_.Type -eq 1 -or $_.Type -eq 28 } | ForEach-Object { ,@([string]$_.Entry, [string]$_.Data) })
    [Console]::Out.WriteLine((@{ t = 'net'; conns = $conns; dns = $dns } | ConvertTo-Json -Compress -Depth 4))
  }
  [Console]::Out.Flush()
  $i++
  Start-Sleep -Milliseconds 800
}
`;

const MAC_FG_SCRIPT = `
set appName to ""
set bid to ""
set winTitle to ""
set winNames to ""
tell application "System Events"
  set fp to first application process whose frontmost is true
  set appName to name of fp
  set appPid to unix id of fp
  try
    set bid to bundle identifier of fp
  end try
  try
    tell fp to set winTitle to name of front window
  end try
  try
    tell fp
      repeat with w in windows
        set winNames to winNames & (name of w) & (ASCII character 31)
      end repeat
    end tell
  end try
end tell
return appName & (ASCII character 30) & winTitle & (ASCII character 30) & appPid & (ASCII character 30) & bid & (ASCII character 30) & winNames
`;

// AppleScript pr. browser – køres kun for browsere der kører (ellers ville macOS starte dem)
const MAC_BROWSERS = { 'Safari': 'safari', 'Google Chrome': 'chrome', 'Microsoft Edge': 'edge', 'Brave Browser': 'brave', 'Arc': 'arc', 'Vivaldi': 'vivaldi', 'Chromium': 'chrome' };
function macUrlScript(app) {
  return app === 'Safari'
    ? 'tell application "Safari" to return URL of front document'
    : `tell application "${app}" to return URL of active tab of front window`;
}
function macTabsScript(app) {
  return `set out to ""
tell application "${app}"
  repeat with wi from 1 to count of windows
    try
      set ts to tabs of window wi
      repeat with ti from 1 to count of ts
        set out to out & wi & (ASCII character 9) & ti & (ASCII character 9) & (URL of item ti of ts) & linefeed
      end repeat
    end try
  end repeat
end tell
return out`;
}

class Monitor extends EventEmitter {
  constructor() {
    super();
    this.fg = { app: '', title: '', pid: 0, url: '' };
    this.processes = [];
    this.windows = []; // andre synlige browservinduer (Windows)
    this.macTabs = []; // alle faner i Safari/Chrome/… (Mac)
    this.net = null; // { conns: [[pid, ip, port]], dns: [[name, ip]], ts }
    this.automationDenied = new Set();
    this.stopped = true;
    this.child = null;
    this.timers = [];
  }

  start() {
    this.stopped = false;
    if (process.platform === 'win32') this._startWindows();
    else if (process.platform === 'darwin') this._startMac();
    else this._startLinux();
  }

  stop() {
    this.stopped = true;
    this.timers.forEach(clearInterval);
    this.timers = [];
    if (this.child) { try { this.child.kill(); } catch (e) { /* */ } this.child = null; }
    // Intet gammelt data fra forrige lektion (ellers kan forkerte vinduer/PID'er blive vurderet ved næste start)
    this.fg = { app: '', title: '', url: '', pid: 0 };
    this.lastFgAt = 0;
    this.windows = [];
    this.processes = [];
    if (this.macTabs) this.macTabs = [];
  }

  _setFg(fg) {
    const changed = fg.app !== this.fg.app || fg.title !== this.fg.title || fg.url !== this.fg.url;
    this.fg = fg;
    this.lastFgAt = Date.now();
    if (changed) this.emit('foreground', fg);
  }

  _setProcs(list) {
    this.processes = list;
    this.emit('processes', list);
  }

  /* ---------------- Windows ---------------- */
  _startWindows() {
    const encoded = Buffer.from(WIN_SCRIPT.replace('__HM_PID__', String(process.pid)), 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    this.child = child;
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) this._winLine(line);
      }
      if (buf.length > 4_000_000) buf = '';
    });
    child.on('exit', () => {
      if (this.child !== child) return; // en gammel PowerShell fra før stop/start
      this.child = null;
      // Genstart hvis PowerShell dør (eller bliver dræbt af eleven) – det logges som manipulation.
      if (!this.stopped) setTimeout(() => !this.stopped && this._startWindows(), 1500);
      this.emit('monitor-restart');
    });
  }

  _winLine(line) {
    let m;
    try { m = JSON.parse(line); } catch (e) { return; }
    // ConvertTo-Json gør lister med ét element til et enkelt objekt
    const arr = (v) => (Array.isArray(v) ? v : v ? [v] : []);
    const pairs = (v) => (Array.isArray(v) && v.length && !Array.isArray(v[0]) ? [v] : arr(v));
    if (m.t === 'fg') {
      this._setFg({ app: String(m.app || ''), orig: String(m.orig || ''), title: String(m.title || ''), pid: Number(m.pid) || 0, url: String(m.url || ''), editing: !!m.editing, cls: String(m.cls || ''), hwnd: String(m.hwnd || ''), addr: String(m.addr || '') });
    } else if (m.t === 'wins') {
      this.windows = arr(m.list).map(w => ({ hwnd: String(w.hwnd || ''), pid: Number(w.pid) || 0, app: String(w.app || ''), orig: String(w.orig || ''), title: String(w.title || ''), url: String(w.url || '') }));
    } else if (m.t === 'ps') {
      this._setProcs(arr(m.list).map(p => ({ name: String(p.n || ''), orig: String(p.o || ''), pid: Number(p.p) || 0 })));
    } else if (m.t === 'own') {
      // [[hwnd, 1 = på det aktive skrivebord / 0 = på et andet / -1 = ukendt], …]
      this.emit('own-windows', pairs(m.list).map(x => ({ hwnd: String(x[0] || ''), onCurrent: Number(x[1]) })));
    } else if (m.t === 'net') {
      this.net = { conns: pairs(m.conns), dns: pairs(m.dns), ts: Date.now() };
    }
  }

  /* ---------------- macOS ---------------- */
  _osa(script, timeout = 4000) {
    return new Promise((resolve) => {
      execFile('osascript', ['-e', script], { timeout }, (err, stdout) => resolve({ err, out: String(stdout || '') }));
    });
  }

  _startMac() {
    let busy = false;
    const pollFg = async () => {
      if (busy || this.stopped) return;
      busy = true;
      try {
        const { err, out } = await this._osa(MAC_FG_SCRIPT);
        if (err) {
          if (/not allowed|-1743|-25211|assistive/i.test(String(err.message))) this.emit('permission', 'accessibility');
          return;
        }
        // Felter adskilt af ASCII 30 og vinduesnavne af ASCII 31 – tegn der ikke forekommer i titler
        const [app, title, pid, bid, winNames] = out.replace(/\n$/, '').split('\x1e');
        let url = '';
        if (MAC_BROWSERS[app]) {
          const r = await this._osa(macUrlScript(app), 3000);
          if (r.err) {
            // -1743 = eleven har ikke givet HolyMoly lov til at styre browseren (Automatisering)
            if (/-1743/.test(String(r.err.message))) this.automationDenied.add(MAC_BROWSERS[app]);
          } else {
            url = r.out.trim();
            this.automationDenied.delete(MAC_BROWSERS[app]);
          }
        }
        this._setFg({ app: app || '', bundle: bid || '', title: title || '', pid: Number(pid) || 0, url, editing: false, cls: '', hwnd: '', windowNames: String(winNames || '').split('\x1f').filter(Boolean) });
      } finally {
        busy = false;
      }
    };
    // Alle faner i kørende browsere (fx ChatGPT i et Safari-vindue på skærm 2)
    let tabsBusy = false;
    const pollTabs = async () => {
      if (tabsBusy || this.stopped) return;
      tabsBusy = true;
      try {
        const running = new Set(this.processes.map(p => p.orig || p.name));
        const tabs = [];
        for (const app of Object.keys(MAC_BROWSERS)) {
          if (!running.has(app)) continue;
          const r = await this._osa(macTabsScript(app), 4000);
          if (r.err) continue;
          for (const line of r.out.split('\n')) {
            const [w, t, url] = line.split('\t');
            if (url) tabs.push({ app, w: Number(w), t: Number(t), url: url.trim() });
          }
        }
        this.macTabs = tabs;
      } finally {
        tabsBusy = false;
      }
    };
    this.timers.push(setInterval(pollFg, 1000));
    this.timers.push(setInterval(pollTabs, 3000));
    this._startPs(true);
    pollFg();
  }

  /* ---------------- Linux (udvikling/test) ---------------- */
  _startLinux() {
    let busy = false;
    const pollFg = () => {
      if (busy || this.stopped) return;
      busy = true;
      execFile('xprop', ['-root', '_NET_ACTIVE_WINDOW'], { timeout: 2000 }, (err, out) => {
        const m = !err && String(out).match(/window id # (0x[0-9a-f]+)/i);
        if (!m || m[1] === '0x0') { busy = false; this._setFg({ app: '', title: '', pid: 0, url: '' }); return; }
        execFile('xprop', ['-id', m[1], '_NET_WM_NAME', '_NET_WM_PID', 'WM_CLASS'], { timeout: 2000 }, (err2, out2) => {
          busy = false;
          if (err2) return;
          const s = String(out2);
          const title = (s.match(/_NET_WM_NAME\(\w+\) = "(.*)"/) || [])[1] || '';
          const pid = Number((s.match(/_NET_WM_PID\(CARDINAL\) = (\d+)/) || [])[1]) || 0;
          const cls = (s.match(/WM_CLASS\(STRING\) = "[^"]*", "([^"]*)"/) || [])[1] || '';
          let app = cls;
          try { if (pid) app = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim() || cls; } catch (e) { /* */ }
          this._setFg({ app, title: title.replace(/\\"/g, '"'), pid, url: '' });
        });
      });
    };
    this.timers.push(setInterval(pollFg, 1000));
    this._startPs(false);
    pollFg();
  }

  _startPs(mac) {
    const poll = () => {
      execFile('ps', ['-axo', 'pid=,comm='], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
        if (err) return;
        const list = [];
        for (const line of String(out).split('\n')) {
          const m = line.trim().match(/^(\d+)\s+(.+)$/);
          if (!m) continue;
          const full = m[2];
          // macOS: navnet på .app-pakken afslører en omdøbt binærfil (…/Google Chrome.app/Contents/MacOS/x)
          const bundle = mac ? ((full.match(/\/([^/]+)\.app\/Contents\/MacOS\//) || [])[1] || '') : '';
          list.push({ name: full.split('/').pop(), orig: bundle, pid: Number(m[1]) });
        }
        this._setProcs(list);
      });
    };
    this.timers.push(setInterval(poll, 8000));
    poll();
  }
}

function killProcess(pid) {
  return new Promise((resolve) => {
    if (!pid || pid === process.pid) return resolve(false);
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, (err) => resolve(!err));
    } else {
      try { process.kill(pid, 'SIGTERM'); resolve(true); } catch (e) { resolve(false); }
    }
  });
}

/** Lukker en browser/et program (bruges når HolyMoly ikke kan se ind i det). */
function closeApp(target) {
  return new Promise((resolve) => {
    if (process.platform === 'darwin' && target.app && /^[\w .+-]+$/.test(target.app)) {
      // Pæn lukning først, så eleven ikke mister faner; ellers dræbes processen.
      execFile('osascript', ['-e', `tell application "${target.app}" to quit`], { timeout: 4000 }, (err) => {
        if (!err) return resolve(true);
        killProcess(target.pid).then(resolve);
      });
    } else {
      killProcess(target.pid).then(resolve);
    }
  });
}

/** macOS: sender en fane i Safari/Chrome/… videre til blokeringssiden. */
function macRedirect(appName, target, w, t) {
  return new Promise((resolve) => {
    if (process.platform !== 'darwin' || !MAC_BROWSERS[appName] || !/^https?:\/\/[^"\\]+$/.test(target)) return resolve(false);
    let script;
    if (w && t) script = `tell application "${appName}" to set URL of tab ${Number(t)} of window ${Number(w)} to "${target}"`;
    else if (appName === 'Safari') script = `tell application "Safari" to set URL of front document to "${target}"`;
    else script = `tell application "${appName}" to set URL of active tab of front window to "${target}"`;
    execFile('osascript', ['-e', script], { timeout: 4000 }, (err) => resolve(!err));
  });
}

module.exports = { Monitor, killProcess, closeApp, macRedirect, MAC_BROWSERS, WIN_SCRIPT };
