#Requires -RunAsAdministrator
param (
    [Parameter(Mandatory = $true)]
    [string]$RepoUrl,

    [string]$Branch = 'main',

    [string]$InstallDir = 'C:\hs-sku-crawler'
)

function Install-IfMissing {
    param([string]$Command, [string]$Name)
    if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
        Write-Host "Installing $Name..."
        if (Get-Command winget -ErrorAction SilentlyContinue) {
            winget install --accept-package-agreements --accept-source-agreements $Name
        } else {
            Write-Error "winget not available. Please install $Name manually."
            exit 1
        }
    }
}

# Check administrator privileges
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "This script must be run as Administrator."
    exit 1
}

Install-IfMissing -Command "node" -Name "OpenJS.NodeJS.LTS"
Install-IfMissing -Command "git" -Name "Git.Git"

# Ensure pm2 is installed globally
if (-not (Get-Command pm2 -ErrorAction SilentlyContinue)) {
    Write-Host "Installing pm2..."
    npm install -g pm2
}

$deployScript = Join-Path $PSScriptRoot "lib\deploy.js"
& node "$deployScript" --repo-url "$RepoUrl" --branch "$Branch" --install-dir "$InstallDir"
if ($LASTEXITCODE -ne 0) {
    Write-Error "Deploy script failed."
    exit 1
}

$setupServiceScript = Join-Path $PSScriptRoot "setup-pm2-service.ps1"
if (Test-Path $setupServiceScript) {
    & $setupServiceScript
} else {
    Write-Warning "setup-pm2-service.ps1 not found. Skipping service setup."
}
