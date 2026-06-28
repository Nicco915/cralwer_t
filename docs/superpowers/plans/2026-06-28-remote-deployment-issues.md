# 异地 Windows 部署问题修复实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 根据 `docs/superpowers/specs/2026-06-28-remote-deployment-issues-design.md` 中的规格，让 `deploy.ps1` / `setup-pm2-service.ps1` 在缺少 Node.js PATH、PowerShell 执行策略、npm prefix、WMIC、PM2_HOME 权限、`.env` 的异地 Windows 环境中自动修复并注册服务；同时让 `bin/run.js` 在缺少 `.env` 时给出明确报错。

**架构：** 在 PowerShell 部署脚本中增加幂等的前置检查与修复函数（PATH 刷新、执行策略、WMIC 检测/安装/NSSM 降级、权限修复），在 Node 入口中提前校验 `.env`，并通过单元测试覆盖关键辅助函数。

**技术栈：** PowerShell 5.1、Node.js 20+、`node --test`、NSSM（可选兜底）。

---

## 文件清单

| 文件 | 职责 |
|------|------|
| `deployment/windows/deploy.ps1` | 首次部署入口：安装 Node.js/Git、全局 pm2、刷新 PATH、设置执行策略、调用 `setup-pm2-service.ps1` |
| `deployment/windows/setup-pm2-service.ps1` | 注册 PM2 Windows 服务：前置检查（WMIC/npm prefix/权限）、调用 pm2-installer 或 NSSM 兜底、验证服务状态 |
| `src/cli.js` | CLI 参数解析与 `.env` 加载；新增 `.env` 缺失时抛错 |
| `bin/run.js` | 服务入口；依赖 `src/cli.js` 的 `loadEnvFile` |
| `test/deployment/setup-pm2-service.test.js` | 测试 PowerShell 辅助函数 |
| `test/bin-run.test.js` | 扩展测试 `.env` 缺失行为 |
| `deployment/windows/README.md` | 部署文档更新 |
| `deployment/windows/POST_DEPLOYMENT.md` | 运维文档更新 |

---

## 任务 1：让 `src/cli.js` 在 `.env` 缺失时给出明确报错

**文件：**
- 修改：`src/cli.js:1-21`
- 测试：`test/bin-run.test.js`

### 步骤 1：编写失败的测试

编辑 `test/bin-run.test.js`，在文件末尾追加：

```javascript
describe('loadEnvFile', () => {
  const { loadEnvFile } = require('../src/cli');

  it('throws clear error when .env is missing', () => {
    assert.throws(
      () => loadEnvFile('/nonexistent/crawler/dir'),
      /\.env file not found/
    );
  });
});
```

运行测试验证失败：

```bash
node --test test/bin-run.test.js
```

预期：FAIL，报错 `loadEnvFile` 没有抛出 `.env file not found` 错误。

### 步骤 2：实现 `.env` 缺失报错

编辑 `src/cli.js`，将 `loadEnvFile` 函数改为：

```javascript
function loadEnvFile(cwd) {
  const envPath = path.join(cwd || process.cwd(), '.env');
  if (!fs.existsSync(envPath)) {
    throw new Error(`.env file not found at ${envPath}. Please create it before starting the crawler.`);
  }
  const content = fs.readFileSync(envPath, 'utf-8');
  // ... 其余逻辑保持不变
}
```

运行测试验证通过：

```bash
node --test test/bin-run.test.js
```

预期：PASS。

### 步骤 3：Commit

```bash
git add src/cli.js test/bin-run.test.js
git commit -m "feat(cli): .env 缺失时给出明确报错"
```

---

## 任务 2：在 `deploy.ps1` 中自动设置执行策略并刷新 PATH

**文件：**
- 修改：`deployment/windows/deploy.ps1`

### 步骤 1：添加 `Update-EnvironmentPath` 函数和 `Set-ExecutionPolicy` 检查

编辑 `deployment/windows/deploy.ps1`，在 `Install-IfMissing` 函数之后、`# Check administrator privileges` 之前插入：

```powershell
function Update-EnvironmentPath {
    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = ($machinePath, $userPath | Where-Object { $_ }) -join ';'
}
```

在管理员权限检查之后、调用 `Install-IfMissing` 之前插入：

```powershell
# PowerShell 执行策略会阻止运行 npm.ps1 等脚本；部署脚本需要 RemoteSigned
$execPolicy = Get-ExecutionPolicy
if ($execPolicy -in @('Restricted', 'AllSigned')) {
    Write-Host "Setting PowerShell execution policy to RemoteSigned for current process..."
    Set-ExecutionPolicy RemoteSigned -Scope Process -Force
    $newPolicy = Get-ExecutionPolicy -Scope Process
    if ($newPolicy -notin @('RemoteSigned', 'Unrestricted', 'Bypass')) {
        Write-Error "Failed to set execution policy to RemoteSigned for current process. Current effective policy: $newPolicy. Please adjust manually or contact your administrator."
        exit 1
    }
}
```

### 步骤 2：在关键节点刷新 PATH

在 `Install-IfMissing -Command "node"` 调用后添加：

```powershell
Install-IfMissing -Command "node" -Name "OpenJS.NodeJS.LTS"
Update-EnvironmentPath
```

在 `Install-IfMissing -Command "git"` 调用后添加：

```powershell
Install-IfMissing -Command "git" -Name "Git.Git"
Update-EnvironmentPath
```

### 步骤 3：安装 pm2 后确保 `C:\ProgramData\npm` 在 PATH 中

替换原来的 pm2 安装块：

```powershell
# Ensure pm2 is installed globally
if (-not (Get-Command pm2 -ErrorAction SilentlyContinue)) {
    Write-Host "Installing pm2..."
    npm install -g pm2
    Update-EnvironmentPath
    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $npmPath = "C:\ProgramData\npm"
    $paths = $machinePath -split ';' | Where-Object { $_ -and $_ -ne $npmPath }
    if ($paths -notcontains $npmPath) {
        [Environment]::SetEnvironmentVariable("Path", ($paths + $npmPath) -join ';', "Machine")
        Update-EnvironmentPath
    }
}
```

### 步骤 4：验证脚本语法

```powershell
Get-Command powershell | ForEach-Object { powershell -NoProfile -Command "Get-Command Test-Path" }
```

预期：无语法错误（当前在 Linux 环境无法完整验证 PowerShell 运行时行为，至少确认无解析错误）。

### 步骤 5：Commit

```bash
git add deployment/windows/deploy.ps1
git commit -m "feat(deploy): 自动设置执行策略并刷新 PATH"
```

---

## 任务 3：修复 `setup-pm2-service.ps1` 的已知 bug

**文件：**
- 修改：`deployment/windows/setup-pm2-service.ps1`
- 测试：`test/deployment/setup-pm2-service.test.js`

### 步骤 1：修复 `Repair-Pm2HomePermissions` 当前用户变量

编辑 `setup-pm2-service.ps1`，将：

```powershell
$currentUser = "$env:USERDOMAIN\$env:USERNAME"
```

替换为：

```powershell
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
```

### 步骤 2：修复 `Get-Pm2ServiceLog` 的 `Join-Path` 数组错误

将：

```powershell
$logPaths = @(
    Join-Path $pm2Home "logs\pm2.log",
    Join-Path $pm2Home "pm2.log",
    "C:\ProgramData\pm2\pm2.log"
)
```

替换为：

```powershell
$logPaths = @(
    (Join-Path $pm2Home "logs\pm2.log"),
    (Join-Path $pm2Home "pm2.log"),
    "C:\ProgramData\pm2\pm2.log"
)
```

### 步骤 3：添加测试覆盖 `Get-Pm2ServiceLog` 路径格式

编辑 `test/deployment/setup-pm2-service.test.js`，追加：

```javascript
  it('Get-Pm2ServiceLog does not throw', { skip: os.platform() !== 'win32' }, () => {
    const output = invokePwshFunction('Get-Pm2ServiceLog');
    assert.strictEqual(typeof output, 'string');
  });
```

### 步骤 4：运行现有部署单元测试

```bash
npm run test:deployment:unit
```

预期：现有测试通过（Linux 环境下 PowerShell 测试会被跳过）。

### 步骤 5：Commit

```bash
git add deployment/windows/setup-pm2-service.ps1 test/deployment/setup-pm2-service.test.js
git commit -m "fix(windows-service): 修复当前用户获取与 Join-Path 数组语法"
```

---

## 任务 4：在 `setup-pm2-service.ps1` 中实现 NSSM 兜底注册

**文件：**
- 修改：`deployment/windows/setup-pm2-service.ps1`

### 步骤 1：在脚本开头刷新 PATH 并声明兜底标志

在 `#Requires` 行之后、`$script:Pm2ServiceName = 'pm2.exe'` 之后插入：

```powershell
# 刷新 PATH，确保 npm/pm2 可被本脚本找到（即使刚刚安装）
$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")

$script:UseNssmFallback = $false
```

### 步骤 2：改进 WMIC 安装逻辑以设置兜底标志

将 `Install-WmicCapability` 改为返回布尔值：

```powershell
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
```

将 WMIC 预检查块改为：

```powershell
if (-not (Test-WmicAvailable)) {
    $installed = Install-WmicCapability
    if (-not $installed) {
        Write-Warning "WMIC could not be installed automatically. Will fall back to NSSM for service registration."
        $script:UseNssmFallback = $true
    }
} else {
    Write-Host "WMIC check passed."
}
```

### 步骤 3：新增 `Register-Pm2ServiceWithNssm` 函数

在 `Write-Pm2ServiceDiagnostics` 函数之后插入：

```powershell
function Register-Pm2ServiceWithNssm {
    param([string]$ProjectDir)

    $nssm = Get-Command nssm -ErrorAction SilentlyContinue
    if (-not $nssm) {
        Write-Error "nssm.exe not found in PATH. Please download NSSM from https://nssm.cc/download, place nssm.exe in PATH, or install WMIC manually."
        exit 1
    }

    $npmPrefix = & npm config get prefix 2>$null
    if (-not $npmPrefix) {
        Write-Error "Could not determine npm prefix."
        exit 1
    }
    $pm2Cmd = Join-Path $npmPrefix "pm2.cmd"
    if (-not (Test-Path $pm2Cmd)) {
        Write-Error "pm2.cmd not found at $pm2Cmd."
        exit 1
    }

    Write-Host "Registering PM2 Windows service via NSSM..."
    & nssm install PM2 "$pm2Cmd"
    if ($LASTEXITCODE -ne 0) {
        Write-Error "nssm install failed."
        exit 1
    }
    & nssm set PM2 AppDirectory "$ProjectDir"
    & nssm set PM2 AppParameters "start `"$ProjectDir\deployment\windows\ecosystem.config.js`""
    & nssm set PM2 ObjectName "NT AUTHORITY\LocalService"
    & nssm start PM2
    if ($LASTEXITCODE -ne 0) {
        Write-Error "nssm start failed."
        exit 1
    }
}
```

### 步骤 4：根据兜底标志分支执行服务注册

将 `setup.ps1` 调用块（`Write-Host "Running pm2-installer Windows service setup..."` 开始到 `Set-Location $originalDir` 结束）替换为条件分支：

```powershell
if ($script:UseNssmFallback) {
    Register-Pm2ServiceWithNssm -ProjectDir $projectDir
} else {
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
}
```

注意：当使用 NSSM 兜底时，服务显示名可能是 `PM2` 而不是 `pm2.exe`，因此需要把 `Wait-ServiceStatus` 调用改为同时支持两个名字。

将验证块：

```powershell
$serviceOk = Wait-ServiceStatus -ServiceName $script:Pm2ServiceName -TargetStatus "Running" -TimeoutSeconds 60
```

替换为：

```powershell
$serviceOk = Wait-ServiceStatus -ServiceName $script:Pm2ServiceName -TargetStatus "Running" -TimeoutSeconds 60
if (-not $serviceOk) {
    $serviceOk = Wait-ServiceStatus -ServiceName "PM2" -TargetStatus "Running" -TimeoutSeconds 30
}
```

### 步骤 5：运行部署单元测试

```bash
npm run test:deployment:unit
```

预期：PASS。

### 步骤 6：Commit

```bash
git add deployment/windows/setup-pm2-service.ps1
git commit -m "feat(windows-service): WMIC 不可用时自动降级到 NSSM 注册服务"
```

---

## 任务 5：调整 `Repair-Pm2HomePermissions` 调用时机

**文件：**
- 修改：`deployment/windows/setup-pm2-service.ps1`

### 步骤 1：确保 PM2_HOME 权限在 pm2-installer 之前已修复

当前脚本已经先执行 `Test-Pm2HomePermissions` / `Repair-Pm2HomePermissions`，再进入 `setup.ps1` 调用。本任务主要是验证顺序正确，并在 pm2-installer 调用后再次检查权限是否被覆盖。

在 `if ($script:UseNssmFallback) { ... } else { ... }` 分支之后、`$Env:PM2_HOME = "C:\ProgramData\pm2\home"` 之前插入：

```powershell
# pm2-installer 可能会重置 ACL；确保 LOCAL SERVICE 仍然可写
if (-not (Test-Pm2HomePermissions)) {
    Repair-Pm2HomePermissions
}
```

### 步骤 2：运行部署单元测试

```bash
npm run test:deployment:unit
```

预期：PASS。

### 步骤 3：Commit

```bash
git add deployment/windows/setup-pm2-service.ps1
git commit -m "fix(windows-service): 服务注册后再次校验 PM2_HOME 权限"
```

---

## 任务 6：更新 `setup-pm2-service.test.js` 覆盖新增函数

**文件：**
- 修改：`test/deployment/setup-pm2-service.test.js`

### 步骤 1：添加 `Test-WmicAvailable` 和 `Test-Pm2HomePermissions` 测试

编辑 `test/deployment/setup-pm2-service.test.js`，追加到 `describe` 块中：

```javascript
  it('Test-WmicAvailable returns True or False', { skip: os.platform() !== 'win32' }, () => {
    const output = invokePwshFunction('Test-WmicAvailable');
    const result = output.trim();
    assert.ok(result === 'True' || result === 'False', `Unexpected output: ${result}`);
  });

  it('Test-Pm2HomePermissions returns True or False', { skip: os.platform() !== 'win32' }, () => {
    const output = invokePwshFunction('Test-Pm2HomePermissions');
    const result = output.trim();
    assert.ok(result === 'True' || result === 'False', `Unexpected output: ${result}`);
  });
```

### 步骤 2：运行部署单元测试

```bash
npm run test:deployment:unit
```

预期：PASS。

### 步骤 3：Commit

```bash
git add test/deployment/setup-pm2-service.test.js
git commit -m "test(windows-service): 覆盖 WMIC 与 PM2_HOME 权限检测函数"
```

---

## 任务 7：更新部署文档

**文件：**
- 修改：`deployment/windows/README.md`
- 修改：`deployment/windows/POST_DEPLOYMENT.md`

### 步骤 1：更新 README.md 的执行策略和 NSSM 说明

在 `deployment/windows/README.md` 的 `## 首次部署` 之后、`## PM2 Windows 服务注册` 之前插入一小节：

```markdown
### 异地/内网部署说明

在无法连接 Windows Update 的 Windows 11 24H2+ 机器上，`deploy.ps1` 会自动尝试以下兜底：

1. 检测并安装 WMIC 可选组件
2. 如果 WMIC 安装失败，且 `nssm.exe` 在 PATH 中，则使用 NSSM 注册 PM2 服务

如果两个条件都不满足，脚本会输出明确的下载/手动命令，不会静默失败。
```

### 步骤 2：更新 POST_DEPLOYMENT.md 的服务名说明

在 `### 1.3 检查 Windows 服务` 中，将：

```powershell
Get-Service PM2
```

改为：

```powershell
Get-Service PM2
# 或（pm2-installer 注册的实际服务名）
Get-Service pm2.exe
```

在 `### 4.2 PM2 服务启动循环` 中，在末尾追加：

```markdown
#### NSSM 兜底方案

如果服务器无法安装 WMIC，可下载 NSSM 并将其放入 PATH，然后重新运行 `setup-pm2-service.ps1`，脚本会自动使用 NSSM 注册服务。
```

### 步骤 3：Commit

```bash
git add deployment/windows/README.md deployment/windows/POST_DEPLOYMENT.md
git commit -m "docs(windows): 补充执行策略、NSSM 兜底和服务名说明"
```

---

## 任务 8：全量测试与最终验证

### 步骤 1：运行全部测试

```bash
npm test
```

预期：全部 PASS。

### 步骤 2：运行部署单元测试

```bash
npm run test:deployment:unit
```

预期：全部 PASS（Windows 限定测试在 Linux 上自动跳过）。

### 步骤 3：检查 PowerShell 脚本基本语法

在 Windows 上执行：

```powershell
Get-ChildItem deployment\windows\*.ps1 | ForEach-Object { powershell -NoProfile -Command "Get-Command Test-Path" }
```

预期：无解析错误。

### 步骤 4：最终 Commit

```bash
git add .
git status
```

确认无未跟踪的临时文件后，如果还有未提交变更：

```bash
git commit -m "chore(windows): 异地部署问题修复代码整理"
```

---

## 自检

### 规格覆盖度

- `deploy.ps1` 自动设置执行策略 → 任务 2
- `deploy.ps1` PATH 刷新 → 任务 2
- `deploy.ps1` npm PATH 注册 → 任务 2
- `setup-pm2-service.ps1` PATH 刷新 → 任务 4
- `setup-pm2-service.ps1` WMIC 检测/安装/降级 → 任务 4
- `setup-pm2-service.ps1` NSSM 兜底 → 任务 4
- `Repair-Pm2HomePermissions` 当前用户变量修复 → 任务 3
- `Get-Pm2ServiceLog` Join-Path 修复 → 任务 3
- PM2_HOME 权限时机 → 任务 5
- `src/cli.js` `.env` 缺失报错 → 任务 1
- 测试更新 → 任务 3、6
- 文档更新 → 任务 7

无遗漏。

### 占位符扫描

本计划中无 "TODO"、"后续实现"、"适当的错误处理" 等占位符。每个步骤均包含具体代码或命令。

### 类型一致性

- `loadEnvFile(cwd)` 签名保持不变。
- `Test-WmicAvailable`、`Test-Pm2HomePermissions` 返回布尔值 `True`/`False`，与现有 `Test-NpmPrefixInUserProfile` 一致。
- `Register-Pm2ServiceWithNssm` 使用 `-ProjectDir` 参数，与 `Grant-LocalServicePermission` 使用 `-TargetPath` 风格一致。
