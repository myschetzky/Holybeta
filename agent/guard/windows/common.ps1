# Fælles funktioner for HolyMoly-vagten på Windows (bruges af install.ps1, guard.ps1 og uninstall.ps1).

$HMTaskPath = '\HolyMoly\'
$HMBegin = '# >>> HolyMoly (styres automatisk under lektioner - ret ikke)'
$HMEnd = '# <<< HolyMoly'
$HMDataDefault = Join-Path $env:ProgramData 'HolyMoly'

function HM-NowMs { return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

function HM-SidName([string]$sid) {
  return (New-Object System.Security.Principal.SecurityIdentifier($sid)).Translate([System.Security.Principal.NTAccount]).Value
}

# Datamappen: SYSTEM og administratorer fuld adgang, brugere kun læse.
# Undermappen "requests" må brugerne skrive i (elev-appens lektionsanmodning).
function HM-SetDataAcl([string]$DataDir) {
  New-Item -ItemType Directory -Force -Path (Join-Path $DataDir 'requests') | Out-Null
  & icacls $DataDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' | Out-Null
  & icacls (Join-Path $DataDir 'requests') /grant '*S-1-5-32-545:(OI)(CI)M' | Out-Null
}

function HM-RegisterTasks([string]$InstallDir) {
  $guardScript = Join-Path $InstallDir 'resources\guard\windows\guard.ps1'
  $exe = Join-Path $InstallDir 'HolyMoly.exe'
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)

  # Vagten: kører som SYSTEM fra opstart. Gentages hvert minut, så den starter igen hvis nogen stopper den.
  $tStart = New-ScheduledTaskTrigger -AtStartup
  $tRepeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$guardScript`""
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  Register-ScheduledTask -TaskPath $HMTaskPath -TaskName 'Vagt' -Action $action -Trigger @($tStart, $tRepeat) `
    -Principal $principal -Settings $settings -Description 'HolyMoly-vagt: blokerer forbudte sider under lektioner og holder HolyMoly kørende.' -Force | Out-Null

  # Elev-appen: starter for alle brugere ved login og igen hvert minut, hvis den er lukket.
  $tLogon = New-ScheduledTaskTrigger -AtLogOn
  $tLogon.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1)).Repetition
  $a2 = New-ScheduledTaskAction -Execute $exe -Argument '--tray'
  $p2 = New-ScheduledTaskPrincipal -GroupId (HM-SidName 'S-1-5-32-545') -RunLevel Limited
  Register-ScheduledTask -TaskPath $HMTaskPath -TaskName 'Elev-app' -Action $a2 -Trigger $tLogon `
    -Principal $p2 -Settings $settings -Description 'Starter HolyMoly i proceslinjen.' -Force | Out-Null
}

function HM-HostsWithoutBlock([string]$content) {
  $pattern = '(?ms)\r?\n?' + [regex]::Escape($HMBegin) + '.*?' + [regex]::Escape($HMEnd) + '\r?\n?'
  return ([regex]::Replace($content, $pattern, "`r`n")).TrimEnd() + "`r`n"
}

function HM-CurrentBlock([string]$content) {
  $m = [regex]::Match($content, '(?ms)' + [regex]::Escape($HMBegin) + '\r?\n(.*?)' + [regex]::Escape($HMEnd))
  if ($m.Success) { return $m.Groups[1].Value.Trim() }
  return $null
}

# Browser-politikker HolyMoly styrer (fjernes igen ved afinstallation)
$HMPolicyValues = @(
  @{ Key = 'HKLM:\SOFTWARE\Policies\Google\Chrome'; Name = 'IncognitoModeAvailability'; Value = 1; Type = 'DWord' },
  @{ Key = 'HKLM:\SOFTWARE\Policies\Google\Chrome'; Name = 'BrowserGuestModeEnabled'; Value = 0; Type = 'DWord' },
  @{ Key = 'HKLM:\SOFTWARE\Policies\Google\Chrome'; Name = 'BrowserAddPersonEnabled'; Value = 0; Type = 'DWord' },
  @{ Key = 'HKLM:\SOFTWARE\Policies\Google\Chrome'; Name = 'DnsOverHttpsMode'; Value = 'off'; Type = 'String' },
  @{ Key = 'HKLM:\SOFTWARE\Policies\Microsoft\Edge'; Name = 'InPrivateModeAvailability'; Value = 1; Type = 'DWord' },
  @{ Key = 'HKLM:\SOFTWARE\Policies\Microsoft\Edge'; Name = 'BrowserGuestModeEnabled'; Value = 0; Type = 'DWord' },
  @{ Key = 'HKLM:\SOFTWARE\Policies\Microsoft\Edge'; Name = 'BrowserAddProfileEnabled'; Value = 0; Type = 'DWord' },
  @{ Key = 'HKLM:\SOFTWARE\Policies\Microsoft\Edge'; Name = 'DnsOverHttpsMode'; Value = 'off'; Type = 'String' },
  @{ Key = 'HKLM:\SOFTWARE\Policies\BraveSoftware\Brave'; Name = 'IncognitoModeAvailability'; Value = 1; Type = 'DWord' },
  @{ Key = 'HKLM:\SOFTWARE\Policies\BraveSoftware\Brave'; Name = 'BrowserGuestModeEnabled'; Value = 0; Type = 'DWord' },
  @{ Key = 'HKLM:\SOFTWARE\Policies\BraveSoftware\Brave'; Name = 'BrowserAddPersonEnabled'; Value = 0; Type = 'DWord' },
  @{ Key = 'HKLM:\SOFTWARE\Policies\BraveSoftware\Brave'; Name = 'DnsOverHttpsMode'; Value = 'off'; Type = 'String' },
  @{ Key = 'HKLM:\SOFTWARE\Policies\Mozilla\Firefox'; Name = 'DisablePrivateBrowsing'; Value = 1; Type = 'DWord' },
  @{ Key = 'HKLM:\SOFTWARE\Policies\Mozilla\Firefox\DNSOverHTTPS'; Name = 'Enabled'; Value = 0; Type = 'DWord' },
  @{ Key = 'HKLM:\SOFTWARE\Policies\Mozilla\Firefox\DNSOverHTTPS'; Name = 'Locked'; Value = 1; Type = 'DWord' }
)
