const { describe, it } = require('node:test');
const assert = require('node:assert');
const { PageCrawler, captureDiagnostics } = require('../src/page-crawler');

describe('PageCrawler Cloudflare challenge failure', () => {
  it('returns not_found + CF_CHALLENGE_UNRESOLVED + dataLayerFailed + cfChallengeFailed on search-page CF timeout', async () => {
    const crawler = new PageCrawler({
      baseUrl: 'https://eur.vevor.com',
      cloudflareMaxWait: 1, // 测试加速
      diagnosticDir: '/tmp/test-diag',
      imageDir: '/tmp/test-image',
    });

    const fakePage = {
      async goto() {},
      url: () => 'https://eur.vevor.com/s/TEST',
      async title() { return 'Just a moment...'; },
      async content() { return '<html><body>cf-browser-verification</body></html>'; },
    };

    const result = await crawler.crawlSingleSku('TEST-SKU', fakePage, async () => fakePage);

    assert.strictEqual(result.status, 'not_found');
    assert.strictEqual(result.error, 'CF_CHALLENGE_UNRESOLVED');
    assert.strictEqual(result.dataLayerFailed, true);
    assert.strictEqual(result.cfChallengeFailed, true);
    assert.strictEqual(result.sku, 'TEST-SKU');
  });

  it('returns not_found + CF_CHALLENGE_UNRESOLVED + dataLayerFailed + cfChallengeFailed on product-page CF timeout', async () => {
    const crawler = new PageCrawler({
      baseUrl: 'https://eur.vevor.com',
      cloudflareMaxWait: 1,
      diagnosticDir: '/tmp/test-diag',
      imageDir: '/tmp/test-image',
    });

    // 模拟搜索后跳转到 /p/，第二轮 CF 触发
    const fakePage = {
      async goto(url) {
        this.url = () => url;
      },
      url: () => 'https://eur.vevor.com/s/TEST',
      async title() { return 'Just a moment...'; },
      async content() { return '<html><body>cf-browser-verification</body></html>'; },
    };

    // 第一次 isCloudflareChallenge 返回 false 让搜索 pass，
    // 第二次返回 true 让详情 pass 触发。
    let cfCallCount = 0;
    crawler.isCloudflareChallenge = async () => {
      cfCallCount += 1;
      return cfCallCount >= 2;
    };
    crawler.waitForCloudflare = async () => false;
    crawler.extractProductUrlWithRetry = async () => ({ productUrl: 'https://eur.vevor.com/p/TEST', productName: 'Test', dataLayerFailed: false });

    const result = await crawler.crawlSingleSku('TEST-SKU', fakePage, async () => fakePage);

    assert.strictEqual(result.status, 'not_found');
    assert.strictEqual(result.error, 'CF_CHALLENGE_UNRESOLVED');
    assert.strictEqual(result.dataLayerFailed, true);
    assert.strictEqual(result.cfChallengeFailed, true);
  });
});
