# 爬虫生产化：海外 VPS + 住宅代理方案设计

## 1. 背景与目标

### 1.1 当前状态

- 爬虫基于 Node.js + Playwright，目标站点为 `https://eur.vevor.com`
- 服务模式通过国内上游 API（`117.72.52.0`）拉取任务并回调结果
- 当前运行在本地 Windows 机器，使用 PM2 管理
- 代码已具备多节点扩展能力（`CRAWLER_NODE_CODE`、`PROXY_MACHINE_INDEX/TOTAL`）
- 已集成 Kuaidaili 代理池（`src/proxy-pool.js`、`src/kuaidaili-client.js`），但当前未启用

### 1.2 目标优先级

按用户确认的重要性排序：

1. **降低访问欧洲站点的延迟**（D）
2. **避免被 VEVOR / Cloudflare 拦截**（A）
3. **提升 7×24 稳定运行能力**（B）
4. 并发扩展不是当前重点

### 1.3 预期规模

- 中等规模：每天几千到约一万 SKU
- 单节点起步，验证有效后再扩展为双节点

---

## 2. 方案选择

### 2.1 选定方案：方案一（单节点欧洲 VPS + Cliproxy 粘性代理）

作为生产化起步，先使用单台欧洲 VPS 验证海外部署 + 住宅代理效果，后续再扩展为双节点高可用架构。

### 2.2 未选方案说明

- **方案二（双节点）**：成本翻倍，作为方案一的下一步演进
- **方案三（混合云）**：维护复杂，不适合作为起步

---

## 3. 关键设计决策

| 决策项 | 选择 | 理由 |
|--------|------|------|
| VPS 商家 | Hetzner CPX31 | 欧洲网络好、性价比极高、按小时计费 |
| VPS 区域 | 德国 / 芬兰 | 靠近 `eur.vevor.com`，降低延迟 |
| 部署方式 | Docker + Docker Compose | 与现有 `feature/docker-deployment` 方向一致，便于回滚 |
| 代理供应商 | Cliproxy | 用户已测试，支持粘性会话 |
| 粘性时长 | 30 分钟 | 平衡会话稳定性和 IP 切换灵活性 |
| headed fallback | 在 Docker 中禁用 | 降低容器复杂度；如拦截率高再评估 Xvfb |
| 基线分支 | `main` | `feature/docker-deployment` 落后于 `main`，实现前需先合并基线 |

---

## 4. 总体架构

```text
┌─────────────────────────────────────────────────────────┐
│  上游任务 API (国内 117.72.52.0)                          │
│  ├─ POST /tasks      下发任务                              │
│  └─ POST /callback   接收结果                              │
└─────────────────────────────────────────────────────────┘
                            ▲
                            │ HTTPS / HTTP
                            ▼
┌─────────────────────────────────────────────────────────┐
│  欧洲 VPS (Hetzner CPX31, Ubuntu 22.04)                   │
│  ┌───────────────────────────────────────────────────┐  │
│  │  Docker Compose                                    │  │
│  │  ┌─────────────────────────────────────────────┐  │  │
│  │  │  crawler 容器                                │  │  │
│  │  │  ├─ Node.js + Playwright Chromium           │  │  │
│  │  │  ├─ 2-4 channel                             │  │  │
│  │  │  ├─ Poller → Worker → Channel → Pusher      │  │  │
│  │  │  └─ 每个 channel 经 Cliproxy 访问 eur.vevor.com│  │  │
│  │  └─────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
                            │
                            ▼
              https://eur.vevor.com
              （欧洲出口 IP，降低延迟、更像真实用户）
```

---

## 5. VPS 与 Docker 运行环境

### 5.1 服务器选型

| 项目 | 推荐值 |
|------|--------|
| 商家 | Hetzner |
| 机型 | CPX31 |
| 区域 | 德国 Falkenstein 或芬兰 Helsinki |
| 配置 | 4 vCPU / 8 GB RAM / 160 GB NVMe |
| 系统 | Ubuntu 22.04 LTS |
| 月费 | 约 €12 |
| 防火墙 | 仅开放 22 (SSH)，其余关闭 |

### 5.2 服务器初始化

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-plugin
sudo usermod -aG docker $USER
```

### 5.3 VPS 目录结构

```
/opt/hs-sku-crawler/
├── .env                  # 环境变量（手动放置，不进入镜像）
├── docker-compose.yml    # 容器编排
├── logs/                 # 持久化日志
├── output/               # 结果、检查点
└── images/               # 下载图片
```

### 5.4 docker-compose.yml（Linux 版）

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
      - CRAWLER_NODE_CODE=${CRAWLER_NODE_CODE:-crawler-01}
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

### 5.5 Dockerfile 调整

复用 `feature/docker-deployment` 的 Dockerfile，建议：

1. `CMD` 由 `.env` 控制 mode，不硬编码 `--mode=service`
2. 增加非 root 用户运行容器进程
3. 确认 `npx playwright install chromium` 在 Debian slim 下正常下载

---

## 6. Cliproxy 粘性代理集成

### 6.1 用户名格式

```
{username}-region-{EU|DE|FR|...}-sid-{sessionId}-t-{minutes}
```

示例：

```
myaccount-region-EU-sid-crawler-01-ch1-abc123-t-30
```

- `sid` 不变时，出口 IP 保持不变（在 `t` 分钟内）
- 更换 `sid` 即可获得新 IP
- 密码仅用于认证，不影响 IP 选择

### 6.2 环境变量

```bash
CLIPROXY_HOST=eu.cliproxy.io          # 以 Cliproxy 控制台显示的实际 host 为准
CLIPROXY_PORT=1080                    # 以 Cliproxy 控制台显示的实际 port 为准
CLIPROXY_USERNAME=myaccount
CLIPROXY_PASSWORD=mypassword
CLIPROXY_REGION=EU
CLIPROXY_STICKY_MINUTES=30
CLIPROXY_SESSION_PREFIX=crawler-01
```

### 6.3 代码集成

新增 `src/cliproxy-pool.js`，适配现有 `Service` 代理切换流程：

```text
Service.start()
  └─ 如果配置了 CLIPROXY_USERNAME
       └─ 创建 CliproxyPool
       └─ 为每个 channel 生成带 sid 的代理 URL
       └─ channel.init(browser, proxyUrl)

Service.runHealthCheck()
  └─ 发现 channel 连续代理失败
       └─ CliproxyPool.nextForChannel(channelId)  // 更换 sid
       └─ channel.reinit(browser, newProxyUrl)
```

### 6.4 代理 URL 生成示例

```js
function buildCliproxyUrl(channelId, nonce) {
  const sid = `${CLIPROXY_SESSION_PREFIX}-${channelId}-${nonce}`;
  const user = `${username}-region-${region}-sid-${sid}-t-${stickyMinutes}`;
  return `http://${user}:${password}@${host}:${port}`;
}
```

### 6.5 换 IP 策略

| 失败类型 | 是否换 IP | 说明 |
|---------|----------|------|
| 代理连接错误（`ERR_TUNNEL_CONNECTION_FAILED` 等） | 立即换 | 代理通道本身不可用 |
| 连续任务超时 | 累计 3 次后换 | 单次超时可能是网站慢或瞬时网络问题 |
| Cloudflare 挑战超过最大等待时间 | 累计 2 次后换 | 可能是该 IP 被标记 |
| HTTP 4xx/5xx（非代理相关） | 不换 IP | 按现有 retry 逻辑处理 |
| 任务成功 | 重置失败计数器 | 避免偶发失败导致误切换 |

**最小换 IP 间隔**：5 分钟，防止频繁切换浪费会话。

---

## 7. 任务与数据流

### 7.1 单次任务生命周期

```text
1. Poller 每 5 秒调用上游 /tasks
        ↓
2. Worker 拿到任务队列，分配给空闲 channel
        ↓
3. Channel 使用当前 sticky 代理访问 eur.vevor.com
        ↓
4. PageCrawler 完成 SKU 搜索 → 商品页 → 提取字段 → 下载图片
        ↓
5. 结果推回上游 /callback
        ↓
6. 如果任务失败，按 6.5 策略决定是否换 IP
```

### 7.2 并发模型

- **Poller**：单线程轮询，受 `CRAWLER_POLL_LIMIT` 限制
- **Worker**：单线程调度，把任务派给空闲 channel
- **Channel**：每个 channel 一个独立的 Playwright browser context，各用各的代理
- **Pusher**：异步推送结果，失败自动重试 3 次

### 7.3 需要补充的配置

1. **上游 API timeout 可配置**：VPS 到国内 API 延迟可能比本地高，建议 `Poller` / `Pusher` timeout 默认 30s，可配置到 60s
2. **任务队列上限可配置**：增加 `CRAWLER_MAX_QUEUE_SIZE`，避免上游一次性下发过多任务

---

## 8. 错误处理与降级策略

### 8.1 现有容错能力

main 分支已具备：

- `gotoWithRetry`：导航失败最多重试 3 次
- `Channel.runHeadedFallback`：headless 超时后有头浏览器兜底
- `Service.runHealthCheck`：每 30 秒检查并自动重启/换代理
- `Worker`：任务失败也尝试推送 error 状态
- `Pusher`：回调失败自动重试 3 次

### 8.2 Docker 化后的调整

#### headed fallback

方案一选择 **禁用 headed fallback**：

```bash
CRAWLER_HEADED_FALLBACK=false
```

原因：

- 降低容器复杂度
- 减少资源占用
- 如欧洲住宅 IP 效果好，Cloudflare 通过率应较高

如上线后拦截率高，后续再评估容器内使用 Xvfb 跑有头浏览器。

#### 国内上游 API 访问异常

- `Poller` / `Pusher` 增加可配置 `FETCH_TIMEOUT`
- Pusher 重试间隔适当增加（1s / 5s / 15s）
- 连续拉取任务失败时服务不崩溃，继续下一轮轮询

#### 代理会话过期

- 每 25 分钟主动为每个 channel 刷新一次 sid
- 刷新尽量在 channel 空闲时进行
- 任务进行中过期则由下一次任务触发重试或换 IP

### 8.3 容器重启策略

```yaml
restart: unless-stopped
```

- 容器异常退出时自动重启
- 手动停止不会自动重启

---

## 9. 部署与更新流程

### 9.1 镜像仓库

推荐：Docker Hub 私有仓库 或 GitHub Container Registry (ghcr.io)。

> 下文中的镜像地址 `ghcr.io/org/hs-sku-crawler` 仅为示例，`org` 需替换为实际组织名或用户名。

### 9.2 CI/CD（GitHub Actions 示例）

```yaml
name: Build and Push Docker Image
on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Build image
        run: docker build -t ghcr.io/org/hs-sku-crawler:${{ github.sha }} -f deployment/docker/Dockerfile .
      - name: Push image
        run: docker push ghcr.io/org/hs-sku-crawler:${{ github.sha }}
```

### 9.3 VPS 部署脚本（Linux Bash）

新增 `deployment/linux/` 目录：

```
deployment/linux/
├── deploy.sh
├── update.sh
├── rollback.sh
├── .env.example
└── docker-compose.yml
```

#### deploy.sh

```bash
#!/bin/bash
set -e
IMAGE_TAG=${1:?请提供镜像 tag}
export CRAWLER_IMAGE="ghcr.io/org/hs-sku-crawler:${IMAGE_TAG}"

docker compose pull
docker compose up -d
docker compose logs -f crawler
```

#### update.sh

```bash
#!/bin/bash
set -e
IMAGE_TAG=${1:?请提供镜像 tag}

# 记录当前版本用于回滚
docker inspect --format='{{.Config.Image}}' hs-sku-crawler > .last_image 2>/dev/null || true

export CRAWLER_IMAGE="ghcr.io/org/hs-sku-crawler:${IMAGE_TAG}"
docker compose pull
docker compose up -d --no-deps crawler
```

#### rollback.sh

```bash
#!/bin/bash
set -e
LAST_IMAGE=$(cat .last_image 2>/dev/null || true)
if [ -z "$LAST_IMAGE" ]; then
  echo "未找到上一版本镜像" && exit 1
fi
export CRAWLER_IMAGE="$LAST_IMAGE"
docker compose up -d --no-deps crawler
```

### 9.4 Windows 脚本保留

`feature/docker-deployment` 中的 PowerShell 脚本保留，用于 Windows 部署场景。

---

## 10. 监控与日志

### 10.1 现有日志

- `logs/pusher.log`：回调请求记录
- `logs/callbacks/YYYY-MM-DD/*.json`：回调完整 body
- `output/checkpoint.json`：断点续传状态

### 10.2 Docker 化后补充

- 关键事件同时输出到 stdout，方便 `docker logs` 查看
- 保留 `./logs` 挂载，便于备份和排查
- 配置日志轮转：`max-size=50m`, `max-file=5`

### 10.3 关键指标监控

通过简单脚本或 cron 检查：

| 指标 | 检查方式 | 告警阈值 |
|------|---------|---------|
| 容器是否运行 | `docker ps` | 容器不存在 |
| 最近是否有成功任务 | 解析 `logs/pusher.log` | 连续 10 分钟无成功 |
| 最近失败率 | 统计成功/失败数 | 失败率 > 50% |
| 磁盘空间 | `df -h` | 使用率 > 80% |
| 代理剩余流量 | Cliproxy 控制台 | 按套餐 |

### 10.4 告警方式

起步阶段使用脚本 + 企业微信 / 飞书 / Telegram bot，不引入 Prometheus/Grafana。

---

## 11. 安全与成本

### 11.1 安全

#### 凭据管理

| 凭据 | 存放位置 |
|------|---------|
| `CRAWLER_NODE_TOKEN` | VPS `.env` |
| `CLIPROXY_USERNAME/PASSWORD` | VPS `.env` |
| `DASHSCOPE_API_KEY` | VPS `.env` |
| Docker registry 凭据 | VPS `~/.docker/config.json` |

所有凭据不进入 git，不进入 Docker 镜像。

#### 容器安全

Dockerfile 增加非 root 用户：

```dockerfile
RUN groupadd -r crawler && useradd -r -g crawler -d /app crawler
RUN chown -R crawler:crawler /app
USER crawler
```

#### VPS 安全

- 仅开放 SSH（22），建议 key-only 登录
- 不暴露 crawler 端口到公网
- 启用防火墙
- 定期系统更新

### 11.2 成本估算

| 项目 | 月费估算 |
|------|---------|
| Hetzner CPX31 | ~€12 |
| Cliproxy 住宅代理流量 | $50-200 |
| Docker registry（私有） | $0-5 |
| 备份存储 | ~€1 |
| **合计** | **约 ¥500-1500/月** |

Cliproxy 流量建议先用小流量测试一周，再决定套餐。

### 11.3 合规

- 遵守 Cliproxy 使用条款
- 爬虫频率控制在正常用户行为范围（当前 5-10 秒延迟合理）
- 不爬取 robots.txt 明确禁止的内容

---

## 12. 验证与测试策略

### 12.1 上线前验证

| 阶段 | 验证内容 | 通过标准 |
|------|---------|---------|
| 本地 Docker 构建 | `docker build` 成功 | 镜像能构建，无依赖错误 |
| 代理连通性 | 容器内通过 Cliproxy 访问 ipinfo.io | 返回欧洲住宅 IP |
| 模拟上游测试 | `npm run test:deployment:local` | 多节点任务分发和去重正常 |
| 真实上游 smoke test | 连接国内上游 API 和 Cliproxy，跑 10-30 分钟 | 成功率 ≥ 当前本地水平 |
| 24 小时稳定性测试 | 单节点持续运行 1 天 | 无内存泄漏、无异常退出 |

### 12.2 需要新增的测试

1. **CliproxyPool 单元测试**
   - 代理 URL 格式正确
   - session ID 变化后 URL 变化
   - 粘性时长参数正确

2. **Linux 部署脚本测试**
   - 参数校验
   - `.env` 必填项检查

3. **Docker 镜像非 root 用户测试**
   - 验证容器内进程不是 root

### 12.3 上线切换步骤

1. VPS 部署并跑 smoke test（不接入正式任务流）
2. 上游 API 同时给本地和 VPS 分发少量任务，对比成功率
3. 如果 VPS 成功率稳定 1-2 天，把任务权重切到 VPS
4. 本地机器保留配置，作为应急备份

---

## 13. 实现顺序与基线合并

### 13.1 关键风险

`feature/docker-deployment` 分支在 Docker 文件之外的内容**显著落后于 `main`**，缺少以下重要更新：

- poller/worker 反压与任务去重
- channel context 重建与 page 刷新
- page-crawler goto 错误分类与重试
- channel headed fallback 兜底
- poller BigInt ID 处理
- pusher 回调 body 日志
- Dashboard 服务

### 13.2 实现顺序

1. **从 `main` 切出新 worktree**
2. **将 `feature/docker-deployment` 的 Docker 相关文件 cherry-pick 到新 worktree**
3. **新增 Linux 部署脚本和 Cliproxy 支持**
4. **编写测试并验证**
5. **合并回 `main`**

不能直接在 `feature/docker-deployment` 上继续开发，否则会覆盖 main 的多项核心修复。

---

## 14. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| `feature/docker-deployment` 落后 main | 丢失核心修复 | 从 main 切出新分支，cherry-pick Docker 文件 |
| Cliproxy 欧洲出口 IP 效果不佳 | 仍被拦截 | 调整区域参数、缩短粘性时长、增加换 IP 频率 |
| 欧洲 VPS 访问国内上游 API 不稳定 | 任务拉取/回调失败 | 增加 timeout、放宽重试间隔、保留本地备份 |
| 住宅代理流量超支 | 成本上升 | 先用小流量测试，监控流量使用 |
| 容器内 Playwright 内存泄漏 | 服务崩溃 | 健康检查自动重启、24 小时稳定性测试 |
| headed fallback 禁用后拦截率上升 | 成功率下降 | 评估后决定是否增加 Xvfb 有头浏览器兜底 |

---

## 15. 待实现清单

- [ ] 从 `main` 创建新 worktree
- [ ] 将 `feature/docker-deployment` 的 `deployment/docker/` 迁移到新 worktree
- [ ] 新增 `deployment/linux/` Bash 部署脚本
- [ ] 修改 Dockerfile，使用非 root 用户
- [ ] 实现 `src/cliproxy-pool.js`
- [ ] 在 `src/service.js` 中集成 CliproxyPool
- [ ] 新增 `.env.example` 中的 Cliproxy 配置项
- [ ] 增加 CliproxyPool 单元测试
- [ ] 增加 Linux 部署脚本测试
- [ ] 更新 README，补充海外 VPS 部署说明
- [ ] 运行 smoke test 验证
