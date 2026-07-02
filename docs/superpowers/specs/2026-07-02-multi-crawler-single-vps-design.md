# 单 VPS 多 crawler 节点部署设计

**日期:** 2026-07-02  
**目标:** 在已有 crawlab + Docker 部署基础上，把单台 VPS 的 6C8G 资源充分利用起来，运行多个 `hs-sku-crawler` 节点，并通过 crawlab 统一纳管。

---

## 1. 背景与目标

### 1.1 当前状态

- 已完成 crawlab + 单个 crawler 容器的自动化部署。
- 当前 `deployment/crawlab/docker-compose.yml` 只有一个 `crawler` 服务。
- VPS 配置为 6 vCPU / 8 GB RAM / 160 GB SSD，单个 crawler 节点无法充分利用。

### 1.2 新目标

1. **资源利用**：在单台 VPS 上运行 4-6 个 crawler 节点。
2. **统一管理**：所有节点通过 crawlab 的「节点」页面集中监控健康状态。
3. **共用代理**：多节点共用同一组 Cliproxy 账号，同时避免 IP 冲突。
4. **自由扩缩**：支持通过生成脚本调整节点数量，支持单独启停/重建某个节点。
5. **自动升级**：保持 GitHub Actions push-tag 自动升级全部节点的能力。

---

## 2. 总体架构

```text
┌─────────────────────────────────────────────────────────────┐
│                       GitHub Actions                         │
│  push tag v*  →  build image  →  ssh deploy to VPS           │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  VPS (Bandwagon CN2 GIA, 6C8G, Ubuntu 22.04)                │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────┐   │
│  │   crawlab    │  │  MongoDB     │  │  hs-sku-crawler │   │
│  │   :8080      │  │  (metadata)  │  │  × N instances  │   │
│  └──────┬───────┘  └──────────────┘  └────────┬────────┘   │
│         │                                       │            │
│         └───────────────┬───────────────────────┘            │
│                         │                                    │
│                  Redis (task queue / cache)                  │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 2.1 节点清单（默认 6 节点）

| 服务名 | 容器名 | nodeCode | healthPort | crawlab 访问地址 |
|--------|--------|----------|------------|------------------|
| crawler-1 | hs-sku-crawler-1 | crawler-eu-01 | 3001 | http://crawler-1:3001/health |
| crawler-2 | hs-sku-crawler-2 | crawler-eu-02 | 3002 | http://crawler-2:3002/health |
| crawler-3 | hs-sku-crawler-3 | crawler-eu-03 | 3003 | http://crawler-3:3003/health |
| crawler-4 | hs-sku-crawler-4 | crawler-eu-04 | 3004 | http://crawler-4:3004/health |
| crawler-5 | hs-sku-crawler-5 | crawler-eu-05 | 3005 | http://crawler-5:3005/health |
| crawler-6 | hs-sku-crawler-6 | crawler-eu-06 | 3006 | http://crawler-6:3006/health |

### 2.2 数据流

1. 开发者 push tag。
2. GitHub Actions 构建镜像并推送到 GHCR。
3. Actions SSH 到 VPS 执行 `./update.sh <tag>`。
4. `update.sh` 拉取新镜像并滚动重启 `crawler-1` ~ `crawler-6`。
5. 每个节点启动后监听各自 healthPort，并通过 `CliproxyPool` 获取粘性住宅 IP。
6. 所有节点共享同一个上游任务 API，自然形成负载均衡。
7. crawlab 轮询 6 个健康端点，展示节点在线状态。

---

## 3. 生成脚本与动态扩缩

新增 `deployment/crawlab/generate-compose.js`。

### 3.1 用法

```bash
# 生成默认 6 节点的 docker-compose.yml
node deployment/crawlab/generate-compose.js

# 生成 4 节点
node deployment/crawlab/generate-compose.js --nodes=4

# 生成 8 节点
node deployment/crawlab/generate-compose.js --nodes=8
```

### 3.2 输出规则

- 基础服务 `crawlab` / `mongo` / `redis` 保持不变。
- 根据 `--nodes` 生成 `crawler-1` ~ `crawler-N`。
- 每个节点的 `container_name`、`CRAWLER_NODE_CODE`、`CRAWLER_HEALTH_PORT`、`CRAWLER_CLIPROXY_SESSION_PREFIX` 自动递增。
- 每个节点使用独立的 volume 或子目录，避免文件冲突。

### 3.3 单独启停/重建节点

```bash
# 停止节点 3
docker compose stop crawler-3

# 删除并重建节点 3
docker compose rm -f crawler-3
docker compose up -d crawler-3

# 查看单个节点日志
docker compose logs -f crawler-3
```

### 3.4 替换节点编号

如需废弃 `crawler-3` 并新增 `crawler-7`：

1. 停止并删除 `crawler-3`。
2. 用 `--nodes=7` 重新生成 compose 文件。
3. 执行 `docker compose up -d`。
4. 在 crawlab UI 中删除旧节点 `crawler-eu-03`，添加新节点 `http://crawler-7:3007/health`。

---

## 4. 资源配置（6C8G 场景）

### 4.1 基础服务

| 服务 | CPU limit | 内存 limit |
|------|-----------|------------|
| crawlab | 0.5 | 512 MB |
| mongo | 0.5 | 512 MB |
| redis | 0.25 | 256 MB |

### 4.2 每个 crawler 节点（6 节点 × 2 channel）

| 资源 | limit | reservation |
|------|-------|-------------|
| CPU | 0.5 | 0.2 |
| 内存 | 800 MB | 400 MB |

### 4.3 总占用估算

- CPU limit：约 4.25 vCPU（留 burst 余量）
- 内存 limit：约 6.25 GB（留 1.75 GB 缓冲）

### 4.4 调整建议

- 如果每节点保持 4 channel，建议节点数降到 4，否则内存吃紧。
- 如果 CPU 成为瓶颈，可减少 channel 数或节点数。
- 通过 `docker stats` 持续观察，按需调整。

---

## 5. 配置策略

### 5.1 共享配置

继续放在 `.env`，包括：

- 上游 API 地址与 node token
- Cliproxy 账号密码
- 通用爬虫参数（delay、retry、headless 等）

### 5.2 节点专属覆盖

在生成的 `docker-compose.yml` 中，每个 crawler 服务通过 `environment` 覆盖：

```yaml
services:
  crawler-1:
    container_name: hs-sku-crawler-1
    env_file: .env
    environment:
      - CRAWLER_MODE=service
      - CRAWLER_NODE_CODE=crawler-eu-01
      - CRAWLER_HEALTH_PORT=3001
      - CRAWLER_CLIPROXY_SESSION_PREFIX=crawler-eu-01
      - CRAWLER_CHANNELS=2
      - CRAWLER_OUTPUT_DIR=/app/output/crawler-eu-01
      - CRAWLER_IMAGE_DIR=/app/images/crawler-eu-01
      - CRAWLER_BROWSER_TEMP_DIR=/app/output/browser-temp/crawler-eu-01
      - CRAWLER_CLIPROXY_ASSIGNMENTS_FILE=/app/output/proxy-assignments-crawler-eu-01.json
    ports:
      - "127.0.0.1:3001:3001"
```

### 5.3 需要修复的配置读取

当前 `bin/run.js` 的 `buildServiceConfig` 没有读取 `CRAWLER_HEALTH_PORT`，导致健康服务不会启动。需要新增：

```js
healthPort: config.healthPort !== undefined ? Number(config.healthPort) : undefined,
```

同时 `src/cli.js` 的 envMap 增加：

```js
CRAWLER_HEALTH_PORT: 'healthPort',
```

---

## 6. 代理与 IP 隔离

### 6.1 共用 Cliproxy 账号的可行性

完全可以共用同一组 Cliproxy 账号，只要保证每个节点的 session 标识唯一。

### 6.2 IP 防冲突机制

Cliproxy 通过用户名中的 session 字段分配粘性住宅 IP：

```
<username>-session-<sessionPrefix>-ch-<channel>
```

- 相同 session 标识 → 相同 IP
- 不同 session 标识 → 不同 IP

### 6.3 设计方案

每个节点使用不同的 `CRAWLER_CLIPROXY_SESSION_PREFIX`：

| 节点 | sessionPrefix |
|------|---------------|
| crawler-1 | crawler-eu-01 |
| crawler-2 | crawler-eu-02 |
| ... | ... |
| crawler-6 | crawler-eu-06 |

这样 6 节点 × 2 channel = 12 个完全不同的 session，拿到 12 个不同的住宅 IP。

### 6.4 注意事项

- 禁止所有节点使用相同的 `sessionPrefix`。
- `sessionPrefix` 与 `nodeCode` 保持一致，便于排查问题。
- 节点重建后 sessionPrefix 不变则 IP 不变；更换 sessionPrefix 会重新分配 IP。

---

## 7. 共享任务队列的影响

### 7.1 自然负载均衡

6 个节点同时轮询同一个上游任务 API，每个节点只拉取自己能处理的任务，整体吞吐量提升。

### 7.2 潜在风险

- 如果上游 API 没有任务去重/锁定机制，可能出现多个节点抢到同一任务。
- 设计上假设上游已处理任务分配。
- 如后续发现抢任务问题，可在 crawler 侧通过 `nodeCode` 做任务过滤，或引入 Redis 分布式锁。

---

## 8. 日志与监控

### 8.1 日志文件组织

每个节点写入独立的 JSON Lines 日志：

```
logs/
  crawler-eu-01.jsonl
  crawler-eu-02.jsonl
  ...
  crawler-eu-06.jsonl
```

crawlab 挂载整个 `logs` 目录只读，按文件名查看不同节点日志。

### 8.2 健康端点

每个节点保持现有 `/health` 响应格式，crawlab 中配置 6 个节点地址：

- `http://crawler-1:3001/health`
- `http://crawler-2:3002/health`
- ...
- `http://crawler-6:3006/health`

### 8.3 资源监控

- 使用 `docker stats` 查看各节点 CPU/内存。
- 后续可考虑 node-exporter + Prometheus + Grafana（本次不实现）。

---

## 9. 部署与升级

### 9.1 首次部署

```bash
# 本地或 VPS 上生成 compose 文件
node deployment/crawlab/generate-compose.js --nodes=6

# 编辑 .env 填入敏感配置
nano .env

# 启动全部服务
export CRAWLER_IMAGE_BASE=ghcr.io/<owner>/<repo>
./deploy.sh v1.0.0
```

### 9.2 后续升级

```bash
git tag v1.2.3
git push origin v1.2.3
```

GitHub Actions 构建镜像后 SSH 执行：

```bash
cd /opt/crawler
export CRAWLER_IMAGE_BASE=ghcr.io/<owner>/<repo>
./update.sh v1.2.3
```

`update.sh` 会滚动重启 `crawler-1` ~ `crawler-6`。

### 9.3 滚动升级策略

- 默认 `docker compose up -d` 会按依赖顺序更新服务。
- 如需金丝雀升级，可先更新 `crawler-1`，观察健康后再更新其余节点：

```bash
for n in 1 2 3 4 5 6; do
  docker compose up -d crawler-$n
  sleep 30
done
```

### 9.4 回滚

`./rollback.sh` 读取 `.last_image`，回滚到上一次镜像 tag。

---

## 10. 安全

- 所有 health 端口绑定 `127.0.0.1`，不直接暴露公网。
- crawlab 8080 如需公网访问，前置 Nginx + Basic Auth。
- `.env` 权限保持 `600`。
- Cliproxy 凭据只存在于 `.env`，不进镜像、不进 GitHub Actions 日志。
- 每个节点使用独立的 output/images/browser-temp 目录，避免临时文件冲突和权限问题。

---

## 11. 磁盘空间管理

6 个节点同时写图片和临时文件，160 GB SSD 消耗较快。建议：

- 定期清理 `output/images` 中过期图片（如保留 7 天）。
- 定期清理 `output/browser-temp` 中过期缓存。
- 对 `logs/*.jsonl` 做日志轮转，避免单文件过大。
- 监控 `df -h`，剩余空间低于 20% 时告警。

---

## 12. 测试策略

| 测试目标 | 方式 |
|----------|------|
| `generate-compose.js` 按节点数生成正确服务 | 新增 `test/deployment/generate-compose.test.js` |
| 生成后的 `docker-compose.yml` 语法有效 | 使用 Python `yaml.safe_load` 验证 |
| `CRAWLER_HEALTH_PORT` 被正确读取 | 新增 `test/run-health-port.test.js` |
| 多节点配置互不冲突 | 检查端口、nodeCode、sessionPrefix 唯一性 |
| 健康端点仍返回正确 JSON | 复用并扩展 `test/service-health.test.js` |

---

## 13. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 6 节点 × 2 channel 内存超过 8G | OOM | 降低 channel 数或节点数；加 swap；监控 `docker stats` |
| 上游任务 API 无去重 | 重复处理任务 | 假设上游已处理；后续引入分布式锁或任务过滤 |
| 磁盘写满 | 服务异常 | 定期清理图片/日志；监控磁盘使用率 |
| crawlab 节点配置未同步 | 新增/删除节点后监控缺失 | 运维文档明确 crawlab UI 手动更新步骤 |
| healthPort 未读取 | 健康服务不启动 | 本次修复 `bin/run.js` 和 `src/cli.js` 的 envMap |

---

## 14. 任务拆分建议

实现顺序：

1. 修复 `CRAWLER_HEALTH_PORT` 配置读取 + 测试。
2. 新增 `generate-compose.js` 脚本 + 测试。
3. 修改 `deployment/crawlab/docker-compose.yml` 为模板，默认由脚本生成。
4. 更新 `deploy.sh` / `update.sh` / `rollback.sh` 适配多节点。
5. 更新 `.env.example` 说明多节点配置。
6. 更新 `部署vps.md`，补充多节点、生成脚本、单节点运维章节。
7. 验证生成后的 compose 语法和配置唯一性。
