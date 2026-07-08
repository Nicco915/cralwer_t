# 任务超时换 IP 重试 + 整体 Deadline 保护 — 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** VEVOR 爬虫在 IP 被反爬标记时自动换 IP 重试一次，并对单 task 施加 130s 整体 deadline 防 renderer 卡死导致 channel 永久 busy。

**架构：** page-crawler 内部 retry 3→1 + worker 层加 retry 前置（rotateProxy + 第 2 次 crawl）+ worker 层加 taskPromise 130s deadline 兜底。

**技术栈：** Node.js, Playwright, node:test 框架, 已有 CliproxyPool / KuaidailiClient / channel / worker / service 模块。

**规格文档：** `docs/superpowers/specs/2026-07-08-task-timeout-rotate-retry-design.md`

**分支约定：** 在 `main` 上继续提交新 commit，不开新分支（用户已确认）。所有 commit 在 working tree，**不推送镜像**。

---

## 文件结构

| 文件 | 职责 | 类型 |
|---|---|---|
| `src/worker.js` | runTask 加 retry 前置逻辑；新增 finishTask 包裹 deadline | 修改 |
| `src/channel.js` | 新增 rotateProxy(reason) 方法 | 修改 |
| `src/crawler.js` | config 加 taskTimeoutMs / retryOnTimeout | 修改 |
| `src/page-crawler.js` | gotoMaxRetries / dataLayerMaxRetries 默认值 3→1 | 修改 |
| `src/service.js` | initChannels 显式传 dataLayerMaxRetries=1 | 修改 |
| `test/channel-rotate-proxy.test.js` | rotateProxy 单元测试 | 新增 |
| `test/worker-retry-on-timeout.test.js` | runTask retry 逻辑单测 | 新增 |
| `test/worker-deadline.test.js` | finishTask deadline 行为单测 | 新增 |
| `部署vps.md` | 加 revert 说明 + 监控项 | 修改 |

---

## 任务执行顺序

```
Task 1: B (channel.rotateProxy)
Task 2: A (worker.runTask retry 前置)        ← 依赖 Task 1
Task 3: C (taskPromise deadline)             ← 依赖 Task 2
Task 4: D (config + page-crawler 默认值)     ← 可与 Task 2 并行
Task 5: E (部署文档)
```

**执行策略**：Task 1 → Task 2 + Task 4 并行 → Task 3 → Task 5

每个任务由 subagent-driven-development 派 implementer + spec-reviewer + code-quality-reviewer。

---

### 任务 1：channel.rotateProxy(reason) — 实现

**文件：**
- 修改：`src/channel.js`（在 `maybeTriggerReinstall` 后面新增 `rotateProxy` 方法）
- 测试：`test/channel-rotate-proxy.test.js`（新增）

- [ ] **步骤 1：编写失败测试 — 换 IP 成功路径**

```js
// test/channel-rotate-proxy.test.js
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const { Channel } = require('../src/channel');

function makeMockPool() {
  return {
    nextForChannel: async (channelId) => `http://new-proxy-for-${channelId}`,
  };
}

function makeChannel(overrides = {}) {
  const channel = new Channel({
    id: 1,
    config: {
      cliproxyRotationCooldownMs: 30000,
      ...overrides.config,
    },
    log: () => {},
  });
  channel.browserContext = {
    browser: () => ({ isConnected: () => true }),
  };
  channel.proxyPool = overrides.proxyPool || makeMockPool();
  channel.reinitializing = false;
  channel.lastIpRotationAt = 0;
  // mock reinit 和 recordIpRotation
  channel.reinit = async function (_browser, proxy) {
    channel._lastReinitProxy = proxy;
  };
  channel.recordIpRotation = function () {
    channel.lastIpRotationAt = Date.now();
  };
  return channel;
}

describe('Channel.rotateProxy', () => {
  it('rotates IP when conditions are met', async () => {
    const channel = makeChannel();
    const result = await channel.rotateProxy('task-timeout');

    assert.strictEqual(result.rotated, true);
    assert.strictEqual(result.reason, 'success');
    assert.strictEqual(channel._lastReinitProxy, 'http://new-proxy-for-ch-1');
    assert.ok(channel.lastIpRotationAt > 0, 'should record IP rotation timestamp');
  });

  // ... 其余测试在步骤 2-9
});
```

- [ ] **步骤 2：编写失败测试 — cooldown 内拒绝**

```js
  it('skips rotation within cooldown window', async () => {
    const channel = makeChannel();
    channel.lastIpRotationAt = Date.now() - 10000; // 10s ago, cooldown=30s
    let called = false;
    channel.proxyPool.nextForChannel = async () => { called = true; return 'proxy'; };

    const result = await channel.rotateProxy('task-timeout');

    assert.strictEqual(result.rotated, false);
    assert.strictEqual(result.reason, 'cooldown');
    assert.strictEqual(called, false, 'should not call nextForChannel');
  });
```

- [ ] **步骤 3：编写失败测试 — cooldown 刚过允许**

```js
  it('allows rotation after cooldown elapsed', async () => {
    const channel = makeChannel();
    channel.lastIpRotationAt = Date.now() - 31000; // 31s ago
    const result = await channel.rotateProxy('task-timeout');
    assert.strictEqual(result.rotated, true);
    assert.strictEqual(result.reason, 'success');
  });
```

- [ ] **步骤 4：编写失败测试 — reinitializing 时跳过**

```js
  it('skips rotation when channel is already reinitializing', async () => {
    const channel = makeChannel();
    channel.reinitializing = true;
    let called = false;
    channel.proxyPool.nextForChannel = async () => { called = true; return 'proxy'; };

    const result = await channel.rotateProxy('task-timeout');

    assert.strictEqual(result.rotated, false);
    assert.strictEqual(result.reason, 'reinitializing');
    assert.strictEqual(called, false);
  });
```

- [ ] **步骤 5：编写失败测试 — 无 proxyPool**

```js
  it('returns no_pool when proxyPool is not configured', async () => {
    const channel = makeChannel();
    channel.proxyPool = null;
    const result = await channel.rotateProxy('task-timeout');
    assert.strictEqual(result.rotated, false);
    assert.strictEqual(result.reason, 'no_pool');
  });
```

- [ ] **步骤 6：编写失败测试 — nextForChannel 抛错**

```js
  it('returns error when nextForChannel throws', async () => {
    const channel = makeChannel();
    channel.proxyPool.nextForChannel = async () => { throw new Error('pool exhausted'); }

    const result = await channel.rotateProxy('task-timeout');

    assert.strictEqual(result.rotated, false);
    assert.strictEqual(result.reason, 'error');
    assert.ok(result.error.includes('pool exhausted'));
    assert.strictEqual(channel.reinitializing, false, 'should release reinitializing in finally');
  });
```

- [ ] **步骤 7：编写失败测试 — reinit 抛错**

```js
  it('returns error when reinit throws', async () => {
    const channel = makeChannel();
    channel.reinit = async () => { throw new Error('browser dead'); };

    const result = await channel.rotateProxy('task-timeout');

    assert.strictEqual(result.rotated, false);
    assert.strictEqual(result.reason, 'error');
    assert.ok(result.error.includes('browser dead'));
    assert.strictEqual(channel.reinitializing, false);
  });
```

- [ ] **步骤 8：运行所有测试验证失败**

运行：`node --test test/channel-rotate-proxy.test.js`
预期：FAIL — `TypeError: channel.rotateProxy is not a function`

- [ ] **步骤 9：实现 rotateProxy 方法**

修改 `src/channel.js`，在 `maybeTriggerReinstall`（约 line 447）后面新增：

```js
  // 由 worker.runTask 在任务失败时调用：主动换 IP + session 后重试一次。
  // 返回 { rotated, reason } 让 caller 决定是否重试：
  //   - rotated=true: 已换 IP，可重试
  //   - rotated=false: 跳过换 IP（cooldown / 正在重建 / 无 pool / 错误），直接提交原 result
  // reason 字段用于日志和监控区分跳过原因。
  async rotateProxy(reason) {
    if (this.reinitializing) {
      this.log(`[Channel ${this.id}] rotateProxy(${reason}) skipped: reinitializing`);
      return { rotated: false, reason: 'reinitializing' };
    }

    const cooldownMs = this.config.cliproxyRotationCooldownMs || 30000;
    const now = Date.now();
    if (this.lastIpRotationAt > 0 && (now - this.lastIpRotationAt) < cooldownMs) {
      this.log(`[Channel ${this.id}] rotateProxy(${reason}) skipped: cooldown active (${Math.round((cooldownMs - (now - this.lastIpRotationAt)) / 1000)}s remaining)`);
      return { rotated: false, reason: 'cooldown' };
    }

    if (!this.proxyPool) {
      this.log(`[Channel ${this.id}] rotateProxy(${reason}) skipped: no proxy pool`);
      return { rotated: false, reason: 'no_pool' };
    }

    try {
      this.reinitializing = true;
      const channelId = `ch-${this.id}`;
      const newProxy = await this.proxyPool.nextForChannel(channelId);
      this.log(`[Channel ${this.id}] rotateProxy(${reason}): rotating to ${newProxy}`);
      await this.reinit(this.browser, newProxy);
      this.recordIpRotation();
      return { rotated: true, reason: 'success' };
    } catch (e) {
      this.log(`[Channel ${this.id}] rotateProxy(${reason}) failed: ${e.message}`);
      return { rotated: false, reason: 'error', error: e.message };
    } finally {
      this.reinitializing = false;
    }
  }
```

- [ ] **步骤 10：运行所有测试验证通过**

运行：`node --test test/channel-rotate-proxy.test.js`
预期：PASS — 7/7 通过

- [ ] **步骤 11：Commit**

```bash
git add src/channel.js test/channel-rotate-proxy.test.js
git commit -m "feat(channel): add rotateProxy(reason) for worker-layer IP rotation"
```

---

### 任务 2：worker.runTask 加 retry 前置逻辑 — 实现

**文件：**
- 修改：`src/worker.js`（重构 runTask，加 shouldRetryWithNewIp helper）
- 测试：`test/worker-retry-on-timeout.test.js`（新增）

- [ ] **步骤 1：编写失败测试 — shouldRetryWithNewIp 纯函数全部分支**

```js
// test/worker-retry-on-timeout.test.js
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const { Worker } = require('../src/worker');

describe('Worker.shouldRetryWithNewIp', () => {
  let worker;
  beforeEach(() => {
    worker = new Worker({
      pusher: { push: async () => {} },
      log: () => {},
    });
  });

  it('returns false when retryOnTimeout is disabled', () => {
    worker.retryOnTimeout = false;
    const channel = { reinitializing: false };
    const result = { status: 'not_found', dataLayerFailed: true };
    assert.strictEqual(worker.shouldRetryWithNewIp(result, channel), false);
  });

  it('returns false when channel is reinitializing', () => {
    const channel = { reinitializing: true };
    const result = { status: 'not_found', dataLayerFailed: true };
    assert.strictEqual(worker.shouldRetryWithNewIp(result, channel), false);
  });

  it('returns false for business no-result (dataLayerNotFound=true)', () => {
    const channel = { reinitializing: false };
    const result = { status: 'not_found', dataLayerFailed: true, dataLayerNotFound: true };
    assert.strictEqual(worker.shouldRetryWithNewIp(result, channel), false);
  });

  it('returns true for dataLayer anomaly not_found', () => {
    const channel = { reinitializing: false };
    const result = { status: 'not_found', dataLayerFailed: true, dataLayerNotFound: false };
    assert.strictEqual(worker.shouldRetryWithNewIp(result, channel), true);
  });

  it('returns true for page.goto timeout error', () => {
    const channel = { reinitializing: false };
    const result = { status: 'error', error: 'page.goto: Timeout 30000ms exceeded.' };
    assert.strictEqual(worker.shouldRetryWithNewIp(result, channel), true);
  });

  it('returns true for timeout status', () => {
    const channel = { reinitializing: false };
    const result = { status: 'timeout' };
    assert.strictEqual(worker.shouldRetryWithNewIp(result, channel), true);
  });

  it('returns false for other errors', () => {
    const channel = { reinitializing: false };
    const result = { status: 'error', error: 'ERR_TUNNEL_CONNECTION_FAILED' };
    assert.strictEqual(worker.shouldRetryWithNewIp(result, channel), false);
  });

  it('returns false for success results', () => {
    const channel = { reinitializing: false };
    const result = { status: 'success', product_url: 'https://...' };
    assert.strictEqual(worker.shouldRetryWithNewIp(result, channel), false);
  });
});
```

- [ ] **步骤 2：编写失败测试 — 集成 runTask 触发重试**

```js
describe('Worker.runTask retry behavior', () => {
  it('rotates IP and retries when first crawl returns dataLayer anomaly', async () => {
    let crawlCalls = 0;
    const channel = {
      id: 1,
      busy: false,
      reinitializing: false,
      crawl: async () => {
        crawlCalls += 1;
        if (crawlCalls === 1) {
          return {
            crawlerTaskId: 't1', sku: 'SKU1', status: 'not_found',
            dataLayerFailed: true, dataLayerNotFound: false,
            error: 'DATA_LAYER_MISSING', product_url: '', product_name: '',
          };
        }
        return {
          crawlerTaskId: 't1', sku: 'SKU1', status: 'success',
          product_url: 'https://hit', product_name: 'Hit',
        };
      },
      rotateProxy: async () => ({ rotated: true, reason: 'success' }),
    };

    const pushed = [];
    const worker = new Worker({
      pusher: { push: async (r) => { pushed.push(r); } },
      log: () => {},
    });
    worker.retryOnTimeout = true;

    await worker.runTask({ crawlerTaskId: 't1', sku: 'SKU1' }, channel);

    assert.strictEqual(crawlCalls, 2, 'should crawl twice');
    assert.strictEqual(pushed.length, 1);
    assert.strictEqual(pushed[0].status, 'success', 'should push the retry success result');
  });

  // ... 其余测试
});
```

- [ ] **步骤 3：编写失败测试 — 业务无结果不触发重试**

```js
  it('does NOT retry on business no-result', async () => {
    let crawlCalls = 0;
    const channel = {
      id: 1,
      busy: false,
      reinitializing: false,
      crawl: async () => {
        crawlCalls += 1;
        return {
          crawlerTaskId: 't1', sku: 'NO-RESULT', status: 'not_found',
          dataLayerFailed: false, dataLayerNotFound: true,
          product_url: '', product_name: '',
        };
      },
      rotateProxy: async () => { throw new Error('should not be called'); },
    };

    const pushed = [];
    const worker = new Worker({
      pusher: { push: async (r) => { pushed.push(r); } },
      log: () => {},
    });
    worker.retryOnTimeout = true;

    await worker.runTask({ crawlerTaskId: 't1', sku: 'NO-RESULT' }, channel);

    assert.strictEqual(crawlCalls, 1);
    assert.strictEqual(pushed[0].status, 'not_found');
    assert.strictEqual(pushed[0].dataLayerNotFound, true);
  });
```

- [ ] **步骤 4：编写失败测试 — rotate 失败不重试**

```js
  it('does NOT retry when rotateProxy returns cooldown', async () => {
    let crawlCalls = 0;
    const channel = {
      id: 1,
      busy: false,
      reinitializing: false,
      crawl: async () => {
        crawlCalls += 1;
        return {
          crawlerTaskId: 't1', sku: 'SKU', status: 'not_found',
          dataLayerFailed: true, dataLayerNotFound: false,
        };
      },
      rotateProxy: async () => ({ rotated: false, reason: 'cooldown' }),
    };

    const pushed = [];
    const worker = new Worker({
      pusher: { push: async (r) => { pushed.push(r); } },
      log: () => {},
    });
    worker.retryOnTimeout = true;

    await worker.runTask({ crawlerTaskId: 't1', sku: 'SKU' }, channel);

    assert.strictEqual(crawlCalls, 1, 'should not re-crawl');
    assert.strictEqual(pushed[0].status, 'not_found');
  });
```

- [ ] **步骤 5：编写失败测试 — 第 2 次 crawl 抛异常**

```js
  it('translates second crawl exception to result and pushes', async () => {
    let crawlCalls = 0;
    const channel = {
      id: 1,
      busy: false,
      reinitializing: false,
      crawl: async () => {
        crawlCalls += 1;
        if (crawlCalls === 1) {
          return { crawlerTaskId: 't1', sku: 'SKU', status: 'not_found', dataLayerFailed: true, dataLayerNotFound: false };
        }
        throw new Error('renderer crash after rotate');
      },
      rotateProxy: async () => ({ rotated: true, reason: 'success' }),
    };

    const pushed = [];
    const worker = new Worker({
      pusher: { push: async (r) => { pushed.push(r); } },
      log: () => {},
    });
    worker.retryOnTimeout = true;

    await worker.runTask({ crawlerTaskId: 't1', sku: 'SKU' }, channel);

    assert.strictEqual(crawlCalls, 2);
    assert.strictEqual(pushed[0].status, 'error');
    assert.ok(pushed[0].error.includes('renderer crash'));
  });
```

- [ ] **步骤 6：运行测试验证失败**

运行：`node --test test/worker-retry-on-timeout.test.js`
预期：FAIL — `shouldRetryWithNewIp is not a function`

- [ ] **步骤 7：实现 shouldRetryWithNewIp helper**

修改 `src/worker.js`，在 `class Worker` 内部新增：

```js
  // 决定是否对单 task 触发换 IP 重试。
  // 触发条件：业务异常强信号（dataLayer 异常 / page.goto 全 timeout / crawl timeout）
  // 不触发：业务无结果（dataLayerNotFound=true）/ 成功 / 普通 error / channel 正在重建 / 全局开关关闭
  shouldRetryWithNewIp(result, channel) {
    if (this.retryOnTimeout === false) return false;
    if (!channel || channel.reinitializing) return false;
    if (!result) return false;

    if (result.status === 'not_found' && result.dataLayerFailed === true && result.dataLayerNotFound !== true) {
      return true;
    }

    if (result.status === 'error' && typeof result.error === 'string' && /Timeout \d+ms exceeded/.test(result.error)) {
      return true;
    }

    if (result.status === 'timeout') {
      return true;
    }

    return false;
  }
```

- [ ] **步骤 8：重构 runTask 加 retry 逻辑**

修改 `src/worker.js` 的 `runTask` 方法（约 line 63-152）。**注意：完整重构会涉及 deadline 保护（在任务 3），本任务只加 retry 逻辑，保持现有 finishPromise 结构不变**。

替换 runTask 方法：

```js
  async runTask(task, channel) {
    const taskIdKey = this.getTaskIdKey(task);
    const startedAt = Date.now();
    let retries = 0;
    let result = null;
    channel.busy = true;

    const pushPromise = (async () => {
      try {
        this.log(`[Worker] Assigning task ${task.crawlerTaskId} sku ${task.sku} to channel ${channel.id}`);
        result = await channel.crawl(task);
        this.log(`[Worker] Crawl finished task ${task.crawlerTaskId} status ${result.status}`);

        // 新增：换 IP 重试前置
        if (this.shouldRetryWithNewIp(result, channel)) {
          this.log(`[Worker] task ${task.crawlerTaskId} failed (${result.status}); rotating IP and retrying`);
          const rotated = await channel.rotateProxy('task-timeout');
          if (rotated.rotated) {
            try {
              result = await channel.crawl(task);
              retries = 1;
              this.log(`[Worker] Retry crawl finished task ${task.crawlerTaskId} status ${result.status}`);
            } catch (retryErr) {
              this.log(`[Worker] Retry crawl failed task ${task.crawlerTaskId}: ${retryErr.message}`);
              result = {
                crawlerTaskId: task.crawlerTaskId,
                sku: task.sku,
                status: retryErr.status ?? 'error',
                product_name: '',
                features_details: '',
                product_specification: '',
                product_url: '',
                error: retryErr.message,
              };
              retries = 1;
            }
          } else {
            this.log(`[Worker] rotate skipped for task ${task.crawlerTaskId}: ${rotated.reason}`);
          }
        }
      } catch (e) {
        this.log(`[Worker] Crawl failed task ${task.crawlerTaskId} sku ${task.sku}: ${e.message}`);
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

      try {
        this.log(`[Worker] Starting push task ${task.crawlerTaskId} sku ${task.sku} status=${result.status}`);
        await this.pusher.push(result);
        this.log(`[Worker] Push completed task ${task.crawlerTaskId} status ${result.status}`);

        if (this.imageUploader && result.status === 'success') {
          try {
            await this.imageUploader.upload(result);
            this.log(`[Worker] Image upload completed task ${task.crawlerTaskId} sku ${task.sku}`);
          } catch (uploadErr) {
            this.log(`[Worker] Image upload failed task ${task.crawlerTaskId} sku ${task.sku}: ${uploadErr.message}`);
          }
        }
      } catch (e) {
        retries = 1;
        this.log(`[Worker] Push failed task ${task.crawlerTaskId} sku ${task.sku}: ${e.message}`);
        const errorResult = {
          ...result,
          status: 'error',
          error: e.message,
        };
        try {
          await this.pusher.push(errorResult);
          this.log(`[Worker] Error status pushed for task ${task.crawlerTaskId}`);
        } catch (pushErr) {
          this.log(`[Worker] failed to push error result for task ${task.crawlerTaskId}: ${pushErr.message}`);
        }
        result = errorResult;
      }
    })();

    const taskPromise = pushPromise.finally(async () => {
      if (this.logger) {
        try {
          this.logger.info('task', 'finished', {
            crawlerTaskId: result?.crawlerTaskId,
            sku: result?.sku,
            status: result?.status,
            error: result?.error || '',
            durationMs: Date.now() - startedAt,
            retries,
            channelId: channel.id,
          });
        } catch (e) {
          this.log(`[Worker] Failed to write task event log: ${e.message}`);
        }
      }
      channel.busy = false;
      this.pendingPushes.delete(taskPromise);
      if (taskIdKey !== null) {
        this.inFlightTaskIds.delete(taskIdKey);
      }
      if (channel.onTaskComplete) {
        try {
          await channel.onTaskComplete();
        } catch (e) {
          this.log(`[Worker] channel onTaskComplete error: ${e.message}`);
        }
      }
    });

    this.pendingPushes.add(taskPromise);
    return taskPromise;
  }
```

- [ ] **步骤 9：运行所有 worker 测试验证通过**

运行：`node --test test/worker-retry-on-timeout.test.js`
预期：PASS — 11/11 通过

运行：`node --test test/` 全套
预期：所有已有测试仍 PASS

- [ ] **步骤 10：Commit**

```bash
git add src/worker.js test/worker-retry-on-timeout.test.js
git commit -m "feat(worker): retry-on-timeout — rotate IP and re-crawl once on dataLayer/timeout failure"
```

---

### 任务 3：taskPromise 130s deadline — 实现

**文件：**
- 修改：`src/worker.js`（重构 runTask 包裹 deadline；新增 finishTask helper）
- 测试：`test/worker-deadline.test.js`（新增）

- [ ] **步骤 1：编写失败测试 — 正常完成路径不触发 deadline**

```js
// test/worker-deadline.test.js
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const { Worker } = require('../src/worker');

describe('Worker.runTask deadline', () => {
  it('does not trigger deadline when finishPromise resolves quickly', async () => {
    let onTaskCompleteCalled = false;
    const channel = {
      id: 1,
      busy: false,
      reinitializing: false,
      crawl: async () => ({ crawlerTaskId: 't1', sku: 'SKU', status: 'success', product_url: 'x' }),
      onTaskComplete: async () => { onTaskCompleteCalled = true; },
    };
    const worker = new Worker({
      pusher: { push: async () => {} },
      log: () => {},
      taskTimeoutMs: 5000,
    });

    await worker.runTask({ crawlerTaskId: 't1', sku: 'SKU' }, channel);

    assert.strictEqual(onTaskCompleteCalled, true, 'onTaskComplete should run on normal completion');
    assert.strictEqual(channel.busy, false);
  });
```

- [ ] **步骤 2：编写失败测试 — deadline 触发强制推 timeout**

```js
  it('forces timeout push when finishPromise exceeds deadline', async () => {
    const pushed = [];
    const channel = {
      id: 1,
      busy: false,
      reinitializing: false,
      crawl: async () => {
        // crawl 自己正常返回（模拟前段正常）
        return { crawlerTaskId: 't1', sku: 'SKU', status: 'success', product_url: 'x' };
      },
      onTaskComplete: async () => {
        // onTaskComplete 卡死 3s，触发 deadline（100ms）
        await new Promise(r => setTimeout(r, 3000));
      },
    };
    const worker = new Worker({
      pusher: {
        push: async (r) => {
          pushed.push(r);
          // 模拟 pusher 也卡 1s
          await new Promise(r => setTimeout(r, 1000));
        },
      },
      log: () => {},
      taskTimeoutMs: 100,
    });

    await worker.runTask({ crawlerTaskId: 't1', sku: 'SKU' }, channel);

    assert.ok(pushed.some(r => r.status === 'timeout'), 'should push timeout result');
    assert.strictEqual(channel.busy, false, 'channel.busy must be reset even on deadline');
  });
```

- [ ] **步骤 3：编写失败测试 — deadline 触发后不调 onTaskComplete**

```js
  it('does NOT call onTaskComplete when deadline fires', async () => {
    let onTaskCompleteCalled = false;
    const channel = {
      id: 1,
      busy: false,
      reinitializing: false,
      crawl: async () => ({ crawlerTaskId: 't1', sku: 'SKU', status: 'success' }),
      onTaskComplete: async () => {
        onTaskCompleteCalled = true;
        await new Promise(r => setTimeout(r, 5000)); // hang
      },
    };
    const worker = new Worker({
      pusher: { push: async () => { await new Promise(r => setTimeout(r, 5000)); } }, // hang
      log: () => {},
      taskTimeoutMs: 100,
    });

    await worker.runTask({ crawlerTaskId: 't1', sku: 'SKU' }, channel);

    // deadline 100ms 后应该已经 return，onTaskComplete 应该没被调用（或在 race 后被忽略）
    await new Promise(r => setTimeout(r, 300));
    assert.strictEqual(onTaskCompleteCalled, false, 'onTaskComplete should not be invoked after deadline');
  });
```

- [ ] **步骤 4：编写失败测试 — deadline 触发后 inFlightTaskIds 清理**

```js
  it('clears inFlightTaskIds when deadline fires', async () => {
    const channel = {
      id: 1, busy: false, reinitializing: false,
      crawl: async () => ({ crawlerTaskId: '42', sku: 'SKU', status: 'success' }),
      onTaskComplete: async () => { await new Promise(r => setTimeout(r, 5000)); },
    };
    const worker = new Worker({
      pusher: { push: async () => { await new Promise(r => setTimeout(r, 5000)); } },
      log: () => {},
      taskTimeoutMs: 100,
    });

    await worker.runTask({ crawlerTaskId: '42', sku: 'SKU' }, channel);

    assert.strictEqual(worker.inFlightTaskIds.has('42'), false, 'should clear inFlightTaskIds');
  });
```

- [ ] **步骤 5：编写失败测试 — taskTimeoutMs 配置生效**

```js
  it('respects custom taskTimeoutMs from config', async () => {
    const channel = {
      id: 1, busy: false, reinitializing: false,
      crawl: async () => ({ crawlerTaskId: 't1', sku: 'SKU', status: 'success' }),
      onTaskComplete: async () => { await new Promise(r => setTimeout(r, 1000)); },
    };
    const pushed = [];
    const worker = new Worker({
      pusher: { push: async (r) => { pushed.push(r); await new Promise(r => setTimeout(r, 100)); } },
      log: () => {},
      taskTimeoutMs: 50,
    });

    const start = Date.now();
    await worker.runTask({ crawlerTaskId: 't1', sku: 'SKU' }, channel);
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 200, `should return quickly after deadline, took ${elapsed}ms`);
  });
```

- [ ] **步骤 6：运行测试验证失败**

运行：`node --test test/worker-deadline.test.js`
预期：FAIL — `taskTimeoutMs is not a constructor / config not respected`

- [ ] **步骤 7：重构 runTask 包裹 deadline**

修改 `src/worker.js`：

1. 在 Worker 构造函数读取 `taskTimeoutMs`：
```js
  constructor(options) {
    // ... 现有代码
    this.taskTimeoutMs = (options && options.taskTimeoutMs) || 130000;
  }
```

2. 重构 runTask：把内部 pushPromise 拆为两部分，外部用 Promise.race + deadline 包裹：

```js
  async runTask(task, channel) {
    const taskIdKey = this.getTaskIdKey(task);
    const startedAt = Date.now();
    let retries = 0;
    let result = null;
    let timedOut = false;
    channel.busy = true;

    // 完整流程（包含 crawl + retry + push + imageUpload + cleanup）
    const finishPromise = (async () => {
      try {
        this.log(`[Worker] Assigning task ${task.crawlerTaskId} sku ${task.sku} to channel ${channel.id}`);
        result = await channel.crawl(task);
        this.log(`[Worker] Crawl finished task ${task.crawlerTaskId} status ${result.status}`);

        if (this.shouldRetryWithNewIp(result, channel)) {
          this.log(`[Worker] task ${task.crawlerTaskId} failed (${result.status}); rotating IP and retrying`);
          const rotated = await channel.rotateProxy('task-timeout');
          if (rotated.rotated) {
            try {
              result = await channel.crawl(task);
              retries = 1;
              this.log(`[Worker] Retry crawl finished task ${task.crawlerTaskId} status ${result.status}`);
            } catch (retryErr) {
              this.log(`[Worker] Retry crawl failed task ${task.crawlerTaskId}: ${retryErr.message}`);
              result = {
                crawlerTaskId: task.crawlerTaskId,
                sku: task.sku,
                status: retryErr.status ?? 'error',
                product_name: '',
                features_details: '',
                product_specification: '',
                product_url: '',
                error: retryErr.message,
              };
              retries = 1;
            }
          } else {
            this.log(`[Worker] rotate skipped for task ${task.crawlerTaskId}: ${rotated.reason}`);
          }
        }
      } catch (e) {
        this.log(`[Worker] Crawl failed task ${task.crawlerTaskId} sku ${task.sku}: ${e.message}`);
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

      try {
        this.log(`[Worker] Starting push task ${task.crawlerTaskId} sku ${task.sku} status=${result.status}`);
        await this.pusher.push(result);
        this.log(`[Worker] Push completed task ${task.crawlerTaskId} status ${result.status}`);

        if (this.imageUploader && result.status === 'success') {
          try {
            await this.imageUploader.upload(result);
            this.log(`[Worker] Image upload completed task ${task.crawlerTaskId} sku ${task.sku}`);
          } catch (uploadErr) {
            this.log(`[Worker] Image upload failed task ${task.crawlerTaskId} sku ${task.sku}: ${uploadErr.message}`);
          }
        }
      } catch (e) {
        retries = 1;
        this.log(`[Worker] Push failed task ${task.crawlerTaskId} sku ${task.sku}: ${e.message}`);
        const errorResult = {
          ...result,
          status: 'error',
          error: e.message,
        };
        try {
          await this.pusher.push(errorResult);
          this.log(`[Worker] Error status pushed for task ${task.crawlerTaskId}`);
        } catch (pushErr) {
          this.log(`[Worker] failed to push error result for task ${task.crawlerTaskId}: ${pushErr.message}`);
        }
        result = errorResult;
      }
    })();

    // Deadline 兜底：单 task 不超过 taskTimeoutMs（默认 130s）
    // 触发条件：finishPromise 内部任意一步卡死（renderer 卡死 / pusher 网络卡死等）
    let deadlineReject;
    const deadlinePromise = new Promise((_, reject) => {
      deadlineReject = reject;
    });
    const deadlineTimer = setTimeout(
      () => deadlineReject(new Error(`Task deadline ${this.taskTimeoutMs}ms exceeded`)),
      this.taskTimeoutMs,
    );

    try {
      await Promise.race([finishPromise, deadlinePromise]);
    } catch (deadlineErr) {
      if (deadlineErr.message.startsWith('Task deadline')) {
        timedOut = true;
        this.log(`[Worker] Task ${task.crawlerTaskId} deadline exceeded, forcing timeout result`);
        const timeoutResult = {
          crawlerTaskId: task.crawlerTaskId,
          sku: task.sku,
          status: 'timeout',
          product_name: '',
          features_details: '',
          product_specification: '',
          product_url: '',
          error: deadlineErr.message,
        };
        // 强制推一次 timeout 给上游（不挂起上游）
        try {
          await this.pusher.push(timeoutResult);
          this.log(`[Worker] Forced timeout result pushed for task ${task.crawlerTaskId}`);
        } catch (pushErr) {
          this.log(`[Worker] Failed to push forced timeout result for task ${task.crawlerTaskId}: ${pushErr.message}`);
        }
      }
    } finally {
      clearTimeout(deadlineTimer);
    }

    // 资源清理（即使 deadline 触发也必须执行）
    channel.busy = false;
    this.pendingPushes.delete(/* taskPromise ref */ finishPromise); // 见步骤 8 修复
    if (taskIdKey !== null) {
      this.inFlightTaskIds.delete(taskIdKey);
    }

    // logger
    if (this.logger) {
      try {
        this.logger.info('task', timedOut ? 'timeout' : 'finished', {
          crawlerTaskId: task.crawlerTaskId,
          sku: task.sku,
          status: timedOut ? 'timeout' : (result?.status ?? 'unknown'),
          error: timedOut ? 'Task deadline exceeded' : (result?.error || ''),
          durationMs: Date.now() - startedAt,
          retries,
          channelId: channel.id,
          timedOut,
        });
      } catch (e) {
        this.log(`[Worker] Failed to write task event log: ${e.message}`);
      }
    }

    // 注意：deadline 路径不调 channel.onTaskComplete（避免二次卡死）
    if (!timedOut && channel.onTaskComplete) {
      try {
        await channel.onTaskComplete();
      } catch (e) {
        this.log(`[Worker] channel onTaskComplete error: ${e.message}`);
      }
    }

    return timedOut ? { ...task, status: 'timeout', error: 'Task deadline exceeded' } : result;
  }
```

- [ ] **步骤 8：修复 pendingPushes 引用**

`finishPromise` 内部不再用 `taskPromise` 包装，所以 `pendingPushes` 的引用需调整。修改 loop 的 drain 检查：

```js
  async drain() {
    this.stop();
    if (this.loopPromise) {
      await this.loopPromise;
    }
    while (this.taskQueue.length > 0 || this.channels.some(c => c.busy)) {
      this.log(`[Worker] draining: queue=${this.taskQueue.length}, busy=${this.channels.filter(c => c.busy).length}`);
      await this.sleep(500);
    }
  }
```

**注意**：移除 `pendingPushes.size > 0` 检查（deadline 路径下 finishPromise 可能仍挂起但 drain 不应无限等）。`pendingPushes` 可保留但不在 drain 里用。

- [ ] **步骤 9：运行 deadline 测试验证通过**

运行：`node --test test/worker-deadline.test.js`
预期：PASS — 5/5 通过

- [ ] **步骤 10：运行全套测试验证不破坏**

运行：`node --test test/`
预期：所有已有测试 + retry 测试 + deadline 测试全 PASS

特别注意 `test/worker-retry-on-timeout.test.js` 不能因为结构改变而失败——需要确认 pushPromise 行为对齐。

- [ ] **步骤 11：Commit**

```bash
git add src/worker.js test/worker-deadline.test.js
git commit -m "feat(worker): taskPromise 130s deadline — force timeout push if renderer/pusher hangs"
```

---

### 任务 4：config + page-crawler 默认值 — 实现

**文件：**
- 修改：`src/page-crawler.js`（默认值调整）
- 修改：`src/crawler.js`（config 加 taskTimeoutMs / retryOnTimeout）
- 修改：`src/service.js`（initChannels 显式传 dataLayerMaxRetries=1）
- 测试：可加 `test/page-crawler-defaults.test.js`（新增）

- [ ] **步骤 1：编写失败测试 — page-crawler 默认值**

```js
// test/page-crawler-defaults.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { PageCrawler } = require('../src/page-crawler');

describe('PageCrawler default retry counts', () => {
  it('defaults gotoMaxRetries to 1', () => {
    const crawler = new PageCrawler({});
    assert.strictEqual(crawler.gotoMaxRetries, 1);
  });

  it('defaults dataLayerMaxRetries to 1', () => {
    const crawler = new PageCrawler({});
    assert.strictEqual(crawler.dataLayerMaxRetries, 1);
  });

  it('still respects explicit override', () => {
    const crawler = new PageCrawler({ gotoMaxRetries: 5, dataLayerMaxRetries: 7 });
    assert.strictEqual(crawler.gotoMaxRetries, 5);
    assert.strictEqual(crawler.dataLayerMaxRetries, 7);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/page-crawler-defaults.test.js`
预期：FAIL — `gotoMaxRetries: expected 1, got 3`

- [ ] **步骤 3：修改 page-crawler.js 默认值**

修改 `src/page-crawler.js` 的 PageCrawler 构造函数：

```js
this.gotoMaxRetries = options.gotoMaxRetries !== undefined ? options.gotoMaxRetries : 1;
this.dataLayerMaxRetries = options.dataLayerMaxRetries !== undefined ? options.dataLayerMaxRetries : 1;
```

（从 `: 3` 改为 `: 1`）

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test test/page-crawler-defaults.test.js`
预期：PASS — 3/3

- [ ] **步骤 5：修改 src/crawler.js config**

在 `src/crawler.js` 的 config 构造处添加：

```js
config.taskTimeoutMs = process.env.CRAWLER_TASK_TIMEOUT_MS
  ? parseInt(process.env.CRAWLER_TASK_TIMEOUT_MS, 10)
  : 130000;
config.retryOnTimeout = process.env.CRAWLER_RETRY_ON_TIMEOUT !== 'false';
```

**同时** 在 Worker 构造时传递 `taskTimeoutMs`：

修改 `src/service.js` 的 worker 构造：

```js
this.worker = new Worker({
  pusher: this.pusher,
  imageUploader,
  log: this.log.bind(this),
  logger: this.logger,
  taskTimeoutMs: this.config.taskTimeoutMs,
  retryOnTimeout: this.config.retryOnTimeout,
});
```

- [ ] **步骤 6：修改 src/service.js initChannels 显式传 dataLayerMaxRetries=1**

在 initChannels 的 channel config 中：

```js
dataLayerMaxRetries: 1,  // 显式传，避免依赖默认值
```

- [ ] **步骤 7：运行全套测试验证不破坏**

运行：`node --test test/`
预期：所有测试 PASS

- [ ] **步骤 8：Commit**

```bash
git add src/page-crawler.js src/crawler.js src/service.js test/page-crawler-defaults.test.js
git commit -m "feat(config): taskTimeoutMs=130000, retryOnTimeout=true, goto/dataLayer retry 3→1"
```

---

### 任务 5：部署vps.md 加 revert 说明 — 实现

**文件：**
- 修改：`部署vps.md`（在 7.4 节后新增 7.5 节）

- [ ] **步骤 1：读取现有 部署vps.md 7.x 节结构**

运行：`grep -n "^## " 部署vps.md` 找到现有节位置

- [ ] **步骤 2：在 7.4 节后新增 7.5 节：任务超时换 IP 重试 + Deadline**

```markdown
### 7.5 任务超时换 IP 重试 + Deadline 保护（2026-07-08）

**新增 commit**（按时间顺序）：

| SHA | 说明 |
|---|---|
| `<sha>` | feat(config): taskTimeoutMs=130000, retryOnTimeout=true, goto/dataLayer retry 3→1 |
| `<sha>` | feat(worker): taskPromise 130s deadline — force timeout push if renderer/pusher hangs |
| `<sha>` | feat(worker): retry-on-timeout — rotate IP and re-crawl once on dataLayer/timeout failure |
| `<sha>` | feat(channel): add rotateProxy(reason) for worker-layer IP rotation |

**触发条件**：单个 task 满足以下任一条件时触发换 IP 重试：
- dataLayer 异常触发的 not_found（业务无结果 result_number=0 **不触发**）
- page.goto 全部 timeout（status=error, error 匹配 /Timeout \d+ms exceeded/）
- crawl 抛 TimeoutError（status=timeout）

**Deadline 保护**：单 task 整体 130s 超时后强制推 timeout 给上游，防止 renderer 卡死导致 channel 永久 busy。

**风险**：换 IP 后 IP 池限流（30s cooldown 兜底）/ 网络抖动 SKU 被错杀（gotoRetryDelays 缓解）/ 频繁换 IP（监控告警）。

**监控项**：
- `[Worker] rotating IP and retrying` 频率（建议 < 10/min/channel）
- `Task deadline exceeded` 频率（建议 0/hour，触发则重启容器）
- `rotate skipped for task ... cooldown` 频率（建议 < 30%，过高说明 cooldown 太短）

**Revert**：
```bash
# 单 commit revert（按倒序）
git revert <deadline-commit-sha>
git revert <rotate-proxy-commit-sha>
git revert <worker-retry-commit-sha>
git revert <config-commit-sha>

# 回到 commit 65a53b0（v1.1.x 已知稳定）
git reset --hard 65a53b0
```

**不推送镜像**：所有 commit 在 working tree，等生产观察 1-2 天无异常后再打新 tag。
```

- [ ] **步骤 3：验证文档无错**

运行：`grep -n "TODO\|待定" 部署vps.md` 预期：无匹配

- [ ] **步骤 4：Commit**

```bash
git add 部署vps.md
git commit -m "docs(deploy): revert & monitoring guide for task-timeout-rotate-retry"
```

---

## 自检

**1. 规格覆盖度：**

| 规格章节 | 对应任务 |
|---|---|
| 重试触发条件（worker.runTask）| 任务 2 |
| page-crawler 默认值 3→1 | 任务 4 |
| channel.rotateProxy(reason) | 任务 1 |
| worker.runTask retry 逻辑 | 任务 2 |
| worker.finishTask deadline 保护 | 任务 3 |
| Config 变更（taskTimeoutMs / retryOnTimeout）| 任务 4 |
| 数据流 | 任务 1/2/3 实现 |
| 错误处理 | 任务 2/3 测试覆盖 |
| 测试章节（3 个测试文件）| 任务 1/2/3 |
| 部署 & 回滚 | 任务 5 |

**2. 占位符扫描：** 已检查 — 无 TODO / 待定 / 后续实现。

**3. 类型一致性：**
- `channel.rotateProxy(reason)` 在所有任务中签名一致
- `shouldRetryWithNewIp(result, channel)` 签名一致
- `result.status` 取值：`success` / `not_found` / `error` / `timeout`（与现有 service.js 一致）
- `channel.busy` 状态管理一致

**完成** — 计划覆盖全部规格需求，类型一致，无占位符。

---

## 执行交接

**计划已完成并保存到 `docs/superpowers/plans/2026-07-08-task-timeout-rotate-retry.md`。**

**两种执行方式：**

1. **子代理驱动（推荐）** - 每个任务调度一个新的子代理，任务间进行审查
2. **内联执行** - 在当前会话中使用 executing-plans 执行任务

我已经在主会话内采用**混合策略**：
- 任务 1 → 任务 2+4 并行 → 任务 3 → 任务 5
- 每个 subagent 完整 TDD + spec-reviewer + code-quality-reviewer

确认 OK 我就开始派 implementer subagent。