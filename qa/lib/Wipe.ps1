# qa/lib/Wipe.ps1
# Provable state wipe and canary protection for Fleuron QA runner.

function Get-StandardWipeTargets {
    $localAppData = [Environment]::GetFolderPath("LocalApplicationData")
    $appData = [Environment]::GetFolderPath("ApplicationData")
    $userProfile = [Environment]::GetFolderPath("UserProfile")

    return @(
        @{ Type = "Directory"; Path = (Join-Path $localAppData "Fleuron") },
        @{ Type = "Directory"; Path = (Join-Path $localAppData "Codemap") },
        @{ Type = "Directory"; Path = (Join-Path $appData "study.fleuron.desktop") },
        @{ Type = "Directory"; Path = (Join-Path $appData "app.codemap.desktop") },
        @{ Type = "Directory"; Path = (Join-Path $userProfile "Fleuron") },
        @{ Type = "Registry"; Path = "HKCU:\Software\Fleuron\Fleuron" },
        @{ Type = "Registry"; Path = "HKCU:\Software\Codemap\Codemap" },
        @{ Type = "Registry"; Path = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Fleuron" },
        @{ Type = "Registry"; Path = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Codemap" }
    )
}

function Test-TargetExists {
    param ([hashtable]$Target)
    try {
        return (Test-Path -Path $Target.Path -ErrorAction SilentlyContinue)
    } catch {
        return $false
    }
}

function Remove-Target {
    param ([hashtable]$Target)
    try {
        if (Test-TargetExists -Target $Target) {
            Remove-Item -Path $Target.Path -Recurse -Force -ErrorAction SilentlyContinue
        }
    } catch {}
}

function Invoke-ProvableWipe {
    param (
        [hashtable]$Evidence,
        [array]$CustomTargets = @()
    )

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $targets = if ($CustomTargets.Count -gt 0) { $CustomTargets } else { Get-StandardWipeTargets }

    # 1. Enumerate pre-wipe state
    $preExisting = @()
    foreach ($t in $targets) {
        if (Test-TargetExists -Target $t) {
            $preExisting += "$($t.Type): $($t.Path)"
        }
    }
    $Evidence.wipe_pre = $preExisting

    # 2. Execute deletion
    foreach ($t in $targets) {
        Remove-Target -Target $t
    }

    # 3. Enumerate post-wipe state
    $postExisting = @()
    foreach ($t in $targets) {
        if (Test-TargetExists -Target $t) {
            $postExisting += "$($t.Type): $($t.Path)"
        }
    }
    $Evidence.wipe_post = $postExisting
    $sw.Stop()

    # 4. Record evidence
    $preCount = $preExisting.Count
    $postCount = $postExisting.Count

    if ($postCount -gt 0) {
        $survivors = $postExisting -join "; "
        $preStr = $preExisting -join "; "
        Add-QATestCaseResult -Evidence $Evidence -Name "provable_wipe" -Leg "wipe" -Status "FAIL" -ElapsedMs $sw.ElapsedMilliseconds -ExitCode 1 -Details "Wipe incomplete: $postCount target(s) could not be removed." -Diagnostics "Pre-existing: ($preStr) | Survivors: $survivors"
        return $false
    } else {
        $remStr = if ($preCount -gt 0) { $preExisting -join "; " } else { "None (system was already clean)" }
        Add-QATestCaseResult -Evidence $Evidence -Name "provable_wipe" -Leg "wipe" -Status "PASS" -ElapsedMs $sw.ElapsedMilliseconds -ExitCode 0 -Details "Provable wipe verified clean. Removed $preCount pre-existing target(s), 0 surviving." -Diagnostics "Removed targets: $remStr"
        return $true
    }
}

function Initialize-Canaries {
    param (
        [hashtable]$Evidence
    )

    $localAppData = [Environment]::GetFolderPath("LocalApplicationData")
    $userProfile = [Environment]::GetFolderPath("UserProfile")

    $canaryDirDocs = Join-Path $userProfile "Documents\Fleuron-QA-Canary"
    $canaryDirLocal = Join-Path $localAppData "Fleuron-unrelated-sibling"

    New-Item -ItemType Directory -Path $canaryDirDocs -Force | Out-Null
    New-Item -ItemType Directory -Path $canaryDirLocal -Force | Out-Null

    $cFileDocs = Join-Path $canaryDirDocs "canary-doc.txt"
    $cFileLocal = Join-Path $canaryDirLocal "sibling.dat"

    Set-Content -Path $cFileDocs -Value "CANARY_USER_DOCUMENT_DO_NOT_DELETE" -Force
    Set-Content -Path $cFileLocal -Value "CANARY_SIBLING_DO_NOT_DELETE" -Force

    $hashDocs = (Get-FileHash -Path $cFileDocs -Algorithm SHA256).Hash
    $hashLocal = (Get-FileHash -Path $cFileLocal -Algorithm SHA256).Hash

    $Evidence.canaries = @{
        docs_path = $cFileDocs
        docs_hash = $hashDocs
        local_path = $cFileLocal
        local_hash = $hashLocal
    }
}

function Assert-Canaries {
    param (
        [hashtable]$Evidence,
        [string]$LegName = "install"
    )

    if (-not $Evidence.canaries -or -not $Evidence.canaries.docs_path) {
        return $true
    }

    $cDocs = $Evidence.canaries.docs_path
    $cLocal = $Evidence.canaries.local_path
    $origDocsHash = $Evidence.canaries.docs_hash
    $origLocalHash = $Evidence.canaries.local_hash

    $validDocs = (Test-Path $cDocs) -and ((Get-FileHash -Path $cDocs -Algorithm SHA256).Hash -eq $origDocsHash)
    $validLocal = (Test-Path $cLocal) -and ((Get-FileHash -Path $cLocal -Algorithm SHA256).Hash -eq $origLocalHash)

    if ($validDocs -and $validLocal) {
        Add-QATestCaseResult -Evidence $Evidence -Name "canary_integrity_$LegName" -Leg $LegName -Status "PASS" -Details "Synthetic canaries untouched and hashes intact."
        return $true
    } else {
        Add-QATestCaseResult -Evidence $Evidence -Name "canary_integrity_$LegName" -Leg $LegName -Status "FAIL" -ExitCode 1 -Details "CRITICAL: Synthetic canary was mutated or deleted during operation!" -Diagnostics "Docs canary intact: $validDocs | Local sibling canary intact: $validLocal"
        return $false
    }
}