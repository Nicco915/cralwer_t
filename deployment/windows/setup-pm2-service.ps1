#Requires -RunAsAdministrator
#Requires -Version 5.1

# Windows 服务实际注册名是 pm2.exe，显示名为 PM2
$script:Pm2ServiceName = 'pm2.exe'

# ==================== Helper Functions ====================

function Test-NpmPrefixInUserProfile {
    $prefix = & npm config get prefix 2>$null
    if (-not $prefix) {
        Write-Warning "Could not determine npm prefix."
        return $false
    }
    $normalized = $prefix -replace '/', '\'
    if ($normalized -match '^C:\\Users\\') {
        Write-Warning "npm global prefix is in a user profile: $prefix"
        Write-Warning "NT AUTHORITY\LOCAL SERVICE cannot access this path."
        return $true
    }
    return $false
}

function Repair-NpmPrefix {
    $globalModules = & npm root -g 2>$null
    if (-not $globalModules) {
        Write-Error "Failed to get global npm root."
        exit 1
    }
    $installerDir = Join-Path $globalModules "pm2-installer"
    if (-not (Test-Path $installerDir)) {
        Write-Error "pm2-installer not found at $installerDir. Cannot auto-repair npm prefix."
        exit 1
    }
    $packageJson = Join-Path $installerDir "package.json"
    if (-not (Test-Path $packageJson)) {
        Write-Error "pm2-installer package.json not found at $packageJson."
        exit 1
    }
    Write-Host "Running npm run configure in pm2-installer to move global prefix to C:\ProgramData\npm..."
    $originalDir = Get-Location
    Set-Location $installerDir
    try {
        & npm run configure
        if ($LASTEXITCODE -ne 0) {
            Write-Error "npm run configure failed with exit code $LASTEXITCODE."
            Write-Host "Please run it manually:"
            Write-Host "  cd '$installerDir'"
            Write-Host "  npm run configure"
            exit 1
        }
    } finally {
        Set-Location $originalDir
    }
    Write-Host "npm prefix repaired. You may need to restart your PowerShell session for PATH changes to take effect."
}

function Grant-LocalServicePermission {
    param([string]$TargetPath)
    if (-not (Test-Path $TargetPath)) {
        Write-Warning "Path does not exist, skipping ACL: $TargetPath"
        return
    }
    Write-Host "Granting NT AUTHORITY\LOCAL SERVICE read/execute/modify permission to: $TargetPath"
    try {
        & icacls "$TargetPath" /grant "NT AUTHORITY\LOCAL SERVICE:(OI)(CI)M" /T /C /Q
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "icacls returned exit code $LASTEXITCODE for $TargetPath"
        }
    } catch {
        Write-Warning "Failed to set ACL on ${TargetPath}: $_"
    }
}

function Test-Pm2HomePermissions {
    $pm2Home = "C:\ProgramData\pm2\home"
    if (-not (Test-Path $pm2Home)) {
        return $false
    }
    try {
        $acl = Get-Acl $pm2Home
        $localService = New-Object System.Security.Principal.SecurityIdentifier "S-1-5-19"
        foreach ($access in $acl.Access) {
            $sid = $null
            if ($access.IdentityReference -is [System.Security.Principal.SecurityIdentifier]) {
                $sid = $access.IdentityReference
            } else {
                try { $sid = $access.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]) } catch { }
            }
            if ($sid -and $sid.Value -eq $localService.Value) {
                $rights = $access.FileSystemRights
                if (($rights -band [System.Security.AccessControl.FileSystemRights]::Modify) -eq [System.Security.AccessControl.FileSystemRights]::Modify) {
                    return $true
                }
            }
        }
    } catch {
        Write-Warning "Could not read ACL for ${pm2Home}: $_"
    }
    return $false
}

function Repair-Pm2HomePermissions {
    $pm2Home = "C:\ProgramData\pm2\home"
    if (-not (Test-Path $pm2Home)) {
        New-Item -ItemType Directory -Path $pm2Home -Force | Out-Null
    }
    Write-Host "Repairing PM2_HOME permissions for LOCAL SERVICE and administrators..."

    # 先取得所有权，确保后续 ACL 修改不会失败
    & takeown /F "$pm2Home" /A /R /D Y | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "takeown returned exit code $LASTEXITCODE for $pm2Home"
    }

    # 禁用继承，避免父目录权限变化影响服务运行
    # 同时保留现有显式权限（否则 pm2-installer 的 SetAccessRule 可能只保留 LOCAL SERVICE）
    & icacls "$pm2Home" /inheritance:r /T /C /Q
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "icacls /inheritance:r returned exit code $LASTEXITCODE for $pm2Home"
    }

    # 授予 LOCAL SERVICE 完全控制（PM2 服务运行所需）
    & icacls "$pm2Home" /grant "NT AUTHORITY\LOCAL SERVICE:(OI)(CI)F" /T /C /Q
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "icacls for LOCAL SERVICE returned exit code $LASTEXITCODE for $pm2Home"
    }

    # 授予 Administrators 完全控制（运维排查所需）
    & icacls "$pm2Home" /grant "Administrators:(OI)(CI)F" /T /C /Q
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "icacls for Administrators returned exit code $LASTEXITCODE for $pm2Home"
    }

    # 授予当前用户完全控制（当前会话执行 pm2 命令所需）
    $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    if ($currentUser -and ($currentUser -ne '\')) {
        & icacls "$pm2Home" /grant "${currentUser}:(OI)(CI)F" /T /C /Q
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "icacls for current user returned exit code $LASTEXITCODE for $pm2Home"
        }
    }
}

function Wait-ServiceStatus {
    param(
        [string]$ServiceName = $script:Pm2ServiceName,
        [string]$TargetStatus = "Running",
        [int]$TimeoutSeconds = 60,
        [int]$PollIntervalSeconds = 3
    )
    $elapsed = 0
    while ($elapsed -lt $TimeoutSeconds) {
        $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if (-not $svc) {
            Write-Warning "Service $ServiceName not found."
            return $false
        }
        if ($svc.Status -eq $TargetStatus) {
            return $true
        }
        Write-Host "Waiting for service $ServiceName to reach $TargetStatus... (current: $($svc.Status))"
        Start-Sleep -Seconds $PollIntervalSeconds
        $elapsed += $PollIntervalSeconds
    }
    return $false
}

function Get-Pm2EventLogErrors {
    param([int]$MaxEvents = 10)
    try {
        $events = Get-WinEvent -FilterHashtable @{LogName='Application'; Level=1,2} -MaxEvents 100 -ErrorAction SilentlyContinue |
            Where-Object { $_.Message -like '*pm2*' -or $_.Message -like '*PM2*' -or $_.ProviderName -like '*PM2*' } |
            Select-Object -First $MaxEvents
        if ($events) {
            Write-Host "--- Recent Windows Event Log errors mentioning PM2 ---"
            foreach ($evt in $events) {
                Write-Host "[$($evt.TimeCreated)] [$($evt.ProviderName)] $($evt.Message)"
            }
        } else {
            Write-Host "No recent Windows Event Log entries mentioning PM2."
        }
    } catch {
        Write-Warning "Could not retrieve Windows Event Log entries: $_"
    }
}

function Get-Pm2ServiceLog {
    $pm2Home = "C:\ProgramData\pm2\home"
    $logPaths = @(
        (Join-Path $pm2Home "logs\pm2.log"),
        (Join-Path $pm2Home "pm2.log"),
        "C:\ProgramData\pm2\pm2.log"
    )
    foreach ($logPath in $logPaths) {
        if (Test-Path $logPath) {
            Write-Host "--- PM2 Log: $logPath ---"
            Get-Content $logPath -Tail 30 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
            return
        }
    }
    Write-Host "No PM2 log file found at expected locations."
}

function Get-ProjectRootFromScriptRoot {
    $dir = $PSScriptRoot
    while ($dir) {
        if ((Test-Path (Join-Path $dir ".env")) -or (Test-Path (Join-Path $dir "package.json"))) {
            return $dir
        }
        $parent = Split-Path $dir -Parent
        if ($parent -eq $dir) { break }
        $dir = $parent
    }
    return $null
}

function Write-Pm2ServiceDiagnostics {
    Write-Host ""
    Write-Host "=== PM2 Service Diagnostics ==="
    Get-Pm2EventLogErrors
    Get-Pm2ServiceLog
    Write-Host ""
    Write-Host "=== Troubleshooting commands ==="
    Write-Host "  Get-Service pm2.exe"
    Write-Host "  Get-Service -DisplayName 'PM2'"
    Write-Host "  Get-WinEvent -FilterHashtable @{LogName='Application'; Level=1,2} -MaxEvents 50 | Where-Object { `$_.Message -like '*pm2*' }"
    Write-Host "  pm2 list"
    Write-Host "  pm2 logs"
    Write-Host ""
    Write-Host "=== Common causes ==="
    Write-Host "  - npm global prefix is in user profile and LOCAL SERVICE cannot access it"
    Write-Host "  - Project directory lacks read/execute/modify permission for LOCAL SERVICE"
    Write-Host "  - PM2_HOME directory (C:\ProgramData\pm2\home) lacks write permission for LOCAL SERVICE"
    Write-Host "  - Windows 11 24H2+ removed WMIC (wmic.exe), which PM2 5.x requires"
    Write-Host "    Install it with: DISM /Online /Add-Capability /CapabilityName:WMIC~~~~"
    Write-Host "  - pm2 process list is empty or crawler process is missing"
}

function Test-WmicAvailable {
    $wmic = Get-Command wmic -ErrorAction SilentlyContinue
    if ($wmic) {
        return $true
    }
    # Windows 11 24H2 默认移除了 wmic，PM2 的 pidusage 仍依赖它
    Write-Warning "WMIC (wmic.exe) is not available on this system."
    Write-Warning "PM2 5.x uses pidusage which calls wmic; without it the PM2 service may become unstable or stop."
    return $false
}

function Install-WmicCapability {
    Write-Host "Attempting to install WMIC optional capability via DISM..."
    & DISM /Online /Add-Capability /CapabilityName:WMIC~~~~ /NoRestart
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "DISM failed to install WMIC. You may need to install it manually."
        return $false
    }
    $wmic = Get-Command wmic -ErrorAction SilentlyContinue
    if (-not $wmic) {
        Write-Warning "WMIC still not found after DISM install. A reboot may be required."
        return $false
    }
    Write-Host "WMIC installed successfully."
    return $true
}

# ==================== Pre-flight Checks ====================

Write-Host "=== PM2 Windows Service Pre-flight Checks ==="

if (-not (Test-WmicAvailable)) {
    $installed = Install-WmicCapability
    if (-not $installed) {
        Write-Warning "Please install WMIC manually and reboot if necessary:"
        Write-Warning "  DISM /Online /Add-Capability /CapabilityName:WMIC~~~~"
        Write-Warning "Then re-run this script."
    }
} else {
    Write-Host "WMIC check passed."
}

if (Test-NpmPrefixInUserProfile) {
    Write-Host "npm prefix is in user profile. Attempting auto-repair..."
    Repair-NpmPrefix
} else {
    Write-Host "npm prefix check passed."
}

$projectDir = Get-ProjectRootFromScriptRoot
if ($projectDir) {
    Grant-LocalServicePermission -TargetPath $projectDir
} else {
    Write-Warning "Could not locate project root for ACL grant."
}

if (-not (Test-Pm2HomePermissions)) {
    Repair-Pm2HomePermissions
} else {
    Write-Host "PM2_HOME permissions check passed."
}

Write-Host "=== Pre-flight checks completed ==="
Write-Host ""

# ==================== Original Setup Flow ====================

# 检查 npm 是否存在
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Error "npm not found. Please install Node.js first."
    exit 1
}

# 检查 pm2 是否存在
if (-not (Get-Command pm2 -ErrorAction SilentlyContinue)) {
    Write-Error "pm2 not found. Please run deploy.ps1 first to install dependencies."
    exit 1
}

# 获取全局 node_modules 路径
$globalModules = & npm root -g 2>$null
if (-not $globalModules) {
    Write-Error "Failed to get global npm root."
    exit 1
}

$installerDir = Join-Path $globalModules "pm2-installer"

# 检查 pm2-installer 是否已安装
if (-not (Test-Path $installerDir)) {
    Write-Host "pm2-installer not found. Cloning from GitHub..."
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        Write-Error "git not found. Please install Git first."
        exit 1
    }
    git clone https://github.com/jessety/pm2-installer.git "$installerDir"
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to clone pm2-installer from GitHub."
        exit 1
    }
}

# 运行 pm2-installer 的 Windows 服务安装脚本
# 注意：setup.ps1 内部使用相对路径，必须从 $installerDir 目录执行
$installScript = Join-Path $installerDir "src\windows\setup.ps1"
if (-not (Test-Path $installScript)) {
    Write-Error "pm2-installer setup script not found at: $installScript"
    exit 1
}

Write-Host "Running pm2-installer Windows service setup..."
$originalDir = Get-Location
Set-Location $installerDir
try {
    & $installScript
    if ($LASTEXITCODE -ne 0) {
        Write-Error "pm2-installer failed with exit code $LASTEXITCODE"
        Write-Pm2ServiceDiagnostics
        exit 1
    }
} finally {
    Set-Location $originalDir
}

# pm2-installer 将 PM2_HOME 设置为 C:\ProgramData\pm2\home，当前会话需要同步
$Env:PM2_HOME = "C:\ProgramData\pm2\home"

# 保存当前 PM2 进程列表，确保开机自启时恢复
Write-Host "Checking PM2 process list..."
$pm2ListOutput = & pm2 jlist 2>$null
$pm2List = $null
if ($pm2ListOutput) {
    try {
        $pm2List = $pm2ListOutput | ConvertFrom-Json
    } catch {
        Write-Warning "Could not parse pm2 jlist output as JSON. Assuming process check is not available in this session."
    }
}

if ($pm2List) {
    $crawler = $pm2List | Where-Object { $_.name -eq 'crawler' }
    if (-not $crawler) {
        Write-Error "No crawler process found in PM2. Please run deploy.ps1 first."
        exit 1
    }
} else {
    Write-Warning "Skipping crawler process verification due to PM2 session transition."
}

Write-Host "Saving PM2 process list..."
& pm2 save
if ($LASTEXITCODE -ne 0) {
    Write-Error "pm2 save failed."
    exit 1
}

# ==================== Post-install Verification ====================

Write-Host "Verifying PM2 Windows service status..."
$serviceOk = Wait-ServiceStatus -ServiceName $script:Pm2ServiceName -TargetStatus "Running" -TimeoutSeconds 60
if ($serviceOk) {
    Write-Host "PM2 Windows service is Running."
} else {
    Write-Error "PM2 service failed to reach Running state within 60 seconds."
    Write-Pm2ServiceDiagnostics
    exit 1
}
