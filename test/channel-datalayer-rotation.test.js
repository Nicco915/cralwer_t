const { describe, it } = require('node:test');
const assert = require('node:assert');
const { Channel } = require('../src/channel');

// DATA_LAYER_* 失败的真实路径（page-crawler 外层 catch 翻译，不再抛异常）：
// crawlSingleSku 返回 status=not_found + dataLayerFailed=true + dataLayerNotFound=false，
// channel 透传 result 并递增 dataLayerFailureCount，由 service 换 IP。

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

function dataLayerFailureResult(sku, error) {
  return {
    sku,
    status: 'not_found',
    product_url: '',
    product_name: '',
    features_details: '',
    product_specification: '',
    image_paths: '',
    error,
    dataLayerFailed: true,
    dataLayerNotFound: false,
  };
}

describe('Channel DATA_LAYER_NEVER_PUSHED handling', () => {
  it('passes through not_found result from crawlSingleSku', async () => {
    const channel = await createSilentChannel();
    channel.pageCrawler.crawlSingleSku = async () =>
      dataLayerFailureResult('STUB-SKU', 'DATA_LAYER_NEVER_PUSHED');

    const result = await channel.crawl({ sku: 'STUB-SKU', crawlerTaskId: 1 });

    assert.strictEqual(result.status, 'not_found');
    assert.strictEqual(result.error, 'DATA_LAYER_NEVER_PUSHED');
    assert.strictEqual(result.crawlerTaskId, 1);
  });

  it('increments dataLayerFailureCount on DATA_LAYER_NEVER_PUSHED result', async () => {
    const channel = await createSilentChannel();
    channel.pageCrawler.crawlSingleSku = async () =>
      dataLayerFailureResult('A', 'DATA_LAYER_NEVER_PUSHED');

    await channel.crawl({ sku: 'A', crawlerTaskId: 1 });
    assert.strictEqual(channel.dataLayerFailureCount, 1);
    assert.strictEqual(channel.needsProxyRotation(), true);
  });

  it('does not trigger headed fallback for dataLayer failure results', async () => {
    const channel = await createSilentChannel();
    channel.headedFallback = true;
    channel.headedBrowserLauncher = async () => { throw new Error('headed launcher should not run'); };
    channel.pageCrawler.crawlSingleSku = async () =>
      dataLayerFailureResult('A', 'DATA_LAYER_NEVER_PUSHED');

    const result = await channel.crawl({ sku: 'A', crawlerTaskId: 1 });
    assert.strictEqual(result.status, 'not_found');
  });
});

describe('Channel DATA_LAYER_MISSING handling', () => {
  it('passes through not_found result for DATA_LAYER_MISSING', async () => {
    const channel = await createSilentChannel();
    channel.pageCrawler.crawlSingleSku = async () =>
      dataLayerFailureResult('GHOST-SKU', 'DATA_LAYER_MISSING: page.waitForFunction: Timeout 20000ms exceeded.');

    const result = await channel.crawl({ sku: 'GHOST-SKU', crawlerTaskId: 2 });

    assert.strictEqual(result.status, 'not_found');
    assert.ok(result.error.includes('DATA_LAYER_MISSING'));
    assert.strictEqual(result.crawlerTaskId, 2);
  });

  it('increments dataLayerFailureCount for DATA_LAYER_MISSING too', async () => {
    const channel = await createSilentChannel();
    channel.pageCrawler.crawlSingleSku = async () =>
      dataLayerFailureResult('A', 'DATA_LAYER_MISSING: timeout');

    await channel.crawl({ sku: 'A', crawlerTaskId: 1 });
    assert.strictEqual(channel.dataLayerFailureCount, 1);
    assert.strictEqual(channel.needsProxyRotation(), true);
  });
});

describe('Channel generic errors are unaffected', () => {
  it('still throws generic errors so headed fallback / error reporting paths work', async () => {
    const channel = await createSilentChannel();
    channel.pageCrawler.crawlSingleSku = async () => {
      throw new Error('Some unrelated error');
    };

    await assert.rejects(
      channel.crawl({ sku: 'A', crawlerTaskId: 1 }),
      /Some unrelated error/
    );
  });

  it('does not increment dataLayerFailureCount for non-DATA_LAYER errors', async () => {
    const channel = await createSilentChannel();
    channel.pageCrawler.crawlSingleSku = async () => {
      throw new Error('unrelated failure');
    };

    try {
      await channel.crawl({ sku: 'A', crawlerTaskId: 1 });
    } catch (e) {
      // expected
    }
    assert.strictEqual(channel.dataLayerFailureCount, 0);
  });
});
