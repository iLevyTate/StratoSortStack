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
!ifdef MUI_FINISHPAGE_RUN
  !undef MUI_FINISHPAGE_RUN
!endif
!ifdef MUI_FINISHPAGE_RUN_TEXT
  !undef MUI_FINISHPAGE_RUN_TEXT
!endif
!define MUI_FINISHPAGE_TITLE "StratoSort Installation Complete"
!define MUI_FINISHPAGE_TEXT "StratoSort has been installed on your computer.$\r$\n$\r$\nWhen you first launch, you'll be guided through setting up AI components for intelligent file organization.$\r$\n$\r$\nClick Finish to exit Setup."

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
!define MUI_UNWELCOMEPAGE_TITLE "Welcome to StratoSort Core Uninstall"
!define MUI_UNWELCOMEPAGE_TEXT "This wizard will guide you through the removal of StratoSort Core from your computer.$\r$\n$\r$\nClick Next to continue."

!define MUI_UNFINISHPAGE_TITLE "StratoSort Core Uninstall Complete"
!define MUI_UNFINISHPAGE_TEXT "StratoSort Core has been removed from your computer.$\r$\n$\r$\nClick Finish to close this wizard."

!define MUI_UNABORTWARNING
!define MUI_UNABORTWARNING_TEXT "Are you sure you want to cancel StratoSort Core uninstallation?"

; StratoSort Custom Installer Hooks
; electron-builder already registers uninstaller, shortcuts, and file associations (with
; unregisterFileAssociations on uninstall). Only handle setup markers and optional user-data cleanup.
; Electron userData on Windows is %APPDATA%\StratoSort Core (Roaming), matching productName.
!macro customInstall
  Delete "$INSTDIR\first-run.marker"
  Delete "$APPDATA\StratoSort Core\dependency-setup-complete.marker"
  Delete "$APPDATA\StratoSort Core\first-run.marker"
  ; Legacy / misrouted paths (see userDataMigration.js)
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

  ; Optional full profile removal (electron-builder also supports --delete-app-data on uninstall)
  MessageBox MB_YESNO "Remove all StratoSort Core settings and data?$\r$\n$\r$\nThis includes:$\r$\n• AI embedding database$\r$\n• User settings and preferences$\r$\n• Application logs" IDNO SkipAppData
    RMDir /r "$APPDATA\StratoSort Core"
    RMDir /r "$LOCALAPPDATA\StratoSort Core"
    RMDir /r "$APPDATA\StratoSort"
    RMDir /r "$LOCALAPPDATA\StratoSort"
  SkipAppData:
!macroend


