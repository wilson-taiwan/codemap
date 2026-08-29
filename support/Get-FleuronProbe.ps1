# support/Get-FleuronProbe.ps1
# Fleuron Read-Only Diagnostic Probe (Windows PowerShell 5.1 / pwsh)
#
# Gathers environment and install diagnostics when the app fails to start.
# STRICTLY READ-ONLY: Never modifies files, installs software, or touches
# registry keys except to read. Collects NO transcripts, participant IDs, or code names.

[CmdletBinding()]
param (
    [string]$OutputFilePath = "",
    [switch]$Help
)

$ErrorActionPreference = "Continue"

function Redact-PanicPayload {
    param ([string]$Raw)

    if ([string]::IsNullOrWhiteSpace($Raw)) {
        return "[payload truncated for privacy] (empty)"
    }

    $sanitized = $Raw
    if ($env:USERPROFILE) {
        $sanitized = $sanitized.Replace($env:USERPROFILE, "<home>")
    }
    if ($env:LOCALAPPDATA) {
        $sanitized = $sanitized.Replace($env:LOCALAPPDATA, "<localappdata>")
    }

    # Whitelist chars: [a-zA-Z0-9 ._:/()<\->]
    $chars = $sanitized.ToCharArray()
    $sb = New-Object System.Text.StringBuilder
    $lastWasSpace = $false

    foreach ($c in $chars) {
        $isSafe = [char]::IsLetterOrDigit($c) -or
            ($c -eq ' ') -or ($c -eq '.') -or ($c -eq '_') -or
            ($c -eq ':') -or ($c -eq '/') -or ($c -eq '(') -or
            ($c -eq ')') -or ($c -eq '-') -or ($c -eq '<') -or ($c -eq '>')

        if ($isSafe) {
            if ($c -eq ' ') {
                if (-not $lastWasSpace) {
                    [void]$sb.Append(' ')
                    $lastWasSpace = $true
                }
            } else {
                [void]$sb.Append($c)
                $lastWasSpace = $false
            }
        } elseif (-not $lastWasSpace) {
            [void]$sb.Append(' ')
            $lastWasSpace = $true
        }
    }

    $cleaned = $sb.ToString().Trim()
    $charCount = $cleaned.Length

    if ($charCount -le 120) {
        return "[payload truncated for privacy] $cleaned"
    } else {
        $truncated = $cleaned.Substring(0, 120)
        $withheld = $charCount - 120
        return "[payload truncated for privacy] $truncated ...(+${withheld} chars withheld)"
    }
}

function Invoke-FleuronProbeReport {
    param ([string]$OutputFilePath = "")

    $reportLines = [System.Collections.Generic.List[string]]::new()
    $reportLines.Add("=== Fleuron Diagnostic Probe Report (Windows) ===")
    $reportLines.Add("Generated: $([System.DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'))")
    $reportLines.Add("Probe version: 1.0.0")
    $reportLines.Add("Privacy guarantee: This probe is read-only and collects no transcript text, participant labels, or code names.")
    $reportLines.Add("")

    # 1. System
    $reportLines.Add("--- System ---")
    $reportLines.Add("OS: Windows")
    try {
        $os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
        if ($os) {
            $reportLines.Add("Caption: $($os.Caption)")
            $reportLines.Add("Version: $($os.Version)")
            $reportLines.Add("Build: $($os.BuildNumber)")
        } else {
            $reportLines.Add("Version: $([System.Environment]::OSVersion.VersionString)")
        }
    } catch {
        $reportLines.Add("Version: $([System.Environment]::OSVersion.VersionString)")
    }
    $reportLines.Add("Architecture: $(if ([System.Environment]::Is64BitOperatingSystem) { 'x64' } else { 'x86' })")
    $reportLines.Add("PowerShell version: $($PSVersionTable.PSVersion)")
    $reportLines.Add("")

    # 2. Application Install
    $reportLines.Add("--- Application Install ---")
    $installCandidates = @()
    if ($env:LOCALAPPDATA) { $installCandidates += "$env:LOCALAPPDATA\Programs\Fleuron" }
    if ($env:ProgramFiles) { $installCandidates += "$env:ProgramFiles\Fleuron" }
    if (${env:ProgramFiles(x86)}) { $installCandidates += "${env:ProgramFiles(x86)}\Fleuron" }

    $foundInstall = $false
    foreach ($dir in $installCandidates) {
        if ([string]::IsNullOrWhiteSpace($dir)) { continue }
        if (Test-Path -LiteralPath $dir) {
            $foundInstall = $true
            $reportLines.Add("Install folder found: <localappdata>\Programs\Fleuron")
            $exePath = Join-Path $dir "Fleuron.exe"

            if (Test-Path -LiteralPath $exePath -PathType Container) {
                $reportLines.Add("Executable check: FAIL (poisoned nested directory: Fleuron.exe is a directory)")
            } elseif (Test-Path -LiteralPath $exePath -PathType Leaf) {
                $reportLines.Add("Executable check: OK (Fleuron.exe present)")
                try {
                    $vi = (Get-Item -LiteralPath $exePath).VersionInfo
                    $reportLines.Add("File version: $($vi.FileVersion)")
                    $reportLines.Add("Product version: $($vi.ProductVersion)")
                } catch {
                    $reportLines.Add("Version info: unreadable ($_)")
                }
            } else {
                $reportLines.Add("Executable check: missing Fleuron.exe")
            }
        }
    }

    if (-not $foundInstall) {
        $reportLines.Add("No standard Fleuron install folder found.")
    }
    $reportLines.Add("")

    # 3. Registry Uninstall Entries (Read-only)
    $reportLines.Add("--- Uninstall Registry (Read-only) ---")
    $regPaths = @(
        "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKLM:\Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
    )

    $matchingApps = @()
    foreach ($rp in $regPaths) {
        try {
            $keys = Get-ItemProperty -Path $rp -ErrorAction SilentlyContinue
            foreach ($k in $keys) {
                if ($k.DisplayName -and ($k.DisplayName -match 'Fleuron|Codemap')) {
                    $matchingApps += "$($k.DisplayName) [Version: $($k.DisplayVersion)]"
                }
            }
        } catch {}
    }

    if ($matchingApps.Count -gt 0) {
        foreach ($app in $matchingApps) {
            $reportLines.Add("Registered app: $app")
        }
    } else {
        $reportLines.Add("No Fleuron or Codemap entries found in Uninstall registry.")
    }
    $reportLines.Add("")

    # 4. Library Directory
    $reportLines.Add("--- Library Directory ---")
    $homeDir = if ($env:USERPROFILE) { $env:USERPROFILE } elseif ($env:HOME) { $env:HOME } else { "" }
    if ($homeDir) {
        $libDir = Join-Path $homeDir "Fleuron"
        if (Test-Path -LiteralPath $libDir) {
            $reportLines.Add("Library: <library> (exists)")
            try {
                $projFolders = Get-ChildItem -LiteralPath $libDir -Directory -ErrorAction SilentlyContinue |
                    Where-Object {
                        $_.Name -match '\.(fleuron|codemap|qcproj)$' -or
                        (Test-Path -LiteralPath (Join-Path $_.FullName "project.db"))
                    }
                $reportLines.Add("Project count: $($projFolders.Count)")
            } catch {
                $reportLines.Add("Project count: unavailable ($_)")
            }
        } else {
            $reportLines.Add("Library: <library> (absent)")
        }
    } else {
        $reportLines.Add("Library: unavailable (no home directory detected)")
    }
    $reportLines.Add("")

    # 5. Crash Logs
    $reportLines.Add("--- Crash Logs ---")
    if ($env:LOCALAPPDATA) {
        $crashFile = Join-Path $env:LOCALAPPDATA "study.fleuron.desktop\crashes\crash.log"
        if (Test-Path -LiteralPath $crashFile) {
            try {
                $item = Get-Item -LiteralPath $crashFile
                $reportLines.Add("Crash log present: true ($($item.Length) bytes)")
                $reportLines.Add("Recent records (redacted):")

                $content = [System.IO.File]::ReadAllText($crashFile)
                $chunks = $content -split '--- CRASH RECORD ---'
                $recIdx = 0

                foreach ($chunk in $chunks) {
                    if ([string]::IsNullOrWhiteSpace($chunk)) { continue }
                    $recIdx++
                    $recClean = ($chunk -split '--- END RECORD ---')[0]
                    $lines = $recClean -split "`r?`n"

                    $reportLines.Add("[Record $recIdx]")
                    foreach ($line in $lines) {
                        if ($line -match '^(Timestamp|Version|OS|Thread|Location):') {
                            $reportLines.Add($line.Trim())
                        } elseif ($line -match '^Message:\s*(.*)$') {
                            $redacted = Redact-PanicPayload -Raw $matches[1]
                            $reportLines.Add("Message: $redacted")
                        }
                    }
                }
            } catch {
                $reportLines.Add("Crash log read error: $_")
            }
        } else {
            $reportLines.Add("Crash log present: false (clean)")
        }
    } else {
        $reportLines.Add("Crash log present: unavailable")
    }
    $reportLines.Add("")

    # 6. Windows Error Reporting / Crash Dumps (Counts only)
    $reportLines.Add("--- System Crash Dumps (Counts only) ---")
    if ($env:LOCALAPPDATA) {
        $dumpsDir = Join-Path $env:LOCALAPPDATA "CrashDumps"
        if (Test-Path -LiteralPath $dumpsDir) {
            try {
                $dumps = Get-ChildItem -LiteralPath $dumpsDir -Filter "*Fleuron*.dmp" -File -ErrorAction SilentlyContinue
                $reportLines.Add("CrashDumps count matching Fleuron: $($dumps.Count)")
            } catch {
                $reportLines.Add("CrashDumps check: unavailable ($_)")
            }
        } else {
            $reportLines.Add("CrashDumps directory: absent")
        }
    } else {
        $reportLines.Add("CrashDumps directory: unavailable")
    }

    $fullReport = $reportLines -join "`r`n"

    if ($OutputFilePath) {
        try {
            [System.IO.File]::WriteAllText($OutputFilePath, $fullReport, [System.Text.Encoding]::ASCII)
            Write-Host "Diagnostic report saved to $OutputFilePath"
        } catch {
            Write-Error ("Failed to write report to {0}: {1}" -f $OutputFilePath, $_)
            Write-Host $fullReport
        }
    } else {
        Write-Host $fullReport
    }
}

if ($Help) {
    Write-Host "Fleuron Diagnostic Probe (Windows) - Read-only inspection"
    Write-Host ""
    Write-Host "Usage:"
    Write-Host "  powershell -NoProfile -File support\Get-FleuronProbe.ps1 [-OutputFilePath <path>]"
    Write-Host "  powershell -NoProfile -File support\Get-FleuronProbe.ps1 -Help"
    Write-Host ""
    Write-Host "Parameters:"
    Write-Host "  -OutputFilePath <path>  Write output to the specified text file instead of console only"
    Write-Host "  -Help                   Show this help message"
    exit 0
}

if ($MyInvocation.InvocationName -ne '.') {
    Invoke-FleuronProbeReport -OutputFilePath $OutputFilePath
}
