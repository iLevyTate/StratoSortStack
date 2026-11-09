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

; ============================================================================
; MICROSOFT VISUAL C++ REDISTRIBUTABLE HINT
; ============================================================================
; The local AI engine (node-llama-cpp's prebuilt llama-addon.node and its ggml/llama DLLs) imports
; MSVCP140.dll and VCRUNTIME140.dll. A fresh Windows install does not include the VC++ 2015-2022
; runtime, and StratoSort does not redistribute it. When the DLLs are missing, an interactive
; install offers to open Microsoft's download page in the browser (only on Yes; nothing downloads
; here). Silent installs (auto-update, /S) are never interrupted. The app raises the same hint as
; an in-app banner (ai.vc-runtime-missing) if the runtime is still missing at launch.
; Include guards make these safe next to electron-builder's own includes of the same headers.
!include "LogicLib.nsh"
!include "x64.nsh"

!define STRATOSORT_VC_REDIST_URL "https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist"

!macro StratoSortVcRuntimeHint
  ${IfNot} ${Silent}
    Push $R9
    StrCpy $R9 "present"
    ; NSIS runs as a 32-bit process: on 64-bit Windows $SYSDIR is redirected to SysWOW64 unless
    ; file system redirection is off, and the app needs the native (x64/ARM64) runtime in System32.
    ${If} ${RunningX64}
      ${DisableX64FSRedirection}
    ${EndIf}
    ${IfNot} ${FileExists} "$SYSDIR\msvcp140.dll"
      StrCpy $R9 "missing"
    ${EndIf}
    ${IfNot} ${FileExists} "$SYSDIR\vcruntime140.dll"
      StrCpy $R9 "missing"
    ${EndIf}
    ${If} ${RunningX64}
      ${EnableX64FSRedirection}
    ${EndIf}
    ${If} $R9 == "missing"
      ${If} ${Cmd} `MessageBox MB_YESNO|MB_ICONINFORMATION "StratoSort's local AI needs the Microsoft Visual C++ Redistributable, which isn't installed on this PC.$\r$\n$\r$\nOpen Microsoft's download page now? Choose the x64 version (ARM64 on Arm-based PCs), install it, then start StratoSort.$\r$\n$\r$\nYou can also install it later; StratoSort will show the same link." /SD IDNO IDYES`
        ExecShell "open" "${STRATOSORT_VC_REDIST_URL}"
      ${EndIf}
    ${EndIf}
    Pop $R9
  ${EndIf}
!macroend

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

  !insertmacro StratoSortVcRuntimeHint
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


