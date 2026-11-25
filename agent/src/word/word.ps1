# HolyMoly – "Skriv i Word": broen til Word via COM (Word.Application).
# Startes af agent/src/word/bridge.js. Læser én JSON-linje pr. forespørgsel på stdin og svarer med én JSON-linje.
# Protokollen står i bridge.js. Al tekst ud er ASCII (\uXXXX), så konsollens tegnsæt er ligegyldigt.
# HolyMoly læser kun teksten i det dokument, eleven har åbnet gennem HolyMoly – aldrig andre dokumenter.
# Lukker HolyMoly, lukkes Word IKKE (elevens tekst må aldrig gå tabt).
# BEMÆRK: Skrevet og gennemlæst, men ikke kørt på Windows med Word endnu (se docs/WORD.md, manuel testplan).

$ErrorActionPreference = 'Stop'

try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class HMWord {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
} catch { }
# Fysiske pixels (Electron omregner selv til sit eget koordinatsystem med screen.screenToDipRect)
try { [void][HMWord]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { try { [void][HMWord]::SetProcessDPIAware() } catch { } }

$script:word = $null
$script:doc = $null
$script:hwnd = [IntPtr]::Zero
$script:copilot = 'unknown'
$script:copilotAt = [DateTime]::MinValue

function Send($o) {
  $j = ConvertTo-Json -InputObject $o -Compress -Depth 6
  $j = [regex]::Replace($j, '[^\x00-\x7F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
  [Console]::Out.WriteLine($j)
  [Console]::Out.Flush()
}

function Test-Word {
  try { return (Test-Path 'Registry::HKEY_CLASSES_ROOT\Word.Application\CLSID') } catch { return $false }
}
function Get-WordVersion {
  try { return [string](Get-ItemProperty -Path 'Registry::HKEY_CLASSES_ROOT\Word.Application\CurVer' -ErrorAction Stop).'(default)' } catch { return '' }
}

# Copilot i Word: læs skolens Office-politikker (se docs/WORD.md).
#  - HKCU/HKLM\Software\Policies\Microsoft\office\16.0\common\privacy
#      disconnectedstate   = 2  -> alle forbundne oplevelser er slået fra (Copilot kan ikke bruges)
#      usercontentdisabled = 2  -> "oplevelser, der analyserer indhold" er slået fra (Copilot kan ikke bruges i Word)
#      usercontentdisabled = 1  -> IT har udtrykkeligt tilladt dem: Copilot kan bruges, hvis eleven har adgang
#  - Office LTSC 2019/2021/2024 (volumenlicens) har ikke Copilot.
# Alt andet: 'unknown'. Læses højst hvert 30. sek.
function Get-Policy($name) {
  foreach ($root in @('Registry::HKEY_CURRENT_USER\Software\Policies\Microsoft\office\16.0\common\privacy', 'Registry::HKEY_LOCAL_MACHINE\Software\Policies\Microsoft\office\16.0\common\privacy')) {
    try {
      $v = (Get-ItemProperty -Path $root -Name $name -ErrorAction Stop).$name
      if ($null -ne $v) { return [int]$v }
    } catch { }
  }
  return $null
}
function Get-Copilot {
  if (([DateTime]::UtcNow - $script:copilotAt).TotalSeconds -lt 30) { return $script:copilot }
  $state = 'unknown'
  try {
    $dis = Get-Policy 'disconnectedstate'
    $uc = Get-Policy 'usercontentdisabled'
    if ($dis -eq 2 -or $uc -eq 2) { $state = 'off' }
    elseif ($uc -eq 1) { $state = 'on' }
    else {
      try {
        $ids = [string](Get-ItemProperty -Path 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Office\ClickToRun\Configuration' -ErrorAction Stop).ProductReleaseIds
        $list = @($ids -split ',' | Where-Object { $_ })
        if ($list.Count -gt 0 -and -not ($list | Where-Object { $_ -notmatch '20(19|21|24)Volume' })) { $state = 'off' }
      } catch { }
    }
  } catch { }
  $script:copilot = $state
  $script:copilotAt = [DateTime]::UtcNow
  return $state
}

function Get-WordApp {
  if ($null -ne $script:word) {
    try { [void]$script:word.Version; return $script:word } catch { $script:word = $null }
  }
  $script:word = New-Object -ComObject Word.Application
  $script:word.Visible = $true
  return $script:word
}

# Er dokumentet stadig åbent? (Eleven kan lukke det eller hele Word.)
function Test-Doc {
  if ($null -eq $script:doc) { return $false }
  try { [void]$script:doc.FullName; return $true } catch { $script:doc = $null; $script:hwnd = [IntPtr]::Zero; return $false }
}

function Get-Hwnd {
  try { $h = [IntPtr][long]$script:doc.ActiveWindow.Hwnd; if ($h -ne [IntPtr]::Zero) { $script:hwnd = $h } } catch { }
  return $script:hwnd
}

function Get-Rect($h) {
  if ($h -eq [IntPtr]::Zero) { return $null }
  $r = New-Object HMWord+RECT
  $ok = $false
  # DWMWA_EXTENDED_FRAME_BOUNDS (9): den synlige ramme uden usynlige kanter
  try { $ok = ([HMWord]::DwmGetWindowAttribute($h, 9, [ref]$r, 16) -eq 0) } catch { $ok = $false }
  if (-not $ok) { if (-not [HMWord]::GetWindowRect($h, [ref]$r)) { return $null } }
  return @{ x = $r.Left; y = $r.Top; w = $r.Right - $r.Left; h = $r.Bottom - $r.Top }
}

function Test-Foreground($h) {
  if ($h -eq [IntPtr]::Zero) { return $false }
  try {
    $fg = [HMWord]::GetForegroundWindow()
    if ($fg -eq $h) { return $true }
    $a = 0; $b = 0
    [void][HMWord]::GetWindowThreadProcessId($fg, [ref]$a)
    [void][HMWord]::GetWindowThreadProcessId($h, [ref]$b)
    return ($a -ne 0 -and $a -eq $b) # en dialog i Word (fx Skrifttype) tæller som Word
  } catch { return $false }
}

function Set-Footer($d, $lines, $green) {
  $text = ($lines -join "`r")
  foreach ($sec in $d.Sections) {
    foreach ($kind in 1, 2, 3) { # wdHeaderFooterPrimary, FirstPage, EvenPages
      $f = $sec.Footers.Item($kind)
      if ($kind -ne 1 -and -not $f.Exists) { continue }
      $f.LinkToPrevious = $false
      $f.Range.Text = $text
      $f.Range.Font.Size = 8
      $f.Range.Font.Color = 7500395 # 6B7280 som BGR
      $f.Range.Font.Bold = $false
      try {
        $p = $f.Range.Paragraphs.Item(1).Range
        $p.Font.Bold = $true
        if ($green) { $p.Font.Color = 4030485 } # 15803D som BGR
      } catch { }
    }
  }
}

function Invoke-Cmd($req) {
  switch ([string]$req.cmd) {
    'probe' { return @{ word = (Test-Word); version = (Get-WordVersion) } }
    'open' {
      $p = [string]$req.path
      if (-not $p) { throw 'Ingen sti' }
      $w = Get-WordApp
      if ($req.create) {
        $d = $w.Documents.Add()
        $d.SaveAs2($p, 16) # wdFormatDocumentDefault (.docx)
      } else {
        $d = $w.Documents.Open($p, $false, $false, $false)
      }
      try { $d.TrackRevisions = $false } catch { }
      $script:doc = $d
      $script:hwnd = [IntPtr]::Zero
      try { $d.Activate() } catch { }
      try { $w.Activate() } catch { }
      $h = Get-Hwnd
      if ($h -ne [IntPtr]::Zero) { [void][HMWord]::SetForegroundWindow($h) }
      return @{ path = [string]$d.FullName }
    }
    'state' {
      if (-not (Test-Doc)) { return @{ open = $false } }
      $d = $script:doc
      $h = Get-Hwnd
      $min = $false
      try { $min = [HMWord]::IsIconic($h) } catch { }
      return @{
        open = $true; path = [string]$d.FullName; text = [string]$d.Content.Text; saved = [bool]$d.Saved
        minimized = $min; rect = $(if ($min) { $null } else { Get-Rect $h }); foreground = (-not $min -and (Test-Foreground $h)); copilot = (Get-Copilot)
      }
    }
    'save' {
      if (-not (Test-Doc)) { throw 'Dokumentet er ikke åbent i Word' }
      $script:doc.Save()
      return @{ path = [string]$script:doc.FullName; saved = [bool]$script:doc.Saved }
    }
    'seal' {
      if (-not (Test-Doc)) { throw 'Dokumentet er ikke åbent i Word' }
      $p = [string]$req.path
      if (-not $p -or -not $req.password) { throw 'Mangler sti eller adgangskode' }
      $d = $script:doc
      $d.Save()
      Set-Footer $d @($req.footerLines) ([bool]$req.green)
      $d.Protect(3, $false, [string]$req.password) # wdAllowOnlyReading: kan ikke redigeres uden adgangskoden
      $d.SaveAs2($p, 16)
      $d.Close(0) # wdDoNotSaveChanges (er lige gemt)
      $script:doc = $null
      $script:hwnd = [IntPtr]::Zero
      try { if ($script:word.Documents.Count -eq 0) { $script:word.Quit(); $script:word = $null } } catch { }
      return @{ path = $p }
    }
    'close' {
      if (Test-Doc) {
        if ($req.save) { $script:doc.Save() }
        $script:doc.Close($(if ($req.save) { -1 } else { 0 }))
      }
      $script:doc = $null
      $script:hwnd = [IntPtr]::Zero
      return @{ }
    }
    default { throw 'Ukendt kommando' }
  }
}

Send @{ ready = $true; word = (Test-Word); version = (Get-WordVersion) }
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if (-not $line.Trim()) { continue }
  $id = 0
  try {
    $req = ConvertFrom-Json $line
    $id = $req.id
    $res = Invoke-Cmd $req
    $res.id = $id
    $res.ok = $true
    Send $res
  } catch {
    $msg = [string]$_.Exception.Message
    # Word har en dialog åben (eller er optaget): prøv igen om lidt
    if ($msg -match '0x80010001|0x8001010A|afvist|rejected|busy') { $msg = 'Word er optaget' }
    Send @{ id = $id; ok = $false; error = $msg }
  }
}
# HolyMoly er lukket: slip Word (uden at lukke elevens dokument)
try { if ($null -ne $script:doc) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($script:doc) } } catch { }
try { if ($null -ne $script:word) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($script:word) } } catch { }
