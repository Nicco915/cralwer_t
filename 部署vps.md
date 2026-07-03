# 海外 VPS Docker 部署手册

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

### 6.1 启动容器

```bash
cd /opt/crawler
./deploy.sh <镜像tag>
```

例如：

```bash
./deploy.sh v1.0.0
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
./update.sh <新tag>
```

脚本行为：

1. 记录当前镜像到 `.last_image`
2. `docker compose pull` 拉取新镜像
3. `docker compose up -d --no-deps crawler` 仅重启 crawler 服务

升级后 Cliproxy 会话保持不变（`cliproxy-assignments.json` 持久化），IP 续期。

### 7.2 回滚到上一版本

```bash
./rollback.sh
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

脚本要求显式设置环境变量，避免误用默认镜像。执行前先 `export CRAWLER_IMAGE_BASE=...`，或写入 `~/.bashrc`。

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
cd /opt/crawler/repo/deployment/crawlab
./deploy.sh v1.0.0
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
3. 节点地址填 `http://crawler:3000/health`
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
export CRAWLER_IMAGE_BASE=ghcr.io/<owner>/<repo>
./deploy.sh v1.0.0
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