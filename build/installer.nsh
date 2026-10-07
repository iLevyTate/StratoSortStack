; StratoSort Custom Installer Hooks
; This file contains custom NSIS code that runs during installation
; NOTE: This is the basic version. installer-themed.nsh is used by default.

; Kept in sync with installer-themed.nsh (see that file for rationale).
!macro customInstall
  Delete "$INSTDIR\first-run.marker"
  Delete "$APPDATA\StratoSort Stack\dependency-setup-complete.marker"
  Delete "$APPDATA\StratoSort Stack\first-run.marker"
  Delete "$APPDATA\StratoSort\dependency-setup-complete.marker"
  Delete "$APPDATA\StratoSort\first-run.marker"
  Delete "$LOCALAPPDATA\StratoSort\dependency-setup-complete.marker"
!macroend

!macro customUnInstall
  Delete "$INSTDIR\first-run.marker"
  Delete "$APPDATA\StratoSort Stack\dependency-setup-complete.marker"
  Delete "$APPDATA\StratoSort Stack\first-run.marker"
  Delete "$APPDATA\StratoSort\dependency-setup-complete.marker"
  Delete "$LOCALAPPDATA\StratoSort\dependency-setup-complete.marker"

  MessageBox MB_YESNO "Remove all StratoSort Stack settings and data?$\r$\n$\r$\nThis includes:$\r$\n• AI embedding database$\r$\n• User settings and preferences$\r$\n• Application logs" IDNO SkipAppData
    RMDir /r "$APPDATA\StratoSort Stack"
    RMDir /r "$LOCALAPPDATA\StratoSort Stack"
    RMDir /r "$APPDATA\StratoSort"
    RMDir /r "$LOCALAPPDATA\StratoSort"
  SkipAppData:
!macroend