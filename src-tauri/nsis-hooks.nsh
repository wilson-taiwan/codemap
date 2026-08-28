!include "LogicLib.nsh"
!include "FileFunc.nsh"

Var FleuronParentPid
Var FleuronPendingUpdate
Var FleuronInstallSentinel
Var FleuronInstalledOldVersion

Function FleuronReadUpdateArguments
  ${GetParameters} $0
  ${GetOptions} "$0" "/FLEURON_PARENT_PID=" $FleuronParentPid
  ${GetOptions} "$0" "/FLEURON_PENDING_UPDATE=" $FleuronPendingUpdate
  ${GetOptions} "$0" "/FLEURON_INSTALL_SENTINEL=" $FleuronInstallSentinel
FunctionEnd

; Helper: inspect Win32 file attributes
; Input: path in $0
; Output: pushes 0 (absent/error), 1 (file), 2 (directory)
Function FleuronGetPathKind
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

Function FleuronWriteInstallSentinel
  StrCmp $FleuronInstallSentinel "" sentinel_done
  ${GetParent} "$FleuronInstallSentinel" $0
  CreateDirectory "$0"
  ClearErrors
  FileOpen $0 "$FleuronInstallSentinel" w
  IfErrors sentinel_failed

  ; Retrieve installer PID
  System::Call 'kernel32::GetCurrentProcessId() i.r1'

  ; Write structured JSON sentinel
  FileWrite $0 '{"schema":1,"installer_pid":$1,'
  ${If} $FleuronParentPid != ""
    FileWrite $0 '"parent_pid":$FleuronParentPid,'
  ${Else}
    FileWrite $0 '"parent_pid":null,'
  ${EndIf}
  FileWrite $0 '"target_version":"${VERSION}",'
  FileWrite $0 '"phase":"waiting_for_release"}$\r$\n'
  FileClose $0
  Return

sentinel_failed:
  ${IfNot} ${Silent}
    MessageBox MB_OK|MB_ICONEXCLAMATION "Fleuron could not create its update guard. The existing installation was left unchanged."
  ${EndIf}
  Abort
sentinel_done:
FunctionEnd

Function FleuronParentExited
  StrCmp $FleuronParentPid "" parent_exited
  StrCpy $0 $FleuronParentPid
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

Function FleuronCanReplaceExecutable
  StrCpy $0 "$INSTDIR\Fleuron.exe"
  Call FleuronGetPathKind
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
  System::Call 'kernel32::CreateFileW(w "$INSTDIR\Fleuron.exe", i 0x40010000, i 0, p 0, i 3, i 0, p 0) p.r0'
  IntCmp $0 -1 executable_locked executable_ready executable_ready
executable_locked:
  Push 0
  Return
executable_ready:
  System::Call 'kernel32::CloseHandle(p r0)'
  Push 1
  Return
FunctionEnd

Function FleuronWaitForRelease
  ; Use $R0-$R2 for the counter and results. The helper calls below clobber
  ; $0/$1/$2 — FleuronCanReplaceExecutable does `StrCpy $0 <path>` and an
  ; internal `Pop $1` — which previously reset the loop counter to a path
  ; string (parsed as 0, so +1 => 1, never reaching 120) and overwrote the
  ; parent-exited result, so `$1 == 1` never held when Fleuron.exe was absent.
  ; That was an infinite wait that hung every fresh silent install. The helpers
  ; never touch $R0-$R2, so these survive across the calls.
  StrCpy $R0 0
  ${While} $R0 < 120
    Call FleuronParentExited
    Pop $R1
    Call FleuronCanReplaceExecutable
    Pop $R2
    ${If} $R1 == 1
    ${AndIf} $R2 == 1
      Return
    ${EndIf}
    Sleep 250
    IntOp $R0 $R0 + 1
  ${EndWhile}

  Delete "$FleuronInstallSentinel"
  ${IfNot} ${Silent}
    MessageBox MB_OK|MB_ICONEXCLAMATION "Fleuron is still closing after 30 seconds. The update was cancelled before any files were replaced. Close that one Fleuron window, then retry the update."
  ${EndIf}
  Abort
FunctionEnd

; Recognize and safely repair every known v0.27.0 malformed backup state.
;
; These probes target `$INSTDIR\Fleuron.exe` — the executable THIS installer
; manages. The 2.0.0 rename plan said to keep the old `Codemap.exe` literals
; because "the state carries the old name". That was wrong, and the Windows
; installer matrix caught it (`poison_directory_repaired`, 1 of 4 cases failed):
;
;   * `productName` changed, so 2.0.0 installs into the Fleuron INSTDIR. A
;     v0.27.0-poisoned install sits in a DIFFERENT directory that this installer
;     never visits, which made the old literals unreachable dead probes.
;   * Meanwhile the live path this function exists to protect — `Fleuron.exe`
;     becoming a directory instead of a file — was left entirely unguarded.
;     That is the exact failure mode of v0.27.0.
;
; Probing the wrong path is worse than not probing at all: it builds clean, it
; passes every static NSIS text assertion, and it only misbehaves during an
; upgrade, on a platform no macOS gate exercises.
Function FleuronRepairLegacyV027State
  ; Check live path kind
  StrCpy $0 "$INSTDIR\Fleuron.exe"
  Call FleuronGetPathKind
  Pop $R0 ; 0 = absent, 1 = file, 2 = directory

  ; Check legacy backup path kind
  StrCpy $0 "$INSTDIR\Fleuron.exe.update-backup"
  Call FleuronGetPathKind
  Pop $R1 ; 0 = absent, 1 = file, 2 = directory

  ; State A: live path is a directory (Fleuron.exe\Fleuron.exe)
  ${If} $R0 == 2
    StrCpy $0 "$INSTDIR\Fleuron.exe\Fleuron.exe"
    Call FleuronGetPathKind
    Pop $R2
    ${If} $R2 == 1
      ; Rescue nested executable through $PLUGINSDIR
      InitPluginsDir
      Delete "$PLUGINSDIR\Fleuron.exe"
      Rename "$INSTDIR\Fleuron.exe\Fleuron.exe" "$PLUGINSDIR\Fleuron.exe"
      RMDir "$INSTDIR\Fleuron.exe"
      Rename "$PLUGINSDIR\Fleuron.exe" "$INSTDIR\Fleuron.exe"
    ${Else}
      ${IfNot} ${Silent}
        MessageBox MB_OK|MB_ICONEXCLAMATION "Fleuron detected an unrecognised directory at $INSTDIR\Fleuron.exe. Update cancelled to protect files."
      ${EndIf}
      Abort
    ${EndIf}
  ${EndIf}

  ; State B: legacy backup is a directory (Fleuron.exe.update-backup\Fleuron.exe)
  ${If} $R1 == 2
    StrCpy $0 "$INSTDIR\Fleuron.exe\Fleuron.exe.update-backup\Fleuron.exe"
    StrCpy $0 "$INSTDIR\Fleuron.exe.update-backup\Fleuron.exe"
    Call FleuronGetPathKind
    Pop $R2
    ${If} $R2 == 1
      ; Re-check live path kind
      StrCpy $0 "$INSTDIR\Fleuron.exe"
      Call FleuronGetPathKind
      Pop $R0
      ${If} $R0 == 1
        ; Live file is healthy; remove nested backup
        Delete "$INSTDIR\Fleuron.exe.update-backup\Fleuron.exe"
        RMDir "$INSTDIR\Fleuron.exe.update-backup"
      ${ElseIf} $R0 == 0
        ; Live is missing; rescue nested backup to live
        InitPluginsDir
        Delete "$PLUGINSDIR\Fleuron.exe"
        Rename "$INSTDIR\Fleuron.exe.update-backup\Fleuron.exe" "$PLUGINSDIR\Fleuron.exe"
        RMDir "$INSTDIR\Fleuron.exe.update-backup"
        Rename "$PLUGINSDIR\Fleuron.exe" "$INSTDIR\Fleuron.exe"
      ${EndIf}
    ${Else}
      RMDir "$INSTDIR\Fleuron.exe.update-backup"
    ${EndIf}
  ${EndIf}

  ; State C: legacy backup is a regular file
  ${If} $R1 == 1
    StrCpy $0 "$INSTDIR\Fleuron.exe"
    Call FleuronGetPathKind
    Pop $R0
    ${If} $R0 == 1
      Delete "$INSTDIR\Fleuron.exe.update-backup"
    ${ElseIf} $R0 == 0
      Rename "$INSTDIR\Fleuron.exe.update-backup" "$INSTDIR\Fleuron.exe"
    ${EndIf}
  ${EndIf}
FunctionEnd

Function FleuronReconcileInterruptedTransaction
  ; Inspect transaction backup
  StrCpy $0 "$INSTDIR\.fleuron-update\backup\Fleuron.exe"
  Call FleuronGetPathKind
  Pop $R1 ; 1 = file

  ; Inspect live
  StrCpy $0 "$INSTDIR\Fleuron.exe"
  Call FleuronGetPathKind
  Pop $R0 ; 0 = absent, 1 = file

  ${If} $R1 == 1
    ${If} $R0 == 0
      Rename "$INSTDIR\.fleuron-update\backup\Fleuron.exe" "$INSTDIR\Fleuron.exe"
    ${ElseIf} $R0 == 1
      Delete "$INSTDIR\.fleuron-update\backup\Fleuron.exe"
    ${EndIf}
  ${EndIf}

  ; Clean leftover staged
  Delete "$INSTDIR\.fleuron-update\staged\Fleuron.exe"
FunctionEnd

Function FleuronMarkPendingUpdateFailed
  StrCmp $FleuronPendingUpdate "" pending_failed_done
  FileOpen $0 "$FleuronPendingUpdate.failed" w
  IfErrors pending_failed_done
  FileWrite $0 "nsis verification failed$\r$\n"
  FileClose $0
pending_failed_done:
FunctionEnd

Function FleuronVerifyExecutableVersion
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

Function FleuronCommitTransaction
  ; Staged binary is in $INSTDIR\.fleuron-update\staged\Fleuron.exe
  StrCpy $0 "$INSTDIR\.fleuron-update\staged\Fleuron.exe"
  Call FleuronVerifyExecutableVersion
  Pop $1
  ${If} $1 != 1
    Delete "$FleuronInstallSentinel"
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONEXCLAMATION "The candidate update executable could not be verified. Installation aborted."
    ${EndIf}
    Abort
  ${EndIf}

  StrCpy $0 "$INSTDIR\Fleuron.exe"
  Call FleuronGetPathKind
  Pop $R0

  ${If} $R0 == 1
    ; Existing live installation: capture old version for rollback
    GetDLLVersion "$INSTDIR\Fleuron.exe" $1 $2
    IntOp $3 $1 / 65536
    IntOp $4 $1 & 0xFFFF
    IntOp $5 $2 / 65536
    IntOp $6 $2 & 0xFFFF
    StrCpy $FleuronInstalledOldVersion "$3.$4.$5.$6"

    ; Ensure clean backup target in .fleuron-update\backup
    Delete "$INSTDIR\.fleuron-update\backup\Fleuron.exe"

    ; Atomic same-volume replacement with write-through (REPLACEFILE_WRITE_THROUGH = 1)
    System::Call 'kernel32::ReplaceFileW(w "$INSTDIR\Fleuron.exe", w "$INSTDIR\.fleuron-update\staged\Fleuron.exe", w "$INSTDIR\.fleuron-update\backup\Fleuron.exe", i 1, p 0, p 0) i.r0'
    ${If} $0 == 0
      Call FleuronMarkPendingUpdateFailed
      Delete "$FleuronInstallSentinel"
      ${IfNot} ${Silent}
        MessageBox MB_OK|MB_ICONEXCLAMATION "Fleuron could not replace the executable. The update was cancelled before replacement."
      ${EndIf}
      Abort
    ${EndIf}
  ${Else}
    ; Fresh installation: MoveFileExW with MOVEFILE_REPLACE_EXISTING (1) | MOVEFILE_WRITE_THROUGH (8) = 9
    System::Call 'kernel32::MoveFileExW(w "$INSTDIR\.fleuron-update\staged\Fleuron.exe", w "$INSTDIR\Fleuron.exe", i 9) i.r0'
    ${If} $0 == 0
      Delete "$FleuronInstallSentinel"
      ${IfNot} ${Silent}
        MessageBox MB_OK|MB_ICONEXCLAMATION "Fleuron could not install the executable."
      ${EndIf}
      Abort
    ${EndIf}
  ${EndIf}

  ; Re-verify the live installed executable
  StrCpy $0 "$INSTDIR\Fleuron.exe"
  Call FleuronVerifyExecutableVersion
  Pop $1
  ${If} $1 != 1
    ; Roll back from backup if present
    ${If} $R0 == 1
      System::Call 'kernel32::MoveFileExW(w "$INSTDIR\.fleuron-update\backup\Fleuron.exe", w "$INSTDIR\Fleuron.exe", i 9) i.r0'
    ${EndIf}
    Call FleuronMarkPendingUpdateFailed
    Delete "$FleuronInstallSentinel"
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONEXCLAMATION "The Fleuron update could not be verified. The prior executable was restored."
    ${EndIf}
    Abort
  ${EndIf}
FunctionEnd

!macro NSIS_HOOK_PREINSTALL
  Call FleuronReadUpdateArguments
  Call FleuronRepairLegacyV027State
  Call FleuronReconcileInterruptedTransaction
  Call FleuronWriteInstallSentinel
  Call FleuronWaitForRelease
  Delete "$INSTDIR\qualitative-coding-app.exe"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Delete "$INSTDIR\.fleuron-update\backup\Fleuron.exe"
  Delete "$INSTDIR\.fleuron-update\staged\Fleuron.exe"
  RMDir "$INSTDIR\.fleuron-update\backup"
  RMDir "$INSTDIR\.fleuron-update\staged"
  RMDir "$INSTDIR\.fleuron-update"
  Delete "$INSTDIR\Fleuron.exe.update-backup"
  RMDir "$INSTDIR\Fleuron.exe.update-backup"
  Delete "$FleuronInstallSentinel"
!macroend

Function un.FleuronWaitForUninstallRelease
  StrCpy $0 0
  ${While} $0 < 120
    StrCpy $1 "$INSTDIR\Fleuron.exe"
    System::Call 'kernel32::GetFileAttributesW(w r1) i.r2'
    ${If} $2 == -1
      Return
    ${EndIf}
    ; Test exclusive open
    System::Call 'kernel32::CreateFileW(w "$INSTDIR\Fleuron.exe", i 0x40010000, i 0, p 0, i 3, i 0, p 0) p.r2'
    ${If} $2 != -1
      System::Call 'kernel32::CloseHandle(p r2)'
      Return
    ${EndIf}
    Sleep 250
    IntOp $0 $0 + 1
  ${EndWhile}
FunctionEnd

!macro NSIS_HOOK_PREUNINSTALL
  Call un.FleuronWaitForUninstallRelease
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$INSTDIR\.fleuron-update\backup\Fleuron.exe"
  Delete "$INSTDIR\.fleuron-update\staged\Fleuron.exe"
  RMDir "$INSTDIR\.fleuron-update\backup"
  RMDir "$INSTDIR\.fleuron-update\staged"
  RMDir "$INSTDIR\.fleuron-update"
  Delete "$INSTDIR\Fleuron.exe.update-backup"
  RMDir "$INSTDIR\Fleuron.exe.update-backup"
  RMDir "$INSTDIR"
!macroend
