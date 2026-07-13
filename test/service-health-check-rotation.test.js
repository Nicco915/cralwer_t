const { describe, it } = require('node:test');
const assert = require('node:assert');
const { CrawlerService } = require('../src/service');

function createService() {
  const service = new CrawlerService({
    nodeCode: 'test-node',
    channels: 1,
    imageDir: '/tmp/test-health-rotation',
  });
  service.browser = { isConnected: () => true };
  service.proxyPool = {
    nextForChannel: async () => 'http://new-proxy:8080',
  };
  return service;
}

describe('CrawlerService runHealthCheck proxy rotation', () => {
  it('skips reinit when channel is busy', async () => {
    const service = createService();
    let reinitCalled = false;
    const channel = {
      id: 1,
      busy: true,
      dataLayerFailureCount: 5,
      consecutiveFailures: 0,
      lastFailureWasProxy: false,
      needsProxyRotation: () => true,
      isHealthy: async () => true,
      reinit: async () => { reinitCalled = true; },
      recordIpRotation: () => {},
    };
    service.channels = [channel];

    await service.runHealthCheck();

    assert.strictEqual(reinitCalled, false, 'busy channel should not be reinitialized');
  });

  it('reinitializes idle channel when dataLayer rotation is needed', async () => {
    const service = createService();
    let reinitCalled = false;
    const channel = {
      id: 1,
      busy: false,
      browserContext: {},
      page: {},
      dataLayerFailureCount: 5,
      consecutiveFailures: 0,
      lastFailureWasProxy: false,
      needsProxyRotation: () => true,
      isHealthy: async () => true,
      reinit: async () => { reinitCalled = true; },
      recordIpRotation: () => {},
    };
    service.channels = [channel];

    await service.runHealthCheck();

    assert.strictEqual(reinitCalled, true, 'idle channel with dataLayer failures should be reinitialized');
  });

  it('skips rotation for hibernated channel (reclaimed by idle reaper)', async () => {
    const service = createService();
    let rotationCalled = false;
    service.proxyPool = {
      nextForChannel: async () => { rotationCalled = true; return 'http://new-proxy:8080'; },
    };
    // 休眠回收后的 channel：browserContext/page 均为 null，
    // isHealthy() 对真实 Channel 会返回 false，但这不是故障——
    // 下个任务到来时 ensureContext() 会懒重建。
    const channel = {
      id: 1,
      busy: false,
      reinitializing: false,
      browserContext: null,
      page: null,
      dataLayerFailureCount: 0,
      consecutiveFailures: 0,
      lastFailureWasProxy: false,
      needsProxyRotation: () => false,
      isHealthy: async () => false,
      reinit: async () => { rotationCalled = true; },
      recordIpRotation: () => {},
    };
    service.channels = [channel];

    await service.runHealthCheck();

    assert.strictEqual(rotationCalled, false, 'hibernated channel should not trigger proxy rotation');
  });
});
