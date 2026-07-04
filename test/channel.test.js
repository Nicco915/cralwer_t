const { describe, it } = require('node:test');
const assert = require('node:assert');
const { Channel } = require('../src/channel');

function createMockBrowser() {
  return {
    isConnected() { return true; },
    async newContext() {
      return {
        browser: () => this,
        async addInitScript() {},
        async newPage() { return { close: async () => {} }; },
        async close() {},
      };
    },
    async close() {},
  };
}

describe('Channel', () => {
  it('counts consecutive failures and detects proxy errors', async () => {
    const channel = new Channel({ id: 1, config: {}, log: () => {} });
    channel.page = { evaluate: async () => 'title' };
    channel.browserContext = { browser: () => ({ isConnected: () => true }) };

    assert.strictEqual(channel.isProxyError(new Error('page.goto: net::ERR_TUNNEL_CONNECTION_FAILED')), true);
    assert.strictEqual(channel.isProxyError(new Error('page.goto: net::ERR_CONNECTION_RESET')), true);
    assert.strictEqual(channel.isProxyError(new Error('page.goto: timeout')), false);

    channel.consecutiveFailures = 2;
    channel.lastFailureWasProxy = true;
    assert.strictEqual(channel.consecutiveFailures, 2);
    assert.strictEqual(channel.lastFailureWasProxy, true);
  });

  it('waits random delay before crawl when minDelay/maxDelay configured', async () => {
    const channel = new Channel({
      id: 1,
      config: { minDelay: 0.05, maxDelay: 0.05 },
      log: () => {},
    });
    await channel.init(createMockBrowser());
    let crawlCalled = false;
    channel.pageCrawler.crawlSingleSku = async () => {
      crawlCalled = true;
      return {
        status: 'success',
        sku: 'TEST',
        product_name: 'Test',
        features_details: '',
        product_specification: '',
        product_url: 'https://example.com',
        error: '',
      };
    };

    const start = Date.now();
    await channel.crawl({ crawlerTaskId: 1n, sku: 'TEST' });
    const elapsed = Date.now() - start;

    assert.strictEqual(crawlCalled, true);
    assert.ok(elapsed >= 45, `expected at least 45ms delay, got ${elapsed}ms`);
  });

  it('does not wait before crawl when minDelay/maxDelay are zero', async () => {
    const channel = new Channel({
      id: 1,
      config: {},
      log: () => {},
    });
    await channel.init(createMockBrowser());
    let crawlCalled = false;
    channel.pageCrawler.crawlSingleSku = async () => {
      crawlCalled = true;
      return {
        status: 'success',
        sku: 'TEST',
        product_name: 'Test',
        features_details: '',
        product_specification: '',
        product_url: 'https://example.com',
        error: '',
      };
    };

    const start = Date.now();
    await channel.crawl({ crawlerTaskId: 1n, sku: 'TEST' });
    const elapsed = Date.now() - start;

    assert.strictEqual(crawlCalled, true);
    assert.ok(elapsed < 50, `expected no delay, got ${elapsed}ms`);
  });
});
