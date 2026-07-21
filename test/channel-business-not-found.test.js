const { describe, it } = require('node:test');
const assert = require('node:assert');
const { Channel } = require('../src/channel');

// Channel.crawl 应当区分业务无结果（dataLayerNotFound=true）和真 dataLayer 异常（dataLayerFailed=true）：
// - 业务无结果：不递增 dataLayerFailureCount，不触发换 IP
// - 真异常：递增 dataLayerFailureCount

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

describe('Channel.crawl business not-found (dataLayerNotFound=true) does not trigger rotation', () => {
  it('does NOT increment dataLayerFailureCount when result.dataLayerNotFound=true', async () => {
    // 业务无结果 SKU（result_number=0 + HTML 也没找到）：dataLayerFailed=false, dataLayerNotFound=true
    const channel = await createSilentChannel();
    channel.pageCrawler.crawlSingleSku = async () => ({
      sku: 'NO-RESULT-SKU',
      status: 'not_found',
      product_url: '',
      product_name: '',
      features_details: '',
      product_specification: '',
      image_paths: '',
      error: 'No product URL found',
      dataLayerFailed: false,
      dataLayerNotFound: true,
    });

    const result = await channel.crawl({ sku: 'NO-RESULT-SKU', crawlerTaskId: 1 });

    assert.strictEqual(result.status, 'not_found');
    assert.strictEqual(result.dataLayerNotFound, true);
    // 关键：业务无结果不能递增 dataLayerFailureCount
    assert.strictEqual(channel.dataLayerFailureCount, 0);
    assert.strictEqual(channel.needsProxyRotation(), false);
  });

  it('does NOT increment dataLayerFailureCount after multiple consecutive business not-found SKUs', async () => {
    // 即使连续多个 SKU 都业务无结果，也不应换 IP
    const channel = await createSilentChannel();
    channel.pageCrawler.crawlSingleSku = async () => ({
      sku: 'NO-RESULT',
      status: 'not_found',
      product_url: '',
      product_name: '',
      features_details: '',
      product_specification: '',
      image_paths: '',
      error: 'No product URL found',
      dataLayerFailed: false,
      dataLayerNotFound: true,
    });

    for (let i = 0; i < 5; i++) {
      await channel.crawl({ sku: `NO-RESULT-${i}`, crawlerTaskId: i });
    }
    assert.strictEqual(channel.dataLayerFailureCount, 0);
    assert.strictEqual(channel.needsProxyRotation(), false);
  });

  it('does NOT increment dataLayerFailureCount when dataLayerNotFound=true even if dataLayerFailed=true', async () => {
    // 防御：理论上 dataLayerNotFound=true 时 dataLayerFailed 应为 false，
    // 但即使上游误标 dataLayerFailed=true，dataLayerNotFound=true 也应胜出（业务无结果优先）
    const channel = await createSilentChannel();
    channel.pageCrawler.crawlSingleSku = async () => ({
      sku: 'NO-RESULT-SKU',
      status: 'not_found',
      product_url: '',
      product_name: '',
      features_details: '',
      product_specification: '',
      image_paths: '',
      error: 'No product URL found',
      dataLayerFailed: true,
      dataLayerNotFound: true,
    });

    await channel.crawl({ sku: 'NO-RESULT-SKU', crawlerTaskId: 1 });
    assert.strictEqual(channel.dataLayerFailureCount, 0);
  });
});

describe('Channel.crawl real dataLayer failure (dataLayerFailed=true, dataLayerNotFound=false)', () => {
  it('when status is not_found, increments dataLayerFailureCount', async () => {
    // 真 dataLayer 异常（HTML 也没救回来）→ 计入失败（IP 可能有问题）。
    // 真实路径：page-crawler 外层 catch 把 DATA_LAYER_* 翻译成
    // not_found + dataLayerFailed 返回（不再抛异常），channel 递增计数。
    const channel = await createSilentChannel();
    channel.pageCrawler.crawlSingleSku = async () => ({
      sku: 'STUB-SKU',
      status: 'not_found',
      product_url: '',
      product_name: '',
      features_details: '',
      product_specification: '',
      image_paths: '',
      error: 'DATA_LAYER_NEVER_PUSHED',
      dataLayerFailed: true,
      dataLayerNotFound: false,
    });

    await channel.crawl({ sku: 'STUB-SKU', crawlerTaskId: 1 });
    assert.strictEqual(channel.dataLayerFailureCount, 1);
    assert.strictEqual(channel.needsProxyRotation(), true);
  });

  it('does not trigger rotation after HTML recovered (status=success even if dataLayerFailed=true)', async () => {
    // 真 dataLayer 异常 + HTML 救回来：count 会被 success 重置为 0
    // （HTML 救回来 = IP 没问题，不应换 IP）
    const channel = await createSilentChannel();
    channel.pageCrawler.crawlSingleSku = async () => ({
      sku: 'STUB-SKU',
      status: 'success',
      product_url: 'https://eur.vevor.com/p/HTML',
      product_name: 'X',
      features_details: '',
      product_specification: '',
      image_paths: '',
      error: '',
      dataLayerFailed: true,
      dataLayerNotFound: false,
    });

    await channel.crawl({ sku: 'STUB-SKU', crawlerTaskId: 1 });
    // 关键：HTML 救回来后 status=success → count 被重置（保留现有行为）
    assert.strictEqual(channel.dataLayerFailureCount, 0);
    assert.strictEqual(channel.needsProxyRotation(), false);
  });

  it('resets dataLayerFailureCount to 0 on full success', async () => {
    const channel = await createSilentChannel();
    // 第一次：dataLayer 异常（result 标志位路径）
    channel.pageCrawler.crawlSingleSku = async () => ({
      sku: 'A',
      status: 'not_found',
      product_url: '',
      product_name: '',
      features_details: '',
      product_specification: '',
      image_paths: '',
      error: 'DATA_LAYER_NEVER_PUSHED',
      dataLayerFailed: true,
      dataLayerNotFound: false,
    });
    await channel.crawl({ sku: 'A', crawlerTaskId: 1 });
    assert.strictEqual(channel.dataLayerFailureCount, 1);

    // 第二次：完全成功（无 dataLayer 失败）
    channel.pageCrawler.crawlSingleSku = async () => ({
      sku: 'B',
      status: 'success',
      product_url: 'https://eur.vevor.com/p/Y',
      product_name: 'Y',
      features_details: '',
      product_specification: '',
      image_paths: '',
      error: '',
      dataLayerFailed: false,
      dataLayerNotFound: false,
    });
    await channel.crawl({ sku: 'B', crawlerTaskId: 2 });
    assert.strictEqual(channel.dataLayerFailureCount, 0);
  });
});

describe('Channel.crawl CF challenge and DATA_LAYER_* errors still increment', () => {
  it('DATA_LAYER_NEVER_PUSHED result (dataLayerFailed=true, notFound=false) still increments', async () => {
    // 真实路径：DATA_LAYER_* 由 page-crawler 翻译成 result 标志位返回
    const channel = await createSilentChannel();
    channel.pageCrawler.crawlSingleSku = async () => ({
      sku: 'A',
      status: 'not_found',
      product_url: '',
      product_name: '',
      features_details: '',
      product_specification: '',
      image_paths: '',
      error: 'DATA_LAYER_NEVER_PUSHED',
      dataLayerFailed: true,
      dataLayerNotFound: false,
    });

    await channel.crawl({ sku: 'A', crawlerTaskId: 1 });
    assert.strictEqual(channel.dataLayerFailureCount, 1);
  });

  it('CF_CHALLENGE_UNRESOLVED in result (dataLayerFailed=true, notFound=false) still increments', async () => {
    const channel = await createSilentChannel();
    channel.pageCrawler.crawlSingleSku = async () => ({
      sku: 'A',
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
    });

    await channel.crawl({ sku: 'A', crawlerTaskId: 1 });
    assert.strictEqual(channel.dataLayerFailureCount, 1);
  });
});