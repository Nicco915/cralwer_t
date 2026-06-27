#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

param (
    [Parameter(Mandatory = $true)]
    [string]$ImageTag,

    [string]$InstallDir = 'C:\hs-sku-crawler',

    [string]$Registry = 'registry.example.com',

    [string]$ImageName = 'hs-sku-crawler'
)

# Check administrator privileges
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "This script must be run as Administrator."
    exit 1
}

# Check Docker is installed
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Error "Docker is not installed. Please install Docker first."
    exit 1
}

# Validate inputs
if ([string]::IsNullOrWhiteSpace($ImageTag) -or [string]::IsNullOrWhiteSpace($Registry) -or [string]::IsNullOrWhiteSpace($ImageName) -or
    $ImageTag -match '[\s;|&$`<>()]' -or $Registry -match '[\s;|&$`<>()]' -or $ImageName -match '[\s;|&$`<>()]') {
    Write-Error "Registry, ImageName and ImageTag must be non-empty and must not contain whitespace or shell metacharacters."
    exit 1
}

if ($InstallDir -match '[\s;|&$`<>()]' -or -not [System.IO.Path]::IsPathRooted($InstallDir)) {
    Write-Error "InstallDir must be an absolute path and must not contain whitespace or shell metacharacters."
    exit 1
}

$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)

# Check Docker Compose is available
try {
    $null = & docker compose version 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw "docker compose version failed"
    }
} catch {
    Write-Error "Docker Compose is not available. Please install Docker Compose."
    exit 1
}

# Create install directory and subdirectories
$subdirs = @('logs', 'output', 'images')
foreach ($subdir in $subdirs) {
    $dirPath = Join-Path $InstallDir $subdir
    if (-not (Test-Path $dirPath)) {
        New-Item -ItemType Directory -Path $dirPath -Force | Out-Null
    }
}

# Check .env exists
$envPath = Join-Path $InstallDir '.env'
if (-not (Test-Path $envPath)) {
    Write-Error ".env not found at $envPath. Please place it before deploying."
    exit 1
}

# Copy docker-compose.yml if not exists
$composeSource = Join-Path $PSScriptRoot 'docker-compose.yml'
$composeDest = Join-Path $InstallDir 'docker-compose.yml'
if (-not (Test-Path $composeDest)) {
    if (Test-Path $composeSource) {
        Copy-Item -Path $composeSource -Destination $composeDest -Force
    } else {
        Write-Error "docker-compose.yml not found at $composeSource"
        exit 1
    }
}

# Construct full image name
$fullImage = "$Registry/$ImageName`:$ImageTag"

# Call deploy.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js is not installed. Please install Node.js first."
    exit 1
}

$deployScript = Join-Path $PSScriptRoot "lib\deploy.js"
& node "$deployScript" --image "$fullImage" --install-dir "$InstallDir"
if ($LASTEXITCODE -ne 0) {
    Write-Error "Deploy script failed."
    exit 1
}
