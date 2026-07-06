# CF Challenge 旋转触发实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** Cloudflare challenge 在 `cloudflareMaxWait` 秒内未通过时，自动触发代理/IP 旋转，并在 `adaptive` stealth 模式下推动 fingerprint 切换。复用现有 `dataLayerProxyRotationThreshold` 计数器，不新增配置。

**架构：** `page-crawler` 在两处 CF 未通过分支（搜索结果页 + 产品详情页）改为返回 `{ status: 'not_found', error: 'CF_CHALLENGE_UNRESOLVED', dataLayerFailed: true, cfChallengeFailed: true }`。`channel.crawl()` catch 块扩展识别正则把这三种错误纳入 `dataLayerFailureCount`。`service.checkChannelForRotation` 自动接手，余下走现有旋转路径。

**技术栈：** Node.js + Playwright（已有），无新增依赖。

---

## 文件结构

| 文件 | 改动类型 | 职责 |
|---|---|---|
| `src/page-crawler.js` | 修改 | CF 未通过分支返回结构化 result + 调用 captureDiagnostics |
| `src/channel.js` | 修改 | catch 块中 dataLayer 错误识别正则增加 `CF_CHALLENGE_UNRESOLVED` |
| `deployment/crawlab/.env.example` | 修改 | 在 `DATA_LAYER_PROXY_ROTATION_THRESHOLD` 注释处补充 CF 失败共用此阈值 |
| `test/page-crawler-cf-rotation.test.js` | 新建 | page-crawler CF 失败行为测试 |
| `test/channel-cf-rotation.test.js` | 新建 | channel CF 失败 → dataLayerFailureCount 测试 |

### 不变的部分

- `service.checkChannelForRotation`：完全不改，它的 `dataLayerRequiresRotation` 触发逻辑已经把 CF 失败覆盖。
- `captureDiagnostics`：不变。
- `waitForCloudflare`：不变。
- 其他 channel/page-crawler 测试：不变，应保持绿灯。

---

## 任务 1：page-crawler CF 失败分支改造

**文件：**
- 修改：`src/page-crawler.js:348-355` （搜索阶段 CF 分支）
- 修改：`src/page-crawler.js:395-403` （详情阶段 CF 分支）
- 测试：`test/page-crawler-cf-rotation.test.js`（新建）

- [ ] **步骤 1：编写失败的测试（搜索阶段）**

在 `test/page-crawler-cf-rotation.test.js` 中写入：

```js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { PageCrawler, captureDiagnostics } = require('../src/page-crawler');

describe('PageCrawler Cloudflare challenge failure', () => {
  it('returns not_found + CF_CHALLENGE_UNRESOLVED + dataLayerFailed + cfChallengeFailed on search-page CF timeout', async () => {
    const crawler = new PageCrawler({
      baseUrl: 'https://eur.vevor.com',
      cloudflareMaxWait: 1, // 测试加速
      diagnosticDir: '/tmp/test-diag',
      imageDir: '/tmp/test-image',
    });

    const fakePage = {
      async goto() {},
      url: () => 'https://eur.vevor.com/s/TEST',
      async title() { return 'Just a moment...'; },
      async content() { return '<html><body>cf-browser-verification</body></html>'; },
    };

    const result = await crawler.crawlSingleSku('TEST-SKU', fakePage, async () => fakePage);

    assert.strictEqual(result.status, 'not_found');
    assert.strictEqual(result.error, 'CF_CHALLENGE_UNRESOLVED');
    assert.strictEqual(result.dataLayerFailed, true);
    assert.strictEqual(result.cfChallengeFailed, true);
    assert.strictEqual(result.sku, 'TEST-SKU');
  });
});
```

- [ ] **步骤 2：运行测试验证它正确失败**

```bash
cd /Users/nz/downloads/hs_sku/crawler
npm test -- test/page-crawler-cf-rotation.test.js
```

预期：FAIL，错误信息是 `result.error` 不等于 `'CF_CHALLENGE_UNRESOLLED'`（目前返回的是 `'Cloudflare challenge not resolved automatically'`）。

- [ ] **步骤 3：修改搜索阶段 CF 分支**

在 `src/page-crawler.js` 第 348-355 行（`isCloudflareChallenge(page)` 之后），把：

```js
if (await this.isCloudflareChallenge(page)) {
  const passed = await this.waitForCloudflare(page, sku);
  if (!passed) {
    result.status = 'error';
    result.error = 'Cloudflare challenge not resolved automatically';
    return result;
  }
}
```

替换为：

```js
if (await this.isCloudflareChallenge(page)) {
  const passed = await this.waitForCloudflare(page, sku);
  if (!passed) {
    try {
      await captureDiagnostics(page, sku, 'cf-challenge', this.config.diagnosticDir);
    } catch (diagErr) {
      this.log(`[${sku}] CF diagnostic capture failed: ${diagErr.message}`);
    }
    result.status = 'not_found';
    result.error = 'CF_CHALLENGE_UNRESOLVED';
    result.dataLayerFailed = true;
    result.cfChallengeFailed = true;
    this.log(`[${sku}] Cloudflare challenge not resolved after ${this.config.cloudflareMaxWait}s, marking not_found + rotation trigger`);
    return result;
  }
}
```

- [ ] **步骤 4：跑测试验证搜索阶段通过**

```bash
npm test -- test/page-crawler-cf-rotation.test.js
```

预期：第一个用例 PASS。

- [ ] **步骤 5：修改详情阶段 CF 分支**

在 `src/page-crawler.js` 第 395-403 行（产品详情页 goto 之后的 CF 检查），把：

```js
if (await this.isCloudflareChallenge(page)) {
  const passed = await this.waitForCloudflare(page, sku);
  if (!passed) {
    result.status = 'error';
    result.error = 'Cloudflare challenge on product page not resolved';
    return result;
  }
}
```

替换为：

```js
if (await this.isCloudflareChallenge(page)) {
  const passed = await this.waitForCloudflare(page, sku);
  if (!passed) {
    try {
      await captureDiagnostics(page, sku, 'cf-challenge-product', this.config.diagnosticDir);
    } catch (diagErr) {
      this.log(`[${sku}] CF diagnostic capture (product) failed: ${diagErr.message}`);
    }
    result.status = 'not_found';
    result.error = 'CF_CHALLENGE_UNRESOLVED';
    result.dataLayerFailed = true;
    result.cfChallengeFailed = true;
    this.log(`[${sku}] Cloudflare challenge on product page not resolved after ${this.config.cloudflareMaxWait}s, marking not_found + rotation trigger`);
    return result;
  }
}
```

- [ ] **步骤 6：新增详情阶段 CF 失败测试**

在 `test/page-crawler-cf-rotation.test.js` 现有 `describe` 块内追加：

```js
  it('returns not_found + CF_CHALLENGE_UNRESOLVED + dataLayerFailed + cfChallengeFailed on product-page CF timeout', async () => {
    const crawler = new PageCrawler({
      baseUrl: 'https://eur.vevor.com',
      cloudflareMaxWait: 1,
      diagnosticDir: '/tmp/test-diag',
      imageDir: '/tmp/test-image',
    });

    // 模拟搜索后跳转到 /p/，第二轮 CF 触发
    const fakePage = {
      async goto(url) {
        this.url = () => url;
      },
      url: () => 'https://eur.vevor.com/s/TEST',
      async title() { return 'Just a moment...'; },
      async content() { return '<html><body>cf-browser-verification</body></html>'; },
    };

    // 第一次 isCloudflareChallenge 返回 false 让搜索 pass，
    // 第二次返回 true 让详情 pass 触发。
    let cfCallCount = 0;
    crawler.isCloudflareChallenge = async () => {
      cfCallCount += 1;
      return cfCallCount >= 2;
    };
    crawler.waitForCloudflare = async () => false;
    crawler.extractProductUrlWithRetry = async () => ({ productUrl: 'https://eur.vevor.com/p/TEST', productName: 'Test', dataLayerFailed: false });

    const result = await crawler.crawlSingleSku('TEST-SKU', fakePage, async () => fakePage);

    assert.strictEqual(result.status, 'not_found');
    assert.strictEqual(result.error, 'CF_CHALLENGE_UNRESOLVED');
    assert.strictEqual(result.dataLayerFailed, true);
    assert.strictEqual(result.cfChallengeFailed, true);
  });
```

- [ ] **步骤 7：跑 page-crawler 全套测试**

```bash
npm test -- test/page-crawler-cf-rotation.test.js test/page-crawler.test.js test/page-crawler-goto-retry.test.js test/page-crawler-datalayer-fastpath.test.js test/page-crawler-datalayer-retry.test.js
```

预期：全部 PASS。如果有遗留 page-crawler 测试因为旧 error 文案 break，先单独修但不合并进本任务。

- [ ] **步骤 8：Commit**

```bash
git add src/page-crawler.js test/page-crawler-cf-rotation.test.js
git commit -m "feat(page-crawler): CF challenge timeout triggers rotation via not_found/dataLayerFailed"
```

---

## 任务 2：channel 错误识别扩展

**文件：**
- 修改：`src/channel.js:271` （catch 块的 `isDataLayerError` 判断行附近）
- 测试：`test/channel-cf-rotation.test.js`（新建）

- [ ] **步骤 1：编写失败的测试**

在 `test/channel-cf-rotation.test.js` 中写入：

```js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { Channel } = require('../src/channel');

function createSilentChannel(options = {}) {
  const log = () => {};
  const channel = new Channel({
    id: 1,
    config: {
      dataLayerProxyRotationThreshold: 1,
      dataLayerFailureThreshold: 3,
      ...options,
    },
    log,
  });
  return channel;
}

describe('Channel CF_CHALLENGE_UNRESOLVED handling', () => {
  it('returns not_found when crawlSingleSku throws CF_CHALLENGE_UNRESOLVED', async () => {
    const channel = createSilentChannel();
    channel.pageCrawler.crawlSingleSku = async () => {
      throw new Error('CF_CHALLENGE_UNRESOLVED');
    };

    const result = await channel.crawl({ sku: 'STUB-SKU', crawlerTaskId: 1 });
    assert.strictEqual(result.status, 'not_found');
    assert.strictEqual(result.error, 'CF_CHALLENGE_UNRESOLVED');
    assert.strictEqual(result.crawlerTaskId, 1);
  });

  it('increments dataLayerFailureCount and triggers needsProxyRotation for CF failure', async () => {
    const channel = createSilentChannel();
    channel.pageCrawler.crawlSingleSku = async () => {
      throw new Error('CF_CHALLENGE_UNRESOLVED');
    };

    await channel.crawl({ sku: 'A', crawlerTaskId: 1 });
    assert.strictEqual(channel.dataLayerFailureCount, 1);
    assert.strictEqual(channel.needsProxyRotation(), true);
  });

  it('does not throw CF errors to the caller', async () => {
    const channel = createSilentChannel();
    channel.pageCrawler.crawlSingleSku = async () => {
      throw new Error('CF_CHALLENGE_UNRESOLVED');
    };

    // 不应抛
    await channel.crawl({ sku: 'A', crawlerTaskId: 1 });
  });
});
```

- [ ] **步骤 2：运行测试验证它正确失败**

```bash
npm test -- test/channel-cf-rotation.test.js
```

预期：FAIL，错误是 channel.crawl() 仍向上抛 `CF_CHALLENGE_UNRESOLVED`，因为现有 catch 块不识别这个错误（只识别 `DATA_LAYER_NEVER_PUSHED|DATA_LAYER_MISSING`）。

- [ ] **步骤 3：扩展 channel catch 块的错误识别**

在 `src/channel.js` 第 271 行，把：

```js
const isDataLayerError = e.message && (/^DATA_LAYER_NEVER_PUSHED/.test(e.message) || /^DATA_LAYER_MISSING/.test(e.message));
```

替换为：

```js
const isDataLayerError = e.message && (
  /^DATA_LAYER_NEVER_PUSHED/.test(e.message) ||
  /^DATA_LAYER_MISSING/.test(e.message) ||
  /^CF_CHALLENGE_UNRESOLVED/.test(e.message)
);
```

- [ ] **步骤 4：跑测试验证通过**

```bash
npm test -- test/channel-cf-rotation.test.js
```

预期：3 个用例全部 PASS。

- [ ] **步骤 5：跑 channel 全套测试做 regression**

```bash
npm test -- test/channel-cf-rotation.test.js test/channel-datalayer-rotation.test.js test/channel.test.js test/channel-profile.test.js test/channel-proxy.test.js test/channel-page-refresh.test.js test/channel-headed-fallback.test.js test/channel-refresh-disconnected.test.js
```

预期：全部 PASS。

- [ ] **步骤 6：Commit**

```bash
git add src/channel.js test/channel-cf-rotation.test.js
git commit -m "feat(channel): recognize CF_CHALLENGE_UNRESOLVED as rotation-triggering failure"
```

---

## 任务 3：env example 注释更新

**文件：**
- 修改：`deployment/crawlab/.env.example:54-56` （`CRAWLER_DATA_LAYER_PROXY_ROTATION_THRESHOLD` 注释行）

- [ ] **步骤 1：更新注释**

在 `deployment/crawlab/.env.example` 第 54-56 行（描述 `DATA_LAYER_PROXY_ROTATION_THRESHOLD` 的位置），把：

```text
# 连续多少次 dataLayer 失败后主动旋转代理（需配置代理池才生效）
# 设为 1 时，一次 dataLayer 失败任务结束就换 IP
CRAWLER_DATA_LAYER_PROXY_ROTATION_THRESHOLD=1
```

替换为：

```text
# 连续多少次 dataLayer / Cloudflare challenge 失败后主动旋转代理（需配置代理池才生效）
# Cloudflare challenge 在 cloudflareMaxWait 秒内未通过视为失败
# 设为 1 时，一次失败任务结束就换 IP
CRAWLER_DATA_LAYER_PROXY_ROTATION_THRESHOLD=1
```

- [ ] **步骤 2：Commit**

```bash
git add deployment/crawlab/.env.example
git commit -m "docs(env): note that CRAWLER_DATA_LAYER_PROXY_ROTATION_THRESHOLD covers CF challenges"
```

---

## 任务 4：最终验证

- [ ] **步骤 1：跑全套测试**

```bash
cd /Users/nz/downloads/hs_sku/crawler
npm test
```

预期：所有测试 PASS，包括新增的 4 个 page-crawler 用例 + 3 个 channel 用例。

- [ ] **步骤 2：grep 防漏检查**

```bash
grep -n "Cloudflare challenge not resolved automatically\|Cloudflare challenge on product page not resolved" src/
```

预期：无输出（旧的 error 文案已全部替换）。

```bash
grep -n "CF_CHALLENGE_UNRESOLVED" src/ test/
```

预期：page-crawler.js 中 2 处定义 result.error、channel.js 中 1 处正则识别、test/ 两个文件中存在引用。

- [ ] **步骤 3：Commit（如有 lockfile 变更）**

```bash
git status
```

如果 lockfile 没变，跳过 commit；否则：

```bash
git add -A
git commit -m "chore: full test suite green after CF rotation trigger"
```

---

## 自检结果

**规格覆盖度：** 设计文档提到的所有 5 个改动点都已对应一个任务（page-crawler 搜索/详情两个分支 → 任务 1；channel 识别 → 任务 2；env 注释 → 任务 3；测试；全套验证 → 任务 4）。✅

**占位符扫描：** 没有 "TODO"、"待定"。所有步骤的代码块都是具体代码。✅

**类型一致性：** `cfChallengeFailed: true` 在任务 1 设置 → 任务 1 测试断言；`CF_CHALLENGE_UNRESOLVED` 在任务 1 写入 result → 任务 2 catch 块正则 → 任务 2 测试断言。`/^CF_CHALLENGE_UNRESOLVED/` 这一正则锚定开头，避免误匹配其他错误。✅

**YAGNI 检查：** 没有引入新的 counter、新的 env 配置或新的 channel 状态字段；`cfChallengeFailed` 只作为 result 上的 transient 字段，未持久化到 channel 状态。✅
