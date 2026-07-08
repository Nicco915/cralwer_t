# Worker.runTask 边界清理实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 清理 `src/worker.js` 中 `runTask` 的三个边界问题：deadline 后避免白换代理、timeout 结果禁止二次推送、移除未使用的 `pendingPushes`。

**架构：** 在现有 `runTask` 内部做三处最小改动，不拆分函数；每个改动配一个测试用例，使用 `node:test` 框架。

**技术栈：** Node.js 22+，`node:test`，`node:assert`。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/worker.js` | 主实现：三处最小改动 |
| `test/worker-deadline.test.js` | 新增 deadline 相关边界测试 |
| `test/worker.test.js` | 新增 Worker 构造函数残留字段测试 |

---

### 任务 1：rotateProxy 前检查 `cancelled`

**文件：**
- 修改：`src/worker.js:133-138`
- 测试：`test/worker-deadline.test.js`

**背景：** 当前 `finishPromise` 在 crawl 返回 retry 条件结果后会直接调用 `channel.rotateProxy('task-timeout')`。如果此时 deadline 已经触发，`rotateProxy` 仍会执行，浪费一次 IP 轮换和浏览器重连。

- [ ] **步骤 1：编写失败的测试**

在 `test/worker-deadline.test.js` 末尾新增一个测试：

```js
  it('does not rotate proxy when deadline fires before rotateProxy', async () => {
    let rotateCalls = 0;
    const channel = {
      id: 1,
      busy: false,
      reinitializing: false,
      crawl: async () => ({
        crawlerTaskId: 't1',
        sku: 'SKU',
        status: 'not_found',
        dataLayerFailed: true,
        dataLayerNotFound: false,
      }),
      rotateProxy: async () => {
        rotateCalls += 1;
        return { rotated: true, reason: 'success' };
      },
      onTaskComplete: async () => {},
    };
    const worker = new Worker({
      pusher: { push: async () => {} },
      log: () => {},
      taskTimeoutMs: 50,
    });
    worker.retryOnTimeout = true;

    await worker.runTask({ crawlerTaskId: 't1', sku: 'SKU' }, channel);

    assert.strictEqual(rotateCalls, 0, 'rotateProxy should not be called after deadline');
  });
```

- [ ] **步骤 2：运行测试验证失败**

运行：
```bash
node --test test/worker-deadline.test.js
```

预期：FAIL，rotateCalls 为 1，断言期望为 0。

- [ ] **步骤 3：编写最少实现代码**

修改 `src/worker.js:133-138`，在 `rotateProxy` 调用前检查 `cancelled`：

```js
      if (this.shouldRetryWithNewIp(result, channel)) {
        this.log(`[Worker] task ${task.crawlerTaskId} failed (${result.status}); rotating IP and retrying`);
        if (cancelled) {
          this.log(`[Worker] task ${task.crawlerTaskId} retry cancelled: deadline already exceeded`);
          return result;
        }
        let rotated;
        try {
          rotated = await channel.rotateProxy('task-timeout');
```

- [ ] **步骤 4：运行测试验证通过**

运行：
```bash
node --test test/worker-deadline.test.js
```

预期：全部通过。

- [ ] **步骤 5：Commit**

```bash
git add src/worker.js test/worker-deadline.test.js
git commit -m "fix(worker): skip rotateProxy when deadline already exceeded"
```

---

### 任务 2：timeout 结果禁用 pusher fallback 二次推送

**文件：**
- 修改：`src/worker.js:218-233`
- 测试：`test/worker-deadline.test.js`

**背景：** 当前 push 失败的 catch 块会无条件把结果改为 `error` 再推一次。当原始结果已经是 `timeout` 时，这会导致上游收到 timeout + error 两个结果。

- [ ] **步骤 1：编写失败的测试**

在 `test/worker-deadline.test.js` 末尾新增一个测试：

```js
  it('does not fallback-push error for already-timeout result', async () => {
    const pushed = [];
    const channel = {
      id: 1,
      busy: false,
      reinitializing: false,
      crawl: async () => {
        await new Promise(r => setTimeout(r, 200));
        return { crawlerTaskId: 't1', sku: 'SKU', status: 'success', product_url: 'x' };
      },
      onTaskComplete: async () => {},
    };
    const worker = new Worker({
      pusher: {
        push: async (r) => {
          pushed.push(r);
          throw new Error('pusher down');
        },
      },
      log: () => {},
      taskTimeoutMs: 100,
    });

    await worker.runTask({ crawlerTaskId: 't1', sku: 'SKU' }, channel);

    assert.strictEqual(pushed.length, 1, `expected 1 push but got ${pushed.length}`);
    assert.strictEqual(pushed[0].status, 'timeout');
  });
```

- [ ] **步骤 2：运行测试验证失败**

运行：
```bash
node --test test/worker-deadline.test.js
```

预期：FAIL，`pushed.length` 为 2，断言期望为 1。

- [ ] **步骤 3：编写最少实现代码**

修改 `src/worker.js:218-233` 的 catch 块，对 `timeout` 状态跳过 fallback：

```js
      } catch (e) {
        this.log(`[Worker] Push failed task ${task.crawlerTaskId} sku ${task.sku}: ${e.message}`);
        if (result.status === 'timeout') {
          this.log(`[Worker] Skipping fallback error push for already-timeout task ${task.crawlerTaskId}`);
        } else {
          retries = 1;  // 触发了 fallback error push
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
      }
```

- [ ] **步骤 4：运行测试验证通过**

运行：
```bash
node --test test/worker-deadline.test.js
```

预期：全部通过。

- [ ] **步骤 5：Commit**

```bash
git add src/worker.js test/worker-deadline.test.js
git commit -m "fix(worker): suppress fallback error push when original result is timeout"
```

---

### 任务 3：清理 `pendingPushes` 残留

**文件：**
- 修改：`src/worker.js:18`、`src/worker.js:238`
- 测试：`test/worker.test.js`

**背景：** `Worker` 构造函数初始化了 `this.pendingPushes = new Set()`，`runTask` 里也 `delete(finishPromise)`，但从未 `add()`，且 `drain()` 不再等待它。

- [ ] **步骤 1：编写失败的测试**

在 `test/worker.test.js` 中新增一个测试：

```js
  describe('constructor', () => {
    it('does not expose unused pendingPushes set', () => {
      const worker = createWorker();
      assert.strictEqual(worker.pendingPushes, undefined, 'pendingPushes should be removed');
    });
  });
```

- [ ] **步骤 2：运行测试验证失败**

运行：
```bash
node --test test/worker.test.js
```

预期：FAIL，`worker.pendingPushes` 是一个 Set，断言期望为 `undefined`。

- [ ] **步骤 3：编写最少实现代码**

修改 `src/worker.js`：

1. 删除构造函数第 18 行：
```diff
-    this.pendingPushes = new Set();
```

2. 删除 `runTask` 资源清理段第 238 行：
```diff
-    this.pendingPushes.delete(finishPromise);
```

- [ ] **步骤 4：运行测试验证通过**

运行：
```bash
node --test test/worker.test.js
```

预期：全部通过。

- [ ] **步骤 5：Commit**

```bash
git add src/worker.js test/worker.test.js
git commit -m "refactor(worker): remove unused pendingPushes set"
```

---

## 自检

**1. 规格覆盖度：**
- rotateProxy 前检查 `cancelled` → 任务 1 ✓
- timeout 结果禁用 fallback error push → 任务 2 ✓
- 清理 `pendingPushes` → 任务 3 ✓

**2. 占位符扫描：** 无 TODO/TBD/模糊描述，每个步骤都有具体代码和命令。

**3. 类型一致性：** `cancelled` 为外层 `runTask` 已声明的 boolean；`result.status` 为字符串；`pendingPushes` 移除后不存在命名冲突。

---

## 执行交接

计划已完成并保存到 `docs/superpowers/plans/2026-07-08-worker-runtask-cleanup.md`。两种执行方式：

**1. 子代理驱动（推荐）** - 每个任务调度一个新的子代理，任务间进行审查，快速迭代

**2. 内联执行** - 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点

选哪种方式？
