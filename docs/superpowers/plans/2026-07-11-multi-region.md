# 多区域爬取适配（regionCode） 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让单个爬虫节点按上游 task 里的 `regionCode`（CN/CA/US/EU/GB）动态切换目标站点，代理池（DE）不动，EU 行为零回归。

**架构：** 新增 `RegionRegistry`（区域码 → baseUrl 映射，内置五区域默认值，配置可覆盖）；Worker 在 `runTask` 入口把 `task.regionCode` 解析成 `task.baseUrl`（未知码 / 禁用码快速失败回推，不占通道）；Channel 把 `task.baseUrl` 透传给 `PageCrawler.crawlSingleSku`（每次调用级覆盖）；Pusher 回调回显 `regionCode`。与 main 上已有的 idle-reclaim（`Channel.ensureContext` / `lastActivityAt`）正交共存。

**技术栈：** Node.js 20、CommonJS、内置测试框架 `node:test`、Playwright。测试命令统一为 `node --test <file>`。

**基线与分支：** 当前工作分支 `main`（已含 idle-reclaim feature，最新提交 `7b2106a`）。本计划任务在 `main` 上顺序小步提交（如团队惯例用 feature 分支，先 `git checkout -b feat/multi-region`）。设计规格：`docs/superpowers/specs/2026-07-10-multi-region-design.md`（最新 regionCode 契约版在分支 `backup/multi-region-spec`，commit `d8d2c75`；本计划已把契约内联，不依赖工作区里的规格文件版本）。

**契约内联（以此为准）：**
- 请求：`{ "crawlerTaskId": 1, "sku": "ABC-001", "regionCode": "GB" }`；`regionCode ∈ CN|CA|US|EU|GB`，缺省 = 默认区域 `EU`。
- 映射：`EU=https://eur.vevor.com`，`GB=https://www.vevor.co.uk`，`CA=https://www.vevor.ca`，`US=https://www.vevor.com`，`CN=`（留空 = 已知但禁用）。
- 未知码 → `status:'error'` + `unknown regionCode: XX`，快速失败回推、不进通道、不崩节点；禁用码（CN）→ `region CN has no target site (disabled)`，文案与未知码区分。
- 回调新增 `regionCode` 字段回显（归一化后的码）。

---

## 文件结构

| 文件 | 职责 | 操作 |
|---|---|---|
| `src/region-registry.js` | 区域码 → baseUrl 映射：内置默认值 + `CRAWLER_REGIONS` 解析 + 归一化 + `resolve/isKnown` | 新建 |
| `src/page-crawler.js` | `crawlSingleSku` 增加可选第 4 参 `options.baseUrl`（每次调用级覆盖，缺省回退 `config.baseUrl`） | 修改 |
| `src/cli.js` | 新增 `--regions` / `--default-region` / `--clear-cookies-on-region-switch` 与对应 `CRAWLER_*` env 映射 | 修改 |
| `bin/run.js` | `buildServiceConfig` 透传 `regions` / `defaultRegion` / `clearCookiesOnRegionSwitch` | 修改 |
| `src/worker.js` | `runTask` 入口区域解析 + 快速失败回推 + `result.regionCode` 回显 + 日志 meta | 修改 |
| `src/channel.js` | 两处 `crawlSingleSku` 调用透传 `task.baseUrl`；可选跨区域 cookie 护栏（默认关） | 修改 |
| `src/pusher.js` | `buildBody` 增加 `regionCode` 字段 | 修改 |
| `src/service.js` | 构造 `RegionRegistry`、注入 Worker、向 Channel 传护栏开关、启动日志打印映射 | 修改 |
| `test/region-registry.test.js` | registry 单测 | 新建 |
| `test/page-crawler-region.test.js` | per-call baseUrl 覆盖单测 | 新建 |
| `test/cli-region-config.test.js` | CLI/env 映射单测 | 新建 |
| `test/service-config-region.test.js` | buildServiceConfig 透传单测 | 新建 |
| `test/pusher-region.test.js` | buildBody regionCode 单测 | 新建 |
| `test/worker-region.test.js` | Worker 路由/快速失败/回显集成单测 | 新建 |
| `test/channel-region.test.js` | Channel 透传 + cookie 护栏单测 | 新建 |
| `test/service-region-registry.test.js` | Service 接线单测 | 新建 |
| `deployment/linux/.env.example` + `scripts/deploy/windows/*/.env.example` + `README.md` | 三个新配置项文档 | 修改 |

不动：`src/poller.js`（spread 已透传 `regionCode`）、`src/crawler.js`（批量 CLI 模式保持单站点，本次只做 service 模式多区域）、代理池全部、健康检查/心跳/stealth。

---

## 任务 0：基线确认

**文件：** 无（只读）

- [ ] **步骤 1：确认分支与工作区干净**

运行：`git branch --show-current && git status --short`
预期：输出 `main`（或你新建的 feature 分支）；`logs/crawler.jsonl` 为未跟踪文件（**全程不要提交它**）。

- [ ] **步骤 2：确认无残留测试进程**（避免后续 `npm test` 被僵尸进程拖住）

运行：`pgrep -f "node --test" | wc -l`
预期：`0`。若 > 0 且确认是历史残留（`ps -o lstart= -p <pid>` 显示几天前），执行 `pkill -f "node --test"` 清理。

---

## 任务 1：RegionRegistry 映射表

**文件：**
- 创建：`src/region-registry.js`
- 测试：`test/region-registry.test.js`

- [ ] **步骤 1：编写失败的测试** `test/region-registry.test.js`

```js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { RegionRegistry, parseRegions } = require('../src/region-registry');

describe('parseRegions', () => {
  it('parses code=url pairs', () => {
    assert.deepStrictEqual(parseRegions('EU=https://eur.vevor.com,CA=https://www.vevor.ca'), {
      EU: 'https://eur.vevor.com',
      CA: 'https://www.vevor.ca',
    });
  });

  it('keeps empty value for disabled codes and uppercases codes', () => {
    assert.deepStrictEqual(parseRegions('cn=, us = https://www.vevor.com'), {
      CN: '',
      US: 'https://www.vevor.com',
    });
  });

  it('returns empty object for missing/garbage input', () => {
    assert.deepStrictEqual(parseRegions(undefined), {});
    assert.deepStrictEqual(parseRegions(''), {});
    assert.deepStrictEqual(parseRegions(' , ,'), {});
  });
});

describe('RegionRegistry', () => {
  it('resolves built-in region codes with zero config', () => {
    const reg = new RegionRegistry();
    assert.strictEqual(reg.resolve('EU'), 'https://eur.vevor.com');
    assert.strictEqual(reg.resolve('GB'), 'https://www.vevor.co.uk');
    assert.strictEqual(reg.resolve('CA'), 'https://www.vevor.ca');
    assert.strictEqual(reg.resolve('US'), 'https://www.vevor.com');
  });

  it('treats CN as known but disabled (null)', () => {
    const reg = new RegionRegistry();
    assert.strictEqual(reg.isKnown('CN'), true);
    assert.strictEqual(reg.resolve('CN'), null);
  });

  it('returns null and isKnown=false for unknown codes', () => {
    const reg = new RegionRegistry();
    assert.strictEqual(reg.isKnown('AU'), false);
    assert.strictEqual(reg.resolve('AU'), null);
  });

  it('normalizes case/whitespace and falls back to defaultRegion when empty', () => {
    const reg = new RegionRegistry();
    assert.strictEqual(reg.resolve('  gb '), 'https://www.vevor.co.uk');
    assert.strictEqual(reg.resolve(''), 'https://eur.vevor.com');
    assert.strictEqual(reg.resolve(undefined), 'https://eur.vevor.com');
  });

  it('lets CRAWLER_REGIONS override built-ins', () => {
    const reg = new RegionRegistry({ regions: 'US=https://us.internal.example' });
    assert.strictEqual(reg.resolve('US'), 'https://us.internal.example');
    assert.strictEqual(reg.resolve('GB'), 'https://www.vevor.co.uk');
  });

  it('legacyBaseUrl maps the default region when regions omits it (back-compat)', () => {
    const reg = new RegionRegistry({ legacyBaseUrl: 'https://legacy.example' });
    assert.strictEqual(reg.resolve('EU'), 'https://legacy.example');
    assert.strictEqual(reg.resolve(''), 'https://legacy.example');
  });

  it('regions entry beats legacyBaseUrl for the default region', () => {
    const reg = new RegionRegistry({ regions: 'EU=https://explicit.example', legacyBaseUrl: 'https://legacy.example' });
    assert.strictEqual(reg.resolve('EU'), 'https://explicit.example');
  });

  it('legacyBaseUrl applies to a non-EU defaultRegion too (deterministic rule)', () => {
    const reg = new RegionRegistry({ defaultRegion: 'GB', legacyBaseUrl: 'https://legacy.example' });
    assert.strictEqual(reg.resolve(''), 'https://legacy.example');
  });

  it('honors a non-EU defaultRegion without legacyBaseUrl', () => {
    const reg = new RegionRegistry({ defaultRegion: 'gb' });
    assert.strictEqual(reg.resolve(''), 'https://www.vevor.co.uk');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/region-registry.test.js`
预期：FAIL，报错 `Cannot find module '../src/region-registry'`。

- [ ] **步骤 3：编写实现** `src/region-registry.js`

```js
'use strict';

// VEVOR 各区域站的 canonical URL（公开事实，非密钥）。
// 空字符串 = 已知区域但无目标站（禁用），resolve 返回 null。
const BUILT_IN_REGIONS = {
  EU: 'https://eur.vevor.com',
  GB: 'https://www.vevor.co.uk',
  CA: 'https://www.vevor.ca',
  US: 'https://www.vevor.com',
  CN: '',
};

// 解析 'EU=https://eur.vevor.com,CN=' 形式的配置串：
// 无 '=' 的片段视为禁用码；空片段跳过；区域码统一大写。
function parseRegions(raw) {
  const out = {};
  if (!raw || typeof raw !== 'string') return out;
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      out[trimmed.toUpperCase()] = '';
      continue;
    }
    const code = trimmed.slice(0, eq).trim().toUpperCase();
    if (!code) continue;
    out[code] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

class RegionRegistry {
  constructor({ regions, defaultRegion = 'EU', legacyBaseUrl } = {}) {
    this.defaultRegion = String(defaultRegion || 'EU').trim().toUpperCase() || 'EU';
    const explicit = parseRegions(regions);
    this.map = { ...BUILT_IN_REGIONS, ...explicit };
    // 兼容旧的 CRAWLER_BASE_URL：单站点模式下该 URL = 默认区域的站点
    if (!(this.defaultRegion in explicit) && legacyBaseUrl) {
      this.map[this.defaultRegion] = legacyBaseUrl;
    }
  }

  // 缺省/空白 → 默认区域；其余 trim + upper 后原样返回
  normalize(code) {
    const c = String(code == null ? '' : code).trim().toUpperCase();
    return c === '' ? this.defaultRegion : c;
  }

  isKnown(code) {
    return Object.prototype.hasOwnProperty.call(this.map, this.normalize(code));
  }

  // 返回 baseUrl；未知码或禁用码（空 URL）返回 null
  resolve(code) {
    const c = this.normalize(code);
    if (!Object.prototype.hasOwnProperty.call(this.map, c)) return null;
    return this.map[c] || null;
  }
}

module.exports = { RegionRegistry, BUILT_IN_REGIONS, parseRegions };
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test test/region-registry.test.js`
预期：PASS，`tests 11 / pass 11 / fail 0`。

- [ ] **步骤 5：Commit**

```bash
git add src/region-registry.js test/region-registry.test.js
git commit -m "feat(crawler): 新增 RegionRegistry（区域码→baseUrl 映射，内置 CN/CA/US/EU/GB）"
```

---

## 任务 2：PageCrawler 支持每次调用覆盖 baseUrl

**文件：**
- 修改：`src/page-crawler.js`（`crawlSingleSku`，约第 340-341 行）
- 测试：`test/page-crawler-region.test.js`

- [ ] **步骤 1：编写失败的测试** `test/page-crawler-region.test.js`（沿用 `test/page-crawler.test.js` 的 mock 模式）

```js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { PageCrawler } = require('../src/page-crawler');

function createMockPage(opts = {}) {
  let currentUrl = opts.url || '';
  const customGoto = opts.goto;
  return {
    goto: async (url) => { if (customGoto) await customGoto(url); currentUrl = url; },
    url: () => currentUrl,
    evaluate: async () => '',
    content: async () => '',
    $: async () => null,
    mouse: { move: async () => {} },
  };
}

function stubCrawler(crawler, productUrl) {
  crawler.sleep = async () => {};
  crawler.isCloudflareChallenge = async () => false;
  crawler.extractProductUrlFromDataLayer = async () => [productUrl, ''];
  crawler.extractFromHtml = async () => ['', ''];
  crawler.extractPageSku = async () => 'A-123';
  crawler.extractAllProductImages = async () => [];
}

describe('PageCrawler.crawlSingleSku per-call baseUrl', () => {
  it('uses options.baseUrl for the search URL when provided', async () => {
    const crawler = new PageCrawler({ baseUrl: 'https://eur.vevor.com' });
    stubCrawler(crawler, 'https://www.vevor.ca/p/A-123');
    const visited = [];
    const page = createMockPage({
      url: 'https://www.vevor.ca/p/A-123',
      goto: async (u) => { visited.push(u); },
      elements: { 'h1': { innerText: async () => 'T' } },
    });

    await crawler.crawlSingleSku('A-123', page, undefined, { baseUrl: 'https://www.vevor.ca' });

    assert.strictEqual(visited[0], 'https://www.vevor.ca/s/A%2D123');
  });

  it('falls back to config.baseUrl when options.baseUrl is absent', async () => {
    const crawler = new PageCrawler({ baseUrl: 'https://eur.vevor.com' });
    stubCrawler(crawler, 'https://eur.vevor.com/p/A-123');
    const visited = [];
    const page = createMockPage({
      url: 'https://eur.vevor.com/p/A-123',
      goto: async (u) => { visited.push(u); },
      elements: { 'h1': { innerText: async () => 'T' } },
    });

    await crawler.crawlSingleSku('A-123', page);

    assert.strictEqual(visited[0], 'https://eur.vevor.com/s/A%2D123');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/page-crawler-region.test.js`
预期：FAIL（断言 `visited[0]` 仍是 `https://eur.vevor.com/s/A%2D123`，因为第 4 参尚未生效）。

- [ ] **步骤 3：修改 `src/page-crawler.js`**

把 `crawlSingleSku` 的签名与 baseUrl 取值改为（仅这两处，其余不动）：

```js
  async crawlSingleSku(sku, page, recreateContext, options = {}) {
    const { imageDir, maxImages } = this.config;
    const baseUrl = options.baseUrl || this.config.baseUrl;
```

（原代码为 `async crawlSingleSku(sku, page, recreateContext) {` 与 `const { baseUrl, imageDir, maxImages } = this.config;`。）

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test test/page-crawler-region.test.js test/page-crawler.test.js`
预期：全部 PASS（旧测试验证向后兼容）。

- [ ] **步骤 5：Commit**

```bash
git add src/page-crawler.js test/page-crawler-region.test.js
git commit -m "feat(crawler): crawlSingleSku 支持每次调用覆盖 baseUrl（多区域前置）"
```

---

## 任务 3：CLI 新增区域配置项

**文件：**
- 修改：`src/cli.js`（FLAG_MAP / BOOLEAN_FLAGS / BOOLEAN_CONFIG_KEYS / envMap）
- 测试：`test/cli-region-config.test.js`

- [ ] **步骤 1：编写失败的测试** `test/cli-region-config.test.js`

```js
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { parse } = require('../src/cli');

const ENV_KEYS = ['CRAWLER_REGIONS', 'CRAWLER_DEFAULT_REGION', 'CRAWLER_CLEAR_COOKIES_ON_REGION_SWITCH'];
const saved = {};
beforeEach(() => { for (const k of ENV_KEYS) saved[k] = process.env[k]; });
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('cli region config', () => {
  it('maps CRAWLER_REGIONS / CRAWLER_DEFAULT_REGION env', () => {
    process.env.CRAWLER_REGIONS = 'EU=https://eur.vevor.com,CN=';
    process.env.CRAWLER_DEFAULT_REGION = 'GB';
    const config = parse([]);
    assert.strictEqual(config.regions, 'EU=https://eur.vevor.com,CN=');
    assert.strictEqual(config.defaultRegion, 'GB');
  });

  it('maps --regions / --default-region flags', () => {
    delete process.env.CRAWLER_REGIONS;
    delete process.env.CRAWLER_DEFAULT_REGION;
    const config = parse(['--regions=EU=https://eur.vevor.com', '--default-region', 'CA']);
    assert.strictEqual(config.regions, 'EU=https://eur.vevor.com');
    assert.strictEqual(config.defaultRegion, 'CA');
  });

  it('parses CRAWLER_CLEAR_COOKIES_ON_REGION_SWITCH as boolean', () => {
    process.env.CRAWLER_CLEAR_COOKIES_ON_REGION_SWITCH = 'true';
    assert.strictEqual(parse([]).clearCookiesOnRegionSwitch, true);
    process.env.CRAWLER_CLEAR_COOKIES_ON_REGION_SWITCH = 'false';
    assert.strictEqual(parse([]).clearCookiesOnRegionSwitch, false);
  });

  it('parses --clear-cookies-on-region-switch / --no-clear-cookies-on-region-switch', () => {
    delete process.env.CRAWLER_CLEAR_COOKIES_ON_REGION_SWITCH;
    assert.strictEqual(parse(['--clear-cookies-on-region-switch']).clearCookiesOnRegionSwitch, true);
    assert.strictEqual(parse(['--no-clear-cookies-on-region-switch']).clearCookiesOnRegionSwitch, false);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/cli-region-config.test.js`
预期：FAIL（`config.regions` / `config.clearCookiesOnRegionSwitch` 为 undefined）。

- [ ] **步骤 3：修改 `src/cli.js`（4 处追加）**

在 `FLAG_MAP` 末尾（`'heartbeat-interval': 'heartbeatInterval',` 之后）追加：

```js
  regions: 'regions',
  'default-region': 'defaultRegion',
  'clear-cookies-on-region-switch': 'clearCookiesOnRegionSwitch',
```

在 `BOOLEAN_FLAGS` 的 Set 里追加：

```js
  'clear-cookies-on-region-switch',
```

在 `BOOLEAN_CONFIG_KEYS` 的 Set 里追加：

```js
  'clearCookiesOnRegionSwitch',
```

在 `envMap` 末尾（`CRAWLER_CLIPROXY_ROTATION_COOLDOWN_MS` 之后）追加：

```js
    CRAWLER_REGIONS: 'regions',
    CRAWLER_DEFAULT_REGION: 'defaultRegion',
    CRAWLER_CLEAR_COOKIES_ON_REGION_SWITCH: 'clearCookiesOnRegionSwitch',
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test test/cli-region-config.test.js test/cli-proxy-pool.test.js test/cli-heartbeat-config.test.js`
预期：全部 PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/cli.js test/cli-region-config.test.js
git commit -m "feat(cli): 新增 --regions/--default-region/--clear-cookies-on-region-switch 与 CRAWLER_* 环境变量"
```

---

## 任务 4：buildServiceConfig 透传区域配置

**文件：**
- 修改：`bin/run.js`（`buildServiceConfig`，约第 11 行后）
- 测试：`test/service-config-region.test.js`

- [ ] **步骤 1：编写失败的测试** `test/service-config-region.test.js`

```js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { buildServiceConfig } = require('../bin/run.js');

describe('buildServiceConfig region passthrough', () => {
  it('passes regions / defaultRegion / clearCookiesOnRegionSwitch through', () => {
    const cfg = buildServiceConfig({
      regions: 'EU=https://eur.vevor.com,CN=',
      defaultRegion: 'GB',
      clearCookiesOnRegionSwitch: true,
    });
    assert.strictEqual(cfg.regions, 'EU=https://eur.vevor.com,CN=');
    assert.strictEqual(cfg.defaultRegion, 'GB');
    assert.strictEqual(cfg.clearCookiesOnRegionSwitch, true);
  });

  it('defaults defaultRegion to EU and the cookie guard to off', () => {
    const cfg = buildServiceConfig({});
    assert.strictEqual(cfg.defaultRegion, 'EU');
    assert.strictEqual(cfg.clearCookiesOnRegionSwitch, false);
    assert.strictEqual(cfg.regions, undefined);
  });

  it('tolerates string "true" from programmatic callers', () => {
    const cfg = buildServiceConfig({ clearCookiesOnRegionSwitch: 'true' });
    assert.strictEqual(cfg.clearCookiesOnRegionSwitch, true);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/service-config-region.test.js`
预期：FAIL（`cfg.defaultRegion` / `cfg.clearCookiesOnRegionSwitch` 不符）。

- [ ] **步骤 3：修改 `bin/run.js`**

在 `buildServiceConfig` 返回对象的第一行 `baseUrl: config.baseUrl || 'https://eur.vevor.com',` 之后插入：

```js
    regions: config.regions,
    defaultRegion: config.defaultRegion || 'EU',
    clearCookiesOnRegionSwitch: config.clearCookiesOnRegionSwitch === true || config.clearCookiesOnRegionSwitch === 'true',
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test test/service-config-region.test.js test/bin-run.test.js`
预期：全部 PASS。

- [ ] **步骤 5：Commit**

```bash
git add bin/run.js test/service-config-region.test.js
git commit -m "feat(crawler): buildServiceConfig 透传 regions/defaultRegion/cookie 护栏开关"
```

---

## 任务 5：Pusher 回调回显 regionCode

**文件：**
- 修改：`src/pusher.js`（`buildBody`）
- 测试：`test/pusher-region.test.js`

- [ ] **步骤 1：编写失败的测试** `test/pusher-region.test.js`

```js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { Pusher } = require('../src/pusher');

describe('Pusher.buildBody regionCode', () => {
  it('includes regionCode from the result', () => {
    const pusher = new Pusher({ callbackUrl: 'http://x/callback', nodeCode: 'n1', nodeToken: 't' });
    const body = pusher.buildBody({ crawlerTaskId: 1, sku: 'S', status: 'success', regionCode: 'CA' });
    assert.strictEqual(body.regionCode, 'CA');
  });

  it('defaults regionCode to empty string when absent', () => {
    const pusher = new Pusher({ callbackUrl: 'http://x/callback', nodeCode: 'n1', nodeToken: 't' });
    const body = pusher.buildBody({ crawlerTaskId: 1, sku: 'S', status: 'error' });
    assert.strictEqual(body.regionCode, '');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/pusher-region.test.js`
预期：FAIL（`body.regionCode` 为 undefined）。

- [ ] **步骤 3：修改 `src/pusher.js` 的 `buildBody`**

在返回对象的 `sku: result.sku,` 之后插入一行：

```js
      regionCode: result.regionCode || '',
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test test/pusher-region.test.js test/pusher.test.js`
预期：全部 PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/pusher.js test/pusher-region.test.js
git commit -m "feat(crawler): 回调 payload 新增 regionCode 回显"
```

---

## 任务 6：Worker 区域路由与快速失败

**文件：**
- 修改：`src/worker.js`（constructor / `buildErrorResult` / `runTask` 入口 / push 前 / logger meta）
- 测试：`test/worker-region.test.js`

- [ ] **步骤 1：编写失败的测试** `test/worker-region.test.js`

```js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { Worker } = require('../src/worker');
const { RegionRegistry } = require('../src/region-registry');

function makePusher() {
  return { pushed: [], async push(r) { this.pushed.push(r); } };
}

function makeChannel() {
  return {
    id: 1,
    busy: false,
    reinitializing: false,
    onTaskComplete: null,
    crawlCalls: [],
    async crawl(task) {
      this.crawlCalls.push(task);
      return {
        sku: task.sku,
        status: 'success',
        product_name: 'X',
        product_url: `${task.baseUrl || ''}/p/X`,
        features_details: '',
        product_specification: '',
      };
    },
  };
}

function makeWorker() {
  const pusher = makePusher();
  const channel = makeChannel();
  const worker = new Worker({ pusher, log: () => {}, regionRegistry: new RegionRegistry() });
  return { worker, pusher, channel };
}

describe('Worker multi-region routing', () => {
  it('resolves task.regionCode to task.baseUrl and echoes regionCode on the result', async () => {
    const { worker, pusher, channel } = makeWorker();
    const result = await worker.runTask({ crawlerTaskId: 1, sku: 'S1', regionCode: 'CA' }, channel);
    assert.strictEqual(channel.crawlCalls.length, 1);
    assert.strictEqual(channel.crawlCalls[0].baseUrl, 'https://www.vevor.ca');
    assert.strictEqual(result.regionCode, 'CA');
    assert.strictEqual(pusher.pushed.length, 1);
    assert.strictEqual(pusher.pushed[0].regionCode, 'CA');
  });

  it('defaults missing regionCode to EU', async () => {
    const { worker, channel } = makeWorker();
    await worker.runTask({ crawlerTaskId: 2, sku: 'S2' }, channel);
    assert.strictEqual(channel.crawlCalls[0].baseUrl, 'https://eur.vevor.com');
    assert.strictEqual(channel.crawlCalls[0].regionCode, 'EU');
  });

  it('normalizes case/whitespace of regionCode', async () => {
    const { worker, channel } = makeWorker();
    await worker.runTask({ crawlerTaskId: 5, sku: 'S5', regionCode: '  gb ' }, channel);
    assert.strictEqual(channel.crawlCalls[0].baseUrl, 'https://www.vevor.co.uk');
    assert.strictEqual(channel.crawlCalls[0].regionCode, 'GB');
  });

  it('fails unknown regionCode fast without occupying the channel', async () => {
    const { worker, pusher, channel } = makeWorker();
    const result = await worker.runTask({ crawlerTaskId: 3, sku: 'S3', regionCode: 'AU' }, channel);
    assert.strictEqual(channel.crawlCalls.length, 0);
    assert.strictEqual(channel.busy, false);
    assert.strictEqual(result.status, 'error');
    assert.match(result.error, /unknown regionCode: AU/);
    assert.strictEqual(pusher.pushed.length, 1);
    assert.strictEqual(pusher.pushed[0].regionCode, 'AU');
  });

  it('fails disabled regionCode (CN) with a distinct message without crawling', async () => {
    const { worker, pusher, channel } = makeWorker();
    const result = await worker.runTask({ crawlerTaskId: 4, sku: 'S4', regionCode: 'CN' }, channel);
    assert.strictEqual(channel.crawlCalls.length, 0);
    assert.strictEqual(channel.busy, false);
    assert.match(result.error, /region CN has no target site \(disabled\)/);
    assert.strictEqual(pusher.pushed[0].regionCode, 'CN');
  });

  it('still works without a regionRegistry (legacy construction)', async () => {
    const pusher = makePusher();
    const channel = makeChannel();
    const worker = new Worker({ pusher, log: () => {} });
    await worker.runTask({ crawlerTaskId: 6, sku: 'S6' }, channel);
    assert.strictEqual(channel.crawlCalls.length, 1);
    assert.strictEqual(channel.crawlCalls[0].baseUrl, undefined);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/worker-region.test.js`
预期：FAIL（`baseUrl`/`regionCode` 未被设置，快速失败路径不存在）。

- [ ] **步骤 3：修改 `src/worker.js`（4 处）**

(a) constructor 里 `this.pusher = options.pusher;` 之后追加：

```js
    this.regionRegistry = options.regionRegistry || null;
```

(b) `buildErrorResult` 返回对象里 `sku: task.sku,` 之后追加：

```js
      regionCode: task.regionCode,
```

(c) `runTask` 入口：`let cancelled = false;` 之后、`channel.busy = true;` **之前**插入：

```js
    // 多区域路由：把 task.regionCode 解析成 task.baseUrl。
    // 未知码/禁用码 → 快速失败回推，不占用通道、不崩节点。
    if (this.regionRegistry) {
      const reg = this.regionRegistry;
      const code = reg.normalize(task.regionCode);
      task.regionCode = code;
      const baseUrl = reg.resolve(code);
      if (baseUrl === null) {
        const disabled = reg.isKnown(code);
        const message = disabled
          ? `region ${code} has no target site (disabled)`
          : `unknown regionCode: ${code}`;
        result = this.buildErrorResult(task, new Error(message));
        this.log(`[Worker] task ${task.crawlerTaskId} rejected before crawl: ${message}`);
        try {
          await this.pusher.push(result);
        } catch (pushErr) {
          this.log(`[Worker] push failed for rejected task ${task.crawlerTaskId}: ${pushErr.message}`);
        }
        if (taskIdKey !== null) {
          this.inFlightTaskIds.delete(taskIdKey);
        }
        if (this.logger) {
          try {
            this.logger.info('task', 'finished', {
              crawlerTaskId: task.crawlerTaskId,
              sku: task.sku,
              status: 'error',
              error: message,
              durationMs: Date.now() - startedAt,
              retries: 0,
              channelId: channel.id,
              timedOut: false,
              regionCode: code,
            });
          } catch (e) { /* ignore logger errors */ }
        }
        return result;
      }
      task.baseUrl = baseUrl;
    }
```

(d) push 之前（`// 统一推送（包括 timeout）` 注释下方、`if (result) {` 之前）插入：

```js
    if (result) {
      result.regionCode = task.regionCode;
    }
```

并在 logger 的 `this.logger.info('task', ...)` meta 对象里追加一行 `regionCode: task.regionCode,`。

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test test/worker-region.test.js test/worker.test.js test/worker-task-event.test.js test/worker-deadline.test.js test/worker-retry-on-timeout.test.js test/worker-channel-integration.test.js test/worker-image-upload.test.js`
预期：全部 PASS（旧 Worker 测试验证未回归）。

- [ ] **步骤 5：Commit**

```bash
git add src/worker.js test/worker-region.test.js
git commit -m "feat(crawler): Worker 按 regionCode 路由 baseUrl，未知/禁用码快速失败回推"
```

---

## 任务 7：Channel 透传 baseUrl + 跨区域 cookie 护栏

**文件：**
- 修改：`src/channel.js`（constructor / `crawl` / `runHeadedFallback`）
- 测试：`test/channel-region.test.js`

**落位提示：** 当前 `crawl()` 开头（idle-reclaim 之后）为：

```js
  async crawl(task) {
    this.currentTask = task;

    try {
      this.markActivity();
      await this.ensureContext();
      const delay = this.pageCrawler.randomDelay();
```

两处 `crawlSingleSku` 调用分别位于 `crawl()` 主体与 `runHeadedFallback()` 内。

- [ ] **步骤 1：编写失败的测试** `test/channel-region.test.js`

```js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { Channel } = require('../src/channel');

function makeChannel(config = {}) {
  const channel = new Channel({
    id: 1,
    config: { nodeCode: 'test-node', baseUrl: 'https://eur.vevor.com', ...config },
    log: () => {},
    headedBrowserLauncher: null,
    onTaskComplete: null,
  });
  const captured = { calls: [] };
  channel.pageCrawler = {
    randomDelay: () => 0,
    sleep: async () => {},
    crawlSingleSku: async (sku, page, recreateContext, options) => {
      captured.calls.push({ sku, options });
      return {
        sku,
        status: 'success',
        product_name: 'X',
        product_url: '',
        features_details: '',
        product_specification: '',
      };
    },
  };
  channel._captured = captured;
  return channel;
}

describe('Channel multi-region', () => {
  it('passes task.baseUrl through to pageCrawler.crawlSingleSku', async () => {
    const channel = makeChannel();
    channel.ensureContext = async () => ({});
    channel.page = {};

    await channel.crawl({ crawlerTaskId: 1, sku: 'S1', baseUrl: 'https://www.vevor.ca', regionCode: 'CA' });

    assert.strictEqual(channel._captured.calls.length, 1);
    assert.deepStrictEqual(channel._captured.calls[0].options, { baseUrl: 'https://www.vevor.ca' });
  });

  it('passes undefined baseUrl when the task has none (PageCrawler falls back to config)', async () => {
    const channel = makeChannel();
    channel.ensureContext = async () => ({});
    channel.page = {};

    await channel.crawl({ crawlerTaskId: 2, sku: 'S2' });

    assert.strictEqual(channel._captured.calls[0].options.baseUrl, undefined);
  });

  it('does not clear cookies on region switch when the guard is off (default)', async () => {
    const channel = makeChannel();
    let cleared = 0;
    channel.browserContext = { clearCookies: async () => { cleared += 1; } };
    channel.ensureContext = async () => ({});
    channel.page = {};

    await channel.crawl({ crawlerTaskId: 3, sku: 'S3', regionCode: 'CA' });
    await channel.crawl({ crawlerTaskId: 4, sku: 'S4', regionCode: 'GB' });

    assert.strictEqual(cleared, 0);
    assert.strictEqual(channel.lastRegionCode, 'GB');
  });

  it('clears cookies only when the region actually switches and the guard is on', async () => {
    const channel = makeChannel({ clearCookiesOnRegionSwitch: true });
    let cleared = 0;
    channel.browserContext = { clearCookies: async () => { cleared += 1; } };
    channel.ensureContext = async () => ({});
    channel.page = {};

    await channel.crawl({ crawlerTaskId: 5, sku: 'S5', regionCode: 'CA' }); // 首次：无上次区域，不清
    await channel.crawl({ crawlerTaskId: 6, sku: 'S6', regionCode: 'GB' }); // 切换：清 1 次
    await channel.crawl({ crawlerTaskId: 7, sku: 'S7', regionCode: 'GB' }); // 同区：不清

    assert.strictEqual(cleared, 1);
    assert.strictEqual(channel.lastRegionCode, 'GB');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/channel-region.test.js`
预期：FAIL（options 未透传；`lastRegionCode` 不存在）。

- [ ] **步骤 3：修改 `src/channel.js`（4 处）**

(a) constructor 里 `this.lastIpRotationAt = 0;` 之后追加：

```js
    // 跨区域 cookie 护栏（默认关）：记录上次任务的区域，热切换时清 cookie 防串扰。
    this.lastRegionCode = null;
    this.clearCookiesOnRegionSwitch = this.config.clearCookiesOnRegionSwitch === true
      || this.config.clearCookiesOnRegionSwitch === 'true';
```

(b) `crawl()` 里 `await this.ensureContext();` 之后、`const delay = this.pageCrawler.randomDelay();` 之前插入：

```js
      const taskRegion = task.regionCode || null;
      if (this.clearCookiesOnRegionSwitch && taskRegion && this.lastRegionCode
          && taskRegion !== this.lastRegionCode && this.browserContext) {
        await this.browserContext.clearCookies();
        this.log(`[Channel ${this.id}] region switch ${this.lastRegionCode} → ${taskRegion}, cookies cleared`);
      }
      if (taskRegion) {
        this.lastRegionCode = taskRegion;
      }
```

(c) `crawl()` 主体里的调用改为透传：

```js
        result = await this.pageCrawler.crawlSingleSku(task.sku, this.page, recreateContext, { baseUrl: task.baseUrl });
```

(d) `runHeadedFallback()` 里的调用改为透传：

```js
      return await this.pageCrawler.crawlSingleSku(task.sku, headedPage, recreateContext, { baseUrl: task.baseUrl });
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test test/channel-region.test.js test/channel.test.js test/channel-business-not-found.test.js test/channel-cf-rotation.test.js test/channel-datalayer-rotation.test.js test/channel-headed-fallback.test.js test/channel-cooldown.test.js test/channel-page-refresh.test.js test/channel-proxy.test.js test/channel-rotate-proxy.test.js test/channel-profile.test.js test/channel-refresh-disconnected.test.js`
预期：全部 PASS（旧 Channel 测试验证未回归）。

- [ ] **步骤 5：Commit**

```bash
git add src/channel.js test/channel-region.test.js
git commit -m "feat(crawler): Channel 透传 task.baseUrl，新增跨区域 cookie 护栏（默认关）"
```

---

## 任务 8：CrawlerService 接线

**文件：**
- 修改：`src/service.js`（require / constructor / `initChannels` / `start` 的 Worker 构造 / 启动日志）
- 测试：`test/service-region-registry.test.js`

- [ ] **步骤 1：编写失败的测试** `test/service-region-registry.test.js`

```js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { CrawlerService } = require('../src/service');

describe('CrawlerService region registry wiring', () => {
  it('builds a RegionRegistry honoring regions + defaultRegion', () => {
    const service = new CrawlerService({
      regions: 'CN=,US=https://www.vevor.com',
      defaultRegion: 'GB',
      imageDir: './output/test-region-svc',
    });
    assert.strictEqual(service.regionRegistry.resolve('US'), 'https://www.vevor.com');
    assert.strictEqual(service.regionRegistry.resolve('CN'), null);
    assert.strictEqual(service.regionRegistry.resolve(''), 'https://www.vevor.co.uk');
  });

  it('back-compat: no regions config → EU via legacy baseUrl, other regions via built-ins', () => {
    const service = new CrawlerService({
      baseUrl: 'https://eur.vevor.com',
      imageDir: './output/test-region-svc',
    });
    assert.strictEqual(service.regionRegistry.resolve('EU'), 'https://eur.vevor.com');
    assert.strictEqual(service.regionRegistry.resolve(''), 'https://eur.vevor.com');
    assert.strictEqual(service.regionRegistry.resolve('CA'), 'https://www.vevor.ca');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/service-region-registry.test.js`
预期：FAIL（`service.regionRegistry` 为 undefined）。

- [ ] **步骤 3：修改 `src/service.js`（5 处）**

(a) 顶部 require 区追加：

```js
const { RegionRegistry } = require('./region-registry');
```

(b) constructor 里 `this.config = { ... }` 与 idleReclaim 解析之后、`this.browser = null;` 之前插入：

```js
    this.regionRegistry = new RegionRegistry({
      regions: this.config.regions,
      defaultRegion: this.config.defaultRegion,
      legacyBaseUrl: this.config.baseUrl,
    });
```

(c) `initChannels()` 的 channel `config: { ... }` 里（如 `stealthMode: this.config.stealthMode,` 附近）追加：

```js
          clearCookiesOnRegionSwitch: this.config.clearCookiesOnRegionSwitch,
```

(d) `start()` 里 `new Worker({ ... })` 的 options 追加：

```js
      regionRegistry: this.regionRegistry,
```

(e) `start()` 里 `this.log(`[SERVICE] Running with nodeCode=...`)` 之后追加一行：

```js
    this.log(`[SERVICE] regions: ${JSON.stringify(this.regionRegistry.map)}`);
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test test/service-region-registry.test.js test/service-cliproxy.test.js test/service-proxy-pool.test.js test/service-heartbeat.test.js test/service-health.test.js test/service-health-is-healthy.test.js test/service-health-check-rotation.test.js test/service-task-complete-rotation.test.js test/service-idle-reaper.test.js test/service-profile.test.js test/service-worker-logger-injection.test.js test/service-logger.test.js`
预期：全部 PASS（含 idle-reaper 测试，验证与空闲收池共存）。

- [ ] **步骤 5：Commit**

```bash
git add src/service.js test/service-region-registry.test.js
git commit -m "feat(crawler): service 接入 RegionRegistry 并向 Worker/Channel 透传区域配置"
```

---

## 任务 9：部署配置与文档

**文件：**
- 修改：`deployment/linux/.env.example`
- 修改：`scripts/deploy/windows/docker/.env.example`
- 修改：`scripts/deploy/windows/native/.env.example`
- 修改：`README.md`（配置表，`--base-url` 行附近）

- [ ] **步骤 1：在 `deployment/linux/.env.example` 的 `CRAWLER_BASE_URL` 行之后追加**

```bash
# 多区域映射（可选）：留空时默认区域=EU 且站点=CRAWLER_BASE_URL
# 区域码：EU 欧盟 / GB 英国 / CA 加拿大 / US 美国 / CN 中国（留空=禁用）
# CRAWLER_REGIONS='EU=https://eur.vevor.com,GB=https://www.vevor.co.uk,CA=https://www.vevor.ca,US=https://www.vevor.com,CN='
# CRAWLER_DEFAULT_REGION=EU
# 跨区域 cookie 护栏（默认关）：通道热切换区域时清空 cookie 防串扰
# CRAWLER_CLEAR_COOKIES_ON_REGION_SWITCH=false
```

- [ ] **步骤 2：同样追加到 `scripts/deploy/windows/docker/.env.example` 与 `scripts/deploy/windows/native/.env.example`**（内容与步骤 1 相同）。

- [ ] **步骤 3：`README.md` 配置表里 `--base-url` 行之后追加三行**（与既有行格式对齐：`|` flag | env | 默认 | 说明 `|`）：

```markdown
| `--regions` | `CRAWLER_REGIONS` | 内置五区域 | 区域码→站点映射，如 `EU=https://eur.vevor.com,...,CN=`（空值=禁用） |
| `--default-region` | `CRAWLER_DEFAULT_REGION` | `EU` | task 缺 regionCode 时的默认区域 |
| `--clear-cookies-on-region-switch` | `CRAWLER_CLEAR_COOKIES_ON_REGION_SWITCH` | `false` | 通道热切换区域时清空 cookie |
```

- [ ] **步骤 4：校验部署配置未破坏**（compose 文件引用这些 env 的既有测试）

运行：`node --test test/deployment/*.test.js test/github-workflow.test.js`
预期：全部 PASS。

- [ ] **步骤 5：Commit**

```bash
git add deployment/linux/.env.example scripts/deploy/windows/docker/.env.example scripts/deploy/windows/native/.env.example README.md
git commit -m "docs(deploy): 多区域配置项 CRAWLER_REGIONS/DEFAULT_REGION/cookie 护栏写入 env.example 与 README"
```

---

## 任务 10：US 真站烟测门禁（上线 US 前必过）

> 背景：EU/CA/GB 已于 2026-07-10 在 VPS 用 DE 代理烟测通过；**US（`www.vevor.com` 全球站）尚未验证**。`test-sku.js` 代理参数已修复（commit `1233040`），可直接复用。本任务在 US 进生产 `CRAWLER_REGIONS` 之前执行。

**前置：** 上游/产品提供 1~3 个 `www.vevor.com` 上确定有货的 SKU。

- [ ] **步骤 1：在 VPS 上起一次性隔离容器跑 US SKU**（同 07-10 烟测方法，不碰 live 的 8 个容器）

```bash
ssh <vps>
docker run --rm --network crawler_crawler-net --env-file /opt/crawler/.env \
  -e CLIPROXY_SESSION_PREFIX=smoke-us \
  -e PLAYWRIGHT_BROWSERS_PATH=/app/ms-playwright \
  -e CRAWLER_IMAGE_UPLOAD_URL= \
  -w /app ghcr.io/nicco915/cralwer_t:v1.2.0 \
  node test-sku.js <US_SKU> --base-url=https://www.vevor.com --no-headed-fallback
```

- [ ] **步骤 2：判定**——`status=success` 且 `product_url` 落在 `www.vevor.com`。任一以下信号 = **未过**：强制跳回其他域名、CF 未解、`net::ERR`/geo 阻断。未过则：US 不进生产映射，回设计评估（US 单独区域节点或 US 出口代理）。

- [ ] **步骤 3：烟测通过后，更新 VPS 生产配置** `/opt/crawler/.env` 追加：

```bash
CRAWLER_REGIONS='EU=https://eur.vevor.com,GB=https://www.vevor.co.uk,CA=https://www.vevor.ca,US=https://www.vevor.com,CN='
CRAWLER_DEFAULT_REGION=EU
```

US 未过烟测前，生产 `CRAWLER_REGIONS` 只放 `EU/GB/CA`（US 先不写；写了内置默认也能跑，但必须以烟测为准）。

- [ ] **步骤 4：把烟测结果（SKU、出口 IP、`product_url` 域名、通过/未过）记进规格文档 §2** 的验证记录，随本分支提交。

---

## 任务 11：全量回归与发布门禁

- [ ] **步骤 1：跑本特性相关全部测试**

运行：

```bash
node --test test/region-registry.test.js test/page-crawler-region.test.js test/cli-region-config.test.js test/service-config-region.test.js test/pusher-region.test.js test/worker-region.test.js test/channel-region.test.js test/service-region-registry.test.js
```

预期：8 个文件全部 PASS。

- [ ] **步骤 2：全量回归**

运行：`npm test`
预期：全部 PASS。注意：含 3 个真站集成测试（`service.integration.test.js`，每个最长 ~90s，需要能访问 `eur.vevor.com` 的网络），整轮约数分钟；若卡住先按任务 0 步骤 2 排查残留进程。

- [ ] **步骤 3：确认 git 历史干净**

运行：`git log --oneline -12 && git status --short`
预期：任务 1~9 各一笔小提交；工作区无遗漏改动（`logs/crawler.jsonl` 仍未跟踪、未提交）。

- [ ] **步骤 4（上线时）：验证生产日志**

VPS 部署后，观察启动日志包含 `[SERVICE] regions: {...}` 映射正确；来一条带 `regionCode` 的真任务后，回调 payload 含 `regionCode` 且 `sourceUrl` 域名与之一致。

---

## 自检（计划编写后执行）

**1. 规格覆盖度：**
- 契约（regionCode / 五区域码 / 缺省 EU / CN 禁用 / 未知码快速失败 / 回调回显）→ 任务 1、5、6 全覆盖。
- 动态 baseUrl 通道模型 → 任务 2、6、7。
- 代理池不动 → 无改动项（已确认）；DE 出口前提 → 任务 10 记录。
- cookie 护栏（默认关）→ 任务 3、4、7、8、9。
- 配置（CRAWLER_REGIONS / DEFAULT_REGION / 兼容 CRAWLER_BASE_URL）→ 任务 1、3、4、8、9。
- US 待烟测 → 任务 10（上线门禁）；CN 留空 → 任务 1 内置 + 任务 6 文案区分。
- 与 idle-reclaim 共存 → 任务 7 落位提示 + 任务 8 回归集含 `service-idle-reaper.test.js`。

**2. 占位符扫描：** 无 TODO/待定；任务 10 的 SKU 由上游提供是外部依赖（已在步骤里写明获取方与判定标准），不是占位符。

**3. 类型一致性：** `RegionRegistry.resolve/isKnown/normalize`（任务 1 定义，任务 6 使用）、`task.baseUrl/task.regionCode`（任务 6 写入，任务 7 读取）、`clearCookiesOnRegionSwitch`（任务 3 cli → 任务 4 serviceConfig → 任务 8 service → 任务 7 channel）、`result.regionCode`（任务 6 写入，任务 5 读取）——全链路命名一致。

---

## 执行交接

**计划已完成并保存到 `docs/superpowers/plans/2026-07-11-multi-region.md`。两种执行方式：**

**1. 子代理驱动（推荐）** — 每个任务调度一个新的子代理，任务间进行审查，快速迭代

**2. 内联执行** — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点

**选哪种方式？**
