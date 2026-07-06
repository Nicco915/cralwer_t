# Cloudflare Challenge 触发代理/指纹旋转 — 设计文档

日期：2026-07-06  
状态：用户批准（方案 A：`not_found` + `cfChallengeFailed` 标记）

## 背景

VEVOR 爬虫目前在 Cloudflare challenge 拦截时会原地等 `cloudflareMaxWait`（默认 45 秒），超时后仅把任务记为 error，不触发代理或 fingerprint 旋转。这导致：

- 已被 Cloudflare 标记的 IP/指纹组合继续被反复使用；
- 同一通道下次任务仍然会被 CF 挑战拦截；
- 上游 callback 收到 `error` 但无法区分"网络错误" vs "反爬拦截"。

近 3 小时观察显示 crawler-3 在一次 CF 触发后，因为容器切换了上下文（指纹/IP 改变），后续任务又恢复正常，**说明一旦换掉被标记的 IP/指纹组合就能恢复**。我们要把这个"换"自动化。

## 目标

让 Cloudflare challenge 30s 内未通过时，自动触发现有的代理旋转路径（换 IP），并在 `adaptive` stealth 模式下被记入 fingerprint 切换条件。同时把失败信号通过 `cfChallengeFailed` 标记暴露给上层，便于诊断。

## 非目标

- 不引入新的旋转 counter（继续复用 `dataLayerProxyRotationThreshold`）。
- 不实现真正的 CF 自动验证（保留 `waitForCloudflare` 行为不变）。
- 不改变 success / not_found / error 的 callback 协议语义，只在 result 上加可选的 `cfChallengeFailed` 字段。

## 设计

### 行为变更

`page-crawler.crawlSingleSku` 中两处"CF 未通过"分支（搜索结果页 L348-355、产品详情页 L396-403）统一改为：

```
if (passed === false) {
  try {
    await captureDiagnostics(page, sku, 'cf-challenge', this.config.diagnosticDir);
  } catch (diagErr) { ... }
  result.status = 'not_found';
  result.error = 'CF_CHALLENGE_UNRESOLVED';
  result.dataLayerFailed = true;
  result.cfChallengeFailed = true;
  return result;
}
```

要点：

1. `status='not_found'` 沿用上游 callback 协议里"我找不到这个 SKU"的语义，对应"页面被反爬挡住、无法确认商品是否存在"。
2. `error='CF_CHALLENGE_UNRESOLVED'` 是一个明确字符串，便于上层匹配和日志检索。
3. `dataLayerFailed=true` 让现有 `Channel.crawl()` 的 dataLayer-error 分支自动把计数计入 `dataLayerFailureCount`，触发代理旋转（复用 `dataLayerProxyRotationThreshold`）。
4. `cfChallengeFailed=true` 是新增的可选字段，让上层调用方（和未来可能的运维 dashboard）能区分 CF 失败和纯 dataLayer 提取失败。

### 触发链

```
page-crawler.crawlSingleSku  (CF wait → false)
  └── result { status: 'not_found', dataLayerFailed: true, cfChallengeFailed: true }
        │
        ▼
channel.crawl() catch → "DATA_LAYER_NEVER_PUSHED|DATA_LAYER_MISSING|CF_CHALLENGE_UNRESOLVED"
  └── dataLayerFailureCount += 1
        │
        ▼
onTaskComplete → service.checkChannelForRotation
  └── channel.needsProxyRotation() === true
        └── proxyPool.nextForChannel(channelId) → 换 IP → channel.reinit
```

`adaptive` stealth 模式下，`updateAdaptiveState(result.status, ..., result.dataLayerFailed=true)` 已经把 CF 失败计入 `consecutiveTimeouts`，连续 N 次后自动从 channel 切到 session，再连续失败就触发 rotation。**这一路径零新增代码即可工作**。

### 复用现有配置

| 配置 | 现有值 | 用途 |
|---|---|---|
| `CRAWLER_DATA_LAYER_PROXY_ROTATION_THRESHOLD` | 1 | 1 次 CF 失败就旋转代理（默认行为，无需改动） |
| `CRAWLER_DATA_LAYER_FAILURE_THRESHOLD` | 3 | 触发 WARNING 日志，连同 dataLayer 失败一起 |
| `CRAWLER_CLIPROXY_ROTATION_COOLDOWN_MS` | 120000 | 旋转后冷却 120 秒，避免频繁换 IP |
| `CRAWLER_CLOUDFLARE_MAX_WAIT` | 45 | 单个任务等待 CF 时间（保持现状） |

**不新增配置项**。如果将来需要把 CF 旋转条件从 dataLayer 失败里独立出来，再引入 `CRAWLER_CF_PROXY_ROTATION_THRESHOLD`。

### 修改文件清单

| 文件 | 改动 |
|---|---|
| `src/page-crawler.js` | 修改 CF 未通过分支（搜索/详情两处）：返回 `not_found` + `dataLayerFailed` + `cfChallengeFailed`，调用 `captureDiagnostics` |
| `src/channel.js` | `crawl()` catch 块中扩展 dataLayer-error 识别：`/^(DATA_LAYER_NEVER_PUSHED\|DATA_LAYER_MISSING\|CF_CHALLENGE_UNRESOLVED)/` |
| `test/page-crawler-cf-rotation.test.js` | 新增：mock `page` 让 `isCloudflareChallenge === true` 且 `waitForCloudflare` 超时 → 验证返回字段正确、调用了 captureDiagnostics |
| `test/channel-cf-rotation.test.js` | 新增：CF 错误抛出 → `dataLayerFailureCount += 1` → `needsProxyRotation === true` |
| `deployment/crawlab/.env.example` | 在 `CRAWLER_DATA_LAYER_PROXY_ROTATION_THRESHOLD` 处加注释：本阈值同时适用于 Cloudflare challenge 失败的代理旋转 |

### 测试要点

新增两个测试文件，3-5 用例即可。验证：

1. **page-crawler**：
   - CF 30s 超时后返回 `{ status: 'not_found', error: 'CF_CHALLENGE_UNRESOLVED', dataLayerFailed: true, cfChallengeFailed: true }`。
   - 调用了 `captureDiagnostics(page, sku, 'cf-challenge', dir)`。
   - 没有 CF 时旧路径不受影响（regression test）。

2. **channel**：
   - `crawlSingleSku` 抛 `CF_CHALLENGE_UNRESOLVED` → `dataLayerFailureCount === 1` 且 `needsProxyRotation === true`。
   - 不抛给上层；返回 `result.status === 'not_found'`。
   - 不影响非 CF 错误的行为（regression test）。

3. **regression**：dataLayer 已经存在的 5-6 个 channel 测试 + page-crawler 测试全部应保持绿灯。

## 错误处理

- **诊断失败**：`captureDiagnostics` 抛错已经在原代码里有 try/catch 包住，不影响主流程。
- **代理旋转失败**：由 `service.checkChannelForRotation` 现有的 try/catch 兜底，最终 fallback 是 `restartBrowser`。
- **诊断目录未配置**：`diagnosticDir` 为空时 `captureDiagnostics` 应快速返回（已实现，保持现状）。

## 风险评估

| 风险 | 缓解 |
|---|---|
| CF 计数和 dataLayer 失败共享同一 counter，可能误把短暂 CF 抖动当成持续 IP 污染 | 现有 `cliproxyRotationCooldownMs=120000` 已经限制换 IP 频率；观察 1-2 天看是否需要拆分 |
| 上游看到 status='not_found' 而不是 'error'，影响统计口径 | CF 失败确实没拿到商品信息，语义上"找不到"是准确的；error 字段保留 `CF_CHALLENGE_UNRESOLVED` 便于过滤 |
| 诊断文件激增 | 现有 cooldown + rotation 机制已经限制触发频率；和 dataLayer 失败的总量在同一量级 |

## 验收标准

1. `npm test` 全部通过。
2. 部署到一台 crawler，先观察 24 小时：
   - 触发 CF challenge 的任务 `dataLayerFailureCount` 自动递增。
   - 必要时 `proxyPool.nextForChannel` 被调用，通道指纹/IP 切换。
   - 日志出现 `[CF] cf-challenge diagnostic captured` 和 `[SERVICE] Channel X has Y consecutive dataLayer failures, rotating proxy`。
3. 不引入新配置；`deployment/crawlab/.env.example` 仅注释更新。

## 参考代码

- `src/page-crawler.js:90-107` — `waitForCloudflare` 实现
- `src/page-crawler.js:323-355` — `crawlSingleSku` 中搜索阶段 CF 分支
- `src/page-crawler.js:395-403` — `crawlSingleSku` 中产品阶段 CF 分支
- `src/page-crawler.js:139, 181` — `captureDiagnostics` 调用样例
- `src/channel.js:268-298` — dataLayer 失败识别与计数
- `src/service.js:394-433` — `checkChannelForRotation` 旋转逻辑
