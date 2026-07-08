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

  it('forces timeout push when finishPromise exceeds deadline', async () => {
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
      pusher: { push: async (r) => { pushed.push(r); } },
      log: () => {},
      taskTimeoutMs: 100,
    });

    await worker.runTask({ crawlerTaskId: 't1', sku: 'SKU' }, channel);

    assert.ok(pushed.some(r => r.status === 'timeout'), 'should push timeout result');
    assert.strictEqual(channel.busy, false, 'channel.busy must be reset even on deadline');
  });

  it('does NOT call onTaskComplete when deadline fires', async () => {
    let onTaskCompleteCalled = false;
    const channel = {
      id: 1,
      busy: false,
      reinitializing: false,
      crawl: async () => {
        await new Promise(r => setTimeout(r, 200));
        return { crawlerTaskId: 't1', sku: 'SKU', status: 'success' };
      },
      onTaskComplete: async () => {
        onTaskCompleteCalled = true;
        await new Promise(r => setTimeout(r, 300));
      },
    };
    const worker = new Worker({
      pusher: { push: async () => {} },
      log: () => {},
      taskTimeoutMs: 100,
    });

    await worker.runTask({ crawlerTaskId: 't1', sku: 'SKU' }, channel);

    await new Promise(r => setTimeout(r, 300));
    assert.strictEqual(onTaskCompleteCalled, false, 'onTaskComplete should not be invoked after deadline');
  });

  it('clears inFlightTaskIds when deadline fires', async () => {
    const channel = {
      id: 1, busy: false, reinitializing: false,
      crawl: async () => {
        await new Promise(r => setTimeout(r, 200));
        return { crawlerTaskId: '42', sku: 'SKU', status: 'success' };
      },
      onTaskComplete: async () => {},
    };
    const worker = new Worker({
      pusher: { push: async () => {} },
      log: () => {},
      taskTimeoutMs: 100,
    });

    await worker.runTask({ crawlerTaskId: '42', sku: 'SKU' }, channel);

    assert.strictEqual(worker.inFlightTaskIds.has('42'), false, 'should clear inFlightTaskIds');
  });

  it('respects custom taskTimeoutMs from config', async () => {
    const channel = {
      id: 1, busy: false, reinitializing: false,
      crawl: async () => {
        await new Promise(r => setTimeout(r, 200));
        return { crawlerTaskId: 't1', sku: 'SKU', status: 'success' };
      },
      onTaskComplete: async () => {},
    };
    const pushed = [];
    const worker = new Worker({
      pusher: { push: async (r) => { pushed.push(r); } },
      log: () => {},
      taskTimeoutMs: 50,
    });

    const start = Date.now();
    await worker.runTask({ crawlerTaskId: 't1', sku: 'SKU' }, channel);
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 200, `should return quickly after deadline, took ${elapsed}ms`);
  });

  it('logs but does not throw when forced timeout push fails', async () => {
    const logs = [];
    const channel = {
      id: 1, busy: false, reinitializing: false,
      crawl: async () => {
        await new Promise(r => setTimeout(r, 200));
        return { crawlerTaskId: 't1', sku: 'SKU', status: 'success' };
      },
      onTaskComplete: async () => {},
    };
    const worker = new Worker({
      pusher: { push: async () => { throw new Error('pusher down'); } },
      log: (msg) => { logs.push(msg); },
      taskTimeoutMs: 100,
    });

    await assert.doesNotReject(async () => {
      await worker.runTask({ crawlerTaskId: 't1', sku: 'SKU' }, channel);
    });

    assert.ok(logs.some(msg => msg.includes('Push failed')), 'should log push failure');
    assert.strictEqual(channel.busy, false);
  });

  it('pushes timeout only once when deadline fires during crawl', async () => {
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
          await new Promise(r => setTimeout(r, 10));
        },
      },
      log: () => {},
      taskTimeoutMs: 100,
    });

    await worker.runTask({ crawlerTaskId: 't1', sku: 'SKU' }, channel);
    await new Promise(r => setTimeout(r, 300));

    assert.strictEqual(pushed.length, 1, `expected 1 push but got ${pushed.length}`);
    assert.strictEqual(pushed[0].status, 'timeout');
    assert.strictEqual(channel.busy, false);
  });

  it('does not swallow non-deadline errors from rotateProxy', async () => {
    const pushed = [];
    let rotateCalls = 0;
    const channel = {
      id: 1,
      busy: false,
      reinitializing: false,
      crawl: async () => ({
        crawlerTaskId: 't1', sku: 'SKU', status: 'not_found',
        dataLayerFailed: true, dataLayerNotFound: false,
      }),
      rotateProxy: async () => {
        rotateCalls += 1;
        throw new Error('proxy rotation failed');
      },
      onTaskComplete: async () => {},
    };
    const worker = new Worker({
      pusher: { push: async (r) => { pushed.push(r); } },
      log: () => {},
      taskTimeoutMs: 5000,
    });
    worker.retryOnTimeout = true;

    await worker.runTask({ crawlerTaskId: 't1', sku: 'SKU' }, channel);

    assert.strictEqual(rotateCalls, 1);
    assert.strictEqual(pushed.length, 1);
    assert.strictEqual(pushed[0].status, 'error');
    assert.ok(pushed[0].error.includes('proxy rotation failed'));
  });

  it('does not rotate proxy when deadline fires before rotateProxy', async () => {
    let rotateCalls = 0;
    const channel = {
      id: 1,
      busy: false,
      reinitializing: false,
      crawl: async () => {
        await new Promise(r => setTimeout(r, 200));
        return {
          crawlerTaskId: 't1',
          sku: 'SKU',
          status: 'not_found',
          dataLayerFailed: true,
          dataLayerNotFound: false,
        };
      },
      rotateProxy: async () => {
        rotateCalls += 1;
        return { rotated: true, reason: 'success' };
      },
      onTaskComplete: async () => {},
    };
    const worker = new Worker({
      pusher: { push: async () => {} },
      log: () => {},
      taskTimeoutMs: 100,
    });
    worker.retryOnTimeout = true;

    await worker.runTask({ crawlerTaskId: 't1', sku: 'SKU' }, channel);
    await new Promise(r => setTimeout(r, 300));

    assert.strictEqual(rotateCalls, 0, 'rotateProxy should not be called after deadline');
  });

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
});
