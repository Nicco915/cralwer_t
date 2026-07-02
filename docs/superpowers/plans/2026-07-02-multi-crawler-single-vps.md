# 单 VPS 多 crawler 节点实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在单台 VPS 上通过 Docker Compose 运行多个 `hs-sku-crawler` 节点，由 crawlab 统一监控，并支持动态生成 compose 配置。

**架构：** 使用 `generate-compose.js` 根据 `--nodes=N` 生成包含 `crawler-1` ~ `crawler-N` 的 `docker-compose.yml`；每个节点有独立的 `nodeCode`、`healthPort`、`sessionPrefix` 和 volume 子目录；修复 `CRAWLER_HEALTH_PORT` 配置读取，使健康服务真正生效。

**技术栈：** Node.js, Docker Compose, Bash, GitHub Actions

---

## 文件清单

| 文件 | 动作 | 职责 |
|------|------|------|
| `src/cli.js` | 修改 | envMap 增加 `CRAWLER_HEALTH_PORT` 到 `healthPort` 的映射 |
| `bin/run.js` | 修改 | `buildServiceConfig` 增加 `healthPort` 字段 |
| `test/run-health-port.test.js` | 创建 | 验证 `CRAWLER_HEALTH_PORT` 环境变量被正确读取 |
| `deployment/crawlab/generate-compose.js` | 创建 | 根据 `--nodes=N` 生成多节点 `docker-compose.yml` |
| `test/deployment/generate-compose.test.js` | 创建 | 验证生成脚本输出正确（端口唯一、nodeCode 唯一、sessionPrefix 唯一、YAML 有效） |
| `deployment/crawlab/docker-compose.yml` | 修改 | 替换为 6 节点生成的最终版本 |
| `test/deployment/crawlab-docker-compose.test.js` | 修改 | 适配 6 节点配置 |
| `deployment/crawlab/deploy.sh` | 修改 | 创建每个节点的子目录，启动全部服务 |
| `deployment/crawlab/update.sh` | 修改 | 记录每个节点当前镜像，拉取并滚动更新所有 crawler 服务 |
| `deployment/crawlab/rollback.sh` | 修改 | 读取每个节点的 `.last_image`，回滚所有 crawler 服务 |
| `deployment/crawlab/.env.example` | 修改 | 说明多节点下哪些变量由 compose 覆盖 |
| `部署vps.md` | 修改 | 新增「多节点部署」、「生成脚本」、「单节点运维」章节 |

---

## 任务 1：修复 CRAWLER_HEALTH_PORT 读取

**背景：** 当前 `docker-compose.yml` 设置了 `CRAWLER_HEALTH_PORT=3000`，但 `bin/run.js` 的 `buildServiceConfig` 没有读取它，导致健康服务不启动。

**文件：**
- 修改：`src/cli.js`
- 修改：`bin/run.js`
- 创建：`test/run-health-port.test.js`

### 步骤 1.1：编写失败的测试

创建 `test/run-health-port.test.js`：

```js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { parse } = require('../src/cli');
const { buildServiceConfig } = require('../bin/run');

describe('buildServiceConfig reads CRAWLER_HEALTH_PORT', () => {
  it('maps CRAWLER_HEALTH_PORT to healthPort as number', () => {
    const config = parse([], {
      defaults: {},
      env: {
        CRAWLER_HEALTH_PORT: '3001',
      },
    });
    const serviceConfig = buildServiceConfig(config);
    assert.strictEqual(serviceConfig.healthPort, 3001);
  });

  it('defaults healthPort to undefined when not set', () => {
    const config = parse([], {
      defaults: {},
      env: {},
    });
    const serviceConfig = buildServiceConfig(config);
    assert.strictEqual(serviceConfig.healthPort, undefined);
  });
});
```

**注意：** 当前 `parse()` 不接受 `env` 参数。需要在测试中通过直接设置 `process.env.CRAWLER_HEALTH_PORT` 来模拟。修正后的测试：

```js
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { parse } = require('../src/cli');
const { buildServiceConfig } = require('../bin/run');

describe('buildServiceConfig reads CRAWLER_HEALTH_PORT', () => {
  let originalHealthPort;

  beforeEach(() => {
    originalHealthPort = process.env.CRAWLER_HEALTH_PORT;
    delete process.env.CRAWLER_HEALTH_PORT;
  });

  afterEach(() => {
    if (originalHealthPort !== undefined) {
      process.env.CRAWLER_HEALTH_PORT = originalHealthPort;
    } else {
      delete process.env.CRAWLER_HEALTH_PORT;
    }
  });

  it('maps CRAWLER_HEALTH_PORT to healthPort as number', () => {
    process.env.CRAWLER_HEALTH_PORT = '3001';
    const config = parse([]);
    const serviceConfig = buildServiceConfig(config);
    assert.strictEqual(serviceConfig.healthPort, 3001);
  });

  it('defaults healthPort to undefined when not set', () => {
    delete process.env.CRAWLER_HEALTH_PORT;
    const config = parse([]);
    const serviceConfig = buildServiceConfig(config);
    assert.strictEqual(serviceConfig.healthPort, undefined);
  });
});
```

### 步骤 1.2：运行测试验证失败

```bash
npm test -- test/run-health-port.test.js
```

预期：第二个测试通过（undefined 是默认值），第一个测试失败，因为 `healthPort` 是 `undefined` 而不是 `3001`。

### 步骤 1.3：修改 src/cli.js

在 `src/cli.js` 的 `envMap` 对象中增加一行：

```js
CRAWLER_HEALTH_PORT: 'healthPort',
```

具体位置在 `CRAWLER_MODE: 'mode',` 附近：

```js
    CRAWLER_MODE: 'mode',
    CRAWLER_NODE_CODE: 'nodeCode',
    CRAWLER_NODE_TOKEN: 'nodeToken',
    CRAWLER_TASK_URL: 'taskUrl',
```

插入后：

```js
    CRAWLER_MODE: 'mode',
    CRAWLER_NODE_CODE: 'nodeCode',
    CRAWLER_NODE_TOKEN: 'nodeToken',
    CRAWLER_HEALTH_PORT: 'healthPort',
    CRAWLER_TASK_URL: 'taskUrl',
```

### 步骤 1.4：修改 bin/run.js

在 `buildServiceConfig` 返回对象中增加：

```js
    healthPort: config.healthPort !== undefined ? Number(config.healthPort) : undefined,
```

建议放在 `nodeCode` 之后：

```js
    nodeCode: config.nodeCode || os.hostname(),
    nodeToken: config.nodeToken || '',
    healthPort: config.healthPort !== undefined ? Number(config.healthPort) : undefined,
    taskUrl: config.taskUrl || 'http://117.72.52.0/renren-api/classify/open/crawler/tasks',
```

### 步骤 1.5：运行测试验证通过

```bash
npm test -- test/run-health-port.test.js
```

预期：两个测试都通过。

### 步骤 1.6：Commit

```bash
git add src/cli.js bin/run.js test/run-health-port.test.js
git commit -m "fix(service): 读取 CRAWLER_HEALTH_PORT 环境变量"
```

---

## 任务 2：创建 generate-compose.js 脚本

**背景：** 手动维护 6 个几乎相同的 crawler 服务块容易出错。使用脚本根据节点数自动生成。

**文件：**
- 创建：`deployment/crawlab/generate-compose.js`
- 创建：`test/deployment/generate-compose.test.js`

### 步骤 2.1：编写生成脚本

创建 `deployment/crawlab/generate-compose.js`：

```js
#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = argv.slice(2);
  let nodes = 6;
  let output = path.resolve(__dirname, 'docker-compose.yml');

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--nodes=')) {
      nodes = parseInt(arg.slice('--nodes='.length), 10);
    } else if (arg === '--nodes' && i + 1 < args.length) {
      nodes = parseInt(args[i + 1], 10);
      i++;
    } else if (arg.startsWith('--output=')) {
      output = path.resolve(__dirname, arg.slice('--output='.length));
    } else if (arg === '--output' && i + 1 < args.length) {
      output = path.resolve(__dirname, args[i + 1]);
      i++;
    }
  }

  if (Number.isNaN(nodes) || nodes < 1 || nodes > 20) {
    console.error('错误: --nodes 必须是 1-20 之间的整数');
    process.exit(1);
  }

  return { nodes, output };
}

function baseServices() {
  return `services:
  crawlab:
    image: crawlabteam/crawlab:0.6.3
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
      mongo:
        condition: service_healthy
      redis:
        condition: service_healthy
    networks:
      - crawler-net

  mongo:
    image: mongo:6.0.15
    container_name: crawlab-mongo
    restart: unless-stopped
    volumes:
      - mongo-data:/data/db
    healthcheck:
      test: ["CMD", "mongosh", "--eval", "db.adminCommand('ping')"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 10s
    networks:
      - crawler-net

  redis:
    image: redis:7.2.4-alpine
    container_name: crawlab-redis
    restart: unless-stopped
    volumes:
      - redis-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 5s
    networks:
      - crawler-net
`;
}

function crawlerService(index) {
  const nodeCode = `crawler-eu-${String(index).padStart(2, '0')}`;
  const healthPort = 3000 + index;
  return `  crawler-${index}:
    image: \${CRAWLER_IMAGE:?未设置 CRAWLER_IMAGE 环境变量}
    container_name: hs-sku-crawler-${index}
    restart: unless-stopped
    env_file: .env
    environment:
      - CRAWLER_MODE=service
      - CRAWLER_NODE_CODE=${nodeCode}
      - CRAWLER_HEALTH_PORT=${healthPort}
      - CRAWLER_CLIPROXY_SESSION_PREFIX=${nodeCode}
      - CRAWLER_HEADED_FALLBACK=false
    ports:
      - "127.0.0.1:${healthPort}:${healthPort}"
    volumes:
      - ./logs:/app/logs
      - ./output/${nodeCode}:/app/output
      - ./images/${nodeCode}:/app/images
    deploy:
      resources:
        limits:
          cpus: '0.5'
          memory: 800M
        reservations:
          cpus: '0.2'
          memory: 400M
    depends_on:
      redis:
        condition: service_healthy
    networks:
      - crawler-net
`;
}

function footer() {
  return `volumes:
  crawlab-data:
  mongo-data:
  redis-data:

networks:
  crawler-net:
    driver: bridge
`;
}

function generate({ nodes }) {
  const parts = [baseServices()];
  for (let i = 1; i <= nodes; i++) {
    parts.push(crawlerService(i));
  }
  parts.push(footer());
  return parts.join('\n');
}

function main(argv) {
  const { nodes, output } = parseArgs(argv);
  const content = generate({ nodes });
  fs.writeFileSync(output, content, 'utf-8');
  console.log(`已生成 ${nodes} 个 crawler 节点: ${output}`);
}

if (require.main === module) {
  main(process.argv);
}

module.exports = { parseArgs, generate, crawlerService };
```

### 步骤 2.2：编写生成脚本测试

创建 `test/deployment/generate-compose.test.js`：

```js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { generate, parseArgs } = require('../../deployment/crawlab/generate-compose');

describe('generate-compose', () => {
  it('generates 6 nodes by default', () => {
    const content = generate({ nodes: 6 });
    assert.ok(content.includes('crawler-1:'));
    assert.ok(content.includes('crawler-6:'));
    assert.ok(!content.includes('crawler-7:'));
  });

  it('assigns unique nodeCode per node', () => {
    const content = generate({ nodes: 3 });
    assert.ok(content.includes('CRAWLER_NODE_CODE=crawler-eu-01'));
    assert.ok(content.includes('CRAWLER_NODE_CODE=crawler-eu-02'));
    assert.ok(content.includes('CRAWLER_NODE_CODE=crawler-eu-03'));
    const matches = content.match(/CRAWLER_NODE_CODE=/g);
    assert.strictEqual(matches.length, 3);
  });

  it('assigns unique healthPort per node', () => {
    const content = generate({ nodes: 3 });
    assert.ok(content.includes('CRAWLER_HEALTH_PORT=3001'));
    assert.ok(content.includes('CRAWLER_HEALTH_PORT=3002'));
    assert.ok(content.includes('CRAWLER_HEALTH_PORT=3003'));
  });

  it('assigns unique sessionPrefix per node', () => {
    const content = generate({ nodes: 3 });
    assert.ok(content.includes('CRAWLER_CLIPROXY_SESSION_PREFIX=crawler-eu-01'));
    assert.ok(content.includes('CRAWLER_CLIPROXY_SESSION_PREFIX=crawler-eu-02'));
    assert.ok(content.includes('CRAWLER_CLIPROXY_SESSION_PREFIX=crawler-eu-03'));
  });

  it('binds each health port to 127.0.0.1', () => {
    const content = generate({ nodes: 3 });
    assert.ok(content.includes('"127.0.0.1:3001:3001"'));
    assert.ok(content.includes('"127.0.0.1:3002:3002"'));
    assert.ok(content.includes('"127.0.0.1:3003:3003"'));
  });

  it('uses per-node output and image directories', () => {
    const content = generate({ nodes: 2 });
    assert.ok(content.includes('./output/crawler-eu-01:/app/output'));
    assert.ok(content.includes('./output/crawler-eu-02:/app/output'));
    assert.ok(content.includes('./images/crawler-eu-01:/app/images'));
    assert.ok(content.includes('./images/crawler-eu-02:/app/images'));
  });

  it('adds resource limits to each node', () => {
    const content = generate({ nodes: 1 });
    assert.ok(content.includes("cpus: '0.5'"));
    assert.ok(content.includes('memory: 800M'));
  });

  it('rejects invalid node counts', () => {
    assert.throws(() => parseArgs(['node', 'script', '--nodes=0']), /错误/);
    assert.throws(() => parseArgs(['node', 'script', '--nodes=abc']), /错误/);
    assert.throws(() => parseArgs(['node', 'script', '--nodes=21']), /错误/);
  });
});
```

### 步骤 2.3：运行测试验证失败

```bash
npm test -- test/deployment/generate-compose.test.js
```

预期：全部失败，因为脚本和测试文件都还不存在。

### 步骤 2.4：让脚本可执行

```bash
chmod +x deployment/crawlab/generate-compose.js
```

### 步骤 2.5：运行测试验证通过

```bash
npm test -- test/deployment/generate-compose.test.js
```

预期：全部通过。

### 步骤 2.6：Commit

```bash
git add deployment/crawlab/generate-compose.js test/deployment/generate-compose.test.js
git commit -m "feat(deployment): 增加 generate-compose.js 多节点生成脚本"
```

---

## 任务 3：生成并提交 6 节点 docker-compose.yml

**背景：** 把生成脚本的默认输出作为仓库里的最终 `docker-compose.yml`，方便直接部署。

**文件：**
- 修改：`deployment/crawlab/docker-compose.yml`
- 修改：`test/deployment/crawlab-docker-compose.test.js`

### 步骤 3.1：生成 6 节点 compose 文件

```bash
node deployment/crawlab/generate-compose.js --nodes=6
```

### 步骤 3.2：验证 YAML 有效

```bash
python3 -c "import yaml; yaml.safe_load(open('deployment/crawlab/docker-compose.yml'))"
```

预期：无报错。

### 步骤 3.3：更新 crawlab-docker-compose 测试

修改 `test/deployment/crawlab-docker-compose.test.js`：

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
    assert.ok(content.includes('crawler-1:'), 'should define crawler-1 service');
    assert.ok(content.includes('crawler-6:'), 'should define crawler-6 service');
  });

  it('exposes crawlab on port 8080', () => {
    assert.ok(content.includes('"8080:8080"'), 'should expose crawlab 8080');
  });

  it('binds crawler health ports to 127.0.0.1', () => {
    assert.ok(content.includes('"127.0.0.1:3001:3001"'), 'should bind crawler-1 health port');
    assert.ok(content.includes('"127.0.0.1:3006:3006"'), 'should bind crawler-6 health port');
  });

  it('sets unique CRAWLER_HEALTH_PORT per node', () => {
    assert.ok(content.includes('CRAWLER_HEALTH_PORT=3001'), 'should set crawler-1 health port');
    assert.ok(content.includes('CRAWLER_HEALTH_PORT=3006'), 'should set crawler-6 health port');
  });

  it('sets unique CRAWLER_NODE_CODE per node', () => {
    assert.ok(content.includes('CRAWLER_NODE_CODE=crawler-eu-01'), 'should set crawler-1 node code');
    assert.ok(content.includes('CRAWLER_NODE_CODE=crawler-eu-06'), 'should set crawler-6 node code');
  });

  it('sets unique CRAWLER_CLIPROXY_SESSION_PREFIX per node', () => {
    assert.ok(content.includes('CRAWLER_CLIPROXY_SESSION_PREFIX=crawler-eu-01'), 'should set crawler-1 session prefix');
    assert.ok(content.includes('CRAWLER_CLIPROXY_SESSION_PREFIX=crawler-eu-06'), 'should set crawler-6 session prefix');
  });

  it('shares logs volume with crawlab read-only', () => {
    assert.ok(content.includes('./logs:/app/logs:ro'), 'crawlab should read logs');
  });

  it('uses per-node output and image directories', () => {
    assert.ok(content.includes('./output/crawler-eu-01:/app/output'), 'crawler-1 should have isolated output dir');
    assert.ok(content.includes('./images/crawler-eu-06:/app/images'), 'crawler-6 should have isolated images dir');
  });

  it('uses a shared crawler-net network', () => {
    assert.ok(content.includes('crawler-net:'), 'should define crawler-net');
  });

  it('pins crawlab image tag', () => {
    assert.ok(!content.includes('crawlabteam/crawlab:latest'), 'should not use crawlab latest tag');
    assert.ok(content.includes('crawlabteam/crawlab:0.6.3'), 'should pin crawlab to 0.6.3');
  });

  it('pins mongo image tag', () => {
    assert.ok(content.includes('mongo:6.0.15'), 'should pin mongo to 6.0.15');
  });

  it('pins redis image tag', () => {
    assert.ok(content.includes('redis:7.2.4-alpine'), 'should pin redis to 7.2.4-alpine');
  });

  it('adds healthchecks to mongo and redis', () => {
    assert.ok(content.includes('healthcheck:'), 'should define healthcheck');
    assert.ok(content.includes('mongosh'), 'should use mongosh for mongo healthcheck');
    assert.ok(content.includes('redis-cli'), 'should use redis-cli for redis healthcheck');
  });

  it('uses service_healthy condition in depends_on', () => {
    assert.ok(content.includes('condition: service_healthy'), 'should wait for services to be healthy');
  });

  it('adds resource limits to crawler nodes', () => {
    assert.ok(content.includes("cpus: '0.5'"), 'should limit cpu');
    assert.ok(content.includes('memory: 800M'), 'should limit memory');
  });
});
```

### 步骤 3.4：运行测试验证通过

```bash
npm test -- test/deployment/crawlab-docker-compose.test.js
```

预期：全部通过。

### 步骤 3.5：Commit

```bash
git add deployment/crawlab/docker-compose.yml test/deployment/crawlab-docker-compose.test.js
git commit -m "feat(deployment): 生成 6 节点 docker-compose.yml 并更新测试"
```

---

## 任务 4：更新 deploy.sh 适配多节点

**背景：** 首次部署时需要创建每个节点的 `output` 和 `images` 子目录。

**文件：**
- 修改：`deployment/crawlab/deploy.sh`

### 步骤 4.1：修改 deploy.sh

替换 `mkdir -p logs output images` 为循环创建每个节点的子目录。

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

if [ ! -f .env ]; then
  echo "错误:当前目录缺少 .env 文件" >&2
  exit 1
fi

export CRAWLER_IMAGE="${CRAWLER_IMAGE_BASE}:${IMAGE_TAG}"

mkdir -p logs
for i in $(seq 1 6); do
  node_code=$(printf "crawler-eu-%02d" "$i")
  mkdir -p "output/${node_code}" "images/${node_code}"
done

docker compose pull
docker compose up -d

echo "部署完成:${CRAWLER_IMAGE}"
docker compose ps
```

### 步骤 4.2：验证语法

```bash
bash -n deployment/crawlab/deploy.sh
```

预期：无报错。

### 步骤 4.3：Commit

```bash
git add deployment/crawlab/deploy.sh
git commit -m "feat(deployment): deploy.sh 创建多节点子目录"
```

---

## 任务 5：更新 update.sh 适配多节点

**背景：** 升级时需要记录每个节点当前镜像，并更新所有 crawler 服务。

**文件：**
- 修改：`deployment/crawlab/update.sh`

### 步骤 5.1：修改 update.sh

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

if [ ! -f .env ]; then
  echo "错误:当前目录缺少 .env 文件" >&2
  exit 1
fi

if [[ ! "${IMAGE_TAG}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "警告：镜像 tag 格式不符合 vX.Y.Z 规范，继续执行: ${IMAGE_TAG}" >&2
fi

export CRAWLER_IMAGE="${CRAWLER_IMAGE_BASE}:${IMAGE_TAG}"

# 记录每个 crawler 节点当前镜像
> .last_image
for i in $(seq 1 6); do
  container_name=$(printf "hs-sku-crawler-%d" "$i")
  current_image=$(docker inspect --format='{{.Config.Image}}' "$container_name" 2>/dev/null || true)
  if [ -n "$current_image" ]; then
    echo "$container_name=$current_image" >> .last_image
  fi
done

docker compose pull crawler-1 crawler-2 crawler-3 crawler-4 crawler-5 crawler-6
for i in $(seq 1 6); do
  docker compose up -d --no-deps "crawler-$i"
done

echo "更新完成:${CRAWLER_IMAGE}"
docker compose ps
```

### 步骤 5.2：验证语法

```bash
bash -n deployment/crawlab/update.sh
```

预期：无报错。

### 步骤 5.3：Commit

```bash
git add deployment/crawlab/update.sh
git commit -m "feat(deployment): update.sh 支持多节点镜像记录与滚动更新"
```

---

## 任务 6：更新 rollback.sh 适配多节点

**背景：** 回滚时需要读取 `.last_image` 中每个节点记录的镜像，并分别回滚。

**文件：**
- 修改：`deployment/crawlab/rollback.sh`

### 步骤 6.1：修改 rollback.sh

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

# 按容器名逐行回滚
while IFS='=' read -r container_name image; do
  [ -z "$container_name" ] && continue
  [ -z "$image" ] && continue
  service_name=${container_name#hs-sku-crawler-}
  service_name="crawler-${service_name}"
  echo "回滚 ${service_name} 到 ${image}"
  docker rm -f "$container_name" 2>/dev/null || true
  docker run -d \
    --name "$container_name" \
    --network crawler-net \
    --env-file .env \
    -e CRAWLER_IMAGE="$image" \
    "$image"
done < .last_image

echo "回滚完成"
docker compose ps
```

**等等，上面的实现有问题。** 直接用 `docker run` 会丢失 compose 里的 ports/volumes/depends_on/resource limits 等配置。更好的做法是使用 `docker compose up -d --no-deps <service>` 配合环境变量指定镜像。

但 `docker compose up` 读取的是 compose 文件里的 `image: ${CRAWLER_IMAGE}`，所以需要在运行前设置 `CRAWLER_IMAGE` 环境变量。每个服务可以分别设置。

修正后的 `rollback.sh`：

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

# 按容器名逐行回滚
while IFS='=' read -r container_name image; do
  [ -z "$container_name" ] && continue
  [ -z "$image" ] && continue
  service_index=${container_name#hs-sku-crawler-}
  service_name="crawler-${service_index}"
  echo "回滚 ${service_name} 到 ${image}"
  CRAWLER_IMAGE="$image" docker compose up -d --no-deps "$service_name"
done < .last_image

echo "回滚完成"
docker compose ps
```

### 步骤 6.2：验证语法

```bash
bash -n deployment/crawlab/rollback.sh
```

预期：无报错。

### 步骤 6.3：Commit

```bash
git add deployment/crawlab/rollback.sh
git commit -m "feat(deployment): rollback.sh 支持多节点逐节点回滚"
```

---

## 任务 7：更新 .env.example

**背景：** 多节点场景下，`CRAWLER_NODE_CODE`、`CRAWLER_HEALTH_PORT`、`CRAWLER_CLIPROXY_SESSION_PREFIX` 会被每个服务覆盖，需要在 `.env.example` 中说明。

**文件：**
- 修改：`deployment/crawlab/.env.example`

### 步骤 7.1：修改 .env.example

```bash
# Docker 镜像配置
CRAWLER_IMAGE_BASE=ghcr.io/<GITHUB_OWNER>/<REPO>

# 上游 API
# 注意:多节点部署时,CRAWLER_NODE_CODE/HEALTH_PORT/SESSION_PREFIX 由 docker-compose.yml 按节点覆盖
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
# 多节点共用同一组账号,通过 per-node sessionPrefix 避免 IP 冲突
CLIPROXY_HOST=eu.cliproxy.io
CLIPROXY_PORT=1080
CLIPROXY_USERNAME=your-cliproxy-username
CLIPROXY_PASSWORD=your-cliproxy-password
CLIPROXY_REGION=EU
CLIPROXY_STICKY_MINUTES=30
CLIPROXY_SESSION_PREFIX=crawler-eu-01
```

### 步骤 7.2：Commit

```bash
git add deployment/crawlab/.env.example
git commit -m "docs(deployment): .env.example 补充多节点配置说明"
```

---

## 任务 8：更新 部署vps.md

**背景：** 需要把多节点部署、生成脚本、单节点运维写进用户文档。

**文件：**
- 修改：`部署vps.md`

### 步骤 8.1：在文档末尾新增「十二、多节点部署」章节

追加内容：

```markdown
## 十二、多节点部署（单 VPS 多 crawler 节点）

当单台 VPS 配置较高（如 6C8G）时，可以运行多个 crawler 节点以充分利用资源。

### 12.1 生成多节点 compose 文件

默认生成 6 个节点：

```bash
cd deployment/crawlab
node generate-compose.js
```

生成 4 个节点：

```bash
node generate-compose.js --nodes=4
```

节点编号为 `crawler-1` ~ `crawler-N`，对应：
- `CRAWLER_NODE_CODE`: `crawler-eu-01` ~ `crawler-eu-0N`
- `CRAWLER_HEALTH_PORT`: `3001` ~ `3000+N`
- `CRAWLER_CLIPROXY_SESSION_PREFIX`: 与 `nodeCode` 相同，避免 IP 冲突

### 12.2 首次部署

```bash
export CRAWLER_IMAGE_BASE=ghcr.io/<owner>/<repo>
./deploy.sh v1.0.0
```

`deploy.sh` 会自动创建每个节点的 `output/crawler-eu-0N` 和 `images/crawler-eu-0N` 子目录。

### 12.3 在 crawlab 中添加节点

进入 crawlab Web UI → 节点 → 添加节点：

| 节点名称 | 节点地址 |
|----------|----------|
| crawler-eu-01 | http://crawler-1:3001/health |
| crawler-eu-02 | http://crawler-2:3002/health |
| ... | ... |
| crawler-eu-06 | http://crawler-6:3006/health |

### 12.4 升级全部节点

```bash
git tag v1.2.3
git push origin v1.2.3
```

GitHub Actions 会自动执行 `./update.sh v1.2.3`，滚动升级所有 crawler 节点。

### 12.5 单节点运维

```bash
# 停止节点 3
docker compose stop crawler-3

# 删除并重建节点 3
docker compose rm -f crawler-3
docker compose up -d crawler-3

# 查看单个节点日志
docker compose logs -f crawler-3
```

如需新增或删除节点，用 `generate-compose.js --nodes=N` 重新生成 compose 文件，并在 crawlab UI 中同步节点配置。

### 12.6 资源与风险

- 6 节点 × 2 channel 约占用 6.25 GB 内存 limit，请根据实际 `docker stats` 调整。
- 每个节点使用独立的 `output`/`images` 子目录，避免文件冲突。
- 所有节点共用同一组 Cliproxy 账号，靠不同 `sessionPrefix` 获取不同 IP。
```

### 步骤 8.2：Commit

```bash
git add 部署vps.md
git commit -m "docs: 部署文档增加多节点部署章节"
```

---

## 任务 9：运行全部测试并验证

**背景：** 确保所有修改没有破坏现有功能。

### 步骤 9.1：运行全部测试

```bash
npm test
```

预期：所有测试通过。

### 步骤 9.2：检查生成后的 docker-compose.yml

```bash
python3 -c "import yaml; data = yaml.safe_load(open('deployment/crawlab/docker-compose.yml')); print('services:', list(data['services'].keys()))"
```

预期输出包含 `crawlab`, `mongo`, `redis`, `crawler-1` ~ `crawler-6`。

### 步骤 9.3：Commit（如测试通过）

如果测试通过，无需额外 commit（每个任务已单独 commit）。

---

## 自检

### 规格覆盖度

| 设计文档章节 | 实现任务 |
|--------------|----------|
| 生成脚本与动态扩缩 | 任务 2 |
| 资源配置 | 任务 2（生成脚本中 hardcode limits） |
| 配置策略 | 任务 1、任务 7 |
| 代理与 IP 隔离 | 任务 2（生成脚本设置不同 sessionPrefix） |
| 共享任务队列 | 无代码变更，属于运营假设 |
| 日志与监控 | 无代码变更，依赖现有健康端点 |
| 部署与升级 | 任务 4、5、6 |
| 安全 | 健康端口绑定 127.0.0.1 已在任务 2 中生成 |
| 磁盘空间管理 | 文档说明（任务 8） |
| 测试策略 | 任务 1、2、3 |

### 占位符扫描

- 无 "TODO"、"待定"、"后续实现"。
- 所有代码步骤包含完整代码。
- 所有命令包含预期输出。

### 类型一致性

- `healthPort` 在 `src/cli.js`、`bin/run.js`、测试中均使用同一属性名。
- `nodeCode` 命名规则 `crawler-eu-NN` 在生成脚本、deploy.sh、.env.example、文档中一致。
- 容器名 `hs-sku-crawler-N` 在生成脚本、update.sh、rollback.sh 中一致。

### 遗留问题

- rollback.sh 使用 `CRAWLER_IMAGE=... docker compose up -d --no-deps crawler-N` 的方式依赖 compose 文件中 `image: ${CRAWLER_IMAGE}` 的语法。当前生成脚本已使用该语法，一致。
- 如果节点数量从 6 改为 4，`.last_image` 中可能残留 crawler-5/6 的记录，update.sh 的重定向 `> .last_image` 会先清空文件再写入，因此不会残留旧节点记录。
- 生成脚本中资源限制是 hardcode 的（0.5 CPU / 800M）。如需按节点数动态调整，后续可扩展 `--cpu-limit` 和 `--memory-limit` 参数，但当前 YAGNI。
