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

describe('Channel CF_CHALLENGE_UNRESOLVED handling', () => {
  it('returns not_found when crawlSingleSku throws CF_CHALLENGE_UNRESOLVED', async () => {
    const channel = createSilentChannel();
    channel.pageCrawler.crawlSingleSku = async () => {
      throw new Error('CF_CHALLENGE_UNRESOLVED');
    };

    const result = await channel.crawl({ sku: 'STUB-SKU', crawlerTaskId: 1 });
    assert.strictEqual(result.status, 'not_found');
    assert.strictEqual(result.error, 'CF_CHALLENGE_UNRESOLVED');
    assert.strictEqual(result.crawlerTaskId, 1);
  });

  it('increments dataLayerFailureCount and triggers needsProxyRotation for CF failure', async () => {
    const channel = createSilentChannel();
    channel.pageCrawler.crawlSingleSku = async () => {
      throw new Error('CF_CHALLENGE_UNRESOLVED');
    };

    await channel.crawl({ sku: 'A', crawlerTaskId: 1 });
    assert.strictEqual(channel.dataLayerFailureCount, 1);
    assert.strictEqual(channel.needsProxyRotation(), true);
  });

  it('does not throw CF errors to the caller', async () => {
    const channel = createSilentChannel();
    channel.pageCrawler.crawlSingleSku = async () => {
      throw new Error('CF_CHALLENGE_UNRESOLVED');
    };

    // 不应抛
    await channel.crawl({ sku: 'A', crawlerTaskId: 1 });
  });
});