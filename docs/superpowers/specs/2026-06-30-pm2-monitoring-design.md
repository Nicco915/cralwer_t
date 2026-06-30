# PM2 爬虫监控架构设计（Monitor Hub）

## 背景

当前 SKU 爬虫在 Windows 服务器上以 PM2 服务方式运行，仅有基础进程状态检查（`deployment/windows/lib/health-check.js` 检查 `pm2 jlist` 的 `online` 状态）。随着部署节点增多，需要一套覆盖进程级、业务级、资源级的监控方案，并提供统一 Web 面板与飞书告警。

本设计选择**不引入 Prometheus/Grafana 等外部监控栈**，而是在现有 PM2 基础上增加轻量 Monitor Agent + Monitor Hub，快速落地多节点统一监控。

## 已确认的需求与决策

| 问题 | 决策 |
|---|---|
| 监控优先级 | 分三阶段：A 进程级 → B 业务级 → C 资源级 |
| 部署环境 | Windows 服务器，暂无 Prometheus/Grafana 等监控栈 |
| 告警通道 | 飞书机器人，复用现有 `CRAWLER_FEISHU_*` 配置 |
| Web 面板 | 需要统一中心面板，汇总所有 crawler 节点 |
| 节点规模 | 多台 crawler 节点，统一由 Hub 聚合 |
| 数据持久化 | Hub 使用内存 + JSON 快照，不引入数据库 |
| 面板技术 | 无构建步骤的静态 HTML/JS，Hub 直接提供 |
| crawler 改动 | 新增轻量 `/health` HTTP 接口（默认端口 9999）供 Agent 拉取业务指标 |

## 架构

```text
┌─────────────────────────────────────────────────────────────┐
│                      Monitor Hub 中心节点                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │  HTTP API    │  │  Web 面板    │  │  告警规则引擎     │  │
│  │  /api/nodes  │  │  /dashboard  │  │  Feishu 机器人   │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                           ▲
                           │ HTTP POST 上报（JSON）
        ┌──────────────────┼──────────────────┐
        │                  │                  │
┌───────▼──────┐  ┌───────▼──────┐  ┌───────▼──────┐
│  Crawler-01  │  │  Crawler-02  │  │  Crawler-03  │
│  PM2 crawler │  │  PM2 crawler │  │  PM2 crawler │
│  Monitor     │  │  Monitor     │  │  Monitor     │
│  Agent       │  │  Agent       │  │  Agent       │
└──────────────┘  └──────────────┘  └──────────────┘
```

## 组件设计

### `src/monitor/agent.js` — Monitor Agent

每个 crawler 节点本地运行，由 PM2 托管，职责：

1. 通过 `pm2 jlist` 采集 crawler 进程状态（CPU、内存、重启次数、在线状态）。
2. 通过 HTTP GET `http://localhost:9999/health` 拉取 crawler 业务指标。
3. 通过 Node.js `os` 模块（Phase C）采集机器资源指标。
4. 定时将合并后的数据 POST 到 Hub `/api/report`。

```js
class MonitorAgent {
  constructor(config) {
    this.hubUrl = config.hubUrl;
    this.nodeCode = config.nodeCode;
    this.intervalSeconds = config.intervalSeconds || 30;
  }

  async collect() {
    return {
      process: await this.collectPm2Process(),
      business: await this.collectBusinessMetrics(),
      resource: this.collectResourceMetrics(),
    };
  }

  async report() {
    const payload = await this.collect();
    await fetch(`${this.hubUrl}/api/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }
}
```

### `src/monitor/hub.js` — Monitor Hub

中心服务，职责：

1. 接收 Agent 上报，维护各节点最新状态。
2. 提供 Web API 与 `/dashboard` 面板。
3. 运行告警规则引擎，触发飞书通知。
4. 保留最近 24 小时分钟级历史数据（内存环形缓冲）。

核心 API：

| 接口 | 方法 | 说明 |
|---|---|---|
| `/api/report` | POST | Agent 上报 |
| `/api/nodes` | GET | 所有节点最新状态 |
| `/api/nodes/:nodeCode` | GET | 单个节点详情 |
| `/api/alerts` | GET | 最近告警历史 |
| `/api/health` | GET | Hub 自身健康 |
| `/dashboard` | GET | Web 面板页面 |

### `src/monitor/dashboard/index.html` — Web 面板

无构建步骤的静态页面，由 Hub 提供。展示内容：

- 顶部概览：在线节点数、离线节点数、今日成功/失败任务数
- 节点列表：节点名、进程状态、成功率、队列深度、最后上报时间
- 节点详情：各 Channel 状态（健康/忙碌/当前任务/连续失败）
- 最近告警：时间、节点、规则、级别
- 每 10 秒自动刷新

### `src/monitor/notifier.js` — 飞书通知器

复用项目现有飞书通知逻辑。告警消息格式：

```text
🚨 Crawler 告警

节点：crawler-03
规则：Crawler 进程离线
级别：critical
时间：2026-06-30 12:35:00
详情：节点 crawler-03 的 crawler 进程状态为 errored
面板：http://monitor-server:3000/dashboard
```

告警恢复时发送恢复消息。

### `src/monitor/metrics-collector.js` — 业务指标收集器

在 crawler 进程内维护，供 `/health` 接口读取。

```js
class MetricsCollector {
  constructor() {
    this.reset();
  }

  reset() {
    this.tasksPolled = 0;
    this.tasksQueued = 0;
    this.tasksSuccess = 0;
    this.tasksNotFound = 0;
    this.tasksError = 0;
    this.pushesFailed = 0;
    this.channelStates = [];
  }

  recordTaskResult(status) { /* ... */ }
  recordPushFailed() { /* ... */ }
  setChannelStates(states) { /* ... */ }
  snapshot() { /* 返回当前统计 */ }
}
```

### `src/monitor/rules.json` — 默认告警规则

```json
[
  {
    "id": "crawler-down",
    "name": "Crawler 进程离线",
    "condition": "process.status != 'online'",
    "severity": "critical",
    "cooldownMinutes": 5,
    "message": "节点 {{nodeCode}} 的 crawler 进程状态为 {{process.status}}"
  },
  {
    "id": "node-missing",
    "name": "节点失联",
    "condition": "lastReportSeconds > 120",
    "severity": "critical",
    "cooldownMinutes": 5,
    "message": "节点 {{nodeCode}} 已超过 {{lastReportSeconds}} 秒未上报"
  },
  {
    "id": "success-rate-low",
    "name": "任务成功率过低",
    "condition": "business.successRate < 0.7",
    "severity": "warning",
    "cooldownMinutes": 10,
    "message": "节点 {{nodeCode}} 任务成功率 {{business.successRate}}，低于 70%"
  },
  {
    "id": "push-fail-high",
    "name": "回调失败次数过多",
    "condition": "business.pushesFailed > 10",
    "severity": "warning",
    "cooldownMinutes": 15,
    "message": "节点 {{nodeCode}} 回调失败累计 {{business.pushesFailed}} 次"
  },
  {
    "id": "disk-high",
    "name": "磁盘使用率过高",
    "condition": "resource.diskUsedPercent > 85",
    "severity": "warning",
    "cooldownMinutes": 30,
    "message": "节点 {{nodeCode}} 磁盘使用率 {{resource.diskUsedPercent}}%"
  },
  {
    "id": "memory-high",
    "name": "内存使用率过高",
    "condition": "resource.memoryUsedPercent > 90",
    "severity": "warning",
    "cooldownMinutes": 15,
    "message": "节点 {{nodeCode}} 内存使用率 {{resource.memoryUsedPercent}}%"
  }
]
```

## 数据流

### Agent 上报数据结构

```json
{
  "nodeCode": "crawler-01",
  "timestamp": "2026-06-30T12:34:56.789Z",
  "reportIntervalSeconds": 30,
  "process": {
    "status": "online",
    "pid": 12345,
    "uptimeSeconds": 3600,
    "restartCount": 0,
    "cpuPercent": 12.5,
    "memoryBytes": 268435456
  },
  "business": {
    "tasksPolled": 120,
    "tasksQueued": 3,
    "tasksSuccess": 98,
    "tasksNotFound": 12,
    "tasksError": 10,
    "pushesFailed": 2,
    "successRate": 0.817,
    "channels": [
      { "id": 1, "healthy": true, "busy": true, "currentTaskId": 1001, "consecutiveFailures": 0 },
      { "id": 2, "healthy": true, "busy": false, "currentTaskId": null, "consecutiveFailures": 0 },
      { "id": 3, "healthy": false, "busy": false, "currentTaskId": null, "consecutiveFailures": 2 },
      { "id": 4, "healthy": true, "busy": true, "currentTaskId": 1002, "consecutiveFailures": 0 }
    ],
    "proxy": { "total": 4, "healthy": 4, "lastRefresh": "2026-06-30T12:30:00Z" }
  },
  "resource": {
    "cpuPercent": 35.2,
    "memoryUsedBytes": 2147483648,
    "memoryTotalBytes": 8589934592,
    "diskUsedPercent": 62.1
  }
}
```

### 指标来源

| 指标 | 来源 | 阶段 |
|---|---|---|
| process.status / pid / uptime / restartCount | `pm2 jlist` | A |
| process.cpuPercent / memoryBytes | `pm2 jlist` | A |
| tasksPolled | Poller `fetchTasks()` 成功计数 | B |
| tasksQueued | Worker `taskQueue.length` | B |
| tasksSuccess / notFound / error | Worker `runTask()` 结果统计 | B |
| pushesFailed | Pusher 最终失败计数 | B |
| channels.* | Channel 实例状态 | B |
| proxy.* | ProxyPool / CliproxyPool | B |
| resource.* | Node.js `os` 模块 + PowerShell/wmic | C |

## 错误处理与告警策略

### 告警级别

| 级别 | 含义 | 响应方式 |
|---|---|---|
| critical | 服务不可用或节点失联 | 立即飞书通知 |
| warning | 指标异常，需关注 | 飞书通知，可设置静默 |
| info | 一般性事件 | 仅记录，不主动通知 |

### 告警抑制

- 同一规则同一节点在 `cooldownMinutes` 内只触发一次。
- 节点失联期间，不再触发该节点其他告警，避免告警风暴。
- 支持配置全局静默时段（如夜间不通知 warning）。

### 故障隔离

- Agent、Hub 故障不影响 crawler 主业务运行。
- crawler 的 `/health` 接口无外部依赖，未配置监控时不启动或不影响主流程。
- Hub 宕机仅影响面板和告警，crawler 继续工作。

## 配置项

| CLI Flag | 环境变量 | 默认值 | 说明 |
|---|---|---|---|
| `--monitor-hub-url` | `MONITOR_HUB_URL` | - | Agent 上报地址，未配置时 Agent 不启动 |
| `--monitor-interval` | `MONITOR_INTERVAL_SECONDS` | `30` | Agent 上报周期 |
| `--health-port` | `CRAWLER_HEALTH_PORT` | `9999` | crawler 健康接口端口 |
| `--monitor-port` | `MONITOR_PORT` | `3000` | Hub 监听端口 |
| `--monitor-feishu-webhook` | `MONITOR_FEISHU_WEBHOOK` | - | 告警飞书 webhook，未配置时复用 `CRAWLER_FEISHU_TO` |
| `--monitor-rules-file` | `MONITOR_RULES_FILE` | `src/monitor/rules.json` | 告警规则文件路径 |

## 部署方案

### 1. 单 PM2 配置文件

在 `ecosystem.config.js` 中新增 `monitor-agent` 和 `monitor-hub`：

```js
apps: [
  {
    name: 'crawler',
    // 现有 crawler 配置
  },
  {
    name: 'monitor-agent',
    script: path.join(installDir, 'src', 'monitor', 'agent.js'),
    args: '--monitor-hub-url=http://monitor-server:3000',
    cwd: installDir,
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
  },
  {
    name: 'monitor-hub',
    script: path.join(installDir, 'src', 'monitor', 'hub.js'),
    cwd: installDir,
    instances: 1,
    exec_mode: 'fork',
    env: {
      MONITOR_PORT: 3000,
    },
    autorestart: true,
  },
]
```

### 2. 部署顺序

1. 选择一台机器作为 Hub 中心节点。
2. 在该机器上启动 `monitor-hub`。
3. 在每台 crawler 机器上配置 `MONITOR_HUB_URL` 并启动 `monitor-agent`。
4. 打开 `http://monitor-server:3000/dashboard`。

### 3. 与现有 Windows 部署集成

- 修改 `deployment/windows/ecosystem.config.js` 增加 monitor 应用。
- `setup-pm2-service.ps1` 无需改动，PM2 服务本身已管理所有应用。

## 三阶段演进路线

| 阶段 | 目标 | 主要工作 |
|---|---|---|
| Phase 1 | 进程级监控 + 基础面板 + 飞书告警 | Monitor Agent/Hub/Panel/Notifier 落地 |
| Phase 2 | 业务级精细化监控 | 增加任务分类统计、Channel 健康趋势、回调链路追踪 |
| Phase 3 | 资源级 + 可扩展 | 增加机器资源指标、/metrics 端点、可选 Prometheus/Grafana 接入 |

## 测试

### 单元测试

- `test/monitor/agent.test.js`：验证 Agent 能正确解析 `pm2 jlist` 和 `/health` 数据。
- `test/monitor/hub.test.js`：验证 Hub 接收上报、维护状态、触发告警。
- `test/monitor/notifier.test.js`：验证飞书消息模板渲染。
- `test/monitor/rules.test.js`：验证各告警规则条件计算。

### 集成测试

- 扩展 `test/service.integration.test.js`，验证 crawler 启动后 `/health` 接口返回正确结构。
- 模拟 Agent → Hub 上报流程，验证面板 API 数据一致。

### 部署测试

- 在 Windows 测试机上运行 `pm2 start ecosystem.config.js`，确认三个应用正常启动。
- 模拟 crawler 崩溃，验证 Hub 在 30–60 秒内发出飞书告警。

## 非目标

- 本次不引入 Prometheus/Grafana/InfluxDB 等外部时序数据库。
- 不修改现有 Poller/Pusher/Channel 的核心业务逻辑，仅增加事件埋点。
- 不实现多 Hub 高可用（未来 Phase 3 或节点规模扩大后再考虑）。
- 不实现用户认证与权限管理（面板建议在内网访问）。

## 变更文件

- 新增 `src/monitor/agent.js`
- 新增 `src/monitor/hub.js`
- 新增 `src/monitor/dashboard/index.html`
- 新增 `src/monitor/notifier.js`
- 新增 `src/monitor/metrics-collector.js`
- 新增 `src/monitor/rules.json`
- 修改 `src/service.js`（埋点 + `/health` 接口）
- 修改 `src/cli.js`（解析新增监控配置）
- 修改 `ecosystem.config.js` 和 `deployment/windows/ecosystem.config.js`
- 新增测试文件 `test/monitor/*.test.js`
- 修改 `README.md` 增加监控章节
