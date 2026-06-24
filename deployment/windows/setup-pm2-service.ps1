#Requires -RunAsAdministrator

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

Write-Host "PM2 Windows service registered successfully."
