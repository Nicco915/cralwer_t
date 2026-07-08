const { describe, it } = require('node:test');
const assert = require('node:assert');
const { PageCrawler } = require('../src/page-crawler');

// extractProductUrlWithRetry 在 DATA_LAYER_* 抛错时仍应尝试 HTML fallback，
// 只有 HTML fallback 也失败时才把 dataLayer 错误往外抛给 channel。

function createPage({ dataLayer, html, evaluateImpl } = {}) {
  const calls = [];
  return {
    url: () => 'https://eur.vevor.com/s/SKU',
    async evaluate(fn, arg) {
      calls.push({ type: 'evaluate', arg });
      if (evaluateImpl) return evaluateImpl(fn, arg);
      // 默认：模拟带 dataLayer 的 evaluate
      const prevWindow = global.window;
      global.window = { dataLayer };
      try {
        return fn(arg);
      } finally {
        if (prevWindow === undefined) delete global.window;
        else global.window = prevWindow;
      }
    },
    async waitForFunction(fn, arg, opts) {
      calls.push({ type: 'waitForFunction', arg, opts });
      // 默认行为：timeout
      throw new Error(`page.waitForFunction: Timeout ${opts.timeout}ms exceeded.`);
    },
    async title() { return 'Search SKU | VEVOR EU'; },
    content: async () => html || '<html></html>',
  };
}

describe('PageCrawler.extractProductUrlWithRetry HTML fallback on DATA_LAYER_*', () => {
  it('falls back to HTML when extractProductUrlFromDataLayer throws DATA_LAYER_NEVER_PUSHED', async () => {
    // dataLayer 一直为空 → fast-path 抛 NEVER_PUSHED
    // 但 HTML 里能找到 goodsUrl → 应当返回 HTML 找到的结果
    const html = '<script>"goodsUrl":"https://eur.vevor.com/p/HTML-HIT","title":"HTML Title"</script>';
    const page = createPage({ dataLayer: null, html });

    const crawler = new PageCrawler({});
    const result = await crawler.extractProductUrlWithRetry(page, 'HTML-FALLBACK-SKU');

    assert.strictEqual(result.productUrl, 'https://eur.vevor.com/p/HTML-HIT');
    assert.strictEqual(result.productName, 'HTML Title');
    assert.strictEqual(result.dataLayerFailed, true);
  });

  it('falls back to HTML when extractProductUrlFromDataLayer throws DATA_LAYER_MISSING', async () => {
    // result_number > 0 但 sku 不在 goods_list_params → slow-path 抛 MISSING
    // 但 HTML 能找到 goodsUrl → 返回 HTML 结果
    const html = '<script>"goodsUrl":"https://eur.vevor.com/p/HTML-MISS-HIT","title":"X"</script>';
    const page = createPage({
      dataLayer: [{ search: { result_number: 5, goods_list_params: null } }],
      html,
    });

    const crawler = new PageCrawler({});
    const result = await crawler.extractProductUrlWithRetry(page, 'SKU');

    assert.strictEqual(result.productUrl, 'https://eur.vevor.com/p/HTML-MISS-HIT');
    assert.strictEqual(result.dataLayerFailed, true);
  });

  it('rethrows DATA_LAYER_* after HTML fallback also fails', async () => {
    // dataLayer 抛错 + HTML 也找不到 → 应把原 dataLayer 错误往外抛（让 channel 换 IP）
    const page = createPage({ dataLayer: null, html: '<html>nothing</html>' });

    const crawler = new PageCrawler({});
    await assert.rejects(
      crawler.extractProductUrlWithRetry(page, 'STUB-SKU'),
      /DATA_LAYER_NEVER_PUSHED/
    );
  });

  it('returns empty when dataLayer succeeds but result is empty and HTML also empty', async () => {
    // 业务无结果：dataLayer 返回 ['', '', 'not_found']，HTML 也没有 → 返回空
    // 不应被标 dataLayerFailed（业务无结果不是 dataLayer 异常），但应当是 dataLayerNotFound
    const page = createPage({
      dataLayer: [{ search: { result_number: 0, goods_list_params: null } }],
      html: '<html>nothing</html>',
    });

    const crawler = new PageCrawler({});
    const result = await crawler.extractProductUrlWithRetry(page, 'NO-RESULT-SKU');

    assert.strictEqual(result.productUrl, '');
    assert.strictEqual(result.productName, '');
    assert.strictEqual(result.dataLayerFailed, false);
    assert.strictEqual(result.dataLayerNotFound, true);
  });
});