const { describe, it } = require('node:test');
const assert = require('node:assert');
const { PageCrawler } = require('../src/page-crawler');

// DATA_LAYER_* 失败应与 CF_CHALLENGE_UNRESOLVED 走同款路径：
// 翻译成 not_found + dataLayerFailed 标志位返回（而非 status=error），
// 由 channel 计数 / worker 换 IP 重试 / service rotation 兜底。
describe('PageCrawler DATA_LAYER_* failure translation', () => {
  function createCrawler() {
    return new PageCrawler({
      baseUrl: 'https://eur.vevor.com',
      cloudflareMaxWait: 1,
      diagnosticDir: '/tmp/test-diag',
      imageDir: '/tmp/test-image',
    });
  }

  function createSearchPage() {
    return {
      async goto() {},
      url: () => 'https://eur.vevor.com/s/TEST-SKU',
      async title() { return 'Search results'; },
      async content() { return '<html><body>normal page</body></html>'; },
    };
  }

  it('returns not_found + dataLayerFailed when dataLayer never pushed', async () => {
    const crawler = createCrawler();
    crawler.extractProductUrlWithRetry = async () => {
      throw new Error('DATA_LAYER_NEVER_PUSHED');
    };

    const result = await crawler.crawlSingleSku('TEST-SKU', createSearchPage(), async () => createSearchPage());

    assert.strictEqual(result.status, 'not_found');
    assert.strictEqual(result.error, 'DATA_LAYER_NEVER_PUSHED');
    assert.strictEqual(result.dataLayerFailed, true);
    assert.strictEqual(result.sku, 'TEST-SKU');
  });

  it('returns not_found + dataLayerFailed when dataLayer missing (message contains Timeout text)', async () => {
    const crawler = createCrawler();
    crawler.extractProductUrlWithRetry = async () => {
      throw new Error('DATA_LAYER_MISSING: page.waitForFunction: Timeout 20000ms exceeded.');
    };

    const result = await crawler.crawlSingleSku('TEST-SKU', createSearchPage(), async () => createSearchPage());

    assert.strictEqual(result.status, 'not_found');
    assert.strictEqual(result.error, 'DATA_LAYER_MISSING: page.waitForFunction: Timeout 20000ms exceeded.');
    assert.strictEqual(result.dataLayerFailed, true);
  });

  it('non-DATA_LAYER errors still return status=error', async () => {
    const crawler = createCrawler();
    crawler.extractProductUrlWithRetry = async () => {
      throw new Error('some unexpected failure');
    };

    const result = await crawler.crawlSingleSku('TEST-SKU', createSearchPage(), async () => createSearchPage());

    assert.strictEqual(result.status, 'error');
    assert.strictEqual(result.error, 'some unexpected failure');
  });
});
