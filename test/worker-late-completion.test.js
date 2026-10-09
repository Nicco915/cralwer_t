const { describe, it } = require('node:test');
const assert = require('node:assert');
const { Worker } = require('../src/worker');
const { Channel } = require('../src/channel');

// 方案 A（任务令牌 / epoch）防污染：worker deadline 超时后，
// channel 上仍在跑的僵尸 crawl 迟到完成时不得再触碰 channel 状态、
// 不得二次 push / 二次 onTaskComplete / 污染失败计数，且 rejection 必须被吞。

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeRealChannel(logs) {
  const channel = new Channel({ id: 1, config: {}, log: (m) => logs.push(m) });
  channel.ensureContext = async () => {};
  channel.pageCrawler.randomDelay = () => 0;
  return channel;
}

describe('Worker late completion (zombie crawl after deadline)', () => {
  it('drops late zombie resolve: no double push, no busy flip, no onTaskComplete, channel state untouched', async () => {
    const pushed = [];
    const workerLogs = [];
    const channelLogs = [];
    const zombie = deferred();
    let onTaskCompleteCalls = 0;

    const channel = makeRealChannel(channelLogs);
    channel.pageCrawler.crawlSingleSku = async () => zombie.promise;
    channel.onTaskComplete = async () => { onTaskCompleteCalls++; };

    const worker = new Worker({
      pusher: { push: async (r) => { pushed.push(r); } },
      log: (m) => workerLogs.push(m),
      taskTimeoutMs: 50,
    });

    const task = { crawlerTaskId: 't1', sku: 'SKU-1' };
    const runPromise = worker.runTask(task, channel);
    const result = await runPromise;

    // deadline 路径：恰好一次 timeout push，busy 复位，onTaskComplete 不调
    assert.strictEqual(result.status, 'timeout');
    assert.strictEqual(pushed.length, 1);
    assert.strictEqual(pushed[0].status, 'timeout');
    assert.strictEqual(channel.busy, false);
    assert.strictEqual(onTaskCompleteCalls, 0);

    // 模拟 channel 已被新任务接管（busy 重新置 true）
    channel.busy = true;
    const failuresBefore = channel.consecutiveFailures;
    const refreshBefore = channel.tasksSincePageRefresh;

    // 僵尸迟到 resolve（成功结果）
    zombie.resolve({ status: 'success', product_name: 'x', product_url: 'u', images: [] });
    await new Promise(r => setTimeout(r, 50));

    assert.strictEqual(pushed.length, 1, `no second push, got ${pushed.length}`);
    assert.strictEqual(channel.busy, true, 'zombie must not flip busy of the new task');
    assert.strictEqual(onTaskCompleteCalls, 0, 'zombie must not trigger onTaskComplete');
    assert.strictEqual(channel.consecutiveFailures, failuresBefore, 'zombie must not touch failure counter');
    assert.strictEqual(channel.tasksSincePageRefresh, refreshBefore, 'zombie must not bump refresh counter');
    assert.strictEqual(channel.currentTask, null, 'zombie must not clobber currentTask marker');
    assert.ok(
      workerLogs.some(m => m.includes('late completion dropped') && m.includes('t1')),
      'worker should log late completion dropped',
    );
    assert.ok(
      channelLogs.some(m => m.includes('late completion dropped') && m.includes('t1')),
      'channel should log late completion dropped',
    );
  });

  it('swallows late zombie rejection: no unhandledRejection, no failure-count pollution', async () => {
    const pushed = [];
    const channelLogs = [];
    const zombie = deferred();
    const unhandled = [];
    const onUnhandled = (err) => { unhandled.push(err); };
    process.on('unhandledRejection', onUnhandled);

    try {
      const channel = makeRealChannel(channelLogs);
      channel.pageCrawler.crawlSingleSku = async () => zombie.promise;

      const worker = new Worker({
        pusher: { push: async (r) => { pushed.push(r); } },
        log: () => {},
        taskTimeoutMs: 50,
      });

      await worker.runTask({ crawlerTaskId: 't2', sku: 'SKU-2' }, channel);
      assert.strictEqual(pushed.length, 1);
      assert.strictEqual(pushed[0].status, 'timeout');

      // 僵尸迟到 reject（如 page 被关导致的 TargetClosedError）
      zombie.reject(new Error('Target closed'));
      await new Promise(r => setTimeout(r, 50));

      assert.strictEqual(unhandled.length, 0, `no unhandledRejection, got: ${unhandled.map(e => e.message)}`);
      assert.strictEqual(pushed.length, 1, 'no second push');
      assert.strictEqual(channel.consecutiveFailures, 0, 'zombie rejection must not bump consecutiveFailures');
      assert.strictEqual(channel.lastFailureWasProxy, false, 'zombie rejection must not touch lastFailureWasProxy');
      assert.strictEqual(channel.tasksSincePageRefresh, 0, 'zombie rejection must not bump refresh counter');
      assert.ok(
        channelLogs.some(m => m.includes('late completion dropped') && m.includes('t2')),
        'channel should log late completion dropped',
      );
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });

  it('new task on same channel after deadline is unaffected by predecessor zombie', async () => {
    const pushed = [];
    const channelLogs = [];
    const zombie = deferred();
    let crawlCalls = 0;

    const channel = makeRealChannel(channelLogs);
    channel.pageCrawler.crawlSingleSku = async () => {
      crawlCalls++;
      if (crawlCalls === 1) return zombie.promise; // 第一个任务变僵尸
      return { status: 'success', product_name: 'n2', product_url: 'u2', images: [] };
    };

    const worker = new Worker({
      pusher: { push: async (r) => { pushed.push(r); } },
      log: () => {},
      taskTimeoutMs: 50,
    });

    // 任务 1：超时
    await worker.runTask({ crawlerTaskId: 't1', sku: 'SKU-1' }, channel);
    assert.strictEqual(pushed.length, 1);
    assert.strictEqual(pushed[0].status, 'timeout');

    // 任务 2：同一 channel，正常完成（此时僵尸仍在跑）
    const result2 = await worker.runTask({ crawlerTaskId: 't3', sku: 'SKU-3' }, channel);
    assert.strictEqual(result2.status, 'success');
    assert.strictEqual(pushed.length, 2);
    assert.strictEqual(pushed[1].status, 'success');
    assert.strictEqual(pushed[1].crawlerTaskId, 't3');
    assert.strictEqual(channel.tasksSincePageRefresh, 1, 'only the new task counts toward refresh');
    assert.strictEqual(channel.consecutiveFailures, 0);
    assert.strictEqual(channel.currentTask, null);

    // 僵尸随后迟到 resolve：不得影响任务 2 已落账的状态
    zombie.resolve({ status: 'success', product_name: 'zombie', product_url: 'uz', images: [] });
    await new Promise(r => setTimeout(r, 50));

    assert.strictEqual(pushed.length, 2, `zombie must not push, got ${pushed.length}`);
    assert.strictEqual(channel.tasksSincePageRefresh, 1, 'zombie must not bump refresh counter');
    assert.strictEqual(channel.consecutiveFailures, 0);
    assert.strictEqual(channel.currentTask, null);
    assert.strictEqual(channel.busy, false);
    assert.ok(
      channelLogs.some(m => m.includes('late completion dropped') && m.includes('t1')),
      'channel should log late completion dropped',
    );
  });

  it('cancelActiveCrawl during in-flight crawl voids its completion-side state mutations', async () => {
    // 纯 channel 层：不等 worker deadline，直接 cancelActiveCrawl 作废在途 crawl
    const channelLogs = [];
    const zombie = deferred();
    const channel = makeRealChannel(channelLogs);
    channel.pageCrawler.crawlSingleSku = async () => zombie.promise;

    const crawlPromise = channel.crawl({ crawlerTaskId: 't9', sku: 'SKU-9' });
    channel.cancelActiveCrawl();

    zombie.reject(new Error('page.goto: net::ERR_TUNNEL_CONNECTION_FAILED'));
    await assert.rejects(crawlPromise, /ERR_TUNNEL_CONNECTION_FAILED/);

    assert.strictEqual(channel.consecutiveFailures, 0, 'voided crawl must not count failure');
    assert.strictEqual(channel.lastFailureWasProxy, false, 'voided crawl must not mark proxy failure');
    assert.strictEqual(channel.tasksSincePageRefresh, 0);
    assert.strictEqual(channel.currentTask, null);
    assert.ok(channelLogs.some(m => m.includes('late completion dropped') && m.includes('t9')));
  });

  it('normal (non-timeout) task behavior is unchanged: counts and cleanup still happen', async () => {
    const pushed = [];
    let onTaskCompleteCalls = 0;
    const channel = makeRealChannel([]);
    channel.pageCrawler.crawlSingleSku = async () => ({
      status: 'success', product_name: 'n', product_url: 'u', images: [],
    });
    channel.onTaskComplete = async () => { onTaskCompleteCalls++; };

    const worker = new Worker({
      pusher: { push: async (r) => { pushed.push(r); } },
      log: () => {},
      taskTimeoutMs: 5000,
    });

    const result = await worker.runTask({ crawlerTaskId: 't4', sku: 'SKU-4' }, channel);

    assert.strictEqual(result.status, 'success');
    assert.strictEqual(pushed.length, 1);
    assert.strictEqual(pushed[0].status, 'success');
    assert.strictEqual(onTaskCompleteCalls, 1, 'onTaskComplete runs on normal completion');
    assert.strictEqual(channel.busy, false);
    assert.strictEqual(channel.tasksSincePageRefresh, 1, 'normal completion still counts toward refresh');
    assert.strictEqual(channel.currentTask, null);
  });
});
