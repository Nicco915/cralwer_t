param (
    [Parameter(Mandatory = $true)]
    [string]$Registry,

    [Parameter(Mandatory = $true)]
    [string]$ImageName,

    [string]$Tag = (git rev-parse --short HEAD)
)

$fullImage = "$Registry/$ImageName`:$Tag"
$latestImage = "$Registry/$ImageName`:latest"

$dockerfilePath = Join-Path $PSScriptRoot 'Dockerfile'
$buildContext = Split-Path -Parent $PSScriptRoot | Split-Path -Parent

Write-Host "Building $fullImage ..."
& docker build -t $fullImage -f $dockerfilePath $buildContext
if ($LASTEXITCODE -ne 0) {
    Write-Error "Docker build failed."
    exit 1
}

Write-Host "Tagging $latestImage ..."
& docker tag $fullImage $latestImage
if ($LASTEXITCODE -ne 0) {
    Write-Error "Docker tag failed."
    exit 1
}

Write-Host "Pushing $fullImage ..."
& docker push $fullImage
if ($LASTEXITCODE -ne 0) {
    Write-Error "Docker push failed for $fullImage."
    exit 1
}

Write-Host "Pushing $latestImage ..."
& docker push $latestImage
if ($LASTEXITCODE -ne 0) {
    Write-Error "Docker push failed for $latestImage."
    exit 1
}

Write-Host "Build and push completed successfully."
