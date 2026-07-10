# 多区域（EU / CA / UK）爬取适配 — 设计

- 日期：2026-07-10
- 状态：设计已确认；前置假设已用真烟测验证
- 影响范围：task 契约新增 `region` 字段；单节点同时服务多区域；仅 `baseUrl` 随任务变化

## 1. 背景与目标

现状：爬虫节点启动时从 `CRAWLER_BASE_URL`（默认 `https://eur.vevor.com`）读取一次 `baseUrl`，写死进每个 Channel / PageCrawler（`page-crawler.js` 拼 `${baseUrl}/s/${sku}`）。一个服务实例 = 一个站点，运行期不可改。README 既定调「上游按 `nodeCode` 分发，节点无状态」。

目标：在 **不新增节点、不改动代理池** 的前提下，让单个节点同时爬取三个区域站点：

| 区域 | baseUrl |
|---|---|
| EU | `https://eur.vevor.com` |
| CA | `https://www.vevor.ca` |
| UK | `https://www.vevor.co.uk` |

上游通过在 task 报文里携带区域字段来区分指向。已确认三个站点「域名不同之外，爬取逻辑相同」。

## 2. 已验证前提（2026-07-10 真烟测，VPS 生产代理环境）

在搬瓦工 VPS（生产同镜像 `ghcr.io/nicco915/cralwer_t:v1.2.0`、同网络、同 `.env`）用一次性隔离容器（`--rm`，独立 sticky session，禁图床上传）跑现行 Channel/PageCrawler 链路，仅切换 `--base-url`：

| 区域 | 样本 | 结果 | product_url 域名 |
|---|---|---|---|
| EU（对照） | 3 SKU | 3/3 success | `eur.vevor.com` |
| CA | 3 SKU | 3/3 success | `www.vevor.ca` |
| UK | 3 SKU | 3/3 success | `www.vevor.co.uk` |

无强制跳回 `.com`、无 CF 未解、无 `net::ERR`/geo 阻断。

出口 IP 验证：用与生产完全一致的代理参数（`region=DE`、`asn=AS12897`、`sid`、`t`）请求地理接口，得到 `149.249.136.215`，Hesse, Germany，ASN `AS12897 ENTEGA Medianet GmbH`（与配置 ASN 一致），时区 `Europe/Berlin`。**确认 DE 代理池确为德国出口。**

结论：**“同一 DE 代理池爬所有区域，仅 `baseUrl` 随任务变化”成立**，跨区域的 geo/CF 风险已实证排除，可作为本设计的事实前提。

> 副发现（范围外，见 §10）：仓库自带 `test-sku.js` 构造 `CliproxyPool` 时未传入 `regionParamName/asn/session/sticky` 等参数，会回退到默认 `country-DE`，导致在该 `.env` 下拿到错误/随机出口 IP（首次烟测即因此拿到巴西 IP）。生产 `service.js` 传参正确，不受影响。

## 3. 决策

### 3.1 路由模型：上游在 task 里带 `region`，节点跨区域服务（已选）

- **采用**：task payload 增加 `region`（`EU`/`CA`/`UK`，缺省 = 节点默认区域）。单节点同时跑三区。
- **否决**：上游按 `nodeCode` 路由到「区域节点」（每区一套部署）。优点是与现状零改动、故障隔离强；代价是三套部署、无法跨区弹性借容量，且用户已明确倾向 task 带 region。

### 3.2 通道模型：动态 baseUrl，任一通道跑任一区域（已选）

- **采用**：通道数量不变，任一空闲通道可跑任一区域；Worker 在派发时按 `task.region` 解析 `baseUrl` 下传 PageCrawler。资源全弹性、无容量浪费。
- **否决**：区域分区通道池（ch1-2=EU、ch3=CA、ch4=UK）。优点是隔离最干净、PageCrawler 零改动；代价是要拆 FIFO 队列（否则队头 CA 任务堵住后面 EU）、容量静态切分、新增 channel→region 配置。现阶段不需要。

### 3.3 代理池：完全不动（已选）

继续用 DE（`CLIPROXY_REGION=DE`）代理池爬所有区域。由 §2 实证可行。换 IP / 健康检查 / 心跳逻辑全部维持现状。

### 3.4 区域→baseUrl 映射放节点（registry），上游只传 region 码（已选）

- **采用**：节点配置持有一份权威 `region → baseUrl` 映射；上游只传短码。好处：合法站点白名单在节点侧，防上游拼错 URL 指到恶意站点；回调可回显 `region` 便于对账；新增第 4 区只改一处配置。
- **否决**：上游直接下发 `baseUrl`。节点零映射但失去白名单防线、回调域名难归一。除非上游坚持，否则不采用。

## 4. 数据流

```
upstream
  │ POST CRAWLER_TASK_URL  ← nodeCode（节点全局唯一，不按区域拆）
  ▼
Poller  ── 透传 task.{region, …}（原样透传，不做默认填充）
  ▼
Worker.runTask
  │  region = task.region（缺省/空白 → defaultRegion；归一化 trim+upper）
  │  baseUrl = RegionRegistry.resolve(region)
  │  ├─ null → buildErrorResult(unknown region) 直接 push，不进通道、不崩节点
  │  └─ ok   → task.baseUrl = baseUrl，派发到任一空闲通道
  ▼
Channel.crawl(task)
  │  PageCrawler.crawlSingleSku(sku, page, recreateCtx, { baseUrl: task.baseUrl })
  │  搜索 URL = `${task.baseUrl}/s/${sku}`；缺省回退通道默认 baseUrl
  ▼
Pusher.buildBody ── 新增 region 回显（+ 已有 sourceUrl）→ CRAWLER_CALLBACK_URL
```

代理、换 IP、健康检查、心跳、stealth、dedup（仍按 `crawlerTaskId`，跨区域不冲突）均不进入数据流变更。

## 5. 组件改动清单

| 文件 | 改动 | 量级 |
|---|---|---|
| `src/region-registry.js`（新） | `resolve(region) → baseUrl | null`；`defaultRegion`；从配置解析映射 | ~30 行 |
| `src/cli.js` | 新增 `--regions`/`--default-region` 与 `CRAWLER_REGIONS`/`CRAWLER_DEFAULT_REGION`；`CRAWLER_BASE_URL` 保留为默认区域的兼容别名 | 小 |
| `src/poller.js` | spread 已透传 `region`，无需改动（默认区域填充放 Worker） | 0 |
| `src/worker.js` | `runTask` 入口 resolve baseUrl；未知 region 走 `buildErrorResult` 直接 push；task 事件日志补 `region` | 小 |
| `src/channel.js` | `crawl` 把 `task.baseUrl` 下传给 PageCrawler；可选记录 `lastRegion` 供 cookie 护栏 | 小 |
| `src/page-crawler.js` | `crawlSingleSku(sku, page, recreateCtx, { baseUrl })`，本次调用优先入参，回退 `this.config.baseUrl` | 小 |
| `src/pusher.js` | `buildBody` 增加 `region` 字段 | 1 行 |

无改动：`proxy-pool.js` / `cliproxy-pool.js` / `kuaidaili-client.js` / 健康检查 / 心跳 / `stealth-*`。

## 6. 任务 / 回调契约与配置

请求（上游 → 节点）：

```jsonc
{ "crawlerTaskId": 1, "sku": "ABC-001", "region": "CA" }
// region ∈ EU|CA|UK；缺省 = 节点 defaultRegion（向后兼容现行 EU 行为）
```

节点配置（权威映射，合法站点白名单）：

```bash
CRAWLER_REGIONS='EU=https://eur.vevor.com,CA=https://www.vevor.ca,UK=https://www.vevor.co.uk'
CRAWLER_DEFAULT_REGION=EU
# 兼容：CRAWLER_BASE_URL=https://eur.vevor.com  等价于把默认区域映射到该 URL
```

回调（节点 → 上游，新增 `region`）：

```jsonc
{
  "crawlerTaskId": 1, "sku": "ABC-001", "nodeCode": "crawler-01",
  "region": "CA", "sourceUrl": "https://www.vevor.ca/p/ABC-001",
  "goodsName": "…", "success": true, "errorMessage": ""
}
```

`sourceUrl` 已带真实域名，与 `region` 双重对账。

## 7. 错误处理与边界

- **未知 region**：Worker 在 `runTask` 入口判 `resolve(region) === null` → `buildErrorResult`（`status:'error'`, `error:'unknown region: XX'`）push 回上游；不进通道、不崩节点。
- **缺 region**：填 `defaultRegion`，行为与现行 EU 完全一致 → **零回归**。
- **大小写/空白**：region 归一化（trim + upper）后再查表。
- **dedup**：仍按 `crawlerTaskId`；同一 SKU 在不同区域是不同 task（不同 id），不冲突。若上游对两个区域下发同一 id 视为上游 bug，按现有去重逻辑丢弃后者。
- **跨区域 cookie/CF 串扰**（动态模型固有）：可选开关 `CRAWLER_CLEAR_COOKIES_ON_REGION_SWITCH`（默认 **关**）。开启后 `task.region !== channel.lastRegion` 时 `browserContext.clearCookies()`。默认关（YAGNI）；若实测 CF 按 IP 误伤，再开或退回 §3.2 的区域分区通道池。当前不清 `localStorage`，记为已知限制。

## 8. 风险与逃生舱

| 风险 | 现状 | 逃生舱 |
|---|---|---|
| DE 代理爬 CA/UK 被 geo/CF 拦 | §2 已实证排除 | 退回区域分区通道池（§3.2 否决项） |
| 同通道/IP 跨区域 cookie 串扰 | 默认不清 cookie，已观察无异常 | 开 `CRAWLER_CLEAR_COOKIES_ON_REGION_SWITCH` |
| 上游 region 字段拼写/取值漂移 | 未知 region 快速失败回推 | 白名单 + 对账日志 |
| 上游改下发 `baseUrl` 而非 region | 当前契约用 region 码 | §3.4 备选形态，改动收敛在 registry |

## 9. 测试策略

- 单元：`region-registry`（解析/缺省/大小写/未知）；`page-crawler` 入参 baseUrl 覆盖默认；`worker` 未知 region 走 error 分支、已知 region 下传 baseUrl；`pusher.buildBody` 含 `region`。
- 集成：`service.integration.test` 加多区域 stub（3 个 baseUrl 各返回不同 marker），断言同节点混发 EU/CA/UK 任务时 `sourceUrl` 域名正确、无串号、未知 region 任务以 error 回推且不崩。
- 真烟测（已完成，见 §2）：DE 代理节点跑 EU/CA/UK 各 3 真任务全 success。

## 10. 范围外 / 后续

- `test-sku.js` 的 `CliproxyPool` 未传 `regionParamName/asn/session/sticky` 参数，在该 `.env` 下会拿到错误出口 IP（默认 `country-DE` 被供应商忽略）。生产路径不受影响。建议另起小修复让 `test-sku.js` 与 `service.js` 代理参数一致，避免后续真站调试误判。本特性不依赖该修复。
- 如需新增第 4 区域（如 AU `www.vevor.com.au`）：仅改 `CRAWLER_REGIONS` 一处，无需代码改动（前提同样是先用 §2 烟测验证 DE 代理可达）。
