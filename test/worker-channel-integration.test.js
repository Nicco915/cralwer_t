const { describe, it } = require('node:test');
const assert = require('node:assert');
const { Worker } = require('../src/worker');
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
            async evaluate() { return ''; },
            isClosed() { return this.closed; },
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
        browser() { return browser; },
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
    isConnected() { return true; },
    contexts,
  };
}

const browser = createMockBrowser();

describe('Worker + Channel integration', () => {
  it('processes a task without Channel is busy error', async () => {
    const pushed = [];
    const worker = new Worker({
      pusher: {
        push: async (result) => {
          pushed.push(result);
        },
      },
      log: () => {},
    });

    const channel = new Channel({
      id: 1,
      config: { nodeCode: 'crawler-01' },
      log: () => {},
    });

    await channel.init(browser);
    channel.pageCrawler.crawlSingleSku = async () => ({
      status: 'success',
      sku: 'TEST-001',
      product_name: 'Test Product',
      features_details: '',
      product_specification: '',
      product_url: 'https://example.com/test',
      error: '',
    });

    worker.addChannel(channel);
    worker.pushTasks([{ crawlerTaskId: 1n, sku: 'TEST-001' }]);
    worker.start();
    await worker.drain();

    assert.strictEqual(pushed.length, 1);
    assert.strictEqual(pushed[0].status, 'success', `expected success but got status=${pushed[0].status} error=${pushed[0].error}`);
    assert.strictEqual(pushed[0].sku, 'TEST-001');
  });
});
