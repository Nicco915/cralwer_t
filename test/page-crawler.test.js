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

describe('PageCrawler.extractPageSku', () => {
  it('extracts SKU from dataLayer.product.sku', async () => {
    const crawler = new PageCrawler();
    const page = createMockPage({
      evaluate: () => 'ABC-123',
    });
    const sku = await crawler.extractPageSku(page);
    assert.strictEqual(sku, 'ABC-123');
  });

  it('falls back to HTML regex when dataLayer is empty', async () => {
    const crawler = new PageCrawler();
    const page = createMockPage({
      evaluate: () => '',
      html: '<script>window.__INITIAL_STATE__ = {"sku":"XYZ-999"};</script>',
    });
    const sku = await crawler.extractPageSku(page);
    assert.strictEqual(sku, 'XYZ-999');
  });

  it('falls back to meta tag', async () => {
    const crawler = new PageCrawler();
    const page = createMockPage({
      evaluate: () => '',
      html: '<meta name="sku" content="META-001">',
    });
    const sku = await crawler.extractPageSku(page);
    assert.strictEqual(sku, 'META-001');
  });

  it('returns empty string when SKU is not found', async () => {
    const crawler = new PageCrawler();
    const page = createMockPage({
      evaluate: () => '',
      html: '<html></html>',
    });
    const sku = await crawler.extractPageSku(page);
    assert.strictEqual(sku, '');
  });
});
