; StratoSort Themed Installer Hooks (NSIS / MUI2)
;
; Wizard images (header + welcome/finish sidebars) are supplied as BMP files in build resources
; and wired by electron-builder (installerHeader.bmp, installerSidebar.bmp, uninstallerSidebar.bmp).
; Do NOT set MUI_*_BITMAP here to PNG paths — NSIS often shows a blank left panel for PNG.
;
; Custom install/uninstall hooks: marker files + optional app-data cleanup.

; ============================================================================
; WELCOME PAGE CUSTOMIZATION
; ============================================================================
!define MUI_WELCOMEPAGE_TITLE "Welcome to StratoSort Setup"
!define MUI_WELCOMEPAGE_TEXT "This wizard will guide you through the installation of StratoSort.$\r$\n$\r$\nStratoSort uses AI to intelligently organize your files into smart folders. After installation, the app will help you set up local models and OCR components.$\r$\n$\r$\nClick Next to continue."

; ============================================================================
; FINISH PAGE CUSTOMIZATION
; ============================================================================
; electron-builder splices this include into the script header before assistedInstaller.nsh
; defines MUI_FINISHPAGE_RUN, so the "Run StratoSort Stack" checkbox (nsis.runAfterFinish) cannot
; be removed from here and stays checked by default. The text below is written for that state.
!define MUI_FINISHPAGE_TITLE "StratoSort Installation Complete"
!define MUI_FINISHPAGE_TEXT "Setup is complete. The first start can take a minute or two while Windows Security scans the new files; later starts are faster.$\r$\n$\r$\nWhen StratoSort opens, it will guide you through setting up the local AI components.$\r$\n$\r$\nLeave Run StratoSort Stack checked and click Finish to start the app."

; ============================================================================
; DIRECTORY PAGE CUSTOMIZATION
; ============================================================================
!define MUI_DIRECTORYPAGE_TEXT_TOP "Setup will install StratoSort in the following folder. To install in a different folder, click Browse and select another folder. Click Install to start the installation."

; ============================================================================
; ABORT WARNING
; ============================================================================
!define MUI_ABORTWARNING
!define MUI_ABORTWARNING_TEXT "Are you sure you want to cancel StratoSort installation?"

; ============================================================================
; UNINSTALLER PAGES (MUI_UNPAGE_* — separate from MUI_FINISHPAGE_* install strings)
; ============================================================================
!define MUI_UNWELCOMEPAGE_TITLE "Welcome to StratoSort Stack Uninstall"
!define MUI_UNWELCOMEPAGE_TEXT "This wizard will guide you through the removal of StratoSort Stack from your computer.$\r$\n$\r$\nClick Next to continue."

!define MUI_UNFINISHPAGE_TITLE "StratoSort Stack Uninstall Complete"
!define MUI_UNFINISHPAGE_TEXT "StratoSort Stack has been removed from your computer.$\r$\n$\r$\nClick Finish to close this wizard."

!define MUI_UNABORTWARNING
!define MUI_UNABORTWARNING_TEXT "Are you sure you want to cancel StratoSort Stack uninstallation?"

; StratoSort Custom Installer Hooks
; electron-builder already registers uninstaller, shortcuts, and file associations (with
; unregisterFileAssociations on uninstall). Only handle setup markers and optional user-data cleanup.
; Electron userData on Windows is %APPDATA%\StratoSort Stack (Roaming), matching productName.
!macro customInstall
  Delete "$INSTDIR\first-run.marker"
  Delete "$APPDATA\StratoSort Stack\dependency-setup-complete.marker"
  Delete "$APPDATA\StratoSort Stack\first-run.marker"
  ; Legacy / misrouted paths (see userDataMigration.js)
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

  ; Optional full profile removal (electron-builder also supports --delete-app-data on uninstall)
  MessageBox MB_YESNO "Remove all StratoSort Stack settings and data?$\r$\n$\r$\nThis includes:$\r$\n• AI embedding database$\r$\n• User settings and preferences$\r$\n• Application logs" IDNO SkipAppData
    RMDir /r "$APPDATA\StratoSort Stack"
    RMDir /r "$LOCALAPPDATA\StratoSort Stack"
    RMDir /r "$APPDATA\StratoSort"
    RMDir /r "$LOCALAPPDATA\StratoSort"
  SkipAppData:
!macroend


