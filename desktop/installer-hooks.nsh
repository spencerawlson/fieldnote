; NSIS hooks for the Fieldnote installer.
;
; Tauri's generated uninstaller deletes the files it recorded individually, but
; resources declared as directories — node_modules, server, web — are not
; enumerated, so a default uninstall leaves several thousand files and ~200 MB
; behind along with the install directory itself.
;
; These hooks remove the resource trees recursively and then the install
; directory, so an uninstall actually uninstalls.
;
; Deliberately NOT removed: the user's projects, database and uploads, which
; live under %APPDATA%\app.fieldnote.desktop. Uninstalling an application
; should not destroy the documents it created — that is a separate, explicit
; choice the user makes in their file manager.

!macro NSIS_HOOK_PREUNINSTALL
  ; The backend runs as a child of the app. If the window was closed normally
  ; it is already gone; this covers a crash or a forced shutdown, so the
  ; uninstaller is never blocked by a locked node.exe.
  nsExec::Exec 'taskkill /F /IM fieldnote-desktop.exe /T'
  Pop $0
  Sleep 500
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Bundled resource trees, removed recursively.
  RMDir /r "$INSTDIR\node_modules"
  RMDir /r "$INSTDIR\server"
  RMDir /r "$INSTDIR\web"

  ; Anything else the bundle placed at the top level.
  Delete "$INSTDIR\node.exe"
  Delete "$INSTDIR\WebView2Loader.dll"
  Delete "$INSTDIR\package.json"

  ; Finally the install directory itself. RMDir without /r would fail while
  ; the trees above still existed, which is why this comes last.
  RMDir /r "$INSTDIR"
!macroend
