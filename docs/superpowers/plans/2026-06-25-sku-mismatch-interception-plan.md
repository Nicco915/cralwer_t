# SKU 不匹配拦截实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在当前正式爬取代码中增加 SKU 不匹配拦截，防止“搜索 SKU A 但实际抓取 SKU B 数据”写入 Excel，并在 checkpoint 中独立记录 mismatched_skus。

**架构：** 在 `src/page-crawler.js` 的 `PageCrawler` 中新增 `extractPageSku(page)` 方法并在 `crawlSingleSku` 进入商品详情页后、抓取任何数据前执行校验；在 `src/crawler.js` 中增加 `sku_mismatch` 状态分支并合并 checkpoint 默认值。

**技术栈：** Node.js、Playwright、node:test。

---

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `src/page-crawler.js` | 新增 `extractPageSku(page)`；修改 `crawlSingleSku` 流程，在抓取数据前校验页面真实 SKU。 |
| `src/crawler.js` | 合并 checkpoint 默认值；新增 `classifyResult` 方法处理 `sku_mismatch` 状态。 |
| `test/page-crawler.test.js` | 测试 `extractPageSku` 的多层提取与 `crawlSingleSku` 的匹配/不匹配/无法提取场景。 |
| `test/crawler-checkpoint.test.js` | 测试 `VevorCrawler.loadCheckpoint` 默认值合并与 `classifyResult` 状态分类。 |

---

## 任务 1：新增 `PageCrawler.extractPageSku(page)` 并测试

**文件：**
- 修改：`src/page-crawler.js`（在 `extractFromHtml` 方法之后插入新方法）
- 测试：`test/page-crawler.test.js`

### 步骤 1：编写失败的测试

创建 `test/page-crawler.test.js`：

```js
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
```

### 步骤 2：运行测试验证失败

```bash
node --test test/page-crawler.test.js
```

**预期：** FAIL，报错 `TypeError: crawler.extractPageSku is not a function`

### 步骤 3：编写最少实现代码

在 `src/page-crawler.js` 的 `extractFromHtml` 方法之后、`hasNoResult` 方法之前插入：

```js
  async extractPageSku(page) {
    try {
      const dlSku = await page.evaluate(() => {
        try {
          if (window.dataLayer) {
            for (const item of window.dataLayer) {
              if (item?.product?.sku) return item.product.sku;
              if (item?.ecommerce?.detail?.products?.[0]?.sku) return item.ecommerce.detail.products[0].sku;
            }
          }
          return '';
        } catch (e) {
          return '';
        }
      });
      if (dlSku) return dlSku;

      const html = await page.content();
      const match = html.match(/"sku":"([^"]{5,})"/);
      if (match) return match[1];
      const metaMatch = html.match(/<meta[^>]*sku[^>]*content="([^"]+)"/i);
      if (metaMatch) return metaMatch[1];
      return '';
    } catch (e) {
      return '';
    }
  }
```

### 步骤 4：运行测试验证通过

```bash
node --test test/page-crawler.test.js
```

**预期：** PASS（4 个测试全部通过）

### 步骤 5：Commit

```bash
git add test/page-crawler.test.js src/page-crawler.js
git commit -m "feat(page-crawler): 增加 extractPageSku 方法，支持从 dataLayer/HTML/meta 提取页面真实 SKU"
```

---

## 任务 2：在 `crawlSingleSku` 中增加 SKU 不匹配拦截

**文件：**
- 修改：`src/page-crawler.js:241-260` 附近
- 测试：`test/page-crawler.test.js`

### 步骤 1：编写失败的测试

在 `test/page-crawler.test.js` 末尾追加：

```js
function createFullMockPage(opts = {}) {
  let currentUrl = opts.url || '';
  return {
    goto: async (url) => { currentUrl = url; },
    url: () => currentUrl,
    evaluate: async (fn) => {
      if (opts.evaluate) return opts.evaluate(fn);
      return '';
    },
    content: async () => opts.html || '',
    $: async (selector) => {
      if (opts.elements && opts.elements[selector]) return opts.elements[selector];
      return null;
    },
    mouse: { move: async () => {} },
  };
}

describe('PageCrawler.crawlSingleSku SKU mismatch interception', () => {
  it('returns sku_mismatch when page SKU differs from searched SKU', async () => {
    const crawler = new PageCrawler();
    crawler.sleep = async () => {};
    crawler.isCloudflareChallenge = async () => false;
    crawler.extractProductUrlFromDataLayer = async () => ['https://eur.vevor.com/p/B-123', ''];
    crawler.extractFromHtml = async () => ['', ''];
    crawler.extractPageSku = async () => 'B-123';

    const page = createFullMockPage({ url: 'https://eur.vevor.com/p/B-123' });
    const result = await crawler.crawlSingleSku('A-123', page);

    assert.strictEqual(result.status, 'sku_mismatch');
    assert.ok(result.error.includes('A-123'));
    assert.ok(result.error.includes('B-123'));
    assert.strictEqual(result.product_url, 'https://eur.vevor.com/p/B-123');
    assert.strictEqual(result.product_name, '');
    assert.strictEqual(result.features_details, '');
    assert.strictEqual(result.product_specification, '');
  });

  it('continues crawling when page SKU matches searched SKU', async () => {
    const crawler = new PageCrawler();
    crawler.sleep = async () => {};
    crawler.isCloudflareChallenge = async () => false;
    crawler.extractProductUrlFromDataLayer = async () => ['https://eur.vevor.com/p/A-123', ''];
    crawler.extractFromHtml = async () => ['', ''];
    crawler.extractPageSku = async () => 'A-123';
    crawler.extractAllProductImages = async () => [];

    const page = createFullMockPage({
      url: 'https://eur.vevor.com/p/A-123',
      elements: { 'h1': { innerText: async () => 'Product A' } },
    });
    const result = await crawler.crawlSingleSku('A-123', page);

    assert.strictEqual(result.status, 'success');
    assert.strictEqual(result.product_name, 'Product A');
  });

  it('continues crawling when page SKU cannot be extracted', async () => {
    const crawler = new PageCrawler();
    crawler.sleep = async () => {};
    crawler.isCloudflareChallenge = async () => false;
    crawler.extractProductUrlFromDataLayer = async () => ['https://eur.vevor.com/p/A-123', ''];
    crawler.extractFromHtml = async () => ['', ''];
    crawler.extractPageSku = async () => '';
    crawler.extractAllProductImages = async () => [];

    const page = createFullMockPage({
      url: 'https://eur.vevor.com/p/A-123',
      elements: { 'h1': { innerText: async () => 'Product A' } },
    });
    const result = await crawler.crawlSingleSku('A-123', page);

    assert.strictEqual(result.status, 'success');
  });
});
```

### 步骤 2：运行测试验证失败

```bash
node --test test/page-crawler.test.js
```

**预期：** FAIL，新增的 `sku_mismatch` 测试返回 `success` 而不是 `sku_mismatch`

### 步骤 3：编写最少实现代码

在 `src/page-crawler.js` 的 `crawlSingleSku` 中，将：

```js
      await this.sleep(8000);

      if (!result.product_name) {
```

替换为：

```js
      await this.sleep(2000);

      const pageSku = await this.extractPageSku(page);
      if (pageSku && pageSku.toUpperCase() !== sku.toUpperCase()) {
        result.status = 'sku_mismatch';
        result.error = `SKU mismatch: searched ${sku}, page SKU is ${pageSku}`;
        result.product_url = page.url();
        this.log(`[${sku}] ${result.error}`);
        return result;
      }

      await this.sleep(6000);

      if (!result.product_name) {
```

### 步骤 4：运行测试验证通过

```bash
node --test test/page-crawler.test.js
```

**预期：** PASS（7 个测试全部通过）

### 步骤 5：Commit

```bash
git add test/page-crawler.test.js src/page-crawler.js
git commit -m "feat(page-crawler): 进入商品页后校验页面真实 SKU，不匹配时返回 sku_mismatch 并拦截抓取"
```

---

## 任务 3：更新 `src/crawler.js` checkpoint 与状态分类

**文件：**
- 修改：`src/crawler.js`
- 测试：`test/crawler-checkpoint.test.js`

### 步骤 1：编写失败的测试

创建 `test/crawler-checkpoint.test.js`：

```js
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { VevorCrawler } = require('../src/crawler');

describe('VevorCrawler checkpoint', () => {
  let tmpDir;
  let crawler;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-test-'));
    crawler = new VevorCrawler({
      inputExcel: path.join(tmpDir, 'input.xlsx'),
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loadCheckpoint returns default structure including mismatched_skus', () => {
    const checkpoint = crawler.loadCheckpoint();
    assert.deepStrictEqual(checkpoint, {
      completed_skus: [],
      failed_skus: [],
      not_found_skus: [],
      mismatched_skus: [],
      current_batch: 1,
      last_processed_index: -1,
    });
  });

  it('loadCheckpoint merges missing fields from defaults', () => {
    const checkpointFile = path.join(tmpDir, 'checkpoint.json');
    fs.writeFileSync(checkpointFile, JSON.stringify({
      completed_skus: ['A-001'],
      failed_skus: [],
      not_found_skus: [],
      current_batch: 2,
      last_processed_index: 0,
    }), 'utf-8');

    crawler.config.checkpointFile = checkpointFile;
    const checkpoint = crawler.loadCheckpoint();
    assert.deepStrictEqual(checkpoint.mismatched_skus, []);
    assert.deepStrictEqual(checkpoint.completed_skus, ['A-001']);
  });

  it('classifyResult puts sku_mismatch into mismatched_skus', () => {
    const checkpoint = {
      completed_skus: [],
      failed_skus: [],
      not_found_skus: [],
      mismatched_skus: [],
    };
    crawler.classifyResult(checkpoint, { sku: 'A-123', status: 'sku_mismatch' });
    assert.deepStrictEqual(checkpoint.mismatched_skus, ['A-123']);
    assert.deepStrictEqual(checkpoint.failed_skus, []);
  });

  it('classifyResult puts error into failed_skus', () => {
    const checkpoint = {
      completed_skus: [],
      failed_skus: [],
      not_found_skus: [],
      mismatched_skus: [],
    };
    crawler.classifyResult(checkpoint, { sku: 'A-123', status: 'error' });
    assert.deepStrictEqual(checkpoint.failed_skus, ['A-123']);
  });
});
```

### 步骤 2：运行测试验证失败

```bash
node --test test/crawler-checkpoint.test.js
```

**预期：** FAIL，报错 `TypeError: crawler.classifyResult is not a function` 或 `loadCheckpoint` 返回结构不匹配

### 步骤 3：编写最少实现代码

1. 在 `src/crawler.js` 的 `loadCheckpoint` 中合并默认值：

```js
  loadCheckpoint() {
    const { checkpointFile } = this.config;
    const defaults = {
      completed_skus: [],
      failed_skus: [],
      not_found_skus: [],
      mismatched_skus: [],
      current_batch: 1,
      last_processed_index: -1,
    };
    if (fs.existsSync(checkpointFile)) {
      const saved = JSON.parse(fs.readFileSync(checkpointFile, 'utf-8'));
      return { ...defaults, ...saved };
    }
    return defaults;
  }
```

2. 在 `VevorCrawler` 类中新增 `classifyResult` 方法：

```js
  classifyResult(checkpoint, result) {
    if (result.status === 'success') checkpoint.completed_skus.push(result.sku);
    else if (result.status === 'not_found') checkpoint.not_found_skus.push(result.sku);
    else if (result.status === 'sku_mismatch') checkpoint.mismatched_skus.push(result.sku);
    else checkpoint.failed_skus.push(result.sku);
  }
```

3. 在 `writerTask` 中两处重复的状态分类逻辑替换为 `this.classifyResult(checkpoint, r)`：

- 第一处（`src/crawler.js:435-437` 附近）：
  ```js
  // 替换前：
  if (r.status === 'success') checkpoint.completed_skus.push(r.sku);
  else if (r.status === 'not_found') checkpoint.not_found_skus.push(r.sku);
  else checkpoint.failed_skus.push(r.sku);

  // 替换后：
  this.classifyResult(checkpoint, r);
  ```

- 第二处（`src/crawler.js:462-464` 附近）：同样替换。

### 步骤 4：运行测试验证通过

```bash
node --test test/crawler-checkpoint.test.js
```

**预期：** PASS（4 个测试全部通过）

### 步骤 5：Commit

```bash
git add test/crawler-checkpoint.test.js src/crawler.js
git commit -m "feat(crawler): checkpoint 支持 mismatched_skus，统一状态分类逻辑"
```

---

## 任务 4：运行完整测试套件并修复回归

**文件：**
- 全部测试文件

### 步骤 1：运行全部测试

```bash
npm test
```

### 步骤 2：处理失败

- 若失败与本次改动相关，回到对应任务修复。
- 若失败是已有问题，记录并在本计划末尾注明。

### 步骤 3：确认通过

**预期：** 所有测试通过，终端输出类似：

```
✔ PageCrawler.extractPageSku ...
✔ PageCrawler.crawlSingleSku SKU mismatch interception ...
✔ VevorCrawler checkpoint ...
...
# tests 34
# pass 34
# fail 0
```

### 步骤 4：Commit（如测试文件或代码有调整）

```bash
git add .
git commit -m "test: 全量测试通过"
```

---

## 自检

**1. 规格覆盖度：**
- `extractPageSku` 多层提取 ✅ 任务 1
- 进入详情页后校验 SKU ✅ 任务 2
- 不匹配时返回 `sku_mismatch` 并拦截 ✅ 任务 2
- 无法提取时放行 ✅ 任务 2 第三个测试
- checkpoint 独立记录 `mismatched_skus` ✅ 任务 3

**2. 占位符扫描：**
- 无 TODO、待定、后续实现。
- 每个步骤包含具体代码和命令。

**3. 类型一致性：**
- `sku_mismatch` 状态名在设计、page-crawler、crawler 测试中一致。
- `mismatched_skus` 字段名在 checkpoint 默认值、loadCheckpoint、classifyResult 中一致。
