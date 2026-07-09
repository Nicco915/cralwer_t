# Loki 监控与容器管理使用说明

> 用 Loki + Promtail + Grafana + Prometheus + Blackbox + Portainer 替代 `deployment/crawlab/`，统一 8 个 Docker 节点与 6 台 Windows PM2 节点的日志聚合、失败率、失败 SKU 排行视图，以及整台 VPS 的容器管理。

详细设计见 `docs/superpowers/specs/2026-07-06-loki-monitoring-design.md`。
实现计划见 `docs/superpowers/plans/2026-07-06-loki-monitoring-plan.md`。

---

## 1. 设计要点

### 1.1 架构

```
┌─────────────── Windows PM2 节点（每台 6 个）──────────────┐
│  PM2: crawler                                               │
│   └─ stdout/stderr → logs/crawler-*.log（结构化 JSON）       │
│  Promtail.exe（NSSM 服务）                                  │
│   └─ 抓 logs/crawler-*.log → POST Loki                     │
└───────────────────────────┬──────────────────────────────┘
                            │ 出站 https://100.x.x.V:3100
                            ▼
┌──────────────── VPS（Ubuntu，Docker 主机）───────────────┐
│  Loki        :3100   监听 Tailscale IP                     │
│  Promtail    抓 docker.sock 容器日志 + ./logs              │
│  Grafana     :3000   监听 Tailscale IP（仅内网）            │
│  Prometheus  :9090   抓 Blackbox + node-exporter           │
│  Blackbox    :9115   主动探各节点 /health                 │
│  crawler-1..8:3001..3008                                 │
└──────────────────────────────────────────────────────────┘
```

### 1.2 数据流

业务事件流：

```
CrawlerService.runTask() 捕获 task result
  → logger.info('task', 'finished', { sku, status, error, durationMs, ... })
       ↓
   stdout（容器/Promtail docker.sock 抓）──────→ Loki
       ↓
   file append（logs/crawler.jsonl，Promtail mount 抓）──→ Loki
       ↓
   Promtail pipeline 抽字段（sku/status/error/...）成为 Loki label
       ↓
   Grafana query 用这些 label 聚合
```

心跳流：

```
CrawlerService 每 heartbeatInterval 秒 → logger.info('heartbeat', 'alive', {...})
       ↓
   Loki 中可见 {component="heartbeat", nodeCode="crawler-XX"}
       ↓
   Grafana 仪表盘 "Crawler · 节点心跳" 用 time() - last_heartbeat 计算"最后心跳距今"
       ↓
   超过 5 分钟 → Grafana Alert critical 告警
```

### 1.3 节点命名

| 环境 | 命名 |
|---|---|
| Docker 容器 | `crawler-01` .. `crawler-08`（端口 3001..3008） |
| Windows PM2 | `crawler-09` .. `crawler-14`（端口 9999） |

### 1.4 网络假设

- **默认**：所有监控端口仅监听 Tailscale IP（`100.64.0.0/10`），Grafana 仅内网访问
- **备选**：公网 IP 白名单（VPS 公网 IP 变了要重改防火墙规则）

---

## 2. 部署步骤

### 2.0 前置条件：Tailscale 网络

所有监控端口（Loki `3100`、Grafana `3000`）默认只监听 Tailscale IP，不暴露公网。

#### 2.0.1 VPS 安装 Tailscale

以 root 执行：

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --accept-dns=false --ssh
```

命令行会输出登录链接，在浏览器里用 Tailscale 账号授权。完成后查看 Tailscale IP：

```bash
tailscale ip -4
```

当前 VPS 的 Tailscale IP：

```
100.111.251.108
```

#### 2.0.2 Windows 节点安装 Tailscale

在每台 Windows 服务器上下载安装：
https://tailscale.com/download/windows

登录**同一个 Tailscale 账号**后，Windows 机器即可通过 `100.111.251.108` 访问 VPS 上的 Loki。

---

### 2.1 VPS（Ubuntu）

```bash
cd /opt/crawler/repo
git pull  # 拉取最新代码

# 确保 .env 里有 Grafana 密码
echo "GRAFANA_ADMIN_PASSWORD=<选一个强密码>" >> deployment/monitoring/.env

docker compose -f deployment/monitoring/docker-compose.yml up -d
```

> 注意：`docker-compose.yml` 中 Loki 端口已绑定到 Tailscale IP `100.111.251.108:3100`，不会监听公网。

验证：

```bash
# Loki 健康检查
curl -s http://100.111.251.108:3100/ready

# Grafana 健康检查（容器内）
docker exec monitoring-grafana wget --spider -q http://127.0.0.1:3000/api/health && echo "grafana ok"

# Promtail 是否正常挂载 Docker 目标
docker logs --tail 20 monitoring-promtail
```

首次启动后，等 30-60 秒让 Loki 索引完成。

#### 2.1.1 Grafana 本地访问：SSH 隧道

Grafana 只监听 Tailscale 内网。如果你当前电脑不在 Tailscale 网络里，可通过 SSH 隧道访问。

**推荐：SSH 密钥登录**

本地生成密钥对：

```bash
ssh-keygen -t ed25519 -C "crawler-grafana" -f ~/.ssh/id_ed25519_grafana
```

把公钥上传到 VPS：

```bash
cat ~/.ssh/id_ed25519_grafana.pub
```

在 VPS root 会话里追加：

```bash
mkdir -p /home/crawler/.ssh
echo '<粘贴公钥>' >> /home/crawler/.ssh/authorized_keys
chown -R crawler:crawler /home/crawler/.ssh
chmod 700 /home/crawler/.ssh
chmod 600 /home/crawler/.ssh/authorized_keys
```

然后在本地 `~/.ssh/config` 添加：

```ssh-config
Host crawler-grafana
    HostName 162.211.228.20
    User crawler
    IdentityFile ~/.ssh/id_ed25519_grafana
    LocalForward 3000 127.0.0.1:3000
```

之后只需：

```bash
ssh crawler-grafana
```

浏览器打开 http://localhost:3000，账号 `admin`，密码见 `deployment/monitoring/.env` 里的 `GRAFANA_ADMIN_PASSWORD`。

### 2.2 每台 Windows

```powershell
# 1. 安装 Tailscale：https://tailscale.com/download/windows
#    登录同一个 Tailscale 账号

# 2. 用管理员 PowerShell 安装 Promtail
.\deployment\windows\install-promtail.ps1 `
  -LokiUrl "http://100.111.251.108:3100/loki/api/v1/push" `
  -NodeCode "crawler-09" `
  -LogDir "D:\crawler\logs"

# 3. 安装 windows_exporter（节点资源监控）
.\deployment\windows\install-windows-exporter.ps1

# 4. 重启 PM2 业务（让 logger 立即生效）
pm2 restart ecosystem.config.js
```

`install-promtail.ps1` 自动完成：
- 检测/安装 NSSM
- 下载 Promtail 2.9.8
- 写 `C:\promtail\promtail.yml`（含 pipeline stages 抽字段）
- 注册为 Windows 服务
- 防火墙开 9080 给 Tailscale 网段

> 如果日志目录不是 `D:\crawler\logs`，改 `-LogDir` 参数。`NodeCode` 建议按 `crawler-09` .. `crawler-14` 命名。

### 2.3 业务容器（Crawler）

业务容器代码已含心跳与 task event 埋点（commit `ba8f21d` 及之前）。无需额外操作，PM2 / Docker 重启业务即生效。

---

## 3. 使用方法

### 3.1 访问 Grafana

**方式一：Tailscale 内网直接访问**

如果你本地电脑已加入同一个 Tailscale 网络：

```
http://100.111.251.108:3000
```

**方式二：SSH 隧道（本地电脑不在 Tailscale 网络时）**

配置好 `~/.ssh/config` 里的 `Host crawler-grafana`（见 2.1.1）后：

```bash
ssh crawler-grafana
```

然后浏览器打开 http://localhost:3000。

默认账号 `admin`，密码来自 `deployment/monitoring/.env` 里的 `GRAFANA_ADMIN_PASSWORD`。

### 3.2 四张仪表盘（位于 Crawler 文件夹）

| 仪表盘 | 用途 | 关键查询 |
|---|---|---|
| **Crawler · 节点心跳** | 节点在线状态 + Blackbox 探活 | `time() - max by (nodeCode) (timestamp({app="crawler"} \| json \| component="heartbeat" \| nodeCode=~".+"))` |
| **Crawler · 失败率与 SKU 排行** | 5 分钟失败率曲线 + top10 失败 SKU + 失败原因分布 | `sum(rate({app="crawler"} \| json \| component="task" \| status="error" [5m])) / sum(rate(... status=~".+" [5m]))` |
| **Crawler · 单 SKU 任务日志** | 输入 SKU 看完整任务日志 + 节点过滤 | `{app="crawler"} \| json \| sku=~"$sku"` |
| **Crawler · 节点资源** | CPU/内存/磁盘使用率（来自 node-exporter / windows_exporter） | 标准 PromQL |

### 3.3 常用 LogQL 查询

#### 看某个节点最近 1 小时所有日志

```logql
{app="crawler"} | json | nodeCode="crawler-01"
```

#### 看最近 24h 失败任务总数

```logql
sum(count_over_time({app="crawler"} | json | component="task" | status="error" [24h]))
```

#### 失败率趋势（5 分钟窗口）

```logql
sum(rate({app="crawler"} | json | component="task" | status="error" [5m]))
/
sum(rate({app="crawler"} | json | component="task" | status=~".+" [5m]))
```

#### 失败 SKU top10（24h）

```logql
topk(10, sum by (sku) (count_over_time({app="crawler"} | json | component="task" | status="error" [24h])))
```

#### 单 SKU 全文日志

```logql
{app="crawler"} | json | sku="YOUR_SKU_HERE"
```

#### 看心跳是否存在

```logql
{app="crawler"} | json | component="heartbeat" | nodeCode="crawler-09"
```

---

## 4. 告警（当前就绪但未接飞书）

两条 Grafana Alert 规则已配置（在 `deployment/monitoring/alert-rules/rules.yml`）：

| 规则 | 条件 | 严重度 |
|---|---|---|
| `CrawlerNodeHeartbeatMissing` | 节点心跳缺失超过 5 分钟 | critical |
| `CrawlerFailureRateHigh` | 全局失败率 > 50% 持续 5 分钟 | warning |

**当前状态**：规则在 Grafana Alerting UI 中可见，但**未配置 webhook contact point**（飞书/钉钉等）。需要时在 Grafana UI → Alerting → Contact points 添加。

---

## 5. 常见排查操作

### 5.1 节点不在线

1. Grafana → "Crawler · 节点心跳" 面板，看节点最后心跳时间
2. SSH 到该节点
3. 检查 PM2 状态：`pm2 list` / `pm2 logs`
4. 检查 Promtail 服务：`nssm status Promtail`，查看 `C:\promtail\promtail.log`
5. 检查 Loki 连通性：从 Windows 跑 `Test-NetConnection 100.x.x.V -Port 3100`

### 5.2 看不到任务日志

1. 检查心跳是否存在（3.3 节查询）
2. 如果心跳有但 task event 没有 → 看 Worker 日志 / 调高 `data-layer-failure-threshold` 排查
3. 如果都没 → 检查 Promtail 是否在抓：`cat /var/lib/docker/containers/.../*.log`

### 5.3 Grafana 查询慢

1. 检查 Loki chunk 数：`curl http://127.0.0.1:3100/metrics | grep loki_tsdb`
2. 如果 chunk 太多 → 增加 `compactor.retention_delete_worker_count` 或缩短 `retention_period`

### 5.4 Blackbox 探活显示 0 容器（Grafana "Blackbox 探活（8 容器）" 面板为 0）

**现象**：Grafana → "Crawler · 节点心跳" → "Blackbox 探活（8 容器）" stat 面板显示 **0**（红色），但 Loki 节点列表面板里 8 个节点都有日志。

**根因**：

- `prometheus.yml` 里 blackbox target 用短主机名：`http://crawler-1:3001/health` 等
- Docker DNS 解析容器时，**依赖容器自身 hostname**
- 如果 docker run 启动 crawler 时**没有**显式 `--hostname crawler-N`，容器默认 hostname 是容器 ID 前 12 位（如 `081211bd6a3f`），Docker DNS 无法解析 `crawler-1`
- Blackbox probe 全部 fail → Prometheus `probe_success = 0`

**诊断命令**：

```bash
# 1. 看容器实际 hostname
for i in 1 2 3 4 5 6 7 8; do
  echo "hs-sku-crawler-${i}: $(docker inspect hs-sku-crawler-${i} --format '{{.Config.Hostname}}')"
done

# 2. 看 Prometheus 是否能拉到 blackbox 指标
docker exec monitoring-prometheus wget -qO- "http://localhost:9090/api/v1/query?query=probe_success" | python3 -m json.tool

# 3. 从 blackbox 容器手动探测一次
docker exec monitoring-blackbox wget -qO- "http://127.0.0.1:9115/probe?module=http_2xx&target=http://crawler-1:3001/health"
```

**修复**：重启 crawler 容器时**显式加 `--hostname`**：

```bash
docker run -d \
  --name hs-sku-crawler-1 \
  --hostname crawler-1 \        # ← 关键：让 Docker DNS 能解析
  --network crawler_crawler-net \
  --user 1000:1000 \
  -p 127.0.0.1:3001:3001 \
  ...
  ghcr.io/nicco915/cralwer_t:v1.2.0
```

**验证修复**：

```bash
# 等 30-60 秒 Prometheus 第一轮 scrape 后查
docker exec monitoring-prometheus wget -qO- "http://localhost:9090/api/v1/query?query=sum(probe_success%7Bjob%3D%22blackbox%22%7D)"
# 期望：value = "8"
```

**预防**：在 `部署vps.md` 7.6 节的滚动升级脚本模板里**始终带 `--hostname crawler-N`**，避免遗漏。

---

## 6. 关键配置项

| 项 | 默认值 | 说明 |
|---|---|---|
| `CRAWLER_HEARTBEAT_INTERVAL` | 30 | 心跳间隔（秒） |
| `CRAWLER_HEALTH_PORT` | 9999 | 健康检查端口（Blackbox 探活） |
| `CRAWLER_NODE_CODE` | `crawler-01` | 节点标识，决定 Loki label 中的 `nodeCode` |
| `GRAFANA_ADMIN_PASSWORD` | **必填，无 fallback** | Grafana 管理员密码 |
| `MONITOR_PORT` | 3000 | Grafana 端口（compose 中固定） |

---

## 7. 不做的事（明确边界）

- **不引入** Prometheus/Grafana/InfluxDB 等外部时序数据库（用 Loki 自管）
- **不改造** Poller/Pusher/Channel 主循环，仅增加事件埋点
- **不实现** 告警抑制 / 静默时段
- **不实现** 用户认证（Grafana 仅绑 Tailscale IP，假设内网可信）
- **不废弃** logger.js，仅接入

---

## 8. 文件清单（部署时用到）

```
deployment/monitoring/
├── docker-compose.yml              # 监控栈（loki/promtail/grafana/prometheus/blackbox/node-exporter）
├── loki-config.yml
├── promtail-docker.yml
├── prometheus.yml
├── blackbox.yml
├── grafana-datasources/provider.yml  # Loki + Prometheus
├── grafana-dashboards/provider.yml
├── grafana-dashboards/
│   ├── crawler-nodes.json
│   ├── crawler-failures.json
│   ├── crawler-task-logs.json
│   └── node-resources.json
└── alert-rules/rules.yml

deployment/windows/
├── install-promtail.ps1            # Promtail NSSM 服务
└── install-windows-exporter.ps1    # windows_exporter MSI
```

业务代码改动：

- `src/logger.js` 新增 `createStdoutLogger` / `createBroadcastLogger`
- `src/service.js` `start()` 调 `startHeartbeat()`，`stop()` 调 `stopHeartbeat()`，日志走 broadcast logger
- `src/worker.js` `runTask` 写 task event 日志
- `src/cli.js` `--heartbeat-interval` / `CRAWLER_HEARTBEAT_INTERVAL`

---

## 9. 故障排除速查表

| 现象 | 检查 |
|---|---|
| Loki /ready 返回非 200 | `docker logs monitoring-loki` |
| Promtail 抓不到日志 | `docker logs monitoring-promtail` 看 positions 文件 |
| Grafana dashboard "datasource not found" | `cat deployment/monitoring/grafana-datasources/provider.yml` 看 `uid:` 字段 |
| 告警规则 NoData 一直触发 | 确认 Loki 中 `component="heartbeat"` 日志存在 |
| Promtail pipeline 抽不到 sku | 看 worker 写入的 JSON 是否含 `"sku":"..."` 字段（注意 spec 转义） |
| Blackbox 探活显示 0 容器 | 见 5.4 节，**`--hostname crawler-N`** 是否在 `docker run` 时显式设置 |

---

## 10. Portainer 容器管理面板

`deployment/portainer/` 用 docker compose 单独管理一个 Portainer CE 容器，作为 VPS 上所有容器（crawler、监控栈）的 Web UI。

### 10.1 资源占用

- 镜像：`portainer/portainer-ce:2.21.5`，约 80 MB
- 内存：空闲约 30-50 MB，CPU 接近 0%
- 监听端口：9443（HTTPS，HTTP 9000 已关闭）

对一台跑 8 个 crawler + Loki/Promtail/Grafana/Prometheus/Blackbox 的 VPS 来说基本可忽略。

### 10.2 安装

VPS 上执行（一次性）：

```bash
cd /opt/crawler
mkdir -p portainer && cd portainer

# 复制仓库里的 compose 文件
cp /opt/crawler/repo/deployment/portainer/docker-compose.yml .

# 创建 .env，绑定到 Tailscale IP（仅内网可访问）
cp /opt/crawler/repo/deployment/portainer/.env.example .env
sed -i 's|^PORTAINER_BIND_ADDR=.*|PORTAINER_BIND_ADDR=100.111.251.108|' .env

# 启动
docker compose up -d
```

或者用 `deploy.sh` 类的脚本同步时直接 rsync 这个目录过去。

### 10.3 访问

1. 浏览器打开 `https://100.111.251.108:9443`
2. 首次访问会提示创建管理员账号（用户名 + 12 位以上密码）
3. 进入后会默认列出 **local** 环境，可看到这台 VPS 上所有容器（crawler-1..8、monitoring-*、portainer 自身）
4. 可以按容器看 CPU/内存/日志、重启、exec 进 shell、查环境变量、看镜像层

### 10.4 维护命令

```bash
cd /opt/crawler/portainer

# 拉取新版镜像并滚动重启
docker compose pull
docker compose up -d

# 看日志
docker compose logs -f --tail=100

# 停掉
docker compose down
```

数据持久化在 named volume `portainer_portainer_data`，升级或重建容器不会丢配置/账号/已注册的环境。

### 10.5 安全说明

- Portainer 挂载了 `/var/run/docker.sock`，相当于拿到了宿主机 root 权限。
- 因此 compose 里把端口绑到 `PORTAINER_BIND_ADDR`（默认 Tailscale IP `100.111.251.108`），**不要改成 `0.0.0.0`** 或公网 IP。
- HTTPS 用的是自签证书，浏览器会提示不安全，信任一次即可。
- 创建管理员账号时使用 12 位以上强密码。
- 如果需要多人协作，用 Portainer 自身的 teams/roles 功能给同事开权限，不要共享管理员账号。