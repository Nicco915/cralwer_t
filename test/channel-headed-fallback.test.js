const { describe, it } = require('node:test');
const assert = require('node:assert');
const { Channel } = require('../src/channel');

function createMockBrowser() {
  let contextCount = 0;
  const contexts = [];
  return {
    async newContext() {
      contextCount++;
      const ctxId = contextCount;
      const pages = [];
      const context = {
        id: ctxId,
        async addInitScript() {},
        async newPage() {
          const page = {
            id: `page-${ctxId}-${pages.length + 1}`,
            closed: false,
            async close() { this.closed = true; },
            async goto() {},
            async evaluate() {},
          };
          pages.push(page);
          return page;
        },
        async close() {
          for (const p of pages) {
            if (!p.closed) await p.close();
          }
          this.closed = true;
        },
        closed: false,
        pages,
      };
      contexts.push(context);
      return context;
    },
    async close() {
      for (const ctx of contexts) {
        if (!ctx.closed) await ctx.close();
      }
      this.closed = true;
    },
    closed: false,
    contexts,
  };
}

describe('Channel headed fallback', () => {
  it('returns success when headed fallback succeeds', async () => {
    const mockBrowser = createMockBrowser();
    const channel = new Channel({
      id: 1,
      config: { headedFallback: true },
      log: () => {},
      headedBrowserLauncher: async () => mockBrowser,
    });

    // Mock pageCrawler.crawlSingleSku to return success
    channel.pageCrawler.crawlSingleSku = async (sku, page, recreateContext) => {
      return { status: 'success', sku };
    };

    const result = await channel.runHeadedFallback({ sku: 'ABC123' });
    assert.strictEqual(result.status, 'success');
    assert.strictEqual(mockBrowser.closed, true);
  });

  it('throws error when headed fallback fails', async () => {
    const mockBrowser = createMockBrowser();
    const channel = new Channel({
      id: 1,
      config: { headedFallback: true },
      log: () => {},
      headedBrowserLauncher: async () => mockBrowser,
    });

    channel.pageCrawler.crawlSingleSku = async () => {
      throw new Error('headed fallback failed');
    };

    await assert.rejects(
      async () => channel.runHeadedFallback({ sku: 'ABC123' }),
      /headed fallback failed/
    );
    assert.strictEqual(mockBrowser.closed, true);
  });

  it('closes headedContext when crawlSingleSku throws', async () => {
    const mockBrowser = createMockBrowser();
    const channel = new Channel({
      id: 1,
      config: { headedFallback: true },
      log: () => {},
      headedBrowserLauncher: async () => mockBrowser,
    });

    channel.pageCrawler.crawlSingleSku = async () => {
      throw new Error('boom');
    };

    try {
      await channel.runHeadedFallback({ sku: 'ABC123' });
    } catch (e) {
      // expected
    }

    // All contexts should be closed
    assert.strictEqual(mockBrowser.contexts.every(ctx => ctx.closed), true);
    // Browser should be closed
    assert.strictEqual(mockBrowser.closed, true);
  });

  it('closes headedContext and headedPage when recreateContext throws', async () => {
    const mockBrowser = createMockBrowser();
    const channel = new Channel({
      id: 1,
      config: { headedFallback: true },
      log: () => {},
      headedBrowserLauncher: async () => mockBrowser,
    });

    let callCount = 0;
    channel.pageCrawler.crawlSingleSku = async (sku, page, recreateContext) => {
      callCount++;
      if (callCount === 1) {
        // First call: trigger recreateContext, which will throw
        await recreateContext();
      }
      return { status: 'success' };
    };

    // Make newContext throw on second call (inside recreateContext)
    const originalNewContext = mockBrowser.newContext.bind(mockBrowser);
    let newContextCalls = 0;
    mockBrowser.newContext = async function (...args) {
      newContextCalls++;
      if (newContextCalls === 2) {
        throw new Error('newContext failed');
      }
      return originalNewContext(...args);
    };

    try {
      await channel.runHeadedFallback({ sku: 'ABC123' });
    } catch (e) {
      // expected
    }

    // First context should be closed (by recreateContext)
    assert.strictEqual(mockBrowser.contexts[0].closed, true);
    // Browser should be closed in finally
    assert.strictEqual(mockBrowser.closed, true);
  });

  it('does not trigger headed fallback for non-timeout errors', async () => {
    const mockBrowser = createMockBrowser();
    let headedFallbackCalled = false;
    const channel = new Channel({
      id: 1,
      config: { headedFallback: true },
      log: () => {},
      headedBrowserLauncher: async () => {
        headedFallbackCalled = true;
        return mockBrowser;
      },
    });

    // Simulate a non-timeout error in crawlSingleSku
    channel.pageCrawler.crawlSingleSku = async () => {
      throw new Error('Some random error');
    };

    await assert.rejects(
      async () => channel.crawl({ sku: 'ABC123', crawlerTaskId: 1 }),
      /Some random error/
    );

    assert.strictEqual(headedFallbackCalled, false);
  });

  it('triggers headed fallback for TimeoutError', async () => {
    const mockBrowser = createMockBrowser();
    let headedFallbackCalled = false;
    const channel = new Channel({
      id: 1,
      config: { headedFallback: true },
      log: () => {},
      headedBrowserLauncher: async () => {
        headedFallbackCalled = true;
        return mockBrowser;
      },
    });

    // Simulate a timeout error in crawlSingleSku (headless)
    channel.pageCrawler.crawlSingleSku = async (sku, page, recreateContext) => {
      if (!headedFallbackCalled) {
        const err = new Error('page.goto: Timeout 30000ms exceeded');
        err.name = 'TimeoutError';
        throw err;
      }
      return { status: 'success', sku };
    };

    const result = await channel.crawl({ sku: 'ABC123', crawlerTaskId: 1 });
    assert.strictEqual(result.status, 'success');
    assert.strictEqual(headedFallbackCalled, true);
    assert.strictEqual(mockBrowser.closed, true);
  });

  it('triggers headed fallback for timeout message without TimeoutError name', async () => {
    const mockBrowser = createMockBrowser();
    let headedFallbackCalled = false;
    const channel = new Channel({
      id: 1,
      config: { headedFallback: true },
      log: () => {},
      headedBrowserLauncher: async () => {
        headedFallbackCalled = true;
        return mockBrowser;
      },
    });

    channel.pageCrawler.crawlSingleSku = async (sku, page, recreateContext) => {
      if (!headedFallbackCalled) {
        throw new Error('page.waitForSelector: Timeout 5000ms exceeded');
      }
      return { status: 'success', sku };
    };

    const result = await channel.crawl({ sku: 'ABC123', crawlerTaskId: 1 });
    assert.strictEqual(result.status, 'success');
    assert.strictEqual(headedFallbackCalled, true);
    assert.strictEqual(mockBrowser.closed, true);
  });
});
