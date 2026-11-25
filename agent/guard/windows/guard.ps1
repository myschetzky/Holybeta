# HolyMoly-vagten (Windows). Kører som SYSTEM og kan ikke stoppes af almindelige brugere.
#
#  - Låser browserne: ingen inkognito/InPrivate, gæster, nye profiler eller "sikker DNS"-omgåelse,
#    og tvangsinstallerer HolyMolys browser-del (så den ikke kan fjernes eller slås fra).
#  - Taler DIREKTE med HolyMoly-serveren (ikke gennem elev-appen) med en nøgle i computerens
#    TPM-chip, som kun SYSTEM kan bruge. Lektion, blokeringsliste og "luk dette program" kommer
#    fra serveren. Vagten melder hvilke programmer der kører, hvem der taler med AI-tjenester og
#    hvilket program der er forbundet til HolyMoly (en falsk klient bliver opdaget).
#  - Under en lektion: blokerer forbudte sider for HELE computeren via hosts-filen.
#  - Starter elev-appen igen, hvis den lukkes eller dræbes.
#  - Sætter alt på plads igen, hvis nogen piller ved det, og noterer det (læreren ser rød).
#  - Skriver sin status til guard-status.json (kun administrator kan ændre den).
param(
  [switch]$Once,
  [switch]$NoTray,
  [string]$DataDir = '',
  [string]$ServerUrl = '',
  [string]$HostsFile = (Join-Path $env:SystemRoot 'System32\drivers\etc\hosts')
)
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'common.ps1')
if (-not $DataDir) { $DataDir = $HMDataDefault }

$Version = '1.3.0'
$GuardDir = Split-Path -Parent $PSScriptRoot             # ...\resources\guard
$InstallDir = Split-Path -Parent (Split-Path -Parent $GuardDir)
$StatusFile = Join-Path $DataDir 'guard-status.json'
$StateFile = Join-Path $DataDir 'guard-state.json'
$PairFile = Join-Path $DataDir 'requests\pair.txt'
$ConfigFile = Join-Path $GuardDir 'config.json'
$Baseline = Join-Path $GuardDir 'baseline-hosts.txt'
$ExtFile = Join-Path $GuardDir 'extensions.json'
$HostRe = '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
# Microsoft-domæner skrives ikke i hosts (Windows Defender opfatter det som manipulation) –
# de dækkes af netværksovervågningen og browser-delen i stedet.
$NeverHosts = '(^|\.)(microsoft\.com|bing\.com|cloud\.microsoft|live\.com|office\.com|windows\.com|msn\.com)$'
$MaxLessonMs = 6 * 3600 * 1000

function Load-State {
  $s = @{ rejects = 0; lastHostsOk = $true; lastPoliciesOk = $true; policiesApplied = $false; tasksOk = $false; lessonUntil = 0; lessonHosts = @(); blockHash = ''; writtenHash = ''; tamper = @(); lastTray = 0; trayRelaunches = 0; paired = @(); seq = 0; nextBeat = 0; lastError = ''; notes = @() }
  if (Test-Path $StateFile) {
    try {
      $j = Get-Content $StateFile -Raw | ConvertFrom-Json
      foreach ($k in @($s.Keys)) { if ($null -ne $j.$k) { $s[$k] = $j.$k } }
      $s.lessonHosts = @($s.lessonHosts); $s.tamper = @($s.tamper); $s.paired = @($s.paired); $s.notes = @($s.notes)
    } catch { }
  }
  return $s
}

function Save-Json($obj, [string]$file) {
  $tmp = "$file.tmp"
  ($obj | ConvertTo-Json -Depth 4 -Compress) | Set-Content -Path $tmp -Encoding UTF8
  Move-Item -Force -Path $tmp -Destination $file
}

function Add-Tamper($state, [string]$what) {
  $list = @($state.tamper) + @(@{ ts = (HM-NowMs); what = $what })
  if ($list.Count -gt 20) { $list = $list[($list.Count - 20)..($list.Count - 1)] }
  $state.tamper = $list
}

# Bemærkning (logges hos læreren, men giver ikke rød): ting der også kan ske uden snyd,
# fx at skolens GPO/Intune skriver browser-politikkerne om, eller at HolyMoly genstartes efter et nedbrud
function Add-Note($state, [string]$what) {
  $list = @($state.notes) + @(@{ ts = (HM-NowMs); what = $what })
  if ($list.Count -gt 20) { $list = $list[($list.Count - 20)..($list.Count - 1)] }
  $state.notes = $list
}

function Set-Reg([string]$path, [string]$name, $value, [string]$type) {
  if (-not (Test-Path $path)) { New-Item -Path $path -Force | Out-Null }
  $cur = (Get-ItemProperty -Path $path -Name $name -ErrorAction SilentlyContinue).$name
  if ("$cur" -ne "$value") {
    New-ItemProperty -Path $path -Name $name -Value $value -PropertyType $type -Force | Out-Null
    return 1
  }
  return 0
}

function Ensure-Policies {
  $changed = 0
  foreach ($p in $HMPolicyValues) { $changed += Set-Reg $p.Key $p.Name $p.Value $p.Type }
  # Tvangsinstallér HolyMolys browser-del (kræver at den er udgivet i Chrome Web Store / Edge Add-ons / Firefox Add-ons)
  if (Test-Path $ExtFile) {
    try { $ext = Get-Content $ExtFile -Raw | ConvertFrom-Json } catch { $ext = $null }
    if ($ext) {
      if ($ext.chrome) {
        $changed += Set-Reg 'HKLM:\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist' '1' $ext.chrome 'String'
        $changed += Set-Reg 'HKLM:\SOFTWARE\Policies\BraveSoftware\Brave\ExtensionInstallForcelist' '1' $ext.chrome 'String'
      }
      if ($ext.edge) { $changed += Set-Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallForcelist' '1' $ext.edge 'String' }
      if ($ext.firefox) {
        $json = '{"udvidelse@holymoly.dk":{"installation_mode":"force_installed","install_url":"' + $ext.firefox + '"}}'
        $changed += Set-Reg 'HKLM:\SOFTWARE\Policies\Mozilla\Firefox' 'ExtensionSettings' $json 'String'
      }
    }
  }
  return $changed
}

function Ensure-Tasks {
  $missing = 0
  foreach ($name in @('Vagt', 'Elev-app')) {
    $t = Get-ScheduledTask -TaskPath $HMTaskPath -TaskName $name -ErrorAction SilentlyContinue
    if (-not $t -or $t.State -eq 'Disabled') { $missing++ }
  }
  if ($missing -gt 0) { HM-RegisterTasks $InstallDir }
  return $missing
}

# ---------------------------------------------------------------- server + nøgle
$script:Ecdsa = $null
$script:KeyStore = ''
$script:OrigCache = @{}

$ServerFile = Join-Path $DataDir 'server.txt'            # skolens serveradresse (kun administrator/vagten kan skrive)
$ServerReq = Join-Path $DataDir 'requests\server.txt'    # elev-appens ønske første gang (bruges kun, hvis ingen adresse er sat)
$ServerRe = '^(https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?|http://(127\.0\.0\.1|localhost)(:\d{1,5})?)$'

function HM-Config {
  $c = @{ serverUrl = ''; publisher = '' }
  if (Test-Path $ConfigFile) { try { $j = Get-Content $ConfigFile -Raw | ConvertFrom-Json; $c.serverUrl = "$($j.serverUrl)"; $c.publisher = "$($j.publisher)" } catch { } }
  # Adressen fra skolens IT (installationen med /SERVER=) eller den første opsætning vinder over den indbyggede
  if (Test-Path $ServerFile) { try { $s = (Get-Content $ServerFile -TotalCount 1).Trim().ToLower().TrimEnd('/'); if ($s -match $ServerRe) { $c.serverUrl = $s } } catch { } }
  if ($ServerUrl) { $c.serverUrl = $ServerUrl }
  return $c
}

# Første opsætning: elev-appen beder om en serveradresse. Den sættes KUN, hvis computeren ikke allerede har en
# (indbygget i appen eller sat af IT) – bagefter kan kun en administrator ændre den.
function Apply-ServerRequest {
  if (-not (Test-Path $ServerReq)) { return }
  try {
    $want = (Get-Content $ServerReq -TotalCount 1).Trim().ToLower().TrimEnd('/')
    $built = ''
    if (Test-Path $ConfigFile) { try { $built = "$((Get-Content $ConfigFile -Raw | ConvertFrom-Json).serverUrl)" } catch { } }
    $builtReal = $built -match '^https://'
    if (-not (Test-Path $ServerFile) -and -not $builtReal -and $want -match $ServerRe) {
      [IO.File]::WriteAllText($ServerFile, $want + "`n")
    }
  } catch { } finally { Remove-Item $ServerReq -Force -ErrorAction SilentlyContinue }
}

# Nøglen ligger i TPM-chippen (eller Windows' nøglelager) som maskinnøgle: kan ikke kopieres ud,
# og kun SYSTEM/administratorer kan bruge den.
function HM-Key {
  if ($script:Ecdsa) { return $script:Ecdsa }
  $name = 'HolyMolyGuard'
  foreach ($prov in @('Microsoft Platform Crypto Provider', 'Microsoft Software Key Storage Provider')) {
    try {
      $p = New-Object System.Security.Cryptography.CngProvider($prov)
      if ([System.Security.Cryptography.CngKey]::Exists($name, $p, [System.Security.Cryptography.CngKeyOpenOptions]::MachineKey)) {
        $k = [System.Security.Cryptography.CngKey]::Open($name, $p, [System.Security.Cryptography.CngKeyOpenOptions]::MachineKey)
      } else {
        $cp = New-Object System.Security.Cryptography.CngKeyCreationParameters
        $cp.Provider = $p
        $cp.KeyCreationOptions = [System.Security.Cryptography.CngKeyCreationOptions]::MachineKey
        $cp.ExportPolicy = [System.Security.Cryptography.CngExportPolicies]::None
        $k = [System.Security.Cryptography.CngKey]::Create([System.Security.Cryptography.CngAlgorithm]::ECDsaP256, $name, $cp)
      }
      $e = New-Object System.Security.Cryptography.ECDsaCng($k)
      $e.HashAlgorithm = [System.Security.Cryptography.CngAlgorithm]::Sha256
      $script:KeyStore = $(if ($prov -like '*Platform*') { 'tpm' } else { 'software' })
      $script:Ecdsa = $e
      return $e
    } catch { continue }
  }
  return $null
}

function HM-Post([string]$path, [string]$body) {
  $cfg = HM-Config
  $url = $cfg.serverUrl.TrimEnd('/')
  # Kun HTTPS (undtagen til test på denne computer)
  if (-not ($url -match '^https://' -or $url -match '^http://(127\.0\.0\.1|localhost)(:\d+)?$')) { return @{ status = 0; text = '' } }
  $key = HM-Key
  if (-not $key) { return @{ status = 0; text = '' } }
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
  $sig = [Convert]::ToBase64String($key.SignData($bytes))
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $r = Invoke-WebRequest -UseBasicParsing -Method Post -Uri ($url + $path) -Body $bytes -ContentType 'text/plain; charset=utf-8' `
      -Headers @{ 'X-HM-Sig' = $sig; 'X-HM-Sig-Format' = 'p1363' } -TimeoutSec 15
    return @{ status = [int]$r.StatusCode; text = [System.Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray()) }
  } catch {
    $resp = $_.Exception.Response
    if ($resp) {
      # Fejlsvarets tekst kan indeholde fx 'unpaired=<id>' (elever der skal parres igen)
      $txt = ''
      try { $sr = New-Object System.IO.StreamReader($resp.GetResponseStream(), [System.Text.Encoding]::UTF8); $txt = $sr.ReadToEnd(); $sr.Close() } catch { }
      return @{ status = [int]$resp.StatusCode; text = $txt }
    }
    return @{ status = 0; text = '' }
  }
}

function HM-Clean([string]$t) { return ("$t" -replace "[\t\r\n=]", ' ') }

function HM-Orig([string]$path) {
  if (-not $path) { return '' }
  if ($script:OrigCache.ContainsKey($path)) { return $script:OrigCache[$path] }
  $o = ''
  try { $o = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($path).OriginalFilename } catch { }
  $o = ("$o" -replace '\.(exe|mui)$', '')
  $script:OrigCache[$path] = $o
  return $o
}

# Er programmet den ægte HolyMoly-app? (rigtig sti + gyldig signatur fra skolens udgiver, hvis sat)
function HM-Genuine([string]$path) {
  if (-not $path) { return $false }
  if ($path -ine (Join-Path $InstallDir 'HolyMoly.exe')) { return $false }
  $pub = (HM-Config).publisher
  if ($pub) {
    $sig = Get-AuthenticodeSignature -FilePath $path -ErrorAction SilentlyContinue
    return ($sig -and $sig.Status -eq 'Valid' -and $sig.SignerCertificate.Subject -like "*$pub*")
  }
  return $true
}

function Pair-Students($state) {
  if (-not (Test-Path $PairFile)) { return }
  $cfg = HM-Config
  foreach ($line in (Get-Content $PairFile -TotalCount 50)) {
    if ("$line" -notmatch '^pair=(\d+)\t([A-Za-z0-9_-]{20,100})$') { continue }
    $sid = [int]$Matches[1]; $code = $Matches[2]
    if (@($state.paired) -contains $sid) { continue }
    $key = HM-Key
    if (-not $key) { continue }
    $blob = [Convert]::ToBase64String($key.Key.Export([System.Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob))
    $body = "v=1`ncode=$code`npubblob=$blob`nos=windows`nhost=$(HM-Clean $env:COMPUTERNAME)`nkeystore=$($script:KeyStore)`nguard=$Version`n"
    $r = HM-Post '/api/guard/pair' $body
    if ($r.status -eq 200) { $state.paired = @(@($state.paired) + $sid) }
    elseif ($r.status -eq 409) { Add-Tamper $state 'En anden (falsk) vagt er allerede tilknyttet denne elev' }
  }
}

function Beat($state, [bool]$hostsOk, [bool]$policiesOk) {
  if (@($state.paired).Count -eq 0) { return $null }
  if (-not (HM-Key)) { throw 'vagtens nøgle kan ikke åbnes' }   # sætter også $script:KeyStore
  $now = HM-NowMs
  # Tæller mod genafspilning: tidsstempel (altid stigende, kan ikke nulstilles ved at slette en fil)
  $state.seq = [Math]::Max([int64]$state.seq + 1, [int64]$now)
  $lesson = ([double]$state.lessonUntil -gt $now)
  $L = New-Object System.Collections.Generic.List[string]
  $L.Add('v=1'); $L.Add('students=' + (@($state.paired) -join ',')); $L.Add("seq=$($state.seq)"); $L.Add("ts=$now")
  $L.Add('os=windows'); $L.Add("guard=$Version"); $L.Add("keystore=$($script:KeyStore)")
  $L.Add('hosts=' + $(if ($hostsOk) { 1 } else { 0 })); $L.Add('policies=' + $(if ($policiesOk) { 1 } else { 0 }))
  $L.Add("blockhash=$($state.blockHash)")
  foreach ($t in @($state.tamper)) { if ($now - [double]$t.ts -lt 300000) { $L.Add("tamper=$([int64]$t.ts)`t$(HM-Clean $t.what)") } }
  foreach ($t in @($state.notes)) { if ($t -and $now - [double]$t.ts -lt 300000) { $L.Add("note=$([int64]$t.ts)`t$(HM-Clean $t.what)") } }
  # Overvåger vagten lektionen lige nu? (serveren viser grå "venter på vagten", indtil den gør)
  $L.Add('lesson=' + $(if ($lesson) { 1 } else { 0 }))
  # Er den ægte HolyMoly-app i gang?
  $app = 0
  foreach ($p in @(Get-Process -Name 'HolyMoly' -ErrorAction SilentlyContinue)) { if (HM-Genuine $p.Path) { $app = 1; break } }
  $L.Add("app=$app")
  # Seneste interne fejl i vagten (vises for læreren i stedet for at forsvinde)
  if ($state.lastError) { $L.Add("error=$(HM-Clean $state.lastError)") }
  # Hvem er forbundet til HolyMoly-serveren? (en falsk klient afsløres her)
  try {
    $u = [Uri](HM-Config).serverUrl
    $ips = @([System.Net.Dns]::GetHostAddresses($u.Host) | ForEach-Object { $_.ToString() })
    foreach ($c in @(Get-NetTCPConnection -State Established -RemotePort $u.Port -ErrorAction SilentlyContinue)) {
      if ($ips -notcontains $c.RemoteAddress -and -not ($ips -contains '127.0.0.1' -and $c.RemoteAddress -eq '::1')) { continue }
      if ($c.OwningProcess -eq $PID) { continue }
      $pp = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
      $path = "$($pp.Path)"
      $g = $(if (HM-Genuine $path) { 1 } else { 0 })
      $L.Add("client=$($c.OwningProcess)`t$g`t$(HM-Clean $path)")
    }
  } catch { }
  if ($lesson) {
    foreach ($p in @(Get-Process -ErrorAction SilentlyContinue)) {
      if ($p.Id -eq 0) { continue }
      $L.Add("proc=$($p.Id)`t$(HM-Clean $p.ProcessName)`t$(HM-Clean (HM-Orig $p.Path))")
    }
    foreach ($c in @(Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue)) {
      if ($c.RemoteAddress -match '^(127\.|::1|0\.0\.0\.0|169\.254\.)') { continue }
      $L.Add("conn=$($c.OwningProcess)`t$($c.RemoteAddress)`t$($c.RemotePort)")
    }
    foreach ($d in @(Get-DnsClientCache -ErrorAction SilentlyContinue)) {
      if ($d.Type -eq 1 -or $d.Type -eq 28) { $L.Add("dns=$(HM-Clean $d.Entry)`t$($d.Data)") }
    }
  }
  $r = HM-Post '/api/guard/beat' (($L -join "`n") + "`n")
  # Serveren siger præcis hvilke elever der skal parres igen (fx ny kode / ny computer)
  $drop = @(); foreach ($line in ("$($r.text)" -split "`n")) { if ($line.Trim() -match '^unpaired=(\d+)$') { $drop += $Matches[1] } }
  if ($drop.Count) { $state.paired = @(@($state.paired) | Where-Object { $drop -notcontains "$_" }) }
  if ($r.status -eq 401 -and -not $drop.Count) {
    # Afvist uden forklaring flere gange i træk -> parr alt igen
    $state.rejects = [int]$state.rejects + 1
    if ($state.rejects -ge 3) { $state.paired = @(); $state.rejects = 0 }
  }
  if ($r.status -ne 200) { return $null }
  $state.rejects = 0
  $resp = @{ lesson = $false; until = 0; block = New-Object System.Collections.Generic.List[string]; blockhash = ''; kill = @(); next = 5 }
  foreach ($line in ($r.text -split "`n")) {
    $line = $line.Trim()
    if ($line -eq 'lesson=1') { $resp.lesson = $true }
    elseif ($line -like 'until=*') {
      # NB: [ref]$resp.until ville kun ændre en kopi - derfor en lokal variabel
      $u = 0.0
      if ([double]::TryParse($line.Substring(6), [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$u)) { $resp.until = $u }
    }
    elseif ($line -like 'next=*') { $n = 0; if ([int]::TryParse($line.Substring(5), [ref]$n)) { $resp.next = $n } }
    elseif ($line -like 'blockhash=*') { $resp.blockhash = $line.Substring(10) }
    elseif ($line -like 'block=*') { $h = $line.Substring(6).ToLowerInvariant(); if ($h -match $HostRe -and $h -notmatch $NeverHosts) { $resp.block.Add($h) } }
    elseif ($line -like 'kill=*') { $resp.kill += [int]$line.Substring(5) }
  }
  return $resp
}

function Read-Baseline {
  $out = New-Object System.Collections.Generic.List[string]
  if (Test-Path $Baseline) {
    foreach ($l in (Get-Content $Baseline)) {
      $l = "$l".Trim().ToLowerInvariant()
      if ($l -match $HostRe -and $l -notmatch $NeverHosts) { $out.Add($l) }
    }
  }
  return $out
}

function HM-Hash([string]$text) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $bytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes("$text"))
  return ([BitConverter]::ToString($bytes)).Replace('-', '')
}

function Ensure-Hosts($state, [bool]$active) {
  $result = @{ changed = $false; tampered = $false; count = 0 }
  try { $content = [IO.File]::ReadAllText($HostsFile) } catch { $content = '' }
  $current = HM-CurrentBlock $content
  $expected = $null
  if ($active) {
    $set = New-Object 'System.Collections.Generic.SortedSet[string]'
    foreach ($h in (Read-Baseline)) { [void]$set.Add($h) }
    foreach ($h in @($state.lessonHosts)) { if ($set.Count -lt 20000) { [void]$set.Add("$h") } }
    $expected = (($set | ForEach-Object { "0.0.0.0 $_" }) -join "`r`n")
    $result.count = $set.Count
  }
  if ("$current" -ne "$expected") {
    # Afviger blokken fra det vagten selv skrev sidst, har nogen pillet ved den
    if ($active -and $state.writtenHash -and (HM-Hash "$current") -ne $state.writtenHash) { $result.tampered = $true }
    $new = HM-HostsWithoutBlock $content
    if ($active) { $new = $new + $HMBegin + "`r`n" + $expected + "`r`n" + $HMEnd + "`r`n" }
    try {
      # Fjern skrivebeskyttelse, som en elev kunne have sat
      if (Test-Path $HostsFile) { Set-ItemProperty -Path $HostsFile -Name IsReadOnly -Value $false -ErrorAction SilentlyContinue }
      [IO.File]::WriteAllText($HostsFile, $new, (New-Object System.Text.UTF8Encoding($false)))
      & ipconfig /flushdns | Out-Null
      $result.changed = $true
      if ($active) { $state.writtenHash = (HM-Hash "$expected") } else { $state.writtenHash = '' }
    } catch { }
  }
  return $result
}

function Ensure-Tray($state, [bool]$active) {
  # Kun hvis en bruger er logget ind (explorer kører) og HolyMoly ikke kører
  if (-not (Get-Process -Name 'explorer' -ErrorAction SilentlyContinue)) { return }
  if (Get-Process -Name 'HolyMoly' -ErrorAction SilentlyContinue) { return }
  $now = HM-NowMs
  if ($now - [double]$state.lastTray -lt 10000) { return }
  $state.lastTray = $now
  & schtasks.exe /run /tn ($HMTaskPath + 'Elev-app') | Out-Null
  $state.trayRelaunches = [int]$state.trayRelaunches + 1
  if ($active) { Add-Note $state 'HolyMoly var lukket under lektionen og er startet igen' }
}

# ------------------------------------------------------------------------
New-Item -ItemType Directory -Force -Path (Join-Path $DataDir 'requests') | Out-Null
$state = Load-State
while ($true) {
  try {
    $now = HM-NowMs
    $changed = Ensure-Policies
    if ($changed -gt 0 -and $state.policiesApplied) { Add-Note $state "Browser-indstillinger blev ændret ($changed) - sat på plads igen" }
    $state.policiesApplied = $true

    if (-not $NoTray) {
      $missing = Ensure-Tasks
      if ($missing -gt 0 -and $state.policiesApplied -and $state.tasksOk) { Add-Tamper $state 'HolyMolys planlagte opgaver blev slettet/slået fra - genoprettet' }
      $state.tasksOk = $true
    }

    # Serveren bestemmer: parring, lektion, blokeringsliste og hvad der skal lukkes
    Apply-ServerRequest
    Pair-Students $state
    if ($Once -or $now -ge [double]$state.nextBeat) {
      $wasLesson = ([double]$state.lessonUntil -gt $now)
      $resp = Beat $state ([bool]$state.lastHostsOk) ([bool]$state.lastPoliciesOk)
      if ($resp -and $resp.lesson -and -not $wasLesson) {
        # Lektionen er lige startet: send straks en hjertebanke mere, nu med lektionens data (processer m.m.)
        $state.lessonUntil = [Math]::Min([double]$resp.until, [double]($now + $MaxLessonMs))
        if ($resp.block.Count -gt 0) { $state.lessonHosts = @($resp.block); $state.blockHash = $resp.blockhash }
        $again = Beat $state ([bool]$state.lastHostsOk) ([bool]$state.lastPoliciesOk)
        if ($again) { $resp = $again }
      }
      if ($resp) {
        if ($resp.lesson) {
          $state.lessonUntil = [Math]::Min([double]$resp.until, [double]($now + $MaxLessonMs))
          if ($resp.block.Count -gt 0) { $state.lessonHosts = @($resp.block); $state.blockHash = $resp.blockhash }
        } else {
          # Kun serveren kan afslutte en lektion før tid
          $state.lessonUntil = 0; $state.lessonHosts = @(); $state.blockHash = ''
        }
        foreach ($k in $resp.kill) {
          $pp = Get-Process -Id $k -ErrorAction SilentlyContinue
          if ($pp -and $pp.ProcessName -notmatch '^(HolyMoly|explorer|svchost|csrss|winlogon|lsass|services|smss|wininit|dwm|powershell)$') {
            Stop-Process -Id $k -Force -ErrorAction SilentlyContinue
          }
        }
        $state.nextBeat = $now + ([Math]::Max(3, [Math]::Min(60, [int]$resp.next)) * 1000)
      } else {
        $state.nextBeat = $now + 5000   # offline: prøv igen; blokeringen fortsætter til lektionens slut
      }
    }
    $active = ([double]$state.lessonUntil -gt $now)
    if (-not $active) { $state.lessonHosts = @() }

    $h = Ensure-Hosts $state $active
    if ($h.tampered) { Add-Tamper $state 'hosts-filen blev ændret under lektionen - sat på plads igen' }
    $state.lastHostsOk = ((-not $active) -or ($h.count -gt 0 -and ($null -ne (HM-CurrentBlock ([IO.File]::ReadAllText($HostsFile))))))
    $state.lastPoliciesOk = $true

    if (-not $NoTray) { Ensure-Tray $state $active }

    $state.lastError = ''   # gennemløbet lykkedes (en tidligere fejl er sendt med hjertebanket ovenfor)
    Save-Json $state $StateFile
    Save-Json @{
      ts = (HM-NowMs); version = $Version; lessonUntil = $state.lessonUntil; hostsActive = $active
      hostsCount = $h.count; tamper = @($state.tamper); trayRelaunches = $state.trayRelaunches; keystore = $script:KeyStore
    } $StatusFile
  } catch {
    # Vagten må aldrig dø af en enkelt fejl - men fejlen må heller ikke forsvinde:
    # den gemmes i status, sendes til serveren ved næste hjertebanke og vises i konsollen
    $state.lastError = "linje $($_.InvocationInfo.ScriptLineNumber): $($_.Exception.Message)"
    if ($Once) { [Console]::Error.WriteLine("HolyMoly-vagt FEJL $($state.lastError)") }
    try {
      Save-Json $state $StateFile
      Save-Json @{ ts = (HM-NowMs); version = $Version; error = $state.lastError; tamper = @($state.tamper) } $StatusFile
    } catch { if ($Once) { [Console]::Error.WriteLine("HolyMoly-vagt kan ikke gemme status: $($_.Exception.Message)") } }
  }
  if ($Once) { break }
  Start-Sleep -Seconds 5
}
