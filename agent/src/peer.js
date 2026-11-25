'use strict';
/*
 * Hvem er i den anden ende af en lokal TCP-forbindelse?
 *
 * Bruges til at sikre at det der forbinder til elev-appens bro faktisk ER en browser
 * (ikke et script der udgiver sig for at være HolyMoly-udvidelsen), og til at opdage
 * hvis et andet program har taget HolyMolys port.
 *
 *  Windows: Get-NetTCPConnection (+ originalt filnavn)
 *  macOS/Linux: lsof (+ navnet på den yderste .app-pakke på Mac)
 * Kun tal (porte, pid) indgår i kommandoerne – ingen elevdata.
 */
const { execFile } = require('node:child_process');

function run(cmd, args, timeout = 6000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, out) => resolve(err ? '' : String(out || '')));
  });
}

const port = (p) => {
  const n = Number(p);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('ugyldig port');
  return n;
};

async function winQuery(filter) {
  const script = `$c = Get-NetTCPConnection ${filter} -ErrorAction SilentlyContinue | Select-Object -First 1
if ($c) {
  $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
  $o = ''
  try { $o = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($p.Path).OriginalFilename } catch {}
  @{ pid = [int]$c.OwningProcess; n = [string]$p.ProcessName; o = [string]$o; path = [string]$p.Path } | ConvertTo-Json -Compress
}`;
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]);
  try {
    const j = JSON.parse(out.trim());
    return { pid: Number(j.pid) || 0, name: String(j.n || ''), orig: String(j.o || '').replace(/\.exe$/i, ''), path: String(j.path || '') };
  } catch (e) { return null; }
}

async function lsofQuery(args) {
  const out = await run('lsof', ['-nP', ...args, '-Fpc']);
  const procs = [];
  let cur = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) { cur = { pid: Number(line.slice(1)), name: '' }; procs.push(cur); }
    else if (line.startsWith('c') && cur) cur.name = line.slice(1);
  }
  return procs;
}

async function withPath(p) {
  if (!p) return null;
  const exe = (await run('ps', ['-o', 'comm=', '-p', String(p.pid)])).trim();
  // Mac: "/Applications/Google Chrome.app/Contents/Frameworks/…/Google Chrome Helper.app/…" -> "Google Chrome"
  const app = (exe.match(/\/([^/]+)\.app\//) || [])[1] || '';
  return { pid: p.pid, name: p.name || exe.split('/').pop(), orig: app, path: exe };
}

/** Processen der ejer klient-enden af en forbindelse til vores port. */
async function identifyPeer(remotePort, localPort) {
  remotePort = port(remotePort); localPort = port(localPort);
  if (process.platform === 'win32') {
    return winQuery(`-LocalPort ${remotePort} -RemotePort ${localPort} -State Established`);
  }
  const procs = await lsofQuery([`-iTCP@127.0.0.1:${remotePort}`, '-sTCP:ESTABLISHED']);
  return withPath(procs.find(p => p.pid !== process.pid));
}

/** Processen der lytter på en port (fx en der har taget HolyMolys port). */
async function identifyListener(listenPort) {
  listenPort = port(listenPort);
  if (process.platform === 'win32') {
    return winQuery(`-LocalPort ${listenPort} -State Listen`);
  }
  const procs = await lsofQuery([`-iTCP:${listenPort}`, '-sTCP:LISTEN']);
  return withPath(procs[0]);
}

module.exports = { identifyPeer, identifyListener };
