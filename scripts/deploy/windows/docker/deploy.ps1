<#
.SYNOPSIS
    Windows Docker 部署脚本 —— VEVOR SKU 爬虫节点管理

.DESCRIPTION
    在 Windows 上使用 Docker Desktop 部署一个或多个爬虫容器节点。
    支持 check / start / stop / logs / status / help 子命令。

.EXAMPLE
    .\deploy.ps1 check
    .\deploy.ps1 start
    .\deploy.ps1 status
    .\deploy.ps1 logs
    .\deploy.ps1 stop
#>

param(
    [Parameter(Position = 0)]
    [string]$Command = "help"
)

# 脚本所在目录
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
# 项目根目录（脚本的上三级目录）
$ProjectDir = Resolve-Path (Join-Path $ScriptDir "..\..\..")

# ── 加载 .env 文件 ─────────────────────────────────────────────────
$EnvFile = Join-Path $ScriptDir ".env"
if (Test-Path $EnvFile) {
    Get-Content $EnvFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -match '^\s*#' -or [string]::IsNullOrWhiteSpace($line)) { return }
        if ($line -match '^(\w+)\s*=\s*(.*)$') {
            $key = $matches[1]
            $val = $matches[2].Trim()
            # 去除可能的引号
            $val = $val -replace '^["\']|["\']$'
            if (-not [Environment]::GetEnvironmentVariable($key)) {
                [Environment]::SetEnvironmentVariable($key, $val, "Process")
            }
        }
    }
    Write-Host "[deploy] 已从 .env 加载环境变量" -ForegroundColor DarkGray
}

# ── 默认值 ─────────────────────────────────────────────────────────
$NodeCount     = if ($env:CRAWLER_NODE_COUNT) { [int]$env:CRAWLER_NODE_COUNT } else { 1 }
$NodePrefix    = if ($env:CRAWLER_NODE_PREFIX) { $env:CRAWLER_NODE_PREFIX } else { "win-crawler" }
$PollInterval  = if ($env:CRAWLER_POLL_INTERVAL) { $env:CRAWLER_POLL_INTERVAL } else { "5000" }
$PollLimit     = if ($env:CRAWLER_POLL_LIMIT) { $env:CRAWLER_POLL_LIMIT } else { "5" }
$BaseUrl       = if ($env:CRAWLER_BASE_URL) { $env:CRAWLER_BASE_URL } else { "https://eur.vevor.com" }
$Headless      = if ($env:CRAWLER_HEADLESS) { $env:CRAWLER_HEADLESS } else { "true" }
$ImageDir      = "/app/output/images"

# ── 辅助函数 ───────────────────────────────────────────────────────
function Print-Usage {
    Write-Host ""
    Write-Host "VEVOR SKU 爬虫 —— Windows Docker 部署脚本" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "用法: .\deploy.ps1 <子命令>" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "子命令:"
    Write-Host "  check   检查 Docker 环境与必要环境变量"
    Write-Host "  start   启动爬虫容器节点"
    Write-Host "  stop    停止并移除爬虫容器"
    Write-Host "  logs    收集所有爬虫容器日志"
    Write-Host "  status  查看爬虫容器运行状态"
    Write-Host "  help    显示本帮助信息"
    Write-Host ""
    Write-Host "环境变量（也可写入 .env 文件）:"
    Write-Host "  CRAWLER_NODE_COUNT     节点数量（默认 1）"
    Write-Host "  CRAWLER_NODE_PREFIX    容器名前缀（默认 win-crawler）"
    Write-Host "  CRAWLER_NODE_TOKEN     上游 API 认证令牌（必填）"
    Write-Host "  CRAWLER_TASK_URL       任务拉取地址（必填）"
    Write-Host "  CRAWLER_CALLBACK_URL   结果回调地址（必填）"
    Write-Host "  CRAWLER_POLL_INTERVAL  轮询间隔（默认 5000）"
    Write-Host "  CRAWLER_POLL_LIMIT     每次轮询任务数（默认 5）"
    Write-Host "  CRAWLER_BASE_URL       目标站点（默认 https://eur.vevor.com）"
    Write-Host "  CRAWLER_HEADLESS       无头模式（默认 true）"
    Write-Host "  CRAWLER_PROXY          代理地址（可选）"
    Write-Host "  CRAWLER_BROWSER_PATH   浏览器路径（可选，容器内通常不需要）"
    Write-Host ""
}

function Test-Prerequisite {
    param([string]$Name, [scriptblock]$Test)
    Write-Host "  检查 ${Name} ... " -NoNewline
    try {
        $result = & $Test
        if ($LASTEXITCODE -eq 0 -or $result) {
            Write-Host "OK" -ForegroundColor Green
            return $true
        } else {
            Write-Host "失败" -ForegroundColor Red
            return $false
        }
    } catch {
        Write-Host "失败" -ForegroundColor Red
        return $false
    }
}

function Get-NodeCode {
    param([int]$Index)
    # 允许为每个节点单独设置环境变量，例如 CRAWLER_NODE_CODE_1=custom-01
    $individual = [Environment]::GetEnvironmentVariable("CRAWLER_NODE_CODE_${Index}")
    if ($individual) { return $individual }
    # 全局覆盖
    if ($env:CRAWLER_NODE_CODE) { return $env:CRAWLER_NODE_CODE }
    return "${NodePrefix}-${Index}"
}

function Get-MatchingContainers {
    $containers = docker ps -a --format "{{.Names}}" --filter "name=${NodePrefix}-*" 2>$null
    if ($LASTEXITCODE -ne 0) { $containers = @() }
    if ($containers -is [string]) { $containers = @($containers) }
    return $containers | Where-Object { $_ -match "^${NodePrefix}-\d+$" }
}

# ── check ──────────────────────────────────────────────────────────
function Invoke-Check {
    Write-Host ""
    Write-Host "=== 环境检查 ===" -ForegroundColor Cyan
    Write-Host ""

    $allOk = $true

    # Docker 安装
    $dockerOk = Test-Prerequisite "Docker 安装" { docker --version 2>$null }
    if (-not $dockerOk) { $allOk = $false }

    # Docker 守护进程可达
    $daemonOk = Test-Prerequisite "Docker 守护进程" { docker ps 2>$null | Out-Null; $LASTEXITCODE -eq 0 }
    if (-not $daemonOk) { $allOk = $false }

    Write-Host ""
    Write-Host "--- 必要环境变量 ---" -ForegroundColor Yellow

    $required = @("CRAWLER_TASK_URL", "CRAWLER_CALLBACK_URL", "CRAWLER_NODE_TOKEN")
    foreach ($var in $required) {
        $val = [Environment]::GetEnvironmentVariable($var)
        if ($val) {
            Write-Host "  [OK] ${var} = ${val}" -ForegroundColor Green
        } else {
            Write-Host "  [缺失] ${var}" -ForegroundColor Red
            $allOk = $false
        }
    }

    Write-Host ""
    Write-Host "--- 可选环境变量 ---" -ForegroundColor Yellow

    $optional = @("CRAWLER_PROXY", "CRAWLER_BROWSER_PATH")
    foreach ($var in $optional) {
        $val = [Environment]::GetEnvironmentVariable($var)
        if ($val) {
            Write-Host "  [已设置] ${var} = ${val}" -ForegroundColor Green
        } else {
            Write-Host "  [未设置] ${var}" -ForegroundColor DarkGray
        }
    }

    # 特别警告 CRAWLER_NODE_CODE
    if (-not $env:CRAWLER_NODE_CODE) {
        Write-Host ""
        Write-Host "  提示: CRAWLER_NODE_CODE 未设置，将默认使用 `${NodePrefix}-${序号}` 作为节点代码。" -ForegroundColor DarkYellow
    }

    Write-Host ""
    Write-Host "--- 当前配置摘要 ---" -ForegroundColor Yellow
    Write-Host "  节点数量:    ${NodeCount}"
    Write-Host "  节点前缀:    ${NodePrefix}"
    Write-Host "  轮询间隔:    ${PollInterval} ms"
    Write-Host "  轮询限制:    ${PollLimit}"
    Write-Host "  目标站点:    ${BaseUrl}"
    Write-Host "  无头模式:    ${Headless}"
    Write-Host "  项目目录:    ${ProjectDir}"

    Write-Host ""
    if ($allOk) {
        Write-Host "所有检查通过，可以执行 start。" -ForegroundColor Green
    } else {
        Write-Host "存在未通过项，请先修复后再执行 start。" -ForegroundColor Red
    }
    Write-Host ""
}

# ── start ──────────────────────────────────────────────────────────
function Invoke-Start {
    Write-Host ""
    Write-Host "=== 启动爬虫节点 ===" -ForegroundColor Cyan
    Write-Host ""

    # 验证必要变量
    $missing = @()
    foreach ($var in @("CRAWLER_TASK_URL", "CRAWLER_CALLBACK_URL", "CRAWLER_NODE_TOKEN")) {
        if (-not [Environment]::GetEnvironmentVariable($var)) { $missing += $var }
    }
    if ($missing.Count -gt 0) {
        Write-Host "错误: 缺少必要环境变量: $($missing -join ', ')" -ForegroundColor Red
        Write-Host "请设置环境变量或在 .env 文件中填写后再试。" -ForegroundColor Red
        exit 1
    }

    # 确保输出目录存在
    $outputDir = Join-Path $ProjectDir "output"
    if (-not (Test-Path $outputDir)) { New-Item -ItemType Directory -Path $outputDir | Out-Null }

    $started = @()
    for ($i = 1; $i -le $NodeCount; $i++) {
        $containerName = "${NodePrefix}-${i}"
        $nodeCode = Get-NodeCode -Index $i

        Write-Host "  启动节点 ${i}/${NodeCount}: ${containerName} (code=${nodeCode}) ..." -NoNewline

        # 构建 docker run 参数
        $dockerArgs = @(
            "run", "-d",
            "--name", $containerName,
            "--rm",
            "-v", "${ProjectDir}:/app",
            "-w", "/app",
            "-e", "CRAWLER_MODE=service",
            "-e", "CRAWLER_NODE_CODE=${nodeCode}",
            "-e", "CRAWLER_NODE_TOKEN=$env:CRAWLER_NODE_TOKEN",
            "-e", "CRAWLER_TASK_URL=$env:CRAWLER_TASK_URL",
            "-e", "CRAWLER_CALLBACK_URL=$env:CRAWLER_CALLBACK_URL",
            "-e", "CRAWLER_CHANNELS=1",
            "-e", "CRAWLER_POLL_INTERVAL=${PollInterval}",
            "-e", "CRAWLER_POLL_LIMIT=${PollLimit}",
            "-e", "CRAWLER_BASE_URL=${BaseUrl}",
            "-e", "CRAWLER_HEADLESS=${Headless}",
            "-e", "CRAWLER_IMAGE_DIR=${ImageDir}"
        )

        # 可选变量
        if ($env:CRAWLER_PROXY) {
            $dockerArgs += "-e"
            $dockerArgs += "CRAWLER_PROXY=$env:CRAWLER_PROXY"
        }
        if ($env:CRAWLER_BROWSER_PATH) {
            $dockerArgs += "-e"
            $dockerArgs += "CRAWLER_BROWSER_PATH=$env:CRAWLER_BROWSER_PATH"
        }

        $dockerArgs += "mcr.microsoft.com/playwright:v1.60.0-jammy"
        $dockerArgs += "bash"
        $dockerArgs += "-c"
        $dockerArgs += "npm ci && npm run service"

        $result = docker @dockerArgs 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Host " 成功" -ForegroundColor Green
            $started += $containerName
        } else {
            Write-Host " 失败" -ForegroundColor Red
            Write-Host "    $result" -ForegroundColor Red
        }
    }

    Write-Host ""
    Write-Host "启动完成: 共 $($started.Count) 个容器" -ForegroundColor Green
    if ($started.Count -gt 0) {
        Write-Host "  $($started -join ', ')"
    }
    Write-Host ""
    Write-Host "提示: 首次启动会执行 npm ci，可能需要几分钟。可用 .\deploy.ps1 status 查看状态。" -ForegroundColor DarkGray
    Write-Host ""
}

# ── stop ───────────────────────────────────────────────────────────
function Invoke-Stop {
    Write-Host ""
    Write-Host "=== 停止爬虫节点 ===" -ForegroundColor Cyan
    Write-Host ""

    $containers = Get-MatchingContainers
    if ($containers.Count -eq 0) {
        Write-Host "  未找到匹配 '${NodePrefix}-*' 的容器。" -ForegroundColor DarkGray
        Write-Host ""
        return
    }

    $stopped = @()
    foreach ($name in $containers) {
        Write-Host "  停止并移除 ${name} ..." -NoNewline
        docker rm -f $name 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Write-Host " 已移除" -ForegroundColor Green
            $stopped += $name
        } else {
            Write-Host " 失败" -ForegroundColor Red
        }
    }

    Write-Host ""
    Write-Host "停止完成: 共 $($stopped.Count) 个容器已移除" -ForegroundColor Green
    Write-Host ""
}

# ── logs ───────────────────────────────────────────────────────────
function Invoke-Logs {
    Write-Host ""
    Write-Host "=== 收集日志 ===" -ForegroundColor Cyan
    Write-Host ""

    $containers = Get-MatchingContainers
    if ($containers.Count -eq 0) {
        Write-Host "  未找到匹配 '${NodePrefix}-*' 的容器。" -ForegroundColor DarkGray
        Write-Host ""
        return
    }

    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $logDir = Join-Path $ProjectDir "output" "windows-docker-logs" $timestamp
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null

    foreach ($name in $containers) {
        $logFile = Join-Path $logDir "${name}.log"
        Write-Host "  收集 ${name} ..." -NoNewline
        docker logs --no-color $name > $logFile 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Host " 已保存" -ForegroundColor Green
        } else {
            Write-Host " 失败" -ForegroundColor Red
        }
    }

    Write-Host ""
    Write-Host "日志已保存到: ${logDir}" -ForegroundColor Green
    Write-Host ""
}

# ── status ─────────────────────────────────────────────────────────
function Invoke-Status {
    Write-Host ""
    Write-Host "=== 容器状态 ===" -ForegroundColor Cyan
    Write-Host ""

    $containers = Get-MatchingContainers
    if ($containers.Count -eq 0) {
        Write-Host "  未找到匹配 '${NodePrefix}-*' 的容器。" -ForegroundColor DarkGray
        Write-Host ""
        return
    }

    # 获取所有容器的状态信息
    $allInfo = docker ps -a --format "{{.Names}}|{{.Status}}|{{.State}}" --filter "name=${NodePrefix}-*" 2>$null
    if ($LASTEXITCODE -ne 0) { $allInfo = @() }
    if ($allInfo -is [string]) { $allInfo = @($allInfo) }

    foreach ($line in $allInfo) {
        $parts = $line -split '\|'
        if ($parts.Count -ge 3) {
            $name = $parts[0]
            $statusText = $parts[1]
            $state = $parts[2]
            $color = switch ($state) {
                "running" { "Green" }
                "exited"  { "Red" }
                default   { "Yellow" }
            }
            Write-Host "  ${name}: " -NoNewline
            Write-Host $statusText -ForegroundColor $color
        }
    }

    Write-Host ""
}

# ── 主入口 ─────────────────────────────────────────────────────────
switch ($Command.ToLower()) {
    "check"   { Invoke-Check }
    "start"   { Invoke-Start }
    "stop"    { Invoke-Stop }
    "logs"    { Invoke-Logs }
    "status"  { Invoke-Status }
    "help"    { Print-Usage }
    default   {
        Write-Host "未知子命令: ${Command}" -ForegroundColor Red
        Print-Usage
        exit 1
    }
}
