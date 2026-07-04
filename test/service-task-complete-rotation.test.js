const { describe, it } = require('node:test');
const assert = require('node:assert');
const { Channel } = require('../src/channel');
const { CrawlerService } = require('../src/service');

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

const browser = createMockBrowser();

describe('Task-complete proxy rotation', () => {
  it('Channel calls onTaskComplete after crawl finishes', async () => {
    let called = false;
    const channel = new Channel({
      id: 1,
      config: { nodeCode: 'crawler-01' },
      onTaskComplete: () => { called = true; },
      log: () => {},
    });

    await channel.init(browser);
    channel.pageCrawler.crawlSingleSku = async () => ({
      status: 'success',
      sku: 'TEST',
      product_name: 'Test',
      features_details: '',
      product_specification: '',
      product_url: 'https://example.com',
      error: '',
    });

    await channel.crawl({ crawlerTaskId: 1n, sku: 'TEST' });

    assert.strictEqual(called, true);
  });

  it('CrawlerService rotates proxy when channel needs rotation after task complete', async () => {
    const service = new CrawlerService({
      nodeCode: 'test-node',
      channels: 1,
      imageDir: '/tmp/test-task-complete-rotation',
    });

    let rotated = false;
    service.browser = { isConnected: () => true };
    service.proxyPool = {
      nextForChannel: async () => {
        rotated = true;
        return 'http://new-proxy:8080';
      },
    };

    const channel = {
      id: 1,
      busy: false,
      dataLayerFailureCount: 3,
      consecutiveFailures: 0,
      lastFailureWasProxy: false,
      needsProxyRotation: () => true,
      isHealthy: async () => true,
      reinit: async () => {},
    };
    service.channels = [channel];

    await service.checkChannelForRotation(channel);

    assert.strictEqual(rotated, true);
  });

  it('CrawlerService does not rotate proxy when channel does not need rotation', async () => {
    const service = new CrawlerService({
      nodeCode: 'test-node',
      channels: 1,
      imageDir: '/tmp/test-task-complete-no-rotation',
    });

    let rotated = false;
    service.browser = { isConnected: () => true };
    service.proxyPool = {
      nextForChannel: async () => {
        rotated = true;
        return 'http://new-proxy:8080';
      },
    };

    const channel = {
      id: 1,
      busy: false,
      dataLayerFailureCount: 0,
      consecutiveFailures: 0,
      lastFailureWasProxy: false,
      needsProxyRotation: () => false,
      isHealthy: async () => true,
      reinit: async () => {},
    };
    service.channels = [channel];

    await service.checkChannelForRotation(channel);

    assert.strictEqual(rotated, false);
  });
});
