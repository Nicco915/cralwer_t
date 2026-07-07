const { describe, it } = require('node:test');
const assert = require('node:assert');
const { Worker } = require('../src/worker');

function makeMockChannel(id, behavior) {
  return {
    id,
    busy: false,
    crawl: async () => {
      if (behavior.throwError) {
        const e = new Error(behavior.throwError.message);
        if (behavior.throwError.status) e.status = behavior.throwError.status;
        throw e;
      }
      return behavior.result;
    },
  };
}

class FakePusher {
  async push() { /* noop */ }
}

describe('Worker task event logging', { timeout: 15000 }, () => {
  it('emits one task event log line per runTask (success case)', async () => {
    const lines = [];
    const { createStdoutLogger } = require('../src/logger');
    const logger = createStdoutLogger({ nodeCode: 'evt-node', write: l => lines.push(l) });
    const channel = makeMockChannel(1, {
      result: {
        crawlerTaskId: 100,
        sku: 'SKU-T-1',
        status: 'success',
        product_name: '',
        features_details: '',
        product_specification: '',
        product_url: '',
      },
    });
    const worker = new Worker({ pusher: new FakePusher(), logger });
    worker.addChannel(channel);

    await worker.runTask({ crawlerTaskId: 100, sku: 'SKU-T-1' }, channel);
    await new Promise(r => setTimeout(r, 50));

    const events = lines.map(l => JSON.parse(l)).filter(e => e.component === 'task');
    assert.strictEqual(events.length, 1, 'one task event expected');
    assert.strictEqual(events[0].status, 'success');
    assert.strictEqual(events[0].sku, 'SKU-T-1');
    assert.strictEqual(events[0].channelId, 1);
    assert.ok(typeof events[0].durationMs === 'number');
    assert.ok(typeof events[0].crawlerTaskId === 'number' || typeof events[0].crawlerTaskId === 'string');
  });

  it('emits task event with status=error when crawl throws', async () => {
    const lines = [];
    const { createStdoutLogger } = require('../src/logger');
    const logger = createStdoutLogger({ nodeCode: 'evt-node', write: l => lines.push(l) });
    const channel = makeMockChannel(2, {
      throwError: { message: 'boom', status: 'error' },
    });
    const worker = new Worker({ pusher: new FakePusher(), logger });
    worker.addChannel(channel);

    await worker.runTask({ crawlerTaskId: 200, sku: 'SKU-T-2' }, channel);
    await new Promise(r => setTimeout(r, 50));

    const events = lines.map(l => JSON.parse(l)).filter(e => e.component === 'task');
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].status, 'error');
    assert.strictEqual(events[0].error, 'boom');
  });

  it('emits task event with status=timeout when crawl times out', async () => {
    const lines = [];
    const { createStdoutLogger } = require('../src/logger');
    const logger = createStdoutLogger({ nodeCode: 'evt-node', write: l => lines.push(l) });
    const channel = makeMockChannel(3, {
      throwError: { message: 'Timeout 30000ms exceeded', status: 'timeout' },
    });
    const worker = new Worker({ pusher: new FakePusher(), logger });
    worker.addChannel(channel);

    await worker.runTask({ crawlerTaskId: 300, sku: 'SKU-T-3' }, channel);
    await new Promise(r => setTimeout(r, 50));

    const events = lines.map(l => JSON.parse(l)).filter(e => e.component === 'task');
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].status, 'timeout');
  });

  it('emits task event with status=error when pusher.push fails after successful crawl', async () => {
    const lines = [];
    const { createStdoutLogger } = require('../src/logger');
    const logger = createStdoutLogger({ nodeCode: 'evt-node', write: l => lines.push(l) });
    const channel = makeMockChannel(4, {
      result: { crawlerTaskId: 400, sku: 'SKU-T-4', status: 'success', product_name: '', features_details: '', product_specification: '', product_url: '' },
    });
    class FailingPusher {
      async push() { throw new Error('callback down'); }
    }
    const worker = new Worker({ pusher: new FailingPusher(), logger });
    worker.addChannel(channel);

    await worker.runTask({ crawlerTaskId: 400, sku: 'SKU-T-4' }, channel);
    await new Promise(r => setTimeout(r, 50));

    const events = lines.map(l => JSON.parse(l)).filter(e => e.component === 'task');
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].status, 'error');
    assert.strictEqual(events[0].error, 'callback down');
    assert.strictEqual(events[0].retries, 1);
  });
});