# qa/Invoke-FleuronQA.ps1
# Fleuron Windows VM QA Runner - automated test harness & verification suite.
# Pure PowerShell 5.1 compatible.

[CmdletBinding()]
param (
    [Parameter(Mandatory = $false)]
    [string]$Candidate,

    [Parameter(Mandatory = $false)]
    [string]$ExpectedVersion = "",

    [Parameter(Mandatory = $false)]
    [string]$Previous,

    [string]$PreviousVersion = "1.2.0",

    [Parameter(Mandatory = $false)]
    [string]$PreviousFleuron,

    [string]$PreviousFleuronVersion = "2.0.0",
    [string]$OutputDirectory = "$PSScriptRoot\qa-evidence",
    [switch]$Online,
    [switch]$SkipUpdater,
    [switch]$SelfCheck
)

$ErrorActionPreference = "Stop"

# Dot-source runner helper modules
$LibDir = Join-Path $PSScriptRoot "lib"
. (Join-Path $LibDir "Evidence.ps1")
. (Join-Path $LibDir "Wipe.ps1")
. (Join-Path $LibDir "Selftest.ps1")
. (Join-Path $LibDir "CrashSweep.ps1")
. (Join-Path $LibDir "Download.ps1")

# Helper to stop a process and all its children
function Stop-ProcessTree {
    param ([int]$ProcessId)
    try { & taskkill.exe /PID $ProcessId /T /F *>&1 | Out-Null } catch {}
}

# Helper to execute an installer with bounded timeout
function Invoke-InstallerProcess {
    param (
        [string]$InstallerPath,
        [string]$Arguments,
        [int]$TimeoutSeconds = 60
    )
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $proc = Start-Process -FilePath $InstallerPath -ArgumentList $Arguments -PassThru
    $exited = $proc.WaitForExit($TimeoutSeconds * 1000)
    $sw.Stop()

    if (-not $exited) {
        Stop-ProcessTree -ProcessId $proc.Id
        return @{
            ExitCode = -1
            ElapsedMs = $sw.ElapsedMilliseconds
            TimedOut = $true
            Diagnostics = "Installer timed out after $TimeoutSeconds seconds"
        }
    }

    return @{
        ExitCode = $proc.ExitCode
        ElapsedMs = $sw.ElapsedMilliseconds
        TimedOut = $false
        Diagnostics = ""
    }
}

# Resolve a single release version for every assertion. A packaged runner
# carries release.json, which makes its expected version immutable; repo use
# can instead infer the version from a canonical candidate filename.
function Resolve-ExpectedVersion {
    param (
        [string]$RequestedVersion,
        [string]$CandidatePath
    )

    $manifestVersion = ""
    $manifestPath = Join-Path $PSScriptRoot "release.json"
    if (Test-Path -LiteralPath $manifestPath) {
        try {
            $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
            if ($manifest.platform -and $manifest.platform -ne "windows") {
                throw "platform must be 'windows', got '$($manifest.platform)'"
            }
            $manifestVersion = [string]$manifest.version
        } catch {
            throw "Invalid runner release manifest '$manifestPath': $($_.Exception.Message)"
        }
    }

    if ($RequestedVersion -and $manifestVersion -and $RequestedVersion -ne $manifestVersion) {
        throw "-ExpectedVersion '$RequestedVersion' conflicts with packaged runner version '$manifestVersion'."
    }

    $candidateName = Split-Path -Path $CandidatePath -Leaf
    $candidateVersion = ""
    if ($candidateName -match '^Fleuron_(\d+\.\d+\.\d+)_x64-setup\.exe$') {
        $candidateVersion = $Matches[1]
    }

    $resolvedVersion = if ($manifestVersion) {
        $manifestVersion
    } elseif ($RequestedVersion) {
        $RequestedVersion
    } else {
        $candidateVersion
    }

    if ($resolvedVersion -notmatch '^\d+\.\d+\.\d+$') {
        throw "Could not determine a semantic version. Use a packaged runner, pass -ExpectedVersion X.Y.Z, or use Fleuron_X.Y.Z_x64-setup.exe."
    }
    if ($candidateVersion -and $candidateVersion -ne $resolvedVersion) {
        throw "Candidate '$candidateName' is version $candidateVersion but this runner expects $resolvedVersion."
    }

    return $resolvedVersion
}

# -----------------------------------------------------------------------------
# Self-Check Mode (Runs on CI windows-latest to verify harness mechanics)
# -----------------------------------------------------------------------------
if ($SelfCheck) {
    Write-Host "=== Running Fleuron QA Runner Self-Check ==="
    $Evidence = New-EvidenceState -CandidateHash "SELFCHECK_RUNNER"
    $SelfCheckPass = $true
    $temporaryDirectory = [System.IO.Path]::GetTempPath()

    # 1. Test Provable Wipe on scratch dir
    $g1 = [Guid]::NewGuid().ToString("N")
    $scratchDir = Join-Path $temporaryDirectory "fleuron-qa-selfcheck-wipe-$g1"
    New-Item -ItemType Directory -Path $scratchDir -Force | Out-Null
    $customTarget = @{ Type = "Directory"; Path = $scratchDir }
    $wipeResult = Invoke-ProvableWipe -Evidence $Evidence -CustomTargets @($customTarget)
    if (-not $wipeResult -or (Test-Path $scratchDir)) {
        Write-Host "[FAIL] Self-check failed: Provable wipe on scratch dir did not succeed."
        $SelfCheckPass = $false
    } else {
        Write-Host "[OK] Self-check: Provable wipe helper verified."
    }

    # 2. Test Selftest Transcript Parser against valid sample fixture
    $fixturePath = Join-Path $PSScriptRoot "fixtures\selftest-report-sample.txt"
    if (Test-Path $fixturePath) {
        $sampleText = Get-Content -Path $fixturePath -Raw
        $parsed = Parse-SelftestTranscript -TranscriptText $sampleText -Leg "selfcheck" -Evidence $Evidence
        $pCount = if ($parsed) { $parsed.Count } else { "false" }
        if ($parsed -eq $false -or $parsed.Count -ne 12) {
            Write-Host "[FAIL] Self-check failed: Parser expected 12 suites, got $pCount"
            $SelfCheckPass = $false
        } else {
            Write-Host "[OK] Self-check: Selftest transcript parser verified (12 suites)."
        }
    } else {
        Write-Host "[FAIL] Self-check failed: Fixture not found at $fixturePath"
        $SelfCheckPass = $false
    }

    # 3. Test Selftest Transcript Parser against empty fixture (Watch it fail)
    $emptyFixturePath = Join-Path $PSScriptRoot "fixtures\selftest-report-empty.txt"
    if (Test-Path $emptyFixturePath) {
        $emptyText = Get-Content -Path $emptyFixturePath -Raw
        $mockEvidence = New-EvidenceState -CandidateHash "EMPTY_FIXTURE"
        $parsedEmpty = Parse-SelftestTranscript -TranscriptText $emptyText -Leg "selfcheck" -Evidence $mockEvidence
        $failCase = @($mockEvidence.test_cases | Where-Object { $_.name -eq "selftest_produced_no_report" -and $_.status -eq "FAIL" })
        if ($parsedEmpty -ne $false -or $failCase.Count -eq 0) {
            Write-Host "[FAIL] Self-check failed: Empty transcript was not rejected as FAIL."
            $SelfCheckPass = $false
        } else {
            Write-Host "[OK] Self-check: No-PASS-on-empty rule verified failing on empty fixture."
        }
    }

    # 4. Test CrashSweep against clean temp tree
    $g2 = [Guid]::NewGuid().ToString("N")
    $scratchRaw = Join-Path $temporaryDirectory "fleuron-qa-selfcheck-raw-$g2"
    Invoke-CrashSweep -Evidence $Evidence -StartTimeUtc (Get-Date).ToUniversalTime().AddHours(1) -RawDirectory $scratchRaw -Leg "selfcheck"
    if (Test-Path $scratchRaw) { Remove-Item -Recurse -Force $scratchRaw }
    Write-Host "[OK] Self-check: Crash sweep helper executed cleanly."

    # 5. Test Evidence Export
    $g3 = [Guid]::NewGuid().ToString("N")
    $scratchOut = Join-Path $temporaryDirectory "fleuron-qa-selfcheck-out-$g3"
    Export-QAEvidence -Evidence $Evidence -OutputDirectory $scratchOut
    if ((Test-Path (Join-Path $scratchOut "evidence.json")) -and (Test-Path (Join-Path $scratchOut "SUMMARY.md"))) {
        Write-Host "[OK] Self-check: Evidence export verified."
    } else {
        Write-Host "[FAIL] Self-check failed: Evidence export did not create evidence.json and SUMMARY.md."
        $SelfCheckPass = $false
    }
    if (Test-Path $scratchOut) { Remove-Item -Recurse -Force $scratchOut }

    if ($SelfCheckPass) {
        Write-Host "All QA Runner self-checks PASSED."
        exit 0
    } else {
        Write-Host "QA Runner self-check FAILED."
        exit 1
    }
}

# -----------------------------------------------------------------------------
# Standard Execution Workflow
# -----------------------------------------------------------------------------

if ([string]::IsNullOrWhiteSpace($Candidate)) {
    throw "Mandatory parameter -Candidate is missing. Specify the path to Fleuron_X.Y.Z_x64-setup.exe."
}

if (-not (Test-Path $Candidate)) {
    throw "Candidate installer not found at '$Candidate'"
}

$ExpectedVersion = Resolve-ExpectedVersion -RequestedVersion $ExpectedVersion -CandidatePath $Candidate
$ExpectedVersionRegex = "(?<![0-9]){0}(?![0-9])" -f [regex]::Escape($ExpectedVersion)
$ExpectedCandidateFilename = "Fleuron_$($ExpectedVersion)_x64-setup.exe"
$CandidateHash = (Get-FileHash -Path $Candidate -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Host "=== Fleuron Windows VM QA Runner ==="
Write-Host "Candidate: $Candidate"
Write-Host "Expected version: $ExpectedVersion"
Write-Host "SHA-256:   $CandidateHash"
Write-Host "Output:    $OutputDirectory"
Write-Host "Online:    $Online"

# Prepare Output Directory (rotate if already exists)
if (Test-Path $OutputDirectory) {
    $timestamp = (Get-Date).ToString("yyyyMMdd-HHmmss")
    $backupDir = "${OutputDirectory}.${timestamp}.bak"
    Write-Host "Moving existing output directory to $backupDir..."
    Move-Item -Path $OutputDirectory -Destination $backupDir -Force
}
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$RawDir = Join-Path $OutputDirectory "raw"
New-Item -ItemType Directory -Path $RawDir -Force | Out-Null

$Evidence = New-EvidenceState -CandidateHash $CandidateHash -ExpectedVersion $ExpectedVersion

# Seed Standard Manual Verification Items
Add-QAManualRow -Evidence $Evidence -Number 1 -Title "SmartScreen Warning Check" -Instruction "Open VM browser, download $ExpectedCandidateFilename from GitHub Releases (ensures Mark-of-the-Web is attached), and run. Observe SmartScreen behavior." -ExpectedOutcome "SmartScreen prompt appears cleanly identifying publisher status without blocking manual run via 'More info' -> 'Run anyway'."

Add-QAManualRow -Evidence $Evidence -Number 2 -Title "About Box Version String" -Instruction "Launch Fleuron from Start Menu, open About box (Help -> About or Settings -> About)." -ExpectedOutcome "Displays version $ExpectedVersion and canonical publisher / app name information."

Add-QAManualRow -Evidence $Evidence -Number 3 -Title "Live Updater In-App Click-Through" -Instruction "In installed Codemap 1.2.0, trigger Check for updates -> Download -> Install update." -ExpectedOutcome "Observe whether update completes and relaunch lands in Fleuron $ExpectedVersion."

Add-QAManualRow -Evidence $Evidence -Number 4 -Title "Onboarding Wizard and Theme" -Instruction "On a clean profile, launch Fleuron and step through Welcome / Onboarding." -ExpectedOutcome "All onboarding steps complete without graphical glitches, contrast errors, or hangs."

Add-QAManualRow -Evidence $Evidence -Number 5 -Title "Native File Dialogs" -Instruction "Trigger Open Project and Export PDF dialogs." -ExpectedOutcome "Native Windows file picker opens and selected file/folder paths are loaded without error."

$localAppData = [Environment]::GetFolderPath("LocalApplicationData")
$appData = [Environment]::GetFolderPath("ApplicationData")
$userProfile = [Environment]::GetFolderPath("UserProfile")
$installedExe = Join-Path $localAppData "Fleuron\Fleuron.exe"
$installDir = Join-Path $localAppData "Fleuron"

# -----------------------------------------------------------------------------
# Leg 1: Provable Wipe and Canary Setup
# -----------------------------------------------------------------------------
Write-Host ""
Write-Host "--- Leg 1: Provable Wipe and Canaries ---"
try {
    Invoke-ProvableWipe -Evidence $Evidence
    Initialize-Canaries -Evidence $Evidence
} catch {
    Add-QATestCaseResult -Evidence $Evidence -Name "leg_wipe_fatal" -Leg "wipe" -Status "FAIL" -ExitCode 1 -Details "Fatal error in wipe leg: $($_.Exception.Message)"
}

# -----------------------------------------------------------------------------
# Leg 2: Fresh Install and Installed-Exe Selftest
# -----------------------------------------------------------------------------
Write-Host ""
Write-Host "--- Leg 2: Fresh Install and Installed-Exe Selftest ---"
$freshStartTime = (Get-Date).ToUniversalTime()
try {
    # 1. Install Candidate silently (/S)
    $res = Invoke-InstallerProcess -InstallerPath $Candidate -Arguments "/S" -TimeoutSeconds 90

    # `fresh_silent_install` is about the result a user can observe. Keep the
    # process status as its own row: a bad exit code must not invalidate an
    # otherwise healthy install, nor hide the exit-code regression.
    $exeExists = Test-Path $installedExe
    $isContainer = if ($exeExists) { (Get-Item $installedExe).PSIsContainer } else { $false }
    $stagedResiduePath = Join-Path $installDir ".fleuron-update"
    $stagedResidueExists = Test-Path $stagedResiduePath
    $freshInstallHealthy = $exeExists -and -not $isContainer -and -not $stagedResidueExists
    Add-QATestCaseResult -Evidence $Evidence -Name "fresh_silent_install" -Leg "fresh_install" -Status $(if ($freshInstallHealthy) { "PASS" } else { "FAIL" }) -ElapsedMs $res.ElapsedMs -ExitCode $res.ExitCode -Details $(if ($freshInstallHealthy) { "Fleuron.exe exists as a regular file with no .fleuron-update residue." } else { "Fleuron.exe is missing or a directory, or .fleuron-update residue remains." }) -Diagnostics $res.Diagnostics
    Add-QATestCaseResult -Evidence $Evidence -Name "silent_install_exit_code_zero" -Leg "fresh_install" -Status $(if ($res.ExitCode -eq 0) { "PASS" } else { "FAIL" }) -ElapsedMs $res.ElapsedMs -ExitCode $res.ExitCode -Details "Silent installer exit code was $($res.ExitCode)." -Diagnostics $res.Diagnostics

    Assert-Canaries -Evidence $Evidence -LegName "fresh_install"

    # 2. Assert Layout
    if ($exeExists -and -not $isContainer) {
        Add-QATestCaseResult -Evidence $Evidence -Name "installed_exe_is_file" -Leg "fresh_install" -Status "PASS" -Details "Fleuron.exe exists and is a regular file."
    } else {
        Add-QATestCaseResult -Evidence $Evidence -Name "installed_exe_is_file" -Leg "fresh_install" -Status "FAIL" -ExitCode 1 -Details "Fleuron.exe missing or is a directory (poison state)."
    }

    if (-not $stagedResidueExists) {
        Add-QATestCaseResult -Evidence $Evidence -Name "no_staged_update_residue" -Leg "fresh_install" -Status "PASS" -Details "No leftover .fleuron-update directory found."
    } else {
        Add-QATestCaseResult -Evidence $Evidence -Name "no_staged_update_residue" -Leg "fresh_install" -Status "FAIL" -ExitCode 1 -Details "Found leftover .fleuron-update residue after install."
    }

    # 3. Assert Registry Uninstall entry
    $uninstKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Fleuron"
    if (Test-Path $uninstKey) {
        $props = Get-ItemProperty -Path $uninstKey
        $dispName = $props.DisplayName
        $dispVer = $props.DisplayVersion
        if ($dispName -eq "Fleuron" -and $dispVer -eq $ExpectedVersion) {
            Add-QATestCaseResult -Evidence $Evidence -Name "uninstall_registry_metadata" -Leg "fresh_install" -Status "PASS" -Details "Uninstall registry key has DisplayName='Fleuron' and DisplayVersion='$ExpectedVersion'."
        } else {
            Add-QATestCaseResult -Evidence $Evidence -Name "uninstall_registry_metadata" -Leg "fresh_install" -Status "FAIL" -ExitCode 1 -Details "Uninstall registry metadata mismatch: DisplayName='$dispName', DisplayVersion='$dispVer'"
        }
    } else {
        Add-QATestCaseResult -Evidence $Evidence -Name "uninstall_registry_metadata" -Leg "fresh_install" -Status "FAIL" -ExitCode 1 -Details "Uninstall registry key not found at $uninstKey"
    }

    # 4. Assert FileVersion
    if ($exeExists -and -not $isContainer) {
        $fileVer = (Get-Item $installedExe).VersionInfo.FileVersion
        if ($fileVer -match $ExpectedVersionRegex) {
            Add-QATestCaseResult -Evidence $Evidence -Name "binary_file_version" -Leg "fresh_install" -Status "PASS" -Details "Fleuron.exe reports FileVersion='$fileVer'"
        } else {
            Add-QATestCaseResult -Evidence $Evidence -Name "binary_file_version" -Leg "fresh_install" -Status "FAIL" -ExitCode 1 -Details "Fleuron.exe FileVersion mismatch: expected $ExpectedVersion, got '$fileVer'"
        }
    }

    # 5. Run the INSTALLED executable's selftest suite
    $selftestLog = Join-Path $RawDir "selftest-installed.log"
    Invoke-InstalledSelftest -Evidence $Evidence -BinaryPath $installedExe -LogPath $selftestLog -Leg "fresh_install"

} catch {
    Add-QATestCaseResult -Evidence $Evidence -Name "leg_fresh_install_fatal" -Leg "fresh_install" -Status "FAIL" -ExitCode 1 -Details "Fatal error in fresh install leg: $($_.Exception.Message)"
}

# Crash Sweep after fresh install
Invoke-CrashSweep -Evidence $Evidence -StartTimeUtc $freshStartTime -RawDirectory $RawDir -Leg "fresh_install"

# -----------------------------------------------------------------------------
# Leg 3: Relaunch and Persistence
# -----------------------------------------------------------------------------
Write-Host ""
Write-Host "--- Leg 3: Relaunch and Persistence ---"
$relaunchStartTime = (Get-Date).ToUniversalTime()
try {
    if (Test-Path $installedExe) {
        $proc = Start-Process -FilePath $installedExe -PassThru
        Start-Sleep -Seconds 5
        Stop-ProcessTree -ProcessId $proc.Id
        Add-QATestCaseResult -Evidence $Evidence -Name "app_relaunch_clean" -Leg "relaunch" -Status "PASS" -Details "Installed app relaunches and shuts down cleanly."
    } else {
        Add-QATestCaseResult -Evidence $Evidence -Name "app_relaunch_clean" -Leg "relaunch" -Status "FAIL" -ExitCode 1 -Details "Installed executable missing for relaunch."
    }
} catch {
    Add-QATestCaseResult -Evidence $Evidence -Name "app_relaunch_clean" -Leg "relaunch" -Status "FAIL" -ExitCode 1 -Details "Exception during relaunch: $($_.Exception.Message)"
}
Invoke-CrashSweep -Evidence $Evidence -StartTimeUtc $relaunchStartTime -RawDirectory $RawDir -Leg "relaunch"

# -----------------------------------------------------------------------------
# Leg 4: Legacy .codemap Project Handling
# -----------------------------------------------------------------------------
Write-Host ""
Write-Host "--- Leg 4: Legacy .codemap Project Handling ---"
$legacyStartTime = (Get-Date).ToUniversalTime()
try {
    $docsDir = [Environment]::GetFolderPath("Personal")
    $fixturesDir = Join-Path $docsDir "Fleuron QA Fixtures"
    New-Item -ItemType Directory -Path $fixturesDir -Force | Out-Null

    # 1. Flat legacy layout: "study.codemap\project.db"
    $flatProjectDir = Join-Path $fixturesDir "Legacy Flat Study.codemap"
    New-Item -ItemType Directory -Path $flatProjectDir -Force | Out-Null
    $flatDb = Join-Path $flatProjectDir "project.db"
    if (-not (Test-Path $flatDb)) {
        # Initialize SQLite header (16-byte magic header)
        $sqliteHeader = [byte[]](0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00)
        [System.IO.File]::WriteAllBytes($flatDb, $sqliteHeader)
    }

    # 2. Nested legacy layout: "study-nested.codemap\.codemap\project.db"
    $nestedProjectDir = Join-Path $fixturesDir "Legacy Nested Study.codemap"
    $nestedInnerDir = Join-Path $nestedProjectDir ".codemap"
    New-Item -ItemType Directory -Path $nestedInnerDir -Force | Out-Null
    $nestedDb = Join-Path $nestedInnerDir "project.db"
    if (-not (Test-Path $nestedDb)) {
        $sqliteHeader = [byte[]](0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00)
        [System.IO.File]::WriteAllBytes($nestedDb, $sqliteHeader)
    }

    # Launch app with flat legacy project argument
    if (Test-Path $installedExe) {
        $flatArg = '"{0}"' -f $flatProjectDir
        $pFlat = Start-Process -FilePath $installedExe -ArgumentList $flatArg -PassThru
        Start-Sleep -Seconds 6
        Stop-ProcessTree -ProcessId $pFlat.Id

        # Launch app with nested legacy project argument
        $nestedArg = '"{0}"' -f $nestedProjectDir
        $pNested = Start-Process -FilePath $installedExe -ArgumentList $nestedArg -PassThru
        Start-Sleep -Seconds 6
        Stop-ProcessTree -ProcessId $pNested.Id

        Add-QATestCaseResult -Evidence $Evidence -Name "legacy_project_argv_flat" -Leg "legacy" -Status "PASS" -Details "Launched app targeting flat legacy layout: '$flatProjectDir'"
        Add-QATestCaseResult -Evidence $Evidence -Name "legacy_project_argv_nested" -Leg "legacy" -Status "PASS" -Details "Launched app targeting nested legacy layout: '$nestedProjectDir'"
    } else {
        Add-QATestCaseResult -Evidence $Evidence -Name "legacy_project_argv" -Leg "legacy" -Status "FAIL" -ExitCode 1 -Details "Installed Fleuron executable not found."
    }
} catch {
    Add-QATestCaseResult -Evidence $Evidence -Name "legacy_project_error" -Leg "legacy" -Status "FAIL" -ExitCode 1 -Details "Exception in legacy leg: $($_.Exception.Message)"
}
Invoke-CrashSweep -Evidence $Evidence -StartTimeUtc $legacyStartTime -RawDirectory $RawDir -Leg "legacy"

# -----------------------------------------------------------------------------
# Leg 5: Updater Transaction Simulation (Gap 4 Instrument)
# -----------------------------------------------------------------------------
# Leg 5: Updater Transaction Simulation (Gap 4 Instrument & Fleuron Upgrade)
# -----------------------------------------------------------------------------
if (-not $SkipUpdater) {
    Write-Host ""
    Write-Host "--- Leg 5: Updater Transaction Simulation ---"
    $updaterStartTime = (Get-Date).ToUniversalTime()
    try {
        $updaterBaselines = @(
            @{
                Id = "codemap_120"
                Label = "Codemap $PreviousVersion"
                Version = $PreviousVersion
                PreviousPath = $Previous
                ProductName = "Codemap"
                ExeRelativePath = "Codemap\Codemap.exe"
                AppDataDir = "app.codemap.desktop"
                IsLegacyCodemap = $true
            },
            @{
                Id = "fleuron_200"
                Label = "Fleuron $PreviousFleuronVersion"
                Version = $PreviousFleuronVersion
                PreviousPath = $PreviousFleuron
                ProductName = "Fleuron"
                ExeRelativePath = "Fleuron\Fleuron.exe"
                AppDataDir = "study.fleuron.desktop"
                IsLegacyCodemap = $false
            }
        )

        foreach ($b in $updaterBaselines) {
            Write-Host ""
            Write-Host "--- Updater Leg Baseline: $($b.Label) ---"

            # 1. Provable wipe to start from clean slate
            Invoke-ProvableWipe -Evidence $Evidence
            Initialize-Canaries -Evidence $Evidence

            # 2. Resolve and install baseline
            $prevInstaller = Get-PreviousReleaseInstaller -Evidence $Evidence -PreviousLocalPath $b.PreviousPath -Version $b.Version -DownloadDirectory (Join-Path $OutputDirectory "download")

            if ($prevInstaller -and (Test-Path $prevInstaller)) {
                $prevRes = Invoke-InstallerProcess -InstallerPath $prevInstaller -Arguments "/S" -TimeoutSeconds 90
                $oldExe = Join-Path $localAppData $b.ExeRelativePath

                if (Test-Path $oldExe) {
                    Add-QATestCaseResult -Evidence $Evidence -Name "$($b.Id)_installed" -Leg "updater" -Status "PASS" -ElapsedMs $prevRes.ElapsedMs -ExitCode $prevRes.ExitCode -Details "$($b.Label) executable is present."
                } else {
                    Add-QATestCaseResult -Evidence $Evidence -Name "$($b.Id)_installed" -Leg "updater" -Status "FAIL" -ElapsedMs $prevRes.ElapsedMs -ExitCode $prevRes.ExitCode -Details "$($b.Label) executable is missing."
                }

                # 3. Seed real user data under %APPDATA%\$($b.AppDataDir)
                $baselineAppData = Join-Path $appData $b.AppDataDir
                New-Item -ItemType Directory -Path $baselineAppData -Force | Out-Null
                $seededRecent = Join-Path $baselineAppData "recent-projects.json"
                $seededProjectFolder = Join-Path ([Environment]::GetFolderPath("Personal")) "$($b.ProductName)\Seeded Research.codemap"
                New-Item -ItemType Directory -Path $seededProjectFolder -Force | Out-Null
                $seededDb = Join-Path $seededProjectFolder "project.db"
                $sqliteHeader = [byte[]](0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00)
                [System.IO.File]::WriteAllBytes($seededDb, $sqliteHeader)

                $recentObj = @{
                    projects = @(
                        @{
                            path = $seededProjectFolder
                            title = "Seeded Research Study"
                            last_opened = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
                        }
                    )
                }
                $recentObj | ConvertTo-Json -Depth 4 | Set-Content -Path $seededRecent -Encoding utf8
                $seededHash = (Get-FileHash -Path $seededDb -Algorithm SHA256).Hash

                # 4. Define real marker paths under study.fleuron.desktop
                $fleuronAppData = Join-Path $appData "study.fleuron.desktop"
                New-Item -ItemType Directory -Path $fleuronAppData -Force | Out-Null
                $pendingUpdatePath = Join-Path $fleuronAppData "pending-update.json"
                $installSentinelPath = Join-Path $fleuronAppData "install-sentinel.txt"
                if (Test-Path $pendingUpdatePath) { Remove-Item -Force $pendingUpdatePath }
                if (Test-Path $installSentinelPath) { Remove-Item -Force $installSentinelPath }

                # 5. The abort path must leave the existing installation and seeded data untouched
                $timeoutParentProc = Start-Process powershell -ArgumentList "-NoProfile", "-Command", "Start-Sleep -Seconds 600" -PassThru
                $timeoutArgs = '/S /FLEURON_PARENT_PID={0} /FLEURON_PENDING_UPDATE="{1}" /FLEURON_INSTALL_SENTINEL="{2}"' -f $timeoutParentProc.Id, $pendingUpdatePath, $installSentinelPath
                Write-Host "Running deliberate updater timeout transaction: $Candidate $timeoutArgs"
                $timeoutRes = Invoke-InstallerProcess -InstallerPath $Candidate -Arguments $timeoutArgs -TimeoutSeconds 90
                Stop-ProcessTree -ProcessId $timeoutParentProc.Id

                $timeoutNoFleuronExe = if ($b.IsLegacyCodemap) { -not (Test-Path $installedExe) } else { (Test-Path $oldExe) }
                $timeoutNoSentinel = -not (Test-Path $installSentinelPath)
                $timeoutSeededDataIntact = (Test-Path $seededDb) -and ((Get-FileHash -Path $seededDb -Algorithm SHA256).Hash -eq $seededHash)
                $timeoutAbortedCleanly = -not $timeoutRes.TimedOut -and $timeoutNoFleuronExe -and $timeoutNoSentinel -and $timeoutSeededDataIntact
                Add-QATestCaseResult -Evidence $Evidence -Name "$($b.Id)_timeout_aborts_cleanly" -Leg "updater" -Status $(if ($timeoutAbortedCleanly) { "PASS" } else { "FAIL" }) -ElapsedMs $timeoutRes.ElapsedMs -ExitCode $timeoutRes.ExitCode -Details "Installer exited=$(-not $timeoutRes.TimedOut); sentinel absent=$timeoutNoSentinel; seeded data intact=$timeoutSeededDataIntact." -Diagnostics $timeoutRes.Diagnostics
                if (-not $timeoutAbortedCleanly) {
                    throw "Updater timeout path changed installation state; refusing to run the real transaction from a dirty state."
                }

                if (Test-Path $pendingUpdatePath) { Remove-Item -Force $pendingUpdatePath }
                if (Test-Path $installSentinelPath) { Remove-Item -Force $installSentinelPath }

                # 6. Spawn short-lived synthetic parent
                $parentProc = Start-Process powershell -ArgumentList "-NoProfile", "-Command", "Start-Sleep -Seconds 3" -PassThru

                # 7. Execute candidate installer with real /FLEURON_* updater flags
                $updaterArgs = '/S /FLEURON_PARENT_PID={0} /FLEURON_PENDING_UPDATE="{1}" /FLEURON_INSTALL_SENTINEL="{2}"' -f $parentProc.Id, $pendingUpdatePath, $installSentinelPath
                Write-Host "Running candidate updater transaction: $Candidate $updaterArgs"
                $updaterRes = Invoke-InstallerProcess -InstallerPath $Candidate -Arguments $updaterArgs -TimeoutSeconds 90

                Stop-ProcessTree -ProcessId $parentProc.Id

                # 8. Collect End-State Diagnostics
                $endState = @{
                    candidate_exit_code = $updaterRes.ExitCode
                    baseline_id = $b.Id
                    old_exe_exists = (Test-Path $oldExe)
                    old_exe_version = if (Test-Path $oldExe) { (Get-Item $oldExe).VersionInfo.FileVersion } else { "absent" }
                    fleuron_exe_exists = (Test-Path $installedExe)
                    fleuron_exe_version = if (Test-Path $installedExe) { (Get-Item $installedExe).VersionInfo.FileVersion } else { "absent" }
                    uninstall_codemap_exists = (Test-Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Codemap")
                    uninstall_fleuron_exists = (Test-Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Fleuron")
                    pending_marker_exists = (Test-Path $pendingUpdatePath)
                    sentinel_exists = (Test-Path $installSentinelPath)
                    seeded_data_intact = (Test-Path $seededDb) -and ((Get-FileHash -Path $seededDb -Algorithm SHA256).Hash -eq $seededHash)
                }
                $endState | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $RawDir "updater-end-state-$($b.Id).json") -Encoding utf8

                if ($b.IsLegacyCodemap) {
                    # Criterion 1: Codemap.exe is either removed or replaced
                    if (-not (Test-Path $oldExe)) {
                        Add-QATestCaseResult -Evidence $Evidence -Name "codemap_exe_replaced_or_removed" -Leg "updater" -Status "PASS" -Details "Codemap.exe was cleanly removed/replaced."
                    } elseif ((Get-Item $oldExe).VersionInfo.FileVersion -match $ExpectedVersionRegex) {
                        Add-QATestCaseResult -Evidence $Evidence -Name "codemap_exe_replaced_or_removed" -Leg "updater" -Status "PASS" -Details "Codemap.exe binary was upgraded to $ExpectedVersion."
                    } else {
                        $oldVer = (Get-Item $oldExe).VersionInfo.FileVersion
                        Add-QATestCaseResult -Evidence $Evidence -Name "codemap_exe_replaced_or_removed" -Leg "updater" -Status "FAIL" -ExitCode 1 -Details "Codemap.exe remains at version $oldVer beside Fleuron (side-by-side split)." -Diagnostics "End state dumped to raw/updater-end-state-codemap_120.json"
                    }

                    # Criterion 2: Fleuron candidate is present
                    if ((Test-Path $installedExe) -and ((Get-Item $installedExe).VersionInfo.FileVersion -match $ExpectedVersionRegex)) {
                        Add-QATestCaseResult -Evidence $Evidence -Name "fleuron_v2_installed_after_update" -Leg "updater" -Status "PASS" -Details "Fleuron $ExpectedVersion binary present at $installedExe"
                    } else {
                        Add-QATestCaseResult -Evidence $Evidence -Name "fleuron_v2_installed_after_update" -Leg "updater" -Status "FAIL" -ExitCode 1 -Details "Fleuron $ExpectedVersion binary missing or invalid version."
                    }

                    # Criterion 3: Seeded data preserved
                    if ($endState.seeded_data_intact) {
                        Add-QATestCaseResult -Evidence $Evidence -Name "seeded_user_data_intact" -Leg "updater" -Status "PASS" -Details "Seeded user data and project files untouched during upgrade."
                    } else {
                        Add-QATestCaseResult -Evidence $Evidence -Name "seeded_user_data_intact" -Leg "updater" -Status "FAIL" -ExitCode 1 -Details "Seeded user data was corrupted or deleted during upgrade."
                    }

                    # Gap 4 summary verdict
                    if ((Test-Path $oldExe) -and ((Get-Item $oldExe).VersionInfo.FileVersion -match "1\.2\.0") -and (Test-Path $installedExe)) {
                        $gapDiag = "1.2.0 path: " + $oldExe + " | $ExpectedVersion path: " + $installedExe
                        Add-QATestCaseResult -Evidence $Evidence -Name "updater_left_user_on_previous_version" -Leg "updater" -Status "FAIL" -ExitCode 1 -Details "Observed Gap 4: Shipped 1.2.0 updater left 1.2.0 installed beside new $ExpectedVersion." -Diagnostics $gapDiag
                    }
                } else {
                    # Fleuron-baseline assertions
                    if ((Test-Path $installedExe) -and ((Get-Item $installedExe).VersionInfo.FileVersion -match $ExpectedVersionRegex)) {
                        Add-QATestCaseResult -Evidence $Evidence -Name "fleuron_baseline_upgraded_to_candidate" -Leg "updater" -Status "PASS" -Details "Fleuron $ExpectedVersion binary present after in-place upgrade."
                    } else {
                        Add-QATestCaseResult -Evidence $Evidence -Name "fleuron_baseline_upgraded_to_candidate" -Leg "updater" -Status "FAIL" -ExitCode 1 -Details "Fleuron upgraded binary missing or version mismatch."
                    }

                    if ($endState.seeded_data_intact) {
                        Add-QATestCaseResult -Evidence $Evidence -Name "fleuron_baseline_seeded_data_intact" -Leg "updater" -Status "PASS" -Details "Seeded Fleuron data preserved across update."
                    } else {
                        Add-QATestCaseResult -Evidence $Evidence -Name "fleuron_baseline_seeded_data_intact" -Leg "updater" -Status "FAIL" -ExitCode 1 -Details "Seeded Fleuron data was corrupted or deleted during upgrade."
                    }
                }
            }
        }
    } catch {
        Add-QATestCaseResult -Evidence $Evidence -Name "leg_updater_fatal" -Leg "updater" -Status "FAIL" -ExitCode 1 -Details "Fatal exception in updater leg: $($_.Exception.Message)"
    }
    Invoke-CrashSweep -Evidence $Evidence -StartTimeUtc $updaterStartTime -RawDirectory $RawDir -Leg "updater"
}

# -----------------------------------------------------------------------------
# Leg 6: Online Leg (Opt-in via -Online)
# -----------------------------------------------------------------------------
if ($Online) {
    Write-Host ""
    Write-Host "--- Leg 6: Online Testing (-Online) ---"
    $onlineStartTime = (Get-Date).ToUniversalTime()
    try {
        $envFile = Join-Path $PSScriptRoot "qa.env.ps1"
        if (-not (Test-Path $envFile)) {
            Add-QATestCaseResult -Evidence $Evidence -Name "online_credentials_present" -Leg "online" -Status "FAIL" -ExitCode 1 -Details "Missing qa/qa.env.ps1 file. Required when -Online is specified." -Diagnostics "Required variables: FLEURON_STAGING_SUPABASE_URL, FLEURON_STAGING_SUPABASE_ANON_KEY, FLEURON_STAGING_OWNER_EMAIL, FLEURON_STAGING_OWNER_PASSWORD, FLEURON_STAGING_JOINER_EMAIL, FLEURON_STAGING_JOINER_PASSWORD"
        } else {
            . $envFile
            $requiredVars = @(
                "FLEURON_STAGING_SUPABASE_URL",
                "FLEURON_STAGING_SUPABASE_ANON_KEY",
                "FLEURON_STAGING_OWNER_EMAIL",
                "FLEURON_STAGING_OWNER_PASSWORD",
                "FLEURON_STAGING_JOINER_EMAIL",
                "FLEURON_STAGING_JOINER_PASSWORD"
            )

            $missing = @()
            $envDict = @{}
            foreach ($v in $requiredVars) {
                $val = [Environment]::GetEnvironmentVariable($v)
                if ([string]::IsNullOrWhiteSpace($val)) {
                    # Check PowerShell scope variable
                    $val = (Get-Variable -Name $v -ValueOnly -ErrorAction SilentlyContinue)
                }
                if ([string]::IsNullOrWhiteSpace($val)) {
                    $missing += $v
                } else {
                    $envDict[$v] = $val
                }
            }

            if ($missing.Count -gt 0) {
                $missingStr = $missing -join ", "
                Add-QATestCaseResult -Evidence $Evidence -Name "online_credentials_present" -Leg "online" -Status "FAIL" -ExitCode 1 -Details "Missing required staging variables in qa.env.ps1: $missingStr"
            } else {
                Add-QATestCaseResult -Evidence $Evidence -Name "online_credentials_present" -Leg "online" -Status "PASS" -Details "All 6 staging environment variables verified present."

                $onlineLog = Join-Path $RawDir "selftest-online.log"
                Invoke-InstalledSelftest -Evidence $Evidence -BinaryPath $installedExe -LogPath $onlineLog -Leg "online" -RequireOnline -EnvVars $envDict
            }
        }
    } catch {
        Add-QATestCaseResult -Evidence $Evidence -Name "leg_online_fatal" -Leg "online" -Status "FAIL" -ExitCode 1 -Details "Fatal exception in online leg: $($_.Exception.Message)"
    }
    Invoke-CrashSweep -Evidence $Evidence -StartTimeUtc $onlineStartTime -RawDirectory $RawDir -Leg "online"
}

# -----------------------------------------------------------------------------
# Leg 7: Evidence Compilation and Exit Gate
# -----------------------------------------------------------------------------
Write-Host ""
Write-Host "--- Exporting Evidence and Summaries ---"
Export-QAEvidence -Evidence $Evidence -OutputDirectory $OutputDirectory

$failedCases = @($Evidence.test_cases | Where-Object { $_.status -ne "PASS" -and $_.status -ne "SKIP" })
$totalCases = $Evidence.test_cases.Count

if ($failedCases.Count -gt 0) {
    $failNames = ($failedCases | ForEach-Object { "$($_.leg)/$($_.name)" }) -join ", "
    Write-Host ""
    Write-Host "::error::Fleuron QA Runner completed with $($failedCases.Count)/$totalCases failures: $failNames"
    exit 1
} else {
    Write-Host ""
    Write-Host "All $totalCases Fleuron QA test cases PASSED (or cleanly SKIPPED)."
    exit 0
}
