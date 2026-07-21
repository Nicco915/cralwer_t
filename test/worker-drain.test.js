const { describe, it } = require('node:test');
const assert = require('node:assert');
const { Worker } = require('../src/worker');

// Worker.drain 语义：只等待在途（busy）任务完成。
// 队列中未分发的任务不应阻塞 drain——两个调用方（service.stop /
// restartBrowser）调用 drain 时 loop 都已停，排队任务永远不会再被分发，
// 等队列清空就是死锁（生产事故：draining: queue=1, busy=0 死循环）。
// restartBrowser 场景下排队任务必须保留在队列里，等 worker.start() 后
// 分发到重启后的新 channel。

function makeWorker() {
  return new Worker({
    pusher: { push: async () => {} },
    log: () => {},
  });
}

describe('Worker.drain', () => {
  it('resolves when tasks are queued but the dispatch loop is not running', async () => {
    const worker = makeWorker();
    worker.pushTasks([{ crawlerTaskId: 'q1', sku: 'SKU1' }]);

    try {
      await Promise.race([
        worker.drain(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('drain deadlocked')), 2000)),
      ]);
    } finally {
      worker.taskQueue.length = 0; // 放行可能仍在死循环的旧 drain，让进程能退出
    }
  });

  it('keeps queued tasks in the queue for dispatch after restart', async () => {
    const worker = makeWorker();
    worker.pushTasks([{ crawlerTaskId: 'q1', sku: 'SKU1' }]);

    await worker.drain();

    assert.strictEqual(worker.taskQueue.length, 1);
    assert.strictEqual(worker.taskQueue[0].crawlerTaskId, 'q1');
  });

  it('waits for busy channels to finish', async () => {
    const worker = makeWorker();
    const channel = { id: 1, busy: true };
    worker.addChannel(channel);

    let drained = false;
    const drainPromise = worker.drain().then(() => { drained = true; });

    await new Promise(resolve => setTimeout(resolve, 700));
    assert.strictEqual(drained, false, 'drain should still be waiting for the busy channel');

    channel.busy = false;
    await drainPromise;
    assert.strictEqual(drained, true);
  });
});
