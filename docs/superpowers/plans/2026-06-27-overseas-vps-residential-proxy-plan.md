# 海外 VPS + Cliproxy 住宅代理生产化实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 hs-sku-crawler 从本地 PM2 部署升级为单节点欧洲 VPS + Cliproxy 海外动态住宅代理的生产化部署。

**架构：** 在欧洲 Hetzner VPS 上以 Docker Compose 运行爬虫服务，每个 Playwright channel 通过 Cliproxy 粘性会话获得独立欧洲住宅 IP；任务仍从国内上游 API 拉取，结果回调回国内上游 API。

**技术栈：** Node.js 20、Playwright、Docker、Docker Compose、Bash、Cliproxy 住宅代理。

---

## 文件清单

### 新建文件

| 文件 | 职责 |
|------|------|
| `src/cliproxy-pool.js` | 为每个 channel 生成 Cliproxy 粘性代理 URL，管理 session ID 和换 IP 冷却 |
| `test/cliproxy-pool.test.js` | CliproxyPool 单元测试 |
| `deployment/linux/docker-compose.yml` | 海外 VPS 的 Docker Compose 配置 |
| `deployment/linux/deploy.sh` | VPS 首次部署脚本 |
| `deployment/linux/update.sh` | VPS 更新脚本（记录回滚版本） |
| `deployment/linux/rollback.sh` | VPS 回滚脚本 |
| `deployment/linux/.env.example` | VPS 环境变量模板 |
| `test/deployment/linux-deploy.test.js` | Linux deploy.sh 脚本测试 |
| `test/deployment/linux-update.test.js` | Linux update.sh 脚本测试 |
| `test/deployment/linux-rollback.test.js` | Linux rollback.sh 脚本测试 |

### 修改文件

| 文件 | 修改内容 |
|------|---------|
| `deployment/docker/Dockerfile` | cherry-pick 后改为非 root 用户运行、CMD 由 .env 控制 mode |
| `src/cli.js` | 增加 CLIPROXY_* 环境变量映射 |
| `src/service.js` | 在 Kuaidaili 分支旁增加 CliproxyPool 集成 |
| `.env` | 增加 Cliproxy 配置示例（注释状态，不填真实值） |
| `README.md` | 增加海外 VPS 部署章节 |

### 来源文件（从 `feature/docker-deployment` cherry-pick/复制）

| 来源 | 目标 |
|------|------|
| `feature/docker-deployment/deployment/docker/Dockerfile` | `deployment/docker/Dockerfile` |
| `feature/docker-deployment/deployment/docker/docker-compose.yml` | `deployment/docker/docker-compose.yml` |
| `feature/docker-deployment/deployment/docker/.dockerignore` | `deployment/docker/.dockerignore` |
| `feature/docker-deployment/deployment/docker/README.md` | `deployment/docker/README.md` |
| `feature/docker-deployment/deployment/docker/lib/*.js` | `deployment/docker/lib/*.js` |
| `feature/docker-deployment/deployment/docker/*.ps1` | `deployment/docker/*.ps1` |
| `feature/docker-deployment/test/deployment/docker-*.test.js` | `test/deployment/docker-*.test.js` |

---

## 前置准备

### 工作区要求

- 从 `main` 切出新 worktree，不要直接在 `feature/docker-deployment` 上工作
- `feature/docker-deployment` 的 `src/` 落后于 `main`，只复制 Docker 相关文件

### 需要用户提前准备的信息

- Cliproxy 账号的 `host:port`、`username`、`password`
- 实际出口区域参数（如 `EU`、`DE`、`FR`）
- Docker 镜像仓库地址（如 `ghcr.io/your-org/hs-sku-crawler` 或 Docker Hub）

---

## 任务 1：创建隔离工作区

**文件：**
- 创建 worktree 目录：`.claude/worktrees/overseas-vps-proxy`

- [ ] **步骤 1：从 main 创建新 worktree**

```bash
git worktree add .claude/worktrees/overseas-vps-proxy main
cd .claude/worktrees/overseas-vps-proxy
```

- [ ] **步骤 2：确认当前分支和基线**

```bash
git branch --show-current
git log --oneline -3
```

预期输出：

```text
main
xxxxx docs(specs): 海外 VPS + Cliproxy 住宅代理生产化方案设计
xxxxx fix(dashboard): ...
```

- [ ] **步骤 3：Commit 工作区初始化**

```bash
git commit --allow-empty -m "chore: 创建 overseas-vps-proxy 实现工作区"
```

---

## 任务 2：迁移 Docker 部署文件

**文件：**
- 创建：`deployment/docker/Dockerfile`
- 创建：`deployment/docker/docker-compose.yml`
- 创建：`deployment/docker/.dockerignore`
- 创建：`deployment/docker/README.md`
- 创建：`deployment/docker/lib/*.js`
- 创建：`deployment/docker/*.ps1`
- 创建：`test/deployment/docker-*.test.js`

- [ ] **步骤 1：从 feature/docker-deployment 复制 Docker 文件**

```bash
cd .claude/worktrees/overseas-vps-proxy
mkdir -p deployment/docker/lib test/deployment

# 使用 git show 从 feature/docker-deployment 分支复制文件
for f in deployment/docker/Dockerfile deployment/docker/docker-compose.yml deployment/docker/.dockerignore deployment/docker/README.md; do
  git show feature/docker-deployment:"$f" > "$f"
done

for f in deployment/docker/lib/*.js; do
  git show feature/docker-deployment:"$f" > "$f"
done

for f in deployment/docker/*.ps1; do
  git show feature/docker-deployment:"$f" > "$f"
done

for f in test/deployment/docker-*.test.js; do
  git show feature/docker-deployment:"$f" > "$f"
done
```

- [ ] **步骤 2：验证文件已复制**

```bash
find deployment/docker -type f | sort
find test/deployment -name "docker-*" -type f | sort
```

- [ ] **步骤 3：运行 Docker 部署单元测试**

```bash
npm run test:deployment:unit
```

预期：全部通过（基于 feature/docker-deployment 的已有测试）。

- [ ] **步骤 4：Commit**

```bash
git add deployment/docker test/deployment/docker-*.test.js
git commit -m "chore(deployment): 从 feature/docker-deployment 迁移 Docker 部署文件"
```

---

## 任务 3：实现 CliproxyPool

**文件：**
- 创建：`src/cliproxy-pool.js`

- [ ] **步骤 1：编写失败的测试**

创建 `test/cliproxy-pool.test.js`：

```js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CliproxyPool } = require('../src/cliproxy-pool');

function createPool(options = {}, assignmentsFile = null) {
  return new CliproxyPool({
    host: 'test.cliproxy.io',
    port: 1080,
    username: 'testuser',
    password: 'testpass',
    region: 'EU',
    stickyMinutes: 30,
    sessionPrefix: 'crawler-eu-01',
    channels: 2,
    assignmentsFile: assignmentsFile || path.join(os.tmpdir(), `cliproxy-${Date.now()}.json`),
    ...options,
  });
}

describe('CliproxyPool', () => {
  it('generates a sticky proxy URL per channel', async () => {
    const pool = createPool();
    const map = await pool.assign();

    assert.deepStrictEqual(Object.keys(map).sort(), ['ch-1', 'ch-2']);
    assert.ok(map['ch-1'].startsWith('http://testuser-region-EU-sid-crawler-eu-01-ch1-'));
    assert.ok(map['ch-1'].includes(':testpass@test.cliproxy.io:1080'));
    assert.notStrictEqual(map['ch-1'], map['ch-2']);

    try { fs.unlinkSync(pool.assignmentsFile); } catch (e) {}
  });

  it('reuses previous assignment on restart', async () => {
    const assignmentsFile = path.join(os.tmpdir(), `cliproxy-${Date.now()}.json`);
    const pool1 = createPool({}, assignmentsFile);
    const map1 = await pool1.assign();

    const pool2 = createPool({}, assignmentsFile);
    const map2 = await pool2.assign();

    assert.strictEqual(map1['ch-1'], map2['ch-1']);
    assert.strictEqual(map1['ch-2'], map2['ch-2']);

    try { fs.unlinkSync(assignmentsFile); } catch (e) {}
  });

  it('rotates to a new URL on nextForChannel', async () => {
    const pool = createPool();
    await pool.assign();
    const oldUrl = pool.getProxyForChannel('ch-1');

    const newUrl = await pool.nextForChannel('ch-1');

    assert.notStrictEqual(newUrl, oldUrl);
    assert.strictEqual(pool.getProxyForChannel('ch-1'), newUrl);

    try { fs.unlinkSync(pool.assignmentsFile); } catch (e) {}
  });

  it('respects rotation cooldown', async () => {
    const pool = createPool({ rotationCooldownMs: 1000 });
    await pool.assign();
    const oldUrl = pool.getProxyForChannel('ch-1');

    const newUrl = await pool.nextForChannel('ch-1');
    const newUrl2 = await pool.nextForChannel('ch-1');

    assert.notStrictEqual(newUrl, oldUrl);
    assert.strictEqual(newUrl, newUrl2);

    try { fs.unlinkSync(pool.assignmentsFile); } catch (e) {}
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
node --test test/cliproxy-pool.test.js
```

预期：报错 `Cannot find module '../src/cliproxy-pool'`。

- [ ] **步骤 3：实现 CliproxyPool**

创建 `src/cliproxy-pool.js`：

```js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class CliproxyPool {
  constructor(options) {
    this.host = options.host;
    this.port = Number(options.port);
    this.username = options.username;
    this.password = options.password;
    this.region = options.region || 'EU';
    this.stickyMinutes = Number(options.stickyMinutes || 30);
    this.sessionPrefix = options.sessionPrefix || 'crawler';
    this.channels = Number(options.channels || 1);
    this.assignmentsFile = options.assignmentsFile || path.resolve('./cliproxy-assignments.json');
    this.rotationCooldownMs = Number(options.rotationCooldownMs || 5 * 60 * 1000);
    this.currentAssignments = {};
    this.nonces = {};
    this.lastRotation = {};
  }

  generateNonce() {
    return crypto.randomBytes(4).toString('hex');
  }

  buildProxyUrl(channelId, nonce) {
    const sid = `${this.sessionPrefix}-${channelId}-${nonce}`;
    const user = `${this.username}-region-${this.region}-sid-${sid}-t-${this.stickyMinutes}`;
    return `http://${user}:${this.password}@${this.host}:${this.port}`;
  }

  loadAssignments() {
    try {
      const raw = fs.readFileSync(this.assignmentsFile, 'utf-8');
      return JSON.parse(raw);
    } catch (e) {
      return {};
    }
  }

  saveAssignments(assignments) {
    const dir = path.dirname(this.assignmentsFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.assignmentsFile, JSON.stringify(assignments, null, 2), 'utf-8');
  }

  async assign() {
    const previous = this.loadAssignments();
    const assignments = {};

    for (let i = 1; i <= this.channels; i++) {
      const channelId = `ch-${i}`;
      const previousUrl = previous[channelId];
      let nonce;

      if (previousUrl && typeof previousUrl === 'string') {
        const match = previousUrl.match(/sid-[^-]+-([^-]+)-([a-f0-9]+)-t-/);
        nonce = match ? match[2] : this.generateNonce();
      } else {
        nonce = this.generateNonce();
      }

      assignments[channelId] = this.buildProxyUrl(channelId, nonce);
      this.nonces[channelId] = nonce;
    }

    this.currentAssignments = assignments;
    this.saveAssignments(assignments);
    return assignments;
  }

  getProxyForChannel(channelId) {
    return this.currentAssignments[channelId];
  }

  async nextForChannel(channelId) {
    const now = Date.now();
    const last = this.lastRotation[channelId] || 0;

    if (now - last < this.rotationCooldownMs) {
      return this.currentAssignments[channelId];
    }

    const nonce = this.generateNonce();
    this.nonces[channelId] = nonce;
    this.lastRotation[channelId] = now;
    const url = this.buildProxyUrl(channelId, nonce);
    this.currentAssignments[channelId] = url;
    this.saveAssignments(this.currentAssignments);
    return url;
  }

  async refresh() {
    return this.assign();
  }
}

module.exports = { CliproxyPool };
```

- [ ] **步骤 4：运行测试验证通过**

```bash
node --test test/cliproxy-pool.test.js
```

预期：4 个测试全部通过。

- [ ] **步骤 5：Commit**

```bash
git add src/cliproxy-pool.js test/cliproxy-pool.test.js
git commit -m "feat(proxy): 实现 Cliproxy 粘性代理池"
```

---

## 任务 4：CLI 环境变量映射

**文件：**
- 修改：`src/cli.js`
- 修改：`test/cli-proxy-pool.test.js`（新增断言）

- [ ] **步骤 1：编写失败的测试**

在 `test/cli-proxy-pool.test.js` 中新增测试：

```js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { parse } = require('../src/cli');

describe('CLI Cliproxy env mapping', () => {
  it('maps CLIPROXY_* environment variables to config', () => {
    process.env.CLIPROXY_HOST = 'eu.cliproxy.io';
    process.env.CLIPROXY_PORT = '1080';
    process.env.CLIPROXY_USERNAME = 'user';
    process.env.CLIPROXY_PASSWORD = 'pass';
    process.env.CLIPROXY_REGION = 'EU';
    process.env.CLIPROXY_STICKY_MINUTES = '30';
    process.env.CLIPROXY_SESSION_PREFIX = 'crawler-eu-01';

    try {
      const config = parse([]);
      assert.strictEqual(config.cliproxyHost, 'eu.cliproxy.io');
      assert.strictEqual(config.cliproxyPort, 1080);
      assert.strictEqual(config.cliproxyUsername, 'user');
      assert.strictEqual(config.cliproxyPassword, 'pass');
      assert.strictEqual(config.cliproxyRegion, 'EU');
      assert.strictEqual(config.cliproxyStickyMinutes, 30);
      assert.strictEqual(config.cliproxySessionPrefix, 'crawler-eu-01');
    } finally {
      delete process.env.CLIPROXY_HOST;
      delete process.env.CLIPROXY_PORT;
      delete process.env.CLIPROXY_USERNAME;
      delete process.env.CLIPROXY_PASSWORD;
      delete process.env.CLIPROXY_REGION;
      delete process.env.CLIPROXY_STICKY_MINUTES;
      delete process.env.CLIPROXY_SESSION_PREFIX;
    }
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
node --test test/cli-proxy-pool.test.js
```

预期：新测试失败，`config.cliproxyHost` 为 `undefined`。

- [ ] **步骤 3：在 src/cli.js 增加 CLIPROXY 映射**

在 `envMap` 末尾、`CRAWLER_PROXY: 'proxy'` 之前添加：

```js
CLIPROXY_HOST: 'cliproxyHost',
CLIPROXY_PORT: 'cliproxyPort',
CLIPROXY_USERNAME: 'cliproxyUsername',
CLIPROXY_PASSWORD: 'cliproxyPassword',
CLIPROXY_REGION: 'cliproxyRegion',
CLIPROXY_STICKY_MINUTES: 'cliproxyStickyMinutes',
CLIPROXY_SESSION_PREFIX: 'cliproxySessionPrefix',
CLIPROXY_ASSIGNMENTS_FILE: 'cliproxyAssignmentsFile',
```

- [ ] **步骤 4：运行测试验证通过**

```bash
node --test test/cli-proxy-pool.test.js
```

预期：全部通过。

- [ ] **步骤 5：Commit**

```bash
git add src/cli.js test/cli-proxy-pool.test.js
git commit -m "feat(cli): 增加 CLIPROXY 环境变量映射"
```

---

## 任务 5：Service 集成 CliproxyPool

**文件：**
- 修改：`src/service.js`
- 创建：`test/service-cliproxy.test.js`

- [ ] **步骤 1：编写失败的测试**

创建 `test/service-cliproxy.test.js`：

```js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { CrawlerService } = require('../src/service');

describe('CrawlerService Cliproxy integration', { timeout: 60000 }, () => {
  it('creates CliproxyPool when Cliproxy credentials are configured', async () => {
    const service = new CrawlerService({
      nodeCode: 'test-node',
      nodeToken: '',
      taskUrl: 'http://127.0.0.1:1/tasks',
      callbackUrl: 'http://127.0.0.1:1/callback',
      channels: 1,
      imageDir: '/tmp/test-images',
      cliproxyHost: 'test.cliproxy.io',
      cliproxyPort: 1080,
      cliproxyUsername: 'user',
      cliproxyPassword: 'pass',
      cliproxyRegion: 'EU',
      cliproxyStickyMinutes: 30,
      cliproxySessionPrefix: 'test',
    });

    // 手动初始化 proxyPool 部分验证
    service.ensureImageDir();
    await service.startProxyPool();

    assert.ok(service.proxyPool, 'proxyPool should be created');
    assert.ok(service.proxyPool.getProxyForChannel('ch-1'));
    assert.ok(service.proxyPool.getProxyForChannel('ch-1').includes('test.cliproxy.io'));

    // 清理
    try { await service.stop(); } catch (e) {}
  });
});
```

注意：这里依赖一个假设的 `startProxyPool()` 方法，如果实现时不拆分该方法，需要同步调整测试。

- [ ] **步骤 2：运行测试验证失败**

```bash
node --test test/service-cliproxy.test.js
```

预期：失败，可能是方法不存在或 proxyPool 未创建。

- [ ] **步骤 3：重构 service.js 提取 proxy pool 初始化方法**

修改 `src/service.js`：

1. 文件顶部引入 CliproxyPool：

```js
const { CliproxyPool } = require('./cliproxy-pool');
```

2. 将 `start()` 中的 proxy pool 初始化逻辑提取为 `startProxyPool()` 方法：

```js
async startProxyPool() {
  if (this.config.proxy) {
    return;
  }

  if (this.config.kuaidailiSecretId && this.config.kuaidailiSecretKey) {
    const client = new KuaidailiClient({
      secretId: this.config.kuaidailiSecretId,
      secretKey: this.config.kuaidailiSecretKey,
      proxyType: this.config.kuaidailiProxyType,
      proxyNum: this.config.kuaidailiProxyNum,
      tokenCacheFile: this.config.kuaidailiTokenCacheFile,
    });
    this.proxyPool = new ProxyPool({
      client,
      machineIndex: this.config.proxyMachineIndex,
      machineTotal: this.config.proxyMachineTotal,
      channels: this.config.channels,
      assignmentsFile: this.config.proxyAssignmentsFile,
    });
    await this.proxyPool.assign();
    this.startProxyRefresh();
    return;
  }

  if (this.config.cliproxyUsername && this.config.cliproxyPassword) {
    this.proxyPool = new CliproxyPool({
      host: this.config.cliproxyHost,
      port: this.config.cliproxyPort,
      username: this.config.cliproxyUsername,
      password: this.config.cliproxyPassword,
      region: this.config.cliproxyRegion,
      stickyMinutes: this.config.cliproxyStickyMinutes,
      sessionPrefix: this.config.cliproxySessionPrefix,
      channels: this.config.channels,
      assignmentsFile: this.config.cliproxyAssignmentsFile,
    });
    await this.proxyPool.assign();
    this.startProxyRefresh();
  }
}
```

3. 在 `start()` 中替换原有 proxy pool 初始化逻辑为：

```js
await this.startProxyPool();
```

- [ ] **步骤 4：运行测试验证通过**

```bash
node --test test/service-cliproxy.test.js
```

预期：测试通过。

- [ ] **步骤 5：运行现有 service 相关测试**

```bash
node --test test/service.integration.test.js test/service-proxy-pool.test.js
```

预期：全部通过。

- [ ] **步骤 6：Commit**

```bash
git add src/service.js test/service-cliproxy.test.js
git commit -m "feat(service): 集成 CliproxyPool 代理池"
```

---

## 任务 6：更新 Dockerfile

**文件：**
- 修改：`deployment/docker/Dockerfile`

- [ ] **步骤 1：编写 Dockerfile 测试**

创建 `test/deployment/dockerfile-user.test.js`：

```js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

describe('Dockerfile security', () => {
  it('uses a non-root user', () => {
    const dockerfile = fs.readFileSync(path.resolve('deployment/docker/Dockerfile'), 'utf-8');
    assert.ok(/USER\s+\S+/.test(dockerfile), 'Dockerfile should set a non-root USER');
    assert.ok(/groupadd/.test(dockerfile) || /useradd/.test(dockerfile), 'Dockerfile should create a non-root user');
  });

  it('does not hardcode --mode=service in CMD', () => {
    const dockerfile = fs.readFileSync(path.resolve('deployment/docker/Dockerfile'), 'utf-8');
    assert.ok(!/CMD\s*\[.*--mode=service/.test(dockerfile), 'CMD should not hardcode --mode=service');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
node --test test/deployment/dockerfile-user.test.js
```

预期：失败，当前 Dockerfile 使用 root 且硬编码 `--mode=service`。

- [ ] **步骤 3：修改 Dockerfile**

将 `deployment/docker/Dockerfile` 改为：

```dockerfile
FROM node:20-slim

# 安装系统依赖与 Chromium 所需库
RUN apt-get update && apt-get install -y \
    wget gnupg ca-certificates procps \
    libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 \
    libgbm1 libasound2 libxcomposite1 libxdamage1 libxfixes3 \
    libxrandr2 libgtk-3-0 libpango-1.0-0 libcairo2 \
    && rm -rf /var/lib/apt/lists/*

# 创建非 root 用户
RUN groupadd -r crawler && useradd -r -g crawler -d /app crawler

WORKDIR /app
RUN chown crawler:crawler /app
USER crawler

COPY --chown=crawler:crawler package*.json ./
RUN npm ci --only=production

# 安装 Playwright Chromium
RUN npx playwright install chromium

COPY --chown=crawler:crawler . .

ENV NODE_ENV=production

CMD ["node", "bin/run.js"]
```

- [ ] **步骤 4：运行测试验证通过**

```bash
node --test test/deployment/dockerfile-user.test.js
```

预期：通过。

- [ ] **步骤 5：Commit**

```bash
git add deployment/docker/Dockerfile test/deployment/dockerfile-user.test.js
git commit -m "fix(deployment): Dockerfile 使用非 root 用户，CMD 由 .env 控制 mode"
```

---

## 任务 7：创建 Linux 部署脚本

**文件：**
- 创建：`deployment/linux/docker-compose.yml`
- 创建：`deployment/linux/deploy.sh`
- 创建：`deployment/linux/update.sh`
- 创建：`deployment/linux/rollback.sh`
- 创建：`deployment/linux/.env.example`

- [ ] **步骤 1：创建 docker-compose.yml**

```yaml
version: "3.8"

services:
  crawler:
    image: ${CRAWLER_IMAGE:?未设置 CRAWLER_IMAGE 环境变量}
    container_name: hs-sku-crawler
    restart: unless-stopped
    env_file: .env
    environment:
      - CRAWLER_MODE=service
      - CRAWLER_NODE_CODE=${CRAWLER_NODE_CODE:-crawler-eu-01}
    volumes:
      - ./logs:/app/logs
      - ./output:/app/output
      - ./images:/app/images
    logging:
      driver: "json-file"
      options:
        max-size: "50m"
        max-file: "5"
```

- [ ] **步骤 2：创建 deploy.sh**

```bash
#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_TAG="${1:?请提供镜像 tag，例如 ./deploy.sh abc1234}"
export CRAWLER_IMAGE="${CRAWLER_IMAGE_BASE:?未设置 CRAWLER_IMAGE_BASE 环境变量}:${IMAGE_TAG}"

if [ ! -f .env ]; then
  echo "错误：当前目录缺少 .env 文件" >&2
  exit 1
fi

mkdir -p logs output images

docker compose pull
docker compose up -d

echo "部署完成：${CRAWLER_IMAGE}"
docker compose ps
```

- [ ] **步骤 3：创建 update.sh**

```bash
#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_TAG="${1:?请提供镜像 tag，例如 ./update.sh abc1234}"

CURRENT_IMAGE=$(docker inspect --format='{{.Config.Image}}' hs-sku-crawler 2>/dev/null || true)
if [ -n "$CURRENT_IMAGE" ]; then
  echo "$CURRENT_IMAGE" > .last_image
fi

export CRAWLER_IMAGE="${CRAWLER_IMAGE_BASE:?未设置 CRAWLER_IMAGE_BASE 环境变量}:${IMAGE_TAG}"

docker compose pull
docker compose up -d --no-deps crawler

echo "更新完成：${CRAWLER_IMAGE}"
```

- [ ] **步骤 4：创建 rollback.sh**

```bash
#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -f .last_image ]; then
  echo "错误：未找到 .last_image，无法回滚" >&2
  exit 1
fi

LAST_IMAGE=$(cat .last_image)
export CRAWLER_IMAGE="$LAST_IMAGE"

docker compose up -d --no-deps crawler

echo "回滚完成：${LAST_IMAGE}"
```

- [ ] **步骤 5：创建 .env.example**

```bash
# 上游 API
CRAWLER_NODE_CODE=crawler-eu-01
CRAWLER_NODE_TOKEN=your-node-token
CRAWLER_TASK_URL=http://117.72.52.0/renren-api/classify/open/crawler/tasks
CRAWLER_CALLBACK_URL=http://117.72.52.0/renren-api/classify/open/crawler/callback

# 服务配置
CRAWLER_MODE=service
CRAWLER_CHANNELS=2
CRAWLER_POLL_INTERVAL=5000
CRAWLER_POLL_LIMIT=5
CRAWLER_PUSH_RETRIES=3

# VEVOR 站点
CRAWLER_BASE_URL=https://eur.vevor.com
CRAWLER_HEADLESS=true
CRAWLER_HEADED_FALLBACK=false
CRAWLER_MAX_IMAGES=3
CRAWLER_CLOUDFLARE_MAX_WAIT=45
CRAWLER_MIN_DELAY=5
CRAWLER_MAX_DELAY=10

# Cliproxy 住宅代理（以控制台实际 host/port 为准）
CLIPROXY_HOST=eu.cliproxy.io
CLIPROXY_PORT=1080
CLIPROXY_USERNAME=your-cliproxy-username
CLIPROXY_PASSWORD=your-cliproxy-password
CLIPROXY_REGION=EU
CLIPROXY_STICKY_MINUTES=30
CLIPROXY_SESSION_PREFIX=crawler-eu-01
```

- [ ] **步骤 6：添加执行权限**

```bash
chmod +x deployment/linux/deploy.sh deployment/linux/update.sh deployment/linux/rollback.sh
```

- [ ] **步骤 7：Commit**

```bash
git add deployment/linux/
git commit -m "feat(deployment): 增加 Linux VPS 部署脚本与 compose 配置"
```

---

## 任务 8：测试 Linux 部署脚本

**文件：**
- 创建：`test/deployment/linux-deploy.test.js`
- 创建：`test/deployment/linux-update.test.js`
- 创建：`test/deployment/linux-rollback.test.js`

- [ ] **步骤 1：编写 deploy 脚本测试**

创建 `test/deployment/linux-deploy.test.js`：

```js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

describe('Linux deploy.sh', () => {
  const scriptPath = path.resolve('deployment/linux/deploy.sh');

  it('exists and is executable', () => {
    assert.ok(fs.existsSync(scriptPath), 'deploy.sh should exist');
    const stats = fs.statSync(scriptPath);
    assert.ok(stats.mode & 0o111, 'deploy.sh should be executable');
  });

  it('fails when no image tag is provided', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('${1:?'), 'deploy.sh should require image tag argument');
  });

  it('requires .env file', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('.env'), 'deploy.sh should check for .env file');
  });
});
```

- [ ] **步骤 2：编写 update 脚本测试**

创建 `test/deployment/linux-update.test.js`：

```js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

describe('Linux update.sh', () => {
  const scriptPath = path.resolve('deployment/linux/update.sh');

  it('exists and is executable', () => {
    assert.ok(fs.existsSync(scriptPath), 'update.sh should exist');
    const stats = fs.statSync(scriptPath);
    assert.ok(stats.mode & 0o111, 'update.sh should be executable');
  });

  it('records current image before updating', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('.last_image'), 'update.sh should record last image');
  });
});
```

- [ ] **步骤 3：编写 rollback 脚本测试**

创建 `test/deployment/linux-rollback.test.js`：

```js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

describe('Linux rollback.sh', () => {
  const scriptPath = path.resolve('deployment/linux/rollback.sh');

  it('exists and is executable', () => {
    assert.ok(fs.existsSync(scriptPath), 'rollback.sh should exist');
    const stats = fs.statSync(scriptPath);
    assert.ok(stats.mode & 0o111, 'rollback.sh should be executable');
  });

  it('requires .last_image file', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('.last_image'), 'rollback.sh should check for .last_image');
  });
});
```

- [ ] **步骤 4：运行测试**

```bash
node --test test/deployment/linux-deploy.test.js test/deployment/linux-update.test.js test/deployment/linux-rollback.test.js
```

预期：全部通过。

- [ ] **步骤 5：Commit**

```bash
git add test/deployment/linux-*.test.js
git commit -m "test(deployment): 增加 Linux 部署脚本单元测试"
```

---

## 任务 9：更新 .env 示例和 README

**文件：**
- 修改：`.env`
- 修改：`README.md`

- [ ] **步骤 1：在 .env 中增加 Cliproxy 示例**

在 `.env` 文件末尾追加（注释状态）：

```bash
# Cliproxy 海外住宅代理配置（以控制台实际 host/port 为准）
# 与 CRAWLER_PROXY 互斥，不要同时启用
# CLIPROXY_HOST=eu.cliproxy.io
# CLIPROXY_PORT=1080
# CLIPROXY_USERNAME=your-cliproxy-username
# CLIPROXY_PASSWORD=your-cliproxy-password
# CLIPROXY_REGION=EU
# CLIPROXY_STICKY_MINUTES=30
# CLIPROXY_SESSION_PREFIX=crawler-eu-01
```

- [ ] **步骤 2：在 README.md 增加海外 VPS 部署章节**

在 README 的 "Windows deployment" 之后新增一节：

```markdown
### 海外 VPS 部署（Linux + Docker + Cliproxy）

用于将爬虫部署到欧洲 VPS，通过 Cliproxy 住宅代理访问 `eur.vevor.com`。

#### 准备

1. 准备一台欧洲 VPS（推荐 Hetzner CPX31，4C8G）
2. 安装 Docker 和 Docker Compose
3. 准备 Cliproxy 账号

#### 部署步骤

```bash
cd deployment/linux
cp .env.example .env
# 编辑 .env，填入真实凭据
export CRAWLER_IMAGE_BASE=ghcr.io/your-org/hs-sku-crawler
./deploy.sh <git-commit-short-sha>
```

#### 更新

```bash
./update.sh <new-git-commit-short-sha>
```

#### 回滚

```bash
./rollback.sh
```
```

- [ ] **步骤 3：Commit**

```bash
git add .env README.md
git commit -m "docs: 增加 Cliproxy 配置示例与海外 VPS 部署说明"
```

---

## 任务 10：本地构建 Docker 镜像

**文件：**
- 修改：`deployment/docker/Dockerfile`（如需调整）

- [ ] **步骤 1：构建镜像**

```bash
cd .claude/worktrees/overseas-vps-proxy
docker build -t hs-sku-crawler:local -f deployment/docker/Dockerfile .
```

- [ ] **步骤 2：验证镜像能运行**

```bash
docker run --rm hs-sku-crawler:local node --version
docker run --rm hs-sku-crawler:local npx playwright --version
```

预期：输出 Node.js 版本和 Playwright 版本。

- [ ] **步骤 3：验证容器内用户非 root**

```bash
docker run --rm hs-sku-crawler:local id
```

预期：输出 `uid=... gid=... groups=...` 且不是 `uid=0`。

- [ ] **步骤 4：Commit（如果 Dockerfile 有调整）**

```bash
git add deployment/docker/Dockerfile
git commit -m "fix(deployment): 调整 Dockerfile 以支持本地构建验证" || true
```

---

## 任务 11：运行完整测试套件

- [ ] **步骤 1：运行单元测试**

```bash
npm test
```

预期：全部通过。

- [ ] **步骤 2：运行部署相关测试**

```bash
npm run test:deployment:unit
```

预期：全部通过。

- [ ] **步骤 3：运行集成测试**

```bash
npm run test:integration
```

预期：通过。

- [ ] **步骤 4：Commit（如测试配置有调整）**

```bash
git add package.json
npm run test:deployment:unit
git commit -m "chore(package): 调整测试脚本以包含 Linux 部署测试" || true
```

---

## 任务 12：真实环境 smoke test（手动）

**前置条件：**
- VPS 已创建并安装 Docker
- Docker 镜像已推送到仓库
- `.env` 已上传到 VPS

- [ ] **步骤 1：在 VPS 上首次部署**

```bash
ssh user@vps-ip
mkdir -p /opt/hs-sku-crawler
cd /opt/hs-sku-crawler
# 上传 .env、docker-compose.yml、deploy.sh、update.sh、rollback.sh
export CRAWLER_IMAGE_BASE=ghcr.io/your-org/hs-sku-crawler
./deploy.sh <commit-sha>
```

- [ ] **步骤 2：检查容器日志**

```bash
docker compose logs -f --tail 100 crawler
```

预期：看到 Poller 正常拉取任务、channel 初始化成功、任务被处理。

- [ ] **步骤 3：验证出口 IP**

在容器内临时执行：

```bash
docker compose exec crawler bash -c "curl -s -x \$CLIPROXY_HOST:\$CLIPROXY_PORT -U \$CLIPROXY_USERNAME:\$CLIPROXY_PASSWORD https://ipinfo.io/json"
```

预期：返回欧洲住宅 IP。

- [ ] **步骤 4：对比本地与 VPS 成功率**

- 上游 API 同时给本地和 VPS 分发任务（各 50%）
- 运行 1-2 小时
- 统计成功率、平均耗时、Cloudflare 拦截率

- [ ] **步骤 5：回滚测试**

```bash
./update.sh <new-commit-sha>
# 确认运行正常后
./rollback.sh
# 确认回滚到旧版本
```

---

## 任务 13：合并回 main

- [ ] **步骤 1：切回 main 并合并 worktree**

```bash
git checkout main
git pull origin main
git merge --no-ff overseas-vps-proxy
```

- [ ] **步骤 2：运行 main 分支完整测试**

```bash
npm test
npm run test:deployment:unit
npm run test:integration
```

- [ ] **步骤 3：Push 到远程**

```bash
git push origin main
```

- [ ] **步骤 4：清理 worktree（可选）**

```bash
git worktree remove .claude/worktrees/overseas-vps-proxy
```

---

## 自检

### 规格覆盖度

| 规格章节 | 实现任务 |
|---------|---------|
| 单节点欧洲 VPS | 任务 1、2、7、12 |
| Cliproxy 粘性代理 | 任务 3、4、5 |
| 降低延迟 | 任务 7（欧洲 VPS）、任务 12（IP 验证） |
| 避免拦截 | 任务 3（粘性会话）、任务 5（换 IP 策略） |
| 稳定运行 | 任务 6（非 root）、任务 7（部署脚本）、任务 11（测试） |
| 监控日志 | 任务 7（日志挂载）、任务 12（日志检查） |
| 基线合并风险 | 任务 1、2 |
| 验证测试 | 任务 10、11、12 |

### 占位符扫描

- 无 "TODO"、"FIXME"、"TBD"
- 脚本中的 `your-*` 只在 `.env.example` 中作为用户填写示例，符合预期
- 镜像仓库地址使用 `ghcr.io/your-org/hs-sku-crawler` 作为示例，README 中已说明替换

### 类型一致性

- `CliproxyPool` 的 `assign()`、`nextForChannel()`、`refresh()` 均为 async，与 `ProxyPool` 接口一致
- `service.js` 通过 `startProxyPool()` 统一初始化，Kuaidaili 和 Cliproxy 互斥逻辑一致
- `cli.js` 中环境变量映射键名与 `service.js` 中 config 键名一致

---

## 执行选项

**计划已完成并保存到 `docs/superpowers/plans/2026-06-27-overseas-vps-residential-proxy-plan.md`。两种执行方式：**

**1. 子代理驱动（推荐）** - 每个任务调度一个新的子代理，任务间进行审查，快速迭代

**2. 内联执行** - 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点

**选哪种方式？**
