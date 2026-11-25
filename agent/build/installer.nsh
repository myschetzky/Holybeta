; HolyMoly – ekstra trin i Windows-installationsprogrammet (kører som administrator).
; Installationsprogrammet er 32-bit: brug 64-bit PowerShell (Sysnative), ellers havner
; browser-politikkerne i WOW6432Node, hvor Chrome/Edge ikke læser dem.
!include "x64.nsh"
!include "FileFunc.nsh"

!macro hmPowerShell SCRIPT ARGS
  ${If} ${RunningX64}
    nsExec::ExecToLog '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${SCRIPT}" ${ARGS}'
  ${Else}
    nsExec::ExecToLog '"$WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${SCRIPT}" ${ARGS}'
  ${EndIf}
  Pop $0
!macroend

!macro customInstall
  DetailPrint "Installerer HolyMoly-vagten..."
  ; Skolens serveradresse kan gives med: HolyMoly-Setup.exe /S /SERVER=https://holymoly.minskole.dk
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/SERVER=" $R1
  ${If} ${Errors}
    StrCpy $R1 ""
  ${EndIf}
  !insertmacro hmPowerShell "$INSTDIR\resources\guard\windows\install.ps1" '-InstallDir "$INSTDIR" -Server "$R1"'
!macroend

!macro customUnInstall
  ; Ved en opdatering køres det gamle afinstallationsprogram også – der skal vagten blive.
  ${ifNot} ${isUpdated}
    DetailPrint "Fjerner HolyMoly-vagten..."
    !insertmacro hmPowerShell "$INSTDIR\resources\guard\windows\uninstall.ps1" ""
  ${endIf}
!macroend
