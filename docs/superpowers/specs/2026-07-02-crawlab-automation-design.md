# 海外 VPS + crawlab 自动化部署与监控设计

**日期:** 2026-07-02  
**目标:** 将 `hs-sku-crawler` 从半自动 Docker 部署升级为「一键初始化 + GitHub Actions 自动发布 + crawlab 统一监控」的完整方案,并预留未来 Windows PM2 爬虫接入 crawlab 的扩展接口。

---

## 1. 背景与目标

### 1.1 当前痛点

- 现有 `deployment/linux/` 脚本已实现 Docker 部署,但首次部署仍需人工 SSH、上传文件、编辑 `.env`、执行 `./deploy.sh <tag>`
- 后续升级需要再次 SSH 到 VPS 执行 `./update.sh <tag>`
- 服务内部有健康检查,但**没有对外暴露 HTTP 健康接口**,外部监控平台无法直接感知节点状态
- 日志为纯文本,不利于 crawlab 等监控平台聚合分析
- 仓库内无 crawlab 相关配置,无法与其他爬虫统一纳管

### 1.2 新 VPS 环境

- 机型:BandwagonHost SPECIAL 160G KVM PROMO V5
- 配置:6 vCPU / 8 GB RAM / 160 GB SSD / 5000 GB 月流量 / 5 Gbps
- 位置:洛杉矶(CN2 GIA)或日本(Softbank),可自由迁移
- 系统:Ubuntu 22.04 LTS(推荐)
- 目标站点:eur.vevor.com,出口代理仍使用 **Cliproxy EU 住宅 IP**

### 1.3 设计目标

1. **首次部署自动化**:本地执行一条命令即可完成 VPS 初始化、Docker 安装、仓库克隆、目录准备
2. **后续升级自动化**:push tag 后 GitHub Actions 自动构建镜像并部署到 VPS
3. **监控可视化**:crawlab 作为管理端,可查看节点健康、任务量、日志
4. **扩展预留**:为未来 Windows PM2 爬虫接入 crawlab 预留接口,本次不实现
5. **可回滚**:保留 `./rollback.sh` 能力,Actions 支持重新部署旧 tag

---

## 2. 总体架构

```text
┌─────────────────────────────────────────────────────────────┐
│                       GitHub Actions                         │
│  push tag v1.x.x  →  build image  →  ssh deploy to VPS       │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  VPS (Bandwagon CN2 GIA, 6C8G, Ubuntu 22.04)                │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────┐  │
│  │   crawlab    │  │  MongoDB     │  │  hs-sku-crawler │  │
│  │   :8080      │  │  (metadata)  │  │  (Docker)       │  │
│  └──────┬───────┘  └──────────────┘  └────────┬────────┘  │
│         │                                       │           │
│         └───────────────┬───────────────────────┘           │
│                         │                                   │
│                  Redis (task queue / cache)                 │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Cliproxy EU Gateway                                        │
│  → 每个 channel 一个住宅 IP                                  │
└─────────────────────────────────────────────────────────────┘
```

### 2.1 数据流

1. 开发者在本地 `git tag v1.x.x && git push origin v1.x.x`
2. GitHub Actions 构建 `hs-sku-crawler` 镜像并推送到 GHCR
3. Actions 通过 SSH 在 VPS 上执行 `docker compose pull crawler && docker compose up -d crawler`
4. `hs-sku-crawler` 容器启动后,通过 `CliproxyPool` 分配粘性住宅 IP
5. 容器按原有轮询逻辑从上游 API 拉取任务,同时启动 `:3000/health` HTTP 服务
6. crawlab 通过 `http://crawler:3000/health` 轮询节点健康,并在 `:8080` 提供 Web UI
7. 结构化日志写入 `./logs/crawler.jsonl`,crawlab 可通过 volume 挂载只读查看

### 2.2 关键约束

- crawlab 与 crawler 在同一 Docker network `crawler-net`,通过服务名互访
- 外部仅暴露 22(SSH)、8080(crawlab Web)、3000(可选,健康检查,建议限制为 127.0.0.1)
- Cliproxy 凭据只存在于 `.env`,不进镜像、不进 GitHub Actions 日志
- MongoDB/Redis 仅供 crawlab 使用,与现有 crawler 配置无冲突

---

## 3. Docker Compose 编排

新增文件 `deployment/crawlab/docker-compose.yml`。

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
    image: ${CRAWLER_IMAGE:?未设置 CRAWLER_IMAGE}
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

### 3.1 说明

- `crawler` 服务新增 `CRAWLER_HEALTH_PORT=3000`,用于打开健康 HTTP 服务
- `crawler` 服务的健康端口绑定到 `127.0.0.1:3000`,避免直接暴露公网;crawlab 通过 Docker network 访问
- `./logs` 同时挂载给 crawler(读写)和 crawlab(只读),方便 crawlab 聚合日志
- `depends_on` 仅控制启动顺序,不等待服务就绪;健康检查由 crawlab 轮询完成

---

## 4. 健康端点与指标

### 4.1 HTTP 健康服务

在 `src/service.js` 中内嵌一个轻量 HTTP 服务,使用 Node.js 原生 `http` 模块,不引入 express 等额外依赖。

**启动条件:** 当 `config.healthPort` 存在时启动,监听 `0.0.0.0:${healthPort}`。

**接口:**

```http
GET /health
```

**响应示例:**

```json
{
  "status": "ok",
  "nodeCode": "crawler-eu-01",
  "timestamp": "2026-07-02T11:30:00.000Z",
  "uptime": 3600,
  "browserConnected": true,
  "channels": [
    { "id": 1, "healthy": true, "proxy": "http://***@eu.cliproxy.io:1080" },
    { "id": 2, "healthy": true, "proxy": "http://***@eu.cliproxy.io:1080" }
  ],
  "queue": {
    "pending": 3,
    "running": 2,
    "completed": 128
  }
}
```

**状态码:**

- `200`:状态为 `ok`
- `503`:状态为 `degraded` 或 `error`

### 4.2 指标字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `status` | string | `ok` / `degraded` / `error` |
| `nodeCode` | string | 节点标识,对应 `CRAWLER_NODE_CODE` |
| `uptime` | number | 进程运行秒数 |
| `browserConnected` | boolean | Playwright 浏览器是否仍连接 |
| `channels` | array | 每个通道的健康状态和代理地址(密码脱敏) |
| `queue.pending` | number | 待处理任务数 |
| `queue.running` | number | 运行中任务数 |
| `queue.completed` | number | 已完成任务数 |

### 4.3 crawlab 配置

在 crawlab Web UI 中:

1. 进入「节点」页面
2. 点击「添加节点」
3. 节点地址填写 `http://crawler:3000/health`
4. 轮询间隔设为 30 秒
5. 保存后 crawlab 自动判断节点在线/离线

---

## 5. 结构化日志

### 5.1 日志格式

新增 `src/logger.js`,统一输出 JSON Lines(NDJSON)格式:

```json
{"time":"2026-07-02T11:30:01.234Z","level":"INFO","component":"service","msg":"browser restarted","nodeCode":"crawler-eu-01","channel":1}
{"time":"2026-07-02T11:30:05.123Z","level":"WARN","component":"channel","msg":"proxy rotation","nodeCode":"crawler-eu-01","channel":1,"proxy":"eu.cliproxy.io:1080"}
```

### 5.2 日志级别

- `INFO`:常规生命周期事件(启动、关闭、浏览器重启)
- `WARN`:可恢复异常(代理轮换、健康检查失败但已恢复)
- `ERROR`:需要人工介入(浏览器启动失败、上游 API 连续失败)

### 5.3 输出位置

- 控制台 stdout/stderr(容器默认)
- 文件 `./logs/crawler.jsonl`(新增 volume 挂载)

crawlab 可通过读取 `./logs/crawler.jsonl` 聚合日志,也可直接读取容器 stdout。

---

## 6. GitHub Actions CI/CD

新增文件 `.github/workflows/deploy-vps.yml`。

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

      - name: Log in to Registry
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

### 6.1 触发方式

```bash
git tag v1.2.3
git push origin v1.2.3
```

### 6.2 需要配置的 GitHub Secrets

| Secret | 说明 |
|--------|------|
| `VPS_HOST` | VPS 公网 IP |
| `VPS_USER` | 部署用户名,如 `crawler` |
| `VPS_SSH_KEY` | SSH 私钥,对应 VPS 上 `~/.ssh/authorized_keys` |

### 6.3 部署流程

1. 开发者 push tag
2. Actions `build` job 构建镜像并推送到 GHCR
3. Actions `deploy` job 通过 SSH 在 VPS 上执行 `update.sh`
4. `update.sh` 拉取新镜像,滚动重启 crawler 容器
5. crawlab 轮询 `/health`,节点恢复在线

---

## 7. VPS 一键初始化脚本

新增文件 `deployment/crawlab/setup-vps.sh`。

```bash
#!/bin/bash
set -euo pipefail

VPS_IP="${1:?请提供 VPS IP}"
SSH_USER="${2:-root}"

echo ">>> 1. 安装 Docker"
ssh "${SSH_USER}@${VPS_IP}" '
  apt update && apt upgrade -y
  curl -fsSL https://get.docker.com | sh
  apt install -y docker-compose-plugin git
'

echo ">>> 2. 创建部署用户"
ssh "${SSH_USER}@${VPS_IP}" '
  useradd -m -s /bin/bash crawler || true
  usermod -aG docker crawler
  mkdir -p /opt/crawler && chown crawler:crawler /opt/crawler
'

echo ">>> 3. 克隆仓库"
ssh "crawler@${VPS_IP}" '
  # 注意：将 <GITHUB_OWNER>/<REPO> 替换为实际仓库地址
  git clone https://github.com/<GITHUB_OWNER>/<REPO>.git /opt/crawler/repo
  ln -s /opt/crawler/repo/deployment/crawlab/* /opt/crawler/
'

echo ">>> 4. 初始化 .env"
ssh "crawler@${VPS_IP}" '
  cd /opt/crawler
  cp .env.example .env
  echo "请手动编辑 /opt/crawler/.env 后执行 ./deploy.sh <tag>"
'

echo ">>> 完成。请执行:"
echo "    ssh crawler@${VPS_IP}"
echo "    cd /opt/crawler"
echo "    # 编辑 .env"
echo "    # 注意：将 <GITHUB_OWNER>/<REPO> 替换为实际仓库地址"
echo "    export CRAWLER_IMAGE_BASE=ghcr.io/<GITHUB_OWNER>/<REPO>"
echo "    ./deploy.sh v1.0.0"
```

### 7.1 使用方式

```bash
./deployment/crawlab/setup-vps.sh 203.0.113.10 root
```

### 7.2 首次部署完整流程

```bash
# 1. 本地执行初始化
./deployment/crawlab/setup-vps.sh 203.0.113.10 root

# 2. SSH 到 VPS 填写敏感配置
ssh crawler@203.0.113.10
cd /opt/crawler
nano .env

# 3. 启动服务
export CRAWLER_IMAGE_BASE=ghcr.io/<your-org>/<repo>
./deploy.sh v1.0.0

# 4. 验证
watch docker compose ps
```

后续升级只需 push tag,无需再次 SSH。

---

## 8. 安全与回滚

### 8.1 安全措施

- `.env` 文件权限设为 `600`,不进入 git
- SSH 使用密钥登录,GitHub Actions 私钥存于 Secrets
- crawler 健康端口仅监听 `127.0.0.1:3000`,crawlab 通过容器网络访问
- crawlab 8080 端口如需公网访问,建议前置 Nginx + Basic Auth
- 镜像构建时确保 Cliproxy 密码等凭据不进层缓存
- GitHub Actions 日志中不打印 `.env` 内容

### 8.2 回滚

保留现有 `deployment/linux/rollback.sh`,并在 `deployment/crawlab/` 中通过符号链接或复制复用。也可在 `deployment/crawlab/` 下新建同名脚本,内部调用 `docker compose -f docker-compose.yml up -d --no-deps crawler` 实现回滚。

```bash
./rollback.sh
```

回滚到上一次 `update.sh` 记录的镜像 tag。GitHub Actions 也支持手动触发旧 tag 重新部署。

---

## 9. Windows PM2 爬虫接入预留

本次不实现,但预留以下接口,避免未来重构:

### 9.1 节点标识

`CRAWLER_NODE_CODE` 支持按机器名区分,例如:

- VPS Docker 节点:`crawler-eu-01`
- Windows PM2 节点:`win-office-01`

### 9.2 CLI 任务模式入口

`src/cli.js` 保留 `--mode=task` 扩展空间,未来可支持:

```bash
node bin/run.js --mode=task --task-id=xxx --sku=xxx
```

### 9.3 统一日志格式

Windows PM2 节点未来也采用同样的 JSON Lines 日志格式,方便 crawlab 跨平台聚合。

### 9.4 健康端点复用

Windows 节点未来可运行一个轻量 HTTP 服务复用 `/health` 接口,字段保持一致。

---

## 10. 测试策略

| 测试目标 | 方式 |
|----------|------|
| `/health` 返回正确 JSON | 新增 `test/service-health.test.js` |
| 健康服务随 `CRAWLER_HEALTH_PORT` 启动 | 同上 |
| 日志 JSON 格式正确 | 新增 `test/logger.test.js` |
| `deployment/crawlab/docker-compose.yml` 语法 | 新增 `test/deployment/crawlab-docker-compose.test.js` |
| `setup-vps.sh` 脚本存在且可执行 | 新增 `test/deployment/crawlab-setup.test.js` |
| GitHub Actions workflow YAML 语法 | 使用 `actionlint` 或静态测试 |

---

## 11. 依赖与风险

### 11.1 新增依赖

- Docker 镜像:`crawlabteam/crawlab:latest`、`mongo:6`、`redis:7-alpine`
- GitHub Actions 官方 action:`docker/setup-buildx-action`、`docker/login-action`、`docker/build-push-action`、`appleboy/ssh-action`
- 代码:无新增 npm 包(使用 Node.js 原生 `http`)

### 11.2 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| crawlab 容器资源占用高 | 6C8G 可能紧张 | 监控 `docker stats`,必要时升级配置或拆分 crawlab |
| GitHub Actions SSH 失败 | 无法自动部署 | 保留手动 `./update.sh` 降级路径 |
| 健康端口暴露公网 | 信息泄露 | 绑定 `127.0.0.1`,仅容器网络访问 |
| crawlab 版本升级不兼容 | 监控失效 | 固定 `crawlabteam/crawlab` 镜像 tag,升级前测试 |

---

## 12. 任务拆分建议

实现阶段建议按以下顺序:

1. 新增 `/health` HTTP 端点 + 测试
2. 新增结构化日志 `src/logger.js` + 测试
3. 新增 `deployment/crawlab/docker-compose.yml` + 测试
4. 新增 `deployment/crawlab/.env.example`
5. 新增 `deployment/crawlab/setup-vps.sh` + 测试
6. 新增 `.github/workflows/deploy-vps.yml`
7. 更新 `部署vps.md`,补充 crawlab 章节
8. 在测试环境(或本地)验证 compose 可启动
9. 真实 VPS 首次部署验证

---

## 13. 参考

- [crawlab 官方文档](https://docs.crawlab.cn/)
- [GitHub Actions 文档](https://docs.github.com/cn/actions)
- [Docker Compose 文档](https://docs.docker.com/compose/)
- 本项目既有设计:`docs/superpowers/specs/2026-06-27-overseas-vps-residential-proxy-design.md`