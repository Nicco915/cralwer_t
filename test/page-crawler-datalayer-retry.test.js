const { describe, it } = require('node:test');
const assert = require('node:assert');
const { PageCrawler } = require('../src/page-crawler');

describe('extractProductUrlWithRetry', () => {
  function createCrawler(options = {}) {
    return new PageCrawler({
      baseUrl: 'https://eur.vevor.com',
      imageDir: './output/images',
      ...options,
    });
  }

  it('returns dataLayer result on first attempt', async () => {
    const crawler = createCrawler();
    const page = {};
    crawler.extractProductUrlFromDataLayer = async () => ['https://example.com/p/1', 'Product 1'];
    crawler.extractFromHtml = async () => { throw new Error('should not be called'); };

    const result = await crawler.extractProductUrlWithRetry(page, 'SKU-1');
    assert.strictEqual(result.productUrl, 'https://example.com/p/1');
    assert.strictEqual(result.productName, 'Product 1');
    assert.strictEqual(result.dataLayerFailed, false);
  });

  it('falls back to HTML when dataLayer returns empty', async () => {
    const crawler = createCrawler();
    const page = {};
    crawler.extractProductUrlFromDataLayer = async () => ['', ''];
    crawler.extractFromHtml = async () => ['https://example.com/p/2', 'Product 2'];

    const result = await crawler.extractProductUrlWithRetry(page, 'SKU-2');
    assert.strictEqual(result.productUrl, 'https://example.com/p/2');
    assert.strictEqual(result.productName, 'Product 2');
    assert.strictEqual(result.dataLayerFailed, true);
  });

  it('retries dataLayer after HTML fallback fails', async () => {
    const crawler = createCrawler({ dataLayerMaxRetries: 2 });
    const page = {};
    let dataLayerCalls = 0;
    crawler.extractProductUrlFromDataLayer = async () => {
      dataLayerCalls++;
      if (dataLayerCalls < 2) return ['', ''];
      return ['https://example.com/p/3', 'Product 3'];
    };
    let htmlCalls = 0;
    crawler.extractFromHtml = async () => {
      htmlCalls++;
      return ['', ''];
    };

    const result = await crawler.extractProductUrlWithRetry(page, 'SKU-3');
    assert.strictEqual(result.productUrl, 'https://example.com/p/3');
    assert.strictEqual(result.productName, 'Product 3');
    assert.strictEqual(result.dataLayerFailed, false);
    assert.strictEqual(dataLayerCalls, 2);
    assert.strictEqual(htmlCalls, 1);
  });

  it('returns empty after all dataLayer retries and HTML fallbacks fail', async () => {
    const crawler = createCrawler({ dataLayerMaxRetries: 2 });
    const page = {};
    let dataLayerCalls = 0;
    crawler.extractProductUrlFromDataLayer = async () => {
      dataLayerCalls++;
      return ['', ''];
    };
    let htmlCalls = 0;
    crawler.extractFromHtml = async () => {
      htmlCalls++;
      return ['', ''];
    };

    const result = await crawler.extractProductUrlWithRetry(page, 'SKU-4');
    assert.strictEqual(result.productUrl, '');
    assert.strictEqual(result.productName, '');
    assert.strictEqual(result.dataLayerFailed, true);
    assert.strictEqual(dataLayerCalls, 3);
    assert.strictEqual(htmlCalls, 3);
  });

  it('stops retrying as soon as HTML fallback succeeds', async () => {
    const crawler = createCrawler({ dataLayerMaxRetries: 2 });
    const page = {};
    let dataLayerCalls = 0;
    crawler.extractProductUrlFromDataLayer = async () => {
      dataLayerCalls++;
      return ['', ''];
    };
    let htmlCalls = 0;
    crawler.extractFromHtml = async () => {
      htmlCalls++;
      if (htmlCalls === 2) return ['https://example.com/p/5', 'Product 5'];
      return ['', ''];
    };

    const result = await crawler.extractProductUrlWithRetry(page, 'SKU-5');
    assert.strictEqual(result.productUrl, 'https://example.com/p/5');
    assert.strictEqual(result.productName, 'Product 5');
    assert.strictEqual(result.dataLayerFailed, true);
    assert.strictEqual(dataLayerCalls, 2);
    assert.strictEqual(htmlCalls, 2);
  });
});
