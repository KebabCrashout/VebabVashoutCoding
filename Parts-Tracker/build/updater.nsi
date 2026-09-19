; Parts Tracker Updater
;
; Updates an existing install in place: it finds the current install, then runs the
; bundled Setup silently in upgrade mode. The Setup closes the running app, keeps
; the install folder and shortcuts, and starts the app again. Data lives in
; %APPDATA%\parts-tracker\data, so it is never touched.
;
; Built by scripts/build-updater.js, which passes these defines:
;   PRODUCT_NAME, VERSION, APP_GUID, APP_EXE, SETUP_EXE, OUT_FILE, ICON

Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
!include "WordFunc.nsh"

!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_GUID}"
!define INSTALL_KEY "Software\${APP_GUID}"

Name "${PRODUCT_NAME} Updater"
Caption "${PRODUCT_NAME} Updater ${VERSION}"
OutFile "${OUT_FILE}"
RequestExecutionLevel user
ShowInstDetails show
BrandingText "${PRODUCT_NAME} ${VERSION}"
SetCompressor /SOLID lzma

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${PRODUCT_NAME} Updater"
VIAddVersionKey "FileDescription" "Updates ${PRODUCT_NAME} to version ${VERSION}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "MIT licence"

!define MUI_ICON "${ICON}"
!define MUI_INSTFILESPAGE_FINISHHEADER_TEXT "Update failed"
!define MUI_INSTFILESPAGE_FINISHHEADER_SUBTEXT "See the details below."
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Var InstalledDir
Var InstalledVer

; Reads the current install from the registry, per-user first then all-users.
!macro ReadInstall
  ReadRegStr $InstalledDir HKCU "${INSTALL_KEY}" InstallLocation
  ReadRegStr $InstalledVer HKCU "${UNINSTALL_KEY}" DisplayVersion
  ${If} $InstalledDir == ""
    ReadRegStr $InstalledDir HKLM "${INSTALL_KEY}" InstallLocation
    ReadRegStr $InstalledVer HKLM "${UNINSTALL_KEY}" DisplayVersion
  ${EndIf}
!macroend

Function .onInit
  ${If} ${RunningX64}
    SetRegView 64
  ${EndIf}

  !insertmacro ReadInstall
  ${If} $InstalledDir == ""
  ${OrIfNot} ${FileExists} "$InstalledDir\${APP_EXE}"
    MessageBox MB_OK|MB_ICONEXCLAMATION "${PRODUCT_NAME} isn't installed on this PC, so there is nothing to update.$\r$\n$\r$\nDownload and run ${PRODUCT_NAME} Setup ${VERSION} instead.$\r$\n$\r$\n(Using the portable version? Just download the new portable exe - your parts carry over.)"
    Abort
  ${EndIf}

  ${If} $InstalledVer == "${VERSION}"
    MessageBox MB_YESNO|MB_ICONQUESTION "${PRODUCT_NAME} is already on version ${VERSION}.$\r$\n$\r$\nReinstall it anyway?" IDYES proceed
    Abort
  ${ElseIf} $InstalledVer != ""
    ${VersionCompare} "$InstalledVer" "${VERSION}" $0
    ${If} $0 == 1
      MessageBox MB_YESNO|MB_ICONEXCLAMATION "A newer version of ${PRODUCT_NAME} ($InstalledVer) is already installed.$\r$\n$\r$\nReplace it with the older version ${VERSION}?" IDYES proceed
      Abort
    ${EndIf}
  ${EndIf}
  proceed:
FunctionEnd

Section "Update"
  ${If} $InstalledVer == ""
    DetailPrint "Updating ${PRODUCT_NAME} to ${VERSION}"
  ${Else}
    DetailPrint "Updating ${PRODUCT_NAME} from $InstalledVer to ${VERSION}"
  ${EndIf}
  DetailPrint "Install folder: $InstalledDir"
  DetailPrint "${PRODUCT_NAME} will close if it is open. Your parts and settings are kept."

  InitPluginsDir
  SetDetailsPrint none
  File "/oname=$PLUGINSDIR\setup.exe" "${SETUP_EXE}"
  SetDetailsPrint both

  DetailPrint "Installing..."
  ; The same flags electron-updater uses for a silent in-place upgrade.
  ; An all-users install asks for administrator permission here.
  ExecWait '"$PLUGINSDIR\setup.exe" --updated /S --force-run' $0

  !insertmacro ReadInstall
  ${If} $InstalledVer == "${VERSION}"
    DetailPrint "Done - ${PRODUCT_NAME} is now version ${VERSION}."
    SetAutoClose true
  ${Else}
    DetailPrint "The installer finished with code $0 but version ${VERSION} was not installed."
    MessageBox MB_OK|MB_ICONSTOP "The update didn't finish.$\r$\n$\r$\nIf you declined the administrator prompt, run the updater again and allow it. Otherwise, download ${PRODUCT_NAME} Setup ${VERSION} and run that instead - your parts are kept."
    Abort
  ${EndIf}
SectionEnd
