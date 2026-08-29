# scripts/check-no-crashes.ps1
# Verifies no Windows crash reports, minidumps, or internal panic logs were generated.
# Usage: powershell -ExecutionPolicy Bypass -File scripts/check-no-crashes.ps1 [START_TIMESTAMP_SECONDS]

param (
    [int64]$StartTimestamp = 0
)

$ErrorActionPreference = "Stop"

$startTimeUtc = if ($StartTimestamp -gt 0) {
    [DateTimeOffset]::FromUnixTimeSeconds($StartTimestamp).UtcDateTime
} else {
    [DateTime]::MinValue.ToUniversalTime()
}

$crashFound = $false
Write-Host "[crash-check] Scanning Windows diagnostic reports and internal crash logs (since $($startTimeUtc.ToString('yyyy-MM-dd HH:mm:ssZ')))..."

$appData = [Environment]::GetFolderPath("ApplicationData")
$localAppData = [Environment]::GetFolderPath("LocalApplicationData")

# 1. Internal crash logs: %APPDATA%\study.fleuron.desktop\crashes\crash.log
$internalDirs = @(
    (Join-Path $appData "study.fleuron.desktop\crashes"),
    (Join-Path $appData "app.codemap.desktop\crashes"),
    (Join-Path $appData "qualitative-coding-app\crashes")
)

foreach ($cdir in $internalDirs) {
    if (Test-Path $cdir) {
        $logFile = Join-Path $cdir "crash.log"
        if ((Test-Path $logFile) -and ((Get-Item $logFile).Length -gt 0)) {
            $item = Get-Item $logFile
            if ($item.LastWriteTimeUtc -ge $startTimeUtc) {
                Write-Host "[FAIL] [crash-check] Internal crash log was updated during test: $logFile"
                $content = Get-Content -Path $logFile -Raw -ErrorAction SilentlyContinue
                Write-Host "--- Crash Log Content ---"
                Write-Host $content
                Write-Host "-------------------------"
                $crashFound = $true
            }
        }
    }
}

# 2. Crash Dumps: %LOCALAPPDATA%\CrashDumps\*.dmp
$dumpsDir = Join-Path $localAppData "CrashDumps"
if (Test-Path $dumpsDir) {
    $dumps = Get-ChildItem -Path $dumpsDir -Filter "*.dmp" -ErrorAction SilentlyContinue |
        Where-Object {
            ($_.Name -like "Fleuron*.dmp" -or $_.Name -like "Codemap*.dmp") -and
            ($_.LastWriteTimeUtc -ge $startTimeUtc)
        }

    foreach ($d in $dumps) {
        Write-Host "[FAIL] [crash-check] Found Windows user-mode crash dump: $($d.FullName)"
        $crashFound = $true
    }
}

# 3. Windows Error Reporting (WER)
$werDirs = @(
    (Join-Path $localAppData "Microsoft\Windows\WER\ReportArchive"),
    (Join-Path $localAppData "Microsoft\Windows\WER\ReportQueue")
)

foreach ($wdir in $werDirs) {
    if (Test-Path $wdir) {
        $reports = Get-ChildItem -Path $wdir -Recurse -Filter "Report.wer" -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTimeUtc -ge $startTimeUtc }

        foreach ($r in $reports) {
            $content = Get-Content -Path $r.FullName -Raw -ErrorAction SilentlyContinue
            if ($content -match "Fleuron" -or $content -match "Codemap" -or $r.FullName -match "Fleuron" -or $r.FullName -match "Codemap") {
                Write-Host "[FAIL] [crash-check] Found WER report: $($r.FullName)"
                $crashFound = $true
            }
        }
    }
}

if (-not $crashFound) {
    Write-Host "[OK] [crash-check] No crash reports detected."
    exit 0
} else {
    Write-Host "[FAIL] [crash-check] Failure: Crashes detected during execution."
    exit 1
}