# 爬取导航重试与 headed fallback 设计

## 1. 背景与目标

当前正式服务代码（`src/page-crawler.js`）中，`page.goto` 只有一次 60 秒超时，没有显式重试。参考工作流 `vevor_crawler_workflow_v2.js` 中已经验证了 `gotoWithRetry`（3 次重试）和 headless 超时后的 headed fallback 是有效的兜底手段。

本设计目标：将类似机制引入正式服务代码，提升导航稳定性，同时与现有健康检查、代理轮换、worker 队列等机制协同工作。

## 2. 设计范围

### 2.1 本次包含

- `page.goto` 三次尝试（`gotoMaxRetries = 3`），第 1、2 次复用当前 page，第 3 次尝试时重建 context + page。
- 仅对 Timeout / 导航类错误重试，HTTP 4xx/5xx 不重试。
- 整个流程因 timeout 失败后，启动有头浏览器完整重跑一次（headed fallback）。
- 新增 `timeout` 状态。
- channel 层每处理 X 个任务后自动刷新 page（独立优化）。

### 2.2 本次不包含

- 替换现有 30 秒浏览器健康检查。
- 修改代理轮换逻辑（静态代理 / 快代理按现有逻辑继续工作）。
- 修改推送、翻译的重试逻辑（已有独立实现）。

## 3. 改动文件

| 文件 | 改动 |
|---|---|
| `src/page-crawler.js` | 新增 `gotoWithRetry()`、错误分类；替换两处裸 `page.goto` |
| `src/channel.js` | 新增 `recreateContext()`、`refreshPage()`、headed fallback 触发、任务计数 |
| `src/service.js` | 向 channel 传入 headed browser launcher 回调 |
| `bin/run.js` | 新增 `gotoMaxRetries`、`gotoTimeout`、`gotoRetryDelays`、`pageRefreshAfterTasks` 默认值 |
| `src/cli.js` | 新增对应 CLI 参数和环境变量 |
| `test/page-crawler-goto-retry.test.js` | 新增单元测试 |
| `test/channel-page-refresh.test.js` | 新增单元测试 |

## 4. 核心设计

### 4.1 错误分类

新增 `classifyGotoError(error)`，将异常分为三类：

| 类型 | 判定条件 | 处理 |
|---|---|---|
| 可重试（retryable） | 包含 `Timeout`、`timeout`、`ERR_NAME_NOT_RESOLVED`、`net::ERR`、`Navigation failed` 等 | 进入 3 次重试 |
| 不可重试（non-retryable） | HTTP 4xx/5xx、解析异常等 | 直接失败 |
| 代理错误（proxy） | `ERR_TUNNEL_CONNECTION_FAILED`、`ERR_PROXY_CONNECTION_FAILED`、`ERR_CONNECTION_RESET` | 直接上抛，由健康检查处理 |

### 4.2 goto 重试流程

```
page.goto(url, { timeout: 30000 })     // 第 1 次尝试
  ↓ 成功 → 返回
  ↓ 失败
classify(error)
  ↓ proxy 错误 → throw
  ↓ non-retryable → throw
  ↓ retryable
    attempt 2: sleep 3000ms, 复用 page, goto again
    attempt 3: sleep 6000ms, 复用 page, goto again
    attempt 4: sleep 12000ms, 重建 context + page, goto again
      ↓ 成功 → 返回
      ↓ 失败 → throw
```

说明：`gotoMaxRetries = 3` 表示最多 3 次尝试（与 `vevor_crawler_workflow_v2.js` 的 `GOTO_MAX_RETRIES` 语义一致）。

### 4.3 headed fallback 流程

仅在 `channel.crawl()` 捕获到整体 timeout 异常时触发：

1. 调用 service 提供的 `headedBrowserLauncher()` 启动有头 browser。
2. 创建新 context + page。
3. 在新 page 上完整执行 `pageCrawler.crawlSingleSku()`。
4. 关闭有头 browser。
5. 成功则返回 `success`。
6. 失败时的状态：
   - 若 headed fallback 最终仍因 timeout 失败 → `status: 'timeout'`。
   - 若因 4xx/5xx 或其他不可重试错误失败 → `status: 'error'`。

headed fallback 内部也使用 `gotoWithRetry`，但不再触发新的 headed fallback。

### 4.4 状态标记

- `success`：爬取成功（包括 headed fallback 后成功）。
- `not_found`：页面明确无结果或无法提取商品 URL。
- `sku_mismatch`：商品页 SKU 与搜索 SKU 不一致。
- `timeout`：**新增**，所有 goto 重试耗尽且 headed fallback 失败。
- `error`：其他不可重试错误（如 4xx/5xx、解析异常）。
- `success_translate_error`：爬取成功但翻译失败（现有）。

### 4.5 定期刷新 page

- 在 `Channel` 中维护 `tasksSincePageRefresh` 计数器。
- 每次 `crawl()` 结束后（无论成功失败）递增。
- 达到阈值 `pageRefreshAfterTasks`（默认 20）后，关闭当前 page，在同一 context 中创建新 page，重置计数器。
- 该机制与 goto 重试中的 context 重建独立，互不影响。

## 5. 配置项

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `gotoMaxRetries` | `3` | goto 最大尝试次数（含第 1 次） |
| `gotoTimeout` | `30000` | 单次 goto 超时（毫秒） |
| `gotoRetryDelays` | `[3000, 6000, 12000]` | 第 2/3/4 次尝试前的等待时间，长度应等于 `gotoMaxRetries` |
| `headedFallback` | `true` | 是否启用 headed fallback 兜底 |
| `pageRefreshAfterTasks` | `20` | 每处理多少个任务后刷新 page，0 表示禁用 |

## 6. 与现有机制协同

### 6.1 与 30 秒健康检查

- 健康检查继续检测 browser 断开、channel 不健康、代理失败。
- goto 重试解决单次导航抖动，不替代健康检查。
- 如果重试耗尽后仍是代理错误，健康检查下一次运行会切换代理或重启 browser。

### 6.2 与代理轮换

- `gotoWithRetry` 遇到代理错误不重试，直接上抛。
- 避免在已失效的代理上浪费 3 次重试时间。

### 6.3 与 worker 队列

- `worker.js` 捕获 `channel.crawl()` 异常后生成结果对象。
- 新增 `timeout` 状态后，worker 需要正确透传给回调上游。

## 7. 测试策略

1. **单元测试**：`test/page-crawler-goto-retry.test.js`
   - 前 2 次 timeout、第 3 次成功。
   - 3 次都 timeout 后 headed fallback 成功。
   - 4xx 错误不重试。
   - 代理错误直接上抛。

2. **单元测试**：`test/channel-page-refresh.test.js`
   - 处理 20 个任务后自动刷新 page。
   - 失败任务也计入计数。

3. **故障容忍测试**：在 `test/real/fault-tolerance-test.sh` 中补充连续 timeout 后 headed fallback 恢复场景。

## 8. 风险与回退

- **headed fallback 成本**：启动有头浏览器较慢，可能阻塞 worker 线程一段时间。建议配置开关 `headedFallback: true/false`，默认开启。
- **状态兼容性**：新增 `timeout` 状态，上游消费方需能识别。若不识别，会被当作普通错误处理，不影响现有功能。
- **默认参数激进**：30s 单次超时 + 3 次重试，最坏情况约 51s。若生产环境网络较慢，可通过环境变量调大。

## 9. 参考

- `vevor_crawler_workflow_v2.js`：`gotoWithRetry`、`crawlSingleSku` headed fallback
- `src/page-crawler.js`：现有 `crawlSingleSku` 实现
- `src/channel.js`：channel 生命周期管理
- `src/service.js`：浏览器健康检查与代理轮换
