#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

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

if ($ImageTag -match '[\s;|&$`<>()]') {
    Write-Error "ImageTag must not contain whitespace or shell metacharacters."
    exit 1
}

if ($InstallDir -match '[\s;|&$`<>()]' -or -not [System.IO.Path]::IsPathRooted($InstallDir)) {
    Write-Error "InstallDir must be an absolute path and must not contain whitespace or shell metacharacters."
    exit 1
}

$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js is not installed. Please install Node.js first."
    exit 1
}

$updateScript = Join-Path $PSScriptRoot "lib\update.js"
& node "$updateScript" --image-tag "$ImageTag" --install-dir "$InstallDir"
if ($LASTEXITCODE -ne 0) {
    Write-Error "Update script failed."
    exit 1
}
