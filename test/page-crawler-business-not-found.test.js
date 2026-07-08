const { describe, it } = require('node:test');
const assert = require('node:assert');
const { PageCrawler } = require('../src/page-crawler');

// 业务无结果（dataLayer result_number === 0）应当与 dataLayer 异常区分开：
// - extractProductUrlFromDataLayer 在业务无结果时返回一个带 'not_found' 分类的三元组
// - extractProductUrlWithRetry 把业务无结果信号透传给 caller：
//     dataLayerNotFound=true 且 dataLayerFailed=false（即使 HTML 也找不到也不应触发换 IP）

function createDataLayerPage(options) {
  const calls = [];
  const dataLayerProvider = options.dataLayerAt || (() => null);
  const htmlProvider = options.htmlAt || (() => '<html></html>');
  const page = {
    url: () => 'https://eur.vevor.com/s/SKU',
    async waitForFunction(fn, arg, opts = {}) {
      calls.push({ type: 'waitForFunction', arg, opts });
      const dataLayer = dataLayerProvider('waitForFunction');
      const verdict = runInVm(fn, arg, dataLayer);
      if (verdict !== false) {
        return { jsonValue: async () => verdict };
      }
      const err = new Error(`page.waitForFunction: Timeout ${opts.timeout || 20000}ms exceeded.`);
      throw err;
    },
    async evaluate(fn, arg) {
      calls.push({ type: 'evaluate', arg });
      const dataLayer = dataLayerProvider('evaluate');
      return runInVm(fn, arg, dataLayer);
    },
    async title() { return 'Search SKU | VEVOR EU'; },
    async content() { return htmlProvider(); },
    async screenshot({ path }) { return path; },
  };
  page.calls = calls;
  return page;
}

function runInVm(fn, arg, dataLayer) {
  const prevWindow = global.window;
  global.window = { dataLayer };
  try {
    return fn(arg);
  } finally {
    if (prevWindow === undefined) delete global.window;
    else global.window = prevWindow;
  }
}

describe('PageCrawler.extractProductUrlFromDataLayer business not-found classification', () => {
  it('returns a 3-tuple with classification "not_found" when result_number is 0', async () => {
    const page = createDataLayerPage({
      dataLayerAt: () => [{ search: { result_number: 0, goods_list_params: null } }],
    });
    const crawler = new PageCrawler({});

    const result = await crawler.extractProductUrlFromDataLayer(page, 'NO-RESULT-SKU', 20000);

    // 3-tuple：['', '', 'not_found'] 用于告诉 caller 这是业务无结果，不是异常
    assert.strictEqual(result[0], '');
    assert.strictEqual(result[1], '');
    assert.strictEqual(result[2], 'not_found');
    assert.strictEqual(result.length, 3);
    // fast-path 只调用一次 evaluate，没进 waitForFunction
    assert.strictEqual(page.calls.filter(c => c.type === 'evaluate').length, 1);
    assert.strictEqual(page.calls.filter(c => c.type === 'waitForFunction').length, 0);
  });

  it('returns a 2-tuple [url, title] when sku is in goods_list_params (no classification)', async () => {
    const page = createDataLayerPage({
      dataLayerAt: () => [{
        search: {
          result_number: 1,
          goods_list_params: {
            'GOOD-SKU': { goodsUrl: 'https://eur.vevor.com/p/X', title: 'X Title' }
          }
        }
      }],
    });
    const crawler = new PageCrawler({});

    const result = await crawler.extractProductUrlFromDataLayer(page, 'GOOD-SKU', 20000);

    assert.strictEqual(result[0], 'https://eur.vevor.com/p/X');
    assert.strictEqual(result[1], 'X Title');
    assert.strictEqual(result.length, 2);
  });
});

describe('PageCrawler.extractProductUrlWithRetry distinguishes business not-found vs dataLayer failure', () => {
  it('returns dataLayerNotFound=true (and dataLayerFailed=false) when dataLayer reports result_number=0 and HTML empty', async () => {
    // 业务无结果 + HTML 也找不到 → 不应该被当作 dataLayer 失败
    const page = createDataLayerPage({
      dataLayerAt: () => [{ search: { result_number: 0, goods_list_params: null } }],
      htmlAt: () => '<html>nothing</html>',
    });
    const crawler = new PageCrawler({});

    const result = await crawler.extractProductUrlWithRetry(page, 'NO-RESULT-SKU');

    assert.strictEqual(result.productUrl, '');
    assert.strictEqual(result.productName, '');
    assert.strictEqual(result.dataLayerFailed, false);
    assert.strictEqual(result.dataLayerNotFound, true);
  });

  it('returns dataLayerNotFound=true (and dataLayerFailed=false) when dataLayer reports result_number=0 and HTML has a hit', async () => {
    // 业务无结果但 HTML 救回来 → 仍然算 not_found（商品本来就不在 EU），
    // 也不该触发换 IP
    const html = '<script>"goodsUrl":"https://eur.vevor.com/p/HTML-HIT","title":"T"</script>';
    const page = createDataLayerPage({
      dataLayerAt: () => [{ search: { result_number: 0, goods_list_params: null } }],
      htmlAt: () => html,
    });
    const crawler = new PageCrawler({});

    const result = await crawler.extractProductUrlWithRetry(page, 'NO-RESULT-SKU');

    assert.strictEqual(result.productUrl, 'https://eur.vevor.com/p/HTML-HIT');
    assert.strictEqual(result.dataLayerFailed, false);
    assert.strictEqual(result.dataLayerNotFound, true);
  });

  it('returns dataLayerNotFound=false (and dataLayerFailed=true) when dataLayer throws DATA_LAYER_NEVER_PUSHED but HTML has a hit', async () => {
    // 真异常 + HTML 救回来 → 是 dataLayerFailed（IP 可能有问题），但 HTML 拿到了结果
    const html = '<script>"goodsUrl":"https://eur.vevor.com/p/HTML-HIT","title":"T"</script>';
    const page = createDataLayerPage({
      dataLayerAt: () => null,
      htmlAt: () => html,
    });
    const crawler = new PageCrawler({});

    const result = await crawler.extractProductUrlWithRetry(page, 'STUB-SKU');

    assert.strictEqual(result.productUrl, 'https://eur.vevor.com/p/HTML-HIT');
    assert.strictEqual(result.dataLayerFailed, true);
    assert.strictEqual(result.dataLayerNotFound, false);
  });

  it('returns dataLayerNotFound=false (and dataLayerFailed=false) on fast-path success', async () => {
    // fast-path 命中：sku 在 params → 两条标志都应为 false
    const page = createDataLayerPage({
      dataLayerAt: () => [{
        search: {
          result_number: 1,
          goods_list_params: {
            'GOOD-SKU': { goodsUrl: 'https://eur.vevor.com/p/X', title: 'X' }
          }
        }
      }],
    });
    const crawler = new PageCrawler({});

    const result = await crawler.extractProductUrlWithRetry(page, 'GOOD-SKU');

    assert.strictEqual(result.productUrl, 'https://eur.vevor.com/p/X');
    assert.strictEqual(result.dataLayerFailed, false);
    assert.strictEqual(result.dataLayerNotFound, false);
  });
});