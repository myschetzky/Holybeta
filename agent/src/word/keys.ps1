# HolyMoly – "Skriv i Word": tastetælleren.
# Startes af agent/src/word/keys.js, når en Word-økt åbner, og stoppes, når den slutter (stdin lukkes, eller processen dræbes).
# Den tæller KUN, mens det Word-vindue, broen styrer (hwnd fra word.ps1), er i forgrunden.
# Den gemmer ALDRIG hvilke taster: kun kategorier (tegn, slet, indsæt, fortryd, sendt af et program) og tidspunkter til tempoet.
# Hooken kalder altid CallNextHookEx, så Word (og alle andre programmer) får alle taster.
# Ligger i sin egen proces, så antivirus/EDR, der stopper tastaturhooks, kun stopper tællingen – ikke Word-broen.
#
# Protokol (én JSON-linje pr. forespørgsel, kun ASCII):
#   <- { "ready": true, "hook": true|false }                    (første linje: kunne hooken installeres?)
#   -> { "id": 1, "cmd": "get", "hwnd": 123456 }                (Word-vinduet, der tælles i)
#   <- { "id": 1, "ok": true, "keys": { typed, deleted, pasteKeys, injected, undo, keystrokes, maxCps, burst, fastShare, regularity } }
# BEMÆRK: Skrevet og gennemlæst, men ikke kørt på Windows endnu (se docs/WORD.md, manuel testplan).

$ErrorActionPreference = 'Stop'

function Send($o) {
  $j = ConvertTo-Json -InputObject $o -Compress -Depth 6
  $j = [regex]::Replace($j, '[^\x00-\x7F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
  [Console]::Out.WriteLine($j)
  [Console]::Out.Flush()
}

$ok = $false
try {
  Add-Type -TypeDefinition @'
using System;
using System.Collections;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

public static class HMKeys {
  // Kategorier – aldrig hvilken tast
  const int NONE = 0, CHAR = 1, DEL = 2, PASTE = 3, UNDO = 4;
  const int WH_KEYBOARD_LL = 13;
  const uint WM_QUIT = 0x0012;
  const int LLKHF_INJECTED = 0x10;

  delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int ptX; public int ptY; public uint lPrivate; }
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int idHook, HookProc fn, IntPtr hMod, uint threadId);
  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int nCode, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vKey);
  [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr h, uint min, uint max);
  [DllImport("user32.dll")] static extern bool PostThreadMessage(uint threadId, uint msg, IntPtr w, IntPtr l);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);

  static readonly HookProc proc = Hook; // holdes i live (ellers fjerner GC'en delegaten)
  static IntPtr hook = IntPtr.Zero;
  static uint loopThread = 0;
  static long target = 0;                // Word-vinduet (hwnd), der tælles i – 0: intet tælles
  static readonly object gate = new object();

  // Tællere og tider (samme definitioner som skrivevinduet, agent/renderer/write.js)
  static long typed, deleted, pasteKeys, injected, undo, keystrokes, timed, fast;
  static double maxCps, fastShare, regularity = -1;
  static int burst, downsWithoutUp;
  static uint lastKey;
  static bool hasLast;
  static readonly Queue<uint> times = new Queue<uint>();     // tidspunkter for tegn-taster (seneste 5 sek.)
  static readonly Queue<double> gaps = new Queue<double>();  // afstand mellem tastetryk (til jævnhed)

  /** Installerer hooken på sin egen tråd med egen beskedløkke. true: hooken kører. */
  public static bool Start() {
    var ready = new ManualResetEvent(false);
    var t = new Thread(() => {
      loopThread = GetCurrentThreadId();
      hook = SetWindowsHookEx(WH_KEYBOARD_LL, proc, GetModuleHandle(null), 0);
      ready.Set();
      if (hook == IntPtr.Zero) return;
      MSG m;
      while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) { }
      UnhookWindowsHookEx(hook);
      hook = IntPtr.Zero;
    });
    t.IsBackground = true;
    t.Start();
    ready.WaitOne(5000);
    return hook != IntPtr.Zero;
  }

  /** Fjerner hooken (beskedløkken slutter). */
  public static void Stop() {
    if (loopThread != 0) PostThreadMessage(loopThread, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
  }

  // Word-vinduet, der tælles i. Er hwnd et underliggende vindue, bruges topvinduet (det er det, der er i forgrunden).
  public static void SetTarget(long hwnd) {
    long root = hwnd == 0 ? 0 : GetAncestor(new IntPtr(hwnd), 2).ToInt64(); // GA_ROOT
    Interlocked.Exchange(ref target, root != 0 ? root : hwnd);
  }

  // Kaldes af Windows for hver tast. Returnerer ALTID CallNextHookEx: tasten går videre til Word uændret.
  static IntPtr Hook(int nCode, IntPtr wParam, IntPtr lParam) {
    try { if (nCode >= 0) Count(wParam.ToInt64(), lParam); } catch { }
    return CallNextHookEx(hook, nCode, wParam, lParam);
  }

  static bool Held(int vKey) { return (GetAsyncKeyState(vKey) & 0x8000) != 0; }

  static void Count(long msg, IntPtr lParam) {
    bool down = msg == 0x0100 || msg == 0x0104; // WM_KEYDOWN, WM_SYSKEYDOWN
    bool up = msg == 0x0101 || msg == 0x0105;   // WM_KEYUP, WM_SYSKEYUP
    if (!down && !up) return;
    long tg = Interlocked.Read(ref target);
    if (tg == 0 || GetForegroundWindow().ToInt64() != tg) return; // kun Word-dokumentvinduet i forgrunden
    int flags = Marshal.ReadInt32(lParam, 8);
    uint time = unchecked((uint)Marshal.ReadInt32(lParam, 12));
    lock (gate) {
      if (up) { downsWithoutUp = 0; return; }
      if ((flags & LLKHF_INJECTED) != 0) { injected++; return; } // sendt af et program (autotyper, makro) – ikke tastet
      // Tasten bruges kun her til at finde kategorien og gemmes ikke
      int cat = Category(unchecked((uint)Marshal.ReadInt32(lParam, 0)), Held(0x11), Held(0x12), Held(0x10), Held(0x5B) || Held(0x5C));
      if (cat == CHAR) {
        downsWithoutUp++;
        if (downsWithoutUp > 32) return;      // en tast, der holdes nede, tæller højst 32 tegn (fx en streg "-----")
        typed++;
        keystrokes++;
        if (downsWithoutUp <= 2) Tempo(time); // auto-gentag er ikke skrivetempo
      }
      else if (cat == DEL) deleted++;
      else if (cat == PASTE) pasteKeys++;
      else if (cat == UNDO) undo++;
    }
  }

  // Kategorien for et tastetryk. AltGr (Ctrl+Alt) giver tegn på danske tastaturer (@, £, $, {, }, €).
  static int Category(uint vk, bool ctrl, bool alt, bool shift, bool win) {
    if (win) return NONE;
    if (ctrl && !alt) {
      if (vk == 0x56) return PASTE;               // Ctrl+V og Ctrl+Shift+V
      if (vk == 0x5A || vk == 0x59) return UNDO;  // Ctrl+Z, Ctrl+Y
      if (vk == 0x08 || vk == 0x2E) return DEL;   // Ctrl+Backspace/Delete (et ord)
      return NONE;                                // andre genveje
    }
    if (shift && vk == 0x2D) return PASTE;        // Shift+Insert
    if (alt && !ctrl) return vk == 0x08 ? UNDO : NONE; // Alt+Backspace = fortryd; Alt+tast = båndet
    if (vk == 0x08 || vk == 0x2E) return DEL;     // Backspace, Delete
    if (vk == 0x20 || vk == 0x0D || vk == 0x09) return CHAR; // mellemrum, Enter (nyt afsnit), Tab
    if (vk >= 0x30 && vk <= 0x39) return CHAR;    // tal
    if (vk >= 0x41 && vk <= 0x5A) return CHAR;    // bogstaver
    if (vk >= 0x60 && vk <= 0x6F) return CHAR;    // taltastatur
    if (vk >= 0xBA && vk <= 0xC0) return CHAR;    // tegn (æ, ø, komma, punktum …)
    if (vk >= 0xDB && vk <= 0xDF) return CHAR;    // tegn (å, ´, ¨ …)
    if (vk == 0xE2) return CHAR;                  // < > (dansk tastatur)
    return NONE;                                  // piletaster, F-taster, Esc …
  }

  // Tempo som i skrivevinduet: tegn pr. sek. over 5 sek., byger inden for 1 sek., andel < 12 ms og jævnhed
  static void Tempo(uint t) {
    if (hasLast) {
      double g = unchecked(t - lastKey);
      timed++;
      if (g < 12) fast++;                          // hurtigere end en finger kan trykke
      if (g >= 12 && g < 2000) { gaps.Enqueue(g); if (gaps.Count > 600) gaps.Dequeue(); }
      if (timed >= 100) fastShare = Math.Round((double)fast / timed, 3, MidpointRounding.AwayFromZero);
    }
    hasLast = true;
    lastKey = t;
    times.Enqueue(t);
    while (times.Count > 0 && unchecked(t - times.Peek()) > 5000) times.Dequeue();
    if (times.Count > 20) maxCps = Math.Max(maxCps, Math.Round(times.Count / 5.0, 1, MidpointRounding.AwayFromZero));
    int inSec = 0;
    foreach (uint x in times) if (unchecked(t - x) <= 1000) inSec++;
    burst = Math.Max(burst, inSec);
    if (gaps.Count >= 200) {
      double sum = 0, sq = 0;
      foreach (double x in gaps) sum += x;
      double mean = sum / gaps.Count;
      foreach (double x in gaps) sq += (x - mean) * (x - mean);
      regularity = Math.Round(Math.Sqrt(sq / gaps.Count) / mean, 3, MidpointRounding.AwayFromZero);
    }
  }

  /** Tællerne lige nu – kun tal. */
  public static Hashtable Snapshot() {
    lock (gate) {
      var h = new Hashtable();
      h["typed"] = typed; h["deleted"] = deleted; h["pasteKeys"] = pasteKeys; h["injected"] = injected; h["undo"] = undo;
      h["keystrokes"] = keystrokes; h["maxCps"] = maxCps; h["burst"] = burst; h["fastShare"] = fastShare;
      h["regularity"] = regularity < 0 ? null : (object)regularity;
      return h;
    }
  }
}
'@
  $ok = [HMKeys]::Start()
} catch { $ok = $false }

Send @{ ready = $true; hook = $ok }
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if (-not $line.Trim()) { continue }
  $id = 0
  try {
    $req = ConvertFrom-Json $line
    $id = $req.id
    if ([string]$req.cmd -ne 'get') { throw 'Ukendt kommando' }
    if (-not $ok) { throw 'Tastetryk kan ikke tælles på denne computer' }
    [HMKeys]::SetTarget([long]$req.hwnd)
    Send @{ id = $id; ok = $true; keys = [HMKeys]::Snapshot() }
  } catch {
    Send @{ id = $id; ok = $false; error = [string]$_.Exception.Message }
  }
}
# Word-økten er slut (eller HolyMoly lukket): hooken fjernes
try { if ($ok) { [HMKeys]::SetTarget(0); [HMKeys]::Stop() } } catch { }
