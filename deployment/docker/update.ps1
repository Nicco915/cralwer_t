#Requires -RunAsAdministrator
param (
    [Parameter(Mandatory = $true)]
    [string]$ImageTag,

    [string]$InstallDir = 'C:\hs-sku-crawler'
)

# Check administrator privileges
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "This script must be run as Administrator."
    exit 1
}

$updateScript = Join-Path $PSScriptRoot "lib\update.js"
& node "$updateScript" --image-tag "$ImageTag" --install-dir "$InstallDir"
if ($LASTEXITCODE -ne 0) {
    Write-Error "Update script failed."
    exit 1
}
