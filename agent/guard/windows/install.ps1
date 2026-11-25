# Køres af installationsprogrammet (som administrator).
param([Parameter(Mandatory = $true)][string]$InstallDir, [string]$Server = '', [switch]$NoStart)
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'common.ps1')
HM-SetDataAcl $HMDataDefault
# Skolens serveradresse fra IT (/SERVER=...). Ligger i ProgramData\HolyMoly, som kun administratorer kan ændre.
$Server = "$Server".Trim().ToLower().TrimEnd('/')
if ($Server -match '^(https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?|http://(127\.0\.0\.1|localhost)(:\d{1,5})?)$') {
  [IO.File]::WriteAllText((Join-Path $HMDataDefault 'server.txt'), $Server + "`n")
}
HM-RegisterTasks $InstallDir
if (-not $NoStart) {
  Start-ScheduledTask -TaskPath $HMTaskPath -TaskName 'Vagt'
  Start-ScheduledTask -TaskPath $HMTaskPath -TaskName 'Elev-app' -ErrorAction SilentlyContinue
}
