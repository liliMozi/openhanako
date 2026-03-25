; installer.nsh — NSIS custom hooks for Hanako installer
;
; Kills running Hanako processes before install/uninstall to prevent
; "file in use" errors on Windows overlay installs.

!macro customInit
  ; Kill Electron main process
  nsExec::ExecToLog 'taskkill /F /IM "Hanako.exe"'
  ; Kill bundled server process (renamed node.exe)
  nsExec::ExecToLog 'taskkill /F /IM "hana-server.exe"'
  ; Wait for file handles to release
  Sleep 2000
!macroend

!macro customUnInit
  nsExec::ExecToLog 'taskkill /F /IM "Hanako.exe"'
  nsExec::ExecToLog 'taskkill /F /IM "hana-server.exe"'
  Sleep 2000
!macroend
