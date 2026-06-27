const { describe, it } = require('node:test');
const assert = require('node:assert');
const { Worker } = require('../src/worker');

describe('Worker', () => {
  function createWorker(options = {}) {
    return new Worker({
      pusher: options.pusher || { push: async () => {} },
      log: () => {},
      maxQueueSize: options.maxQueueSize || 10,
    });
  }

  function createChannel(options = {}) {
    return {
      id: options.id || 1,
      busy: options.busy || false,
      crawl: options.crawl || (async () => ({
        status: 'success',
        sku: 'ABC-001',
        product_name: '',
        features_details: '',
        product_specification: '',
        product_url: '',
        error: '',
      })),
    };
  }

  describe('pushTasks', () => {
    it('deduplicates tasks with the same crawlerTaskId', () => {
      const worker = createWorker();
      const tasks = [
        { crawlerTaskId: 1n, sku: 'A' },
        { crawlerTaskId: 1n, sku: 'B' },
        { crawlerTaskId: 2n, sku: 'C' },
      ];
      worker.pushTasks(tasks);
      assert.strictEqual(worker.taskQueue.length, 2);
      assert.strictEqual(worker.taskQueue[0].sku, 'A');
      assert.strictEqual(worker.taskQueue[1].sku, 'C');
    });

    it('deduplicates tasks using id fallback', () => {
      const worker = createWorker();
      const tasks = [
        { id: 10n, sku: 'A' },
        { id: 10n, sku: 'B' },
      ];
      worker.pushTasks(tasks);
      assert.strictEqual(worker.taskQueue.length, 1);
    });

    it('does not deduplicate tasks without ids', () => {
      const worker = createWorker();
      const tasks = [{ sku: 'A' }, { sku: 'B' }];
      worker.pushTasks(tasks);
      assert.strictEqual(worker.taskQueue.length, 2);
    });
  });

  describe('hasCapacity', () => {
    it('returns true when there is an idle channel and empty queue', () => {
      const worker = createWorker();
      worker.addChannel(createChannel({ busy: false }));
      assert.strictEqual(worker.hasCapacity(), true);
    });

    it('returns false when all channels are busy', () => {
      const worker = createWorker();
      worker.addChannel(createChannel({ busy: true }));
      assert.strictEqual(worker.hasCapacity(), false);
    });

    it('returns false when queue is not empty', () => {
      const worker = createWorker();
      worker.addChannel(createChannel({ busy: false }));
      worker.pushTasks([{ crawlerTaskId: 1n, sku: 'A' }]);
      assert.strictEqual(worker.hasCapacity(), false);
    });
  });

  describe('timeout status propagation', () => {
    it('propagates timeout status from channel crawl error', async () => {
      const pushed = [];
      const worker = createWorker({
        pusher: {
          push: async (result) => {
            pushed.push(result);
          },
        },
      });
      const channel = createChannel({
        crawl: async () => {
          const err = new Error('Timeout 30000ms exceeded');
          err.status = 'timeout';
          throw err;
        },
      });
      worker.addChannel(channel);
      worker.pushTasks([{ crawlerTaskId: 1n, sku: 'TIMEOUT-SKU' }]);
      worker.start();
      await worker.drain();
      assert.strictEqual(pushed.length, 1);
      assert.strictEqual(pushed[0].status, 'timeout');
      assert.strictEqual(pushed[0].error, 'Timeout 30000ms exceeded');
    });
  });

  describe('inFlightTaskIds lifecycle', () => {
    it('removes task id from in-flight set after task completes', async () => {
      const worker = createWorker();
      const channel = createChannel({
        crawl: async () => ({
          crawlerTaskId: 1n,
          sku: 'A',
          status: 'success',
          product_name: '',
          features_details: '',
          product_specification: '',
          product_url: '',
          error: '',
        }),
      });
      worker.addChannel(channel);
      worker.pushTasks([{ crawlerTaskId: 1n, sku: 'A' }]);
      worker.start();
      await worker.drain();
      assert.strictEqual(worker.inFlightTaskIds.has('1'), false);
      assert.strictEqual(worker.taskQueue.length, 0);
    });
  });
});
