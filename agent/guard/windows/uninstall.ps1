# Køres ved afinstallation (som administrator). Fjerner alt HolyMoly har sat.
param([string]$HostsFile = (Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'))
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'common.ps1')
foreach ($name in @('Vagt', 'Elev-app')) {
  Stop-ScheduledTask -TaskPath $HMTaskPath -TaskName $name -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskPath $HMTaskPath -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
}
# Stop en evt. kørende vagt
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*\resources\guard\windows\guard.ps1*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
# hosts-blokering
try {
  $content = [IO.File]::ReadAllText($HostsFile)
  if ($null -ne (HM-CurrentBlock $content)) {
    [IO.File]::WriteAllText($HostsFile, (HM-HostsWithoutBlock $content), (New-Object System.Text.UTF8Encoding($false)))
    & ipconfig /flushdns | Out-Null
  }
} catch { }
# Browser-politikker
foreach ($p in $HMPolicyValues) { Remove-ItemProperty -Path $p.Key -Name $p.Name -ErrorAction SilentlyContinue }
foreach ($k in @('HKLM:\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist', 'HKLM:\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallForcelist', 'HKLM:\SOFTWARE\Policies\BraveSoftware\Brave\ExtensionInstallForcelist')) {
  Remove-ItemProperty -Path $k -Name '1' -ErrorAction SilentlyContinue
}
Remove-ItemProperty -Path 'HKLM:\SOFTWARE\Policies\Mozilla\Firefox' -Name 'ExtensionSettings' -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force -Path $HMDataDefault -ErrorAction SilentlyContinue
