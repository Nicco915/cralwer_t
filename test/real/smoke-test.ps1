#Requires -Version 5.1
<#
.SYNOPSIS
    Real API Smoke Test Script (PowerShell)
    Starts the crawler in service mode against real upstream API and VEVOR site.
    Captures logs, waits for tasks to complete, outputs summary.

.DESCRIPTION
    This script is the Windows equivalent of smoke-test.sh.
    It loads environment variables from .env, starts the crawler service,
    monitors logs, and reports statistics.

.EXAMPLE
    .\smoke-test.ps1

.EXAMPLE
    $env:SMOKE_TIMEOUT_SECONDS = 600; .\smoke-test.ps1
#>

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ProjectDir = Resolve-Path (Join-Path $ScriptDir "..\..")

# Load .env file if present
$EnvFile = Join-Path $ProjectDir ".env"
if (Test-Path $EnvFile) {
    Get-Content $EnvFile | ForEach-Object {
        $line = $_.Trim()
        if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith("#")) { return }
        $idx = $line.IndexOf("=")
        if ($idx -lt 0) { return }
        $key = $line.Substring(0, $idx).Trim()
        $value = $line.Substring($idx + 1).Trim()
        # Remove surrounding quotes
        if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
            ($value.StartsWith("'") -and $value.EndsWith("'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        if (-not [Environment]::GetEnvironmentVariable($key)) {
            [Environment]::SetEnvironmentVariable($key, $value, "Process")
        }
    }
}

# Defaults
$SmokeTimeoutSeconds = if ($env:SMOKE_TIMEOUT_SECONDS) { [int]$env:SMOKE_TIMEOUT_SECONDS } else { 300 }
$SmokeMinSuccess = if ($env:SMOKE_MIN_SUCCESS) { [int]$env:SMOKE_MIN_SUCCESS } else { 1 }
$SmokeLogFile = if ($env:SMOKE_LOG_FILE) { $env:SMOKE_LOG_FILE } else { Join-Path $ProjectDir "test\real\smoke-test.log" }

# Ensure log directory exists
$LogDir = Split-Path -Parent $SmokeLogFile
if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

Write-Host "========================================"
Write-Host "  Real API Smoke Test (PowerShell)"
Write-Host "========================================"
Write-Host "  Project:  $ProjectDir"
Write-Host "  Log file: $SmokeLogFile"
Write-Host "  Timeout:  ${SmokeTimeoutSeconds}s"
Write-Host "  Min success: $SmokeMinSuccess"
Write-Host ""

# Validate required env vars
if (-not $env:CRAWLER_NODE_CODE) {
    Write-Host "ERROR: CRAWLER_NODE_CODE is not set. Copy test/real/.env.example to .env and configure." -ForegroundColor Red
    exit 1
}

if (-not $env:CRAWLER_NODE_TOKEN) {
    Write-Host "ERROR: CRAWLER_NODE_TOKEN is not set. Copy test/real/.env.example to .env and configure." -ForegroundColor Red
    exit 1
}

# Check node_modules
$NodeModules = Join-Path $ProjectDir "node_modules"
if (-not (Test-Path $NodeModules)) {
    Write-Host "Installing dependencies..."
    Set-Location $ProjectDir
    npm ci | Out-String | Write-Host
}

# Check Playwright browsers (optional, don't fail)
Write-Host "Checking Playwright browsers..."
try {
    npx playwright install chromium 2>&1 | Out-Null
} catch {
    Write-Host "WARNING: Playwright browser installation may have failed. Continuing..." -ForegroundColor Yellow
}

Write-Host "Starting crawler service mode (logging to $SmokeLogFile)..."
Write-Host ""

# Start service in background, redirect output to log file
$ServiceProcess = Start-Process -FilePath "node" `
    -ArgumentList "bin/run.js", "--mode", "service" `
    -WorkingDirectory $ProjectDir `
    -RedirectStandardOutput $SmokeLogFile `
    -RedirectStandardError $SmokeLogFile `
    -WindowStyle Hidden `
    -PassThru

# Ensure cleanup on exit
$Cleanup = {
    if ($ServiceProcess -and -not $ServiceProcess.HasExited) {
        Write-Host ""
        Write-Host "Sending SIGTERM to crawler service (PID $($ServiceProcess.Id))..."
        Stop-Process -Id $ServiceProcess.Id -Force -ErrorAction SilentlyContinue
    }
}
Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action $Cleanup | Out-Null

# Wait for service startup
$StartTime = Get-Date
$StartupTimeout = 30

while ($true) {
    if (Test-Path $SmokeLogFile) {
        $LogContent = Get-Content $SmokeLogFile -Raw -ErrorAction SilentlyContinue
        if ($LogContent -and $LogContent.Contains("Starting crawler service")) {
            Write-Host "Service started successfully."
            break
        }
    }

    if ($ServiceProcess.HasExited) {
        Write-Host "ERROR: Service process exited before startup." -ForegroundColor Red
        exit 1
    }

    $Elapsed = ((Get-Date) - $StartTime).TotalSeconds
    if ($Elapsed -ge $StartupTimeout) {
        Write-Host "ERROR: Service startup timed out after ${StartupTimeout}s." -ForegroundColor Red
        exit 1
    }

    Start-Sleep -Seconds 1
}

Write-Host "Waiting for tasks to complete (timeout: ${SmokeTimeoutSeconds}s)..."
Write-Host ""

# Wait loop
while ($true) {
    if ($ServiceProcess.HasExited) {
        Write-Host "Service process exited."
        break
    }

    $LogContent = Get-Content $SmokeLogFile -Raw -ErrorAction SilentlyContinue
    if (-not $LogContent) { $LogContent = "" }

    $Started = ([regex]::Matches($LogContent, "start task")).Count
    $Success = ([regex]::Matches($LogContent, "done task .* status success")).Count
    $ErrorCount = ([regex]::Matches($LogContent, "done task .* status error")).Count
    $NotFound = ([regex]::Matches($LogContent, "done task .* status not_found")).Count
    $Completed = $Success + $ErrorCount + $NotFound

    $Elapsed = [int]((Get-Date) - $StartTime).TotalSeconds

    # Print progress on same line
    $Progress = "  Elapsed: {0,3:D}s | Started: {1,2:D} | Completed: {2,2:D} (success={3,2:D} error={4,2:D} not_found={5,2:D})" -f `
        $Elapsed, $Started, $Completed, $Success, $ErrorCount, $NotFound
    Write-Host "`r$Progress" -NoNewline

    if ($Completed -ge $Started -and $Started -gt 0) {
        Write-Host ""
        Write-Host "All started tasks have completed."
        break
    }

    if ($Elapsed -ge $SmokeTimeoutSeconds) {
        Write-Host ""
        Write-Host "WARNING: Reached timeout (${SmokeTimeoutSeconds}s). Stopping service." -ForegroundColor Yellow
        break
    }

    Start-Sleep -Seconds 2
}

Write-Host ""
Write-Host "========================================"
Write-Host "  Smoke Test Summary"
Write-Host "========================================"

# Final counts from log
$LogContent = Get-Content $SmokeLogFile -Raw -ErrorAction SilentlyContinue
if (-not $LogContent) { $LogContent = "" }

$Started = ([regex]::Matches($LogContent, "start task")).Count
$Success = ([regex]::Matches($LogContent, "done task .* status success")).Count
$ErrorCount = ([regex]::Matches($LogContent, "done task .* status error")).Count
$NotFound = ([regex]::Matches($LogContent, "done task .* status not_found")).Count
$Completed = $Success + $ErrorCount + $NotFound

$Shutdown = if ($LogContent.Contains("Shutdown complete")) { "yes" } else { "no" }

Write-Host "  Service started: yes"
Write-Host "  Service shutdown: $Shutdown"
Write-Host "  Tasks started:   $Started"
Write-Host "  Tasks completed: $Completed"
Write-Host "    - success:    $Success"
Write-Host "    - error:      $ErrorCount"
Write-Host "    - not_found:  $NotFound"
Write-Host ""

# Validation
$Pass = $true

if ($Started -eq 0) {
    Write-Host "FAIL: No tasks were started. The upstream API may have no tasks." -ForegroundColor Red
    $Pass = $false
}

if ($Completed -lt $Started) {
    Write-Host "WARNING: Completed tasks ($Completed) < started tasks ($Started)." -ForegroundColor Yellow
    Write-Host "         Some tasks may still be in progress or were interrupted."
}

if ($Success -lt $SmokeMinSuccess) {
    Write-Host "FAIL: Success count ($Success) < minimum required ($SmokeMinSuccess)." -ForegroundColor Red
    $Pass = $false
}

Write-Host ""
if ($Pass) {
    Write-Host "RESULT: PASS" -ForegroundColor Green
    exit 0
} else {
    Write-Host "RESULT: FAIL" -ForegroundColor Red
    exit 1
}
