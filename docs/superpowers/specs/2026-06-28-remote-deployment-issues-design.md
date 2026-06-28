# 异地 Windows 部署问题修复方案

> 日期：2026-06-28  
> 问题：在异地（新 Windows 机器）执行 `deploy.ps1` 时遇到 PATH 未刷新、WMIC 安装失败、PM2_HOME 权限、PowerShell 执行策略、`.env` 缺失等一系列问题。

---

## 1. 已发现的问题清单

| 序号 | 问题现象 | 根因 |
|------|----------|------|
| 1 | `npm`/`node` 命令找不到 | winget 安装 Node.js 后，当前 PowerShell 会话的 `Path` 环境变量未刷新 |
| 2 | `npm.ps1 cannot be loaded because running scripts is disabled` | PowerShell 执行策略为 `Restricted`，禁止运行 `.ps1` 脚本 |
| 3 | `pm2` 命令找不到 | `npm install -g pm2` 后，`C:\ProgramData\npm` 未加入系统 `Path` |
| 4 | `DISM failed to install WMIC` | Windows 11 24H2 移除了 WMIC，异地机器无法连接 Windows Update/WSUS 下载可选组件 |
| 5 | `Access is denied` 在 `C:\ProgramData\pm2\home` | pm2-installer 把目录权限只留给 `LOCAL SERVICE`，当前管理员失去访问权 |
| 6 | crawler 状态 `errored` / `stopped` | 项目根目录缺少 `.env` 文件，`bin/run.js` 启动失败 |
| 7 | 日志目录 `logs/` 为空或不存在 | deploy.js 未执行（因为 deploy.ps1 提前失败），未自动创建 `logs/` |

---

## 2. 当前手动解决方法

按顺序在**管理员 PowerShell** 中执行：

### 2.1 设置执行策略

```powershell
Set-ExecutionPolicy RemoteSigned -Scope LocalMachine -Force
```

### 2.2 刷新 PATH

```powershell
$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
node --version
npm --version
```

### 2.3 修正 npm 全局前缀并安装 pm2

```powershell
npm config set prefix "C:\ProgramData\npm"
npm config set cache "C:\ProgramData\npm\npm-cache"
npm install -g pm2

# 把 C:\ProgramData\npm 加入系统 PATH
[Environment]::SetEnvironmentVariable("Path", $env:Path + ";C:\ProgramData\npm", "Machine")
$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
pm2 --version
```

### 2.4 修复 PM2_HOME 权限

```powershell
$pm2Home = "C:\ProgramData\pm2\home"
takeown /F "$pm2Home" /A /R /D Y
icacls "$pm2Home" /grant "Administrators:(OI)(CI)F" /T /C /Q
icacls "$pm2Home" /grant "NT AUTHORITY\LOCAL SERVICE:(OI)(CI)F" /T /C /Q
```

### 2.5 放置 `.env` 文件并创建 `logs/` 目录

```powershell
# 手动复制 .env 到项目根目录
Copy-Item "你的\.env路径" "C:\hs-sku-crawler\.env"

# 创建日志目录
New-Item -ItemType Directory -Path "C:\hs-sku-crawler\logs" -Force
```

### 2.6 启动 crawler

```powershell
$Env:PM2_HOME = "C:\ProgramData\pm2\home"
cd C:\hs-sku-crawler
pm2 delete crawler
pm2 start "C:\hs-sku-crawler\deployment\windows\ecosystem.config.js"
pm2 save
pm2 list
```

### 2.7 注册 Windows 服务

#### 方案 A：WMIC 可用时（推荐）

```powershell
DISM /Online /Add-Capability /CapabilityName:WMIC~~~~
# 重启后
C:\hs-sku-crawler\deployment\windows\setup-pm2-service.ps1
```

#### 方案 B：WMIC 不可用时（异地内网兜底）

下载 [NSSM](https://nssm.cc/download)，把 `nssm.exe` 放到 PATH 中，然后：

```powershell
nssm install PM2 "C:\ProgramData\npm\pm2.cmd"
nssm set PM2 AppDirectory "C:\hs-sku-crawler"
nssm set PM2 AppParameters "start C:\hs-sku-crawler\deployment\windows\ecosystem.config.js"
nssm set PM2 ObjectName "NT AUTHORITY\LocalService"
nssm start PM2
```

---

## 3. 代码修改方案

### 3.1 `deployment/windows/deploy.ps1`

#### 3.1.1 自动设置 PowerShell 执行策略

在管理员权限检查之后、安装 Node.js 之前：

```powershell
$execPolicy = Get-ExecutionPolicy -Scope LocalMachine
if ($execPolicy -in @('Restricted', 'AllSigned')) {
    Write-Host "Setting PowerShell execution policy to RemoteSigned..."
    Set-ExecutionPolicy RemoteSigned -Scope LocalMachine -Force
}
```

#### 3.1.2 winget 安装 Node.js 后刷新 PATH

```powershell
function Update-EnvironmentPath {
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
}

Install-IfMissing -Command "node" -Name "OpenJS.NodeJS.LTS"
Update-EnvironmentPath
```

#### 3.1.3 安装 pm2 后把 `C:\ProgramData\npm` 加入 PATH

```powershell
if (-not (Get-Command pm2 -ErrorAction SilentlyContinue)) {
    Write-Host "Installing pm2..."
    npm install -g pm2
    Update-EnvironmentPath
    if ($env:Path -notlike "*C:\ProgramData\npm*") {
        [Environment]::SetEnvironmentVariable("Path", $env:Path + ";C:\ProgramData\npm", "Machine")
        Update-EnvironmentPath
    }
}
```

### 3.2 `deployment/windows/setup-pm2-service.ps1`

#### 3.2.1 刷新 PATH

脚本开头刷新 PATH，确保 `npm`、`pm2` 可被找到：

```powershell
$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
```

#### 3.2.2 改进 WMIC 安装逻辑

```powershell
function Test-WmicAvailable { /* ... */ }

function Install-WmicCapability {
    & DISM /Online /Add-Capability /CapabilityName:WMIC~~~~ /NoRestart
    return ($LASTEXITCODE -eq 0) -and (Get-Command wmic -ErrorAction SilentlyContinue)
}

if (-not (Test-WmicAvailable)) {
    if (-not (Install-WmicCapability)) {
        Write-Warning "WMIC could not be installed automatically. Will fall back to NSSM for service registration."
        $script:UseNssmFallback = $true
    }
}
```

#### 3.2.3 WMIC 失败时使用 NSSM 注册服务

新增 `Register-Pm2ServiceWithNssm` 函数：

```powershell
function Register-Pm2ServiceWithNssm {
    $nssm = Get-Command nssm -ErrorAction SilentlyContinue
    if (-not $nssm) {
        Write-Error "nssm.exe not found in PATH. Please download NSSM and add it to PATH, or install WMIC manually."
        exit 1
    }
    $pm2Cmd = Join-Path (npm config get prefix) "pm2.cmd"
    & nssm install PM2 "$pm2Cmd"
    & nssm set PM2 AppDirectory $projectDir
    & nssm set PM2 AppParameters "start `"$projectDir\deployment\windows\ecosystem.config.js`""
    & nssm set PM2 ObjectName "NT AUTHORITY\LocalService"
    & nssm start PM2
}
```

#### 3.2.4 修复 `Repair-Pm2HomePermissions` 中当前用户获取方式

把：

```powershell
$currentUser = "$env:USERDOMAIN\$env:USERNAME"
```

改为：

```powershell
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
```

#### 3.2.5 修复 PM2_HOME 权限时机

在 pm2-installer 运行**之前**就执行 `Repair-Pm2HomePermissions`，避免 pm2-installer 的 `SetAccessRule` 把管理员权限覆盖掉。

### 3.3 `bin/run.js`（或 `src/cli.js`）

#### 3.3.1 启动前明确检查 `.env`

在 `cli.js` 加载 `.env` 后：

```javascript
const envPath = path.join(process.cwd(), '.env');
if (!fs.existsSync(envPath)) {
  console.error(`[FATAL] .env file not found at ${envPath}`);
  console.error('Please create it before starting the crawler.');
  process.exit(1);
}
```

### 3.4 `deployment/windows/lib/deploy.js`

#### 3.4.1 确保 `logs/` 目录存在

当前代码已经有 `ensureDir(path.join(installDir, 'logs'))`，无需修改。但需要确保 deploy.js 能被成功调用。

---

## 4. 验证步骤

1. 在新机器上以管理员身份运行改进后的 `deploy.ps1`
2. 确认 `node --version`、`npm --version`、`pm2 --version` 都可用
3. 确认 `C:\hs-sku-crawler\.env` 存在
4. 确认 `C:\hs-sku-crawler\logs` 已创建
5. 执行 `Get-Service pm2.exe` 或 `Get-Service PM2`，状态应为 `Running`
6. 执行 `pm2 list`，`crawler` 状态应为 `online`

---

## 5. 风险与缓解

| 风险 | 缓解 |
|------|------|
| NSSM 未安装导致降级失败 | 脚本检测不到 nssm 时给出明确下载链接和手动命令 |
| 修改 LocalMachine 执行策略有安全争议 | 该脚本只在部署时使用，且已要求管理员权限 |
| `C:\ProgramData\npm` 已存在其他内容 | 使用 `npm config set prefix` 前先做备份提示 |
| WMIC 未来完全移除 | 长期方案是升级到 PM2 6.x 或迁移到 NSSM/Winsw |

---

## 6. 待办

- [ ] 修改 `deploy.ps1`：执行策略、PATH 刷新、npm PATH 注册
- [ ] 修改 `setup-pm2-service.ps1`：WMIC 检测/安装/降级、权限修复
- [ ] 修改 `src/cli.js`：`.env` 缺失明确报错
- [ ] 新增/更新测试
- [ ] 在真实异地环境验证
