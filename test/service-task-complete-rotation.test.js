const { describe, it } = require('node:test');
const assert = require('node:assert');
const { CrawlerService } = require('../src/service');

describe('Task-complete proxy rotation', () => {
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
      browserContext: {},
      page: {},
      dataLayerFailureCount: 3,
      consecutiveFailures: 0,
      lastFailureWasProxy: false,
      needsProxyRotation: () => true,
      isHealthy: async () => true,
      reinit: async () => {},
      recordIpRotation: () => {},
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
      browserContext: {},
      page: {},
      dataLayerFailureCount: 0,
      consecutiveFailures: 0,
      lastFailureWasProxy: false,
      needsProxyRotation: () => false,
      isHealthy: async () => true,
      reinit: async () => {},
      recordIpRotation: () => {},
    };
    service.channels = [channel];

    await service.checkChannelForRotation(channel);

    assert.strictEqual(rotated, false);
  });

  it('sets reinitializing flag during proxy rotation', async () => {
    const service = new CrawlerService({
      nodeCode: 'test-node',
      channels: 1,
      imageDir: '/tmp/test-task-complete-reinit-flag',
    });

    service.browser = { isConnected: () => true };
    service.proxyPool = {
      nextForChannel: async () => 'http://new-proxy:8080',
    };

    const flags = [];
    const channel = {
      id: 1,
      busy: false,
      reinitializing: false,
      browserContext: {},
      page: {},
      dataLayerFailureCount: 3,
      consecutiveFailures: 0,
      lastFailureWasProxy: false,
      needsProxyRotation: () => true,
      isHealthy: async () => true,
      reinit: async () => {
        flags.push(channel.reinitializing);
      },
      recordIpRotation: () => {},
    };
    service.channels = [channel];

    await service.checkChannelForRotation(channel);

    assert.deepStrictEqual(flags, [true]);
    assert.strictEqual(channel.reinitializing, false);
  });
});
