const { describe, it } = require('node:test');
const assert = require('node:assert');
const { Worker } = require('../src/worker');
const { RegionRegistry } = require('../src/region-registry');

function makePusher() {
  return { pushed: [], async push(r) { this.pushed.push(r); } };
}

function makeChannel() {
  return {
    id: 1,
    busy: false,
    reinitializing: false,
    onTaskComplete: null,
    crawlCalls: [],
    async crawl(task) {
      this.crawlCalls.push(task);
      return {
        sku: task.sku,
        status: 'success',
        product_name: 'X',
        product_url: `${task.baseUrl || ''}/p/X`,
        features_details: '',
        product_specification: '',
      };
    },
  };
}

function makeWorker() {
  const pusher = makePusher();
  const channel = makeChannel();
  const worker = new Worker({ pusher, log: () => {}, regionRegistry: new RegionRegistry() });
  return { worker, pusher, channel };
}

describe('Worker multi-region routing', () => {
  it('resolves task.regionCode to task.baseUrl and echoes regionCode on the result', async () => {
    const { worker, pusher, channel } = makeWorker();
    const result = await worker.runTask({ crawlerTaskId: 1, sku: 'S1', regionCode: 'CA' }, channel);
    assert.strictEqual(channel.crawlCalls.length, 1);
    assert.strictEqual(channel.crawlCalls[0].baseUrl, 'https://www.vevor.ca');
    assert.strictEqual(result.regionCode, 'CA');
    assert.strictEqual(pusher.pushed.length, 1);
    assert.strictEqual(pusher.pushed[0].regionCode, 'CA');
  });

  it('defaults missing regionCode to EU', async () => {
    const { worker, channel } = makeWorker();
    await worker.runTask({ crawlerTaskId: 2, sku: 'S2' }, channel);
    assert.strictEqual(channel.crawlCalls[0].baseUrl, 'https://eur.vevor.com');
    assert.strictEqual(channel.crawlCalls[0].regionCode, 'EU');
  });

  it('normalizes case/whitespace of regionCode', async () => {
    const { worker, channel } = makeWorker();
    await worker.runTask({ crawlerTaskId: 5, sku: 'S5', regionCode: '  gb ' }, channel);
    assert.strictEqual(channel.crawlCalls[0].baseUrl, 'https://www.vevor.co.uk');
    assert.strictEqual(channel.crawlCalls[0].regionCode, 'GB');
  });

  it('fails unknown regionCode fast without occupying the channel', async () => {
    const { worker, pusher, channel } = makeWorker();
    const result = await worker.runTask({ crawlerTaskId: 3, sku: 'S3', regionCode: 'AU' }, channel);
    assert.strictEqual(channel.crawlCalls.length, 0);
    assert.strictEqual(channel.busy, false);
    assert.strictEqual(result.status, 'error');
    assert.match(result.error, /unknown regionCode: AU/);
    assert.strictEqual(pusher.pushed.length, 1);
    assert.strictEqual(pusher.pushed[0].regionCode, 'AU');
  });

  it('fails disabled regionCode (CN) with a distinct message without crawling', async () => {
    const { worker, pusher, channel } = makeWorker();
    const result = await worker.runTask({ crawlerTaskId: 4, sku: 'S4', regionCode: 'CN' }, channel);
    assert.strictEqual(channel.crawlCalls.length, 0);
    assert.strictEqual(channel.busy, false);
    assert.match(result.error, /region CN has no target site \(disabled\)/);
    assert.strictEqual(pusher.pushed[0].regionCode, 'CN');
  });

  it('still works without a regionRegistry (legacy construction)', async () => {
    const pusher = makePusher();
    const channel = makeChannel();
    const worker = new Worker({ pusher, log: () => {} });
    await worker.runTask({ crawlerTaskId: 6, sku: 'S6' }, channel);
    assert.strictEqual(channel.crawlCalls.length, 1);
    assert.strictEqual(channel.crawlCalls[0].baseUrl, undefined);
  });
});
