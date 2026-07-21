const { describe, it } = require('node:test');
const assert = require('node:assert');
const { Channel } = require('../src/channel');

// CF_CHALLENGE_UNRESOLVED 的真实路径（page-crawler 从不抛它）：
// crawlSingleSku 返回 status=not_found + error=CF_CHALLENGE_UNRESOLVED +
// dataLayerFailed=true + cfChallengeFailed=true，channel 透传并递增
// dataLayerFailureCount，由 service 换 IP。

function createMockBrowser() {
  const browser = {
    isConnected: () => true,
    async newContext() {
      const ctx = {
        closed: false,
        async addInitScript() {},
        async newPage() { return { closed: false, async close() {} }; },
        async close() { this.closed = true; },
      };
      ctx.browser = () => browser;
      return ctx;
    },
  };
  return browser;
}

async function createSilentChannel(options = {}) {
  const log = () => {};
  const channel = new Channel({
    id: 1,
    config: {
      dataLayerProxyRotationThreshold: 1,
      dataLayerFailureThreshold: 3,
      ...options,
    },
    log,
  });
  await channel.init(createMockBrowser());
  return channel;
}

function cfFailureResult(sku) {
  return {
    sku,
    status: 'not_found',
    product_url: '',
    product_name: '',
    features_details: '',
    product_specification: '',
    image_paths: '',
    error: 'CF_CHALLENGE_UNRESOLVED',
    dataLayerFailed: true,
    dataLayerNotFound: false,
    cfChallengeFailed: true,
  };
}

describe('Channel CF_CHALLENGE_UNRESOLVED handling', () => {
  it('passes through not_found result with CF_CHALLENGE_UNRESOLVED error', async () => {
    const channel = await createSilentChannel();
    channel.pageCrawler.crawlSingleSku = async () => cfFailureResult('STUB-SKU');

    const result = await channel.crawl({ sku: 'STUB-SKU', crawlerTaskId: 1 });
    assert.strictEqual(result.status, 'not_found');
    assert.strictEqual(result.error, 'CF_CHALLENGE_UNRESOLVED');
    assert.strictEqual(result.crawlerTaskId, 1);
  });

  it('increments dataLayerFailureCount and triggers needsProxyRotation for CF failure', async () => {
    const channel = await createSilentChannel();
    channel.pageCrawler.crawlSingleSku = async () => cfFailureResult('A');

    await channel.crawl({ sku: 'A', crawlerTaskId: 1 });
    assert.strictEqual(channel.dataLayerFailureCount, 1);
    assert.strictEqual(channel.needsProxyRotation(), true);
  });

  it('does not throw CF failure results to the caller', async () => {
    const channel = await createSilentChannel();
    channel.pageCrawler.crawlSingleSku = async () => cfFailureResult('A');

    const result = await channel.crawl({ sku: 'A', crawlerTaskId: 1 });
    assert.strictEqual(result.status, 'not_found');
  });
});
