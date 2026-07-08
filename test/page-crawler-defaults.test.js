const { describe, it } = require('node:test');
const assert = require('node:assert');
const { PageCrawler } = require('../src/page-crawler');

describe('PageCrawler default retry counts', () => {
  it('defaults gotoMaxRetries to 1', () => {
    const crawler = new PageCrawler({});
    assert.strictEqual(crawler.gotoMaxRetries, 1);
  });

  it('defaults dataLayerMaxRetries to 1', () => {
    const crawler = new PageCrawler({});
    assert.strictEqual(crawler.dataLayerMaxRetries, 1);
  });

  it('still respects explicit override', () => {
    const crawler = new PageCrawler({ gotoMaxRetries: 5, dataLayerMaxRetries: 7 });
    assert.strictEqual(crawler.gotoMaxRetries, 5);
    assert.strictEqual(crawler.dataLayerMaxRetries, 7);
  });
});
