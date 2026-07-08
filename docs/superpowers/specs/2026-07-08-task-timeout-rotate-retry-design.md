# 任务超时换 IP 重试 + 整体 Deadline 保护 — 设计文档

日期：2026-07-08
状态：用户批准

## 背景

VEVOR 爬虫在 IP 被反爬标记时，单个任务会出现"内部 retry 全部 timeout"或"dataLayer 提取失败"等强信号失败。当前行为：

1. `page-crawler.crawlSingleSku` 内部 `gotoMaxRetries=3` + `dataLayerMaxRetries=3` = **最多 9 次同 IP 网络请求**，全部失败后才放弃
2. 失败后仅由 `service.checkChannelForRotation`（每 30s health check 或 task 完成回调触发）做"换 IP"决策
3. 决策依赖 `dataLayerFailureCount >= dataLayerProxyRotationThreshold`（默认 2）—— **必须连续失败 2 次**才换 IP
4. 如果 renderer 卡死（`page.evaluate` / `browserContext.close` 永远不返回），`channel.crawl` 永不 resolve，`channel.busy` 永真，整个节点挂死

生产观察（crawler-2 SKU `DSYCHSDTMC21LEAON002V0`）显示：
- 第 1 次 `page.goto` timeout 30s
- `page-crawler` 内部 retry：第 2 次 timeout 30s
- 第 3 次 `Recreating context`（= `browserContext.close()` + 新建 context + 新 page，**同一 IP**），之后 `page.waitForFunction` 失败 `Target page has been closed`（因为 context 重建时旧 page 被关了）
- 最终 channel.busy 永真，下游 task 全部 queue 堆积

## 目标

1. **缩短同 IP 重试次数**：page-crawler 内部 retry 从 3 次降到 1 次，确认 IP 有问题后立即换 IP
2. **加 worker 层换 IP 重试**：单次任务失败触发条件满足时，换 IP + session + recreate context 后重试一次
3. **加整体 deadline**：单 task 兜底 130s 超时，防止 renderer 卡死导致 channel 永久 busy
4. **保持现有健康检查路径**：service.healthCheck + isHealthy 5s timeout 保留，新增保护不取代它们

## 非目标

- 不引入新的全局重试计数器（先实现单 task 单次重试，监控后决定是否调高）
- 不强行 kill chrome 进程（renderer 卡死由 service.restartBrowser 处理）
- 不把 headed fallback 纳入重试（太重，channel 健康就别换 IP）
- 不修改 `lastIpRotationAt` cooldown 行为（worker 层重试尊重 30s cooldown，避免短时间密集换 IP）

## 设计

### 重试触发条件（worker.runTask）

worker.runTask 在第一次 `channel.crawl(task)` 返回后判断，**仅在以下条件全部满足时**触发换 IP 重试：

1. `result.status === 'not_found'` 且 `result.dataLayerFailed === true` 且 `result.dataLayerNotFound !== true`
   - 即：dataLayer 异常（NEVER_PUSHED / MISSING / CF_CHALLENGE_UNRESOLVED）触发的 not_found
   - 业务无结果（result_number=0）**不触发**——已在 commit 0df1b7e 修复

2. `result.status === 'error'` 且 `result.error` 匹配 `/Timeout \d+ms exceeded/`
   - 即：page.goto 全部 timeout 后返回 error

3. `result.status === 'timeout'`
   - 即：channel.crawl 抛出 TimeoutError 后被 catch 转译的 result

4. `!channel.reinitializing`
   - 如果 channel 正在被 service 层重建（health check 触发），不重复换 IP

5. `this.retryOnTimeout !== false`（默认 true）
   - 全局开关，紧急情况可一键关掉

### 行为变更：page-crawler.js 默认值

```diff
- gotoMaxRetries: 3
+ gotoMaxRetries: 1

- dataLayerMaxRetries: 3
+ dataLayerMaxRetries: 1
```

**保留** `gotoRetryDelays` 机制（用户配置），让内部 1 次 retry 留 ~5s 抖动窗口。

**影响**：单个 IP 最多 `1×goto + 1×dataLayer = 2 次` 网络请求，确认 IP 有问题后立即换 IP。VEVOR 反爬失败模式是"整 IP 被拦"而非"网络抖动"，2 次是确认信号甜点。

### 行为变更：channel.rotateProxy(reason)

新增方法，签名：

```js
async rotateProxy(reason)
// reason: string 标识调用方（'task-timeout' / 'health-check' 等），仅用于日志
// returns: { rotated: boolean, reason: 'success' | 'cooldown' | 'reinitializing' | 'no_pool' | 'error', error?: string }
```

实现逻辑：

```
1. if (this.reinitializing) → return { rotated: false, reason: 'reinitializing' }
2. 检查 lastIpRotationAt + cliproxyRotationCooldownMs（默认 30000ms）
   if 在 cooldown 内 → return { rotated: false, reason: 'cooldown' }
3. if (!this.proxyPool) → return { rotated: false, reason: 'no_pool' }
4. try:
     this.reinitializing = true
     const newProxy = await this.proxyPool.nextForChannel(`ch-${this.id}`)
     await this.reinit(this.browser, newProxy)
     this.recordIpRotation()
     return { rotated: true, reason: 'success' }
   catch:
     log error → return { rotated: false, reason: 'error', error: e.message }
   finally:
     this.reinitializing = false
```

**与已有 `maybeTriggerReinstall` 的关系**：`maybeTriggerReinstall` 是 "cooldown 内失败时由 DATA_LAYER_* 路径调用的快速 reinstall 尝试"，设计意图不同；`rotateProxy` 是 "worker 层主动换 IP"。两者并存，`maybeTriggerReinstall` 不修改。

**与已有 `checkChannelForRotation` 的关系**：service 层换 IP 用 `proxyPool.nextForChannel` + `channel.reinit`（service.js:471-476）；worker 层 `rotateProxy` 复用同一路径，封装在 channel 内部，**保留** service 层路径不变（不动 service.js）。

### 行为变更：worker.runTask

新的执行流程：

```js
async runTask(task, channel) {
  const taskIdKey = this.getTaskIdKey(task);
  const startedAt = Date.now();
  channel.busy = true;

  // 第一次 crawl
  let result;
  try {
    result = await channel.crawl(task);
  } catch (e) {
    result = {
      crawlerTaskId: task.crawlerTaskId,
      sku: task.sku,
      status: e.status ?? 'error',
      product_name: '',
      features_details: '',
      product_specification: '',
      product_url: '',
      error: e.message,
    };
  }

  // 重试前置（仅一次）
  if (this.shouldRetryWithNewIp(result, channel)) {
    this.log(`[Worker] task ${task.crawlerTaskId} failed (${result.status}/${result.error}); rotating IP and retrying`);
    const rotated = await channel.rotateProxy('task-timeout');
    if (rotated.rotated) {
      try {
        result = await channel.crawl(task);
      } catch (e) {
        result = {
          crawlerTaskId: task.crawlerTaskId,
          sku: task.sku,
          status: e.status ?? 'error',
          error: e.message,
          product_name: '',
          features_details: '',
          product_specification: '',
          product_url: '',
        };
      }
    } else {
      this.log(`[Worker] rotate skipped for task ${task.crawlerTaskId}: ${rotated.reason}`);
    }
  }

  // 推送 + 资源清理（deadline 包整个 finishTask）
  return this.finishTask(task, channel, result, startedAt, taskIdKey);
}
```

`shouldRetryWithNewIp` 是纯函数 helper：

```js
shouldRetryWithNewIp(result, channel) {
  if (this.retryOnTimeout === false) return false;
  if (channel.reinitializing) return false;
  if (!result) return false;

  // dataLayer 异常触发的 not_found（业务无结果已排除）
  if (result.status === 'not_found' && result.dataLayerFailed === true && result.dataLayerNotFound !== true) {
    return true;
  }

  // page.goto timeout
  if (result.status === 'error' && /Timeout \d+ms exceeded/.test(result.error || '')) {
    return true;
  }

  // crawl 抛 TimeoutError 后被转译
  if (result.status === 'timeout') {
    return true;
  }

  return false;
}
```

### 行为变更：worker.finishTask（deadline 保护）

新增 `finishTask` 方法，包裹 deadline + pusher + imageUploader + 资源清理：

```js
async finishTask(task, channel, result, startedAt, taskIdKey) {
  let timedOut = false;
  let finalResult = result;

  // 推送 + imageUpload + 清理的内部 promise
  const finishPromise = (async () => {
    try {
      this.log(`[Worker] Starting push task ${task.crawlerTaskId} sku ${task.sku} status=${result.status}`);
      await this.pusher.push(result);
      // ... image upload, log, busy=false, inFlight.delete, onTaskComplete
    } catch (e) {
      // ... existing push error fallback
    }
  })();

  // Deadline: 整个 finishTask 不超过 taskTimeoutMs
  const taskTimeoutMs = this.config?.taskTimeoutMs || 130000;
  const deadlinePromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Task deadline ${taskTimeoutMs}ms exceeded`)), taskTimeoutMs)
  );

  try {
    await Promise.race([finishPromise, deadlinePromise]);
  } catch (deadlineErr) {
    if (deadlineErr.message.startsWith('Task deadline')) {
      timedOut = true;
      this.log(`[Worker] Task ${task.crawlerTaskId} deadline exceeded, forcing timeout result`);
      finalResult = {
        crawlerTaskId: task.crawlerTaskId,
        sku: task.sku,
        status: 'timeout',
        product_name: '',
        features_details: '',
        product_specification: '',
        product_url: '',
        error: deadlineErr.message,
      };
      // 强制推一次 timeout 给上游（即使 finishPromise 还挂着）
      try {
        await this.pusher.push(finalResult);
      } catch (pushErr) {
        this.log(`[Worker] Failed to push timeout result: ${pushErr.message}`);
      }
    }
  }

  // 清理（即使 deadline 触发也必须执行）
  if (timedOut) {
    channel.busy = false;  // 强制释放，避免永久 busy
    if (taskIdKey !== null) this.inFlightTaskIds.delete(taskIdKey);
    // 注意：timedOut 时不调 channel.onTaskComplete，避免触发可能卡死的健康检查
  } else {
    // finishPromise 的 finally 会处理 busy=false + inFlight.delete + onTaskComplete
    // 这里只是兜底，确保即使 finishPromise 漏清理也补上
    channel.busy = false;
    if (taskIdKey !== null) this.inFlightTaskIds.delete(taskIdKey);
  }

  // ... existing logger.info('task', 'finished', { ...timedOut })
  return finalResult;
}
```

**关键决策**：
- deadline 触发时**强制推 timeout 给上游**——绝不让上游悬挂
- deadline 触发时**不调 `channel.onTaskComplete`**——避免二次卡死（onTaskComplete 会调 isHealthy / proxyPool 等）
- deadline 触发时**强制 `channel.busy = false`**——让 worker.loop 后续能找到 idle channel
- deadline 触发后**不强行 kill finishPromise**——让它自然完成（避免破坏内部状态），但 worker 层不再等它

### Config 变更

`src/crawler.js`：

```js
// 新增
const TASK_TIMEOUT_MS = parseInt(process.env.CRAWLER_TASK_TIMEOUT_MS, 10) || 130000;
const RETRY_ON_TIMEOUT = process.env.CRAWLER_RETRY_ON_TIMEOUT !== 'false';  // 默认 true

// 在 config 对象里传递
config.taskTimeoutMs = TASK_TIMEOUT_MS;
config.retryOnTimeout = RETRY_ON_TIMEOUT;
```

`src/page-crawler.js` 默认值：

```js
this.gotoMaxRetries = options.gotoMaxRetries !== undefined ? options.gotoMaxRetries : 1;  // 原本 3
this.dataLayerMaxRetries = options.dataLayerMaxRetries !== undefined ? options.dataLayerMaxRetries : 1;  // 原本 3
```

**注意**：channel 构造时显式传 `dataLayerMaxRetries: 1`（service.js initChannels）。

## 数据流

```
worker.runTask(task, channel)
  │
  ├─ channel.crawl(task) ─→ result1
  │     │
  │     └─ page-crawler: goto(1) + retry(1) = 2 次同 IP 请求
  │     └─ page-crawler: dataLayer extract + retry(1) = 2 次 dataLayer 等待
  │     └─ 若全部 timeout → result1.status='not_found'/error, dataLayerFailed=true
  │
  ├─ shouldRetryWithNewIp(result1) === true?
  │     │
  │     ├─ yes → channel.rotateProxy('task-timeout')
  │     │     ├─ cooldown 检查
  │     │     ├─ proxyPool.nextForChannel + channel.reinit + recordIpRotation
  │     │     └─ return { rotated: true } / { rotated: false, reason: ... }
  │     │
  │     └─ if rotated → channel.crawl(task) ─→ result2
  │
  ├─ worker.finishTask(task, channel, finalResult, ...)
  │     ├─ Promise.race([finishPromise, 130s deadline])
  │     ├─ finishPromise: pusher.push + imageUploader + log + busy=false + onTaskComplete
  │     └─ deadline 触发时: 推 timeout + 强制 busy=false + 不调 onTaskComplete
  │
  └─ return finalResult
```

## 错误处理

| 场景 | 行为 |
|---|---|
| rotateProxy 返回 `{ rotated: false, reason: 'cooldown' }` | 直接推 result1 给上游；不重试 |
| rotateProxy 返回 `{ rotated: false, reason: 'reinitializing' }` | 直接推 result1 给上游；service 层在重建 |
| rotateProxy 返回 `{ rotated: false, reason: 'no_pool' }` | 直接推 result1 给上游 |
| rotateProxy 返回 `{ rotated: false, reason: 'error', error: '...' }` | 直接推 result1 给上游；log error |
| 第 2 次 crawl 仍 timeout | 推 result2 给上游（带 timeout 标记）；不再换 IP |
| 第 2 次 crawl 抛异常 | 转译为 result2.status='error' 后推 |
| deadline 触发时 finishPromise 还在 | 强制推 timeout；finishPromise 自然完成；不强制 abort（避免破坏内部状态） |
| deadline 触发时 pusher.push 已失败重试中 | deadline 内 try-catch 吞掉错误；log 失败；不影响上游 |

## 测试

### test/channel-rotate-proxy.test.js（新）

| 用例 | 验证 |
|---|---|
| 换 IP 成功 | proxyPool.nextForChannel + channel.reinit + recordIpRotation 被调用，返回 `{ rotated: true, reason: 'success' }` |
| cooldown 内拒绝 | lastIpRotationAt 在 10s 前，cooldown=30s，返回 `{ rotated: false, reason: 'cooldown' }`，不调 proxyPool |
| cooldown 刚过 | lastIpRotationAt 在 31s 前，返回 `{ rotated: true, reason: 'success' }` |
| reinitializing 时跳过 | channel.reinitializing=true，返回 `{ rotated: false, reason: 'reinitializing' }` |
| 无 proxyPool | this.proxyPool=null，返回 `{ rotated: false, reason: 'no_pool' }` |
| proxyPool.nextForChannel 抛错 | catch error，返回 `{ rotated: false, reason: 'error', error: '...' }` |
| channel.reinit 抛错 | catch error，返回 `{ rotated: false, reason: 'error', error: '...' }` |
| finally 释放 reinitializing | 异常路径后 channel.reinitializing=false |

### test/worker-retry-on-timeout.test.js（新）

| 用例 | 验证 |
|---|---|
| 数据无结果 + dataLayerFailed + dataLayerNotFound=true | **不调** rotateProxy（白名单跳过） |
| dataLayer 异常 + dataLayerNotFound=false | 调 rotateProxy，rotated=true 后第 2 次 crawl 推 result2 |
| page.goto 全 timeout (status=error, error 匹配 regex) | 调 rotateProxy |
| crawl 抛 TimeoutError (status=timeout) | 调 rotateProxy |
| rotate 返回 cooldown | 不重试，推 result1 |
| rotate 返回 error | 不重试，推 result1 |
| rotate 返回 reinitializing | 不重试，推 result1 |
| retryOnTimeout=false | 任何情况都不调 rotateProxy |
| 第二次 crawl 抛异常 | 转译为 result2，推给上游 |
| shouldRetryWithNewIp 各分支 | 纯函数单测，覆盖 true/false 全部分支 |

### test/worker-deadline.test.js（新）

| 用例 | 验证 |
|---|---|
| 正常完成（finishPromise < 130s） | deadline 不触发；onTaskComplete 正常调用 |
| finishPromise 超时（mock sleep 200s） | deadline 触发；pusher.push 收到 timeout result |
| deadline 触发后 channel.busy=false | 强制释放，验证后续 task 能分配到 channel |
| deadline 触发后不调 onTaskComplete | mock onTaskComplete 不被调用 |
| deadline 触发后 inFlightTaskIds 清理 | taskIdKey 被 delete |
| deadline 触发时 pusher.push 失败 | log error；不影响 |
| taskTimeoutMs 配置生效 | 自定义 5s 后 deadline 触发 |

### test/integration.test.js（可选，新）

端到端集成测试：用真实 channel + page-crawler mock，触发"换 IP → 重试 → 成功"完整流程。**优先级低**，先单测覆盖逻辑。

## 风险评估

| 风险 | 量化 | 缓解 |
|---|---|---|
| 频繁换 IP 触发 cliproxy 限流 | 8 channel × 偶尔重试 ≈ 几十次/小时，远低于任何合理限流 | 30s cooldown 兜底 |
| 误判导致正常 SKU 被换 IP | 触发条件全是"goto 全 timeout / dataLayer 异常"强信号 | 监控换 IP 频率告警 |
| 死循环 | 重试上限 1，130s deadline | 第二次仍失败直接推 not_found |
| deadline 触发后 finishPromise 仍持有资源 | 不强制 abort | renderer 由 service.restartBrowser 兜底 |
| 30s cooldown 让 worker 重试被频繁跳过 | cooldown 内仍走 result1（不是丢任务） | 监控 cooldown 触发比例 |
| page-crawler retry 从 3 降到 1 可能漏抓抖动 SKU | 网络抖动场景损失 1 个有效 SKU | gotoRetryDelays 配置；监控换 IP 后立刻 timeout 比例 |

## 文件变更

| 文件 | 变更 |
|---|---|
| `src/worker.js` | runTask 重构 + finishTask 新增 + shouldRetryWithNewIp helper |
| `src/channel.js` | rotateProxy 新增方法 |
| `src/crawler.js` | config 加 taskTimeoutMs / retryOnTimeout |
| `src/page-crawler.js` | gotoMaxRetries / dataLayerMaxRetries 默认值 3→1 |
| `src/service.js` | initChannels 显式传 dataLayerMaxRetries=1 |
| `test/channel-rotate-proxy.test.js` | 新增 |
| `test/worker-retry-on-timeout.test.js` | 新增 |
| `test/worker-deadline.test.js` | 新增 |
| `部署vps.md` | 加 revert 说明 + 监控项 |

## 部署 & 回滚

### 配置（环境变量）

```
CRAWLER_TASK_TIMEOUT_MS=130000
CRAWLER_RETRY_ON_TIMEOUT=true
```

### 监控（loki / grafana）

新增指标：
- `[Worker] rotating IP and retrying` 出现频率（每分钟）
- `Task deadline exceeded` 出现频率（每分钟）
- `rotate skipped for task ... cooldown` 出现频率（每分钟）

告警阈值（建议）：
- 换 IP 频率 > 10 次/min/channel → 检查 IP 池
- deadline 触发 > 0 次/小时 → 立即重启容器 + 检查 renderer

### Revert 步骤

```bash
# 单个 commit revert（按提交时间倒序）
git revert <deadline-commit-sha>
git revert <rotate-proxy-commit-sha>
git revert <worker-retry-commit-sha>
git revert <config-commit-sha>

# 或者一次 revert 到 65a53b0（当前 main HEAD 之前）
git reset --hard 65a53b0
# ⚠️ 强制推送会丢失中间 commit，需团队确认
```

### 不推送镜像

所有 commit 在 working tree，**不推送新镜像**。等生产观察 1-2 天无异常后，再打新 tag（如 `v1.2.0-task-retry`）。