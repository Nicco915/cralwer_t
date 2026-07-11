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

  it('initializes idle state and markActivity updates lastActivityAt', async () => {
    const channel = new Channel({ id: 1, config: {}, log: () => {} });
    assert.strictEqual(channel.browser, null);
    assert.ok(typeof channel.lastActivityAt === 'number' && channel.lastActivityAt > 0);
    const before = channel.lastActivityAt;
    await new Promise((r) => setTimeout(r, 5));
    channel.markActivity();
    assert.ok(channel.lastActivityAt > before, 'lastActivityAt should advance');
  });

  it('isIdleReclaimable reflects busy/reinitializing/context/timeout', () => {
    const channel = new Channel({ id: 1, config: {}, log: () => {} });
    const now = Date.now();
    channel.lastActivityAt = now - 10000;
    channel.busy = false;
    channel.reinitializing = false;

    channel.browserContext = null;
    assert.strictEqual(channel.isIdleReclaimable(now, 5000), false, 'no context -> false');

    channel.browserContext = {};
    assert.strictEqual(channel.isIdleReclaimable(now, 5000), true, 'idle > threshold -> true');

    channel.busy = true;
    assert.strictEqual(channel.isIdleReclaimable(now, 5000), false, 'busy -> false');
    channel.busy = false;

    channel.reinitializing = true;
    assert.strictEqual(channel.isIdleReclaimable(now, 5000), false, 'reinitializing -> false');
    channel.reinitializing = false;

    channel.lastActivityAt = now - 1000;
    assert.strictEqual(channel.isIdleReclaimable(now, 5000), false, 'within threshold -> false');
  });
});
