const { describe, it } = require('node:test');
const assert = require('node:assert');
const { Channel } = require('../src/channel');

function makeChannel(config = {}) {
  const channel = new Channel({
    id: 1,
    config: { nodeCode: 'test-node', baseUrl: 'https://eur.vevor.com', ...config },
    log: () => {},
    headedBrowserLauncher: null,
    onTaskComplete: null,
  });
  const captured = { calls: [] };
  channel.pageCrawler = {
    randomDelay: () => 0,
    sleep: async () => {},
    crawlSingleSku: async (sku, page, recreateContext, options) => {
      captured.calls.push({ sku, options });
      return {
        sku,
        status: 'success',
        product_name: 'X',
        product_url: '',
        features_details: '',
        product_specification: '',
      };
    },
  };
  channel._captured = captured;
  return channel;
}

describe('Channel multi-region', () => {
  it('passes task.baseUrl through to pageCrawler.crawlSingleSku', async () => {
    const channel = makeChannel();
    channel.ensureContext = async () => ({});
    channel.page = {};

    await channel.crawl({ crawlerTaskId: 1, sku: 'S1', baseUrl: 'https://www.vevor.ca', regionCode: 'CA' });

    assert.strictEqual(channel._captured.calls.length, 1);
    assert.deepStrictEqual(channel._captured.calls[0].options, { baseUrl: 'https://www.vevor.ca' });
  });

  it('passes undefined baseUrl when the task has none (PageCrawler falls back to config)', async () => {
    const channel = makeChannel();
    channel.ensureContext = async () => ({});
    channel.page = {};

    await channel.crawl({ crawlerTaskId: 2, sku: 'S2' });

    assert.strictEqual(channel._captured.calls[0].options.baseUrl, undefined);
  });

  it('does not clear cookies on region switch when the guard is off (default)', async () => {
    const channel = makeChannel();
    let cleared = 0;
    channel.browserContext = { clearCookies: async () => { cleared += 1; } };
    channel.ensureContext = async () => ({});
    channel.page = {};

    await channel.crawl({ crawlerTaskId: 3, sku: 'S3', regionCode: 'CA' });
    await channel.crawl({ crawlerTaskId: 4, sku: 'S4', regionCode: 'GB' });

    assert.strictEqual(cleared, 0);
    assert.strictEqual(channel.lastRegionCode, 'GB');
  });

  it('clears cookies only when the region actually switches and the guard is on', async () => {
    const channel = makeChannel({ clearCookiesOnRegionSwitch: true });
    let cleared = 0;
    channel.browserContext = { clearCookies: async () => { cleared += 1; } };
    channel.ensureContext = async () => ({});
    channel.page = {};

    await channel.crawl({ crawlerTaskId: 5, sku: 'S5', regionCode: 'CA' }); // 首次：无上次区域，不清
    await channel.crawl({ crawlerTaskId: 6, sku: 'S6', regionCode: 'GB' }); // 切换：清 1 次
    await channel.crawl({ crawlerTaskId: 7, sku: 'S7', regionCode: 'GB' }); // 同区：不清

    assert.strictEqual(cleared, 1);
    assert.strictEqual(channel.lastRegionCode, 'GB');
  });
});
