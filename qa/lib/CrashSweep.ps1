# qa/lib/CrashSweep.ps1
# Inspects Windows error logs, dumps, and WER reports for Fleuron QA runner.

function Invoke-CrashSweep {
    param (
        [hashtable]$Evidence,
        [Parameter(Mandatory = $true)][datetime]$StartTimeUtc,
        [Parameter(Mandatory = $true)][string]$RawDirectory,
        [string]$Leg = "crash_sweep"
    )

    if (-not (Test-Path $RawDirectory)) {
        New-Item -ItemType Directory -Path $RawDirectory -Force | Out-Null
    }

    $appData = [Environment]::GetFolderPath("ApplicationData")
    $localAppData = [Environment]::GetFolderPath("LocalApplicationData")

    # 1. Internal crash logs: %APPDATA%\study.fleuron.desktop\crashes\crash.log and app.codemap.desktop
    $internalLogDirs = @(
        (Join-Path $appData "study.fleuron.desktop\crashes"),
        (Join-Path $appData "app.codemap.desktop\crashes")
    )

    $internalCrashFound = $false
    $internalCheckedSummary = @()

    foreach ($cdir in $internalLogDirs) {
        if (-not (Test-Path $cdir)) {
            $internalCheckedSummary += "$cdir (absent)"
            continue
        }

        $logFile = Join-Path $cdir "crash.log"
        if ((Test-Path $logFile) -and ((Get-Item $logFile).Length -gt 0)) {
            $item = Get-Item $logFile
            if ($item.LastWriteTimeUtc -ge $StartTimeUtc) {
                $internalCrashFound = $true
                $destName = "crash-log-$($item.LastWriteTimeUtc.ToString('yyyyMMdd-HHmmss'))-$([System.IO.Path]::GetFileName([System.IO.Path]::GetDirectoryName($cdir))).log"
                $destPath = Join-Path $RawDirectory $destName
                Copy-Item -Path $logFile -Destination $destPath -Force

                $content = Get-Content -Path $logFile -Raw -ErrorAction SilentlyContinue
                Add-QATestCaseResult -Evidence $Evidence -Name "internal_crash_log" -Leg $Leg -Status "FAIL" -ExitCode 1 -Details "Internal panic/crash log updated at $logFile" -Diagnostics "Saved to raw/$destName. Content: $content"
            } else {
                $internalCheckedSummary += "$cdir (older than start: $($item.LastWriteTimeUtc.ToString('s')))"
            }
        } else {
            $internalCheckedSummary += "$cdir (no active crash.log)"
        }
    }

    if (-not $internalCrashFound) {
        Add-QATestCaseResult -Evidence $Evidence -Name "internal_crash_log" -Leg $Leg -Status "PASS" -Details "No internal crash logs generated since start time." -Diagnostics ($internalCheckedSummary -join "; ")
    }

    # 2. LocalAppData CrashDumps (*.dmp)
    $dumpsDir = Join-Path $localAppData "CrashDumps"
    $dumpFound = $false
    if (Test-Path $dumpsDir) {
        $dumps = Get-ChildItem -Path $dumpsDir -Filter "*.dmp" -ErrorAction SilentlyContinue |
            Where-Object {
                ($_.Name -like "Fleuron*.dmp" -or $_.Name -like "Codemap*.dmp") -and
                ($_.LastWriteTimeUtc -ge $StartTimeUtc)
            }

        if ($dumps -and $dumps.Count -gt 0) {
            $dumpFound = $true
            $names = @()
            foreach ($d in $dumps) {
                $dest = Join-Path $RawDirectory $d.Name
                Copy-Item -Path $d.FullName -Destination $dest -Force
                $names += $d.Name
            }
            if ($names.Count -gt 0) {
                $namesStr = $names -join ", "
                Add-QATestCaseResult -Evidence $Evidence -Name "crash_dumps_found" -Leg $Leg -Status "FAIL" -ExitCode 1 -Details "Crash dumps found in ${dumpsDir}: $namesStr" -Diagnostics "Minidumps copied to raw/"
            }
        }
    }

    if (-not $dumpFound) {
        $dStatus = if (Test-Path $dumpsDir) { "CrashDumps directory checked: 0 matching dumps" } else { "CrashDumps directory absent" }
        Add-QATestCaseResult -Evidence $Evidence -Name "windows_crash_dumps" -Leg $Leg -Status "PASS" -Details "No Windows user-mode crash dumps generated for Fleuron/Codemap." -Diagnostics $dStatus
    }

    # 3. Windows Error Reporting (WER)
    $werDirs = @(
        (Join-Path $localAppData "Microsoft\Windows\WER\ReportArchive"),
        (Join-Path $localAppData "Microsoft\Windows\WER\ReportQueue")
    )

    $werFound = $false
    $werSummary = @()

    foreach ($wdir in $werDirs) {
        if (-not (Test-Path $wdir)) {
            $werSummary += "$([System.IO.Path]::GetFileName($wdir)) (absent)"
            continue
        }

        $werReports = Get-ChildItem -Path $wdir -Recurse -Filter "Report.wer" -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTimeUtc -ge $StartTimeUtc }

        foreach ($r in $werReports) {
            $content = Get-Content -Path $r.FullName -Raw -ErrorAction SilentlyContinue
            if ($content -match "Fleuron" -or $content -match "Codemap" -or $r.FullName -match "Fleuron" -or $r.FullName -match "Codemap") {
                $werFound = $true
                $parentName = Split-Path (Split-Path $r.FullName -Parent) -Leaf
                $destName = "wer-$parentName-Report.wer"
                $dest = Join-Path $RawDirectory $destName
                Copy-Item -Path $r.FullName -Destination $dest -Force

                Add-QATestCaseResult -Evidence $Evidence -Name "wer_reports" -Leg $Leg -Status "FAIL" -ExitCode 1 -Details "WER crash report captured: $parentName" -Diagnostics "Report copied to raw/$destName"
            }
        }
        $werSummary += "$([System.IO.Path]::GetFileName($wdir)) (scanned)"
    }

    if (-not $werFound) {
        Add-QATestCaseResult -Evidence $Evidence -Name "wer_reports" -Leg $Leg -Status "PASS" -Details "No Windows Error Reporting (WER) crashes found." -Diagnostics ($werSummary -join "; ")
    }
}