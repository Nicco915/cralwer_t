$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

param (
    [Parameter(Mandatory = $true)]
    [string]$Registry,

    [Parameter(Mandatory = $true)]
    [string]$ImageName,

    [string]$Tag = ''
)

if ([string]::IsNullOrWhiteSpace($Registry) -or [string]::IsNullOrWhiteSpace($ImageName) -or
    $Tag -match '[\s;|&$`<>()]' -or $Registry -match '[\s;|&$`<>()]' -or $ImageName -match '[\s;|&$`<>()]') {
    Write-Error "Registry and ImageName must be non-empty; all parameters must not contain whitespace or shell metacharacters."
    exit 1
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Error "Git is not installed. Please install Git first or provide -Tag explicitly."
    exit 1
}

if (-not $Tag) {
    try {
        $gitTag = git rev-parse --short HEAD
        if (-not $gitTag) {
            throw "git rev-parse returned empty"
        }
        $Tag = $gitTag
    } catch {
        Write-Error "Failed to determine git commit hash. Please run this script from a git repository or provide -Tag explicitly."
        exit 1
    }
}

if ($Tag -match '[\s;|&$`<>()]') {
    Write-Error "Generated tag contains invalid characters."
    exit 1
}

$fullImage = "$Registry/$ImageName`:$Tag"
$latestImage = "$Registry/$ImageName`:latest"

$dockerfilePath = Join-Path $PSScriptRoot 'Dockerfile'
$buildContext = Split-Path -Parent $PSScriptRoot | Split-Path -Parent

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Error "Docker is not installed. Please install Docker first."
    exit 1
}

Write-Host "Building $fullImage ..."
& docker build -t "$fullImage" -f "$dockerfilePath" "$buildContext"
if ($LASTEXITCODE -ne 0) {
    Write-Error "Docker build failed."
    exit 1
}

Write-Host "Tagging $latestImage ..."
& docker tag "$fullImage" "$latestImage"
if ($LASTEXITCODE -ne 0) {
    Write-Error "Docker tag failed."
    exit 1
}

Write-Host "Pushing $fullImage ..."
& docker push "$fullImage"
if ($LASTEXITCODE -ne 0) {
    Write-Error "Docker push failed for $fullImage."
    exit 1
}

Write-Host "Pushing $latestImage ..."
& docker push "$latestImage"
if ($LASTEXITCODE -ne 0) {
    Write-Error "Docker push failed for $latestImage."
    exit 1
}

Write-Host "Build and push completed successfully."
