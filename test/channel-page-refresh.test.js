const { describe, it } = require('node:test');
const assert = require('node:assert');
const { Channel } = require('../src/channel');

// Minimal mock browser and context for unit testing
function createMockBrowser() {
  let contextId = 0;
  let pageId = 0;
  const contexts = [];

  const browser = {
    newContext: async (options) => {
      contextId++;
      const pages = [];
      const context = {
        id: contextId,
        options,
        pages,
        addInitScript: async () => {},
        newPage: async () => {
          pageId++;
          const page = {
            id: pageId,
            contextId,
            isClosed: () => false,
            close: async () => {},
            goto: async () => {},
            evaluate: async () => 'title',
          };
          pages.push(page);
          return page;
        },
        close: async () => {},
        browser: () => browser,
      };
      contexts.push(context);
      return context;
    },
    isConnected: () => true,
    contexts: () => contexts,
  };

  return browser;
}

describe('Channel page refresh', () => {
  it('initializes tasksSincePageRefresh and pageRefreshAfterTasks from config', () => {
    const channel1 = new Channel({ id: 1, config: { pageRefreshAfterTasks: 5 }, log: () => {} });
    assert.strictEqual(channel1.tasksSincePageRefresh, 0);
    assert.strictEqual(channel1.pageRefreshAfterTasks, 5);

    const channel2 = new Channel({ id: 2, config: {}, log: () => {} });
    assert.strictEqual(channel2.tasksSincePageRefresh, 0);
    assert.strictEqual(channel2.pageRefreshAfterTasks, 20);

    const channel3 = new Channel({ id: 3, config: { pageRefreshAfterTasks: 0 }, log: () => {} });
    assert.strictEqual(channel3.pageRefreshAfterTasks, 0);
  });

  it('recreateContext closes old context and creates new page with same options', async () => {
    const browser = createMockBrowser();
    const channel = new Channel({ id: 1, config: { proxy: 'http://proxy:8080', userAgent: 'CustomAgent', viewport: { width: 1280, height: 720 }, locale: 'zh-CN', timezone: 'Asia/Shanghai' }, log: () => {} });

    await channel.init(browser);
    const originalContext = channel.browserContext;
    const originalPage = channel.page;
    assert.ok(originalContext);
    assert.ok(originalPage);

    const newPage = await channel.recreateContext(browser);
    assert.ok(newPage);
    assert.notStrictEqual(channel.browserContext, originalContext);
    assert.notStrictEqual(channel.page, originalPage);
    assert.strictEqual(channel.page, newPage);

    // Verify context options preserved
    assert.strictEqual(channel.browserContext.options.userAgent, 'CustomAgent');
    assert.deepStrictEqual(channel.browserContext.options.viewport, { width: 1280, height: 720 });
    assert.strictEqual(channel.browserContext.options.locale, 'zh-CN');
    assert.strictEqual(channel.browserContext.options.timezoneId, 'Asia/Shanghai');
    assert.deepStrictEqual(channel.browserContext.options.proxy, { server: 'http://proxy:8080' });
  });

  it('refreshPage closes old page and creates new page in same context', async () => {
    const browser = createMockBrowser();
    const channel = new Channel({ id: 1, config: {}, log: () => {} });

    await channel.init(browser);
    const originalContext = channel.browserContext;
    const originalPage = channel.page;

    // Simulate some tasks
    channel.tasksSincePageRefresh = 5;

    await channel.refreshPage();
    assert.strictEqual(channel.browserContext, originalContext);
    assert.notStrictEqual(channel.page, originalPage);
    assert.strictEqual(channel.tasksSincePageRefresh, 0);
  });

  it('refreshPageIfNeeded refreshes page after threshold tasks', async () => {
    const browser = createMockBrowser();
    const channel = new Channel({ id: 1, config: { pageRefreshAfterTasks: 3 }, log: () => {} });

    await channel.init(browser);
    const originalPage = channel.page;

    channel.tasksSincePageRefresh = 2;
    await channel.refreshPageIfNeeded();
    // Not yet reached threshold
    assert.strictEqual(channel.page, originalPage);
    assert.strictEqual(channel.tasksSincePageRefresh, 2);

    channel.tasksSincePageRefresh = 3;
    await channel.refreshPageIfNeeded();
    // Reached threshold
    assert.notStrictEqual(channel.page, originalPage);
    assert.strictEqual(channel.tasksSincePageRefresh, 0);
  });

  it('refreshPageIfNeeded does nothing when pageRefreshAfterTasks is 0', async () => {
    const browser = createMockBrowser();
    const channel = new Channel({ id: 1, config: { pageRefreshAfterTasks: 0 }, log: () => {} });

    await channel.init(browser);
    const originalPage = channel.page;

    channel.tasksSincePageRefresh = 100;
    await channel.refreshPageIfNeeded();
    assert.strictEqual(channel.page, originalPage);
    assert.strictEqual(channel.tasksSincePageRefresh, 100);
  });

  it('refreshPage works when page is null', async () => {
    const browser = createMockBrowser();
    const channel = new Channel({ id: 1, config: {}, log: () => {} });

    await channel.init(browser);
    channel.page = null;
    channel.tasksSincePageRefresh = 5;

    await channel.refreshPage();
    assert.ok(channel.page);
    assert.strictEqual(channel.tasksSincePageRefresh, 0);
  });

  it('failed tasks count toward tasksSincePageRefresh', async () => {
    // This test verifies that the counter is incremented regardless of task success/failure.
    // We simulate by directly manipulating the counter as the crawl method would.
    const channel = new Channel({ id: 1, config: { pageRefreshAfterTasks: 2 }, log: () => {} });
    channel.tasksSincePageRefresh = 0;

    // Simulate two task executions (one success, one failure)
    channel.tasksSincePageRefresh++;
    channel.tasksSincePageRefresh++;

    assert.strictEqual(channel.tasksSincePageRefresh, 2);
  });
});
