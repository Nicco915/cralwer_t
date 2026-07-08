# Worker.runTask 边界清理 — 设计文档

日期：2026-07-08
状态：用户批准（方案 A：最小侵入式修复）

## 背景

task-timeout-rotate-retry 主实现已落地：

- `src/worker.js` 的 `runTask` 内用 `finishPromise` 包裹 crawl + 一次 IP 轮换重试；
- 外层用 `Promise.race([finishPromise, deadlinePromise])` 做 130s 兜底；
- `cancelled` 标记用于 deadline 触发后让 `finishPromise` 内部提前返回。

实现后留下三个边界问题：

1. **代理可能白换**：`finishPromise` 在 crawl 结束后、正要调用 `channel.rotateProxy()` 时，如果 deadline 触发，`cancelled` 不会中断已经启动的 `rotateProxy()`，导致浪费一次 IP 轮换和浏览器重连。
2. **timeout 可能二次推送**：push 失败的 fallback 会把任意结果改为 `error` 再推一次。当原始结果已经是 `timeout` 时，这会让上游收到一个 timeout 和一个 error，状态混乱。
3. **`pendingPushes` 是残留代码**：构造函数初始化了 `this.pendingPushes = new Set()`，`runTask` 里也 `delete(finishPromise)`，但从未 `add()`，且 `drain()` 不再等待它。

## 目标

1. 在调用 `channel.rotateProxy()` 前再次检查 `cancelled`，避免 deadline 后浪费代理轮换。
2. 当原始结果状态为 `timeout` 时，禁用 pusher fallback 的二次 `error` 推送。
3. 移除 `Worker` 中未使用的 `pendingPushes` 集合。

## 非目标

- 不重构 `runTask` 的整体结构（如提取 `finishTask`）。
- 不修改 `channel.rotateProxy()` 内部实现。
- 不新增配置开关：timeout 不二次推送是固定行为。

## 设计

### 1. rotateProxy 前检查 `cancelled`

**位置：** `src/worker.js:133-138`

在 `shouldRetryWithNewIp` 通过之后、`rotateProxy` 调用之前插入检查：

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

**效果：** deadline 一旦触发，即使 crawl 刚好返回 retry 条件结果，也不会再发起一次代理轮换。

### 2. `timeout` 结果禁用 pusher fallback 二次推送

**位置：** `src/worker.js:218-233`

当前 catch 块无条件将结果改为 `error` 再推一次。修改后先判断原始状态：

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

**效果：** 上游对 timeout 任务只收到一个 timeout 状态，不会因为 pusher 临时失败而被覆盖成 error。

### 3. 清理 `pendingPushes` 残留

**位置：**
- `src/worker.js:18` 删除 `this.pendingPushes = new Set();`
- `src/worker.js:238` 删除 `this.pendingPushes.delete(finishPromise);`

**效果：** `Worker` 不再维护一个从未被正确使用的集合，避免误导后续维护者。

## 测试

| 文件 | 用例 |
|---|---|
| `test/worker-deadline.test.js` | deadline 触发后，即使 crawl 返回 retry 条件结果，`channel.rotateProxy` 不被调用 |
| `test/worker-deadline.test.js` | timeout 结果 push 失败时，`pusher.push` 只被调用一次（不补发 error） |
| `test/worker.test.js` | Worker 实例不包含 `pendingPushes` 属性 |

## 文件变更

| 文件 | 变更 |
|---|---|
| `src/worker.js` | 三处最小改动（见上方） |
| `test/worker-deadline.test.js` | 新增 2 个测试 |
| `test/worker.test.js` | 新增 1 个测试 |

## Revert

单个 commit，可直接 revert：

```bash
git revert <commit-sha>
```
