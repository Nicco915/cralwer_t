# 海外 VPS Docker 部署手册

## 常见问题与日常运维

### 1. 切换生产接口

`.env` 中当前配置：

- `CRAWLER_TASK_URL=http://117.72.52.0/renren-api/classify/open/crawler/tasks`
- `CRAWLER_CALLBACK_URL=http://117.72.52.0/renren-api/classify/open/crawler/callback`
- `CRAWLER_IMAGE_UPLOAD_URL=http://47.92.233.36:8003/renren-api/classify/open/image/upload`

其中 `117.72.52.0` 是测试环境；`47.92.233.36:8003` 是生产图片上传接口。切换到生产时，把 task 和 callback 地址替换为生产 IP 即可：

```bash
# 在 VPS 上编辑 .env
nano /opt/crawler/.env
```

修改后示例：

```bash
CRAWLER_TASK_URL=http://<生产IP>/renren-api/classify/open/crawler/tasks
CRAWLER_CALLBACK_URL=http://<生产IP>/renren-api/classify/open/crawler/callback
# 图片上传已经是生产地址，无需改动
CRAWLER_IMAGE_UPLOAD_URL=http://47.92.233.36:8003/renren-api/classify/open/image/upload
```

保存后重启生效：

```bash
cd /opt/crawler
export CRAWLER_IMAGE_BASE=ghcr.io/nicco915/cralwer_t
./deploy.sh v1.0.3
```

### 2. 爬取有效性检测

#### 2.1 本地单 SKU 测试

使用项目根目录的 `test-sku.js`，指定一个 SKU 测试完整爬取流程：

```bash
# 本地开发机
export CRAWLER_BASE_URL=https://eur.vevor.com
export CLIPROXY_USERNAME=your-username
export CLIPROXY_PASSWORD=your-password
export CLIPROXY_HOST=us.cliproxy.io
export CLIPROXY_PORT=3010
export CLIPROXY_REGION=EU

node test-sku.js GXSBSJSGWLGXVOLJBV0
```

如果只想验证代理 IP 是否生效，可以加上 `--mock-upload` 走本地 mock 上传服务器：

```bash
node test-sku.js GXSBSJSGWLGXVOLJBV0 --mock-upload
```

#### 2.2 虚拟上下游接口测试

启动本地 stub server，模拟上游任务分发和 callback：

```bash
# 一个终端启动 mock 上游
node src/mock-server.js

# 另一个终端运行爬虫服务
export CRAWLER_MODE=service
export CRAWLER_TASK_URL=http://127.0.0.1:3000/tasks
export CRAWLER_CALLBACK_URL=http://127.0.0.1:3000/callback
export CRAWLER_NODE_CODE=crawler-test
node bin/run.js
```

#### 2.3 检查 stealth 是否生效

在 VPS 容器中查看启动日志：

```bash
docker logs hs-sku-crawler-1 --tail 50 | grep -i stealth
```

正常应看到按节点+通道生成的 UA 指纹、locale 等信息。也可以通过健康检查接口确认浏览器已连接：

```bash
curl http://127.0.0.1:3001/health
```

返回中 `browserConnected: true` 表示浏览器上下文创建成功。

### 3. 新增和删除节点

#### 3.1 新增节点

编辑 `deployment/crawlab/docker-compose.yml`，复制一段 `crawler-N` service 并修改：

```yaml
  crawler-7:
    image: ${CRAWLER_IMAGE:?未设置 CRAWLER_IMAGE 环境变量}
    container_name: hs-sku-crawler-7
    restart: unless-stopped
    user: "1000:1000"
    env_file: .env
    environment:
      - CRAWLER_MODE=service
      - CRAWLER_NODE_CODE=crawler-07
      - CRAWLER_HEALTH_PORT=3007
      - CRAWLER_CLIPROXY_SESSION_PREFIX=crawler-07
      - CRAWLER_HEADED_FALLBACK=false
    ports:
      - "127.0.0.1:3007:3007"
    volumes:
      - ./logs:/app/logs
      - ./output/crawler-07:/app/output
      - ./images/crawler-07:/app/images
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
```

然后创建对应目录并部署：

```bash
cd /opt/crawler
mkdir -p output/crawler-07 images/crawler-07
chown -R crawler:crawler output/crawler-07 images/crawler-07
export CRAWLER_IMAGE_BASE=ghcr.io/nicco915/cralwer_t
./deploy.sh v1.0.3
```

#### 3.2 删除节点

```bash
cd /opt/crawler
# 停止并删除容器
docker compose rm -fs crawler-7
# 可选：删除数据目录
rm -rf output/crawler-07 images/crawler-07
```

> 删除节点前请到上游系统把对应的 `CRAWLER_NODE_CODE`（如 `crawler-07`）下线，避免任务分发到不存在的节点。

### 4. Docker 日常操作

#### 4.1 查看日志

```bash
# 单个容器实时日志
docker logs -f hs-sku-crawler-1

# 最近 100 行
docker logs hs-sku-crawler-1 --tail 100

# 所有 crawler 容器日志
docker compose logs -f --tail 50 crawler-1 crawler-2 crawler-3
```

> 容器名是 `hs-sku-crawler-1` 到 `hs-sku-crawler-6`，不是 `crawler-01`。

#### 4.2 查看状态

```bash
docker ps -a | grep crawler
docker stats hs-sku-crawler-1 hs-sku-crawler-2
```

#### 4.3 重启单个节点

```bash
docker compose restart crawler-1
```

#### 4.4 进入容器排查

```bash
docker exec -it hs-sku-crawler-1 /bin/bash
# 容器内查看环境变量
env | grep CRAWLER_
```

### 5. 修改 crawler-01 命名

节点名字有两处：

1. **业务节点代码**（上报给上游的 ID）：修改 `docker-compose.yml` 中对应 service 的 `CRAWLER_NODE_CODE`
2. **容器名**：修改 `container_name`

例如把 `crawler-01` 改成 `eu-node-01`：

```yaml
  crawler-1:
    container_name: hs-sku-eu-node-01
    environment:
      - CRAWLER_NODE_CODE=eu-node-01
      - CRAWLER_CLIPROXY_SESSION_PREFIX=eu-node-01
```

同时把挂载目录也改掉：

```yaml
    volumes:
      - ./logs:/app/logs
      - ./output/eu-node-01:/app/output
      - ./images/eu-node-01:/app/images
```

然后创建目录并部署：

```bash
cd /opt/crawler
mkdir -p output/eu-node-01 images/eu-node-01
chown -R crawler:crawler output/eu-node-01 images/eu-node-01
export CRAWLER_IMAGE_BASE=ghcr.io/nicco915/cralwer_t
./deploy.sh v1.0.3
```

> 修改命名后，上游系统里也要同步注册新的 `CRAWLER_NODE_CODE`。

### 6. 内存推荐

当前 6 个 crawler 节点，每个限制 800MB，共约 4.8GB；加上 crawlab、mongo、redis 等基础服务约 1-1.5GB。目前 8GB 内存已使用 2GB，属于轻负载。

推荐预留：

| 节点数 | 推荐内存 | 说明 |
|--------|---------|------|
| 6 节点 | 6-8 GB | 当前配置，有余量 |
| 12 节点 | 12-16 GB | 每个节点 800MB + 基础服务 |
| 单节点测试 | 2 GB | 只跑 1 个 crawler |

如果后续增加节点，按「节点数 × 1GB + 2GB 基础」估算。

### 7. 未来升级步骤

#### 7.1 自动升级（推荐）

1. 本地提交代码并 push 到 `main`
2. 打 tag 并推送：

```bash
git tag v1.0.4
git push github v1.0.4
```

3. GitHub Actions 会自动构建镜像并部署到 VPS

#### 7.2 手动升级

```bash
ssh root@<VPS_IP>
cd /opt/crawler
export CRAWLER_IMAGE_BASE=ghcr.io/nicco915/cralwer_t
./deploy.sh v1.0.4
```

如果 `deploy.sh` 报 `safe.directory`：

```bash
chown -R root:root /opt/crawler/repo
export CRAWLER_IMAGE_BASE=ghcr.io/nicco915/cralwer_t
./deploy.sh v1.0.4
chown -R crawler:crawler /opt/crawler/repo
```

#### 7.3 回滚

```bash
cd /opt/crawler
./rollback.sh
```

`rollback.sh` 会读取 `.last_image` 中记录的上一版镜像并重启容器。

#### 7.4 dataLayer 快速短路与换 IP：两个 commit 的 revert 预案

本批次上线的两笔提交（**未推送镜像**，仅在工作区提交）属于行为变更，必须保留 revert 路径：

| Commit | 简称 | 改动 | 风险等级 |
|---|---|---|---|
| `6f3e778` | fast-path 启用 | `extractProductUrlFromDataLayer` 改 fast-path + slow-path；channel 把 `DATA_LAYER_*` 翻成 not_found；service 借此换 IP | ⚠️ 高 |
| `a0d72ef` | 兜底补丁 | 保留 HTML fallback；失败补诊断；channel cooldown 内不 reinstall；默认 cooldown 30s | ⚠️ 中 |

##### 何时触发 revert（症状 + 操作）

| 线上症状 | 操作 |
|---|---|
| not_found 比例显著上升，特别是以前能 success 的 SKU 现在 not_found | `git revert a0d72ef && git revert 6f3e778`，重新 build 镜像 |
| `Channel has N consecutive dataLayer failures, rotating proxy` 日志每 10s 刷屏 | `git revert a0d72ef`，回退 cooldown 优化那一层（保留 fast-path） |
| proxy 消耗异常加速（cliproxy 后台配额告警） | `git revert a0d72ef`，再调大 `CRAWLER_CLIPROXY_ROTATION_COOLDOWN_MS` 到 60000 |
| 诊断目录里**只有** `dataLayer-never-pushed`/`dataLayer-missing`，没有 `dataLayer-timeout`，排查困难 | 暂时性：仍能 revert `a0d72ef` 恢复旧标签 |
| 怀疑 dataLayer 异常但 channel 没换 IP（IP 仍然坏） | `git revert a0d72ef`，回退 cooldown 闸门 |

##### 单 commit revert 操作

```bash
# 1. 确认 commit hash
git log --oneline | head -5

# 2. 在代码层 revert（生成一个新的 commit 撤销原 commit）
cd /opt/crawler
git revert 6f3e778     # 只回退 fast-path 启用层
# 或者
git revert a0d72ef    # 只回退兜底补丁层（保留 fast-path）
# 或者
git revert a0d72ef && git revert 6f3e778  # 全部回退到 7.3 之前的状态

# 3. 重新构建并推送镜像
./build.sh && ./deploy.sh

# 4. 重启容器（必要时）
docker restart hs-sku-crawler-1 hs-sku-crawler-2 hs-sku-crawler-3 hs-sku-crawler-4 \
                   hs-sku-crawler-5 hs-sku-crawler-6 hs-sku-crawler-7 hs-sku-crawler-8
```

##### 关键代码位置（便于事后排查）

| 关注点 | 文件:行 | 说明 |
|---|---|---|
| fast-path 抛错 | `src/page-crawler.js` ~line 130 | `DATA_LAYER_NEVER_PUSHED` 立即抛 |
| slow-path 抛错 | `src/page-crawler.js` ~line 180 | `DATA_LAYER_MISSING` 抛 |
| HTML fallback 兜底 | `src/page-crawler.js` ~line 230 | `extractProductUrlWithRetry` catch DATA_LAYER_* |
| channel 翻译 | `src/channel.js` ~line 280 | 把 DATA_LAYER_* 翻成 not_found + `maybeTriggerReinstall` |
| cooldown 闸门 | `src/channel.js` `maybeTriggerReinstall` | cooldown 期内不 reinstall |
| service 换 IP 触发 | `src/service.js` `checkChannelForRotation` | cooldown 解除后自动换 |

##### 推荐调整（部署镜像时同时改）

容器里 `CRAWLER_CLIPROXY_ROTATION_COOLDOWN_MS=120000` 是显示覆盖，**新默认值已经是 30s**。建议同步把容器环境变量改为 `30000`，避免冷启动后第一次仍走 120s 老逻辑：

```bash
# docker-compose.yml 或部署脚本里
CRAWLER_CLIPROXY_ROTATION_COOLDOWN_MS=30000
```

##### 排查时的快速诊断

```bash
# 1. 看最近一次换 IP 何时发生
docker logs hs-sku-crawler-5 2>&1 | grep 'rotating channel'

# 2. 看 dataLayer 异常频率（按 SKU 分组）
docker exec hs-sku-crawler-5 ls /app/logs/diagnostics/crawler-05/$(date -u +%Y-%m-%d)/ | grep -oE 'dataLayer-[a-z-]+' | sort | uniq -c

# 3. 看 cooldown 期内被跳过的 reinstall
docker logs hs-sku-crawler-5 2>&1 | grep 'cooldown active'

# 4. 看 not_found 是否含 DATA_LAYER_*
docker logs hs-sku-crawler-5 2>&1 | grep -E 'DATA_LAYER_(NEVER_PUSHED|MISSING)' | wc -l
```

##### 已知次要风险（未修，仅观察）

| # | 现象 | 影响 | 后续处理 |
|---|---|---|---|
| 3 | `profileStale=true` 触发的第二次 reinstall 会和 `maybeTriggerReinstall` 串联 | 多一次 context 创建，但 cooldown 仍生效 | 观察；如出现资源压力再加优化 |
| 4 | headless 失败后 headed fallback 也失败 → 双重 reinstall | 罕见场景（同 IP 双重问题） | 观察 |
| 6 | 业务无结果 SKU 也会递增 `dataLayerFailureCount`（预存 bug） | 多次无结果 SKU 累积可能触发换 IP | 不在本次范围，下次单独修 |
| 10 | `service.checkChannelForRotation` 路径绕过 channel cooldown（仍会 reinstall 旧 IP） | 30s 内可能 reinstall 旧 IP 浪费 | 建议下次改动：让 service 也读 `channel.lastIpRotationAt` |
| 11 | 双重 reinstall 用同一 IP（仅 profile 切换有意义） | 浪费但 session 切换有效 | 观察 |

### 8. 部署监控栈（Loki + Promtail + Grafana）

容器与 Windows PM2 节点通过 Loki + Promtail + Grafana 统一监控，详见 `docs/superpowers/specs/2026-07-06-loki-monitoring-design.md` 与 `docs/superpowers/plans/2026-07-06-loki-monitoring-plan.md`。

#### 8.1 VPS 端启动监控栈

```bash
cd /opt/crawler
docker compose -f deployment/monitoring/docker-compose.yml up -d
```

启动后包含的服务：

- `loki`：日志聚合，默认监听 `3100`，仅绑定 Tailscale 内网 IP
- `promtail`：抓取本机 crawler 容器日志，推送至 Loki
- `grafana`：可视化与告警，默认监听 `3000`，仅绑定 Tailscale 内网 IP

#### 8.2 Grafana 访问

仅内网（绑定 Tailscale IP）：`http://100.x.x.V:3000`，默认账号 `admin` / 密码取自 `.env` 中的 `GRAFANA_ADMIN_PASSWORD`。

如需在本地浏览器查看，通过 SSH 隧道转发：

```bash
ssh -L 3000:127.0.0.1:3000 root@<VPS_IP>
```

然后在浏览器打开 `http://localhost:3000`。

#### 8.3 Windows 节点安装（每台）

```powershell
.\deployment\windows\install-promtail.ps1 -LokiUrl "http://100.x.x.V:3100/loki/api/v1/push" -NodeCode "crawler-09"
.\deployment\windows\install-windows-exporter.ps1
```

`install-promtail.ps1` 会创建 NSSM 托管的 Promtail 服务，把 PM2 日志、Crawler stdout/stderr 推送到指定 Loki 地址；`install-windows-exporter.ps1` 安装 windows-exporter 暴露 Prometheus 指标。

#### 8.4 放行防火墙（可选）

如果希望通过公网直接访问 Grafana：

```bash
ufw allow 3000/tcp
# 或者在云厂商控制台放行 3000 端口
```

> 公网暴露 Grafana 有安全风险，建议只通过 SSH 隧道、Tailscale 或 VPN 访问。

#### 8.5 查看监控栈日志

```bash
docker compose -f deployment/monitoring/docker-compose.yml logs -f loki
docker compose -f deployment/monitoring/docker-compose.yml logs -f promtail
docker compose -f deployment/monitoring/docker-compose.yml logs -f grafana
```

---

本文档说明如何把 `hs-sku-crawler` 部署到海外 VPS（Virtual Private Server，虚拟专用服务器），并接入 Cliproxy 动态住宅代理，最终实现 eur.vevor.com 的稳定爬取。

适用场景：希望摆脱本地 PM2（Process Manager 2，Node.js 进程管理工具）部署，让爬虫跑在与目标站点同区域的 VPS 上，借助住宅 IP 规避 Cloudflare 风控。

---

## 一、为什么需要海外 VPS + 住宅代理

| 痛点 | 本地 PM2 部署 | 海外 VPS + 住宅代理 |
|------|---------------|---------------------|
| 出口 IP | 中国机房 IP，Cloudflare 直接拦截 | 欧洲住宅 IP，与真实用户一致 |
| 网络延迟 | 跨太平洋访问 eur.vevor.com 200ms+ | VPS 与目标站点同区域，延迟 20-50ms |
| 7×24 运行 | 依赖本地电脑开机 | VPS 全天候在线 |
| 多通道隔离 | 同一 IP 多线程被识别为异常 | 每通道独立住宅 IP |

推荐起步配置：Hetzner CPX31（4C8G，~€12/月），同区域的 Cliproxy 住宅代理。

---

## 二、架构总览

```
┌──────────────────┐
│  Hetzner VPS     │
│  (Ubuntu 22.04)  │
│                  │
│  ┌────────────┐  │     出口走 Cliproxy 通道
│  │   Docker   │  │     ┌─────────────────────┐
│  │            │  │     │  Cliproxy 网关       │
│  │ ┌────────┐ │──┼────►│  username-region-EU │
│  │ │crawler │ │  │     │  -sid-...-t-30      │
│  │ │ ch-1 ──┼─┼──┼────►│  → 住宅 IP #1       │
│  │ │ ch-2 ──┼─┼──┼────►│  → 住宅 IP #2       │
│  │ │ ch-N ──┼─┼──┼────►│  → 住宅 IP #N       │
│  │ └────────┘ │  │     └─────────────────────┘
│  └────────────┘  │              │
└──────────────────┘              ▼
                          ┌────────────────┐
                          │ eur.vevor.com  │
                          │ (Cloudflare)   │
                          └────────────────┘
```

每个爬虫通道（Channel）绑定一个独立的 Cliproxy 粘性会话（Sticky Session），对外表现是多用户、多地域的真实访问。

---

## 三、服务器初始化（首次部署）

### 3.1 开 Hetzner VPS

- 机型：CPX31（4 vCPU / 8 GB RAM / 160 GB SSD）
- 系统：Ubuntu 22.04 LTS
- 区域：FSN1（德国）或 NBG1（德国纽伦堡），与 Cliproxy EU 节点匹配
- 防火墙：仅放行 22（SSH）

### 3.2 安装 Docker 与创建部署用户

```bash
# SSH 登录
ssh root@<VPS_IP>

# 安装 Docker（Docker Compose v2 插件形式）
apt update && apt upgrade -y
curl -fsSL https://get.docker.com | sh
apt install -y docker-compose-plugin

# 创建专用部署用户（避免 root 运行容器）
useradd -m -s /bin/bash crawler
usermod -aG docker crawler

# 创建部署目录
mkdir -p /opt/crawler/{logs,output,images}
chown -R crawler:crawler /opt/crawler

# 切换到 crawler 用户
su - crawler
cd /opt/crawler
```

### 3.3 上传部署文件

把 `deployment/linux/` 整个目录传到服务器 `/opt/crawler/`：

```bash
# 本地执行（PowerShell 或 bash）
scp -r deployment/linux/* crawler@<VPS_IP>:/opt/crawler/
```

目录结构：

```
/opt/crawler/
├── docker-compose.yml
├── deploy.sh        # 首次部署
├── update.sh        # 升级镜像
├── rollback.sh      # 回滚到上一版本
└── .env.example     # 复制为 .env 后填写
```

---

## 四、Cliproxy 代理申请

### 4.1 注册与开通

1. 进入 Cliproxy 控制台（供应商提供的入口）
2. 申请「住宅代理」套餐，确认 EU 区域已开通
3. 在控制台获取以下信息：
   - `CLIPROXY_HOST`：例如 `eu.cliproxy.io`
   - `CLIPROXY_PORT`：默认 `1080`
   - `CLIPROXY_USERNAME`：账户用户名
   - `CLIPROXY_PASSWORD`：账户密码
   - 可用区域列表：通常包含 EU、US、ASIA

### 4.2 粘性会话原理

Cliproxy 用户名模板（本项目自动拼接）：

```
{username}-region-{REGION}-sid-{SESSION_PREFIX}-{CHANNEL_ID}-{NONCE}-t-{STICKY_MINUTES}
```

实际生成的例子：

```
myuser-region-EU-sid-crawler-01-ch1-a3f9c2d8-t-30
                ↓         ↓          ↓        ↓           ↓
              区域     会话前缀   通道编号  随机nonce   粘性30分钟
```

- `region`：出口 IP 所在区域（EU）
- `sid`：会话 ID，决定 IP 粘性
- `ch1`、`ch2`：每个通道独立 SID，独立 IP
- `nonce`：8 位十六进制随机数
- `t-30`：粘性 30 分钟（同一 IP 持续 30 分钟）

只要用这个用户名 + 密码访问 Cliproxy 网关，出口 IP 就是欧洲住宅 IP，且 30 分钟内不切换。

---

## 五、配置 .env

```bash
cd /opt/crawler
cp .env.example .env
nano .env
```

关键配置项说明：

```bash
# Docker 镜像（必须设置）
CRAWLER_IMAGE_BASE=ghcr.io/your-org/hs-sku-crawler

# 上游派单 API
CRAWLER_NODE_CODE=crawler-01
CRAWLER_NODE_TOKEN=从上游控制台获取
CRAWLER_TASK_URL=http://<上游API>/tasks
CRAWLER_CALLBACK_URL=http://<上游API>/callback

# 服务配置
CRAWLER_MODE=service
CRAWLER_CHANNELS=2                    # 通道数，每通道独立 IP
CRAWLER_POLL_INTERVAL=5000
CRAWLER_POLL_LIMIT=5

# VEVOR 站点
CRAWLER_BASE_URL=https://eur.vevor.com
CRAWLER_HEADLESS=true
CRAWLER_HEADED_FALLBACK=false         # VPS 无 X server，必须关闭
CRAWLER_MAX_IMAGES=3
CRAWLER_CLOUDFLARE_MAX_WAIT=45

# Cliproxy 住宅代理
CLIPROXY_HOST=eu.cliproxy.io
CLIPROXY_PORT=1080
CLIPROXY_USERNAME=your-cliproxy-username
CLIPROXY_PASSWORD=your-cliproxy-password
CLIPROXY_REGION=EU
CLIPROXY_STICKY_MINUTES=30
CLIPROXY_SESSION_PREFIX=crawler-01
```

### 5.1 互斥校验

`startProxyPool()` 启动时检查：

- 不能同时配置 Kuaidaili 和 Cliproxy（互斥）
- 不配置任何代理池则使用静态代理或直连

误配会立即报错，避免静默走错路径。

---

## 六、首次部署

### 部署用户

所有部署/更新操作请使用 `crawler` 用户执行，避免 git `safe.directory` 权限检查报错：

```bash
su - crawler -c "cd /opt/crawler && ./deploy.sh v1.0.0"
```

### 6.1 启动容器

```bash
su - crawler -c "cd /opt/crawler && ./deploy.sh <镜像tag>"
```

例如：

```bash
su - crawler -c "cd /opt/crawler && ./deploy.sh v1.0.0"
```

脚本执行流程：

1. 检查 `CRAWLER_IMAGE_BASE` 已设置
2. 拼接完整镜像名：`${CRAWLER_IMAGE_BASE}:<tag>`
3. 校验 `.env` 文件存在
4. 创建 `logs/`、`output/`、`images/` 目录
5. `docker compose pull` 拉取镜像
6. `docker compose up -d` 后台启动
7. 输出 `docker compose ps` 状态

### 6.2 验证代理 IP

进入容器，检查出口 IP 是否为欧洲住宅 IP：

```bash
docker compose exec crawler sh
curl -s https://ipinfo.io/json
```

期望返回（示例）：

```json
{
  "ip": "203.0.113.45",
  "city": "Frankfurt",
  "country": "DE",
  "org": "AS12345 Some Residential ISP"
}
```

看到 `country: DE`（或 EU 国家）且 `org` 是住宅 ISP（Residential Internet Service Provider，家用宽带运营商），说明 Cliproxy 已生效。

### 6.3 多通道独立 IP 验证

每个通道一个独立 SID，对应不同住宅 IP：

```bash
# 在容器内查看所有通道的代理 URL
docker compose exec crawler node -e "
const { CliproxyPool } = require('/app/src/cliproxy-pool');
const pool = new CliproxyPool({
  host: process.env.CLIPROXY_HOST,
  port: Number(process.env.CLIPROXY_PORT),
  username: process.env.CLIPROXY_USERNAME,
  password: process.env.CLIPROXY_PASSWORD,
  region: process.env.CLIPROXY_REGION,
  stickyMinutes: Number(process.env.CLIPROXY_STICKY_MINUTES),
  sessionPrefix: process.env.CLIPROXY_SESSION_PREFIX,
  channels: Number(process.env.CRAWLER_CHANNELS),
  assignmentsFile: '/app/cliproxy-assignments.json',
});
pool.assign().then(map => console.log(JSON.stringify(map, null, 2)));
"
```

期望看到每个 `ch-N` 对应的 URL 中 `sid` 不同。

---

## 七、镜像升级与回滚

### 7.1 升级到新版本

```bash
su - crawler -c "cd /opt/crawler && ./update.sh <新tag>"
```

脚本行为：

1. 记录当前镜像到 `.last_image`
2. `docker compose pull` 拉取新镜像
3. `docker compose up -d --no-deps crawler` 仅重启 crawler 服务

升级后 Cliproxy 会话保持不变（`cliproxy-assignments.json` 持久化），IP 续期。

### 7.2 回滚到上一版本

```bash
su - crawler -c "cd /opt/crawler && ./rollback.sh"
```

读取 `.last_image` 中的镜像 tag，重新 `docker compose up -d`。

### 7.3 紧急情况：手工停止 / 启动

```bash
docker compose stop crawler
docker compose start crawler
docker compose logs -f crawler
```

---

## 八、运维与监控

### 8.1 日志位置

- 容器内：`/app/logs/callbacks/`
- 主机：`./logs/`（volume 挂载）
- 单文件最大 50 MB，最多保留 5 个文件（Docker logging driver 配置）

### 8.2 健康检查

服务内置 30 秒间隔的浏览器健康检查（`browserHealthCheckInterval`）：

- 浏览器断开 → 自动重启
- 通道连续 2 次代理失败 → 触发 Cliproxy 轮换（新 nonce = 新 IP）
- 轮换冷却期默认 5 分钟

### 8.3 常见问题

#### Q1：Cloudflare 一直弹验证

- 检查出口 IP 是否在 EU 区域（`curl ipinfo.io`）
- 检查 `CRAWLER_HEADLESS=true` 且 `CRAWLER_HEADED_FALLBACK=false`
- 检查 Cliproxy 账户余额

#### Q2：容器启动后立即退出

查看日志：

```bash
docker compose logs --tail=100 crawler
```

常见原因：

- `.env` 缺少 `CRAWLER_IMAGE_BASE` 或 `CRAWLER_NODE_TOKEN`
- Cliproxy 用户名 / 密码错误
- 同时配置了 Kuaidaili 和 Cliproxy

#### Q3：升级后 IP 变了

正常情况：

- `cliproxy-assignments.json` 在 volume 内，升级不丢失
- 只有主动调用 `nextForChannel()` 才会生成新 nonce
- 如果 IP 仍变化，检查是否触发了健康检查轮换

#### Q4：回滚失败提示「未找到 .last_image」

首次部署或从未升级过，没有 `.last_image` 文件。回滚需要至少一次升级历史。

#### Q5：部署脚本提示「未设置 CRAWLER_IMAGE_BASE」

请检查 `.env` 文件是否已配置 `CRAWLER_IMAGE_BASE`，并确认以 `crawler` 用户执行脚本。脚本会自动读取 `.env`，无需手动 `export`。

---

## 九、安全与成本

### 9.1 安全清单

- [x] SSH 密钥登录，禁用密码登录
- [x] 防火墙仅放行 22 端口（容器对外无需开放端口）
- [x] `.env` 文件权限 600（`chmod 600 .env`）
- [x] 容器以非 root 用户（`USER crawler`）运行
- [x] 日志按日分包，自动清理 50 MB × 5 文件

### 9.2 成本估算

| 项目 | 月成本 |
|------|--------|
| Hetzner CPX31 | ~€12 |
| Cliproxy 住宅代理（按流量） | €5-30（取决于爬取量） |
| 总计 | €17-42 / 月 |

建议先小流量（1-2 通道）验证效果，再决定是否扩到 N 通道。

---

## 十、检查清单（首次部署逐项确认）

- [ ] VPS 系统为 Ubuntu 22.04，Docker 已安装
- [ ] 创建了 `crawler` 用户并加入 `docker` 组
- [ ] `/opt/crawler/` 目录及子目录属主为 `crawler:crawler`
- [ ] `deployment/linux/` 全部文件已上传
- [ ] `.env` 已配置：镜像地址、Node Token、Cliproxy 凭据、VEVOR 站点
- [ ] Cliproxy 账户已开通 EU 区域，余额充足
- [ ] `chmod 600 .env` 保护敏感信息
- [ ] `docker compose pull` 成功
- [ ] `docker compose up -d` 容器处于 healthy / running
- [ ] `curl ipinfo.io` 返回 EU 住宅 IP
- [ ] 日志目录可写入（`./logs/callbacks/`）

全部勾选后，爬虫开始从上游 API 拉取任务并自动调度。

---

## 十一、crawlab 同机部署（可选）

如果需要可视化监控节点，可将 crawlab 与爬虫部署在同一台 VPS。

### 11.1 使用 crawlab 版 Docker Compose

```bash
su - crawler -c "cd /opt/crawler/repo/deployment/crawlab && ./deploy.sh v1.0.0"
```

此 compose 默认启动 6 个 crawler 节点，节点数可通过 `generate-compose.js --nodes=N` 调整。实际启动的服务包括：
- `crawlab`：管理界面，访问 `http://<VPS_IP>:8080`
- `mongo`：crawlab 元数据
- `redis`：crawlab 任务队列
- `crawler-1` ~ `crawler-N`：hs-sku-crawler 多节点，分别暴露健康端点

每个 crawler 节点拥有独立的配置：
- `CRAWLER_NODE_CODE`：`crawler-01` ~ `crawler-0N`
- `CRAWLER_HEALTH_PORT`：`3001` ~ `3000+N`
- `CRAWLER_CLIPROXY_SESSION_PREFIX`：与 `nodeCode` 相同，避免 IP 冲突
- 独立的 volume 子目录：`output/crawler-0N/` 和 `images/crawler-0N/`

### 11.2 在 crawlab 中添加节点

1. 打开 `http://<VPS_IP>:8080`
2. 进入「节点」→「添加节点」
3. 每个 crawler 节点单独添加，节点地址按以下规则：
   - `crawler-1` → `http://crawler-1:3001/health`
   - `crawler-2` → `http://crawler-2:3002/health`
   - ...
   - `crawler-8` → `http://crawler-8:3008/health`
4. 轮询间隔 30 秒

### 11.3 GitHub Actions 自动发布

配置 GitHub Secrets：
- `VPS_HOST`：VPS 公网 IP
- `VPS_USER`：部署用户名（如 `crawler`）
- `VPS_SSH_KEY`：SSH 私钥

发布新版本：

```bash
git tag v1.2.3
git push origin v1.2.3
```

GitHub Actions 会自动构建镜像、推送到 GHCR、SSH 到 VPS 执行 `update.sh`。

### 11.4 安全建议

- crawlab 的 8080 端口建议通过 Nginx + Basic Auth 保护，或仅通过 SSH 隧道访问
- 健康端口 3000 仅监听 `127.0.0.1`，不暴露公网

---

## 附录：完整文件清单

部署目录 `/opt/crawler/` 应包含：

```
docker-compose.yml      # 服务编排
deploy.sh               # 首次部署（拉取+启动）
update.sh               # 升级（保留会话）
rollback.sh             # 回滚（基于 .last_image）
.env                    # 运行时配置（不提交到 git）
.env.example            # 配置模板
logs/                   # 回调日志（volume）
output/                 # 任务输出（volume）
images/                 # 下载图片（volume）
cliproxy-assignments.json  # Cliproxy 会话持久化（自动生成）
.last_image             # 上一镜像 tag（自动生成）
```

部署代码与脚本在 `deployment/linux/`，配置示例在 `.env.example`，Dockerfile 在 `deployment/docker/Dockerfile`。

---

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
- `CRAWLER_NODE_CODE`: `crawler-01` ~ `crawler-0N`
- `CRAWLER_HEALTH_PORT`: `3001` ~ `3000+N`
- `CRAWLER_CLIPROXY_SESSION_PREFIX`: 与 `nodeCode` 相同，避免 IP 冲突

### 12.2 首次部署

```bash
su - crawler -c "cd /opt/crawler/repo/deployment/crawlab && ./deploy.sh v1.0.0"
```

`deploy.sh` 会自动创建每个节点的 `output/crawler-0N` 和 `images/crawler-0N` 子目录。

### 12.3 在 crawlab 中添加节点

进入 crawlab Web UI → 节点 → 添加节点：

| 节点名称 | 节点地址 |
|----------|----------|
| crawler-01 | http://crawler-1:3001/health |
| crawler-02 | http://crawler-2:3002/health |
| ... | ... |
| crawler-06 | http://crawler-6:3006/health |

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