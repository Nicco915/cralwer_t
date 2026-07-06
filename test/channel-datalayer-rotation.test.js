const { describe, it } = require('node:test');
const assert = require('node:assert');
const { Channel } = require('../src/channel');

function createSilentChannel(options = {}) {
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
  return channel;
}

describe('Channel DATA_LAYER_NEVER_PUSHED handling', () => {
  it('returns not_found result and does not throw when crawlSingleSku throws DATA_LAYER_NEVER_PUSHED', async () => {
    const channel = createSilentChannel();
    channel.pageCrawler.crawlSingleSku = async () => {
      const err = new Error('DATA_LAYER_NEVER_PUSHED');
      throw err;
    };

    const result = await channel.crawl({ sku: 'STUB-SKU', crawlerTaskId: 1 });

    assert.strictEqual(result.status, 'not_found');
    assert.strictEqual(result.error, 'DATA_LAYER_NEVER_PUSHED');
    assert.strictEqual(result.crawlerTaskId, 1);
  });

  it('increments dataLayerFailureCount when DATA_LAYER_NEVER_PUSHED is thrown', async () => {
    const channel = createSilentChannel();
    channel.pageCrawler.crawlSingleSku = async () => {
      throw new Error('DATA_LAYER_NEVER_PUSHED');
    };

    await channel.crawl({ sku: 'A', crawlerTaskId: 1 });
    assert.strictEqual(channel.dataLayerFailureCount, 1);
    assert.strictEqual(channel.needsProxyRotation(), true);
  });

  it('does not throw to caller even when headed fallback would otherwise be triggered', async () => {
    const channel = createSilentChannel();
    channel.headedBrowserLauncher = async () => { throw new Error('headed launcher should not run'); };
    channel.pageCrawler.crawlSingleSku = async () => {
      throw new Error('DATA_LAYER_NEVER_PUSHED');
    };

    // 不能向上抛
    await channel.crawl({ sku: 'A', crawlerTaskId: 1 });
  });
});

describe('Channel DATA_LAYER_MISSING handling', () => {
  it('returns not_found result when DATA_LAYER_MISSING is thrown', async () => {
    const channel = createSilentChannel();
    channel.pageCrawler.crawlSingleSku = async () => {
      throw new Error('DATA_LAYER_MISSING: page.waitForFunction: Timeout 20000ms exceeded.');
    };

    const result = await channel.crawl({ sku: 'GHOST-SKU', crawlerTaskId: 2 });

    assert.strictEqual(result.status, 'not_found');
    assert.ok(result.error.includes('DATA_LAYER_MISSING'));
    assert.strictEqual(result.crawlerTaskId, 2);
  });

  it('increments dataLayerFailureCount for DATA_LAYER_MISSING too', async () => {
    const channel = createSilentChannel();
    channel.pageCrawler.crawlSingleSku = async () => {
      throw new Error('DATA_LAYER_MISSING: timeout');
    };

    await channel.crawl({ sku: 'A', crawlerTaskId: 1 });
    assert.strictEqual(channel.dataLayerFailureCount, 1);
    assert.strictEqual(channel.needsProxyRotation(), true);
  });
});

describe('Channel generic errors are unaffected', () => {
  it('still throws generic errors so headed fallback / error reporting paths work', async () => {
    const channel = createSilentChannel();
    channel.pageCrawler.crawlSingleSku = async () => {
      throw new Error('Some unrelated error');
    };

    await assert.rejects(
      channel.crawl({ sku: 'A', crawlerTaskId: 1 }),
      /Some unrelated error/
    );
  });

  it('does not increment dataLayerFailureCount for non-DATA_LAYER errors', async () => {
    const channel = createSilentChannel();
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