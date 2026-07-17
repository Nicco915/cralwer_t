# 区域无结果兜底到 US 设计文档

- 日期：2026-07-17
- 背景：US 站点（www.vevor.com）已通过 `cdn_toggle_domain` Cookie 绕过 DE geo 重定向，烟测通过。
- 目标：当 UK/EU/CA 站点搜索页明确无结果时，自动到 US 站点兜底重试一次，提高数据覆盖率。

## 决策结论

1. **兜底规则**：仅对 `GB`、`EU`、`CA` 生效；当且仅当第一次爬取结果为 `not_found` 且 `error === 'Page shows no result'` 时，把 `task.baseUrl` 切换为 US 站点再爬一次。
2. **结果区域码**：`result.regionCode` 保持原请求区域（GB/EU/CA），不回传 US。
3. **实现位置**：`Worker.runTask`（Worker 层兜底），复用 `channel.crawl` 的 headed-fallback、cookie 清理与日志能力。
4. **Deadline**：全局默认 `CRAWLER_TASK_TIMEOUT_MS` 从 `130000ms` 调整为 `200000ms`，兜底不单独动态延长。
5. **US 内置启用**：`RegionRegistry` 内置 `US` 从空字符串（禁用）改为 `https://www.vevor.com`。

## 触发条件

在 `Worker.runTask` 第一次 `channel.crawl(task)` 返回后，必须同时满足：

- `task.regionCode ∈ { 'GB', 'EU', 'CA' }`
- `result.status === 'not_found'`
- `result.error === 'Page shows no result'`
- `regionRegistry.resolve('US') !== null`（US 站点可被解析）

满足以上条件时，执行：

```js
const fallbackRegion = 'US';
const fallbackBaseUrl = this.regionRegistry.resolve(fallbackRegion);
if (fallbackBaseUrl) {
  task.baseUrl = fallbackBaseUrl;
  result = await channel.crawl(task);
  // result.regionCode 保持 task.regionCode（原区域）
}
```

## 关键行为约定

| 项目 | 约定 |
|---|---|
| 兜底次数 | 最多一次；US 自身不在兜底集合中 |
| regionCode | 全程保持原请求区域码（GB/EU/CA） |
| baseUrl | 仅临时改为 US URL，用于第二次 crawl |
| Cookie | 依赖 `injectGeoBypassCookie` 在访问 `www.vevor.com` 时自动注入 `cdn_toggle_domain=1`；`Channel` 按 `task.regionCode` 判断，不会因为 baseUrl 变化误清 cookie |
| 日志 | 记录 `[Worker] task ${id} page shows no result on ${region}, falling back to US` |
| Deadline | 不动态延长；全局默认从 130s 提高到 200s |

## 需要修改的文件

### 1. `src/region-registry.js`

```js
const BUILT_IN_REGIONS = {
  EU: 'https://eur.vevor.com',
  GB: 'https://www.vevor.co.uk',
  CA: 'https://www.vevor.ca',
  US: 'https://www.vevor.com',   // 变更：重新启用
  CN: '',
};
```

同步更新文件顶部注释，说明 US 已通过 Cookie 绕过 DE geo 重定向。

### 2. `src/worker.js`

新增常量：

```js
const NO_RESULT_FALLBACKS = {
  GB: 'US',
  EU: 'US',
  CA: 'US',
};
```

在 `runTask` 的 `finishPromise` 中，第一次 crawl 返回后、进入换 IP 重试逻辑前，插入兜底判断：

```js
if (result && result.status === 'not_found' && result.error === 'Page shows no result') {
  const fallbackRegion = NO_RESULT_FALLBACKS[task.regionCode];
  if (fallbackRegion && this.regionRegistry) {
    const fallbackBaseUrl = this.regionRegistry.resolve(fallbackRegion);
    if (fallbackBaseUrl) {
      this.log(`[Worker] task ${task.crawlerTaskId} page shows no result on ${task.regionCode}, falling back to ${fallbackRegion}`);
      task.baseUrl = fallbackBaseUrl;
      try {
        result = await channel.crawl(task);
        this.log(`[Worker] Fallback crawl finished task ${task.crawlerTaskId} status ${result.status}`);
      } catch (fallbackErr) {
        this.log(`[Worker] Fallback crawl failed task ${task.crawlerTaskId}: ${fallbackErr.message}`);
        result = this.buildErrorResult(task, fallbackErr);
      }
    }
  }
}
```

### 3. 默认超时调整

将默认 `taskTimeoutMs` 从 `130000` 改为 `200000`：

- `src/worker.js` 默认值
- `src/cli.js` 默认值
- `src/crawler.js` 默认值

环境变量 `CRAWLER_TASK_TIMEOUT_MS` 仍可覆盖。

### 4. 测试

新增 / 扩展 `test/worker-region.test.js`：

- `GB` 页面无结果 → fallback 到 US，且 `result.regionCode === 'GB'`。
- `EU`、`CA` 同理。
- US 自身无结果 → 不触发无限兜底。
- `No product URL found` / CF 挑战 / SKU mismatch 等错误 → 不触发兜底。
- 当 US 在 `RegionRegistry` 中被禁用时 → 不触发兜底。

### 5. 部署配置示例

更新以下文件中的注释和示例，移除“US 禁用”说明，并展示包含 US 的 `CRAWLER_REGIONS`：

- `scripts/deploy/windows/native/.env.example`
- `scripts/deploy/windows/docker/.env.example`
- `deployment/windows/ecosystem.canada.config.js`（在 `makeApp` 的 `env` 或新增 `SHARED_REGIONS` 中显式注入）

示例：

```bash
CRAWLER_REGIONS='EU=https://eur.vevor.com,GB=https://www.vevor.co.uk,CA=https://www.vevor.ca,US=https://www.vevor.com'
CRAWLER_DEFAULT_REGION=EU
```

## 数据流示例

```
上游 task: { regionCode: 'GB', sku: 'ABC' }
           ↓
Worker: resolve GB → https://www.vevor.co.uk
           ↓
channel.crawl → PageCrawler: 搜索页显示 "no result"
           ↓
Worker 判断: GB ∈ 兜底表 && error === 'Page shows no result'
           ↓
task.baseUrl = resolve('US') → https://www.vevor.com
           ↓
channel.crawl → PageCrawler: US 站点有结果
           ↓
result.regionCode = 'GB'（保持不变） → pusher
```

## 边界情况

| 场景 | 处理 |
|---|---|
| US 站点也无结果 | 返回 US 的 `not_found`，不再兜底 |
| error 不是 `Page shows no result` | 不触发兜底，走原有换 IP / 超时逻辑 |
| deadline 已触发 | 不触发兜底，直接返回原结果 |
| US 被 env 禁用 | `regionRegistry.resolve('US')` 为 null，不兜底 |
| 第一次 crawl 已抛错 / timeout | 不触发兜底 |
| 上游区域码为 UK | 上游实际使用 GB，无需别名处理 |

## 兼容性

- 对现有非兜底任务零影响。
- `CRAWLER_TASK_TIMEOUT_MS` 调高后，单任务整体耗时上限增加；若上游有自己更短的超时，以上游为准。
- `result.regionCode` 保持原区域，上游无需修改解析逻辑。
