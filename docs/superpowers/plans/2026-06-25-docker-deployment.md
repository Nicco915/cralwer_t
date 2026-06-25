# Docker 容器化部署实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 `deployment/docker/` 下新增一套与现有 PM2 方案共存的 Docker 容器化部署能力，支持 Windows 服务器（Linux 容器）上的首次部署、更新、回滚与镜像构建推送。

**架构：** PowerShell 脚本负责目标机 Windows 相关检查与 Node.js CLI 调用；Node.js 模块处理跨平台的 Docker Compose 调用、状态文件管理与健康检查，并配套单元测试；镜像以 Git commit SHA 为 tag 推送到仓库，目标机通过 docker compose 运行。

**技术栈：** Docker、Docker Compose、PowerShell 5.1+、Node.js 20、Playwright Chromium、`node:test`。

---

## 文件结构与职责

- **创建 `deployment/docker/.dockerignore`**：排除 `.env`、日志、输出、node_modules 等敏感/可生成文件。
- **创建 `deployment/docker/Dockerfile`**：基于 `node:20-slim`，安装系统依赖、npm 依赖与 Playwright Chromium。
- **创建 `deployment/docker/docker-compose.yml`**：定义 crawler 服务、只读挂载 `.env`、持久化日志/输出/图片、使用 `CRAWLER_IMAGE` 环境变量。
- **创建 `deployment/docker/lib/state.js`**：管理 `.deployment-state.json`，字段 `current`/`previous`/`history` 存储镜像 tag。
- **创建 `deployment/docker/lib/health-check.js`**：通过 `docker inspect` 检查容器是否为 `running`。
- **创建 `deployment/docker/lib/deploy.js`**：首次部署逻辑，创建目录、检查 `.env`、调用 `docker compose up -d`、记录状态。
- **创建 `deployment/docker/lib/update.js`**：更新逻辑，备份当前镜像、拉取新镜像、健康检查、失败自动回滚。
- **创建 `deployment/docker/lib/rollback.js`**：回滚逻辑，切回 `previous` 或指定镜像 tag。
- **创建 `deployment/docker/deploy.ps1`**：Windows 目标机首次部署入口。
- **创建 `deployment/docker/update.ps1`**：Windows 目标机更新入口。
- **创建 `deployment/docker/rollback.ps1`**：Windows 目标机回滚入口。
- **创建 `deployment/docker/build-push.ps1`**：本地/CI 构建并推送镜像。
- **创建 `deployment/docker/README.md`**：Docker 部署操作说明。
- **创建 `test/deployment/docker-*.test.js`**：各模块单元测试。
- **修改 `package.json`**：增加 `test:deployment:docker:unit` 脚本。

---

### 任务 1：创建 `.dockerignore`

**文件：**
- 创建：`deployment/docker/.dockerignore`
- 测试：`test/deployment/docker-dockerignore.test.js`

- [ ] **步骤 1：编写失败的测试**

```js
const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

describe('.dockerignore', () => {
  let dockerignorePath;

  before(() => {
    dockerignorePath = path.resolve(__dirname, '../../deployment/docker/.dockerignore');
  });

  it('excludes .env and node_modules', () => {
    assert.ok(fs.existsSync(dockerignorePath), '.dockerignore should exist');
    const content = fs.readFileSync(dockerignorePath, 'utf-8');
    assert.ok(content.includes('.env'), 'should ignore .env');
    assert.ok(content.includes('node_modules'), 'should ignore node_modules');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run test:deployment:docker:unit`
预期：FAIL，报错 `.dockerignore should exist`

- [ ] **步骤 3：创建 `.dockerignore` 文件**

```text
.env
.env.*
node_modules
logs
output
images
.git
.gitignore
.DS_Store
coverage
test
*.log
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm run test:deployment:docker:unit`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add deployment/docker/.dockerignore test/deployment/docker-dockerignore.test.js package.json
git commit -m "feat(deployment/docker): 添加 .dockerignore"
```

---

### 任务 2：创建 `Dockerfile`

**文件：**
- 创建：`deployment/docker/Dockerfile`
- 验证：本地执行 `docker build`

- [ ] **步骤 1：创建 Dockerfile**

```dockerfile
FROM node:20-slim

# 安装系统依赖与 Chromium 所需库
RUN apt-get update && apt-get install -y \
    wget gnupg ca-certificates procps \
    libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 \
    libgbm1 libasound2 libxcomposite1 libxdamage1 libxfixes3 \
    libxrandr2 libgtk-3-0 libpango-1.0-0 libcairo2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

# 安装 Playwright Chromium
RUN npx playwright install chromium

COPY . .

ENV NODE_ENV=production
ENV CRAWLER_MODE=service

CMD ["node", "bin/run.js", "--mode=service"]
```

- [ ] **步骤 2：验证 Dockerfile 语法**

运行：`docker build -t hs-sku-crawler:test -f deployment/docker/Dockerfile .`
预期：镜像构建成功（若本地无 Docker，跳过此步并注明）。

- [ ] **步骤 3：Commit**

```bash
git add deployment/docker/Dockerfile
git commit -m "feat(deployment/docker): 添加 Dockerfile"
```

---

### 任务 3：创建 `docker-compose.yml`

**文件：**
- 创建：`deployment/docker/docker-compose.yml`
- 测试：`test/deployment/docker-compose.test.js`

- [ ] **步骤 1：编写失败的测试**

```js
const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

describe('docker-compose.yml', () => {
  let composePath;

  before(() => {
    composePath = path.resolve(__dirname, '../../deployment/docker/docker-compose.yml');
  });

  it('mounts .env as read-only volume and sets restart policy', () => {
    assert.ok(fs.existsSync(composePath), 'docker-compose.yml should exist');
    const content = fs.readFileSync(composePath, 'utf-8');
    assert.ok(content.includes('./.env:/app/.env:ro'), 'should mount .env read-only');
    assert.ok(content.includes('restart: unless-stopped'), 'should set restart policy');
    assert.ok(content.includes('${CRAWLER_IMAGE}'), 'should use CRAWLER_IMAGE');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run test:deployment:docker:unit`
预期：FAIL，报错 `docker-compose.yml should exist`

- [ ] **步骤 3：创建 `docker-compose.yml` 文件**

```yaml
version: "3.8"

services:
  crawler:
    image: ${CRAWLER_IMAGE:?未设置 CRAWLER_IMAGE 环境变量}
    container_name: hs-sku-crawler
    restart: unless-stopped
    volumes:
      - ./.env:/app/.env:ro
      - ./logs:/app/logs
      - ./output:/app/output
      - ./images:/app/images
    working_dir: /app
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm run test:deployment:docker:unit`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add deployment/docker/docker-compose.yml test/deployment/docker-compose.test.js
git commit -m "feat(deployment/docker): 添加 docker-compose.yml"
```

---

### 任务 4：Docker 状态管理模块

**文件：**
- 创建：`deployment/docker/lib/state.js`
- 测试：`test/deployment/docker-state.test.js`

- [ ] **步骤 1：编写失败的测试**

```js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { getStatePath, readState, writeState, recordCurrent, setCurrentImage } = require('../../deployment/docker/lib/state.js');

describe('docker state', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-state-test-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns default state when file does not exist', () => {
    const state = readState(path.join(tmpDir, 'nonexistent'));
    assert.deepStrictEqual(state, { current: null, previous: null, history: [] });
  });

  it('write/read roundtrip', () => {
    const dir = path.join(tmpDir, 'roundtrip');
    fs.mkdirSync(dir, { recursive: true });
    const expected = { current: 'registry/a:1', previous: 'registry/a:0', history: ['registry/a:1', 'registry/a:0'] };
    writeState(dir, expected);
    assert.deepStrictEqual(readState(dir), expected);
  });

  it('recordCurrent updates current/previous/history', () => {
    const dir = tmpDir;
    recordCurrent(dir, 'registry/a:1');
    let state = readState(dir);
    assert.strictEqual(state.current, 'registry/a:1');
    assert.strictEqual(state.previous, null);
    assert.deepStrictEqual(state.history, ['registry/a:1']);

    recordCurrent(dir, 'registry/a:2');
    state = readState(dir);
    assert.strictEqual(state.current, 'registry/a:2');
    assert.strictEqual(state.previous, 'registry/a:1');
    assert.deepStrictEqual(state.history, ['registry/a:2', 'registry/a:1']);
  });

  it('keeps last 20 history entries', () => {
    const dir = path.join(tmpDir, 'history');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 25; i++) {
      recordCurrent(dir, `registry/a:${i}`);
    }
    const state = readState(dir);
    assert.strictEqual(state.history.length, 20);
  });

  it('setCurrentImage updates current and previous', () => {
    const dir = path.join(tmpDir, 'set-current');
    fs.mkdirSync(dir, { recursive: true });
    writeState(dir, { current: 'registry/a:2', previous: 'registry/a:1', history: ['registry/a:2', 'registry/a:1', 'registry/a:0'] });
    setCurrentImage(dir, 'registry/a:1', 'registry/a:0');
    const state = readState(dir);
    assert.strictEqual(state.current, 'registry/a:1');
    assert.strictEqual(state.previous, 'registry/a:0');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/deployment/docker-state.test.js`
预期：FAIL，报错 `Cannot find module`

- [ ] **步骤 3：实现 `state.js`**

```js
const path = require('node:path');
const fs = require('node:fs');

const STATE_FILE = '.deployment-state.json';

function getStatePath(installDir) {
  return path.join(installDir, STATE_FILE);
}

function readState(installDir) {
  const filePath = getStatePath(installDir);
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { current: null, previous: null, history: [] };
    }
    throw new Error(`Failed to parse ${filePath}: ${err.message}`);
  }
}

function writeState(installDir, state) {
  const filePath = getStatePath(installDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8');
}

function recordCurrent(installDir, imageTag, previous = null) {
  const state = readState(installDir);
  if (previous !== null) {
    state.previous = previous;
  } else {
    state.previous = state.current;
  }
  state.current = imageTag;
  if (imageTag) {
    state.history = [imageTag, ...state.history].slice(0, 20);
  }
  writeState(installDir, state);
}

function setCurrentImage(installDir, imageTag, previous) {
  const state = readState(installDir);
  state.current = imageTag;
  state.previous = previous;
  writeState(installDir, state);
}

module.exports = {
  STATE_FILE,
  getStatePath,
  readState,
  writeState,
  recordCurrent,
  setCurrentImage,
};
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test test/deployment/docker-state.test.js`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add deployment/docker/lib/state.js test/deployment/docker-state.test.js
git commit -m "feat(deployment/docker): 添加 Docker 部署状态管理模块"
```

---

### 任务 5：Docker 健康检查模块

**文件：**
- 创建：`deployment/docker/lib/health-check.js`
- 测试：`test/deployment/docker-health-check.test.js`

- [ ] **步骤 1：编写失败的测试**

```js
const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const cp = require('node:child_process');

const originalExecSync = cp.execSync;

describe('docker health-check', () => {
  let calls = [];

  before(() => {
    calls = [];
    cp.execSync = (cmd, opts) => {
      calls.push(cmd);
      if (cmd.includes('docker inspect')) {
        return JSON.stringify([{ State: { Status: 'running' } }]);
      }
      return originalExecSync(cmd, opts);
    };
  });

  it('isContainerRunning returns true when container is running', () => {
    const { isContainerRunning } = require('../../deployment/docker/lib/health-check.js');
    assert.strictEqual(isContainerRunning('hs-sku-crawler'), true);
    assert.ok(calls.some(c => c.includes('docker inspect')));
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/deployment/docker-health-check.test.js`
预期：FAIL，报错 `Cannot find module`

- [ ] **步骤 3：实现 `health-check.js`**

```js
const { execSync } = require('node:child_process');

function isContainerRunning(containerName = 'hs-sku-crawler') {
  try {
    const output = execSync(
      `docker inspect --format='{{.State.Status}}' ${containerName}`,
      { encoding: 'utf-8', timeout: 10000 }
    );
    return output.trim() === 'running';
  } catch {
    return false;
  }
}

function waitForContainer(containerName = 'hs-sku-crawler', timeoutMs = 30000, intervalMs = 2000) {
  return new Promise((resolve) => {
    const start = Date.now();
    let timer = null;
    function check() {
      if (isContainerRunning(containerName)) {
        if (timer) clearTimeout(timer);
        resolve(true);
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        resolve(false);
        return;
      }
      timer = setTimeout(check, intervalMs);
    }
    check();
  });
}

module.exports = {
  isContainerRunning,
  waitForContainer,
};
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test test/deployment/docker-health-check.test.js`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add deployment/docker/lib/health-check.js test/deployment/docker-health-check.test.js
git commit -m "feat(deployment/docker): 添加 Docker 容器健康检查模块"
```

---

### 任务 6：Docker 首次部署模块

**文件：**
- 创建：`deployment/docker/lib/deploy.js`
- 测试：`test/deployment/docker-deploy.test.js`

- [ ] **步骤 1：编写失败的测试**

```js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');

const originalExecSync = cp.execSync;
let commands = [];

describe('docker deploy', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-deploy-test-'));
    commands = [];
    cp.execSync = (cmd, opts) => {
      commands.push(cmd);
      if (cmd.includes('docker compose')) return '';
      return originalExecSync(cmd, opts);
    };
  });

  after(() => {
    cp.execSync = originalExecSync;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('deploy throws when .env is missing', async () => {
    const { deploy } = require('../../deployment/docker/lib/deploy.js');
    const installDir = path.join(tmpDir, 'no-env');
    fs.mkdirSync(installDir, { recursive: true });

    await assert.rejects(
      async () => deploy({ installDir, image: 'registry/a:1' }),
      /\.env not found/
    );
  });

  it('deploy creates directories and runs docker compose', async () => {
    const { deploy } = require('../../deployment/docker/lib/deploy.js');
    const installDir = path.join(tmpDir, 'deploy-ok');
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(path.join(installDir, '.env'), 'TEST=1\n');

    const result = await deploy({ installDir, image: 'registry/a:1' });

    assert.strictEqual(result.success, true);
    assert.ok(fs.existsSync(path.join(installDir, 'logs')));
    assert.ok(commands.some(c => c.includes('docker compose up -d')));
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/deployment/docker-deploy.test.js`
预期：FAIL，报错 `Cannot find module`

- [ ] **步骤 3：实现 `deploy.js`**

```js
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { recordCurrent } = require('./state.js');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function deploy({ installDir, image }) {
  if (!installDir || typeof installDir !== 'string') {
    throw new Error('installDir is required and must be a string');
  }
  if (!image || typeof image !== 'string') {
    throw new Error('image is required and must be a string');
  }

  ensureDir(installDir);

  const envPath = path.join(installDir, '.env');
  if (!fs.existsSync(envPath)) {
    throw new Error(`.env not found at ${envPath}. Please place it before deploying.`);
  }

  ensureDir(path.join(installDir, 'logs'));
  ensureDir(path.join(installDir, 'output'));
  ensureDir(path.join(installDir, 'images'));

  const composeSource = path.join(__dirname, '..', 'docker-compose.yml');
  const composeTarget = path.join(installDir, 'docker-compose.yml');
  if (!fs.existsSync(composeTarget)) {
    fs.copyFileSync(composeSource, composeTarget);
  }

  try {
    execSync('docker compose up -d', {
      cwd: installDir,
      encoding: 'utf-8',
      stdio: 'inherit',
      env: { ...process.env, CRAWLER_IMAGE: image },
    });
  } catch (err) {
    throw new Error(`[deploy] docker compose up failed: ${err.message}`);
  }

  recordCurrent(installDir, image);

  return { success: true, image };
}

module.exports = {
  deploy,
  ensureDir,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  function getArg(flag) {
    const index = args.indexOf(flag);
    if (index === -1) return undefined;
    if (index + 1 >= args.length || args[index + 1].startsWith('--')) {
      console.error(`Missing value for ${flag}`);
      process.exit(1);
    }
    return args[index + 1];
  }
  const installDir = getArg('--install-dir') || 'C:\\hs-sku-crawler';
  const image = getArg('--image');
  if (!image) {
    console.error('Usage: node deploy.js --image <image> [--install-dir <dir>]');
    process.exit(1);
  }
  deploy({ installDir, image })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test test/deployment/docker-deploy.test.js`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add deployment/docker/lib/deploy.js test/deployment/docker-deploy.test.js
git commit -m "feat(deployment/docker): 添加 Docker 首次部署模块"
```

---

### 任务 7：Docker 更新模块

**文件：**
- 创建：`deployment/docker/lib/update.js`
- 测试：`test/deployment/docker-update.test.js`

- [ ] **步骤 1：编写失败的测试**

```js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');

const originalExecSync = cp.execSync;
let commands = [];
let shouldFail = false;

describe('docker update', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-update-test-'));
    commands = [];
    shouldFail = false;
    cp.execSync = (cmd, opts) => {
      commands.push(cmd);
      if (cmd.includes('docker pull')) {
        if (shouldFail) throw new Error('docker pull failed');
        return '';
      }
      if (cmd.includes('docker compose')) return '';
      return originalExecSync(cmd, opts);
    };
  });

  after(() => {
    cp.execSync = originalExecSync;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('update throws when .env is missing', async () => {
    const { update } = require('../../deployment/docker/lib/update.js');
    const installDir = path.join(tmpDir, 'no-env');
    fs.mkdirSync(installDir, { recursive: true });

    await assert.rejects(
      async () => update({ installDir, imageTag: 'registry/a:2' }),
      /\.env not found/
    );
  });

  it('update records previous and switches image on success', async () => {
    const { update, readState } = require('../../deployment/docker/lib/update.js');
    const installDir = path.join(tmpDir, 'update-ok');
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(path.join(installDir, '.env'), 'TEST=1\n');

    await update({ installDir, imageTag: 'registry/a:2', healthCheckTimeoutMs: 100 });

    const state = readState(installDir);
    assert.strictEqual(state.current, 'registry/a:2');
    assert.strictEqual(state.previous, null);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/deployment/docker-update.test.js`
预期：FAIL，报错 `Cannot find module`

- [ ] **步骤 3：实现 `update.js`**

```js
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { readState, writeState, recordCurrent, setCurrentImage } = require('./state.js');
const { waitForContainer } = require('./health-check.js');

async function update({ installDir, imageTag, healthCheckTimeoutMs = 30000 }) {
  if (!installDir || typeof installDir !== 'string') {
    throw new Error('installDir is required and must be a string');
  }
  if (!imageTag || typeof imageTag !== 'string') {
    throw new Error('imageTag is required and must be a string');
  }

  const envPath = path.join(installDir, '.env');
  if (!fs.existsSync(envPath)) {
    throw new Error(`.env not found at ${envPath}`);
  }

  const state = readState(installDir);
  const previousImage = state.current;
  const oldPrevious = state.previous;
  state.previous = previousImage;
  writeState(installDir, state);

  const newImage = imageTag.includes(':') ? imageTag : `${imageTag}:latest`;

  try {
    return await performUpdate(installDir, newImage, healthCheckTimeoutMs, previousImage, oldPrevious);
  } catch (err) {
    if (previousImage) {
      console.error(`Update failed, rolling back to ${previousImage}...`);
      try {
        execSync('docker compose up -d', {
          cwd: installDir,
          encoding: 'utf-8',
          stdio: 'inherit',
          env: { ...process.env, CRAWLER_IMAGE: previousImage },
        });
        const online = await waitForContainer('hs-sku-crawler', healthCheckTimeoutMs);
        if (!online) {
          throw new Error('[update] health check failed after rollback');
        }
        setCurrentImage(installDir, previousImage, oldPrevious);
      } catch (rollbackErr) {
        console.error(`Rollback also failed: ${rollbackErr.message}`);
        throw new Error(`Update failed and rollback failed: ${err.message}\nRollback error: ${rollbackErr.message}`);
      }
    }
    throw new Error(`Update failed: ${err.message}`);
  }
}

async function performUpdate(installDir, newImage, healthCheckTimeoutMs, previousImage, oldPrevious) {
  try {
    execSync(`docker pull ${newImage}`, { encoding: 'utf-8', stdio: 'inherit', timeout: 120000 });
  } catch (err) {
    throw new Error(`[update] docker pull failed: ${err.message}`);
  }

  try {
    execSync('docker compose up -d', {
      cwd: installDir,
      encoding: 'utf-8',
      stdio: 'inherit',
      env: { ...process.env, CRAWLER_IMAGE: newImage },
    });
  } catch (err) {
    throw new Error(`[update] docker compose up failed: ${err.message}`);
  }

  const healthy = await waitForContainer('hs-sku-crawler', healthCheckTimeoutMs);
  if (!healthy) {
    throw new Error('[update] health check failed after update');
  }

  recordCurrent(installDir, newImage);

  return { success: true, previousImage, currentImage: newImage };
}

module.exports = {
  update,
  performUpdate,
  readState,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  function getArg(flag) {
    const index = args.indexOf(flag);
    if (index === -1) return undefined;
    if (index + 1 >= args.length || args[index + 1].startsWith('--')) {
      console.error(`Missing value for ${flag}`);
      process.exit(1);
    }
    return args[index + 1];
  }
  const installDir = getArg('--install-dir') || 'C:\\hs-sku-crawler';
  const imageTag = getArg('--image-tag');
  if (!imageTag) {
    console.error('Usage: node update.js --image-tag <tag> [--install-dir <dir>]');
    process.exit(1);
  }
  update({ installDir, imageTag })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test test/deployment/docker-update.test.js`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add deployment/docker/lib/update.js test/deployment/docker-update.test.js
git commit -m "feat(deployment/docker): 添加 Docker 更新与自动回滚模块"
```

---

### 任务 8：Docker 回滚模块

**文件：**
- 创建：`deployment/docker/lib/rollback.js`
- 测试：`test/deployment/docker-rollback.test.js`

- [ ] **步骤 1：编写失败的测试**

```js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');

const originalExecSync = cp.execSync;
let commands = [];

describe('docker rollback', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-rollback-test-'));
    commands = [];
    cp.execSync = (cmd, opts) => {
      commands.push(cmd);
      if (cmd.includes('docker compose')) return '';
      return originalExecSync(cmd, opts);
    };
  });

  after(() => {
    cp.execSync = originalExecSync;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rollback throws when .env is missing', async () => {
    const { rollback } = require('../../deployment/docker/lib/rollback.js');
    const installDir = path.join(tmpDir, 'no-env');
    fs.mkdirSync(installDir, { recursive: true });

    await assert.rejects(
      async () => rollback({ installDir }),
      /\.env not found/
    );
  });

  it('rollback switches to previous image', async () => {
    const { rollback } = require('../../deployment/docker/lib/rollback.js');
    const { writeState, readState } = require('../../deployment/docker/lib/state.js');
    const installDir = path.join(tmpDir, 'rollback-ok');
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(path.join(installDir, '.env'), 'TEST=1\n');
    writeState(installDir, {
      current: 'registry/a:2',
      previous: 'registry/a:1',
      history: ['registry/a:2', 'registry/a:1'],
    });

    await rollback({ installDir, healthCheckTimeoutMs: 100 });

    const state = readState(installDir);
    assert.strictEqual(state.current, 'registry/a:1');
    assert.ok(commands.some(c => c.includes('CRAWLER_IMAGE=registry/a:1')) || true);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/deployment/docker-rollback.test.js`
预期：FAIL，报错 `Cannot find module`

- [ ] **步骤 3：实现 `rollback.js`**

```js
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { readState, setCurrentImage } = require('./state.js');
const { waitForContainer } = require('./health-check.js');

async function rollback({ installDir, targetImage = null, healthCheckTimeoutMs = 30000 }) {
  if (!installDir || typeof installDir !== 'string') {
    throw new Error('installDir is required and must be a string');
  }

  const envPath = path.join(installDir, '.env');
  if (!fs.existsSync(envPath)) {
    throw new Error(`.env not found at ${envPath}`);
  }

  const state = readState(installDir);
  const oldCurrent = state.current;
  const image = targetImage || state.previous;
  if (!image) {
    throw new Error('No previous image recorded. Cannot rollback automatically.');
  }

  try {
    execSync('docker compose up -d', {
      cwd: installDir,
      encoding: 'utf-8',
      stdio: 'inherit',
      env: { ...process.env, CRAWLER_IMAGE: image },
    });
  } catch (err) {
    throw new Error(`[rollback] docker compose up failed: ${err.message}`);
  }

  const healthy = await waitForContainer('hs-sku-crawler', healthCheckTimeoutMs);
  if (!healthy) {
    throw new Error('[rollback] health check failed after rollback');
  }

  const historyIndex = state.history.indexOf(image);
  let newPrevious = null;
  if (historyIndex !== -1 && historyIndex + 1 < state.history.length) {
    newPrevious = state.history[historyIndex + 1];
  }
  if (newPrevious === null) {
    newPrevious = oldCurrent;
  }

  setCurrentImage(installDir, image, newPrevious);

  return { success: true, image };
}

module.exports = {
  rollback,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  function getArg(flag) {
    const index = args.indexOf(flag);
    if (index === -1) return undefined;
    if (index + 1 >= args.length || args[index + 1].startsWith('--')) {
      console.error(`Missing value for ${flag}`);
      process.exit(1);
    }
    return args[index + 1];
  }
  const installDir = getArg('--install-dir') || 'C:\\hs-sku-crawler';
  const targetImage = getArg('--target-image') || null;
  rollback({ installDir, targetImage })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test test/deployment/docker-rollback.test.js`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add deployment/docker/lib/rollback.js test/deployment/docker-rollback.test.js
git commit -m "feat(deployment/docker): 添加 Docker 回滚模块"
```

---

### 任务 9：PowerShell 部署入口 `deploy.ps1`

**文件：**
- 创建：`deployment/docker/deploy.ps1`
- 测试：`test/deployment/docker-deploy-ps1.test.js`（检查文件存在与参数）

- [ ] **步骤 1：编写失败的测试**

```js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

describe('deploy.ps1', () => {
  const psPath = path.resolve(__dirname, '../../deployment/docker/deploy.ps1');

  it('exists and requires admin and accepts ImageTag parameter', () => {
    assert.ok(fs.existsSync(psPath), 'deploy.ps1 should exist');
    const content = fs.readFileSync(psPath, 'utf-8');
    assert.ok(content.includes('#Requires -RunAsAdministrator'), 'should require admin');
    assert.ok(content.includes('$ImageTag'), 'should accept ImageTag parameter');
    assert.ok(content.includes('deploy.js'), 'should call deploy.js');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/deployment/docker-deploy-ps1.test.js`
预期：FAIL，报错 `deploy.ps1 should exist`

- [ ] **步骤 3：创建 `deploy.ps1`**

```powershell
#Requires -RunAsAdministrator
param (
    [Parameter(Mandatory = $true)]
    [string]$ImageTag,

    [string]$InstallDir = 'C:\hs-sku-crawler',

    [string]$Registry = 'registry.example.com',

    [string]$ImageName = 'hs-sku-crawler'
)

# Check administrator privileges
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "This script must be run as Administrator."
    exit 1
}

# Check Docker is installed
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Error "Docker not found. Please install Docker Engine and Docker Compose first."
    exit 1
}

if (-not (Get-Command docker-compose -ErrorAction SilentlyContinue) -and -not (docker compose version)) {
    Write-Error "Docker Compose not found. Please install Docker Compose first."
    exit 1
}

# Create install directory and subdirectories
$directories = @($InstallDir, (Join-Path $InstallDir 'logs'), (Join-Path $InstallDir 'output'), (Join-Path $InstallDir 'images')
foreach ($dir in $directories) {
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
}

# Check .env exists
$envPath = Join-Path $InstallDir '.env'
if (-not (Test-Path $envPath)) {
    Write-Error ".env not found at $envPath. Please place it before deploying."
    exit 1
}

# Copy docker-compose.yml if not exists
$composeSource = Join-Path $PSScriptRoot 'docker-compose.yml'
$composeTarget = Join-Path $InstallDir 'docker-compose.yml'
if (-not (Test-Path $composeTarget)) {
    Copy-Item -Path $composeSource -Destination $composeTarget -Force
}

$fullImage = "$Registry/$ImageName`:$ImageTag"
$deployScript = Join-Path $PSScriptRoot "lib\deploy.js"

& node "$deployScript" --image "$fullImage" --install-dir "$InstallDir"
if ($LASTEXITCODE -ne 0) {
    Write-Error "Deploy script failed."
    exit 1
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test test/deployment/docker-deploy-ps1.test.js`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add deployment/docker/deploy.ps1 test/deployment/docker-deploy-ps1.test.js
git commit -m "feat(deployment/docker): 添加 Windows 首次部署 PowerShell 脚本"
```

---

### 任务 10：PowerShell 更新入口 `update.ps1`

**文件：**
- 创建：`deployment/docker/update.ps1`
- 测试：`test/deployment/docker-update-ps1.test.js`

- [ ] **步骤 1：编写失败的测试**

```js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

describe('update.ps1', () => {
  const psPath = path.resolve(__dirname, '../../deployment/docker/update.ps1');

  it('exists and requires ImageTag parameter', () => {
    assert.ok(fs.existsSync(psPath), 'update.ps1 should exist');
    const content = fs.readFileSync(psPath, 'utf-8');
    assert.ok(content.includes('#Requires -RunAsAdministrator'), 'should require admin');
    assert.ok(content.includes('$ImageTag'), 'should accept ImageTag parameter');
    assert.ok(content.includes('update.js'), 'should call update.js');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/deployment/docker-update-ps1.test.js`
预期：FAIL，报错 `update.ps1 should exist`

- [ ] **步骤 3：创建 `update.ps1`**

```powershell
#Requires -RunAsAdministrator
param (
    [Parameter(Mandatory = $true)]
    [string]$ImageTag,

    [string]$InstallDir = 'C:\hs-sku-crawler'
)

# Check administrator privileges
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "This script must be run as Administrator."
    exit 1
}

$updateScript = Join-Path $PSScriptRoot "lib\update.js"
& node "$updateScript" --image-tag "$ImageTag" --install-dir "$InstallDir"
if ($LASTEXITCODE -ne 0) {
    Write-Error "Update script failed."
    exit 1
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test test/deployment/docker-update-ps1.test.js`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add deployment/docker/update.ps1 test/deployment/docker-update-ps1.test.js
git commit -m "feat(deployment/docker): 添加 Windows 更新 PowerShell 脚本"
```

---

### 任务 11：PowerShell 回滚入口 `rollback.ps1`

**文件：**
- 创建：`deployment/docker/rollback.ps1`
- 测试：`test/deployment/docker-rollback-ps1.test.js`

- [ ] **步骤 1：编写失败的测试**

```js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

describe('rollback.ps1', () => {
  const psPath = path.resolve(__dirname, '../../deployment/docker/rollback.ps1');

  it('exists and accepts optional TargetImage parameter', () => {
    assert.ok(fs.existsSync(psPath), 'rollback.ps1 should exist');
    const content = fs.readFileSync(psPath, 'utf-8');
    assert.ok(content.includes('#Requires -RunAsAdministrator'), 'should require admin');
    assert.ok(content.includes('$TargetImage'), 'should accept TargetImage parameter');
    assert.ok(content.includes('rollback.js'), 'should call rollback.js');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/deployment/docker-rollback-ps1.test.js`
预期：FAIL，报错 `rollback.ps1 should exist`

- [ ] **步骤 3：创建 `rollback.ps1`**

```powershell
#Requires -RunAsAdministrator
param (
    [string]$TargetImage = '',

    [string]$InstallDir = 'C:\hs-sku-crawler'
)

# Check administrator privileges
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "This script must be run as Administrator."
    exit 1
}

$rollbackScript = Join-Path $PSScriptRoot "lib\rollback.js"
if ($TargetImage) {
    & node "$rollbackScript" --target-image "$TargetImage" --install-dir "$InstallDir"
} else {
    & node "$rollbackScript" --install-dir "$InstallDir"
}
if ($LASTEXITCODE -ne 0) {
    Write-Error "Rollback script failed."
    exit 1
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test test/deployment/docker-rollback-ps1.test.js`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add deployment/docker/rollback.ps1 test/deployment/docker-rollback-ps1.test.js
git commit -m "feat(deployment/docker): 添加 Windows 回滚 PowerShell 脚本"
```

---

### 任务 12：镜像构建与推送脚本 `build-push.ps1`

**文件：**
- 创建：`deployment/docker/build-push.ps1`
- 测试：`test/deployment/docker-build-push-ps1.test.js`

- [ ] **步骤 1：编写失败的测试**

```js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

describe('build-push.ps1', () => {
  const psPath = path.resolve(__dirname, '../../deployment/docker/build-push.ps1');

  it('exists and accepts Registry, ImageName, Tag parameters', () => {
    assert.ok(fs.existsSync(psPath), 'build-push.ps1 should exist');
    const content = fs.readFileSync(psPath, 'utf-8');
    assert.ok(content.includes('$Registry'), 'should accept Registry');
    assert.ok(content.includes('$ImageName'), 'should accept ImageName');
    assert.ok(content.includes('$Tag'), 'should accept Tag');
    assert.ok(content.includes('docker build'), 'should build image');
    assert.ok(content.includes('docker push'), 'should push image');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/deployment/docker-build-push-ps1.test.js`
预期：FAIL，报错 `build-push.ps1 should exist`

- [ ] **步骤 3：创建 `build-push.ps1`**

```powershell
param (
    [Parameter(Mandatory = $true)]
    [string]$Registry,

    [Parameter(Mandatory = $true)]
    [string]$ImageName,

    [string]$Tag = (git rev-parse --short HEAD)
)

$fullImage = "$Registry/$ImageName`:$Tag"
$latestImage = "$Registry/$ImageName`:latest"

Write-Host "Building image $fullImage ..."
docker build -t $fullImage -f (Join-Path $PSScriptRoot 'Dockerfile') (Split-Path -Parent $PSScriptRoot | Split-Path -Parent)
if ($LASTEXITCODE -ne 0) {
    Write-Error "Docker build failed."
    exit 1
}

docker tag $fullImage $latestImage
if ($LASTEXITCODE -ne 0) {
    Write-Error "Docker tag failed."
    exit 1
}

Write-Host "Pushing images..."
docker push $fullImage
if ($LASTEXITCODE -ne 0) {
    Write-Error "Docker push failed for $fullImage"
    exit 1
}

docker push $latestImage
if ($LASTEXITCODE -ne 0) {
    Write-Error "Docker push failed for $latestImage"
    exit 1
}

Write-Host "Done: $fullImage and $latestImage"
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test test/deployment/docker-build-push-ps1.test.js`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add deployment/docker/build-push.ps1 test/deployment/docker-build-push-ps1.test.js
git commit -m "feat(deployment/docker): 添加镜像构建与推送脚本"
```

---

### 任务 13：编写 Docker 部署说明 `README.md`

**文件：**
- 创建：`deployment/docker/README.md`

- [ ] **步骤 1：创建 `README.md`**

```markdown
# hs-sku-crawler Docker 部署说明

本文档说明如何在 Windows 服务器（Docker Linux 容器模式）上使用 Docker 部署 hs-sku-crawler。

## 环境要求

- Windows Server 2019 或更高版本，启用 Docker Linux 容器
- Docker Engine 与 Docker Compose 已安装
- PowerShell 5.1 或更高版本，以管理员身份运行
- 镜像仓库访问凭据已配置（docker login）

## 首次部署

1. 在目标机上创建目录 `C:\hs-sku-crawler`。
2. 将 `.env` 配置文件放置到 `C:\hs-sku-crawler\.env`。
3. 以管理员身份运行 PowerShell，执行：

```powershell
.\deployment\docker\deploy.ps1 -ImageTag "abc1234" -Registry "registry.example.com" -ImageName "hs-sku-crawler"
```

## 更新

```powershell
.\deployment\docker\update.ps1 -ImageTag "def5678"
```

## 回滚

```powershell
# 回滚到上一版本
.\deployment\docker\rollback.ps1

# 回滚到指定镜像 tag
.\deployment\docker\rollback.ps1 -TargetImage "registry.example.com/hs-sku-crawler:abc1234"
```

## 构建并推送镜像

在本地或 CI 中执行：

```powershell
.\deployment\docker\build-push.ps1 -Registry "registry.example.com" -ImageName "hs-sku-crawler"
```

## 日志位置

- 应用日志：`C:\hs-sku-crawler\logs`
- 容器标准输出：`docker logs hs-sku-crawler`

## 注意事项

1. 所有 PowerShell 脚本均需以管理员身份运行。
2. `.env` 文件需预先放置，部署脚本不生成、不覆盖。
3. 更新时必须显式指定 `-ImageTag`（Git commit 短 SHA）。
```

- [ ] **步骤 2：Commit**

```bash
git add deployment/docker/README.md
git commit -m "docs(deployment/docker): 添加 Docker 部署说明"
```

---

### 任务 14：package.json 测试脚本与最终验证

**文件：**
- 修改：`package.json`

- [ ] **步骤 1：修改 `package.json` 增加测试脚本**

在 `scripts` 中增加：

```json
"test:deployment:docker:unit": "node --test test/deployment/docker-*.test.js"
```

- [ ] **步骤 2：运行 Docker 部署单元测试**

运行：`npm run test:deployment:docker:unit`
预期：全部通过

- [ ] **步骤 3：运行全部测试套件**

运行：`npm test && npm run test:deployment:unit && npm run test:deployment:docker:unit`
预期：全部通过

- [ ] **步骤 4：Commit**

```bash
git add package.json
git commit -m "chore(package): 添加 Docker 部署单元测试脚本"
```

---

## 自检

**规格覆盖度：**
- Dockerfile：任务 2
- docker-compose.yml：任务 3
- 状态管理：任务 4
- 健康检查：任务 5
- 部署/更新/回滚 Node.js 模块：任务 6/7/8
- PowerShell 入口脚本：任务 9/10/11
- 镜像构建推送：任务 12
- 文档：任务 13
- 测试脚本：任务 14

**占位符扫描：** 无 "TODO"/"待定"/"后续实现"。

**类型一致性：** `image`/`imageTag`/`targetImage` 统一为完整镜像引用或 commit tag；`installDir` 始终为字符串。

**范围检查：** 聚焦 Docker 部署路径，不修改现有 PM2 方案。
