# qa/Test-Parse.ps1
# Parse-checks every runner .ps1 WITHOUT executing it, and reports every error
# at once instead of the one-per-run cascade you get from just launching it.
# Run this after copying the qa/ folder to the VM, before any real QA run.

$qaFiles = Get-ChildItem -Path $PSScriptRoot -Recurse -Filter *.ps1
$supportDir = Join-Path (Split-Path -Parent $PSScriptRoot) "support"
$supportFiles = if (Test-Path -LiteralPath $supportDir) {
    Get-ChildItem -Path $supportDir -Recurse -Filter *.ps1
} else {
    @()
}
$files = @($qaFiles) + @($supportFiles) | Sort-Object FullName
$bad = 0
$repoRoot = Split-Path -Parent $PSScriptRoot

foreach ($f in $files) {
    $errs = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile(
        $f.FullName, [ref]$null, [ref]$errs)

    $rel = if ($f.FullName.StartsWith($repoRoot)) {
        $f.FullName.Substring($repoRoot.Length).TrimStart('\', '/')
    } else {
        $f.Name
    }
    if ($errs -and $errs.Count -gt 0) {
        $bad++
        Write-Host ("FAIL  {0}  ({1} error(s))" -f $rel, $errs.Count)
        foreach ($e in $errs) {
            Write-Host ("        line {0} col {1}: {2}" -f $e.Extent.StartLineNumber, $e.Extent.StartColumnNumber, $e.Message)
        }
    } else {
        Write-Host ("OK    {0}" -f $rel)
    }
}

Write-Host ""
Write-Host ("PowerShell $($PSVersionTable.PSVersion) parsed $($files.Count) file(s), $bad with errors.")
if ($bad -gt 0) { exit 1 }
Write-Host "All runner files parse clean. Safe to run -SelfCheck."
exit 0
