# v1.1.9 之后更新说明（额外说明）

日期：2026-07-09
范围：自 v1.1.9 标签之后的所有 main commit
状态：未推送新镜像，工作区已包含全部更新

---

## 概述

本次更新分两批共 **14 个 commit**，聚焦两件事：

1. **task-timeout-rotate-retry**：timeout / dataLayer 异常时自动换 IP + session 重试一次；130s deadline 兜底防 renderer 卡死
2. **worker.runTask 边界清理**：deadline 后跳过白换 IP、timeout 不二次推送、清理残留字段

---

## 第一批：task-timeout-rotate-retry（10 个 commit）

### Commit 链

| SHA | 说明 |
|---|---|
| `60c6a1b` | feat(channel): add rotateProxy(reason) — worker 层主动换 IP 入口 |
| `43eab72` | fix(channel): rotateProxy 用 browserContext.browser() 而非 undefined this.browser |
| `2ce1ca0` | feat(worker): timeout/dataLayer 异常时换 IP + session 重试一次 |
| `05ecd7d` | fix(worker): catch crawl 异常后判断 retry，提取 buildErrorResult |
| `2d16bfe` | feat(config): taskTimeoutMs=130000, retryOnTimeout=true, goto/dataLayer retry 3→1 |
| `6cbd46b` | fix(config): CLI 默认值对齐，校验 taskTimeoutMs，加 env flags |
| `ffcaf50` | feat(worker): taskPromise 130s deadline — 兜底防 renderer 卡死 |
| `697cf8c` | fix(worker): deadline 触发后禁止重复 push，非 deadline 错误向上抛 |
| `d7ceb17` | fix(worker): rotateProxy 失败时保留原始 result.status |
| `de323fe` | docs(deploy): revert & 监控指引 |

### 核心行为变化

#### 重试链路

| 层级 | 变更前 | 变更后 |
|---|---|---|
| page-crawler goto retry | 3 次 | **1 次** |
| page-crawler dataLayer retry | 3 次 | **1 次** |
| worker 层换 IP 重试 | 无 | **1 次**（条件触发） |

**worker 层重试触发条件**（任一满足即触发换 IP + session + 重试一次）：

- `result.status === 'not_found'` 且 `dataLayerFailed === true` 且 `dataLayerNotFound !== true`
  - 即 dataLayer 异常（NEVER_PUSHED / MISSING / CF_CHALLENGE_UNRESOLVED）触发的 not_found
- `result.status === 'error'` 且 `error` 匹配 `/Timeout \d+ms exceeded/`
  - 即 page.goto 全部 timeout 后返回 error
- `result.status === 'timeout'`
  - 即 channel.crawl 抛出 TimeoutError 后被 catch 转译

**不触发重试**：

- 业务无结果（`dataLayerNotFound === true`，即 `result_number=0`）
- 成功（`status === 'success'`）
- 普通错误（non-timeout error）
- channel 正在重建（`channel.reinitializing === true`）
- 全局开关关闭（`CRAWLER_RETRY_ON_TIMEOUT=false`）
- 30s cooldown 期内（见下文）

#### 30s cooldown 是什么

**含义**：channel 上次换 IP 之后 **30 秒内** 不再换第二次。

**为什么需要**：

| 情况 | 不加 cooldown 的后果 |
|---|---|
| 8 个 channel 同时换 IP | cliproxy 池瞬时发新连接，可能触发限流 |
| 同一 channel 反复换 IP | 浪费 cliproxy 池配额 |
| 同一 IP 分配给多 channel | 破坏"按 Channel 独立 IP"的隔离前提 |

**代码位置**：`src/channel.js` `rotateProxy` 方法：

```js
const cooldownMs = this.config.cliproxyRotationCooldownMs || 30000;
const now = Date.now();
if (this.lastIpRotationAt > 0 && (now - this.lastIpRotationAt) < cooldownMs) {
  return { rotated: false, reason: 'cooldown' };
}
```

**默认值变更**：`cliproxyRotationCooldownMs` 从 `120000`（2 分钟）→ `30000`（30 秒）。

**具体场景示例**（crawler-2 爬 `DSYCHSDTMC21LEAON002V0`）：

| 时间 | 事件 | cooldown 影响 |
|---|---|---|
| T+0s | channel 1 第一次爬 timeout | 换 IP，记录 lastIpRotationAt |
| T+5s | channel 1 重试，仍 timeout | cooldown 期内，**不换 IP**，推 result 给上游 |
| T+35s | 又一次 timeout | 距上次换 IP 35s > 30s，**可以换 IP** |

如果 cooldown=0：channel 会在每次 timeout 时都换 IP，30 秒内可能换 3-4 次，触发 cliproxy 限流。

#### 130s deadline 兜底

**问题**：如果 renderer 卡死（`page.evaluate` / `browserContext.close` 永远不返回），`channel.crawl` 永不 resolve，`channel.busy` 永真，整个节点挂死。

**方案**：单 task 整体 crawl + retry 用 `Promise.race` 包 130s 兜底：

```js
const finishPromise = (async () => { /* crawl + retry */ })();
const deadlineTimer = setTimeout(
  () => { cancelled = true; deadlineReject(new TaskDeadlineError(130000)); },
  130000,
);
await Promise.race([finishPromise, deadlinePromise]);
```

**deadline 触发时**：

1. 强制推 timeout 给上游（即使 finishPromise 还挂着）
2. **强制释放 channel**（`channel.busy = false`），让 worker.loop 后续能找到 idle channel
3. **不调 `channel.onTaskComplete`**（避免二次卡死）
4. 清理 `inFlightTaskIds`
5. finishPromise 让它自然完成（不强行 abort，避免破坏内部状态）

### 配置变更

**新增环境变量**：

```
CRAWLER_TASK_TIMEOUT_MS=130000
CRAWLER_RETRY_ON_TIMEOUT=true
```

**新增 CLI flags**：

```
--task-timeout-ms <ms>
--retry-on-timeout / --no-retry-on-timeout
```

**新增 config 字段**：`taskTimeoutMs`, `retryOnTimeout`

**默认值变更**：

- `gotoMaxRetries`: 3 → **1**
- `dataLayerMaxRetries`: 3 → **1**
- `cliproxyRotationCooldownMs`: 120000 → **30000**

---

## 第二批：worker.runTask 边界清理（4 个 commit）

### Commit 链

| SHA | 说明 |
|---|---|
| `f9ffe48` | docs(spec): worker.runTask 边界清理设计 |
| `acfc04f` | fix(worker): deadline 后跳过 rotateProxy（不白换 IP） |
| `71c615a` | fix(worker): timeout 结果不再二次 fallback error push |
| `b0383e2` | refactor(worker): 移除未使用的 pendingPushes 残留 |

### 三处清理

#### 1. deadline 后跳过 rotateProxy

**问题**：`finishPromise` 在 crawl 结束后、正要调用 `channel.rotateProxy()` 时，如果 deadline 已经触发，仍会发起 rotateProxy，白白浪费一次 IP 轮换和浏览器重连。

**修复**：`shouldRetryWithNewIp` 通过之后、`rotateProxy` 调用之前再检查 `cancelled`：

```js
if (this.shouldRetryWithNewIp(result, channel)) {
  this.log(`[Worker] task ${task.crawlerTaskId} failed (${result.status}); rotating IP and retrying`);
  if (cancelled) {
    this.log(`[Worker] task ${task.crawlerTaskId} retry cancelled: deadline already exceeded`);
    return result;
  }
  // ... rotateProxy
}
```

#### 2. timeout 禁用 pusher fallback 二次推送

**问题**：push 失败的 catch 块无条件把结果改为 `error` 再推一次。当原始结果已经是 `timeout` 时，上游会收到 timeout + error 两个结果，状态混乱。

**修复**：catch 块先判断原始状态：

```js
} catch (e) {
  if (result.status === 'timeout') {
    // 跳过二次 fallback error push
  } else {
    // 构造 errorResult 二次推送
  }
}
```

**效果**：上游对 timeout 任务只收到一个 timeout 状态。

#### 3. 清理 pendingPushes 残留

**问题**：`Worker` 构造函数初始化了 `this.pendingPushes = new Set()`，`runTask` 里也 `delete(finishPromise)`，但从未 `add()`，且 `drain()` 不再等待它。

**修复**：删除构造函数和 runTask 资源清理段的相关代码。

---

## 测试

**核心子集**：`node --test test/worker-*.test.js test/channel-*.test.js test/page-crawler-*.test.js test/bin-run.test.js`

**结果**：**157 tests pass / 0 fail**

---

## 文件变更清单

| 文件 | 变更 |
|---|---|
| `src/channel.js` | 新增 rotateProxy 方法；maskProxyUrl helper |
| `src/worker.js` | runTask 重构 + deadline race + cancelled 守卫；移除 pendingPushes |
| `src/crawler.js` | config 加 taskTimeoutMs / retryOnTimeout |
| `src/page-crawler.js` | gotoMaxRetries / dataLayerMaxRetries 默认值 3→1 |
| `src/service.js` | initChannels 显式传 dataLayerMaxRetries |
| `src/cli.js` | 新增 --task-timeout-ms / --retry-on-timeout flags |
| `bin/run.js` | defaults 对齐，新增 timeout/retry 配置 |
| `test/channel-rotate-proxy.test.js` | 新增 8 个测试 |
| `test/worker-retry-on-timeout.test.js` | 新增 7 个测试 |
| `test/worker-deadline.test.js` | 新增 10 个测试 |
| `test/page-crawler-defaults.test.js` | 新增默认值测试 |
| `test/bin-run.test.js` | 新增 service 配置测试 |
| `docs/superpowers/specs/2026-07-08-task-timeout-rotate-retry-design.md` | 主设计文档 |
| `docs/superpowers/specs/2026-07-08-worker-runtask-cleanup-design.md` | 清理设计文档 |
| `docs/superpowers/plans/2026-07-08-task-timeout-rotate-retry.md` | 主实现计划 |
| `docs/superpowers/plans/2026-07-08-worker-runtask-cleanup.md` | 清理实现计划 |
| `部署vps.md` | 加 7.5 节回滚指引 |

---

## 部署相关

### 环境变量（生产配置）

```
CRAWLER_TASK_TIMEOUT_MS=130000
CRAWLER_RETRY_ON_TIMEOUT=true
```

### 监控指标（loki / grafana）

新增日志：

- `[Worker] rotating IP and retrying` — 每次触发换 IP 重试
- `[Worker] Task X deadline exceeded, forcing timeout result` — deadline 兜底触发
- `[Worker] rotate skipped for task X: cooldown` — 30s cooldown 内跳过
- `[Worker] Skipping fallback error push for already-timeout task X` — timeout 不二次推送

建议告警阈值：

- 换 IP 频率 > 10 次/min/channel → 检查 IP 池
- deadline 触发 > 0 次/小时 → 立即重启容器 + 检查 renderer

### 回滚方案

```bash
# 单个 commit revert
git revert <commit-sha>

# 一次性回到 v1.1.9 状态
git reset --hard <v1.1.9-tag-sha>
```

### 镜像推送

**未推送新镜像**。等生产观察 1-2 天无异常后，再打新 tag（如 `v1.2.0-task-retry`）。

---

## 已知未修复

| 问题 | 状态 |
|---|---|
| `captureDiagnostics` 期间 page 被 close 存不下诊断 | **未修**，需补 try/catch |
| `page.goto` retry 全 timeout 不存截图/HTML | **未修** |
| Playwright 协议远端断连（"Target page closed"） | **无法根除**，靠重试 + deadline 兜底 |

---

## 一句话总结

**worker 层增加一次换 IP 重试 + 130s deadline 兜底**，page-crawler 内部 retry 从 3 降到 1，业务无结果不触发重试，30s cooldown 防代理池过载。