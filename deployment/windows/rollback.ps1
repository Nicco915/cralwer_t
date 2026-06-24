#Requires -RunAsAdministrator
param (
    [string]$InstallDir = 'C:\hs-sku-crawler',

    [string]$TargetCommit = ''
)

# Check administrator privileges
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "This script must be run as Administrator."
    exit 1
}

$rollbackScript = Join-Path $PSScriptRoot "lib\rollback.js"
if ($TargetCommit) {
    & node "$rollbackScript" --install-dir "$InstallDir" --target-commit "$TargetCommit"
} else {
    & node "$rollbackScript" --install-dir "$InstallDir"
}
if ($LASTEXITCODE -ne 0) {
    Write-Error "Rollback script failed."
    exit 1
}
