; StratoSort Custom Installer Hooks
; This file contains custom NSIS code that runs during installation
; NOTE: This is the basic version. installer-themed.nsh is used by default.

; Kept in sync with installer-themed.nsh (see that file for rationale).
!macro customInstall
  Delete "$INSTDIR\first-run.marker"
  Delete "$APPDATA\StratoSort Core\dependency-setup-complete.marker"
  Delete "$APPDATA\StratoSort Core\first-run.marker"
  Delete "$APPDATA\StratoSort\dependency-setup-complete.marker"
  Delete "$APPDATA\StratoSort\first-run.marker"
  Delete "$LOCALAPPDATA\StratoSort\dependency-setup-complete.marker"
!macroend

!macro customUnInstall
  Delete "$INSTDIR\first-run.marker"
  Delete "$APPDATA\StratoSort Core\dependency-setup-complete.marker"
  Delete "$APPDATA\StratoSort Core\first-run.marker"
  Delete "$APPDATA\StratoSort\dependency-setup-complete.marker"
  Delete "$LOCALAPPDATA\StratoSort\dependency-setup-complete.marker"

  MessageBox MB_YESNO "Remove all StratoSort Core settings and data?$\r$\n$\r$\nThis includes:$\r$\n• AI embedding database$\r$\n• User settings and preferences$\r$\n• Application logs" IDNO SkipAppData
    RMDir /r "$APPDATA\StratoSort Core"
    RMDir /r "$LOCALAPPDATA\StratoSort Core"
    RMDir /r "$APPDATA\StratoSort"
    RMDir /r "$LOCALAPPDATA\StratoSort"
  SkipAppData:
!macroend