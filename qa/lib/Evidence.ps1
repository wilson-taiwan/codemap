# qa/lib/Evidence.ps1
# Structured evidence collection and reporting for the Fleuron QA runner.

function New-EvidenceState {
    param (
        [string]$CandidateHash = "UNKNOWN",
        [string]$ExpectedVersion = ""
    )

    $winCaption = ""
    $winBuild = ""
    try {
        $os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
        if ($os) {
            $winCaption = $os.Caption
            $winBuild = $os.BuildNumber
        }
    } catch {}

    if (-not $winCaption) {
        $winCaption = [System.Environment]::OSVersion.ToString()
    }
    $winVer = if ($winBuild) { "$winCaption (Build $winBuild)" } else { $winCaption }

    return @{
        schema = 1
        runner_version = "1.1.0"
        candidate_installer_hash = $CandidateHash
        expected_release_version = $ExpectedVersion
        executed_at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
        windows_version = $winVer
        wipe_pre = @()
        wipe_post = @()
        canaries = @{}
        manual_rows = @()
        test_cases = @()
    }
}

function Add-QATestCaseResult {
    param (
        [hashtable]$Evidence,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Leg,
        [Parameter(Mandatory = $true)][string]$Status, # PASS, FAIL, SKIP, BLOCKED
        [int]$ElapsedMs = 0,
        [int]$ExitCode = 0,
        [string]$Details = "",
        [string]$Diagnostics = ""
    )

    # Enforce no-PASS-on-empty rule: A case may not pass with completely blank details/evidence
    $effectiveStatus = $Status
    $effectiveDetails = $Details
    $effectiveDiagnostics = $Diagnostics

    if ($effectiveStatus -eq "PASS" -and ([string]::IsNullOrWhiteSpace($effectiveDetails))) {
        $effectiveStatus = "FAIL"
        $effectiveDetails = "Failed no-PASS-on-empty enforcement: case reported PASS with empty details."
        $effectiveDiagnostics = if ($Diagnostics) { "$Diagnostics | Empty details on PASS" } else { "Empty details on PASS" }
    }

    $caseObj = @{
        name = $Name
        leg = $Leg
        status = $effectiveStatus
        elapsed_ms = $ElapsedMs
        exit_code = $ExitCode
        details = $effectiveDetails
        diagnostics = $effectiveDiagnostics
    }

    $Evidence.test_cases += $caseObj

    # Single-char sigil: the status word is already printed in brackets below,
    # so this is a scanning aid, not a repeat of it.
    $icon = switch ($effectiveStatus) {
        "PASS"    { "+" }
        "FAIL"    { "x" }
        "SKIP"    { "~" }
        "BLOCKED" { "!" }
        Default   { "?" }
    }
    Write-Host "  $icon [$effectiveStatus] ($Leg) $Name ($ElapsedMs ms, exit: $ExitCode) - $effectiveDetails"
    if ($effectiveDiagnostics) {
        Write-Host "      diagnostics: $effectiveDiagnostics"
    }
}

function Add-QAManualRow {
    param (
        [hashtable]$Evidence,
        [Parameter(Mandatory = $true)][int]$Number,
        [Parameter(Mandatory = $true)][string]$Title,
        [Parameter(Mandatory = $true)][string]$Instruction,
        [Parameter(Mandatory = $true)][string]$ExpectedOutcome
    )

    $Evidence.manual_rows += @{
        number = $Number
        title = $Title
        instruction = $Instruction
        expected = $ExpectedOutcome
    }
}

function Export-QAEvidence {
    param (
        [hashtable]$Evidence,
        [string]$OutputDirectory
    )

    if (-not (Test-Path $OutputDirectory)) {
        New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
    }

    $rawDir = Join-Path $OutputDirectory "raw"
    if (-not (Test-Path $rawDir)) {
        New-Item -ItemType Directory -Path $rawDir -Force | Out-Null
    }

    # 1. Write evidence.json
    $jsonPath = Join-Path $OutputDirectory "evidence.json"
    $Evidence | ConvertTo-Json -Depth 6 | Set-Content -Path $jsonPath -Encoding utf8
    Write-Host ""
    Write-Host "Evidence JSON written to: $jsonPath"

    # 2. Compile SUMMARY.md
    $cases = @($Evidence.test_cases)
    $passCount = @($cases | Where-Object { $_.status -eq "PASS" }).Count
    $failCount = @($cases | Where-Object { $_.status -eq "FAIL" }).Count
    $skipCount = @($cases | Where-Object { $_.status -eq "SKIP" }).Count
    $blockedCount = @($cases | Where-Object { $_.status -eq "BLOCKED" }).Count
    $totalCount = $cases.Count

    $summaryLines = @()
    $summaryLines += "# Fleuron Windows VM QA Summary"
    $summaryLines += ""
    $summaryLines += "- **Verdict:** **$passCount PASS** / **$failCount FAIL** / **$skipCount SKIP** / **$blockedCount BLOCKED** (Total: $totalCount)"
    $summaryLines += ('- **Candidate Hash (SHA-256):** `' + $Evidence.candidate_installer_hash + '`')
    $summaryLines += "- **Executed At:** $($Evidence.executed_at)"
    $summaryLines += "- **Windows OS:** $($Evidence.windows_version)"
    $summaryLines += "- **Runner Version:** $($Evidence.runner_version)"
    $summaryLines += ""
    $summaryLines += "## Test Results by Leg"
    $summaryLines += ""
    $summaryLines += "| Leg | Case | Status | Elapsed (ms) | Exit Code | Details |"
    $summaryLines += "|---|---|---|---|---|---|"

    foreach ($c in $cases) {
        $cleanDetails = ($c.details -replace '\|', '\|') -replace '[\r\n]+', ' '
        $summaryLines += "| $($c.leg) | $($c.name) | **$($c.status)** | $($c.elapsed_ms) | $($c.exit_code) | $cleanDetails |"
    }

    $failedCases = @($cases | Where-Object { $_.status -eq "FAIL" -or $_.status -eq "BLOCKED" })
    if ($failedCases.Count -gt 0) {
        $summaryLines += ""
        $summaryLines += "## Failures & Blocked Diagnostics"
        $summaryLines += ""
        foreach ($fc in $failedCases) {
            $summaryLines += "### [$($fc.status)] $($fc.name) ($($fc.leg))"
            $summaryLines += "- **Details:** $($fc.details)"
            if ($fc.diagnostics) {
                $summaryLines += "- **Diagnostics:** $($fc.diagnostics)"
            }
            $summaryLines += ""
        }
    }

    $manualRows = @($Evidence.manual_rows)
    $summaryLines += ""
    $summaryLines += "## MANUAL - $($manualRows.Count) rows for you"
    $summaryLines += ""
    $summaryLines += "The following items require hands-on verification inside the VM:"
    $summaryLines += ""

    foreach ($m in $manualRows) {
        $summaryLines += "### $($m.number). $($m.title)"
        $summaryLines += "- **Action:** $($m.instruction)"
        $summaryLines += "- **Expected Outcome:** $($m.expected)"
        $summaryLines += ""
    }

    $summaryPath = Join-Path $OutputDirectory "SUMMARY.md"
    $summaryLines -join [Environment]::NewLine | Set-Content -Path $summaryPath -Encoding utf8
    Write-Host "Summary Markdown written to: $summaryPath"

    # 3. Write the manual-rows checklist (FL-029 closeout artifact). The five
    # hands-on rows leave no automated record, so the run emits a fill-in
    # sheet naming the exact build under test. CI is never gated on it.
    $versionTag = $Evidence.expected_release_version
    if ([string]::IsNullOrWhiteSpace($versionTag)) { $versionTag = "unversioned" }
    $versionTag = ($versionTag -replace '[^A-Za-z0-9._-]', '_')
    $manualLines = @()
    $manualLines += "# Fleuron Manual QA Checklist"
    $manualLines += ""
    $manualLines += "- Build under test: $versionTag"
    $manualLines += "- Candidate SHA-256: $($Evidence.candidate_installer_hash)"
    $manualLines += "- Automated run at: $($Evidence.executed_at) ($($Evidence.windows_version))"
    $manualLines += "- Runner version: $($Evidence.runner_version)"
    $manualLines += ""
    $manualLines += "Tick one box per row after performing it by hand inside the VM."
    $manualLines += ""
    foreach ($m in $manualRows) {
        $manualLines += "## $($m.number). $($m.title)"
        $manualLines += "- Action: $($m.instruction)"
        $manualLines += "- Expected: $($m.expected)"
        $manualLines += "- [ ] PASS"
        $manualLines += "- [ ] FAIL"
        $manualLines += "- [ ] SKIP"
        $manualLines += "- Notes: "
        $manualLines += ""
    }
    $manualPath = Join-Path $OutputDirectory ("manual-rows-" + $versionTag + ".md")
    $manualLines -join [Environment]::NewLine | Set-Content -Path $manualPath -Encoding utf8
    Write-Host "Manual checklist written to: $manualPath"
}
