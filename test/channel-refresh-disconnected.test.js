const { describe, it } = require('node:test');
const assert = require('node:assert');
const { Channel } = require('../src/channel');

function createMockBrowser(connected = true) {
  return {
    connected,
    isConnected() {
      return this.connected;
    },
    async close() {},
  };
}

function createMockContext(browser, { newPageHangs = false } = {}) {
  return {
    closed: false,
    browser() {
      return browser;
    },
    async addInitScript() {},
    async newPage() {
      if (newPageHangs) {
        return new Promise(() => {});
      }
      return { close: async () => {} };
    },
    async close() {
      this.closed = true;
    },
  };
}

describe('Channel refreshPage when browser is disconnected', () => {
  it('does not hang waiting for newPage on a disconnected browser', async () => {
    const browser = createMockBrowser(false);
    const context = createMockContext(browser, { newPageHangs: true });
    const channel = new Channel({ id: 1, config: {}, log: () => {} });
    channel.browserContext = context;
    channel.page = { close: async () => {} };

    const start = Date.now();
    await channel.refreshPage();
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 1000, `refreshPage hung for ${elapsed}ms`);
    assert.strictEqual(channel.browserContext, null, 'context should be cleared');
    assert.strictEqual(channel.page, null, 'page should be cleared');
    assert.strictEqual(context.closed, true, 'context should be closed');
  });

  it('still creates a new page when browser is connected', async () => {
    const browser = createMockBrowser(true);
    const context = createMockContext(browser, { newPageHangs: false });
    const channel = new Channel({ id: 1, config: {}, log: () => {} });
    channel.browserContext = context;
    channel.page = { close: async () => {} };

    await channel.refreshPage();

    assert.strictEqual(channel.browserContext, context, 'context should remain');
    assert.ok(channel.page, 'page should be recreated');
  });
});
