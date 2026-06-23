<#
.SYNOPSIS
    Windows 原生部署脚本 —— VEVOR SKU 爬虫节点管理（无 Docker）

.DESCRIPTION
    在 Windows 上直接以原生 node 进程方式部署一个或多个爬虫节点。
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
$NodePrefix    = if ($env:CRAWLER_NODE_PREFIX) { $env:CRAWLER_NODE_PREFIX } else { "win-native-crawler" }
$PollInterval  = if ($env:CRAWLER_POLL_INTERVAL) { $env:CRAWLER_POLL_INTERVAL } else { "5000" }
$PollLimit     = if ($env:CRAWLER_POLL_LIMIT) { $env:CRAWLER_POLL_LIMIT } else { "5" }
$BaseUrl       = if ($env:CRAWLER_BASE_URL) { $env:CRAWLER_BASE_URL } else { "https://eur.vevor.com" }
$Headless      = if ($env:CRAWLER_HEADLESS) { $env:CRAWLER_HEADLESS } else { "true" }

# ── 辅助函数 ───────────────────────────────────────────────────────
function Print-Usage {
    Write-Host ""
    Write-Host "VEVOR SKU 爬虫 —— Windows 原生部署脚本" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "用法: .\deploy.ps1 <子命令>" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "子命令:"
    Write-Host "  check   检查 Node.js 环境、依赖、Playwright 与必要环境变量"
    Write-Host "  start   启动爬虫后台进程节点"
    Write-Host "  stop    停止所有匹配前缀的爬虫进程"
    Write-Host "  logs    显示或收集日志"
    Write-Host "  status  查看爬虫进程运行状态"
    Write-Host "  help    显示本帮助信息"
    Write-Host ""
    Write-Host "环境变量（也可写入 .env 文件）:"
    Write-Host "  CRAWLER_NODE_COUNT     节点数量（默认 1）"
    Write-Host "  CRAWLER_NODE_PREFIX    节点名前缀（默认 win-native-crawler）"
    Write-Host "  CRAWLER_NODE_TOKEN     上游 API 认证令牌（必填）"
    Write-Host "  CRAWLER_TASK_URL       任务拉取地址（必填）"
    Write-Host "  CRAWLER_CALLBACK_URL   结果回调地址（必填）"
    Write-Host "  CRAWLER_POLL_INTERVAL  轮询间隔（默认 5000）"
    Write-Host "  CRAWLER_POLL_LIMIT     每次轮询任务数（默认 5）"
    Write-Host "  CRAWLER_BASE_URL       目标站点（默认 https://eur.vevor.com）"
    Write-Host "  CRAWLER_HEADLESS       无头模式（默认 true）"
    Write-Host "  CRAWLER_PROXY          代理地址（可选）"
    Write-Host "  CRAWLER_BROWSER_PATH   浏览器路径（可选）"
    Write-Host ""
}

function Test-Prerequisite {
    param([string]$Name, [scriptblock]$Test)
    Write-Host "  检查 ${Name} ... " -NoNewline
    try {
        $result = & $Test 2>$null
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

function Get-MatchingProcesses {
    # 查找命令行包含 bin/run.js --mode service 且 CRAWLER_NODE_CODE 匹配前缀的 node 进程
    $processes = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
        $_.CommandLine -match 'bin/run\.js\s+--mode\s+service'
    }
    $matched = @()
    foreach ($proc in $processes) {
        # 尝试从环境变量块提取 CRAWLER_NODE_CODE
        $nodeCode = $null
        if ($proc.EnvironmentVariables) {
            $envVars = $proc.EnvironmentVariables
            if ($envVars -is [System.Collections.IDictionary]) {
                $nodeCode = $envVars['CRAWLER_NODE_CODE']
            } elseif ($envVars -is [string]) {
                # 某些系统返回字符串形式，尝试正则提取
                if ($envVars -match 'CRAWLER_NODE_CODE=([^\s;]*)') {
                    $nodeCode = $matches[1]
                }
            }
        }
        # 备选：从命令行参数推断（如果环境变量不可读）
        if (-not $nodeCode) {
            # 如果进程命令行包含前缀，则视为匹配
            if ($proc.CommandLine -match [regex]::Escape($NodePrefix)) {
                $nodeCode = "${NodePrefix}-?"
            }
        }
        # 过滤：只保留匹配 ${NodePrefix}-* 的
        if ($nodeCode -and $nodeCode -match "^${NodePrefix}-") {
            $matched += [PSCustomObject]@{
                PID = $proc.ProcessId
                NodeCode = $nodeCode
                CommandLine = $proc.CommandLine
            }
        }
    }
    return $matched
}

# ── check ──────────────────────────────────────────────────────────
function Invoke-Check {
    Write-Host ""
    Write-Host "=== 环境检查 ===" -ForegroundColor Cyan
    Write-Host ""

    $allOk = $true

    # Node.js 安装
    $nodeOk = Test-Prerequisite "Node.js" { node --version }
    if (-not $nodeOk) { $allOk = $false }

    # npm 安装
    $npmOk = Test-Prerequisite "npm" { npm --version }
    if (-not $npmOk) { $allOk = $false }

    # 项目依赖
    Write-Host "  检查 node_modules ... " -NoNewline
    $nodeModulesDir = Join-Path $ProjectDir "node_modules"
    if (Test-Path $nodeModulesDir) {
        Write-Host "OK" -ForegroundColor Green
    } else {
        Write-Host "未找到" -ForegroundColor Red
        Write-Host "    警告: 项目依赖未安装。请运行 'npm ci' 后再试。" -ForegroundColor DarkYellow
        $allOk = $false
    }

    # Playwright 浏览器
    Write-Host "  检查 Playwright 浏览器 ... " -NoNewline
    try {
        $npxResult = npx playwright --version 2>$null
        if ($LASTEXITCODE -eq 0) {
            # 尝试检查 chromium 是否已安装
            $chromiumDir = Join-Path $ProjectDir "node_modules" "playwright" ".local-browsers"
            $hasChromium = $false
            if (Test-Path $chromiumDir) {
                $chromiumPaths = Get-ChildItem -Path $chromiumDir -Directory -Filter "chromium*" -ErrorAction SilentlyContinue
                if ($chromiumPaths) { $hasChromium = $true }
            }
            # 备选：检查用户目录
            $userDataDir = Join-Path $env:LOCALAPPDATA "ms-playwright"
            if (-not $hasChromium -and (Test-Path $userDataDir)) {
                $chromiumPaths = Get-ChildItem -Path $userDataDir -Directory -Filter "chromium*" -ErrorAction SilentlyContinue
                if ($chromiumPaths) { $hasChromium = $true }
            }
            if ($hasChromium) {
                Write-Host "OK" -ForegroundColor Green
            } else {
                Write-Host "未安装" -ForegroundColor DarkYellow
                Write-Host "    警告: Playwright Chromium 未安装。可运行 'npx playwright install chromium' 安装，或使用系统浏览器（设置 CRAWLER_BROWSER_PATH）。" -ForegroundColor DarkYellow
            }
        } else {
            Write-Host "npx 不可用" -ForegroundColor DarkYellow
            Write-Host "    警告: 无法通过 npx 检查 Playwright。请确保 Playwright 浏览器已安装或配置 CRAWLER_BROWSER_PATH 使用系统浏览器。" -ForegroundColor DarkYellow
        }
    } catch {
        Write-Host "检查失败" -ForegroundColor DarkYellow
        Write-Host "    警告: 无法验证 Playwright 浏览器状态。" -ForegroundColor DarkYellow
    }

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
        exit 1
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

    # 确保日志输出目录存在
    $logDir = Join-Path $ProjectDir "output" "windows-native-logs"
    if (-not (Test-Path $logDir)) {
        New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    }

    $started = @()
    for ($i = 1; $i -le $NodeCount; $i++) {
        $nodeCode = Get-NodeCode -Index $i
        $logFile = Join-Path $logDir "${nodeCode}.log"

        Write-Host "  启动节点 ${i}/${NodeCount}: ${nodeCode} ..." -NoNewline

        # 构建环境变量哈希表
        $envVars = @{
            CRAWLER_MODE = "service"
            CRAWLER_NODE_CODE = $nodeCode
            CRAWLER_NODE_TOKEN = $env:CRAWLER_NODE_TOKEN
            CRAWLER_TASK_URL = $env:CRAWLER_TASK_URL
            CRAWLER_CALLBACK_URL = $env:CRAWLER_CALLBACK_URL
            CRAWLER_CHANNELS = "1"
            CRAWLER_POLL_INTERVAL = $PollInterval
            CRAWLER_POLL_LIMIT = $PollLimit
            CRAWLER_BASE_URL = $BaseUrl
            CRAWLER_HEADLESS = $Headless
        }
        if ($env:CRAWLER_PROXY) { $envVars['CRAWLER_PROXY'] = $env:CRAWLER_PROXY }
        if ($env:CRAWLER_BROWSER_PATH) { $envVars['CRAWLER_BROWSER_PATH'] = $env:CRAWLER_BROWSER_PATH }

        # 使用 cmd.exe /c 启动后台进程，将 stdout/stderr 合并重定向到日志文件
        # 注意：cmd.exe 中 " 表示字面量引号，用于处理含空格的路径
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = "cmd.exe"
        $cmdInner = 'node bin/run.js --mode service > ""' + $logFile + '"" 2>&1'
        $psi.Arguments = '/c "' + $cmdInner + '"'
        $psi.WorkingDirectory = $ProjectDir
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true

        # 设置环境变量（继承当前进程并覆盖），使用 ContainsKey/Add 模式保证健壮性
        foreach ($key in $envVars.Keys) {
            if ($psi.EnvironmentVariables.ContainsKey($key)) {
                $psi.EnvironmentVariables[$key] = $envVars[$key]
            } else {
                $psi.EnvironmentVariables.Add($key, $envVars[$key])
            }
        }

        $process = New-Object System.Diagnostics.Process
        $process.StartInfo = $psi

        # 启动进程并检查存活状态
        $startedOk = $process.Start()
        if ($startedOk) {
            $alive = $false
            for ($j = 0; $j -lt 5; $j++) {
                Start-Sleep -Milliseconds 300
                $p = Get-Process -Id $process.Id -ErrorAction SilentlyContinue
                if ($p) { $alive = $true; break }
            }
            if (-not $alive) {
                Write-Host " 失败 (进程启动后立即退出)" -ForegroundColor Red
                if (Test-Path $logFile) {
                    Write-Host "  日志最后 10 行:" -ForegroundColor DarkGray
                    Get-Content $logFile -Tail 10 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
                }
                continue
            }
            Write-Host " 成功 (PID=$($process.Id))" -ForegroundColor Green
            $started += [PSCustomObject]@{
                PID = $process.Id
                NodeCode = $nodeCode
                LogFile = $logFile
            }
        } else {
            Write-Host " 失败" -ForegroundColor Red
        }
    }

    Write-Host ""
    Write-Host "启动完成: 共 $($started.Count) 个节点" -ForegroundColor Green
    foreach ($s in $started) {
        Write-Host "  PID=$($s.PID), NodeCode=$($s.NodeCode), Log=$($s.LogFile)"
    }
    Write-Host ""
    Write-Host "提示: 可用 .\deploy.ps1 status 查看状态，.\deploy.ps1 logs 查看日志。" -ForegroundColor DarkGray
    Write-Host ""
}

# ── stop ───────────────────────────────────────────────────────────
function Invoke-Stop {
    Write-Host ""
    Write-Host "=== 停止爬虫节点 ===" -ForegroundColor Cyan
    Write-Host ""

    $processes = Get-MatchingProcesses
    if ($processes.Count -eq 0) {
        Write-Host "  未找到匹配 '${NodePrefix}-*' 的爬虫进程。" -ForegroundColor DarkGray
        Write-Host ""
        return
    }

    $stopped = @()
    foreach ($proc in $processes) {
        $pid = $proc.PID
        Write-Host "  停止 PID=${pid} ($($proc.NodeCode)) ..." -NoNewline

        # 尝试优雅关闭：taskkill /PID /T 发送终止信号到进程树
        $taskkillResult = taskkill /PID ([int]$pid) /T 2>&1
        $taskkillExit = $LASTEXITCODE
        if ($taskkillExit -ne 0 -and $taskkillExit -ne 128) {
            Write-Host " 警告: taskkill 返回退出码 ${taskkillExit}" -ForegroundColor DarkYellow
        }

        # 等待最多 5 秒
        $waited = 0
        $maxWait = 5000
        $interval = 200
        $stillRunning = $true
        while ($waited -lt $maxWait) {
            Start-Sleep -Milliseconds $interval
            $waited += $interval
            try {
                $testProc = Get-Process -Id $pid -ErrorAction SilentlyContinue
                if (-not $testProc) {
                    $stillRunning = $false
                    break
                }
            } catch {
                $stillRunning = $false
                break
            }
        }

        if (-not $stillRunning) {
            Write-Host " 已停止" -ForegroundColor Green
            $stopped += $proc
        } else {
            # 强制终止前验证 PID 未被复用
            $target = Get-Process -Id $pid -ErrorAction SilentlyContinue
            if ($target -and $target.ProcessName -eq "node") {
                try {
                    Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
                    Write-Host " 已强制终止" -ForegroundColor DarkYellow
                    $stopped += $proc
                } catch {
                    Write-Host " 强制终止失败" -ForegroundColor Red
                }
            } else {
                Write-Host " 进程已不存在或 PID 已被复用" -ForegroundColor DarkYellow
            }
        }
    }

    Write-Host ""
    Write-Host "停止完成: 共 $($stopped.Count) 个进程已停止" -ForegroundColor Green
    Write-Host ""
}

# ── logs ───────────────────────────────────────────────────────────
function Invoke-Logs {
    Write-Host ""
    Write-Host "=== 日志信息 ===" -ForegroundColor Cyan
    Write-Host ""

    $logDir = Join-Path $ProjectDir "output" "windows-native-logs"
    if (-not (Test-Path $logDir)) {
        Write-Host "  日志目录不存在: ${logDir}" -ForegroundColor DarkGray
        Write-Host ""
        return
    }

    # 查找匹配前缀的日志文件
    $logFiles = Get-ChildItem -Path $logDir -Filter "${NodePrefix}-*.log" -ErrorAction SilentlyContinue
    if ($logFiles.Count -eq 0) {
        Write-Host "  未找到匹配 '${NodePrefix}-*.log' 的日志文件。" -ForegroundColor DarkGray
        Write-Host ""
        return
    }

    Write-Host "日志文件路径:" -ForegroundColor Yellow
    foreach ($file in $logFiles) {
        Write-Host "  $($file.FullName) ($($file.Length) bytes)"
    }

    Write-Host ""
    Write-Host "最近 50 行日志摘要:" -ForegroundColor Yellow
    foreach ($file in $logFiles) {
        Write-Host ""
        Write-Host "--- $($file.Name) ---" -ForegroundColor Cyan
        $lines = Get-Content $file.FullName -Tail 50
        if ($lines) {
            $lines | ForEach-Object { Write-Host "  $_" }
        } else {
            Write-Host "  (空文件)" -ForegroundColor DarkGray
        }
    }

    Write-Host ""
}

# ── status ─────────────────────────────────────────────────────────
function Invoke-Status {
    Write-Host ""
    Write-Host "=== 进程状态 ===" -ForegroundColor Cyan
    Write-Host ""

    $runningProcs = Get-MatchingProcesses
    $foundAny = $false

    for ($i = 1; $i -le $NodeCount; $i++) {
        $nodeCode = Get-NodeCode -Index $i
        $proc = $runningProcs | Where-Object { $_.NodeCode -eq $nodeCode } | Select-Object -First 1
        if ($proc) {
            try {
                $p = Get-Process -Id $proc.PID -ErrorAction SilentlyContinue
                if ($p) {
                    Write-Host "  ${nodeCode}: " -NoNewline
                    Write-Host "运行中 (PID=$($proc.PID))" -ForegroundColor Green
                    $foundAny = $true
                } else {
                    Write-Host "  ${nodeCode}: " -NoNewline
                    Write-Host "已停止" -ForegroundColor Red
                    $foundAny = $true
                }
            } catch {
                Write-Host "  ${nodeCode}: " -NoNewline
                Write-Host "已停止" -ForegroundColor Red
                $foundAny = $true
            }
        } else {
            Write-Host "  ${nodeCode}: " -NoNewline
            Write-Host "已停止" -ForegroundColor Red
            $foundAny = $true
        }
    }

    if (-not $foundAny) {
        Write-Host "  未找到匹配 '${NodePrefix}-*' 的爬虫进程。" -ForegroundColor DarkGray
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
