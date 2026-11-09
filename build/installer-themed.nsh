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
; MICROSOFT VISUAL C++ REDISTRIBUTABLE
; ============================================================================
; The local AI engine (node-llama-cpp's prebuilt llama-addon.node and its ggml/llama DLLs) imports
; MSVCP140.dll and VCRUNTIME140.dll. A fresh Windows install does not include the VC++ 2015-2022
; (v14) runtime. Windows packages bundle Microsoft's unmodified, Microsoft-signed
; vc_redist.<arch>.exe at $INSTDIR\resources\assets\runtime\vcredist\ (electron-builder
; win.extraResources; staged and Authenticode-verified by scripts/setup-vc-redist.js; excluded from
; our own signing by win.signExts).
;
; When the DLLs are missing from the native System32 and this is not an auto-update (the isUpdated flag,
; the --updated flag electron-updater passes), the bundled redistributable runs:
;   interactive: /install /passive /norestart   (progress window only)
;   silent (/S): /install /quiet /norestart
; The runtime installs per-machine, so Windows shows a UAC prompt; this installer itself stays
; per-user and never elevates. Exit codes: 0 and 1638 (same or newer already installed) succeed,
; 3010 succeeds but needs a reboot, 1602 / 1223 mean the user cancelled, anything else failed.
; On cancel or failure an interactive install offers Microsoft's download page (only on Yes); a
; silent install just continues. Either way the app raises the ai.vc-runtime-missing banner at
; launch, whose "Install now" runs the same bundled file.
; Include guards make these safe next to electron-builder's own includes of the same headers.
!include "LogicLib.nsh"
!include "x64.nsh"

!define STRATOSORT_VC_REDIST_URL "https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist"
!define STRATOSORT_VC_REDIST_DIR "$INSTDIR\resources\assets\runtime\vcredist"

; Interactive only: explain, then offer Microsoft's download page (Yes opens it; nothing downloads
; here). REASON must not contain double quotes.
!macro StratoSortVcRuntimeDownloadPrompt REASON
  ${IfNot} ${Silent}
    ${If} ${Cmd} `MessageBox MB_YESNO|MB_ICONINFORMATION "${REASON}$\r$\n$\r$\nOpen Microsoft's download page now? Choose the x64 version (ARM64 on Arm-based PCs), install it, then start StratoSort.$\r$\n$\r$\nYou can also install it later from StratoSort: it shows an Install now button while the runtime is missing." /SD IDNO IDYES`
      ExecShell "open" "${STRATOSORT_VC_REDIST_URL}"
    ${EndIf}
  ${EndIf}
!macroend

!macro StratoSortVcRuntimeInstall
  ${IfNot} ${isUpdated}
    Push $R6
    Push $R7
    Push $R8
    ${IfNot} ${Silent}
      ; installSection.nsh hides details for interactive installs; show our status line.
      SetDetailsPrint textonly
    ${EndIf}

    StrCpy $R7 "present"
    ; NSIS runs as a 32-bit process: on 64-bit Windows $SYSDIR is redirected to SysWOW64 unless
    ; file system redirection is off, and the app needs the native (x64/ARM64) runtime in System32.
    ${If} ${RunningX64}
      ${DisableX64FSRedirection}
    ${EndIf}
    ${IfNot} ${FileExists} "$SYSDIR\msvcp140.dll"
      StrCpy $R7 "missing"
    ${EndIf}
    ${IfNot} ${FileExists} "$SYSDIR\vcruntime140.dll"
      StrCpy $R7 "missing"
    ${EndIf}
    ${If} ${RunningX64}
      ${EnableX64FSRedirection}
    ${EndIf}

    ${If} $R7 == "missing"
      ; Each package carries only its own arch's file. An arm64 build on Arm runs the arm64
      ; redistributable; an x64 build (also when emulated on Arm) runs the x64 one.
      StrCpy $R8 ""
      ${If} ${IsNativeARM64}
      ${AndIf} ${FileExists} "${STRATOSORT_VC_REDIST_DIR}\vc_redist.arm64.exe"
        StrCpy $R8 "${STRATOSORT_VC_REDIST_DIR}\vc_redist.arm64.exe"
      ${ElseIf} ${FileExists} "${STRATOSORT_VC_REDIST_DIR}\vc_redist.x64.exe"
        StrCpy $R8 "${STRATOSORT_VC_REDIST_DIR}\vc_redist.x64.exe"
      ${EndIf}

      ${If} $R8 == ""
        DetailPrint "Microsoft Visual C++ Redistributable is missing and this package does not include its installer."
        !insertmacro StratoSortVcRuntimeDownloadPrompt "StratoSort's local AI needs the Microsoft Visual C++ Redistributable, which isn't installed on this PC."
      ${Else}
        ClearErrors
        ${If} ${Silent}
          DetailPrint "Installing the Microsoft Visual C++ Redistributable (quiet): $R8"
          ExecWait '"$R8" /install /quiet /norestart' $R6
        ${Else}
          DetailPrint "Installing the Microsoft Visual C++ Redistributable; Windows will ask for permission..."
          ExecWait '"$R8" /install /passive /norestart' $R6
        ${EndIf}

        ${If} ${Errors}
          DetailPrint "Microsoft Visual C++ Redistributable installer could not be started."
          !insertmacro StratoSortVcRuntimeDownloadPrompt "The Microsoft Visual C++ Redistributable installer could not be started. StratoSort's local AI needs it."
        ${ElseIf} $R6 == "0"
        ${OrIf} $R6 == "1638"
          DetailPrint "Microsoft Visual C++ Redistributable is installed (exit code $R6)."
        ${ElseIf} $R6 == "3010"
          DetailPrint "Microsoft Visual C++ Redistributable installed; Windows needs a restart to finish (exit code 3010)."
          ${IfNot} ${Silent}
            MessageBox MB_OK|MB_ICONINFORMATION "The Microsoft Visual C++ Redistributable was installed, but Windows needs a restart to finish. If StratoSort says local AI is unavailable, restart your PC." /SD IDOK
          ${EndIf}
        ${ElseIf} $R6 == "1602"
        ${OrIf} $R6 == "1223"
          DetailPrint "Microsoft Visual C++ Redistributable installation was cancelled (exit code $R6)."
          !insertmacro StratoSortVcRuntimeDownloadPrompt "The Microsoft Visual C++ Redistributable was not installed because the installation was cancelled. StratoSort's local AI needs it."
        ${Else}
          DetailPrint "Microsoft Visual C++ Redistributable installation failed (exit code $R6)."
          !insertmacro StratoSortVcRuntimeDownloadPrompt "The Microsoft Visual C++ Redistributable could not be installed (exit code $R6). StratoSort's local AI needs it."
        ${EndIf}
      ${EndIf}
    ${EndIf}

    ${IfNot} ${Silent}
      SetDetailsPrint none
    ${EndIf}
    Pop $R8
    Pop $R7
    Pop $R6
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

  !insertmacro StratoSortVcRuntimeInstall
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


