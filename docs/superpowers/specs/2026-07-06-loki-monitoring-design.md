# Loki + Promtail + Grafana 监控方案

## 背景

当前 hs-sku-crawler 在 1 台 Ubuntu VPS（Docker 容器，8 个 crawler 节点）和 6 台 Windows（PM2 管理）上运行，原 `deployment/crawlab/` 只发挥"节点列表 + ping /health"的作用，无法回答以下业务问题：

- 单 SKU 的最近一次抓取结果（成功 / 失败 / 原因）
- 过去 24h 失败率趋势
- 失败最多的 SKU 排行
- 任一节点当前是否在线、心跳何时中断
- 单个容器 / 单台 Windows 的实时与历史日志全文

`docs/superpowers/specs/2026-06-30-pm2-monitoring-design.md` 提出过自研 Monitor Hub（6 文件、~1600 行），方案重、维护成本高。

本设计用 **Loki + Promtail + Grafana** 替代 Crawlab 与待落地的自研 Hub，以最小业务代码改动换取完整日志聚合与故障定位能力。

## 目标

1. 删除 `/deployment/crawlab/`，由 Loki + Grafana 提供节点与日志视图。
2. 6 台 Windows PM2 节点与 8 个 Docker 节点进同一份 Loki 数据。
3. 仪表盘回答：节点在线状态、失败率、失败 SKU 排行、单 SKU 全文日志、节点心跳。
4. 业务代码改动控制在 ~80 行以内。
5. 监控栈故障不影响爬虫主业务。

## 已确认的决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 节点命名 | Docker：`crawler-01`..`crawler-08`；Windows PM2：`crawler-09`..`crawler-14` | 与现有 docker-compose 中 `CRAWLER_NODE_CODE` 对齐；6 台 Windows 接续编号 |
| 网络 | 默认 **Tailscale** mesh，所有监控端口仅对 `100.x.x.x` 监听 | 零端口对公网开放；白名单自动维护；个人账号免费 100 设备足够 |
| 网络备选 | 不装 Tailscale 时，Windows `healthPort` 对 VPS 公网 IP 开白名单 | 维护成本高但可降级运行 |
| 告警 | 保留 Grafana Alert 规则模板（进程离线、心跳超时、失败率突增），但**不接飞书 webhook** | 用户要求暂缓，预留配置 |
| 日志存储 | Loki 本地文件系统后端，保留 31 天 | 单 VPS 容量够；不引入 S3 / MinIO |
| 资源采集 | node-exporter + Prometheus Blackbox | 与 Loki 同栈部署，不增加新组件 |
| 行为 | **不引入 Alertmanager**、**不改造 CrawlerService 主循环**、**不动 logger.js 接口** | 守住改动边界 |

## 架构

```
┌─────────────── Windows PM2 节点（每台 6 个）──────────────┐
│ Tailscale IP: 100.x.x.A..F                                  │
│                                                          │
│  PM2: crawler                                               │
│   └─ stdout/stderr → logs/crawler-*-out.log,  crawler-*.log │
│       （结构化 JSON，通过 logger.js 改造后输出）              │
│  Promtail.exe（NSSM 装服务）                                │
│   └─ 抓 logs/crawler-*.log → POST Loki                     │
└───────────────────────────┬──────────────────────────────┘
                            │ 出站 https://100.x.x.V:3100
                            ▼
┌──────────────── VPS（Ubuntu，Docker 主机）───────────────┐
│ Tailscale IP: 100.x.x.V                                   │
│                                                          │
│  Loki        :3100   监听 100.64.0.0/10                    │
│  Promtail    抓 docker.sock 容器日志 + ./logs 目录         │
│  Grafana     :3000   监听 100.64.0.0/10                    │
│  Prometheus  :9090   抓 Blackbox + node-exporter           │
│  Blackbox    :9115   主动探各节点 /health                 │
│  crawler-1..8:3001..3008                                 │
└──────────────────────────────────────────────────────────┘
                            ▲
              Tailscale 内网（出站入站都走 mesh）
                            │
┌──────────────────────────┴───────────────────────────────┐
│  用户浏览器 → Grafana :3000                                │
│  仅内网访问（绑定 Tailscale IP）                            │
└──────────────────────────────────────────────────────────┘
```

## 数据流

### 1. 任务结果上报

```
CrawlerService.runTask() 捕获 task result
  → logger.info('task', { sku, status, error, durationMs, retries })
       ↓
   console.log (stdout) ────→ Docker 容器 stdout ──→ Promtail docker.sock ──→ Loki
       ↓
   file append (logs/crawler.jsonl) ──→ 主机 ./logs/ ──→ Promtail mounts ──→ Loki
```

Windows 节点同上，promtail 直接读 PM2 log 文件和 `crawler.jsonl`。

### 2. 节点心跳

```
CrawlerService 启动 setInterval(30s)
  → logger.info('heartbeat', { uptime, channels, queue })
  → Promtail 看到一条心跳日志
  → Grafana 仪表盘 time() - max(timestamp(...)) 算"最后心跳"
  > 5 分钟 → 标红告警
```

### 3. 健康探活

```
Prometheus Blackbox → http://100.x.x.A:9999/health  (PM2 节点)
                  → http://crawler-1:3001/health    (Docker 容器，docker 网络内)
Grafana → Prometheus datasource → prober_success{instance="..."} up{}
```

### 4. 资源指标

每台 Windows 装 `windows_exporter`（Prometheus 官方），VPS 装 `node_exporter`。本设计关注业务监控，资源指标用现成 dashboard 模板即可，不写自定义查询。

## 组件清单

### 必装

| 组件 | 镜像 / 二进制 | 来源 | 端口 |
|---|---|---|---|
| Loki | `grafana/loki:2.9.x` | Docker Hub | 3100 |
| Promtail（容器） | `grafana/promtail:2.9.x` | Docker Hub | — |
| Promtail（Windows） | `promtail-windows-amd64.exe` | GitHub Releases | — |
| Grafana | `grafana/grafana:10.4.x` | Docker Hub | 3000 |
| Prometheus | `prom/prometheus:v2.51.x` | Docker Hub | 9090 |
| Blackbox exporter | `prom/blackbox-exporter:v0.25.x` | Docker Hub | 9115 |
| node-exporter | `prom/node-exporter:v1.7.x` | Docker Hub | 9100 |
| windows_exporter | `windows_exporter-0.27.x.msi` | GitHub Releases | 9182 |
| Tailscale | `tailscale_1.66.x_amd64.deb` / `Tailscale-1.66.x.msi` | 官网 | — |

### 各机器组件分布

| 机器 | 装什么 |
|---|---|
| VPS（Ubuntu） | Loki、Promtail（容器）、Grafana、Prometheus、Blackbox、node-exporter、Tailscale |
| Windows 1..6 | 爬虫本体（PM2）、Promtail.exe、windows_exporter、Tailscale |

## 文件清单（本设计引入或修改）

### 新增

```
deployment/monitoring/
├── docker-compose.yml                  # 监控栈：loki/promtail/grafana/prometheus/blackbox
├── loki-config.yml
├── prometheus.yml                      # scrape 配置文件
├── promtail-docker.yml                 # 容器版 promtail 配置（抓 docker.sock + ./logs）
├── blackbox.yml
├── grafana-datasources/
│   └── loki.yml                        # Loki datasource（自动 provisioning）
├── grafana-dashboards/
│   ├── crawler-nodes.json              # 节点在线 + 心跳 + 容器资源
│   ├── crawler-failures.json           # 失败率 + 失败 SKU 排行
│   ├── crawler-task-logs.json          # 单 SKU 全文日志过滤
│   └── node-resources.json             # node-exporter 通用模板
└── alert-rules/
    └── rules.yml                       # Grafana Alert 规则（暂不接 webhook）

deployment/windows/
├── install-promtail.ps1                # NSSM 注册 Promtail 服务
├── install-windows-exporter.ps1
└── uninstall-promtail.ps1

test/monitoring/
├── promtail-pipeline.test.js           # 验证 Promtail pipeline 拆字段正确
├── service-heartbeat.test.js           # 验证 /health 返回 timeSinceLastHeartbeat
└── worker-task-event.test.js           # 验证 Worker 埋点写出正确 JSON
```

### 修改

```
src/service.js          # 接入 logger.js 写 JSON 日志 + 心跳定时器
src/worker.js           # 在 pushPromise.finally 写 task event 日志
src/cli.js              # 加 NODE_CODE 心跳间隔配置（默认 30s）
ecosystem.config.js     # 加 --log-format=json 心跳开关（如果用 PM2 启 service）
deployment/crawlab/     # 整目录删除
```

## 业务代码改动详细

### 1. `src/logger.js`（几乎不动）

现有 `createFileLogger` 即可用，新增一个 `createStdoutLogger`（写 stdout，与现有 stdout 行为兼容），让两个 logger 通过 `createBroadcastLogger` 同时写：

```js
// 新增
function createBroadcastLogger(loggers) {
  return {
    info: (c, m, e) => loggers.forEach(l => l.info(c, m, e)),
    warn: (c, m, e) => loggers.forEach(l => l.warn(c, m, e)),
    error: (c, m, e) => loggers.forEach(l => l.error(c, m, e)),
  };
}
```

### 2. `src/service.js`

构造时实例化 logger（在 `nodeCode` 已知之后）：

```js
this.logger = createBroadcastLogger([
  createLogger({ nodeCode: this.config.nodeCode }),                       // stdout
  createFileLogger({ nodeCode: this.config.nodeCode, logDir: './logs' }),  // 文件
]);
```

`log()` 方法保留内部旧调用兼容，外层所有事件改用 `this.logger.info/warn/error`。

增加心跳定时器：

```js
startHeartbeat() {
  const interval = (this.config.heartbeatInterval || 30) * 1000;
  this.heartbeatTimer = setInterval(() => {
    this.logger.info('heartbeat', 'alive', {
      uptime: Math.floor((Date.now() - this.startedAt) / 1000),
      channels: this.channels.length,
      pending: this.worker?.taskQueue.length || 0,
      running: this.worker?.channels.filter(c => c.busy).length || 0,
    });
  }, interval);
}
```

### 3. `src/worker.js`

在 `runTask` 的 `pushPromise.finally` 中：

```js
pushPromise.finally(() => {
  this.logger.info('task', 'finished', {
    crawlerTaskId: result?.crawlerTaskId,
    sku: result?.sku,
    status: result?.status,   // success | not_found | error | timeout
    error: result?.error,
    durationMs: Date.now() - startedAt,
    retries: retries,
    channelId: channel.id,
  });
  channel.busy = false;
  // ...existing cleanup
});
```

构造器接收 `logger`：

```js
this.logger = options.logger || createConsoleLikeLogger();
```

## Promtail pipeline（关键）

`promtail-docker.yml` 和 `promtail-windows.yml` 共享同一套 pipeline stages，确保 Loki 收到的字段一致：

```yaml
scrape_configs:
  - job_name: crawler
    docker_sd_configs:
      - host: unix:///var/run/docker.sock
        refresh_interval: 5s
        filters:
          - name: label
            values: ["com.docker.compose.project"]
    relabel_configs:
      - source_labels: ['__meta_docker_container_name']
        regex: '/(hs-sku-crawler-\d+)'
        target_label: 'container'
      - source_labels: ['__meta_docker_container_label_CRAWLER_NODE_CODE']
        target_label: 'nodeCode'

pipeline_stages:
  - match:
      selector: '{app="crawler"}'
      stages:
        - regex:
            expression: '.*"sku":"(?P<sku>[^"]+)".*'
        - regex:
            expression: '.*"status":"(?P<status>[^"]+)".*'
        - regex:
            expression: '.*"error":"(?P<error>[^"]+)".*'
        - regex:
            expression: '.*"durationMs":(?P<durationMs>\d+).*'
        - regex:
            expression: '.*"component":"(?P<component>[^"]+)".*'
        - regex:
            expression: '.*"level":"(?P<level>[^"]+)".*'
        - labeldrop:
            - level
        - labels:
            level:
```

提取出来的 `sku`、`status`、`error`、`durationMs` 成为 LogQL 可查询字段。

## Grafana 仪表盘查询

### 仪表盘 1：crawler-nodes.json

**节点列表（心跳面板）**：

```logql
sum by (nodeCode) (
  count_over_time({app="crawler"} | json | component="heartbeat" [$__interval])
)
```

**"最后一次心跳距今"**：

```logql
time() - max by (nodeCode) (
  timestamp(
    coalesce(
      {app="crawler"} | json | component="heartbeat" | __error__="" | nodeCode=~".+",
      {app="crawler"} | json | nodeCode=~".+"
    )
  )
)
```

阈值 > 300s 标红。

**节点健康（Prometheus）**：

```
probe_success{job="crawler-blackbox"}
```

### 仪表盘 2：crawler-failures.json

**失败率（每分钟）**：

```logql
sum(rate({app="crawler"} | json | component="task" | status="error" [5m]))
/
sum(rate({app="crawler"} | json | component="task" | status=~"success|error|timeout|not_found" [5m]))
```

**失败 SKU 排名（24h top10）**：

```logql
topk(10,
  sum by (sku) (
    count_over_time(
      {app="crawler"} | json | component="task" | status="error" [24h]
    )
  )
)
```

**失败原因分布**：

```logql
sum by (error) (
  count_over_time(
    {app="crawler"} | json | component="task" | status="error" [24h]
  )
)
```

### 仪表盘 3：crawler-task-logs.json

**单 SKU 全文日志过滤**（变量 `$sku`）：

```logql
{app="crawler"} | json | sku="$sku"
```

**单节点实时日志**：

```logql
{app="crawler"} | json | nodeCode="$nodeCode"
```

## 错误处理与降级

| 故障 | 影响 | 行为 |
|---|---|---|
| Loki 宕 | 业务无感 | Promtail 本地磁盘缓冲 24h，恢复后重推 |
| Promtail 宕 | 业务无感 | 重启后从文件最新位置继续 |
| Windows → VPS 网络断 | 业务无感 | Promtail 本地缓冲；Tailscale 断后重连自动恢复 |
| Grafana 不可用 | 仅影响可视化 | 可 `docker logs loki` 应急查 |
| Prometheus 不可用 | 仪表盘黑屏 | `docker compose restart monitoring` 即可 |
| Tailscale 断 | 失去 Loki 上报 + Blackbox 探活 | 节点继续运行；Prometheus Up 为 0；下次 Tailscale 恢复后心跳重新上报 |
| node-exporter 不可用 | 资源指标缺失 | 业务监控仍可用 |

**关键不变量**：监控组件全部失败 = 爬虫业务继续运行；这是设计第一原则。

## 测试

### 单元

| 文件 | 内容 |
|---|---|
| `test/logger.test.js`（已有，扩展） | 验证 `createBroadcastLogger` 双写顺序与失败兜底 |
| `test/service-heartbeat.test.js`（新增） | mock 时间，验证心跳 JSON 字段完整 |
| `test/worker-task-event.test.js`（新增） | mock `pusher.push` 成功/失败，验证 task event 日志结构 |

### 集成

| 文件 | 内容 |
|---|---|
| `test/monitoring/promtail-pipeline.test.js`（新增） | 喂入一组合成日志给 Promtail pipeline stages，断言 `sku/status/error` 字段被正确抽取。**用 Loki 的 pipeline stage 包作为 Node 模块直接测**（Loki pipeline 是独立 Go 库；用 Docker 跑 Promtail 测试实际输出更可靠） |
| `test/deployment/monitoring-stack.test.js`（新增） | `docker compose -f deployment/monitoring/docker-compose.yml up -d` 后，curl `http://127.0.0.1:3100/ready`、`http://127.0.0.1:3000/api/health` 全 OK |

### 部署测试

```
1. 在 1 个 Docker 节点 + 1 台 Windows 各跑通
2. 用假 SKU 触发 1 条失败
3. 验证 Loki 中能查到这行日志 + Grafana 仪表盘显示
4. 关闭 Loki 容器 60 秒后再开
5. 验证 Promtail 补推，业务日志无丢失
6. 关闭 Tailscale 60 秒后恢复
7. 验证 Promtail 重连恢复（无重复日志）
```

## 部署步骤

### A. 一次性 VPS 操作

```bash
# 1. 安装 Tailscale
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up --authkey=<auth-key>

# 2. 拉监控 docker-compose
cd /opt/crawler
docker compose -f deployment/monitoring/docker-compose.yml up -d

# 3. 导入 Grafana dashboard
#    通过 Grafana UI: Dashboard → Import → 上传 4 个 JSON 文件
#    或通过 provisioning 自动导入（推荐，复制定义到 grafana-dashboards/）

# 4. 删除 Crawlab
docker compose -f deployment/crawlab/docker-compose.yml down -v
rm -rf deployment/crawlab
```

### B. 每台 Windows 操作

```powershell
# 1. 安装 Tailscale
msiexec /i Tailscale-1.66.x.msi /quiet

# 2. 安装 Promtail
.\install-promtail.ps1 -LokiUrl "http://100.x.x.V:3100/loki/api/v1/push"

# 3. 安装 windows_exporter
msiexec /i windows_exporter-0.27.x.msi /quiet

# 4. 重启 PM2 业务（让 logger 立即生效）
pm2 restart ecosystem.config.js
```

PM2 log 文件路径需在 `install-promtail.ps1` 中与现有 `ecosystem.config.js` 配置一致（默认 `D:\crawler\logs\crawler-*-out.log`）。

### C. 业务代码上线

```bash
git pull
npm install
pm2 reload ecosystem.config.js   # Windows
docker compose up -d             # VPS crawler 节点
```

## Grafana Alert 模板（接与不接都给）

```yaml
# deployment/monitoring/alert-rules/rules.yml
groups:
  - name: crawler
    rules:
      - alert: CrawlerNodeHeartbeatMissing
        expr: time() - max by (nodeCode) (timestamp({app="crawler"} | json | component="heartbeat" | nodeCode=~".+" | __error__="")) > 300
        for: 2m
        labels: { severity: critical }
        annotations:
          summary: "节点 {{ $labels.nodeCode }} 心跳超过 5 分钟"

      - alert: CrawlerFailureRateHigh
        expr: |
          sum(rate({app="crawler"} | json | component="task" | status="error" [5m]))
          / sum(rate({app="crawler"} | json | component="task" | status=~".+" [5m])) > 0.5
        for: 5m
        labels: { severity: warning }
        annotations:
          summary: "节点 {{ $labels.nodeCode }} 失败率超过 50%"

      - alert: BlackboxProbeFailed
        expr: probe_success{job="crawler-blackbox"} == 0
        for: 1m
        labels: { severity: critical }
```

## 不做的事（明确边界）

- 不引入 Alertmanager；告警 fly-out 仅留 Grafana Alert contact point 配置位
- 不引入外部对象存储（S3 / MinIO）；Loki 用本地 fs 后端
- 不改造 `CrawlerService` 主循环；`Poller/Pusher/Channel` 不动
- 不实现告警抑制 / 静默时段；下个 sprint 再加
- 不实现多 Grafana 高可用
- 不实现用户认证；Grafana 仅绑 Tailscale IP（内网访问假设可信）
- 不废弃 logger.js，仅接入
- 不动 `ecosystem.config.js` 的 PM2 日志文件路径（沿用现有 `logs/crawler-*-out.log`）

## 风险与缓解

| 风险 | 概率 | 缓解 |
|---|---|---|
| Tailscale 个人账号注销 → 全员失联 | 低 | 保留公网白名单备选；`install-promtail.ps1` 接受 `--fallback-public-url` |
| Loki 单点故障 | 中 | Volume 挂到 VPS 本地 SSD；监控 compose 中加 `restart: unless-stopped` |
| Grafana dashboard JSON 不兼容 | 低 | 在 `loki:2.9.x / grafana:10.4.x` 锁定版本；升级时回归测试 |
| Windows Promtail 内存累积 | 中 | Promtail 默认每 24h rotate log position；显式限制 `batch_wait` = 1s |
| 业务日志格式演进破坏 Promtail pipeline | 中 | CI 中加 `promtail-pipeline.test.js` 跑现有 fixture |
| 多节点同时推 Loki，网络抖动 | 中 | Promtail 客户端 retry + disk buffer，参数显式配置 |

## 后续可演进项

1. 接入飞书 webhook（用户暂缓）
2. Loki S3 后端 + 多 VPS
3. Grafana SSO
4. 业务级 dashboard 模板（按节点分组）
5. nodeCode 自发现（PM2 启动时自动注册到 Loki label）

## 验收清单

- [ ] 删除 `deployment/crawlab/` 目录
- [ ] `deployment/monitoring/` 完整可起
- [ ] Tailscale mesh 6 台 Windows + VPS 入网
- [ ] CrawlerService 心跳每 30s 一行 JSON
- [ ] Worker.runTask 完成一条 task event
- [ ] Grafana 4 张 dashboard 可视化
- [ ] `/health` 含 `nodeCode`、`business` 字段（沿用既有实现）
- [ ] 单 SKU 输入 Grafana 变量过滤能查到完整日志
- [ ] 关闭 Loki 30s 后日志不丢
- [ ] 测试 `npm test` 全绿
