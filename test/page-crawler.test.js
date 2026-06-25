const { describe, it } = require('node:test');
const assert = require('node:assert');
const { PageCrawler } = require('../src/page-crawler');

function createMockPage(opts = {}) {
  return {
    evaluate: async (fn) => {
      if (opts.evaluate) return opts.evaluate(fn);
      return '';
    },
    content: async () => opts.html || '',
  };
}

// 在 Node 环境中，window 不存在；通过 vm 在隔离上下文执行 evaluate 回调，
// 让函数内部的 `window` 引用解析为 mock 对象。
// 这里采用更直接的方式：调用 fn 之前临时设置 global.window，
// 调用结束后还原，避免污染全局。
function runEvaluateWithWindow(fn, mockWindow) {
  const prevWindow = global.window;
  global.window = mockWindow;
  try {
    return fn.call(mockWindow, mockWindow);
  } finally {
    if (prevWindow === undefined) {
      delete global.window;
    } else {
      global.window = prevWindow;
    }
  }
}

describe('PageCrawler.extractPageSku', () => {
  it('extracts SKU from dataLayer.product.sku', async () => {
    const crawler = new PageCrawler();
    const page = createMockPage({
      evaluate: (fn) => {
        const mockWindow = { dataLayer: [{ product: { sku: 'ABC-123' } }] };
        return runEvaluateWithWindow(fn, mockWindow);
      },
    });
    const sku = await crawler.extractPageSku(page);
    assert.strictEqual(sku, 'ABC-123');
  });

  it('extracts SKU from dataLayer.ecommerce.detail.products', async () => {
    const crawler = new PageCrawler();
    const page = createMockPage({
      evaluate: (fn) => {
        const mockWindow = {
          dataLayer: [{
            ecommerce: {
              detail: {
                products: [{ sku: 'ECO-456' }]
              }
            }
          }]
        };
        return runEvaluateWithWindow(fn, mockWindow);
      },
    });
    const sku = await crawler.extractPageSku(page);
    assert.strictEqual(sku, 'ECO-456');
  });

  it('falls back to HTML regex when dataLayer is empty', async () => {
    const crawler = new PageCrawler();
    const page = createMockPage({
      evaluate: (fn) => {
        const mockWindow = { dataLayer: [] };
        return runEvaluateWithWindow(fn, mockWindow);
      },
      html: '<script>window.__INITIAL_STATE__ = {"sku":"XYZ-999"};</script>',
    });
    const sku = await crawler.extractPageSku(page);
    assert.strictEqual(sku, 'XYZ-999');
  });

  it('falls back to meta tag with name before content', async () => {
    const crawler = new PageCrawler();
    const page = createMockPage({
      evaluate: (fn) => {
        const mockWindow = { dataLayer: [] };
        return runEvaluateWithWindow(fn, mockWindow);
      },
      html: '<meta name="sku" content="META-001">',
    });
    const sku = await crawler.extractPageSku(page);
    assert.strictEqual(sku, 'META-001');
  });

  it('falls back to meta tag with content before name', async () => {
    const crawler = new PageCrawler();
    const page = createMockPage({
      evaluate: (fn) => {
        const mockWindow = { dataLayer: [] };
        return runEvaluateWithWindow(fn, mockWindow);
      },
      html: '<meta content="META-002" name="sku">',
    });
    const sku = await crawler.extractPageSku(page);
    assert.strictEqual(sku, 'META-002');
  });

  it('returns empty string when SKU is not found', async () => {
    const crawler = new PageCrawler();
    const page = createMockPage({
      evaluate: (fn) => {
        const mockWindow = { dataLayer: [] };
        return runEvaluateWithWindow(fn, mockWindow);
      },
      html: '<html></html>',
    });
    const sku = await crawler.extractPageSku(page);
    assert.strictEqual(sku, '');
  });

  it('returns empty string when evaluate throws', async () => {
    const crawler = new PageCrawler();
    const page = createMockPage({
      evaluate: () => { throw new Error('evaluate failed'); },
    });
    const sku = await crawler.extractPageSku(page);
    assert.strictEqual(sku, '');
  });

  it('returns empty string when content throws', async () => {
    const crawler = new PageCrawler();
    const page = createMockPage({
      evaluate: (fn) => {
        const mockWindow = { dataLayer: [] };
        return runEvaluateWithWindow(fn, mockWindow);
      },
      content: () => { throw new Error('content failed'); },
    });
    const sku = await crawler.extractPageSku(page);
    assert.strictEqual(sku, '');
  });
});
