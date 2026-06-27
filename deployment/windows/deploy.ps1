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
    if ($LASTEXITCODE -ne 0) {
        Write-Error "setup-pm2-service.ps1 failed. See diagnostics above."
        Write-Host ""
        Write-Host "=== Post-failure diagnostics ==="
        Write-Host "Check Windows Event Log for PM2 errors:"
        Write-Host "  Get-WinEvent -FilterHashtable @{LogName='Application'; Level=1,2} -MaxEvents 50 | Where-Object { `$_.Message -like '*pm2*' }"
        Write-Host "Check PM2 process list:"
        Write-Host "  `$Env:PM2_HOME = 'C:\ProgramData\pm2\home'"
        Write-Host "  pm2 list"
        Write-Host "Check PM2 logs:"
        Write-Host "  pm2 logs"
        Write-Host "Check service status:"
        Write-Host "  Get-Service pm2.exe"
        Write-Host "  Get-Service -DisplayName 'PM2'"
        Write-Host ""
        Write-Host "=== Common fixes ==="
        Write-Host "  1. Run 'npm run configure' in the pm2-installer directory"
        Write-Host "  2. Ensure NT AUTHORITY\LOCAL SERVICE has read/execute/modify permission to $InstallDir"
        Write-Host "  3. Ensure PM2_HOME (C:\ProgramData\pm2\home) is writable by NT AUTHORITY\LOCAL SERVICE"
        exit 1
    }
    Write-Host ""
    Write-Host "=== Deployment Summary ==="
    try {
        $svc = Get-Service -Name "pm2.exe" -ErrorAction SilentlyContinue
        if ($svc) {
            Write-Host "PM2 Service Status: $($svc.Status)"
        } else {
            Write-Warning "PM2 service not found."
        }
    } catch {
        Write-Warning "Could not query PM2 service status: $_"
    }
} else {
    Write-Warning "setup-pm2-service.ps1 not found. Skipping service setup."
}
