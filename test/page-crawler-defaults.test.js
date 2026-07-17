const { describe, it } = require('node:test');
const assert = require('node:assert');
const { PageCrawler } = require('../src/page-crawler');
const { VevorCrawler, DEFAULT_CONFIG } = require('../src/crawler');

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

describe('VevorCrawler timeout config defaults', () => {
  it('DEFAULT_CONFIG contains taskTimeoutMs and retryOnTimeout', () => {
    assert.strictEqual(DEFAULT_CONFIG.taskTimeoutMs, 200000);
    assert.strictEqual(DEFAULT_CONFIG.retryOnTimeout, true);
  });

  it('defaults taskTimeoutMs to 200000 and retryOnTimeout to true', () => {
    const crawler = new VevorCrawler({ inputExcel: './test/fixtures/sku-list.xlsx' });
    assert.strictEqual(crawler.config.taskTimeoutMs, 200000);
    assert.strictEqual(crawler.config.retryOnTimeout, true);
  });

  it('overrides taskTimeoutMs and retryOnTimeout from environment variables', () => {
    const originalTaskTimeout = process.env.CRAWLER_TASK_TIMEOUT_MS;
    const originalRetryOnTimeout = process.env.CRAWLER_RETRY_ON_TIMEOUT;
    process.env.CRAWLER_TASK_TIMEOUT_MS = '90000';
    process.env.CRAWLER_RETRY_ON_TIMEOUT = 'false';
    try {
      const crawler = new VevorCrawler({ inputExcel: './test/fixtures/sku-list.xlsx' });
      assert.strictEqual(crawler.config.taskTimeoutMs, 90000);
      assert.strictEqual(crawler.config.retryOnTimeout, false);
    } finally {
      if (originalTaskTimeout === undefined) {
        delete process.env.CRAWLER_TASK_TIMEOUT_MS;
      } else {
        process.env.CRAWLER_TASK_TIMEOUT_MS = originalTaskTimeout;
      }
      if (originalRetryOnTimeout === undefined) {
        delete process.env.CRAWLER_RETRY_ON_TIMEOUT;
      } else {
        process.env.CRAWLER_RETRY_ON_TIMEOUT = originalRetryOnTimeout;
      }
    }
  });

  it('falls back to 200000 when taskTimeoutMs env var is invalid', () => {
    const originalTaskTimeout = process.env.CRAWLER_TASK_TIMEOUT_MS;
    process.env.CRAWLER_TASK_TIMEOUT_MS = 'abc';
    try {
      const crawler = new VevorCrawler({ inputExcel: './test/fixtures/sku-list.xlsx' });
      assert.strictEqual(crawler.config.taskTimeoutMs, 200000);
    } finally {
      if (originalTaskTimeout === undefined) {
        delete process.env.CRAWLER_TASK_TIMEOUT_MS;
      } else {
        process.env.CRAWLER_TASK_TIMEOUT_MS = originalTaskTimeout;
      }
    }
  });
});
