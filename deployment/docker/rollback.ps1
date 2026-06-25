#Requires -RunAsAdministrator
param (
    [string]$TargetImage = '',

    [string]$InstallDir = 'C:\hs-sku-crawler'
)

# Check administrator privileges
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "This script must be run as Administrator."
    exit 1
}

$rollbackScript = Join-Path $PSScriptRoot "lib\rollback.js"
if ($TargetImage) {
    & node "$rollbackScript" --target-image "$TargetImage" --install-dir "$InstallDir"
} else {
    & node "$rollbackScript" --install-dir "$InstallDir"
}
if ($LASTEXITCODE -ne 0) {
    Write-Error "Rollback script failed."
    exit 1
}
