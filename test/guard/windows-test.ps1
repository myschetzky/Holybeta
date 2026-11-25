# Tester HolyMoly-vagten på en rigtig Windows-maskine (GitHub Actions, administrator) mod en rigtig HolyMoly-server.
$ErrorActionPreference = 'Stop'
$script:failed = 0
function Check($cond, [string]$msg) { if ($cond) { Write-Host "  OK   $msg" } else { Write-Host "  FEJL $msg"; $script:failed++ } }
function Guard([switch]$Tray) {
  if ($Tray) { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $guard -Once -ServerUrl 'http://127.0.0.1:18080' | Out-Host }
  else { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $guard -Once -NoTray -ServerUrl 'http://127.0.0.1:18080' | Out-Host }
}
function Status { Get-Content "$env:ProgramData\HolyMoly\guard-status.json" -Raw | ConvertFrom-Json }
function HostsText { [IO.File]::ReadAllText("$env:SystemRoot\System32\drivers\etc\hosts") }
function View { Invoke-RestMethod 'http://127.0.0.1:18081/view' }

$root = (Resolve-Path "$PSScriptRoot\..\..").Path
$inst = Join-Path $env:RUNNER_TEMP 'HolyMoly'
New-Item -ItemType Directory -Force "$inst\resources" | Out-Null
Copy-Item -Recurse -Force "$root\agent\guard" "$inst\resources\guard"
# "HolyMoly.exe" i testinstallationen er en kopi af node, så den simulerede elev-app kører fra den rigtige sti
Copy-Item (Get-Command node).Source "$inst\HolyMoly.exe"
'{"chrome":"abcdefghijklmnopabcdefghijklmnop;https://clients2.google.com/service/update2/crx","edge":"ponmlkjihgfedcbaponmlkjihgfedcba;https://edge.microsoft.com/extensionwebstorebase/v1/crx","firefox":"https://example.com/holymoly.xpi"}' | Set-Content "$inst\resources\guard\extensions.json"
$guard = "$inst\resources\guard\windows\guard.ps1"

Write-Host "Installation"
& "$inst\resources\guard\windows\install.ps1" -InstallDir $inst -NoStart
Check ([bool](Get-ScheduledTask -TaskPath '\HolyMoly\' -TaskName 'Vagt' -ErrorAction SilentlyContinue)) 'opgaven "Vagt" (SYSTEM) er oprettet'
Check ([bool](Get-ScheduledTask -TaskPath '\HolyMoly\' -TaskName 'Elev-app' -ErrorAction SilentlyContinue)) 'opgaven "Elev-app" (alle brugere) er oprettet'
Check ((Get-ScheduledTask -TaskPath '\HolyMoly\' -TaskName 'Vagt').Principal.UserId -match 'SYSTEM') 'vagten kører som SYSTEM'
$acl = (Get-Acl "$env:ProgramData\HolyMoly").Access | Where-Object { $_.IdentityReference -match 'Users|Brugere' }
Check (-not ($acl | Where-Object { $_.FileSystemRights -match 'Write|Modify|FullControl' })) 'brugere kan ikke skrive i vagtens mappe'

Write-Host "Server + elev-app + lektion (harness)"
$h = Start-Process node -ArgumentList "`"$root\test\guard\harness.js`" `"$env:ProgramData\HolyMoly`" `"Windows 11`" `"$inst\HolyMoly.exe`"" -PassThru -NoNewWindow
Start-Sleep -Seconds 4
$v = View
Check ($v.color -eq 'grey' -and $v.greyReason -match 'ikke tilknyttet') "uden vagt: aldrig grøn ($($v.color): $($v.greyReason))"

Write-Host "Vagten parrer sig og taler direkte med serveren"
Guard
Start-Sleep -Milliseconds 1500
$v = View
Check ($v.guard -eq 'ok') "serveren har modtaget en gyldig, signeret hjertebanke (vagt: $($v.guard))"
Check ($v.color -eq 'green') "eleven er grøn med vagt ($($v.color) $($v.greyReason))"
$sf = "$env:ProgramData\HolyMoly\guard-status.json"
Check (Test-Path $sf) 'vagten skriver sin status'
if (Test-Path $sf) { $st = Status; Check (-not $st.error) "vagten kører uden interne fejl ($($st.error))" }
$ksName = @{ tpm = 'TPM-chip'; software = 'Windows nøglelager (ingen TPM på denne maskine)' }[[string](Status).keystore]
Check ([bool]$ksName) "vagtens nøgle ligger i: $ksName"

Write-Host "Browser-låsning"
Check ((Get-ItemProperty 'HKLM:\SOFTWARE\Policies\Google\Chrome').IncognitoModeAvailability -eq 1) 'Chrome: inkognito slået fra'
Check ((Get-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Edge').InPrivateModeAvailability -eq 1) 'Edge: InPrivate slået fra'
Check ((Get-ItemProperty 'HKLM:\SOFTWARE\Policies\Google\Chrome').DnsOverHttpsMode -eq 'off') 'Chrome: sikker DNS-omgåelse slået fra'
Check ((Get-ItemProperty 'HKLM:\SOFTWARE\Policies\Mozilla\Firefox').DisablePrivateBrowsing -eq 1) 'Firefox: privat browsing slået fra'
Check ((Get-ItemProperty 'HKLM:\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist').'1' -like 'abcdef*') 'Chrome: browser-delen tvangsinstalleres'

Write-Host "Blokering for hele computeren – listen kommer fra serveren"
Guard
$ht = HostsText
Check ($ht -match '(?m)^0\.0\.0\.0 chatgpt\.com\s*$') 'chatgpt.com blokeres'
Check ($ht -match '(?m)^0\.0\.0\.0 example-blocked-site\.com\s*$') 'lærerens egen blokering (fra serveren) virker'
Check ($ht -notmatch 'copilot\.microsoft\.com') 'Microsoft-domæner skrives ikke i hosts (Defender)'
$ip = (Resolve-DnsName chatgpt.com -Type A -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress } | Select-Object -First 1).IPAddress
Check ($ip -eq '0.0.0.0') "chatgpt.com slås op til 0.0.0.0 (fik: $ip)"
"until=0" | Set-Content "$env:ProgramData\HolyMoly\requests\lesson.txt"
Guard
Check ((HostsText) -match 'chatgpt\.com') 'eleven kan ikke afslutte blokeringen (kun serveren kan)'

Write-Host "Forbudt program lukkes af vagten (besked fra serveren)"
Copy-Item "$env:SystemRoot\System32\notepad.exe" "$env:RUNNER_TEMP\RobloxPlayerBeta.exe"
$game = Start-Process "$env:RUNNER_TEMP\RobloxPlayerBeta.exe" -PassThru
Start-Sleep -Seconds 1
Guard
Start-Sleep -Seconds 1
Check (-not (Get-Process -Id $game.Id -ErrorAction SilentlyContinue)) 'spillet blev lukket af vagten'

Write-Host "Falsk HolyMoly-klient (et program der selv taler med serveren)"
$fakeCmd = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes('$c = New-Object Net.Sockets.TcpClient("127.0.0.1", 18080); Start-Sleep 60'))
$fake = Start-Process powershell.exe -ArgumentList "-NoProfile -EncodedCommand $fakeCmd" -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 2
Guard
Start-Sleep -Milliseconds 1500
$v = View
$texts = (@($v.violations) | ForEach-Object { $_.text }) -join ' | '
Check ($v.color -eq 'red' -and $texts -match 'Falsk HolyMoly-klient') "falsk klient afsløret: $texts"
Stop-Process -Id $fake.Id -Force -ErrorAction SilentlyContinue

Write-Host "Manipulation"
$clean = [regex]::Replace((HostsText), '(?ms)# >>> HolyMoly.*?# <<< HolyMoly\r?\n?', '')
[IO.File]::WriteAllText("$env:SystemRoot\System32\drivers\etc\hosts", $clean)
Remove-ItemProperty 'HKLM:\SOFTWARE\Policies\Google\Chrome' -Name IncognitoModeAvailability
Disable-ScheduledTask -TaskPath '\HolyMoly\' -TaskName 'Elev-app' | Out-Null
Guard -Tray
Start-Sleep -Milliseconds 1500
Check ((HostsText) -match 'chatgpt\.com') 'hosts-blokeringen er sat på plads igen'
Check ((Get-ItemProperty 'HKLM:\SOFTWARE\Policies\Google\Chrome').IncognitoModeAvailability -eq 1) 'browser-låsningen er sat på plads igen'
Check ((Get-ScheduledTask -TaskPath '\HolyMoly\' -TaskName 'Elev-app').State -ne 'Disabled') 'den slåede-fra opgave er genoprettet'
Guard
Start-Sleep -Milliseconds 1500
$v = View
$texts = (@($v.violations) | ForEach-Object { $_.text }) -join ' | '
Check ($v.color -eq 'red' -and $texts -match 'slå HolyMoly fra') "læreren ser manipulationen som rød: $texts"

Write-Host "Kun serveren kan afslutte lektionen"
Invoke-RestMethod -Method Post 'http://127.0.0.1:18081/stop' | Out-Null
Guard
Check ((HostsText) -notmatch 'HolyMoly') 'blokeringen fjernes når læreren afslutter lektionen'

Write-Host "Afinstallation"
Stop-Process -Id $h.Id -Force -ErrorAction SilentlyContinue
Get-Process -Name HolyMoly -ErrorAction SilentlyContinue | Stop-Process -Force
& "$inst\resources\guard\windows\uninstall.ps1"
Check (-not (Get-ScheduledTask -TaskPath '\HolyMoly\' -ErrorAction SilentlyContinue)) 'opgaverne er fjernet'
Check ($null -eq (Get-ItemProperty 'HKLM:\SOFTWARE\Policies\Google\Chrome' -ErrorAction SilentlyContinue).IncognitoModeAvailability) 'browser-låsningen er fjernet'
Check (-not (Test-Path "$env:ProgramData\HolyMoly")) 'vagtens mappe er fjernet'

if ($script:failed) { Write-Host "$script:failed fejl"; exit 1 } else { Write-Host 'Alle Windows-vagttest bestået' }
