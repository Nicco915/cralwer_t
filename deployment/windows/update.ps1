#Requires -RunAsAdministrator
param (
    [string]$InstallDir = 'C:\hs-sku-crawler',

    [string]$Branch = 'main'
)

# Check administrator privileges
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "This script must be run as Administrator."
    exit 1
}

$updateScript = Join-Path $PSScriptRoot "lib" "update.js"
& node "$updateScript" --install-dir "$InstallDir" --branch "$Branch"
if ($LASTEXITCODE -ne 0) {
    Write-Error "Update script failed."
    exit 1
}
