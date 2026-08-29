# qa/lib/Download.ps1
# Fetches published releases for baseline and updater regression testing in Fleuron QA runner.

function Get-PreviousReleaseInstaller {
    param (
        [hashtable]$Evidence,
        [string]$PreviousLocalPath = "",
        [string]$Version = "1.2.0",
        [string]$DownloadDirectory = "$PSScriptRoot\..\download"
    )

    if ($PreviousLocalPath -and (Test-Path $PreviousLocalPath)) {
        $hash = (Get-FileHash -Path $PreviousLocalPath -Algorithm SHA256).Hash.ToLowerInvariant()
        Add-QATestCaseResult -Evidence $Evidence -Name "previous_installer_resolved" -Leg "updater" -Status "PASS" -Details "Using provided local previous installer: $PreviousLocalPath (SHA-256: $hash)"
        return $PreviousLocalPath
    }

    if (-not (Test-Path $DownloadDirectory)) {
        New-Item -ItemType Directory -Path $DownloadDirectory -Force | Out-Null
    }

    # Immutable released filename for 1.2.0 was Codemap_1.2.0_x64-setup.exe
    $fileName = if ($Version -eq "1.2.0" -or $Version -eq "1.1.0" -or $Version -eq "1.0.0") {
        "Codemap_${Version}_x64-setup.exe"
    } else {
        "Fleuron_${Version}_x64-setup.exe"
    }

    $destPath = Join-Path $DownloadDirectory $fileName
    $downloadUrl = "https://github.com/wilson-taiwan/fleuron/releases/download/v${Version}/${fileName}"

    Write-Host "Downloading previous installer v${Version} from $downloadUrl..."
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $downloadUrl -OutFile $destPath -UseBasicParsing
        $sw.Stop()

        if (-not (Test-Path $destPath) -or ((Get-Item $destPath).Length -eq 0)) {
            Add-QATestCaseResult -Evidence $Evidence -Name "previous_installer_download" -Leg "updater" -Status "FAIL" -ElapsedMs $sw.ElapsedMilliseconds -ExitCode 1 -Details "Downloaded previous installer was empty or missing at $destPath" -Diagnostics "URL: $downloadUrl"
            return $null
        }

        $hash = (Get-FileHash -Path $destPath -Algorithm SHA256).Hash.ToLowerInvariant()
        Add-QATestCaseResult -Evidence $Evidence -Name "previous_installer_download" -Leg "updater" -Status "PASS" -ElapsedMs $sw.ElapsedMilliseconds -Details "Downloaded v${Version} installer ($((Get-Item $destPath).Length) bytes, SHA-256: $hash)" -Diagnostics "URL: $downloadUrl"

        return $destPath
    } catch {
        $sw.Stop()
        Add-QATestCaseResult -Evidence $Evidence -Name "previous_installer_download" -Leg "updater" -Status "FAIL" -ElapsedMs $sw.ElapsedMilliseconds -ExitCode 1 -Details "Failed to download previous installer: $($_.Exception.Message)" -Diagnostics "URL: $downloadUrl"
        return $null
    }
}