# 海外 VPS + crawlab 自动化部署实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在单台海外 VPS 上实现 crawlab + hs-sku-crawler 同机部署,并接入 GitHub Actions 自动发布、HTTP 健康检查、结构化日志,最终让 push tag 即可自动部署。

**架构：** GitHub Actions 在 push tag 时构建 Docker 镜像并推送到 GHCR,随后 SSH 到 VPS 执行 `update.sh` 滚动重启 crawler;VPS 上 `deployment/crawlab/docker-compose.yml` 同时运行 crawlab、MongoDB、Redis、hs-sku-crawler;crawler 暴露 `/health` 端点供 crawlab 轮询;结构化日志写入 `./logs/crawler.jsonl`。

**技术栈：** Node.js 原生 `http`、Docker Compose、crawlab、MongoDB、Redis、GitHub Actions、GHCR。

---

## 文件结构

| 文件 | 类型 | 职责 |
|------|------|------|
| `src/service.js` | 修改 | 在 `CrawlerService` 中启动 `/health` HTTP 服务,并在 `stop()` 中关闭 |
| `src/logger.js` | 创建 | JSON Lines 日志格式化与输出 |
| `test/service-health.test.js` | 创建 | 验证 `/health` 端点返回正确 JSON |
| `test/logger.test.js` | 创建 | 验证 JSON 日志格式 |
| `deployment/crawlab/docker-compose.yml` | 创建 | crawlab + MongoDB + Redis + crawler 编排 |
| `deployment/crawlab/.env.example` | 创建 | crawlab 部署环境变量模板 |
| `deployment/crawlab/setup-vps.sh` | 创建 | VPS 首次一键初始化脚本 |
| `deployment/crawlab/deploy.sh` | 创建 | 首次启动脚本(基于 `deployment/linux/deploy.sh` 调整) |
| `deployment/crawlab/update.sh` | 创建 | 升级脚本(复用 `deployment/linux/update.sh` 逻辑) |
| `deployment/crawlab/rollback.sh` | 创建 | 回滚脚本(复用 `deployment/linux/rollback.sh` 逻辑) |
| `test/deployment/crawlab-docker-compose.test.js` | 创建 | 验证 docker-compose.yml 关键配置 |
| `test/deployment/crawlab-setup.test.js` | 创建 | 验证 setup-vps.sh 存在且可执行 |
| `.github/workflows/deploy-vps.yml` | 创建 | GitHub Actions CI/CD workflow |
| `test/github-workflow.test.js` | 创建 | 验证 workflow YAML 语法与必需 secrets |
| `部署vps.md` | 修改 | 新增 crawlab 章节与 GitHub Actions 章节 |

---

## 前置依赖

- 已合并 `main` 分支,且包含 `src/service.js`、`src/cliproxy-pool.js`、`deployment/linux/*` 等海外部署相关代码
- 已安装 Node.js >= 20
- 已安装 Docker 与 Docker Compose(本地验证用)
- 已阅读设计文档 `docs/superpowers/specs/2026-07-02-crawlab-automation-design.md`

---

### 任务 1：为 CrawlerService 添加 `/health` HTTP 端点

**文件：**
- 修改：`src/service.js:14-29`(constructor)、`src/service.js:171-228`(start)、`src/service.js:230-269`(stop)
- 测试：`test/service-health.test.js`

- [ ] **步骤 1：编写失败的测试**

创建 `test/service-health.test.js`：

```js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { CrawlerService } = require('../src/service');

describe('CrawlerService health endpoint', { timeout: 30000 }, () => {
  let service;
  let healthPort;

  before(async () => {
    healthPort = 19999;
    service = new CrawlerService({
      nodeCode: 'test-node',
      nodeToken: '',
      taskUrl: 'http://127.0.0.1:1/tasks',
      callbackUrl: 'http://127.0.0.1:1/callback',
      channels: 1,
      imageDir: '/tmp/test-health-images',
      healthPort,
    });
    service.ensureImageDir();
  });

  after(async () => {
    try { await service.stop(); } catch (e) {}
  });

  it('exposes /health returning status ok', async () => {
    await service.startHealthServer();

    const res = await new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${healthPort}/health`, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
    });

    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    assert.strictEqual(json.status, 'ok');
    assert.strictEqual(json.nodeCode, 'test-node');
    assert.ok('uptime' in json);
  });

  it('returns 503 when browser is not connected', async () => {
    await service.startHealthServer();
    service.browser = { isConnected: () => false };

    const res = await new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${healthPort}/health`, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
    });

    assert.strictEqual(res.status, 503);
    const json = JSON.parse(res.body);
    assert.strictEqual(json.status, 'degraded');
    assert.strictEqual(json.browserConnected, false);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
node --test test/service-health.test.js
```

预期：`FAIL`，报错 `startHealthServer is not a function`。

- [ ] **步骤 3：在 `src/service.js` 中实现健康服务器**

在 `src/service.js` 顶部导入 `http`：

```js
const http = require('node:http');
```

在 `CrawlerService` constructor 中新增字段(约第 28 行后)：

```js
    this.healthServer = null;
    this.healthServerStartTime = null;
```

在 `src/service.js` 中新增 `startHealthServer()` 方法(放在 `startHealthCheck()` 附近)：

```js
  async startHealthServer() {
    if (this.healthServer || !this.config.healthPort) {
      return;
    }

    this.healthServerStartTime = Date.now();
    this.healthServer = http.createServer((req, res) => {
      if (req.url !== '/health') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'not found' }));
        return;
      }

      const browserConnected = this.browser && this.browser.isConnected();
      const status = browserConnected ? 'ok' : 'degraded';
      const code = browserConnected ? 200 : 503;

      const channels = this.channels.map(c => ({
        id: c.id,
        healthy: c.healthy || false,
        proxy: this.proxyPool ? this.proxyPool.getProxyForChannel(`ch-${c.id}`) : this.config.proxy,
      }));

      const queue = {
        pending: this.worker ? this.worker.taskQueue.length : 0,
        running: this.worker ? this.worker.channels.filter(c => c.busy).length : 0,
        completed: 0,
      };

      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status,
        nodeCode: this.config.nodeCode,
        timestamp: new Date().toISOString(),
        uptime: this.healthServerStartTime ? Math.floor((Date.now() - this.healthServerStartTime) / 1000) : 0,
        browserConnected,
        channels,
        queue,
      }));
    });

    return new Promise((resolve, reject) => {
      this.healthServer.listen(this.config.healthPort, '0.0.0.0', (err) => {
        if (err) return reject(err);
        this.log(`[HEALTH] Server listening on port ${this.config.healthPort}`);
        resolve();
      });
    });
  }
```

在 `start()` 方法末尾(约第 227 行,`this.startHealthCheck();` 之后)调用：

```js
    await this.startHealthServer();
```

在 `stop()` 方法中新增关闭逻辑(放在 `this.stopProxyRefresh();` 之后)：

```js
    if (this.healthServer) {
      this.healthServer.close();
      this.healthServer = null;
    }
```

- [ ] **步骤 4：运行测试验证通过**

```bash
node --test test/service-health.test.js
```

预期：`tests 2 / pass 2 / fail 0`。

- [ ] **步骤 5：Commit**

```bash
git add src/service.js test/service-health.test.js
git commit -m "feat(service): 添加 /health HTTP 健康端点

- CrawlerService 支持 healthPort 配置
- /health 返回节点状态、浏览器连接状态、通道健康、队列长度
- 浏览器断开时返回 503 degraded
- 新增 test/service-health.test.js"
```

---

### 任务 2：添加结构化日志模块

**文件：**
- 创建：`src/logger.js`
- 修改：`src/service.js:31-33`(log 方法)
- 测试：`test/logger.test.js`

- [ ] **步骤 1：编写失败的测试**

创建 `test/logger.test.js`：

```js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createLogger } = require('../src/logger');

describe('Logger', () => {
  it('formats log as JSON line', () => {
    const logs = [];
    const logger = createLogger({
      nodeCode: 'test-node',
      write: (line) => logs.push(line),
    });

    logger.info('service', 'started', { channel: 1 });

    assert.strictEqual(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assert.strictEqual(parsed.level, 'INFO');
    assert.strictEqual(parsed.component, 'service');
    assert.strictEqual(parsed.msg, 'started');
    assert.strictEqual(parsed.nodeCode, 'test-node');
    assert.strictEqual(parsed.channel, 1);
    assert.ok(parsed.time);
  });

  it('supports warn and error levels', () => {
    const logs = [];
    const logger = createLogger({
      nodeCode: 'test-node',
      write: (line) => logs.push(line),
    });

    logger.warn('channel', 'proxy rotation');
    logger.error('service', 'browser launch failed', { error: 'timeout' });

    assert.strictEqual(JSON.parse(logs[0]).level, 'WARN');
    assert.strictEqual(JSON.parse(logs[1]).level, 'ERROR');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
node --test test/logger.test.js
```

预期：`FAIL`，报错 `createLogger is not a function`。

- [ ] **步骤 3：实现 logger.js**

创建 `src/logger.js`：

```js
const fs = require('fs');
const path = require('path');

function createLogger(options = {}) {
  const nodeCode = options.nodeCode || 'unknown';
  const write = options.write || ((line) => process.stdout.write(line));

  function log(level, component, msg, extra = {}) {
    const entry = {
      time: new Date().toISOString(),
      level,
      component,
      msg,
      nodeCode,
      ...extra,
    };
    write(JSON.stringify(entry) + '\n');
  }

  return {
    info: (component, msg, extra) => log('INFO', component, msg, extra),
    warn: (component, msg, extra) => log('WARN', component, msg, extra),
    error: (component, msg, extra) => log('ERROR', component, msg, extra),
  };
}

function createFileLogger(options = {}) {
  const logDir = options.logDir || path.resolve('./logs');
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  const logFile = path.join(logDir, 'crawler.jsonl');
  const stream = fs.createWriteStream(logFile, { flags: 'a' });
  return createLogger({
    nodeCode: options.nodeCode,
    write: (line) => stream.write(line),
  });
}

module.exports = { createLogger, createFileLogger };
```

- [ ] **步骤 4：可选：让 CrawlerService 使用 logger**

如果希望 service 日志也结构化,修改 `src/service.js` 的 `log()` 方法：

```js
  log(...args) {
    console.log(...args);
    if (this.logger) {
      this.logger.info('service', args.join(' '));
    }
  }
```

并在 constructor 中初始化(可选)：

```js
    this.logger = config.logger || null;
```

此步骤 optional,不影响 crawlab 监控,可跳过以保持改动最小。

- [ ] **步骤 5：运行测试验证通过**

```bash
node --test test/logger.test.js
```

预期：`tests 2 / pass 2 / fail 0`。

- [ ] **步骤 6：Commit**

```bash
git add src/logger.js test/logger.test.js
git commit -m "feat(logger): 添加 JSON Lines 结构化日志模块

- createLogger 支持 info/warn/error
- createFileLogger 追加写入 logs/crawler.jsonl
- 新增 test/logger.test.js"
```

---

### 任务 3：创建 crawlab Docker Compose 编排

**文件：**
- 创建：`deployment/crawlab/docker-compose.yml`
- 测试：`test/deployment/crawlab-docker-compose.test.js`

- [ ] **步骤 1：编写失败的测试**

创建 `test/deployment/crawlab-docker-compose.test.js`：

```js
const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

describe('deployment/crawlab/docker-compose.yml', () => {
  let composePath;
  let content;

  before(() => {
    composePath = path.resolve(__dirname, '../../deployment/crawlab/docker-compose.yml');
    assert.ok(fs.existsSync(composePath), 'docker-compose.yml should exist');
    content = fs.readFileSync(composePath, 'utf-8');
  });

  it('defines crawlab, mongo, redis and crawler services', () => {
    assert.ok(content.includes('crawlab:'), 'should define crawlab service');
    assert.ok(content.includes('mongo:'), 'should define mongo service');
    assert.ok(content.includes('redis:'), 'should define redis service');
    assert.ok(content.includes('crawler:'), 'should define crawler service');
  });

  it('exposes crawlab on port 8080', () => {
    assert.ok(content.includes('"8080:8080"'), 'should expose crawlab 8080');
  });

  it('binds crawler health port to 127.0.0.1', () => {
    assert.ok(content.includes('127.0.0.1:3000:3000'), 'should bind health port to localhost only');
  });

  it('sets CRAWLER_HEALTH_PORT=3000', () => {
    assert.ok(content.includes('CRAWLER_HEALTH_PORT=3000'), 'should enable health server');
  });

  it('shares logs volume with crawlab read-only', () => {
    assert.ok(content.includes('./logs:/app/logs:ro'), 'crawlab should read logs');
  });

  it('uses a shared crawler-net network', () => {
    assert.ok(content.includes('crawler-net:'), 'should define crawler-net');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
node --test test/deployment/crawlab-docker-compose.test.js
```

预期：`FAIL`,文件不存在。

- [ ] **步骤 3：创建 docker-compose.yml**

创建 `deployment/crawlab/docker-compose.yml`：

```yaml
services:
  crawlab:
    image: crawlabteam/crawlab:latest
    container_name: crawlab
    restart: unless-stopped
    ports:
      - "8080:8080"
    environment:
      - CRAWLAB_NODE_MASTER=y
      - CRAWLAB_MONGO_HOST=mongo
      - CRAWLAB_REDIS_HOST=redis
      - CRAWLAB_LOG_LEVEL=info
    volumes:
      - crawlab-data:/data
      - ./logs:/app/logs:ro
    depends_on:
      - mongo
      - redis
    networks:
      - crawler-net

  mongo:
    image: mongo:6
    container_name: crawlab-mongo
    restart: unless-stopped
    volumes:
      - mongo-data:/data/db
    networks:
      - crawler-net

  redis:
    image: redis:7-alpine
    container_name: crawlab-redis
    restart: unless-stopped
    volumes:
      - redis-data:/data
    networks:
      - crawler-net

  crawler:
    image: ${CRAWLER_IMAGE:?未设置 CRAWLER_IMAGE 环境变量}
    container_name: hs-sku-crawler
    restart: unless-stopped
    env_file: .env
    environment:
      - CRAWLER_MODE=service
      - CRAWLER_NODE_CODE=${CRAWLER_NODE_CODE:-crawler-eu-01}
      - CRAWLER_HEADED_FALLBACK=false
      - CRAWLER_HEALTH_PORT=3000
    ports:
      - "127.0.0.1:3000:3000"
    volumes:
      - ./logs:/app/logs
      - ./output:/app/output
      - ./images:/app/images
    depends_on:
      - redis
    networks:
      - crawler-net

volumes:
  crawlab-data:
  mongo-data:
  redis-data:

networks:
  crawler-net:
    driver: bridge
```

- [ ] **步骤 4：运行测试验证通过**

```bash
node --test test/deployment/crawlab-docker-compose.test.js
```

预期：`tests 6 / pass 6 / fail 0`。

- [ ] **步骤 5：Commit**

```bash
git add deployment/crawlab/docker-compose.yml test/deployment/crawlab-docker-compose.test.js
git commit -m "feat(deployment): 增加 crawlab + crawler 同机 Docker Compose 编排

- 包含 crawlab、MongoDB、Redis、hs-sku-crawler 四个服务
- crawler 暴露 127.0.0.1:3000 健康端口
- crawlab 只读挂载 ./logs
- 新增 6 个静态测试断言"
```

---

### 任务 4：创建 crawlab 部署环境变量模板

**文件：**
- 创建：`deployment/crawlab/.env.example`

- [ ] **步骤 1：创建文件**

创建 `deployment/crawlab/.env.example`：

```bash
# Docker 镜像配置
CRAWLER_IMAGE_BASE=ghcr.io/<GITHUB_OWNER>/<REPO>

# 上游 API
CRAWLER_NODE_CODE=crawler-eu-01
CRAWLER_NODE_TOKEN=your-node-token
CRAWLER_TASK_URL=http://<上游IP>/renren-api/classify/open/crawler/tasks
CRAWLER_CALLBACK_URL=http://<上游IP>/renren-api/classify/open/crawler/callback

# 服务配置
CRAWLER_MODE=service
CRAWLER_CHANNELS=2
CRAWLER_POLL_INTERVAL=5000
CRAWLER_POLL_LIMIT=5
CRAWLER_PUSH_RETRIES=3
CRAWLER_HEALTH_PORT=3000

# VEVOR 站点
CRAWLER_BASE_URL=https://eur.vevor.com
CRAWLER_HEADLESS=true
CRAWLER_HEADED_FALLBACK=false
CRAWLER_MAX_IMAGES=3
CRAWLER_CLOUDFLARE_MAX_WAIT=45
CRAWLER_MIN_DELAY=5
CRAWLER_MAX_DELAY=10

# Cliproxy 住宅代理
CLIPROXY_HOST=eu.cliproxy.io
CLIPROXY_PORT=1080
CLIPROXY_USERNAME=your-cliproxy-username
CLIPROXY_PASSWORD=your-cliproxy-password
CLIPROXY_REGION=EU
CLIPROXY_STICKY_MINUTES=30
CLIPROXY_SESSION_PREFIX=crawler-eu-01
```

- [ ] **步骤 2：Commit**

```bash
git add deployment/crawlab/.env.example
git commit -m "chore(deployment): 增加 crawlab 部署 .env 模板"
```

---

### 任务 5：创建 VPS 一键初始化脚本

**文件：**
- 创建：`deployment/crawlab/setup-vps.sh`
- 测试：`test/deployment/crawlab-setup.test.js`

- [ ] **步骤 1：编写失败的测试**

创建 `test/deployment/crawlab-setup.test.js`：

```js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

describe('deployment/crawlab/setup-vps.sh', () => {
  const scriptPath = path.resolve(__dirname, '../../deployment/crawlab/setup-vps.sh');

  it('exists and is executable', () => {
    assert.ok(fs.existsSync(scriptPath), 'setup-vps.sh should exist');
    const stats = fs.statSync(scriptPath);
    assert.ok(stats.mode & 0o111, 'setup-vps.sh should be executable');
  });

  it('requires VPS_IP argument', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('VPS_IP="${1:?'), 'should require VPS_IP');
  });

  it('installs docker and docker-compose-plugin', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('get.docker.com'), 'should install docker');
    assert.ok(content.includes('docker-compose-plugin'), 'should install compose plugin');
  });

  it('creates crawler user and /opt/crawler directory', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('useradd'), 'should create crawler user');
    assert.ok(content.includes('/opt/crawler'), 'should create /opt/crawler');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
node --test test/deployment/crawlab-setup.test.js
```

预期：`FAIL`,脚本不存在。

- [ ] **步骤 3：创建 setup-vps.sh**

创建 `deployment/crawlab/setup-vps.sh`：

```bash
#!/bin/bash
set -euo pipefail

VPS_IP="${1:?请提供 VPS IP,例如 ./setup-vps.sh 203.0.113.10}"
SSH_USER="${2:-root}"
GITHUB_OWNER="${GITHUB_OWNER:?请设置 GITHUB_OWNER 环境变量}"
REPO="${REPO:?请设置 REPO 环境变量}"

echo ">>> 1. 安装 Docker"
ssh "${SSH_USER}@${VPS_IP}" '
  export DEBIAN_FRONTEND=noninteractive
  apt-get update && apt-get upgrade -y
  curl -fsSL https://get.docker.com | sh
  apt-get install -y docker-compose-plugin git
'

echo ">>> 2. 创建部署用户"
ssh "${SSH_USER}@${VPS_IP}" '
  useradd -m -s /bin/bash crawler || true
  usermod -aG docker crawler
  mkdir -p /opt/crawler/logs /opt/crawler/output /opt/crawler/images
  chown -R crawler:crawler /opt/crawler
'

echo ">>> 3. 克隆仓库"
ssh "crawler@${VPS_IP}" "
  rm -rf /opt/crawler/repo
  git clone https://github.com/${GITHUB_OWNER}/${REPO}.git /opt/crawler/repo
  ln -sf /opt/crawler/repo/deployment/crawlab/* /opt/crawler/
"

echo ">>> 4. 初始化 .env"
ssh "crawler@${VPS_IP}" '
  cd /opt/crawler
  cp .env.example .env
'

echo ">>> 完成。请执行:"
echo "    export CRAWLER_IMAGE_BASE=ghcr.io/${GITHUB_OWNER}/${REPO}"
echo "    ssh crawler@${VPS_IP}"
echo "    cd /opt/crawler"
echo "    nano .env"
echo "    ./deploy.sh v1.0.0"
```

赋予执行权限：

```bash
chmod +x deployment/crawlab/setup-vps.sh
```

- [ ] **步骤 4：运行测试验证通过**

```bash
node --test test/deployment/crawlab-setup.test.js
```

预期：`tests 4 / pass 4 / fail 0`。

- [ ] **步骤 5：Commit**

```bash
git add deployment/crawlab/setup-vps.sh test/deployment/crawlab-setup.test.js
git commit -m "feat(deployment): 增加 VPS 一键初始化脚本

- setup-vps.sh 自动安装 Docker、创建 crawler 用户、clone 仓库、初始化 .env
- 通过 GITHUB_OWNER/REPO 环境变量指定仓库
- 新增 4 个行为测试"
```

---

### 任务 6：创建 deploy / update / rollback 脚本

**文件：**
- 创建：`deployment/crawlab/deploy.sh`、`deployment/crawlab/update.sh`、`deployment/crawlab/rollback.sh`

- [ ] **步骤 1：创建 deploy.sh**

```bash
#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_TAG="${1:?请提供镜像 tag,例如 ./deploy.sh v1.0.0}"

if [ -z "${CRAWLER_IMAGE_BASE:-}" ]; then
  echo "错误:未设置 CRAWLER_IMAGE_BASE 环境变量" >&2
  exit 1
fi

if [[ "${CRAWLER_IMAGE_BASE}" == */ ]]; then
  echo "错误:CRAWLER_IMAGE_BASE 末尾不应包含斜杠" >&2
  exit 1
fi

export CRAWLER_IMAGE="${CRAWLER_IMAGE_BASE}:${IMAGE_TAG}"

if [ ! -f .env ]; then
  echo "错误:当前目录缺少 .env 文件" >&2
  exit 1
fi

mkdir -p logs output images

docker compose pull
docker compose up -d

echo "部署完成:${CRAWLER_IMAGE}"
docker compose ps
```

- [ ] **步骤 2：创建 update.sh**

```bash
#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_TAG="${1:?请提供镜像 tag,例如 ./update.sh v1.0.0}"

if [ -z "${CRAWLER_IMAGE_BASE:-}" ]; then
  echo "错误:未设置 CRAWLER_IMAGE_BASE 环境变量" >&2
  exit 1
fi

if [[ "${CRAWLER_IMAGE_BASE}" == */ ]]; then
  echo "错误:CRAWLER_IMAGE_BASE 末尾不应包含斜杠" >&2
  exit 1
fi

CURRENT_IMAGE=$(docker inspect --format='{{.Config.Image}}' hs-sku-crawler 2>/dev/null || true)
if [ -n "$CURRENT_IMAGE" ]; then
  echo "$CURRENT_IMAGE" > .last_image
fi

export CRAWLER_IMAGE="${CRAWLER_IMAGE_BASE}:${IMAGE_TAG}"

docker compose pull
docker compose up -d --no-deps crawler

echo "更新完成:${CRAWLER_IMAGE}"
docker compose ps
```

- [ ] **步骤 3：创建 rollback.sh**

```bash
#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -f .env ]; then
  echo "错误:当前目录缺少 .env 文件" >&2
  exit 1
fi

if [ ! -f .last_image ]; then
  echo "错误:未找到 .last_image,无法回滚" >&2
  exit 1
fi

LAST_IMAGE=$(cat .last_image)
export CRAWLER_IMAGE="$LAST_IMAGE"

docker compose up -d --no-deps crawler

echo "回滚完成:${LAST_IMAGE}"
```

- [ ] **步骤 4：赋予执行权限**

```bash
chmod +x deployment/crawlab/deploy.sh deployment/crawlab/update.sh deployment/crawlab/rollback.sh
```

- [ ] **步骤 5：运行静态测试**

复用现有 `test/deployment/linux-deploy.test.js` 的测试模式,或新增 `test/deployment/crawlab-scripts.test.js`：

```js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

function assertScript(name) {
  const p = path.resolve(__dirname, `../../deployment/crawlab/${name}`);
  assert.ok(fs.existsSync(p), `${name} should exist`);
  const stats = fs.statSync(p);
  assert.ok(stats.mode & 0o111, `${name} should be executable`);
}

describe('deployment/crawlab scripts', () => {
  it('deploy.sh exists and is executable', () => assertScript('deploy.sh'));
  it('update.sh exists and is executable', () => assertScript('update.sh'));
  it('rollback.sh exists and is executable', () => assertScript('rollback.sh'));
});
```

运行：

```bash
node --test test/deployment/crawlab-scripts.test.js
```

预期：`tests 3 / pass 3 / fail 0`。

- [ ] **步骤 6：Commit**

```bash
git add deployment/crawlab/deploy.sh deployment/crawlab/update.sh deployment/crawlab/rollback.sh test/deployment/crawlab-scripts.test.js
git commit -m "feat(deployment): 增加 crawlab 部署的 deploy/update/rollback 脚本

- deploy.sh:首次部署并启动所有服务
- update.sh:升级 crawler 镜像并记录 .last_image
- rollback.sh:回滚到上一镜像
- 新增 3 个脚本存在性与可执行权限测试"
```

---

### 任务 7：创建 GitHub Actions CI/CD Workflow

**文件：**
- 创建：`.github/workflows/deploy-vps.yml`
- 测试：`test/github-workflow.test.js`

- [ ] **步骤 1：编写失败的测试**

创建 `test/github-workflow.test.js`：

```js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

describe('.github/workflows/deploy-vps.yml', () => {
  const workflowPath = path.resolve(__dirname, '../.github/workflows/deploy-vps.yml');

  it('exists', () => {
    assert.ok(fs.existsSync(workflowPath), 'workflow should exist');
  });

  it('triggers on tag push', () => {
    const content = fs.readFileSync(workflowPath, 'utf-8');
    assert.ok(content.includes("tags:\n      - 'v*'"), 'should trigger on v* tags');
  });

  it('builds and pushes image to ghcr', () => {
    const content = fs.readFileSync(workflowPath, 'utf-8');
    assert.ok(content.includes('ghcr.io/${{ github.repository }}'), 'should use ghcr');
    assert.ok(content.includes('docker/build-push-action'), 'should build and push');
  });

  it('deploys via SSH using secrets', () => {
    const content = fs.readFileSync(workflowPath, 'utf-8');
    assert.ok(content.includes('secrets.VPS_HOST'), 'should use VPS_HOST secret');
    assert.ok(content.includes('secrets.VPS_USER'), 'should use VPS_USER secret');
    assert.ok(content.includes('secrets.VPS_SSH_KEY'), 'should use VPS_SSH_KEY secret');
    assert.ok(content.includes('appleboy/ssh-action'), 'should use ssh action');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
node --test test/github-workflow.test.js
```

预期：`FAIL`,workflow 不存在。

- [ ] **步骤 3：创建 workflow**

创建 `.github/workflows/deploy-vps.yml`：

```yaml
name: Build and Deploy to VPS

on:
  push:
    tags:
      - 'v*'

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: .
          file: deployment/docker/Dockerfile
          push: true
          tags: |
            ghcr.io/${{ github.repository }}:${{ github.ref_name }}
            ghcr.io/${{ github.repository }}:latest
          cache-from: type=gha
          cache-to: type=gha,mode=max

  deploy:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - name: Deploy to VPS
        uses: appleboy/ssh-action@v1.0.0
        with:
          host: ${{ secrets.VPS_HOST }}
          username: ${{ secrets.VPS_USER }}
          key: ${{ secrets.VPS_SSH_KEY }}
          script: |
            cd /opt/crawler
            export CRAWLER_IMAGE_BASE=ghcr.io/${{ github.repository }}
            ./update.sh ${{ github.ref_name }}
```

- [ ] **步骤 4：运行测试验证通过**

```bash
node --test test/github-workflow.test.js
```

预期：`tests 4 / pass 4 / fail 0`。

- [ ] **步骤 5：Commit**

```bash
git add .github/workflows/deploy-vps.yml test/github-workflow.test.js
git commit -m "ci: 增加 GitHub Actions 自动构建并部署到 VPS

- 触发条件:push v* tag
- build job:构建镜像并推送到 ghcr.io
- deploy job:SSH 到 VPS 执行 update.sh
- 新增 4 个 workflow 静态测试"
```

---

### 任务 8：更新部署文档

**文件：**
- 修改：`部署vps.md`

- [ ] **步骤 1：在文档末尾新增 crawlab + GitHub Actions 章节**

在 `部署vps.md` 附录前插入新章节：

```markdown
---

## 十一、crawlab 同机部署(可选)

如果需要可视化监控节点,可将 crawlab 与爬虫部署在同一台 VPS。

### 11.1 使用 crawlab 版 Docker Compose

```bash
cd /opt/crawler/repo/deployment/crawlab
./deploy.sh v1.0.0
```

此 compose 会启动 4 个服务:
- `crawlab`:管理界面,访问 `http://<VPS_IP>:8080`
- `mongo`:crawlab 元数据
- `redis`:crawlab 任务队列
- `crawler`:hs-sku-crawler,暴露健康端点

### 11.2 在 crawlab 中添加节点

1. 打开 `http://<VPS_IP>:8080`
2. 进入「节点」→「添加节点」
3. 节点地址填 `http://crawler:3000/health`
4. 轮询间隔 30 秒

### 11.3 GitHub Actions 自动发布

配置 GitHub Secrets:
- `VPS_HOST`:VPS 公网 IP
- `VPS_USER`:部署用户名(如 `crawler`)
- `VPS_SSH_KEY`:SSH 私钥

发布新版本:

```bash
git tag v1.2.3
git push origin v1.2.3
```

GitHub Actions 会自动构建镜像、推送到 GHCR、SSH 到 VPS 执行 `update.sh`。

### 11.4 安全建议

- crawlab 的 8080 端口建议通过 Nginx + Basic Auth 保护,或仅通过 SSH 隧道访问
- 健康端口 3000 仅监听 `127.0.0.1`,不暴露公网
```

- [ ] **步骤 2：Commit**

```bash
git add 部署vps.md
git commit -m "docs: 部署文档增加 crawlab + GitHub Actions 章节

- 说明 crawlab 同机部署步骤
- 说明如何在 crawlab 中添加 crawler 节点
- 说明 GitHub Actions 自动发布流程与安全建议"
```

---

### 任务 9：本地 compose 语法验证

**文件：**
- 运行命令,无文件修改

- [ ] **步骤 1：验证 docker-compose.yml 可解析**

在本地(需安装 Docker Compose)：

```bash
cd deployment/crawlab
export CRAWLER_IMAGE_BASE=ghcr.io/test/test
export CRAWLER_IMAGE=ghcr.io/test/test:v1.0.0
docker compose config
```

预期：命令成功退出,无错误,输出包含 4 个 service。

- [ ] **步骤 2：记录验证结果**

将命令输出保存到本地,或在 commit message 中记录：

```bash
cd ../..
git commit --allow-empty -m "chore: 验证 deployment/crawlab/docker-compose.yml 可解析"
```

---

### 任务 10：真实 VPS 首次部署验证

**文件：**
- 运行命令,无文件修改

- [ ] **步骤 1：在真实 VPS 上执行初始化**

```bash
export GITHUB_OWNER=你的GitHub用户名
export REPO=你的仓库名
./deployment/crawlab/setup-vps.sh <VPS_IP> root
```

- [ ] **步骤 2：SSH 到 VPS 完成配置**

```bash
ssh crawler@<VPS_IP>
cd /opt/crawler
nano .env
export CRAWLER_IMAGE_BASE=ghcr.io/${GITHUB_OWNER}/${REPO}
./deploy.sh v1.0.0
```

- [ ] **步骤 3：验证服务状态**

```bash
docker compose ps
curl -s http://127.0.0.1:3000/health | jq .
```

预期：`crawler` 状态为 `healthy` 或 `running`,`/health` 返回 JSON 且 `status` 为 `ok`。

- [ ] **步骤 4：验证 crawlab 可访问**

浏览器访问 `http://<VPS_IP>:8080`,确认 crawlab 管理界面正常。

- [ ] **步骤 5：验证 GitHub Actions 自动升级**

```bash
git tag v1.0.1
git push origin v1.0.1
```

等待 Actions 完成后,在 VPS 上执行：

```bash
docker inspect --format='{{.Config.Image}}' hs-sku-crawler
```

预期：输出 `ghcr.io/<owner>/<repo>:v1.0.1`。

---

## 自检

### 规格覆盖度

| 设计章节 | 实现任务 |
|----------|----------|
| `/health` 端点 | 任务 1 |
| 结构化日志 | 任务 2 |
| Docker Compose 编排 | 任务 3 |
| `.env.example` | 任务 4 |
| `setup-vps.sh` | 任务 5 |
| deploy/update/rollback 脚本 | 任务 6 |
| GitHub Actions CI/CD | 任务 7 |
| 文档更新 | 任务 8 |
| 本地验证 | 任务 9 |
| 真实 VPS 验证 | 任务 10 |

无遗漏。

### 占位符扫描

- `<GITHUB_OWNER>`、`<REPO>`：显式说明需替换,并通过环境变量注入到 `setup-vps.sh`
- `<VPS_IP>`：使用示例说明
- `<上游IP>`：与既有 `.env.example` 保持一致
- 无 "TODO" / "待定" / "后续实现" 等占位符

### 类型一致性

- `CrawlerService` 新增 `healthServer`、`healthServerStartTime` 字段,在 `start()`、`stop()` 中一致使用
- `healthPort` 配置在测试、service、docker-compose 中名称一致
- `crawler-net` 网络名称在 docker-compose 各服务中一致

### 范围检查

- 计划聚焦：单 VPS + crawlab + GitHub Actions + 健康端点 + 结构化日志
- Windows PM2 接入明确预留接口,不在本次实现
- 任务粒度 2-5 分钟,适合子代理驱动或内联执行

---

## 执行选项

**计划已完成并保存到 `docs/superpowers/plans/2026-07-02-crawlab-automation.md`。两种执行方式：**

**1. 子代理驱动（推荐）** - 每个任务调度一个新的子代理,任务间进行审查,快速迭代

**2. 内联执行** - 在当前会话中使用 executing-plans 执行任务,批量执行并设有检查点

**选哪种方式？**