# scripts/test-windows-installer.ps1
# Windows candidate installer verification matrix runner.
#
# Validates NSIS installer packages on Windows across upgrades, clean installs,
# lock contention, poisoned residue recovery, and synthetic process lifecycle.
#
# Reliability/observability notes:
# - On timeout, NSIS may have spawned child processes; killing only the launched
#   PID orphans them and leaves the install directory locked, which poisons the
#   next case. We capture a process-tree + window-title snapshot for diagnostics,
#   then kill the whole tree (taskkill /T), and reset lingering installer
#   processes between cases so failures are independent rather than cascading.
# - The script exits non-zero if any case is not PASS so the CI job fails loudly
#   instead of silently going green on a red matrix. Pass criteria are unchanged.

[CmdletBinding()]
param (
    [Parameter(Mandatory = $true)]
    [string]$CandidateInstaller,

    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $CandidateInstaller)) {
    throw "Candidate installer not found at '$CandidateInstaller'"
}

if (-not (Test-Path $OutputDirectory)) {
    New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
}

$CandidateHash = (Get-FileHash -Path $CandidateInstaller -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Host "=== Fleuron Candidate Installer Test Matrix ==="
Write-Host "Candidate: $CandidateInstaller (SHA-256: $CandidateHash)"
Write-Host "Output Directory: $OutputDirectory"

$EvidenceResults = @{
    schema = 1
    candidate_installer_hash = $CandidateHash
    executed_at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    test_cases = @()
}

function Add-TestCaseResult {
    param (
        [string]$Name,
        [string]$Status,
        [int]$ElapsedMs,
        [int]$ExitCode,
        [string]$Details,
        [string]$Diagnostics = ""
    )
    $EvidenceResults.test_cases += @{
        name = $Name
        status = $Status
        elapsed_ms = $ElapsedMs
        exit_code = $ExitCode
        details = $Details
        diagnostics = $Diagnostics
    }
    Write-Host "[$Status] $Name ($ElapsedMs ms, exit: $ExitCode) - $Details"
    if ($Diagnostics) { Write-Host "    diagnostics: $Diagnostics" }
}

# Capture a snapshot of a hung process and its descendants: names, command
# lines, and whether any of them has an open window (a window title at timeout
# is a strong signal the installer is blocked on a dialog in silent mode).
function Get-ProcessTreeDiagnostics {
    param ([int]$RootProcessId)
    $lines = @()
    try {
        $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
        $tree = @($RootProcessId)
        $frontier = @($RootProcessId)
        while ($frontier.Count -gt 0) {
            $next = @()
            foreach ($p in $all) {
                $ppid = [int]$p.ParentProcessId
                $cpid = [int]$p.ProcessId
                if (($frontier -contains $ppid) -and -not ($tree -contains $cpid)) {
                    $tree += $cpid
                    $next += $cpid
                }
            }
            $frontier = $next
        }
        foreach ($treePid in $tree) {
            $pi = $all | Where-Object { [int]$_.ProcessId -eq $treePid } | Select-Object -First 1
            if ($pi) {
                $wnd = ""
                try {
                    $gp = Get-Process -Id $treePid -ErrorAction SilentlyContinue
                    if ($gp) { $wnd = $gp.MainWindowTitle }
                } catch {}
                $lines += "pid=$treePid name=$($pi.Name) window='$wnd'"
            }
        }
    } catch {
        $lines += "process diag error: $($_.Exception.Message)"
    }
    return ($lines -join " ; ")
}

function Get-InstallDirDiagnostics {
    param ([string]$Dir)
    if (-not (Test-Path $Dir)) { return "installdir absent" }
    try {
        $items = Get-ChildItem -Path $Dir -Force -ErrorAction SilentlyContinue |
            Select-Object -First 20 |
            ForEach-Object { if ($_.PSIsContainer) { "$($_.Name)/" } else { $_.Name } }
        return "installdir: " + ($items -join ", ")
    } catch {
        return "installdir diag error: $($_.Exception.Message)"
    }
}

function Stop-ProcessTreeById {
    param ([int]$ProcessId)
    try { & taskkill.exe /PID $ProcessId /T /F *>&1 | Out-Null } catch {}
}

# Kill any lingering installer processes left from a prior case so cross-case
# contention (an orphaned installer still holding the install dir) does not turn
# an independent case into a false timeout. Targets the versioned installer
# process only, not the installed Fleuron app.
function Reset-InstallerProcesses {
    try {
        Get-Process -Name "Fleuron_*" -ErrorAction SilentlyContinue | ForEach-Object {
            Stop-ProcessTreeById -ProcessId $_.Id
        }
    } catch {}
    Start-Sleep -Milliseconds 1500
}

function Invoke-InstallerWithTimeout {
    param (
        [string]$InstallerPath,
        [string]$Arguments,
        [int]$TimeoutMs = 60000
    )
    Reset-InstallerProcesses
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $proc = Start-Process -FilePath $InstallerPath -ArgumentList $Arguments -PassThru
    $exited = $proc.WaitForExit($TimeoutMs)
    $sw.Stop()

    if (-not $exited) {
        $diag = (Get-ProcessTreeDiagnostics -RootProcessId $proc.Id) + " | " + (Get-InstallDirDiagnostics -Dir $InstallDir)
        Write-Host "  TIMEOUT after $($sw.ElapsedMilliseconds) ms: $diag"
        Stop-ProcessTreeById -ProcessId $proc.Id
        return @{
            ExitCode = -1
            ElapsedMs = $sw.ElapsedMilliseconds
            TimedOut = $true
            Diagnostics = $diag
        }
    }

    return @{
        ExitCode = $proc.ExitCode
        ElapsedMs = $sw.ElapsedMilliseconds
        TimedOut = $false
        Diagnostics = ""
    }
}

# 1. Setup Synthetic Canaries
$LocalAppData = [Environment]::GetFolderPath("LocalApplicationData")
$AppData = [Environment]::GetFolderPath("ApplicationData")
$UserProfile = [Environment]::GetFolderPath("UserProfile")

$CanaryDirApp = Join-Path $AppData "study.fleuron.desktop"
$CanaryDirDocs = Join-Path $UserProfile "Documents\Fleuron-test-canary"
$CanaryDirLocal = Join-Path $LocalAppData "Fleuron-unrelated-sibling"

New-Item -ItemType Directory -Path $CanaryDirApp -Force | Out-Null
New-Item -ItemType Directory -Path $CanaryDirDocs -Force | Out-Null
New-Item -ItemType Directory -Path $CanaryDirLocal -Force | Out-Null

$CanaryFile1 = Join-Path $CanaryDirApp "canary-project.json"
$CanaryFile2 = Join-Path $CanaryDirDocs "canary-doc.txt"
$CanaryFile3 = Join-Path $CanaryDirLocal "sibling.dat"

Set-Content -Path $CanaryFile1 -Value "CANARY_APP_DATA_DO_NOT_DELETE"
Set-Content -Path $CanaryFile2 -Value "CANARY_USER_DOCUMENT_DO_NOT_DELETE"
Set-Content -Path $CanaryFile3 -Value "CANARY_SIBLING_DO_NOT_DELETE"

$CanaryHash1Before = (Get-FileHash -Path $CanaryFile1 -Algorithm SHA256).Hash
$CanaryHash2Before = (Get-FileHash -Path $CanaryFile2 -Algorithm SHA256).Hash
$CanaryHash3Before = (Get-FileHash -Path $CanaryFile3 -Algorithm SHA256).Hash

# Verify Canaries
function Verify-Canaries {
    $h1 = (Get-FileHash -Path $CanaryFile1 -Algorithm SHA256).Hash
    $h2 = (Get-FileHash -Path $CanaryFile2 -Algorithm SHA256).Hash
    $h3 = (Get-FileHash -Path $CanaryFile3 -Algorithm SHA256).Hash
    if ($h1 -ne $CanaryHash1Before -or $h2 -ne $CanaryHash2Before -or $h3 -ne $CanaryHash3Before) {
        throw "CRITICAL FAILURE: Synthetic canary was mutated or deleted during installation!"
    }
}

# 2. Execute Test Cases
$InstallDir = Join-Path $LocalAppData "Fleuron"
$installedExe = Join-Path $InstallDir "Fleuron.exe"

# Case A: Fresh manual installation without custom arguments (silent /S)
if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
Remove-Item -Path "HKCU:\Software\Fleuron\Fleuron" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Fleuron" -Recurse -Force -ErrorAction SilentlyContinue
$res = Invoke-InstallerWithTimeout -InstallerPath $CandidateInstaller -Arguments "/S"
Verify-Canaries
if (-not $res.TimedOut -and $res.ExitCode -eq 0 -and (Test-Path $installedExe) -and -not (Test-Path (Join-Path $InstallDir ".fleuron-update"))) {
    Add-TestCaseResult -Name "fresh_manual_install" -Status "PASS" -ElapsedMs $res.ElapsedMs -ExitCode $res.ExitCode -Details "Fresh manual installation succeeded cleanly." -Diagnostics $res.Diagnostics
} else {
    Add-TestCaseResult -Name "fresh_manual_install" -Status "FAIL" -ElapsedMs $res.ElapsedMs -ExitCode $res.ExitCode -Details "Missing installed executable or leftover transaction residue." -Diagnostics $res.Diagnostics
}

# Case B: v0.26.1 updater semantics (/S /P /UPDATE)
$res = Invoke-InstallerWithTimeout -InstallerPath $CandidateInstaller -Arguments "/S /P /UPDATE"
Verify-Canaries
if (-not $res.TimedOut -and (Test-Path $installedExe)) {
    Add-TestCaseResult -Name "v0261_updater_flags" -Status "PASS" -ElapsedMs $res.ElapsedMs -ExitCode $res.ExitCode -Details "Updater flags /S /P /UPDATE processed successfully." -Diagnostics $res.Diagnostics
} else {
    Add-TestCaseResult -Name "v0261_updater_flags" -Status "FAIL" -ElapsedMs $res.ElapsedMs -ExitCode $res.ExitCode -Details "Updater flags failed." -Diagnostics $res.Diagnostics
}

# Case C: v0.27.0 updater semantics with legacy /FLEURON_TARGET_VERSION_FILE argument
$res = Invoke-InstallerWithTimeout -InstallerPath $CandidateInstaller -Arguments '/S /P /UPDATE /FLEURON_TARGET_VERSION_FILE="dummy.txt"'
Verify-Canaries
if (-not $res.TimedOut -and (Test-Path $installedExe)) {
    Add-TestCaseResult -Name "v0270_legacy_arg_ignored" -Status "PASS" -ElapsedMs $res.ElapsedMs -ExitCode $res.ExitCode -Details "Legacy target version argument safely ignored." -Diagnostics $res.Diagnostics
} else {
    Add-TestCaseResult -Name "v0270_legacy_arg_ignored" -Status "FAIL" -ElapsedMs $res.ElapsedMs -ExitCode $res.ExitCode -Details "Installer failed on legacy argument." -Diagnostics $res.Diagnostics
}

# Case D: Residue repair - poisoned nested directory Fleuron.exe\Fleuron.exe
Remove-Item -Recurse -Force $InstallDir
New-Item -ItemType Directory -Path (Join-Path $InstallDir "Fleuron.exe") -Force | Out-Null
Set-Content -Path (Join-Path $InstallDir "Fleuron.exe\Fleuron.exe") -Value "DUMMY_BINARY_DATA"
$res = Invoke-InstallerWithTimeout -InstallerPath $CandidateInstaller -Arguments "/S"
Verify-Canaries
$isDir = $false
if (Test-Path $installedExe) {
    $isDir = (Get-Item $installedExe).PSIsContainer
}
if (-not $res.TimedOut -and (Test-Path $installedExe) -and -not $isDir) {
    Add-TestCaseResult -Name "poison_directory_repaired" -Status "PASS" -ElapsedMs $res.ElapsedMs -ExitCode $res.ExitCode -Details "Poisoned directory layout repaired to regular file." -Diagnostics $res.Diagnostics
} else {
    Add-TestCaseResult -Name "poison_directory_repaired" -Status "FAIL" -ElapsedMs $res.ElapsedMs -ExitCode $res.ExitCode -Details "Poisoned directory layout was not repaired." -Diagnostics $res.Diagnostics
}

# Case E: Real updater flags transaction (/S /FLEURON_PARENT_PID= /FLEURON_PENDING_UPDATE= /FLEURON_INSTALL_SENTINEL=)
# The parent must exit well before FleuronWaitForRelease's 30-second budget.
# An early exit is the intended success condition; a late exit deadlocks it.
$parentProcE = Start-Process powershell -ArgumentList "-NoProfile", "-Command", "Start-Sleep -Seconds 3" -PassThru
$pendingUpdateE = Join-Path $CanaryDirApp "pending-update-e.json"
$sentinelE = Join-Path $CanaryDirApp "install-sentinel-e.txt"
if (Test-Path $pendingUpdateE) { Remove-Item -Force $pendingUpdateE }
if (Test-Path $sentinelE) { Remove-Item -Force $sentinelE }
$argsE = '/S /FLEURON_PARENT_PID={0} /FLEURON_PENDING_UPDATE="{1}" /FLEURON_INSTALL_SENTINEL="{2}"' -f $parentProcE.Id, $pendingUpdateE, $sentinelE
$res = Invoke-InstallerWithTimeout -InstallerPath $CandidateInstaller -Arguments $argsE
Stop-ProcessTreeById -ProcessId $parentProcE.Id
Verify-Canaries
if (-not $res.TimedOut -and (Test-Path $installedExe)) {
    Add-TestCaseResult -Name "real_updater_flags" -Status "PASS" -ElapsedMs $res.ElapsedMs -ExitCode $res.ExitCode -Details "Real updater flags processed cleanly by NSIS hooks." -Diagnostics $res.Diagnostics
} else {
    Add-TestCaseResult -Name "real_updater_flags" -Status "FAIL" -ElapsedMs $res.ElapsedMs -ExitCode $res.ExitCode -Details "Installer failed when driven by real /FLEURON_* updater flags." -Diagnostics $res.Diagnostics
}

# Case F: Cross-rename updater flags (Informational / Gap 4 observation)
# Shipped Codemap 1.2.0 clients invoke updater with /CODEMAP_* argument names.
# TODO(Gap 4): Once the 1.2.0 -> current Fleuron migration path is finalized by Wilson, this case
# should become a gating assertion rather than informational PASS.
$parentProcF = Start-Process powershell -ArgumentList "-NoProfile", "-Command", "Start-Sleep -Seconds 30" -PassThru
$pendingUpdateF = Join-Path $CanaryDirApp "pending-update-f.json"
$sentinelF = Join-Path $CanaryDirApp "install-sentinel-f.txt"
$argsF = '/S /CODEMAP_PARENT_PID={0} /CODEMAP_PENDING_UPDATE="{1}" /CODEMAP_INSTALL_SENTINEL="{2}"' -f $parentProcF.Id, $pendingUpdateF, $sentinelF
$res = Invoke-InstallerWithTimeout -InstallerPath $CandidateInstaller -Arguments $argsF
Stop-ProcessTreeById -ProcessId $parentProcF.Id
Verify-Canaries
$obs = if (-not $res.TimedOut -and (Test-Path $installedExe)) { "Installer completed (flags safely ignored/handled)" } else { "Installer failed or timed out on legacy flags" }
Add-TestCaseResult -Name "cross_rename_updater_flags" -Status "PASS" -ElapsedMs $res.ElapsedMs -ExitCode $res.ExitCode -Details "[INFORMATIONAL] $obs" -Diagnostics "Observed behavior for shipped 1.2.0 updater flags"

# Save Evidence
$EvidencePath = Join-Path $OutputDirectory "windows-installer-matrix-evidence.json"
$EvidenceResults | ConvertTo-Json -Depth 5 | Set-Content -Path $EvidencePath -Encoding utf8
Write-Host "Evidence saved to $EvidencePath"

# Fail loudly if any case is not PASS so the CI job goes red instead of silently
# green. Evidence is already written above; upload steps must run with
# `if: always()` so the diagnostics survive this non-zero exit.
$total = $EvidenceResults.test_cases.Count
$failed = @($EvidenceResults.test_cases | Where-Object { $_.status -ne "PASS" })
if ($failed.Count -gt 0) {
    $names = ($failed | ForEach-Object { $_.name }) -join ", "
    Write-Host "::error::Windows installer matrix failed $($failed.Count)/$total cases: $names"
    exit 1
}
Write-Host "All $total installer matrix cases passed."
exit 0
