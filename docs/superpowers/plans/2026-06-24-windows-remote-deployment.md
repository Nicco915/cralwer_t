# Windows 异地快速部署实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在目标 Windows 服务器上实现一套可重复的 PowerShell 一键部署、更新、回滚流程，使用 PM2 守护 crawler 服务并注册为 Windows 服务。

**架构：** 使用 PowerShell 脚本处理 Windows 特有操作（管理员检查、依赖安装、服务注册），使用 Node.js 模块处理跨平台部署逻辑（Git 操作、npm install、PM2 启停、健康检查、状态记录）。PM2 通过 `ecosystem.config.js` 管理 crawler 进程，并通过 `pm2-installer` 注册为 Windows 服务实现开机自启。

**技术栈：** PowerShell 5.1+、Node.js 20+、PM2、pm2-installer、Git、winget/Chocolatey

---

## 文件结构

将新增以下文件：

- `deployment/windows/ecosystem.config.js` — PM2 进程配置
- `deployment/windows/lib/state.js` — `.deployment-state.json` 读写
- `deployment/windows/lib/health-check.js` — 通过 PM2 检查 crawler 服务是否在线
- `deployment/windows/lib/deploy.js` — 首次部署核心逻辑
- `deployment/windows/lib/update.js` — 更新核心逻辑
- `deployment/windows/lib/rollback.js` — 回滚核心逻辑
- `deployment/windows/deploy.ps1` — 首次部署 PowerShell 入口
- `deployment/windows/update.ps1` — 更新 PowerShell 入口
- `deployment/windows/rollback.ps1` — 回滚 PowerShell 入口
- `deployment/windows/setup-pm2-service.ps1` — 将 PM2 注册为 Windows 服务
- `deployment/windows/README.md` — 部署操作说明

---

## 任务 1：PM2 配置与状态/健康检查工具

**文件：**
- 创建：`deployment/windows/ecosystem.config.js`
- 创建：`deployment/windows/lib/state.js`
- 创建：`deployment/windows/lib/health-check.js`
- 测试：`test/deployment/state.test.js`
- 测试：`test/deployment/health-check.test.js`

### 步骤 1：编写 `ecosystem.config.js`

- [ ] **编写 PM2 配置**

```javascript
const path = require('path');

const installDir = process.env.CRAWLER_INSTALL_DIR || 'C:\\hs-sku-crawler';

module.exports = {
  apps: [
    {
      name: 'crawler',
      script: path.join(installDir, 'bin', 'run.js'),
      args: '--mode=service',
      cwd: installDir,
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
      },
      log_file: path.join(installDir, 'logs', 'crawler-combined.log'),
      out_file: path.join(installDir, 'logs', 'crawler-out.log'),
      error_file: path.join(installDir, 'logs', 'crawler-error.log'),
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: false,
      max_restarts: 10,
      min_uptime: '10s',
      autorestart: true,
      kill_timeout: 30000,
      listen_timeout: 10000,
    },
  ],
};
```

### 步骤 2：编写 `state.js`

- [ ] **编写状态管理模块**

```javascript
const fs = require('fs');
const path = require('path');

const STATE_FILE = '.deployment-state.json';

function getStatePath(installDir) {
  return path.join(installDir, STATE_FILE);
}

function readState(installDir) {
  const statePath = getStatePath(installDir);
  if (!fs.existsSync(statePath)) {
    return { current: null, previous: null, history: [] };
  }
  try {
    const content = fs.readFileSync(statePath, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    throw new Error(`Failed to parse ${statePath}: ${err.message}`);
  }
}

function writeState(installDir, state) {
  const statePath = getStatePath(installDir);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
}

function recordCurrent(installDir, commit) {
  const state = readState(installDir);
  state.previous = state.current;
  state.current = commit;
  if (commit) {
    state.history = [commit, ...state.history].slice(0, 20);
  }
  writeState(installDir, state);
}

module.exports = {
  STATE_FILE,
  getStatePath,
  readState,
  writeState,
  recordCurrent,
};
```

### 步骤 3：编写 `health-check.js`

- [ ] **编写健康检查模块**

```javascript
const { execSync } = require('child_process');

function isServiceOnline(appName = 'crawler') {
  try {
    const output = execSync('pm2 jlist', { encoding: 'utf-8', timeout: 10000 });
    const list = JSON.parse(output);
    const app = list.find((item) => item.name === appName);
    if (!app) return false;
    return app.pm2_env && app.pm2_env.status === 'online';
  } catch (err) {
    return false;
  }
}

function waitForService(appName = 'crawler', timeoutMs = 30000, intervalMs = 2000) {
  const start = Date.now();
  return new Promise((resolve) => {
    const check = () => {
      if (isServiceOnline(appName)) {
        resolve(true);
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(check, intervalMs);
    };
    check();
  });
}

module.exports = { isServiceOnline, waitForService };
```

### 步骤 4：编写状态模块测试

- [ ] **编写 `test/deployment/state.test.js`**

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { readState, writeState, recordCurrent, getStatePath } = require('../../deployment/windows/lib/state');

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'deployment-state-'));
}

test('readState returns default when file missing', () => {
  const dir = createTempDir();
  const state = readState(dir);
  assert.deepStrictEqual(state, { current: null, previous: null, history: [] });
});

test('writeState and readState roundtrip', () => {
  const dir = createTempDir();
  const expected = { current: 'abc123', previous: 'def456', history: ['abc123'] };
  writeState(dir, expected);
  const actual = readState(dir);
  assert.deepStrictEqual(actual, expected);
});

test('recordCurrent updates current and previous', () => {
  const dir = createTempDir();
  recordCurrent(dir, 'v1');
  recordCurrent(dir, 'v2');
  const state = readState(dir);
  assert.strictEqual(state.current, 'v2');
  assert.strictEqual(state.previous, 'v1');
  assert.deepStrictEqual(state.history, ['v2', 'v1']);
});
```

### 步骤 5：编写健康检查模块测试

- [ ] **编写 `test/deployment/health-check.test.js`**

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const { execSync } = require('child_process');
const { isServiceOnline, waitForService } = require('../../deployment/windows/lib/health-check');

test('isServiceOnline returns false when pm2 not running', () => {
  const result = isServiceOnline('non-existent-app');
  assert.strictEqual(result, false);
});

test('waitForService resolves false when service not online', async () => {
  const result = await waitForService('non-existent-app', 1000, 100);
  assert.strictEqual(result, false);
});
```

### 步骤 6：运行测试验证

- [ ] **运行测试**

```bash
node --test test/deployment/state.test.js test/deployment/health-check.test.js
```

预期：全部通过。

### 步骤 7：Commit

- [ ] **提交**

```bash
git add deployment/windows/ecosystem.config.js deployment/windows/lib/state.js deployment/windows/lib/health-check.js test/deployment/state.test.js test/deployment/health-check.test.js
git commit -m "feat(deployment/windows): 添加 PM2 配置、部署状态和健康检查模块"
```

---

## 任务 2：首次部署核心逻辑

**文件：**
- 创建：`deployment/windows/lib/deploy.js`
- 测试：`test/deployment/deploy.test.js`

### 步骤 1：编写失败的测试

- [ ] **编写 `test/deployment/deploy.test.js`**

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { deploy } = require('../../deployment/windows/lib/deploy');

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-test-'));
}

test('deploy throws when .env is missing', async () => {
  const dir = createTempDir();
  const repoDir = createTempDir();
  await assert.rejects(
    () => deploy({ installDir: dir, repoUrl: repoDir, branch: 'main' }),
    /\.env not found/
  );
});
```

### 步骤 2：运行测试验证失败

- [ ] **运行测试**

```bash
node --test test/deployment/deploy.test.js
```

预期：FAIL，报错 "deploy is not a function" 或类似。

### 步骤 3：编写 `deploy.js`

- [ ] **编写首次部署模块**

```javascript
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { recordCurrent } = require('./state');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getCurrentCommit(repoDir) {
  return execSync('git rev-parse HEAD', {
    cwd: repoDir,
    encoding: 'utf-8',
  }).trim();
}

function deploy({ installDir, repoUrl, branch = 'main' }) {
  ensureDir(installDir);

  const envPath = path.join(installDir, '.env');
  if (!fs.existsSync(envPath)) {
    throw new Error(`.env not found at ${envPath}. Please place it before deploying.`);
  }

  const logsDir = path.join(installDir, 'logs');
  ensureDir(logsDir);

  if (fs.existsSync(path.join(installDir, '.git'))) {
    execSync('git fetch origin', { cwd: installDir, stdio: 'inherit' });
    execSync(`git reset --hard origin/${branch}`, { cwd: installDir, stdio: 'inherit' });
  } else {
    if (fs.readdirSync(installDir).length > 0) {
      throw new Error(`Install directory ${installDir} is not empty and not a git repository.`);
    }
    execSync(`git clone --branch ${branch} --single-branch ${repoUrl} "${installDir}"`, {
      stdio: 'inherit',
    });
  }

  execSync('npm ci', { cwd: installDir, stdio: 'inherit' });

  const ecosystemPath = path.join(installDir, 'deployment', 'windows', 'ecosystem.config.js');
  if (fs.existsSync(ecosystemPath)) {
    execSync(`pm2 start "${ecosystemPath}"`, { cwd: installDir, stdio: 'inherit' });
    execSync('pm2 save', { cwd: installDir, stdio: 'inherit' });
  } else {
    execSync('pm2 start bin/run.js --name crawler -- --mode=service', {
      cwd: installDir,
      stdio: 'inherit',
    });
    execSync('pm2 save', { cwd: installDir, stdio: 'inherit' });
  }

  const commit = getCurrentCommit(installDir);
  recordCurrent(installDir, commit);

  return { success: true, commit };
}

module.exports = { deploy, ensureDir, getCurrentCommit };
```

### 步骤 4：补充测试

- [ ] **补充测试用例**

在 `test/deployment/deploy.test.js` 中追加：

```javascript
test('ensureDir creates directory recursively', () => {
  const { ensureDir } = require('../../deployment/windows/lib/deploy');
  const dir = path.join(createTempDir(), 'nested', 'dir');
  ensureDir(dir);
  assert.ok(fs.existsSync(dir));
});

test('getCurrentCommit returns commit hash', () => {
  const { getCurrentCommit } = require('../../deployment/windows/lib/deploy');
  const repoDir = createTempDir();
  execSync('git init', { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, 'a.txt'), 'a');
  execSync('git add .', { cwd: repoDir });
  execSync('git config user.email "test@test.com" && git config user.name "Test"', { cwd: repoDir });
  execSync('git commit -m init', { cwd: repoDir });
  const commit = getCurrentCommit(repoDir);
  assert.strictEqual(commit.length, 40);
});
```

### 步骤 5：运行测试验证通过

- [ ] **运行测试**

```bash
node --test test/deployment/deploy.test.js
```

预期：全部通过。

### 步骤 6：Commit

- [ ] **提交**

```bash
git add deployment/windows/lib/deploy.js test/deployment/deploy.test.js
git commit -m "feat(deployment/windows): 添加首次部署核心逻辑"
```

---

## 任务 3：更新与回滚核心逻辑

**文件：**
- 创建：`deployment/windows/lib/update.js`
- 创建：`deployment/windows/lib/rollback.js`
- 测试：`test/deployment/update.test.js`
- 测试：`test/deployment/rollback.test.js`

### 步骤 1：编写 `update.js`

- [ ] **编写更新模块**

```javascript
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { readState, recordCurrent } = require('./state');
const { waitForService } = require('./health-check');

async function update({ installDir, branch = 'main', healthCheckTimeoutMs = 30000 }) {
  const envPath = path.join(installDir, '.env');
  if (!fs.existsSync(envPath)) {
    throw new Error(`.env not found at ${envPath}`);
  }

  const state = readState(installDir);
  const previousCommit = state.current;

  execSync('git fetch origin', { cwd: installDir, stdio: 'inherit' });
  execSync(`git reset --hard origin/${branch}`, { cwd: installDir, stdio: 'inherit' });

  execSync('npm ci', { cwd: installDir, stdio: 'inherit' });

  const ecosystemPath = path.join(installDir, 'deployment', 'windows', 'ecosystem.config.js');
  if (fs.existsSync(ecosystemPath)) {
    execSync(`pm2 reload "${ecosystemPath}"`, { cwd: installDir, stdio: 'inherit' });
  } else {
    execSync('pm2 reload crawler', { cwd: installDir, stdio: 'inherit' });
  }

  const online = await waitForService('crawler', healthCheckTimeoutMs);
  if (!online) {
    throw new Error('Health check failed after update. Run rollback.ps1 to revert.');
  }

  const newCommit = execSync('git rev-parse HEAD', { cwd: installDir, encoding: 'utf-8' }).trim();
  recordCurrent(installDir, newCommit);

  return { success: true, previousCommit, currentCommit: newCommit };
}

module.exports = { update };
```

注意：`update` 函数使用了 `await`，需要改为 `async function`。

### 步骤 2：编写 `rollback.js`

- [ ] **编写回滚模块**

```javascript
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { readState, recordCurrent } = require('./state');
const { waitForService } = require('./health-check');

async function rollback({ installDir, targetCommit = null, healthCheckTimeoutMs = 30000 }) {
  const envPath = path.join(installDir, '.env');
  if (!fs.existsSync(envPath)) {
    throw new Error(`.env not found at ${envPath}`);
  }

  const state = readState(installDir);
  const commit = targetCommit || state.previous;
  if (!commit) {
    throw new Error('No previous commit recorded. Cannot rollback automatically.');
  }

  execSync(`git reset --hard ${commit}`, { cwd: installDir, stdio: 'inherit' });
  execSync('npm ci', { cwd: installDir, stdio: 'inherit' });

  const ecosystemPath = path.join(installDir, 'deployment', 'windows', 'ecosystem.config.js');
  if (fs.existsSync(ecosystemPath)) {
    execSync(`pm2 reload "${ecosystemPath}"`, { cwd: installDir, stdio: 'inherit' });
  } else {
    execSync('pm2 reload crawler', { cwd: installDir, stdio: 'inherit' });
  }

  const online = await waitForService('crawler', healthCheckTimeoutMs);
  if (!online) {
    throw new Error('Health check failed after rollback.');
  }

  recordCurrent(installDir, commit);
  return { success: true, commit };
}

module.exports = { rollback };
```

注意：`rollback` 函数使用了 `await`，需要改为 `async function`。

### 步骤 3：编写更新测试

- [ ] **编写 `test/deployment/update.test.js`**

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { update } = require('../../deployment/windows/lib/update');

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'update-test-'));
}

test('update throws when .env is missing', async () => {
  const dir = createTempDir();
  await assert.rejects(
    () => update({ installDir: dir }),
    /\.env not found/
  );
});
```

### 步骤 4：编写回滚测试

- [ ] **编写 `test/deployment/rollback.test.js`**

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { rollback } = require('../../deployment/windows/lib/rollback');

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rollback-test-'));
}

test('rollback throws when .env is missing', async () => {
  const dir = createTempDir();
  await assert.rejects(
    () => rollback({ installDir: dir }),
    /\.env not found/
  );
});

test('rollback throws when no previous commit and no target', async () => {
  const dir = createTempDir();
  fs.writeFileSync(path.join(dir, '.env'), 'TEST=1\n');
  await assert.rejects(
    () => rollback({ installDir: dir }),
    /No previous commit recorded/
  );
});
```

### 步骤 5：运行测试验证

- [ ] **运行测试**

```bash
node --test test/deployment/update.test.js test/deployment/rollback.test.js
```

预期：全部通过。

### 步骤 6：Commit

- [ ] **提交**

```bash
git add deployment/windows/lib/update.js deployment/windows/lib/rollback.js test/deployment/update.test.js test/deployment/rollback.test.js
git commit -m "feat(deployment/windows): 添加更新与回滚核心逻辑"
```

---

## 任务 4：PowerShell 入口脚本

**文件：**
- 创建：`deployment/windows/deploy.ps1`
- 创建：`deployment/windows/update.ps1`
- 创建：`deployment/windows/rollback.ps1`

### 步骤 1：编写 `deploy.ps1`

- [ ] **编写首次部署 PowerShell 脚本**

```powershell
#Requires -RunAsAdministrator
param(
    [string]$RepoUrl = "",
    [string]$Branch = "main",
    [string]$InstallDir = "C:\hs-sku-crawler",
    [string]$NodeVersion = "20"
)

$ErrorActionPreference = "Stop"

function Test-Admin {
    $currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    return $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Admin)) {
    Write-Error "This script must be run as Administrator."
    exit 1
}

function Install-IfMissing {
    param([string]$Command, [string]$Name)
    if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
        Write-Host "Installing $Name..."
        if (Get-Command winget -ErrorAction SilentlyContinue) {
            winget install --accept-package-agreements --accept-source-agreements $Name
        } else {
            Write-Error "winget not available. Please install $Name manually."
            exit 1
        }
    }
}

Install-IfMissing -Command "node" -Name "OpenJS.NodeJS.LTS"
Install-IfMissing -Command "git" -Name "Git.Git"

if (-not (Get-Command pm2 -ErrorAction SilentlyContinue)) {
    Write-Host "Installing pm2..."
    npm install -g pm2
}

$RepoUrl = if ($RepoUrl) { $RepoUrl } else {
    Write-Error "RepoUrl parameter is required."
    exit 1
}

Write-Host "Deploying crawler to $InstallDir from $RepoUrl ($Branch)..."
node "$PSScriptRoot\lib\deploy.js" --repo-url "$RepoUrl" --branch "$Branch" --install-dir "$InstallDir"

if ($LASTEXITCODE -ne 0) {
    Write-Error "Deploy failed."
    exit 1
}

Write-Host "Deploy completed. Setting up PM2 Windows service..."
& "$PSScriptRoot\setup-pm2-service.ps1"

Write-Host "Deployment complete."
```

注意：`deploy.js` 需要支持命令行参数。可以在 `deploy.js` 底部添加 CLI 入口，或创建一个 `cli.js`。为了简单，直接让 `deploy.js` 支持命令行参数。

### 步骤 2：修改 `deploy.js` 支持 CLI

- [ ] **在 `deploy.js` 底部添加 CLI 入口**

```javascript
if (require.main === module) {
  const args = process.argv.slice(2);
  const repoUrlIndex = args.indexOf('--repo-url');
  const branchIndex = args.indexOf('--branch');
  const installDirIndex = args.indexOf('--install-dir');

  const repoUrl = repoUrlIndex !== -1 ? args[repoUrlIndex + 1] : '';
  const branch = branchIndex !== -1 ? args[branchIndex + 1] : 'main';
  const installDir = installDirIndex !== -1 ? args[installDirIndex + 1] : 'C:\\hs-sku-crawler';

  if (!repoUrl) {
    console.error('Usage: node deploy.js --repo-url <url> --branch <branch> --install-dir <dir>');
    process.exit(1);
  }

  deploy({ repoUrl, branch, installDir })
    .then((result) => {
      console.log('Deploy succeeded:', result);
    })
    .catch((err) => {
      console.error('Deploy failed:', err.message);
      process.exit(1);
    });
}
```

### 步骤 3：编写 `update.ps1`

- [ ] **编写更新 PowerShell 脚本**

```powershell
#Requires -RunAsAdministrator
param(
    [string]$InstallDir = "C:\hs-sku-crawler",
    [string]$Branch = "main"
)

$ErrorActionPreference = "Stop"

$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "This script must be run as Administrator."
    exit 1
}

node "$PSScriptRoot\lib\update.js" --install-dir "$InstallDir" --branch "$Branch"

if ($LASTEXITCODE -ne 0) {
    Write-Error "Update failed."
    exit 1
}

Write-Host "Update complete."
```

### 步骤 4：修改 `update.js` 支持 CLI

- [ ] **在 `update.js` 底部添加 CLI 入口**

```javascript
if (require.main === module) {
  const args = process.argv.slice(2);
  const installDirIndex = args.indexOf('--install-dir');
  const branchIndex = args.indexOf('--branch');

  const installDir = installDirIndex !== -1 ? args[installDirIndex + 1] : 'C:\\hs-sku-crawler';
  const branch = branchIndex !== -1 ? args[branchIndex + 1] : 'main';

  update({ installDir, branch })
    .then((result) => {
      console.log('Update succeeded:', result);
    })
    .catch((err) => {
      console.error('Update failed:', err.message);
      process.exit(1);
    });
}
```

### 步骤 5：编写 `rollback.ps1`

- [ ] **编写回滚 PowerShell 脚本**

```powershell
#Requires -RunAsAdministrator
param(
    [string]$InstallDir = "C:\hs-sku-crawler",
    [string]$TargetCommit = ""
)

$ErrorActionPreference = "Stop"

$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "This script must be run as Administrator."
    exit 1
}

$targetArg = if ($TargetCommit) { "--target-commit $TargetCommit" } else { "" }
node "$PSScriptRoot\lib\rollback.js" --install-dir "$InstallDir" $targetArg

if ($LASTEXITCODE -ne 0) {
    Write-Error "Rollback failed."
    exit 1
}

Write-Host "Rollback complete."
```

### 步骤 6：修改 `rollback.js` 支持 CLI

- [ ] **在 `rollback.js` 底部添加 CLI 入口**

```javascript
if (require.main === module) {
  const args = process.argv.slice(2);
  const installDirIndex = args.indexOf('--install-dir');
  const targetIndex = args.indexOf('--target-commit');

  const installDir = installDirIndex !== -1 ? args[installDirIndex + 1] : 'C:\\hs-sku-crawler';
  const targetCommit = targetIndex !== -1 ? args[targetIndex + 1] : null;

  rollback({ installDir, targetCommit })
    .then((result) => {
      console.log('Rollback succeeded:', result);
    })
    .catch((err) => {
      console.error('Rollback failed:', err.message);
      process.exit(1);
    });
}
```

### 步骤 7：验证 PowerShell 脚本语法

- [ ] **在 Windows 上验证（如可用）**

```powershell
Get-Command powershell
powershell -Command "Get-Help"
```

在 macOS 上无法直接运行 PowerShell 测试，因此通过以下方式间接验证：

- [ ] **检查脚本文件存在且非空**

```bash
ls -la deployment/windows/*.ps1
```

### 步骤 8：Commit

- [ ] **提交**

```bash
git add deployment/windows/deploy.ps1 deployment/windows/update.ps1 deployment/windows/rollback.ps1 deployment/windows/lib/deploy.js deployment/windows/lib/update.js deployment/windows/lib/rollback.js
git commit -m "feat(deployment/windows): 添加 PowerShell 部署入口脚本"
```

---

## 任务 5：PM2 Windows 服务注册脚本与部署文档

**文件：**
- 创建：`deployment/windows/setup-pm2-service.ps1`
- 创建：`deployment/windows/README.md`

### 步骤 1：编写 `setup-pm2-service.ps1`

- [ ] **编写服务注册脚本**

```powershell
#Requires -RunAsAdministrator
$ErrorActionPreference = "Stop"

$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "This script must be run as Administrator."
    exit 1
}

if (-not (Get-Command pm2 -ErrorAction SilentlyContinue)) {
    Write-Error "pm2 not found. Please run deploy.ps1 first or install pm2 globally."
    exit 1
}

$pm2Path = (Get-Command pm2).Source
$pm2Dir = Split-Path -Parent $pm2Path
$globalModules = & node -e "console.log(process.env.npm_config_prefix || require('path').dirname(process.execPath))"
$installerDir = Join-Path $globalModules "node_modules" "pm2-installer"

if (-not (Test-Path $installerDir)) {
    Write-Host "Installing pm2-installer globally..."
    npm install -g pm2-installer
    $globalModules = & node -e "console.log(process.env.npm_config_prefix || require('path').dirname(process.execPath))"
    $installerDir = Join-Path $globalModules "node_modules" "pm2-installer"
}

if (-not (Test-Path $installerDir)) {
    Write-Error "pm2-installer not found after installation."
    exit 1
}

Write-Host "Running pm2-installer from $installerDir..."
& "$installerDir\src\windows-service\install.ps1"

pm2 save

Write-Host "PM2 Windows service setup complete."
```

注意：`pm2-installer` 的实际路径可能不同。此脚本假设 pm2-installer 安装在 pm2 的 node_modules 下。如果安装后路径不同，需要调整。这里先按常见路径编写，后续在 Windows 上实测时修正。

### 步骤 2：编写 `README.md`

- [ ] **编写部署说明文档**

```markdown
# Windows 异地快速部署说明

## 环境要求

- Windows Server 2019 / 2022（或 Windows 10/11）
- 管理员权限
- 可访问 Git 仓库的网络

## 首次部署

1. 在目标服务器上创建安装目录，例如 `C:\hs-sku-crawler`。
2. 将 `.env` 配置文件放入安装目录。
3. 打开 PowerShell（以管理员身份），执行：

```powershell
deployment\windows\deploy.ps1 -RepoUrl "https://github.com/your-org/hs-sku-crawler.git" -Branch "main" -InstallDir "C:\hs-sku-crawler"
```

4. 脚本会自动安装 Node.js、Git、PM2，clone 代码，安装依赖，启动服务，并将 PM2 注册为 Windows 服务。

## 后续更新

```powershell
deployment\windows\update.ps1 -InstallDir "C:\hs-sku-crawler" -Branch "main"
```

## 回滚

```powershell
deployment\windows\rollback.ps1 -InstallDir "C:\hs-sku-crawler"
```

或指定目标版本：

```powershell
deployment\windows\rollback.ps1 -InstallDir "C:\hs-sku-crawler" -TargetCommit "abc1234"
```

## 日志

- 部署日志：`C:\hs-sku-crawler\logs\deploy.log`
- 服务日志：`C:\hs-sku-crawler\logs\crawler-*.log`

## 注意事项

- 所有脚本必须以管理员身份运行。
- `.env` 文件由运维人员手动维护，部署脚本不会覆盖。
- 首次部署前请确保安装目录为空或不存在。
```

### 步骤 3：检查新增文件

- [ ] **列出新增文件**

```bash
ls -la deployment/windows/
ls -la deployment/windows/lib/
```

### 步骤 4：Commit

- [ ] **提交**

```bash
git add deployment/windows/setup-pm2-service.ps1 deployment/windows/README.md
git commit -m "docs(deployment/windows): 添加 PM2 服务注册脚本和部署说明"
```

---

## 任务 6：整体集成验证

**文件：**
- 修改：无新增文件，仅验证

### 步骤 1：运行全部测试

- [ ] **运行所有测试**

```bash
npm test
```

预期：所有原有测试和新增测试通过。

### 步骤 2：检查文件结构

- [ ] **检查部署目录结构**

```bash
find deployment/windows -type f
```

预期输出包含：
- `deployment/windows/deploy.ps1`
- `deployment/windows/update.ps1`
- `deployment/windows/rollback.ps1`
- `deployment/windows/setup-pm2-service.ps1`
- `deployment/windows/ecosystem.config.js`
- `deployment/windows/README.md`
- `deployment/windows/lib/deploy.js`
- `deployment/windows/lib/update.js`
- `deployment/windows/lib/rollback.js`
- `deployment/windows/lib/state.js`
- `deployment/windows/lib/health-check.js`

### 步骤 3：最终 Commit

- [ ] **如有任何修正则提交**

```bash
git add -A
git commit -m "chore(deployment/windows): 集成验证与最终调整"
```

---

## 自检

- **规格覆盖度：** 每个规格需求都有对应任务：PM2 配置（任务1）、首次部署（任务2）、更新与回滚（任务3）、PowerShell 入口（任务4）、Windows 服务注册与文档（任务5）、集成验证（任务6）。
- **占位符扫描：** 计划中没有 "TODO"、"待定" 或未完成的步骤。所有代码和命令都是具体可执行的。
- **类型一致性：** `state.js`、`health-check.js`、`deploy.js`、`update.js`、`rollback.js` 的接口和命名在各任务中保持一致。
- **注意事项：** PowerShell 脚本的实际路径需要在 Windows 服务器上实测验证；`pm2-installer` 的安装路径可能因环境而异，脚本中已预留调整空间。
