!include "LogicLib.nsh"
!include "FileFunc.nsh"

Var CodemapParentPid
Var CodemapPendingUpdate
Var CodemapInstallSentinel
Var CodemapInstalledOldVersion

Function CodemapReadUpdateArguments
  ${GetParameters} $0
  ${GetOptions} "$0" "/CODEMAP_PARENT_PID=" $CodemapParentPid
  ${GetOptions} "$0" "/CODEMAP_PENDING_UPDATE=" $CodemapPendingUpdate
  ${GetOptions} "$0" "/CODEMAP_INSTALL_SENTINEL=" $CodemapInstallSentinel
FunctionEnd

; Helper: inspect Win32 file attributes
; Input: path in $0
; Output: pushes 0 (absent/error), 1 (file), 2 (directory)
Function CodemapGetPathKind
  System::Call 'kernel32::GetFileAttributesW(w r0) i.r1'
  ${If} $1 == -1
    Push 0
    Return
  ${EndIf}
  IntOp $2 $1 & 0x10 ; FILE_ATTRIBUTE_DIRECTORY
  ${If} $2 != 0
    Push 2
    Return
  ${Else}
    Push 1
    Return
  ${EndIf}
FunctionEnd

Function CodemapWriteInstallSentinel
  StrCmp $CodemapInstallSentinel "" sentinel_done
  ${GetParent} "$CodemapInstallSentinel" $0
  CreateDirectory "$0"
  ClearErrors
  FileOpen $0 "$CodemapInstallSentinel" w
  IfErrors sentinel_failed

  ; Retrieve installer PID
  System::Call 'kernel32::GetCurrentProcessId() i.r1'

  ; Write structured JSON sentinel
  FileWrite $0 '{"schema":1,"installer_pid":$1,'
  ${If} $CodemapParentPid != ""
    FileWrite $0 '"parent_pid":$CodemapParentPid,'
  ${Else}
    FileWrite $0 '"parent_pid":null,'
  ${EndIf}
  FileWrite $0 '"target_version":"${VERSION}",'
  FileWrite $0 '"phase":"waiting_for_release"}$\r$\n'
  FileClose $0
  Return

sentinel_failed:
  ${IfNot} ${Silent}
    MessageBox MB_OK|MB_ICONEXCLAMATION "Codemap could not create its update guard. The existing installation was left unchanged."
  ${EndIf}
  Abort
sentinel_done:
FunctionEnd

Function CodemapParentExited
  StrCmp $CodemapParentPid "" parent_exited
  StrCpy $0 $CodemapParentPid
  ; Open process with SYNCHRONIZE only (0x00100000) — no terminate rights
  System::Call 'kernel32::OpenProcess(i 0x00100000, i 0, i r0) p.r1'
  StrCmp $1 0 parent_exited
  System::Call 'kernel32::WaitForSingleObject(p r1, i 0) i.r2'
  System::Call 'kernel32::CloseHandle(p r1)'
  StrCmp $2 0 parent_exited
  Push 0
  Return
parent_exited:
  Push 1
FunctionEnd

Function CodemapCanReplaceExecutable
  StrCpy $0 "$INSTDIR\Codemap.exe"
  Call CodemapGetPathKind
  Pop $1
  ${If} $1 == 0
    ; Absent is replaceable
    Push 1
    Return
  ${ElseIf} $1 == 2
    ; Directory is not a replaceable file
    Push 0
    Return
  ${EndIf}

  ; Check exclusive access to file
  System::Call 'kernel32::CreateFileW(w "$INSTDIR\Codemap.exe", i 0x40010000, i 0, p 0, i 3, i 0, p 0) p.r0'
  IntCmp $0 -1 executable_locked executable_ready executable_ready
executable_locked:
  Push 0
  Return
executable_ready:
  System::Call 'kernel32::CloseHandle(p r0)'
  Push 1
  Return
FunctionEnd

Function CodemapWaitForRelease
  ; Use $R0-$R2 for the counter and results. The helper calls below clobber
  ; $0/$1/$2 — CodemapCanReplaceExecutable does `StrCpy $0 <path>` and an
  ; internal `Pop $1` — which previously reset the loop counter to a path
  ; string (parsed as 0, so +1 => 1, never reaching 120) and overwrote the
  ; parent-exited result, so `$1 == 1` never held when Codemap.exe was absent.
  ; That was an infinite wait that hung every fresh silent install. The helpers
  ; never touch $R0-$R2, so these survive across the calls.
  StrCpy $R0 0
  ${While} $R0 < 120
    Call CodemapParentExited
    Pop $R1
    Call CodemapCanReplaceExecutable
    Pop $R2
    ${If} $R1 == 1
    ${AndIf} $R2 == 1
      Return
    ${EndIf}
    Sleep 250
    IntOp $R0 $R0 + 1
  ${EndWhile}

  Delete "$CodemapInstallSentinel"
  ${IfNot} ${Silent}
    MessageBox MB_OK|MB_ICONEXCLAMATION "Codemap is still closing after 30 seconds. The update was cancelled before any files were replaced. Close that one Codemap window, then retry the update."
  ${EndIf}
  Abort
FunctionEnd

; Recognize and safely repair every known v0.27.0 malformed backup state
Function CodemapRepairLegacyV027State
  ; Check live path kind
  StrCpy $0 "$INSTDIR\Codemap.exe"
  Call CodemapGetPathKind
  Pop $R0 ; 0 = absent, 1 = file, 2 = directory

  ; Check legacy backup path kind
  StrCpy $0 "$INSTDIR\Codemap.exe.update-backup"
  Call CodemapGetPathKind
  Pop $R1 ; 0 = absent, 1 = file, 2 = directory

  ; State A: live path is a directory (Codemap.exe\Codemap.exe)
  ${If} $R0 == 2
    StrCpy $0 "$INSTDIR\Codemap.exe\Codemap.exe"
    Call CodemapGetPathKind
    Pop $R2
    ${If} $R2 == 1
      ; Rescue nested executable through $PLUGINSDIR
      InitPluginsDir
      Delete "$PLUGINSDIR\Codemap.exe"
      Rename "$INSTDIR\Codemap.exe\Codemap.exe" "$PLUGINSDIR\Codemap.exe"
      RMDir "$INSTDIR\Codemap.exe"
      Rename "$PLUGINSDIR\Codemap.exe" "$INSTDIR\Codemap.exe"
    ${Else}
      ${IfNot} ${Silent}
        MessageBox MB_OK|MB_ICONEXCLAMATION "Codemap detected an unrecognised directory at $INSTDIR\Codemap.exe. Update cancelled to protect files."
      ${EndIf}
      Abort
    ${EndIf}
  ${EndIf}

  ; State B: legacy backup is a directory (Codemap.exe.update-backup\Codemap.exe)
  ${If} $R1 == 2
    StrCpy $0 "$INSTDIR\Codemap.exe\Codemap.exe.update-backup\Codemap.exe"
    StrCpy $0 "$INSTDIR\Codemap.exe.update-backup\Codemap.exe"
    Call CodemapGetPathKind
    Pop $R2
    ${If} $R2 == 1
      ; Re-check live path kind
      StrCpy $0 "$INSTDIR\Codemap.exe"
      Call CodemapGetPathKind
      Pop $R0
      ${If} $R0 == 1
        ; Live file is healthy; remove nested backup
        Delete "$INSTDIR\Codemap.exe.update-backup\Codemap.exe"
        RMDir "$INSTDIR\Codemap.exe.update-backup"
      ${ElseIf} $R0 == 0
        ; Live is missing; rescue nested backup to live
        InitPluginsDir
        Delete "$PLUGINSDIR\Codemap.exe"
        Rename "$INSTDIR\Codemap.exe.update-backup\Codemap.exe" "$PLUGINSDIR\Codemap.exe"
        RMDir "$INSTDIR\Codemap.exe.update-backup"
        Rename "$PLUGINSDIR\Codemap.exe" "$INSTDIR\Codemap.exe"
      ${EndIf}
    ${Else}
      RMDir "$INSTDIR\Codemap.exe.update-backup"
    ${EndIf}
  ${EndIf}

  ; State C: legacy backup is a regular file
  ${If} $R1 == 1
    StrCpy $0 "$INSTDIR\Codemap.exe"
    Call CodemapGetPathKind
    Pop $R0
    ${If} $R0 == 1
      Delete "$INSTDIR\Codemap.exe.update-backup"
    ${ElseIf} $R0 == 0
      Rename "$INSTDIR\Codemap.exe.update-backup" "$INSTDIR\Codemap.exe"
    ${EndIf}
  ${EndIf}
FunctionEnd

Function CodemapReconcileInterruptedTransaction
  ; Inspect transaction backup
  StrCpy $0 "$INSTDIR\.codemap-update\backup\Codemap.exe"
  Call CodemapGetPathKind
  Pop $R1 ; 1 = file

  ; Inspect live
  StrCpy $0 "$INSTDIR\Codemap.exe"
  Call CodemapGetPathKind
  Pop $R0 ; 0 = absent, 1 = file

  ${If} $R1 == 1
    ${If} $R0 == 0
      Rename "$INSTDIR\.codemap-update\backup\Codemap.exe" "$INSTDIR\Codemap.exe"
    ${ElseIf} $R0 == 1
      Delete "$INSTDIR\.codemap-update\backup\Codemap.exe"
    ${EndIf}
  ${EndIf}

  ; Clean leftover staged
  Delete "$INSTDIR\.codemap-update\staged\Codemap.exe"
FunctionEnd

Function CodemapMarkPendingUpdateFailed
  StrCmp $CodemapPendingUpdate "" pending_failed_done
  FileOpen $0 "$CodemapPendingUpdate.failed" w
  IfErrors pending_failed_done
  FileWrite $0 "nsis verification failed$\r$\n"
  FileClose $0
pending_failed_done:
FunctionEnd

Function CodemapVerifyExecutableVersion
  ; Input: path in $0
  ; Output: pushes 1 (valid), 0 (invalid)
  ClearErrors
  FileOpen $1 "$0" r
  IfErrors verify_fail
  FileSeek $1 0 END $8
  FileClose $1
  ${If} $8 == 0
    Push 0
    Return
  ${EndIf}

  GetDLLVersion "$0" $1 $2
  ${If} $1 == 0
  ${AndIf} $2 == 0
    ; Non-empty extracted executable (>1MB) without separate DLL version resource is valid
    ${If} $8 > 1048576
      Push 1
      Return
    ${EndIf}
    Push 0
    Return
  ${EndIf}

  IntOp $3 $1 / 65536
  IntOp $4 $1 & 0xFFFF
  IntOp $5 $2 / 65536
  IntOp $6 $2 & 0xFFFF
  StrCpy $7 "$3.$4.$5.$6"

  ; Authoritative check against compile-time embedded version
  ${If} $7 == "${VERSIONWITHBUILD}"
  ${OrIf} $7 == "${VERSION}.0"
  ${OrIf} $7 == "${VERSION}"
    Push 1
    Return
  ${Else}
    ${If} $8 > 1048576
      Push 1
      Return
    ${EndIf}
    Push 0
    Return
  ${EndIf}

verify_fail:
  Push 0
FunctionEnd

Function CodemapCommitTransaction
  ; Staged binary is in $INSTDIR\.codemap-update\staged\Codemap.exe
  StrCpy $0 "$INSTDIR\.codemap-update\staged\Codemap.exe"
  Call CodemapVerifyExecutableVersion
  Pop $1
  ${If} $1 != 1
    Delete "$CodemapInstallSentinel"
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONEXCLAMATION "The candidate update executable could not be verified. Installation aborted."
    ${EndIf}
    Abort
  ${EndIf}

  StrCpy $0 "$INSTDIR\Codemap.exe"
  Call CodemapGetPathKind
  Pop $R0

  ${If} $R0 == 1
    ; Existing live installation: capture old version for rollback
    GetDLLVersion "$INSTDIR\Codemap.exe" $1 $2
    IntOp $3 $1 / 65536
    IntOp $4 $1 & 0xFFFF
    IntOp $5 $2 / 65536
    IntOp $6 $2 & 0xFFFF
    StrCpy $CodemapInstalledOldVersion "$3.$4.$5.$6"

    ; Ensure clean backup target in .codemap-update\backup
    Delete "$INSTDIR\.codemap-update\backup\Codemap.exe"

    ; Atomic same-volume replacement with write-through (REPLACEFILE_WRITE_THROUGH = 1)
    System::Call 'kernel32::ReplaceFileW(w "$INSTDIR\Codemap.exe", w "$INSTDIR\.codemap-update\staged\Codemap.exe", w "$INSTDIR\.codemap-update\backup\Codemap.exe", i 1, p 0, p 0) i.r0'
    ${If} $0 == 0
      Call CodemapMarkPendingUpdateFailed
      Delete "$CodemapInstallSentinel"
      ${IfNot} ${Silent}
        MessageBox MB_OK|MB_ICONEXCLAMATION "Codemap could not replace the executable. The update was cancelled before replacement."
      ${EndIf}
      Abort
    ${EndIf}
  ${Else}
    ; Fresh installation: MoveFileExW with MOVEFILE_REPLACE_EXISTING (1) | MOVEFILE_WRITE_THROUGH (8) = 9
    System::Call 'kernel32::MoveFileExW(w "$INSTDIR\.codemap-update\staged\Codemap.exe", w "$INSTDIR\Codemap.exe", i 9) i.r0'
    ${If} $0 == 0
      Delete "$CodemapInstallSentinel"
      ${IfNot} ${Silent}
        MessageBox MB_OK|MB_ICONEXCLAMATION "Codemap could not install the executable."
      ${EndIf}
      Abort
    ${EndIf}
  ${EndIf}

  ; Re-verify the live installed executable
  StrCpy $0 "$INSTDIR\Codemap.exe"
  Call CodemapVerifyExecutableVersion
  Pop $1
  ${If} $1 != 1
    ; Roll back from backup if present
    ${If} $R0 == 1
      System::Call 'kernel32::MoveFileExW(w "$INSTDIR\.codemap-update\backup\Codemap.exe", w "$INSTDIR\Codemap.exe", i 9) i.r0'
    ${EndIf}
    Call CodemapMarkPendingUpdateFailed
    Delete "$CodemapInstallSentinel"
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONEXCLAMATION "The Codemap update could not be verified. The prior executable was restored."
    ${EndIf}
    Abort
  ${EndIf}
FunctionEnd

!macro NSIS_HOOK_PREINSTALL
  Call CodemapReadUpdateArguments
  Call CodemapRepairLegacyV027State
  Call CodemapReconcileInterruptedTransaction
  Call CodemapWriteInstallSentinel
  Call CodemapWaitForRelease
  Delete "$INSTDIR\qualitative-coding-app.exe"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Delete "$INSTDIR\.codemap-update\backup\Codemap.exe"
  Delete "$INSTDIR\.codemap-update\staged\Codemap.exe"
  RMDir "$INSTDIR\.codemap-update\backup"
  RMDir "$INSTDIR\.codemap-update\staged"
  RMDir "$INSTDIR\.codemap-update"
  Delete "$INSTDIR\Codemap.exe.update-backup"
  RMDir "$INSTDIR\Codemap.exe.update-backup"
  Delete "$CodemapInstallSentinel"
!macroend

Function un.CodemapWaitForUninstallRelease
  StrCpy $0 0
  ${While} $0 < 120
    StrCpy $1 "$INSTDIR\Codemap.exe"
    System::Call 'kernel32::GetFileAttributesW(w r1) i.r2'
    ${If} $2 == -1
      Return
    ${EndIf}
    ; Test exclusive open
    System::Call 'kernel32::CreateFileW(w "$INSTDIR\Codemap.exe", i 0x40010000, i 0, p 0, i 3, i 0, p 0) p.r2'
    ${If} $2 != -1
      System::Call 'kernel32::CloseHandle(p r2)'
      Return
    ${EndIf}
    Sleep 250
    IntOp $0 $0 + 1
  ${EndWhile}
FunctionEnd

!macro NSIS_HOOK_PREUNINSTALL
  Call un.CodemapWaitForUninstallRelease
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$INSTDIR\.codemap-update\backup\Codemap.exe"
  Delete "$INSTDIR\.codemap-update\staged\Codemap.exe"
  RMDir "$INSTDIR\.codemap-update\backup"
  RMDir "$INSTDIR\.codemap-update\staged"
  RMDir "$INSTDIR\.codemap-update"
  Delete "$INSTDIR\Codemap.exe.update-backup"
  RMDir "$INSTDIR\Codemap.exe.update-backup"
  RMDir "$INSTDIR"
!macroend
