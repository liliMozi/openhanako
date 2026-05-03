; installer.nsh - NSIS custom hooks for Hanako installer
;
; Owns the Windows overlay boundary for Hanako installs. The installer may
; replace Hana-owned program files, while user/runtime state stays outside
; $INSTDIR.

; Disable CRC integrity check. electron-builder's post-compilation PE editing
; (signtool + rcedit) corrupts the NSIS CRC when no signing cert is configured,
; causing "Installer integrity check has failed" on Windows.
CRCCheck off

!include LogicLib.nsh

!macro hanakoFindProcess _NAME _RETURN
  nsExec::ExecToLog `"$SYSDIR\cmd.exe" /D /C tasklist /FI "IMAGENAME eq ${_NAME}" /FO CSV | "$SYSDIR\find.exe" "${_NAME}"`
  Pop ${_RETURN}
!macroend

!macro hanakoFindRunningProcesses _RETURN
  !insertmacro hanakoFindProcess Hanako.exe ${_RETURN}
  ${If} ${_RETURN} != 0
    !insertmacro hanakoFindProcess hana-server.exe ${_RETURN}
  ${EndIf}
!macroend

!macro hanakoKillProcess _NAME _FORCE
  Push $0
  Push $1
  ${If} ${_FORCE} == 1
    StrCpy $0 "/F"
  ${Else}
    StrCpy $0 ""
  ${EndIf}
  nsExec::ExecToLog `"$SYSDIR\cmd.exe" /D /C taskkill $0 /T /IM "${_NAME}"`
  Pop $1
  Pop $1
  Pop $0
!macroend

!macro hanakoKillRunningProcesses _FORCE
  !insertmacro hanakoKillProcess Hanako.exe ${_FORCE}
  !insertmacro hanakoKillProcess hana-server.exe ${_FORCE}
!macroend

!macro hanakoWriteInstallDirProcessCleaner _SCRIPT
  Push $0
  FileOpen $0 "${_SCRIPT}" w
  FileWrite $0 `$$ErrorActionPreference = 'SilentlyContinue'$\r$\n`
  FileWrite $0 `$$installDir = [Environment]::GetEnvironmentVariable('HANA_INSTALL_DIR')$\r$\n`
  FileWrite $0 `if ([string]::IsNullOrWhiteSpace($$installDir)) { exit 0 }$\r$\n`
  FileWrite $0 `$$installFull = [System.IO.Path]::GetFullPath($$installDir).TrimEnd('\')$\r$\n`
  FileWrite $0 `$$installPrefix = $$installFull + '\'$\r$\n`
  FileWrite $0 `$$selfPid = $$PID$\r$\n`
  FileWrite $0 `$$self = Get-CimInstance Win32_Process -Filter "ProcessId = $$selfPid"$\r$\n`
  FileWrite $0 `$$installerPid = if ($$self) { $$self.ParentProcessId } else { -1 }$\r$\n`
  FileWrite $0 `function Test-HanaPath([string]$$value) {$\r$\n`
  FileWrite $0 `  if ([string]::IsNullOrWhiteSpace($$value)) { return $$false }$\r$\n`
  FileWrite $0 `  try {$\r$\n`
  FileWrite $0 `    $$full = [System.IO.Path]::GetFullPath($$value)$\r$\n`
  FileWrite $0 `    return $$full.Equals($$installFull, [StringComparison]::OrdinalIgnoreCase) -or $$full.StartsWith($$installPrefix, [StringComparison]::OrdinalIgnoreCase)$\r$\n`
  FileWrite $0 `  } catch { return $$false }$\r$\n`
  FileWrite $0 `}$\r$\n`
  FileWrite $0 `function Test-HanaCommand([string]$$value) {$\r$\n`
  FileWrite $0 `  if ([string]::IsNullOrWhiteSpace($$value)) { return $$false }$\r$\n`
  FileWrite $0 `  $$quotedPrefix = '"' + $$installPrefix$\r$\n`
  FileWrite $0 `  return $$value.StartsWith($$installPrefix, [StringComparison]::OrdinalIgnoreCase) -or $$value.IndexOf($$quotedPrefix, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or $$value.IndexOf(' ' + $$installPrefix, [StringComparison]::OrdinalIgnoreCase) -ge 0$\r$\n`
  FileWrite $0 `}$\r$\n`
  FileWrite $0 `Get-CimInstance Win32_Process | Where-Object {$\r$\n`
  FileWrite $0 `  $$_.ProcessId -ne $$selfPid -and $$_.ProcessId -ne $$installerPid -and ((Test-HanaPath $$_.ExecutablePath) -or (Test-HanaCommand $$_.CommandLine))$\r$\n`
  FileWrite $0 `} | ForEach-Object {$\r$\n`
  FileWrite $0 `  Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue$\r$\n`
  FileWrite $0 `}$\r$\n`
  FileClose $0
  Pop $0
!macroend

!macro hanakoWriteInstallDirProcessFinder _SCRIPT
  Push $0
  FileOpen $0 "${_SCRIPT}" w
  FileWrite $0 `$$ErrorActionPreference = 'SilentlyContinue'$\r$\n`
  FileWrite $0 `$$installDir = [Environment]::GetEnvironmentVariable('HANA_INSTALL_DIR')$\r$\n`
  FileWrite $0 `if ([string]::IsNullOrWhiteSpace($$installDir)) { exit 1 }$\r$\n`
  FileWrite $0 `$$installFull = [System.IO.Path]::GetFullPath($$installDir).TrimEnd('\')$\r$\n`
  FileWrite $0 `$$installPrefix = $$installFull + '\'$\r$\n`
  FileWrite $0 `$$selfPid = $$PID$\r$\n`
  FileWrite $0 `$$self = Get-CimInstance Win32_Process -Filter "ProcessId = $$selfPid"$\r$\n`
  FileWrite $0 `$$installerPid = if ($$self) { $$self.ParentProcessId } else { -1 }$\r$\n`
  FileWrite $0 `function Test-HanaPath([string]$$value) {$\r$\n`
  FileWrite $0 `  if ([string]::IsNullOrWhiteSpace($$value)) { return $$false }$\r$\n`
  FileWrite $0 `  try {$\r$\n`
  FileWrite $0 `    $$full = [System.IO.Path]::GetFullPath($$value)$\r$\n`
  FileWrite $0 `    return $$full.Equals($$installFull, [StringComparison]::OrdinalIgnoreCase) -or $$full.StartsWith($$installPrefix, [StringComparison]::OrdinalIgnoreCase)$\r$\n`
  FileWrite $0 `  } catch { return $$false }$\r$\n`
  FileWrite $0 `}$\r$\n`
  FileWrite $0 `function Test-HanaCommand([string]$$value) {$\r$\n`
  FileWrite $0 `  if ([string]::IsNullOrWhiteSpace($$value)) { return $$false }$\r$\n`
  FileWrite $0 `  $$quotedPrefix = '"' + $$installPrefix$\r$\n`
  FileWrite $0 `  return $$value.StartsWith($$installPrefix, [StringComparison]::OrdinalIgnoreCase) -or $$value.IndexOf($$quotedPrefix, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or $$value.IndexOf(' ' + $$installPrefix, [StringComparison]::OrdinalIgnoreCase) -ge 0$\r$\n`
  FileWrite $0 `}$\r$\n`
  FileWrite $0 `$$matches = @(Get-CimInstance Win32_Process | Where-Object {$\r$\n`
  FileWrite $0 `  $$_.ProcessId -ne $$selfPid -and $$_.ProcessId -ne $$installerPid -and ((Test-HanaPath $$_.ExecutablePath) -or (Test-HanaCommand $$_.CommandLine))$\r$\n`
  FileWrite $0 `})$\r$\n`
  FileWrite $0 `$$matches | ForEach-Object {$\r$\n`
  FileWrite $0 `  Write-Output ("Hanako-owned process still running: {0} pid={1} path={2}" -f $$_.Name, $$_.ProcessId, $$_.ExecutablePath)$\r$\n`
  FileWrite $0 `}$\r$\n`
  FileWrite $0 `if ($$matches.Count -gt 0) { exit 0 } else { exit 1 }$\r$\n`
  FileClose $0
  Pop $0
!macroend

!macro hanakoStopInstallDirProcesses
  ; Stop every process launched from this install root. This catches renamed
  ; helper processes and stale child processes that do not use fixed image names.
  Push $0
  Push $1
  InitPluginsDir
  StrCpy $1 "$PLUGINSDIR\hanako-stop-install-dir.ps1"
  !insertmacro hanakoWriteInstallDirProcessCleaner "$1"
  System::Call 'kernel32::SetEnvironmentVariable(t "HANA_INSTALL_DIR", t "$INSTDIR") i.r0'
  nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$1"`
  Pop $0
  Pop $1
  Pop $0
!macroend

!macro hanakoFindInstallDirProcesses _RETURN
  Push $0
  Push $1
  InitPluginsDir
  StrCpy $1 "$PLUGINSDIR\hanako-find-install-dir.ps1"
  !insertmacro hanakoWriteInstallDirProcessFinder "$1"
  System::Call 'kernel32::SetEnvironmentVariable(t "HANA_INSTALL_DIR", t "$INSTDIR") i.r0'
  nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$1"`
  Pop ${_RETURN}
  Pop $1
  Pop $0
!macroend

!macro hanakoBypassOldUninstallerForUpdate
  ${If} ${isUpdated}
    DetailPrint "Update mode detected; bypassing the previous uninstaller and preparing a Hana-owned overlay."
    !insertmacro hanakoPrepareOwnedOverlay
    DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}"
    !ifdef UNINSTALL_REGISTRY_KEY_2
      DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY_2}"
    !endif
    ClearErrors
  ${EndIf}
!macroend

!macro customInstallMode
  ${If} ${isUpdated}
    ${If} $installMode == "all"
      StrCpy $isForceMachineInstall "1"
    ${Else}
      StrCpy $isForceCurrentInstall "1"
    ${EndIf}
  ${EndIf}
!macroend

Function hanakoSkipFinishPageForUpdate
  ${If} ${isUpdated}
    Abort
  ${EndIf}
FunctionEnd

!macro customInstall
  ${If} ${isUpdated}
  ${AndIf} ${isForceRun}
    HideWindow
    StrCpy $1 "--updated"
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  ${EndIf}
!macroend

!macro customFinishPage
  !ifndef HIDE_RUN_AFTER_FINISH
    Function StartApp
      ${if} ${isUpdated}
        StrCpy $1 "--updated"
      ${else}
        StrCpy $1 ""
      ${endif}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    FunctionEnd

    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !endif

  !define MUI_PAGE_CUSTOMFUNCTION_PRE hanakoSkipFinishPageForUpdate
  !insertmacro MUI_PAGE_FINISH
!macroend

!macro customCheckAppRunning
  !insertmacro hanakoBypassOldUninstallerForUpdate
  !insertmacro hanakoStopInstallDirProcesses
  !insertmacro hanakoFindInstallDirProcesses $R0
  ${If} $R0 == 0
    DetailPrint "Detected Hanako-owned process in install directory; closing it before install."
    Sleep 500
    !insertmacro hanakoStopInstallDirProcesses

    StrCpy $R1 0
    hanako_check_install_dir_processes:
      !insertmacro hanakoFindInstallDirProcesses $R0
      ${If} $R0 == 0
        IntOp $R1 $R1 + 1
        DetailPrint "Waiting for Hanako-owned install-directory processes to close."
        ${If} $R1 > 2
          DetailPrint "Hanako-owned install-directory processes still running; asking user to retry."
          MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY hanako_retry_install_dir_close
          Quit
          hanako_retry_install_dir_close:
          StrCpy $R1 0
        ${EndIf}
        !insertmacro hanakoStopInstallDirProcesses
        Sleep 1000
        Goto hanako_check_install_dir_processes
      ${EndIf}
  ${EndIf}

  ${IfNot} ${isUpdated}
  !insertmacro hanakoFindRunningProcesses $R0
  ${If} $R0 == 0
    DetailPrint "Detected Hanako.exe or hana-server.exe; closing them before install."
    !insertmacro hanakoKillRunningProcesses 0
    Sleep 500

    !insertmacro hanakoFindRunningProcesses $R0
    ${If} $R0 == 0
      !insertmacro hanakoKillRunningProcesses 1
      Sleep 1000
    ${EndIf}

    StrCpy $R1 0
    hanako_check_processes:
      !insertmacro hanakoFindRunningProcesses $R0
      ${If} $R0 == 0
        IntOp $R1 $R1 + 1
        DetailPrint "Waiting for Hanako.exe or hana-server.exe to close."
        ${If} $R1 > 2
          DetailPrint "Hanako.exe or hana-server.exe still running; asking user to retry."
          MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY hanako_retry_close
          Quit
          hanako_retry_close:
          StrCpy $R1 0
        ${EndIf}
        !insertmacro hanakoKillRunningProcesses 1
        Sleep 1000
        Goto hanako_check_processes
      ${EndIf}
  ${EndIf}
  ${EndIf}
!macroend

!macro hanakoCleanBundledServer
  ; resources\server is generated on every build. Remove it before copying
  ; new files so a failed stale uninstall cannot leave mixed bundle/deps/native files.
  IfFileExists "$INSTDIR\resources\server\*.*" 0 +3
    DetailPrint "Removing old bundled server resources"
    RMDir /r "$INSTDIR\resources\server"
!macroend

!macro hanakoRemoveOwnedInstallTrees
  DetailPrint "Removing Hana-owned install files"
  SetOutPath "$TEMP"
  RMDir /r "$INSTDIR\resources\server"
  RMDir /r "$INSTDIR\resources\git"
  RMDir /r "$INSTDIR\resources\screenshot-themes"
  RMDir /r "$INSTDIR\resources\app.asar.unpacked"
  Delete "$INSTDIR\resources\app.asar"
  Delete "$INSTDIR\resources\app-update.yml"
  Delete "$INSTDIR\resources\elevate.exe"
  RMDir "$INSTDIR\resources"
  RMDir /r "$INSTDIR\locales"
  RMDir /r "$INSTDIR\swiftshader"
  Delete "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  Delete "$INSTDIR\${UNINSTALL_FILENAME}"
  Delete "$INSTDIR\uninstallerIcon.ico"
  Delete "$INSTDIR\*.pak"
  Delete "$INSTDIR\*.bin"
  Delete "$INSTDIR\*.dat"
  Delete "$INSTDIR\*.dll"
  Delete "$INSTDIR\*.json"
  Delete "$INSTDIR\*.html"
  Delete "$INSTDIR\LICENSE*"
  Delete "$INSTDIR\*.ico"
!macroend

!macro hanakoPrepareOwnedOverlay
  !insertmacro hanakoStopInstallDirProcesses
  !insertmacro hanakoRemoveOwnedInstallTrees
  ClearErrors
!macroend

!macro customInit
  !insertmacro hanakoStopInstallDirProcesses
  ; Wait for file handles to release.
  Sleep 2000
!macroend

!macro customUnInstallCheck
  ${If} ${Errors}
    DetailPrint `Previous uninstaller could not be launched; preparing a Hana-owned overlay.`
  ${ElseIf} $R0 != 0
    DetailPrint `Previous uninstaller exited with code $R0; preparing a Hana-owned overlay.`
  ${EndIf}
  !insertmacro hanakoPrepareOwnedOverlay
  ClearErrors
!macroend

!macro customUnInstallCheckCurrentUser
  ${If} ${Errors}
    DetailPrint `Previous current-user uninstaller could not be launched; continuing with Hana-owned overlay.`
  ${ElseIf} $R0 != 0
    DetailPrint `Previous current-user uninstaller exited with code $R0; continuing with Hana-owned overlay.`
  ${EndIf}
  !insertmacro hanakoPrepareOwnedOverlay
  ClearErrors
!macroend

!macro customRemoveFiles
  !insertmacro hanakoStopInstallDirProcesses
  Delete "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  !insertmacro hanakoRemoveOwnedInstallTrees
  RMDir "$INSTDIR"
!macroend

!macro customUnInit
  !insertmacro hanakoStopInstallDirProcesses
  Sleep 2000
!macroend
