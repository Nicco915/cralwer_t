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

function makeChannelWithFallbackResponse() {
  return {
    id: 1,
    busy: false,
    reinitializing: false,
    onTaskComplete: null,
    crawlCalls: [],
    async crawl(task) {
      this.crawlCalls.push(task);
      const baseUrl = task.baseUrl || '';
      if (baseUrl === 'https://www.vevor.com') {
        return {
          sku: task.sku,
          status: 'success',
          product_name: 'X',
          product_url: `${baseUrl}/p/X`,
          features_details: '',
          product_specification: '',
        };
      }
      return {
        sku: task.sku,
        status: 'not_found',
        error: 'Page shows no result',
        product_name: '',
        product_url: '',
        features_details: '',
        product_specification: '',
      };
    },
  };
}

function makeChannelReturningNotFound(error) {
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
        status: 'not_found',
        error,
        product_name: '',
        product_url: '',
        features_details: '',
        product_specification: '',
      };
    },
  };
}

describe('Worker no-result fallback to US', () => {
  [
    { code: 'GB', baseUrl: 'https://www.vevor.co.uk' },
    { code: 'EU', baseUrl: 'https://eur.vevor.com' },
    { code: 'CA', baseUrl: 'https://www.vevor.ca' },
  ].forEach(({ code, baseUrl }) => {
    it.todo(`${code} page shows no result -> fallback to US and keeps regionCode as ${code}`, async () => {
      const pusher = makePusher();
      const channel = makeChannelWithFallbackResponse();
      const worker = new Worker({ pusher, log: () => {}, regionRegistry: new RegionRegistry() });
      const task = { crawlerTaskId: 10, sku: 'S10', regionCode: code };
      const result = await worker.runTask(task, channel);

      assert.strictEqual(channel.crawlCalls.length, 2);
      assert.strictEqual(channel.crawlCalls[0].baseUrl, baseUrl);
      assert.strictEqual(channel.crawlCalls[1].baseUrl, 'https://www.vevor.com');
      assert.strictEqual(channel.crawlCalls[1].regionCode, code);
      assert.strictEqual(channel.crawlCalls[1].sku, task.sku);
      assert.strictEqual(channel.crawlCalls[1].crawlerTaskId, task.crawlerTaskId);
      assert.strictEqual(result.status, 'success');
      assert.strictEqual(result.regionCode, code);
      assert.strictEqual(pusher.pushed.length, 1);
      assert.strictEqual(pusher.pushed[0].regionCode, code);
    });
  });

  it('US page shows no result -> does not fallback again', async () => {
    const pusher = makePusher();
    const channel = makeChannelReturningNotFound('Page shows no result');
    const worker = new Worker({ pusher, log: () => {}, regionRegistry: new RegionRegistry() });
    const result = await worker.runTask({ crawlerTaskId: 13, sku: 'S13', regionCode: 'US' }, channel);

    assert.strictEqual(channel.crawlCalls.length, 1);
    assert.strictEqual(channel.crawlCalls[0].baseUrl, 'https://www.vevor.com');
    assert.strictEqual(result.status, 'not_found');
    assert.strictEqual(result.error, 'Page shows no result');
  });

  it('does not fallback for "No product URL found"', async () => {
    const pusher = makePusher();
    const channel = makeChannelReturningNotFound('No product URL found');
    const worker = new Worker({ pusher, log: () => {}, regionRegistry: new RegionRegistry() });
    const result = await worker.runTask({ crawlerTaskId: 14, sku: 'S14', regionCode: 'GB' }, channel);

    assert.strictEqual(channel.crawlCalls.length, 1);
    assert.strictEqual(result.status, 'not_found');
    assert.strictEqual(result.error, 'No product URL found');
  });

  it('does not fallback when US is disabled in RegionRegistry', async () => {
    const pusher = makePusher();
    const channel = makeChannelWithFallbackResponse();
    const worker = new Worker({
      pusher,
      log: () => {},
      regionRegistry: new RegionRegistry({ regions: 'US=' }),
    });
    const result = await worker.runTask({ crawlerTaskId: 15, sku: 'S15', regionCode: 'GB' }, channel);

    assert.strictEqual(channel.crawlCalls.length, 1);
    assert.strictEqual(result.status, 'not_found');
    assert.strictEqual(result.error, 'Page shows no result');
  });
});
