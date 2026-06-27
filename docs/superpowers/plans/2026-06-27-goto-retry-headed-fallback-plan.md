# 爬取导航重试与 headed fallback 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为正式服务代码引入 `page.goto` 三次尝试重试、 headed fallback 兜底、以及 channel 层定期刷新 page 的机制。

**架构：** 在 `src/page-crawler.js` 中新增 `gotoWithRetry` 和错误分类；在 `src/channel.js` 中封装 context/page 生命周期和 headed fallback 触发；`src/service.js` 向 channel 提供有头 browser 启动能力；配置项从 `bin/run.js` 和 `src/cli.js` 注入。

**技术栈：** Node.js 内置测试框架（`node:test` / `node:assert`）、Playwright、CommonJS。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/page-crawler.js` | 新增 `classifyGotoError()` 和 `gotoWithRetry()`；替换两处裸 `page.goto` 调用；在结果中支持 `timeout` 状态 |
| `src/channel.js` | 新增 `recreateContext()`、`refreshPage()`、`runHeadedFallback()`；维护 `tasksSincePageRefresh` 计数器；在 `crawl()` 中捕获整体 timeout 触发 headed fallback |
| `src/service.js` | 向 `Channel` 传入 `headedBrowserLauncher` 回调和 goto/page-refresh 相关配置 |
| `bin/run.js` | 新增 `gotoMaxRetries`、`gotoTimeout`、`gotoRetryDelays`、`headedFallback`、`pageRefreshAfterTasks` 默认值 |
| `src/cli.js` | 新增对应 CLI 参数和环境变量映射 |
| `test/page-crawler-goto-retry.test.js` | 测试 `classifyGotoError` 和 `gotoWithRetry` 的各种场景 |
| `test/channel-page-refresh.test.js` | 测试 channel 任务计数器和 `refreshPage()` |
| `test/page-crawler.test.js` | 现有测试，需补充 `timeout` 状态断言 |

---

## 任务 1：增加配置项

**文件：**
- 修改：`bin/run.js:19-42`
- 修改：`src/cli.js:22-62`、`src/cli.js:124-164`
- 测试：`test/cli-proxy-pool.test.js` 或新建 `test/cli.test.js`

目标：让服务可以接收 `gotoMaxRetries`、`gotoTimeout`、`gotoRetryDelays`、`headedFallback`、`pageRefreshAfterTasks` 配置。

- [ ] **步骤 1：在 `bin/run.js` 的 `buildServiceConfig` 中添加默认值**

在 `pushRetries` 之后、`proxy` 之前插入：

```js
gotoMaxRetries: config.gotoMaxRetries !== undefined ? Number(config.gotoMaxRetries) : 3,
gotoTimeout: config.gotoTimeout !== undefined ? Number(config.gotoTimeout) : 30000,
gotoRetryDelays: config.gotoRetryDelays || [3000, 6000, 12000],
headedFallback: config.headedFallback !== false && config.headedFallback !== 'false',
pageRefreshAfterTasks: config.pageRefreshAfterTasks !== undefined ? Number(config.pageRefreshAfterTasks) : 20,
```

- [ ] **步骤 2：在 `src/cli.js` 的 `FLAG_MAP` 中添加映射**

```js
'goto-max-retries': 'gotoMaxRetries',
'goto-timeout': 'gotoTimeout',
'goto-retry-delays': 'gotoRetryDelays',
'headed-fallback': 'headedFallback',
'page-refresh-after-tasks': 'pageRefreshAfterTasks',
```

- [ ] **步骤 3：在 `src/cli.js` 的 `BOOLEAN_FLAGS` 中添加 `headed-fallback`**

```js
const BOOLEAN_FLAGS = new Set([
  'headless',
  'translate',
  'feishu',
  'headed-fallback',
]);
```

并在 `BOOLEAN_CONFIG_KEYS` 中添加 `headedFallback`：

```js
const BOOLEAN_CONFIG_KEYS = new Set([
  'headless',
  'enableTranslation',
  'enableFeishu',
  'headedFallback',
]);
```

- [ ] **步骤 4：在 `src/cli.js` 的 `envMap` 中添加环境变量映射**

```js
CRAWLER_GOTO_MAX_RETRIES: 'gotoMaxRetries',
CRAWLER_GOTO_TIMEOUT: 'gotoTimeout',
CRAWLER_GOTO_RETRY_DELAYS: 'gotoRetryDelays',
CRAWLER_HEADED_FALLBACK: 'headedFallback',
CRAWLER_PAGE_REFRESH_AFTER_TASKS: 'pageRefreshAfterTasks',
```

注意：`gotoRetryDelays` 从环境变量读取时是逗号分隔字符串，需要在 `coerceValue` 中或 `parse` 返回前将其解析为数字数组。在 `parse` 函数末尾、return 之前添加：

```js
if (typeof config.gotoRetryDelays === 'string') {
  config.gotoRetryDelays = config.gotoRetryDelays.split(',').map(s => Number(s.trim())).filter(n => !Number.isNaN(n));
}
if (!config.gotoRetryDelays || config.gotoRetryDelays.length === 0) {
  config.gotoRetryDelays = [3000, 6000, 12000];
}
```

- [ ] **步骤 5：运行 CLI 测试验证配置解析**

```bash
node -e "const { parse } = require('./src/cli'); console.log(parse(['--goto-max-retries=5', '--goto-timeout=10000', '--goto-retry-delays=1000,2000,3000', '--no-headed-fallback', '--page-refresh-after-tasks=10']))"
```

预期输出包含：`gotoMaxRetries: 5`、`gotoTimeout: 10000`、`gotoRetryDelays: [1000, 2000, 3000]`、`headedFallback: false`、`pageRefreshAfterTasks: 10`。

- [ ] **步骤 6：Commit**

```bash
git add bin/run.js src/cli.js
git commit -m "feat(config): 增加 goto 重试与 headed fallback 配置项"
```

---

## 任务 2：在 `src/page-crawler.js` 中实现错误分类和 `gotoWithRetry`

**文件：**
- 修改：`src/page-crawler.js`
- 测试：`test/page-crawler-goto-retry.test.js`

目标：新增 `classifyGotoError(error)` 和 `gotoWithRetry(page, url, options)`，其中 options 包含 `sku`、`gotoMaxRetries`、`gotoTimeout`、`gotoRetryDelays`、`recreateContext` 回调。

- [ ] **步骤 1：编写失败的单元测试**

创建 `test/page-crawler-goto-retry.test.js`：

```js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { classifyGotoError, gotoWithRetry } = require('../src/page-crawler');

describe('classifyGotoError', () => {
  it('classifies timeout as retryable', () => {
    const err = new Error('page.goto: Timeout 30000ms exceeded');
    assert.strictEqual(classifyGotoError(err), 'retryable');
  });

  it('classifies proxy tunnel error as proxy', () => {
    const err = new Error('net::ERR_TUNNEL_CONNECTION_FAILED');
    assert.strictEqual(classifyGotoError(err), 'proxy');
  });

  it('classifies 403 as non-retryable', () => {
    const err = new Error('net::ERR_HTTP_RESPONSE_CODE_FAILURE');
    assert.strictEqual(classifyGotoError(err), 'non-retryable');
  });
});

describe('gotoWithRetry', () => {
  it('returns on first success', async () => {
    const calls = [];
    const page = {
      goto: async (url, opts) => {
        calls.push({ url, opts });
      },
    };
    await gotoWithRetry(page, 'https://example.com', { sku: 'SKU-1', gotoMaxRetries: 3, gotoTimeout: 30000, gotoRetryDelays: [100, 100, 100] });
    assert.strictEqual(calls.length, 1);
  });

  it('retries on timeout and succeeds on second attempt', async () => {
    const calls = [];
    const page = {
      goto: async (url, opts) => {
        calls.push({ url, opts });
        if (calls.length === 1) {
          throw new Error('page.goto: Timeout 30000ms exceeded');
        }
      },
    };
    await gotoWithRetry(page, 'https://example.com', { sku: 'SKU-1', gotoMaxRetries: 3, gotoTimeout: 30000, gotoRetryDelays: [50, 50, 50] });
    assert.strictEqual(calls.length, 2);
  });

  it('throws on non-retryable error without retrying', async () => {
    const calls = [];
    const page = {
      goto: async (url, opts) => {
        calls.push({ url, opts });
        throw new Error('net::ERR_HTTP_RESPONSE_CODE_FAILURE');
      },
    };
    await assert.rejects(
      () => gotoWithRetry(page, 'https://example.com', { sku: 'SKU-1', gotoMaxRetries: 3, gotoTimeout: 30000, gotoRetryDelays: [50, 50, 50] }),
      /ERR_HTTP_RESPONSE_CODE_FAILURE/
    );
    assert.strictEqual(calls.length, 1);
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

```bash
node --test test/page-crawler-goto-retry.test.js
```

预期：`classifyGotoError is not a function` 或类似错误。

- [ ] **步骤 3：在 `src/page-crawler.js` 中实现错误分类和 goto 重试**

在 `PageCrawler` 类之前或之后添加模块级函数（推荐放在类之后导出）：

```js
function classifyGotoError(error) {
  const msg = (error && error.message) || '';
  if (
    msg.includes('ERR_TUNNEL_CONNECTION_FAILED') ||
    msg.includes('ERR_PROXY_CONNECTION_FAILED') ||
    msg.includes('ERR_CONNECTION_RESET')
  ) {
    return 'proxy';
  }
  if (
    msg.includes('ERR_HTTP_RESPONSE_CODE_FAILURE') ||
    /\b4\d{2}\b/.test(msg) ||
    /\b5\d{2}\b/.test(msg) ||
    msg.includes('status code')
  ) {
    return 'non-retryable';
  }
  if (
    msg.includes('Timeout') ||
    msg.includes('timeout') ||
    msg.includes('ERR_NAME_NOT_RESOLVED') ||
    msg.includes('net::ERR') ||
    msg.includes('Navigation failed')
  ) {
    return 'retryable';
  }
  return 'non-retryable';
}

async function gotoWithRetry(page, url, options) {
  const {
    sku,
    gotoMaxRetries = 3,
    gotoTimeout = 30000,
    gotoRetryDelays = [3000, 6000, 12000],
    recreateContext,
    log = console.log,
  } = options || {};

  let lastError;
  for (let attempt = 0; attempt < gotoMaxRetries; attempt++) {
    try {
      return await page.goto(url, { waitUntil: 'domcontentloaded', timeout: gotoTimeout });
    } catch (e) {
      lastError = e;
      const category = classifyGotoError(e);
      if (category === 'proxy' || category === 'non-retryable') {
        throw e;
      }
      log(`[${sku}] goto attempt ${attempt + 1}/${gotoMaxRetries} failed for ${url}: ${e.message}`);
      if (attempt < gotoMaxRetries - 1) {
        const delay = gotoRetryDelays[attempt] || 5000;
        log(`[${sku}] Retrying goto in ${delay / 1000}s...`);
        await this.sleep(delay);
        if (attempt === gotoMaxRetries - 2 && typeof recreateContext === 'function') {
          log(`[${sku}] Recreating context for final goto attempt...`);
          page = await recreateContext();
        }
      }
    }
  }
  throw lastError;
}
```

注意：`gotoWithRetry` 中的 `this.sleep` 在模块级函数中不存在，需要改为使用 `PageCrawler.sleep` 静态方法或直接内联 `setTimeout`。这里改为：

```js
async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

然后在 `gotoWithRetry` 中使用 `await sleep(delay)`。

- [ ] **步骤 4：导出新增函数**

在 `module.exports` 中加上：

```js
module.exports = { PageCrawler, classifyGotoError, gotoWithRetry };
```

- [ ] **步骤 5：运行测试确认通过**

```bash
node --test test/page-crawler-goto-retry.test.js
```

预期：全部 PASS。

- [ ] **步骤 6：Commit**

```bash
git add src/page-crawler.js test/page-crawler-goto-retry.test.js
git commit -m "feat(page-crawler): 增加 goto 错误分类与三次重试"
```

---

## 任务 3：在 `src/page-crawler.js` 中替换两处裸 `page.goto`

**文件：**
- 修改：`src/page-crawler.js:231`、`src/page-crawler.js:272`
- 测试：`test/page-crawler.test.js`

目标：让 `crawlSingleSku` 使用 `gotoWithRetry`，并传入必要的配置和回调。

- [ ] **步骤 1：在 `PageCrawler` 构造函数中接收配置**

在 `constructor(options)` 中添加：

```js
this.gotoMaxRetries = options.gotoMaxRetries !== undefined ? options.gotoMaxRetries : 3;
this.gotoTimeout = options.gotoTimeout !== undefined ? options.gotoTimeout : 30000;
this.gotoRetryDelays = options.gotoRetryDelays || [3000, 6000, 12000];
```

- [ ] **步骤 2：修改 `crawlSingleSku` 签名**

将 `async crawlSingleSku(sku, page)` 改为 `async crawlSingleSku(sku, page, recreateContext)`。

- [ ] **步骤 3：替换第一处 `page.goto`**

将：

```js
await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
```

替换为：

```js
await gotoWithRetry(page, searchUrl, {
  sku,
  gotoMaxRetries: this.gotoMaxRetries,
  gotoTimeout: this.gotoTimeout,
  gotoRetryDelays: this.gotoRetryDelays,
  recreateContext,
  log: this.log.bind(this),
});
```

- [ ] **步骤 4：替换第二处 `page.goto`**

将：

```js
await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
```

替换为：

```js
await gotoWithRetry(page, productUrl, {
  sku,
  gotoMaxRetries: this.gotoMaxRetries,
  gotoTimeout: this.gotoTimeout,
  gotoRetryDelays: this.gotoRetryDelays,
  recreateContext,
  log: this.log.bind(this),
});
```

- [ ] **步骤 5：运行现有 page-crawler 测试**

```bash
node --test test/page-crawler.test.js
```

预期：全部 PASS（如果测试依赖裸 goto 的 60s 超时，需要更新测试 mock）。

- [ ] **步骤 6：Commit**

```bash
git add src/page-crawler.js
git commit -m "feat(page-crawler): crawlSingleSku 使用 gotoWithRetry"
```

---

## 任务 4：在 `src/channel.js` 中实现 `recreateContext` 和 `refreshPage`

**文件：**
- 修改：`src/channel.js`
- 测试：`test/channel-page-refresh.test.js`

目标：channel 能够重建 context/page，并在任务计数达到阈值后刷新 page。

- [ ] **步骤 1：编写失败的单元测试**

创建 `test/channel-page-refresh.test.js`：

```js
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const { Channel } = require('../src/channel');

function createFakeBrowser() {
  return {
    newContext: async () => ({
      addInitScript: async () => {},
      newPage: async () => ({
        goto: async () => {},
        evaluate: async () => '',
        content: async () => '',
        url: () => 'https://example.com',
        isClosed: () => false,
      }),
      close: async () => {},
    }),
    isConnected: () => true,
    close: async () => {},
  };
}

describe('Channel page refresh', () => {
  it('refreshes page after configured number of tasks', async () => {
    const fakeBrowser = createFakeBrowser();
    let newPageCalls = 0;
    fakeBrowser.newContext = async () => ({
      addInitScript: async () => {},
      newPage: async () => {
        newPageCalls++;
        return {
          goto: async () => {},
          evaluate: async () => '',
          content: async () => '',
          url: () => 'https://example.com',
          isClosed: () => false,
          close: async () => {},
        };
      },
      close: async () => {},
    });

    const channel = new Channel({
      id: 1,
      config: { baseUrl: 'https://example.com', imageDir: '/tmp', pageRefreshAfterTasks: 3 },
      log: () => {},
    });

    await channel.init(fakeBrowser);
    const originalPage = channel.page;

    // Simulate 3 tasks
    for (let i = 0; i < 3; i++) {
      channel.tasksSincePageRefresh++;
    }
    await channel.refreshPageIfNeeded();

    assert.notStrictEqual(channel.page, originalPage);
    assert.strictEqual(channel.tasksSincePageRefresh, 0);
    assert.strictEqual(newPageCalls, 1);
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

```bash
node --test test/channel-page-refresh.test.js
```

预期：`refreshPageIfNeeded is not a function`。

- [ ] **步骤 3：在 `Channel` 构造函数中添加计数器**

```js
this.tasksSincePageRefresh = 0;
this.pageRefreshAfterTasks = this.config.pageRefreshAfterTasks !== undefined ? this.config.pageRefreshAfterTasks : 20;
```

- [ ] **步骤 4：实现 `recreateContext`、`refreshPage`、`refreshPageIfNeeded`**

```js
async recreateContext(browser) {
  if (this.browserContext) {
    try {
      await this.browserContext.close();
    } catch (e) {
      // ignore
    }
  }
  const userAgent = this.config.userAgent || DEFAULT_USER_AGENT;
  const viewport = this.config.viewport || DEFAULT_VIEWPORT;
  const locale = this.config.locale || 'en-GB';
  const timezone = this.config.timezone || 'Europe/London';
  const contextOptions = { userAgent, viewport, locale, timezoneId: timezone };
  if (this.config.proxy) {
    contextOptions.proxy = { server: this.config.proxy };
  }
  this.browserContext = await browser.newContext(contextOptions);
  await this.browserContext.addInitScript(this.getStealthScript());
  this.page = await this.browserContext.newPage();
  this.log(`[Channel ${this.id}] context recreated`);
  return this.page;
}

async refreshPage() {
  if (!this.browserContext) return;
  if (this.page) {
    try {
      await this.page.close();
    } catch (e) {
      // ignore
    }
  }
  this.page = await this.browserContext.newPage();
  this.tasksSincePageRefresh = 0;
  this.log(`[Channel ${this.id}] page refreshed`);
}

async refreshPageIfNeeded() {
  if (this.pageRefreshAfterTasks > 0 && this.tasksSincePageRefresh >= this.pageRefreshAfterTasks) {
    await this.refreshPage();
  }
}
```

- [ ] **步骤 5：修改 `reinit` 使用 `recreateContext`**

```js
async reinit(browser, proxyOverride) {
  await this.close();
  await this.init(browser, proxyOverride);
}
```

当前 `reinit` 已如此，无需改动。但 `recreateContext` 和 `init` 有重复代码，后续可抽取公共 helper，本次保持简单。

- [ ] **步骤 6：运行测试确认通过**

```bash
node --test test/channel-page-refresh.test.js
```

预期：全部 PASS。

- [ ] **步骤 7：Commit**

```bash
git add src/channel.js test/channel-page-refresh.test.js
git commit -m "feat(channel): 增加 context 重建与 page 刷新机制"
```

---

## 任务 5：在 `src/channel.js` 中集成 `gotoWithRetry` 的 `recreateContext` 回调

**文件：**
- 修改：`src/channel.js`

目标：在 `channel.crawl()` 调用 `pageCrawler.crawlSingleSku` 时传入 `recreateContext` 回调。

- [ ] **步骤 1：修改 `crawl()` 中的调用**

将：

```js
const result = await this.pageCrawler.crawlSingleSku(task.sku, this.page);
```

替换为：

```js
const recreateContext = async () => this.recreateContext(this.browserContext.browser());
const result = await this.pageCrawler.crawlSingleSku(task.sku, this.page, recreateContext);
```

注意：需要安全获取 browser。`this.browserContext.browser()` 可能抛错，应包装：

```js
const recreateContext = async () => {
  const browser = this.browserContext ? this.browserContext.browser() : null;
  if (!browser) throw new Error('Browser context not available');
  return this.recreateContext(browser);
};
```

- [ ] **步骤 2：运行 channel 现有测试**

```bash
node --test test/channel.test.js
```

预期：全部 PASS。

- [ ] **步骤 3：Commit**

```bash
git add src/channel.js
git commit -m "feat(channel): 向 pageCrawler 传入 recreateContext 回调"
```

---

## 任务 6：在 `src/channel.js` 中实现 headed fallback

**文件：**
- 修改：`src/channel.js`
- 测试：`test/page-crawler-goto-retry.test.js` 或 `test/channel.test.js`

目标：当 `crawlSingleSku` 因 timeout 整体失败时，启动有头浏览器完整重跑一次。

- [ ] **步骤 1：在 `Channel` 构造函数中接收 `headedBrowserLauncher`**

```js
this.headedBrowserLauncher = options.headedBrowserLauncher || null;
this.headedFallback = options.config && options.config.headedFallback !== false;
```

- [ ] **步骤 2：实现 `runHeadedFallback(task)`**

```js
async runHeadedFallback(task) {
  if (!this.headedBrowserLauncher) {
    throw new Error('headedBrowserLauncher not configured');
  }
  const headedBrowser = await this.headedBrowserLauncher();
  try {
    const headedContext = await headedBrowser.newContext({
      userAgent: this.config.userAgent || DEFAULT_USER_AGENT,
      viewport: this.config.viewport || DEFAULT_VIEWPORT,
      locale: this.config.locale || 'en-GB',
      timezoneId: this.config.timezone || 'Europe/London',
      proxy: this.config.proxy ? { server: this.config.proxy } : undefined,
    });
    await headedContext.addInitScript(this.getStealthScript());
    const headedPage = await headedContext.newPage();
    const recreateContext = async () => {
      await headedContext.close();
      const newContext = await headedBrowser.newContext({
        userAgent: this.config.userAgent || DEFAULT_USER_AGENT,
        viewport: this.config.viewport || DEFAULT_VIEWPORT,
        locale: this.config.locale || 'en-GB',
        timezoneId: this.config.timezone || 'Europe/London',
        proxy: this.config.proxy ? { server: this.config.proxy } : undefined,
      });
      await newContext.addInitScript(this.getStealthScript());
      return newContext.newPage();
    };
    return await this.pageCrawler.crawlSingleSku(task.sku, headedPage, recreateContext);
  } finally {
    await headedBrowser.close();
  }
}
```

- [ ] **步骤 3：修改 `crawl()` 以触发 headed fallback**

在 `crawl()` 的 try/catch 中：

```js
try {
  this.log(`[Channel ${this.id}] start task ${task.crawlerTaskId} sku ${task.sku}`);
  let result;
  try {
    const recreateContext = async () => {
      const browser = this.browserContext ? this.browserContext.browser() : null;
      if (!browser) throw new Error('Browser context not available');
      return this.recreateContext(browser);
    };
    result = await this.pageCrawler.crawlSingleSku(task.sku, this.page, recreateContext);
  } catch (e) {
    const isTimeout = e.message && (e.message.includes('Timeout') || e.message.includes('timeout'));
    if (isTimeout && this.headedFallback && this.headedBrowserLauncher) {
      this.log(`[Channel ${this.id}] Headless timeout, trying headed fallback for task ${task.crawlerTaskId}`);
      result = await this.runHeadedFallback(task);
    } else {
      throw e;
    }
  }
  result.crawlerTaskId = task.crawlerTaskId;
  // ... 后续不变
}
```

- [ ] **步骤 4：增加失败计数和 page 刷新逻辑**

在 `crawl()` 的 `finally` 块中：

```js
finally {
  this.busy = false;
  this.currentTask = null;
  this.tasksSincePageRefresh++;
  await this.refreshPageIfNeeded();
}
```

注意：即使任务失败，计数也要递增。`refreshPageIfNeeded` 在失败任务后也可能触发刷新。

- [ ] **步骤 5：运行 channel 测试**

```bash
node --test test/channel.test.js
```

预期：全部 PASS。

- [ ] **步骤 6：Commit**

```bash
git add src/channel.js
git commit -m "feat(channel): 实现 headed fallback 兜底"
```

---

## 任务 7：在 `src/service.js` 中传入配置和 headed browser launcher

**文件：**
- 修改：`src/service.js:71-99`

目标：把 goto 重试配置、page 刷新配置、headed browser launcher 传给 channel。

- [ ] **步骤 1：修改 `initChannels` 中创建 Channel 的代码**

将 `initChannels` 中的 channel 配置对象扩展为：

```js
const channel = new Channel({
  id: i,
  config: {
    baseUrl: this.config.baseUrl,
    imageDir: this.config.imageDir,
    userAgent: this.config.userAgent,
    viewport: this.config.viewport,
    locale: this.config.locale,
    timezone: this.config.timezone,
    maxImages: this.config.maxImages,
    cloudflareMaxWait: this.config.cloudflareMaxWait,
    minDelay: this.config.minDelay,
    maxDelay: this.config.maxDelay,
    proxy,
    gotoMaxRetries: this.config.gotoMaxRetries,
    gotoTimeout: this.config.gotoTimeout,
    gotoRetryDelays: this.config.gotoRetryDelays,
    headedFallback: this.config.headedFallback,
    pageRefreshAfterTasks: this.config.pageRefreshAfterTasks,
  },
  headedBrowserLauncher: () => this.launchBrowser({ headless: false }),
  log: this.log.bind(this),
});
```

- [ ] **步骤 2：确保 `initBrowser` 接收可选 headless 参数**

`initBrowser` 当前签名是 `async initBrowser()`，使用 `this.config.headless`。需要改为：

```js
async initBrowser(options = {}) {
  const headless = options.headless !== undefined ? options.headless : this.config.headless;
  // ... 其余不变，把 this.config.headless 替换为 headless
}
```

- [ ] **步骤 3：运行 service 集成测试**

```bash
node --test test/service.integration.test.js
```

预期：全部 PASS（注意：测试可能耗时较长）。

- [ ] **步骤 4：Commit**

```bash
git add src/service.js
git commit -m "feat(service): 向 channel 注入 goto 重试配置与 headed browser launcher"
```

---

## 任务 8：新增 `timeout` 状态的处理

**文件：**
- 修改：`src/page-crawler.js`、`src/channel.js`、`src/worker.js`
- 测试：`test/page-crawler-goto-retry.test.js`、`test/worker.test.js`

目标：当所有重试和 headed fallback 都因 timeout 失败时，结果状态为 `timeout`。

- [ ] **步骤 1：在 `page-crawler.js` 的 `crawlSingleSku` 中返回 `timeout` 状态**

由于 `gotoWithRetry` 会抛出错误，`crawlSingleSku` 当前没有 catch。需要在 channel 层 catch 后判断。这部分已在任务 6 的 `runHeadedFallback` 和 `crawl()` 中处理。若 headed fallback 因 timeout 失败，`runHeadedFallback` 会抛出 timeout 错误，channel 需要将其转换为 `timeout` 状态。

- [ ] **步骤 2：在 `channel.js` 的 `crawl()` 中转换最终错误为结果**

修改 `crawl()` 使其不再向上抛错，而是返回结果对象（与现有 `worker.js` 通过 try/catch 处理的方式兼容）：

当前 `channel.crawl()` 在异常时会 throw，worker 会 catch 并生成 error 结果。为了新增 `timeout` 状态，可以：

**方案 A（推荐）**：保留 `channel.crawl()` 抛错语义，但抛出的错误对象携带 `status` 字段。`worker.js` 在 catch 时优先使用 `err.status`，否则为 `error`。

在 `channel.js` 的 `crawl()` catch 中：

```js
} catch (e) {
  this.consecutiveFailures++;
  this.lastFailureWasProxy = this.isProxyError(e);
  this.log(`[Channel ${this.id}] done task ${task.crawlerTaskId} status error message=${e.message}`);
  const isTimeout = e.message && (e.message.includes('Timeout') || e.message.includes('timeout'));
  if (isTimeout) {
    e.status = 'timeout';
  }
  throw e;
}
```

- [ ] **步骤 3：在 `worker.js` 中识别错误状态**

找到 `worker.js` 中处理 `channel.crawl()` 异常的代码，将：

```js
result = { status: 'error', error: e.message, ... };
```

改为：

```js
result = { status: e.status || 'error', error: e.message, ... };
```

- [ ] **步骤 4：编写测试验证 timeout 状态**

在 `test/page-crawler-goto-retry.test.js` 中增加：

```js
const { Channel } = require('../src/channel');

describe('Channel headed fallback timeout status', () => {
  it('returns timeout status when all retries and headed fallback fail with timeout', async () => {
    let launchCalls = 0;
    const fakeBrowser = {
      newContext: async () => ({
        addInitScript: async () => {},
        newPage: async () => ({
          goto: async () => { throw new Error('Timeout 30000ms exceeded'); },
          evaluate: async () => '',
          content: async () => '',
          url: () => 'https://example.com',
          isClosed: () => false,
          close: async () => {},
        }),
        close: async () => {},
      }),
      isConnected: () => true,
      close: async () => { launchCalls++; },
    };

    const channel = new Channel({
      id: 1,
      config: { baseUrl: 'https://example.com', imageDir: '/tmp', gotoMaxRetries: 2, gotoTimeout: 10, gotoRetryDelays: [10, 10], headedFallback: true },
      headedBrowserLauncher: async () => fakeBrowser,
      log: () => {},
    });

    // Mock pageCrawler to avoid full initialization
    channel.pageCrawler = {
      crawlSingleSku: async () => { throw new Error('Timeout 30000ms exceeded'); },
    };
    channel.page = { close: async () => {}, goto: async () => {} };
    channel.browserContext = { browser: () => fakeBrowser, close: async () => {} };

    const result = await channel.crawl({ crawlerTaskId: 1, sku: 'SKU-1' });
    assert.strictEqual(result.status, 'timeout');
  });
});
```

- [ ] **步骤 5：运行相关测试**

```bash
node --test test/page-crawler-goto-retry.test.js test/worker.test.js
```

预期：全部 PASS。

- [ ] **步骤 6：Commit**

```bash
git add src/page-crawler.js src/channel.js src/worker.js test/page-crawler-goto-retry.test.js
git commit -m "feat(channel/worker): 新增 timeout 状态传递"
```

---

## 任务 9：集成验证与运行

**文件：**
- 运行：`npm test` 或 `node --test test/*.test.js`

- [ ] **步骤 1：运行全部测试**

```bash
node --test test/*.test.js
```

预期：全部 PASS（注意：`test/real/` 下脚本可能需要单独运行）。

- [ ] **步骤 2：启动服务进行冒烟测试（可选）**

```bash
node bin/run.js --mode=service --channels=1 --poll-limit=1 --goto-max-retries=3 --goto-timeout=30000 --headed-fallback --page-refresh-after-tasks=10
```

观察日志中是否出现：`goto attempt X/3 failed`、`Retrying goto in Xs`、`Headless timeout, trying headed fallback`、`page refreshed` 等关键字。

- [ ] **步骤 3：Commit（如有测试或日志调整）**

```bash
git add .
git commit -m "test: 补充 goto 重试与 headed fallback 集成验证"
```

---

## 自检

### 规格覆盖度

- [x] `page.goto` 三次尝试重试 → 任务 2、3
- [x] 第 3 次尝试重建 context + page → 任务 2、5
- [x] 仅对 Timeout / 导航错误重试，4xx/5xx 不重试 → 任务 2
- [x] headed fallback → 任务 6
- [x] 新增 `timeout` 状态 → 任务 8
- [x] channel 定期刷新 page → 任务 4、5
- [x] 配置项 → 任务 1
- [x] 测试 → 任务 2、4、8、9

### 占位符扫描

计划中无"待定"、"TODO"、"后续实现"、"补充细节"、"类似任务 N"等占位符。

### 类型一致性

- `gotoMaxRetries`、`gotoTimeout`、`pageRefreshAfterTasks` 均为 Number。
- `gotoRetryDelays` 为 Number 数组。
- `headedFallback` 为 Boolean。
- `recreateContext` 返回新的 `page` 对象。
- 错误对象新增可选 `status` 字段，worker 读取时默认回退到 `'error'`。
