# qa/lib/Selftest.ps1
# Executes and parses in-app --selftest suite results for Fleuron QA runner.

function Parse-SelftestTranscript {
    param (
        [string]$TranscriptText,
        [string]$Leg,
        [hashtable]$Evidence,
        [switch]$RequireOnline
    )

    $lines = $TranscriptText -split "[\r\n]+"
    $parsedSuites = @()

    foreach ($line in $lines) {
        # Match PASS: "  [PASS] suite-name (123ms)", with or without a leading
        # status glyph. The glyph is deliberately NOT matched literally: the app
        # emits UTF-8 and the console codepage may mangle it, so we skip over
        # whatever non-space token precedes the ASCII [PASS] tag.
        if ($line -match '^\s*\S*\s*\[PASS\]\s+([^\s\(]+)(?:\s+\((\d+)ms\))?') {
            $suiteName = $Matches[1]
            $dur = if ($Matches[2]) { [int]$Matches[2] } else { 0 }
            $parsedSuites += @{
                Name = $suiteName
                Status = "PASS"
                DurationMs = $dur
                Details = "Selftest suite passed in ${dur}ms"
                Diagnostics = ""
            }
        }
        # Match SKIP: "  [SKIP] suite-name: Reason" or "  [SKIP] suite-name (123ms): Reason"
        elseif ($line -match '^\s*\S*\s*\[SKIP\]\s+([^\s\:\(]+)(?:\s+\((\d+)ms\))?[^:]*:\s*(.*)$') {
            $suiteName = $Matches[1]
            $dur = if ($Matches[2]) { [int]$Matches[2] } else { 0 }
            $reason = $Matches[3]
            if ($RequireOnline) {
                $parsedSuites += @{
                    Name = $suiteName
                    Status = "FAIL"
                    DurationMs = $dur
                    Details = "Suite skipped while --require-online active: $reason"
                    Diagnostics = "Online requirement enforced: SKIP treated as FAIL"
                }
            } else {
                $parsedSuites += @{
                    Name = $suiteName
                    Status = "SKIP"
                    DurationMs = $dur
                    Details = "Suite skipped: $reason"
                    Diagnostics = ""
                }
            }
        }
        # Match FAIL: "  [FAIL] suite-name (123ms): Error", "  [FAIL] suite-name: Error",
        # and the --require-online form, which inserts a parenthesised clause
        # between the duration and the colon:
        #   "  [FAIL] suite (5ms) (skipped while --require-online active): reason"
        elseif ($line -match '^\s*\S*\s*\[FAIL\]\s+([^\s\:\(]+)(?:\s+\((\d+)ms\))?[^:]*:\s*(.*)$') {
            $suiteName = $Matches[1]
            $dur = if ($Matches[2]) { [int]$Matches[2] } else { 0 }
            $err = $Matches[3]
            $parsedSuites += @{
                Name = $suiteName
                Status = "FAIL"
                DurationMs = $dur
                Details = "Selftest suite failed: $err"
                Diagnostics = $line.Trim()
            }
        }
    }

    if ($parsedSuites.Count -eq 0) {
        $snip = if ($TranscriptText.Length -gt 500) { $TranscriptText.Substring(0, 500) } else { $TranscriptText }
        Add-QATestCaseResult -Evidence $Evidence -Name "selftest_produced_no_report" -Leg $Leg -Status "FAIL" -ElapsedMs 0 -ExitCode 1 -Details "Selftest completed without emitting any parseable suite result lines." -Diagnostics "Transcript snippet: $snip"
        return $false
    }

    foreach ($s in $parsedSuites) {
        Add-QATestCaseResult -Evidence $Evidence -Name "selftest_$($s.Name)" -Leg $Leg -Status $s.Status -ElapsedMs $s.DurationMs -Details $s.Details -Diagnostics $s.Diagnostics
    }

    return $parsedSuites
}

function Invoke-InstalledSelftest {
    param (
        [hashtable]$Evidence,
        [Parameter(Mandatory = $true)][string]$BinaryPath,
        [Parameter(Mandatory = $true)][string]$LogPath,
        [string]$Leg = "fresh_install",
        [switch]$RequireOnline,
        [hashtable]$EnvVars = $null,
        [int]$TimeoutSeconds = 120
    )

    if (-not (Test-Path $BinaryPath)) {
        Add-QATestCaseResult -Evidence $Evidence -Name "selftest_binary_exists" -Leg $Leg -Status "FAIL" -ExitCode 1 -Details "Target binary not found at '$BinaryPath'"
        return $false
    }

    $argsList = @("--selftest")
    if ($RequireOnline) {
        $argsList += "--require-online"
    }

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $BinaryPath
    $psi.Arguments = $argsList -join " "
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    # The app is Rust and writes UTF-8. Without these the streams are decoded
    # with the console's OEM codepage and every non-ASCII byte is mangled.
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8

    if ($EnvVars) {
        foreach ($k in $EnvVars.Keys) {
            $psi.EnvironmentVariables[$k] = $EnvVars[$k]
        }
    }

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi

    try {
        Write-Host "Running selftest (up to $TimeoutSeconds s), output follows on exit..."
        $proc.Start() | Out-Null

        # Read both pipes asynchronously. Reading them synchronously one after
        # the other can deadlock when the other pipe's buffer fills.
        $outTask = $proc.StandardOutput.ReadToEndAsync()
        $errTask = $proc.StandardError.ReadToEndAsync()

        $completed = $proc.WaitForExit($TimeoutSeconds * 1000)
        $sw.Stop()

        if (-not $completed) {
            try { $proc.Kill() } catch {}
        }

        $stdOut = if ($outTask.Wait(5000)) { $outTask.Result } else { "" }
        $stdErr = if ($errTask.Wait(5000)) { $errTask.Result } else { "" }
        $allText = $stdOut + [Environment]::NewLine + $stdErr

        Write-Host $allText
        Set-Content -Path $LogPath -Value $allText -Encoding utf8

        if (-not $completed) {
            Add-QATestCaseResult -Evidence $Evidence -Name "selftest_execution" -Leg $Leg -Status "FAIL" -ElapsedMs $sw.ElapsedMilliseconds -ExitCode -1 -Details "Selftest process timed out after $TimeoutSeconds seconds." -Diagnostics "Captured logs written to $LogPath"
            return $false
        }

        Add-QATestCaseResult -Evidence $Evidence -Name "selftest_execution" -Leg $Leg -Status $(if ($proc.ExitCode -eq 0) { "PASS" } else { "FAIL" }) -ElapsedMs $sw.ElapsedMilliseconds -ExitCode $proc.ExitCode -Details "Selftest process exited with code $($proc.ExitCode) in $($sw.ElapsedMilliseconds)ms." -Diagnostics "Log saved to $([System.IO.Path]::GetFullPath($LogPath))"

        # Parse individual suite lines
        $parsed = Parse-SelftestTranscript -TranscriptText $allText -Leg $Leg -Evidence $Evidence -RequireOnline:$RequireOnline
        return ($proc.ExitCode -eq 0 -and $parsed -ne $false)

    } catch {
        $sw.Stop()
        Add-QATestCaseResult -Evidence $Evidence -Name "selftest_execution" -Leg $Leg -Status "FAIL" -ElapsedMs $sw.ElapsedMilliseconds -ExitCode 1 -Details "Exception spawning selftest: $($_.Exception.Message)"
        return $false
    }
}
