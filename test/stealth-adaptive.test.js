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

const browser = createMockBrowser();

describe('Channel adaptive stealth mode', () => {
  it('starts in channel-like effective mode', async () => {
    const channel = new Channel({
      id: 1,
      config: {
        nodeCode: 'crawler-01',
        stealthMode: 'adaptive',
        adaptiveTimeoutThreshold: 2,
        adaptiveRecoverySuccesses: 3,
      },
      log: () => {},
    });

    assert.strictEqual(channel.stealthMode, 'adaptive');
    assert.strictEqual(channel.effectiveStealthMode, 'channel');
  });

  it('switches to session after consecutive timeouts', async () => {
    const logs = [];
    const channel = new Channel({
      id: 1,
      config: {
        nodeCode: 'crawler-01',
        stealthMode: 'adaptive',
        adaptiveTimeoutThreshold: 2,
        adaptiveRecoverySuccesses: 3,
      },
      log: (msg) => logs.push(msg),
    });

    await channel.init(browser);
    const initialProfile = channel.profile.signature;

    channel.updateAdaptiveState('timeout', true);
    assert.strictEqual(channel.effectiveStealthMode, 'channel');

    channel.updateAdaptiveState('timeout', true);
    assert.strictEqual(channel.effectiveStealthMode, 'session');
    assert.ok(logs.some(msg => msg.includes('switching to session mode')));

    await channel.recreateContext(browser);
    assert.notStrictEqual(channel.profile.signature, initialProfile);
  });

  it('switches back to channel after consecutive successes', async () => {
    const logs = [];
    const channel = new Channel({
      id: 1,
      config: {
        nodeCode: 'crawler-01',
        stealthMode: 'adaptive',
        adaptiveTimeoutThreshold: 2,
        adaptiveRecoverySuccesses: 3,
      },
      log: (msg) => logs.push(msg),
    });

    await channel.init(browser);
    channel.updateAdaptiveState('timeout', true);
    channel.updateAdaptiveState('timeout', true);
    assert.strictEqual(channel.effectiveStealthMode, 'session');

    channel.updateAdaptiveState('success', false);
    channel.updateAdaptiveState('success', false);
    assert.strictEqual(channel.effectiveStealthMode, 'session');

    channel.updateAdaptiveState('success', false);
    assert.strictEqual(channel.effectiveStealthMode, 'channel');
    assert.ok(logs.some(msg => msg.includes('switching back to channel mode')));
  });

  it('resets timeout counter on non-timeout results', async () => {
    const channel = new Channel({
      id: 1,
      config: {
        nodeCode: 'crawler-01',
        stealthMode: 'adaptive',
        adaptiveTimeoutThreshold: 2,
        adaptiveRecoverySuccesses: 3,
      },
      log: () => {},
    });

    channel.updateAdaptiveState('timeout', true);
    channel.updateAdaptiveState('error', false);
    assert.strictEqual(channel.effectiveStealthMode, 'channel');
    assert.strictEqual(channel.consecutiveTimeouts, 0);

    channel.updateAdaptiveState('timeout', true);
    channel.updateAdaptiveState('timeout', true);
    assert.strictEqual(channel.effectiveStealthMode, 'session');
  });

  it('does not switch modes in plain channel mode', async () => {
    const channel = new Channel({
      id: 1,
      config: {
        nodeCode: 'crawler-01',
        stealthMode: 'channel',
      },
      log: () => {},
    });

    channel.updateAdaptiveState('timeout', true);
    channel.updateAdaptiveState('timeout', true);
    channel.updateAdaptiveState('timeout', true);
    assert.strictEqual(channel.stealthMode, 'channel');
    assert.strictEqual(channel.effectiveStealthMode, 'channel');
  });

  it('switches to session after consecutive dataLayer failures', async () => {
    const logs = [];
    const channel = new Channel({
      id: 1,
      config: {
        nodeCode: 'crawler-01',
        stealthMode: 'adaptive',
        adaptiveTimeoutThreshold: 2,
        adaptiveDataLayerThreshold: 2,
      },
      log: (msg) => logs.push(msg),
    });

    await channel.init(browser);
    channel.dataLayerFailureCount = 2;
    channel.updateAdaptiveState('not_found', false, true);
    assert.strictEqual(channel.effectiveStealthMode, 'channel');

    channel.updateAdaptiveState('not_found', false, true);
    assert.strictEqual(channel.effectiveStealthMode, 'session');
    assert.ok(logs.some(msg => msg.includes('dataLayer failures')));
  });

  it('recreates browser context when adaptive switches to session after dataLayer failure', async () => {
    let newContextCount = 0;
    let closeCount = 0;
    const trackingBrowser = {
      isConnected() { return true; },
      async newContext() {
        newContextCount++;
        return {
          browser: () => this,
          async addInitScript() {},
          async newPage() { return { close: async () => {} }; },
          async close() { closeCount++; },
        };
      },
      async close() {},
    };

    const channel = new Channel({
      id: 1,
      config: {
        nodeCode: 'crawler-01',
        stealthMode: 'adaptive',
        adaptiveTimeoutThreshold: 1,
        adaptiveDataLayerThreshold: 1,
        dataLayerProxyRotationThreshold: 99,
      },
      log: () => {},
    });

    await channel.init(trackingBrowser);
    const initialProfile = channel.profile.signature;

    channel.pageCrawler.crawlSingleSku = async () => ({
      status: 'not_found',
      sku: 'TEST',
      product_name: '',
      features_details: '',
      product_specification: '',
      product_url: '',
      error: '',
      dataLayerFailed: true,
    });

    await channel.crawl({ crawlerTaskId: 1n, sku: 'TEST' });

    assert.strictEqual(channel.effectiveStealthMode, 'session');
    assert.strictEqual(newContextCount, 2, 'expected context to be recreated');
    assert.strictEqual(closeCount, 1, 'expected old context to be closed');
    assert.notStrictEqual(channel.profile.signature, initialProfile);
  });

  it('recreates browser context when adaptive switches back to channel after successes', async () => {
    let newContextCount = 0;
    let closeCount = 0;
    const trackingBrowser = {
      isConnected() { return true; },
      async newContext() {
        newContextCount++;
        return {
          browser: () => this,
          async addInitScript() {},
          async newPage() { return { close: async () => {} }; },
          async close() { closeCount++; },
        };
      },
      async close() {},
    };

    const channel = new Channel({
      id: 1,
      config: {
        nodeCode: 'crawler-01',
        stealthMode: 'adaptive',
        adaptiveTimeoutThreshold: 1,
        adaptiveRecoverySuccesses: 2,
        dataLayerProxyRotationThreshold: 99,
      },
      log: () => {},
    });

    await channel.init(trackingBrowser);
    channel.updateAdaptiveState('timeout', true);
    await channel.recreateContext(trackingBrowser);
    assert.strictEqual(channel.effectiveStealthMode, 'session');

    channel.pageCrawler.crawlSingleSku = async () => ({
      status: 'success',
      sku: 'TEST',
      product_name: 'Test',
      features_details: '',
      product_specification: '',
      product_url: 'https://example.com',
      error: '',
    });

    newContextCount = 0;
    closeCount = 0;

    await channel.crawl({ crawlerTaskId: 1n, sku: 'TEST' });
    assert.strictEqual(channel.effectiveStealthMode, 'session');

    await channel.crawl({ crawlerTaskId: 2n, sku: 'TEST' });
    assert.strictEqual(channel.effectiveStealthMode, 'channel');
    assert.ok(newContextCount >= 1, 'expected context to be recreated after switching back to channel');
    assert.ok(closeCount >= 1, 'expected old context to be closed');
  });

  it('needsProxyRotation returns true when dataLayerFailureCount reaches threshold=1', () => {
    const channel = new Channel({
      id: 1,
      config: {
        nodeCode: 'crawler-01',
        stealthMode: 'channel',
        dataLayerProxyRotationThreshold: 1,
      },
      log: () => {},
    });

    assert.strictEqual(channel.needsProxyRotation(), false);
    channel.dataLayerFailureCount = 1;
    assert.strictEqual(channel.needsProxyRotation(), true);
  });
});
