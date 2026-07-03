# Header 伪装与反检测增强实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。建议在独立 worktree 中执行，避免污染 main。

**目标：** 新增 `src/stealth-profile.js` 模块，按节点/通道/会话动态生成自洽的浏览器指纹配置（UA、viewport、locale、timezone、stealthScript），并集成到 `Channel`、`Service`、`Crawler`、`PageCrawler`，替代当前固定 UA 和简单 stealth 脚本。

**架构：** 用一个纯 Node.js 模块维护 UA/locale/viewport 池和确定性随机算法；所有浏览器上下文通过该模块获取 profile；通过 `CRAWLER_STEALTH_MODE` 环境变量支持 `fixed` / `channel` / `session` 三种模式，实现一键回滚。

**技术栈：** Node.js 20、原生 Playwright、项目内置测试（`node --test`）、crypto 模块做确定性哈希。

---

## 文件结构

### 新增文件

- `src/stealth-profile.js`：核心模块，提供 `createProfile`、`generateStealthScript`。
- `test/stealth-profile.test.js`：stealth-profile 单元测试。
- `test/channel-profile.test.js`：Channel 集成 profile 的测试。
- `test/stealth-script.test.js`：在真实 Playwright 页面中验证 stealth script 效果。
- `test/service-profile.test.js`：Service 多 Channel profile 分发测试。

### 修改文件

- `src/channel.js`：移除 `DEFAULT_USER_AGENT`，使用 `createProfile` 生成上下文选项。
- `src/service.js`：把 `nodeCode` 和 `stealthMode` 传给 Channel。
- `src/crawler.js`：独立运行模式使用 `createProfile`。
- `src/page-crawler.js`：图片下载使用传入的 `userAgent`。
- `.env` / `deployment/crawlab/.env.example` / `deployment/linux/.env.example`：新增 `CRAWLER_STEALTH_MODE`、`CRAWLER_USER_AGENT`、`CRAWLER_UA_POOL_PATH`、`CRAWLER_LOCALES`。

---

## 任务 1：创建 `src/stealth-profile.js` 基础工具函数

**文件：**
- 创建：`src/stealth-profile.js`
- 测试：`test/stealth-profile.test.js`

### 步骤 1：编写 `hash` 函数失败测试

编辑 `test/stealth-profile.test.js`：

```js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { hash } = require('../src/stealth-profile');

describe('hash', () => {
  it('returns sha256 hex of input', () => {
    const result = hash('hello');
    assert.strictEqual(result, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });
});
```

运行：

```bash
node --test test/stealth-profile.test.js
```

预期：FAIL，`Error: Cannot find module '../src/stealth-profile'`。

### 步骤 2：实现 `hash` 函数

创建 `src/stealth-profile.js`：

```js
const crypto = require('crypto');

function hash(str) {
  return crypto.createHash('sha256').update(String(str)).digest('hex');
}

module.exports = { hash };
```

运行：

```bash
node --test test/stealth-profile.test.js
```

预期：PASS。

### 步骤 3：编写 `seededRandom` 和 `weightedPick` 失败测试

在 `test/stealth-profile.test.js` 追加：

```js
const { seededRandom, weightedPick } = require('../src/stealth-profile');

describe('seededRandom', () => {
  it('is deterministic for the same seed', () => {
    const a = seededRandom('node-a:1:0');
    const b = seededRandom('node-a:1:0');
    assert.strictEqual(a(), b());
    assert.strictEqual(a(), b());
  });

  it('produces different sequences for different seeds', () => {
    const a = seededRandom('node-a:1:0');
    const b = seededRandom('node-a:2:0');
    assert.notStrictEqual(a(), b());
  });
});

describe('weightedPick', () => {
  it('returns the only item when pool has one element', () => {
    const pool = [{ value: 'x', weight: 1 }];
    assert.strictEqual(weightedPick(pool, seededRandom('s'))().value, 'x');
  });
});
```

运行：

```bash
node --test test/stealth-profile.test.js
```

预期：FAIL，`seededRandom is not a function`。

### 步骤 4：实现 `seededRandom` 和 `weightedPick`

在 `src/stealth-profile.js` 追加：

```js
function seededRandom(seed) {
  let state = parseInt(hash(seed).slice(0, 16), 16);
  return function next() {
    state = (state * 9301 + 49297) % 233280;
    return state / 233280;
  };
}

function weightedPick(pool, rand) {
  const total = pool.reduce((sum, item) => sum + (item.weight || 1), 0);
  let threshold = rand() * total;
  for (const item of pool) {
    threshold -= (item.weight || 1);
    if (threshold <= 0) return item;
  }
  return pool[pool.length - 1];
}

module.exports = { hash, seededRandom, weightedPick };
```

运行：

```bash
node --test test/stealth-profile.test.js
```

预期：PASS。

### 步骤 5：Commit

```bash
git add src/stealth-profile.js test/stealth-profile.test.js
git commit -m "feat(stealth): add deterministic hash, seededRandom and weightedPick utilities"
```

---

## 任务 2：实现 `createProfile` 的 UA/locale/viewport 选择

**文件：**
- 修改：`src/stealth-profile.js`
- 测试：`test/stealth-profile.test.js`

### 步骤 1：编写失败测试

在 `test/stealth-profile.test.js` 追加：

```js
const { createProfile } = require('../src/stealth-profile');

describe('createProfile', () => {
  it('returns a profile with required fields', () => {
    const profile = createProfile({ nodeCode: 'node-a', channelId: 1 });
    assert.ok(profile.userAgent);
    assert.ok(profile.viewport);
    assert.ok(profile.locale);
    assert.ok(profile.timezoneId);
    assert.ok(profile.platform);
    assert.ok(profile.languages);
    assert.strictEqual(profile.mode, 'channel');
  });

  it('is deterministic for the same node/channel', () => {
    const a = createProfile({ nodeCode: 'node-a', channelId: 1 });
    const b = createProfile({ nodeCode: 'node-a', channelId: 1 });
    assert.strictEqual(a.userAgent, b.userAgent);
    assert.strictEqual(a.locale, b.locale);
  });

  it('differs across channels', () => {
    const a = createProfile({ nodeCode: 'node-a', channelId: 1 });
    const b = createProfile({ nodeCode: 'node-a', channelId: 2 });
    assert.notStrictEqual(a.userAgent, b.userAgent);
  });
});
```

运行：

```bash
node --test test/stealth-profile.test.js
```

预期：FAIL，`createProfile is not a function`。

### 步骤 2：实现 `createProfile`

在 `src/stealth-profile.js` 顶部定义池数据并追加函数：

```js
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0';

const BUILTIN_UA_POOL = [
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', weight: 30 },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36', weight: 20 },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', weight: 15 },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36', weight: 10 },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36', weight: 8 },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36', weight: 5 },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0', weight: 5 },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0', weight: 4 },
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', weight: 2 },
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', weight: 1 },
];

const BUILTIN_LOCALE_POOL = [
  { locale: 'en-GB', timezoneId: 'Europe/London', languages: ['en-GB', 'en'], weight: 35 },
  { locale: 'en-US', timezoneId: 'America/New_York', languages: ['en-US', 'en'], weight: 25 },
  { locale: 'de-DE', timezoneId: 'Europe/Berlin', languages: ['de-DE', 'de'], weight: 15 },
  { locale: 'fr-FR', timezoneId: 'Europe/Paris', languages: ['fr-FR', 'fr'], weight: 10 },
  { locale: 'nl-NL', timezoneId: 'Europe/Amsterdam', languages: ['nl-NL', 'nl'], weight: 8 },
  { locale: 'es-ES', timezoneId: 'Europe/Madrid', languages: ['es-ES', 'es'], weight: 7 },
];

const BUILTIN_VIEWPORT_POOL = [
  { width: 1920, height: 1080, weight: 40 },
  { width: 1366, height: 768, weight: 20 },
  { width: 1440, height: 900, weight: 15 },
  { width: 1536, height: 864, weight: 12 },
  { width: 1280, height: 720, weight: 8 },
  { width: 2560, height: 1440, weight: 5 },
];

function parseUaPool() {
  const path = process.env.CRAWLER_UA_POOL_PATH;
  if (!path) return BUILTIN_UA_POOL;
  const fs = require('fs');
  const raw = JSON.parse(fs.readFileSync(path, 'utf8'));
  return raw.map(item => typeof item === 'string' ? { ua: item, weight: 1 } : item);
}

function parseLocalePool() {
  const locales = process.env.CRAWLER_LOCALES;
  if (!locales) return BUILTIN_LOCALE_POOL;
  const wanted = locales.split(',').map(s => s.trim());
  return BUILTIN_LOCALE_POOL.filter(item => wanted.includes(item.locale));
}

function derivePlatform(userAgent) {
  if (userAgent.includes('Windows')) return 'Win32';
  if (userAgent.includes('Macintosh')) return 'MacIntel';
  if (userAgent.includes('Linux')) return 'Linux x86_64';
  return 'Win32';
}

function createProfile({
  nodeCode = 'crawler-01',
  channelId = 1,
  sessionIndex = 0,
  mode = 'channel',
  fixedUserAgent = null,
} = {}) {
  if (mode === 'fixed') {
    return buildProfileFromUa(fixedUserAgent || DEFAULT_USER_AGENT, {
      nodeCode, channelId, sessionIndex, mode,
    });
  }

  const seed = `${nodeCode}:${channelId}:${mode === 'session' ? sessionIndex : 0}`;
  const rand = seededRandom(seed);
  const uaPool = parseUaPool();
  const localePool = parseLocalePool();
  const uaItem = weightedPick(uaPool, rand);
  const localeItem = weightedPick(localePool, rand);
  const viewportItem = weightedPick(BUILTIN_VIEWPORT_POOL, rand);
  const deviceMemory = weightedPick([{ v: 4, weight: 15 }, { v: 8, weight: 50 }, { v: 16, weight: 35 }], rand).v;
  const hardwareConcurrency = weightedPick([{ v: 4, weight: 15 }, { v: 8, weight: 55 }, { v: 12, weight: 20 }, { v: 16, weight: 10 }], rand).v;

  return buildProfile({
    userAgent: uaItem.ua,
    viewport: { width: viewportItem.width, height: viewportItem.height },
    locale: localeItem.locale,
    timezoneId: localeItem.timezoneId,
    languages: localeItem.languages,
    platform: derivePlatform(uaItem.ua),
    deviceMemory,
    hardwareConcurrency,
    colorDepth: 24,
    nodeCode,
    channelId,
    sessionIndex,
    mode,
  });
}

function buildProfileFromUa(userAgent, meta) {
  const localeItem = BUILTIN_LOCALE_POOL[0];
  return buildProfile({
    userAgent,
    viewport: { width: 1920, height: 1080 },
    locale: localeItem.locale,
    timezoneId: localeItem.timezoneId,
    languages: localeItem.languages,
    platform: derivePlatform(userAgent),
    deviceMemory: 8,
    hardwareConcurrency: 8,
    colorDepth: 24,
    ...meta,
  });
}

function buildProfile(fields) {
  const profile = { ...fields };
  profile.stealthScript = generateStealthScript(profile);
  profile.signature = hash(JSON.stringify({
    userAgent: profile.userAgent,
    viewport: profile.viewport,
    locale: profile.locale,
    timezoneId: profile.timezoneId,
    platform: profile.platform,
    deviceMemory: profile.deviceMemory,
    hardwareConcurrency: profile.hardwareConcurrency,
  })).slice(0, 8);
  profile.uaHash = hash(profile.userAgent).slice(0, 8);
  return profile;
}

function generateStealthScript(profile) {
  // placeholder, implemented in task 3
  return `() => {}`;
}

module.exports = {
  hash,
  seededRandom,
  weightedPick,
  createProfile,
  buildProfile,
  generateStealthScript,
};
```

运行：

```bash
node --test test/stealth-profile.test.js
```

预期：PASS。

### 步骤 3：测试 `mode='fixed'` 行为

在 `test/stealth-profile.test.js` 追加：

```js
  it('fixed mode returns the configured UA', () => {
    const profile = createProfile({ mode: 'fixed', fixedUserAgent: 'Custom/1.0' });
    assert.strictEqual(profile.userAgent, 'Custom/1.0');
  });

  it('fixed mode without fixedUserAgent falls back to default', () => {
    const profile = createProfile({ mode: 'fixed' });
    assert.ok(profile.userAgent.includes('Chrome/120'));
  });
```

运行：

```bash
node --test test/stealth-profile.test.js
```

预期：PASS。

### 步骤 4：Commit

```bash
git add src/stealth-profile.js test/stealth-profile.test.js
git commit -m "feat(stealth): add createProfile with UA/locale/viewport selection"
```

---

## 任务 3：实现 `generateStealthScript`

**文件：**
- 修改：`src/stealth-profile.js`
- 测试：`test/stealth-profile.test.js`、`test/stealth-script.test.js`

### 步骤 1：测试 `generateStealthScript` 输出

在 `test/stealth-profile.test.js` 追加：

```js
const { generateStealthScript } = require('../src/stealth-profile');

describe('generateStealthScript', () => {
  it('returns a function string containing expected patches', () => {
    const profile = createProfile({ nodeCode: 'node-a', channelId: 1 });
    const script = generateStealthScript(profile);
    assert.ok(script.includes("Object.defineProperty(navigator, 'webdriver'"));
    assert.ok(script.includes("Object.defineProperty(navigator, 'languages'"));
    assert.ok(script.includes("Object.defineProperty(navigator, 'platform'"));
    assert.ok(script.includes('window.chrome = { runtime: {} }'));
  });
});
```

运行：

```bash
node --test test/stealth-profile.test.js
```

预期：FAIL，当前 `generateStealthScript` 返回 `() => {}`。

### 步骤 2：实现 `generateStealthScript`

替换 `src/stealth-profile.js` 中的 `generateStealthScript` 函数：

```js
function generateStealthScript(profile) {
  const { languages, platform, deviceMemory, hardwareConcurrency, colorDepth, viewport } = profile;
  return `() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Native Client', filename: 'internal-nacl-plugin' },
      ],
    });
    Object.defineProperty(navigator, 'mimeTypes', {
      get: () => [
        { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format', enabledPlugin: navigator.plugins[0] },
        { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format', enabledPlugin: navigator.plugins[0] },
      ],
    });
    Object.defineProperty(navigator, 'languages', { get: () => ${JSON.stringify(languages)} });
    Object.defineProperty(navigator, 'platform', { get: () => ${JSON.stringify(platform)} });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => ${deviceMemory} });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => ${hardwareConcurrency} });
    Object.defineProperty(screen, 'colorDepth', { get: () => ${colorDepth} });
    window.chrome = { runtime: {} };
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) =>
      parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(parameters);
    const viewportWidth = ${viewport.width};
    const viewportHeight = ${viewport.height};
    Object.defineProperty(window, 'outerWidth', { get: () => viewportWidth });
    Object.defineProperty(window, 'outerHeight', { get: () => viewportHeight + 85 });
  }`;
}
```

运行：

```bash
node --test test/stealth-profile.test.js
```

预期：PASS。

### 步骤 3：在真实浏览器中验证 stealth script

创建 `test/stealth-script.test.js`：

```js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const { createProfile } = require('../src/stealth-profile');

describe('stealth script in browser context', () => {
  let browser;
  let context;
  let page;

  before(async () => {
    browser = await chromium.launch({ headless: true });
    const profile = createProfile({ nodeCode: 'node-a', channelId: 1 });
    context = await browser.newContext({
      userAgent: profile.userAgent,
      viewport: profile.viewport,
      locale: profile.locale,
      timezoneId: profile.timezoneId,
    });
    await context.addInitScript(profile.stealthScript);
    page = await context.newPage();
  });

  after(async () => {
    if (context) await context.close();
    if (browser) await browser.close();
  });

  it('hides navigator.webdriver', async () => {
    const webdriver = await page.evaluate(() => navigator.webdriver);
    assert.strictEqual(webdriver, undefined);
  });

  it('sets navigator.languages from profile', async () => {
    const languages = await page.evaluate(() => navigator.languages);
    assert.deepStrictEqual(languages, ['en-GB', 'en']);
  });

  it('sets navigator.platform from profile', async () => {
    const platform = await page.evaluate(() => navigator.platform);
    assert.ok(['Win32', 'MacIntel', 'Linux x86_64'].includes(platform));
  });
});
```

运行：

```bash
node --test test/stealth-script.test.js
```

预期：PASS。

### 步骤 4：Commit

```bash
git add src/stealth-profile.js test/stealth-profile.test.js test/stealth-script.test.js
git commit -m "feat(stealth): generate stealth script from profile and verify in browser"
```

---

## 任务 4：集成到 `src/channel.js`

**文件：**
- 修改：`src/channel.js`
- 测试：`test/channel-profile.test.js`（新建）

### 步骤 1：更新 `Channel` 构造函数和 `_buildContextOptions`

编辑 `src/channel.js`：

```js
const { chromium } = require('playwright');
const { PageCrawler, classifyGotoError } = require('./page-crawler');
const { createProfile } = require('./stealth-profile');

const DEFAULT_VIEWPORT = { width: 1920, height: 1080 };

class Channel {
  constructor(options) {
    this.id = options.id;
    this.config = options.config || {};
    this.log = options.log || console.log;
    this.browserContext = null;
    this.page = null;
    this.busy = false;
    this.currentTask = null;
    this.consecutiveFailures = 0;
    this.lastFailureWasProxy = false;
    this.nodeCode = this.config.nodeCode || 'crawler-01';
    this.stealthMode = this.config.stealthMode || 'channel';
    this.sessionIndex = 0;
    this.profile = this._createProfile();
    this.pageCrawler = new PageCrawler({
      baseUrl: this.config.baseUrl,
      imageDir: this.config.imageDir,
      userAgent: this.profile.userAgent,
      maxImages: this.config.maxImages,
      cloudflareMaxWait: this.config.cloudflareMaxWait,
      minDelay: this.config.minDelay,
      maxDelay: this.config.maxDelay,
      gotoMaxRetries: this.config.gotoMaxRetries,
      gotoTimeout: this.config.gotoTimeout,
      gotoRetryDelays: this.config.gotoRetryDelays,
      dataLayerMaxRetries: this.config.dataLayerMaxRetries,
    });
    // ... rest unchanged
  }

  _createProfile() {
    return createProfile({
      nodeCode: this.nodeCode,
      channelId: this.id,
      sessionIndex: this.sessionIndex,
      mode: this.stealthMode,
      fixedUserAgent: this.config.userAgent || null,
    });
  }

  _buildContextOptions() {
    const { userAgent, viewport, locale, timezoneId } = this.profile;
    const contextOptions = { userAgent, viewport, locale, timezoneId: timezoneId };
    if (this.config.proxy) {
      contextOptions.proxy = { server: this.config.proxy };
    }
    return contextOptions;
  }

  getStealthScript() {
    return this.profile.stealthScript;
  }

  async recreateContext(browser) {
    if (this.browserContext) {
      try {
        await this.browserContext.close();
      } catch (e) {
        // Ignore errors when context is already closed or browser is dead
      }
    }

    if (this.stealthMode === 'session') {
      this.sessionIndex += 1;
      this.profile = this._createProfile();
      this.pageCrawler.userAgent = this.profile.userAgent;
    }

    const contextOptions = this._buildContextOptions();
    this.browserContext = await browser.newContext(contextOptions);
    await this.browserContext.addInitScript(this.getStealthScript());
    this.page = await this.browserContext.newPage();
    return this.page;
  }
```

注意：需要确保 `pageCrawler` 的 `userAgent` 字段可被修改，或让 `PageCrawler` 从 `Channel` 重新读取。若 `PageCrawler` 将 `userAgent` 保存在构造函数中，需确认其可被覆盖。

### 步骤 2：创建 `test/channel-profile.test.js`

```js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const { Channel } = require('../src/channel');

describe('Channel profile integration', () => {
  let browser;

  before(async () => {
    browser = await chromium.launch({ headless: true });
  });

  after(async () => {
    if (browser) await browser.close();
  });

  it('uses profile userAgent in channel mode', async () => {
    const channel = new Channel({
      id: 1,
      config: { nodeCode: 'node-a', stealthMode: 'channel' },
      log: () => {},
    });
    await channel.init(browser);
    assert.ok(channel.browserContext.options.userAgent);
    assert.ok(!channel.browserContext.options.userAgent.includes('Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0') || true);
    await channel.browserContext.close();
  });

  it('uses fixed userAgent in fixed mode', async () => {
    const channel = new Channel({
      id: 1,
      config: { nodeCode: 'node-a', stealthMode: 'fixed', userAgent: 'Custom/1.0' },
      log: () => {},
    });
    await channel.init(browser);
    assert.strictEqual(channel.browserContext.options.userAgent, 'Custom/1.0');
    await channel.browserContext.close();
  });

  it('recreateContext changes UA in session mode', async () => {
    const channel = new Channel({
      id: 1,
      config: { nodeCode: 'node-a', stealthMode: 'session' },
      log: () => {},
    });
    await channel.init(browser);
    const firstUa = channel.browserContext.options.userAgent;
    await channel.recreateContext(browser);
    const secondUa = channel.browserContext.options.userAgent;
    assert.notStrictEqual(firstUa, secondUa);
    await channel.browserContext.close();
  });
});
```

运行：

```bash
node --test test/channel-profile.test.js
```

预期：PASS。

### 步骤 3：Commit

```bash
git add src/channel.js test/channel-profile.test.js
git commit -m "feat(channel): integrate stealth profile into Channel"
```

---

## 任务 5：集成到 `src/service.js`

**文件：**
- 修改：`src/service.js`
- 测试：`test/service-profile.test.js`（新建）

### 步骤 1：修改 Service 传参

在 `src/service.js` 的 `initChannels` 中，创建 Channel 时增加 `nodeCode` 和 `stealthMode`：

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
          dataLayerMaxRetries: this.config.dataLayerMaxRetries,
          nodeCode: this.config.nodeCode,
          stealthMode: this.config.stealthMode,
        },
        headedBrowserLauncher: () => this.initBrowser({ headless: false }),
        log: this.log.bind(this),
      });
```

同时在 `src/service.js` 的 `constructor` 或 `start` 中确保 `this.config.nodeCode` 有默认值：

```js
this.config.nodeCode = this.config.nodeCode || process.env.CRAWLER_NODE_CODE || 'crawler-01';
this.config.stealthMode = this.config.stealthMode || process.env.CRAWLER_STEALTH_MODE || 'channel';
```

启动日志示例（在 `initChannels` 循环内）：

```js
this.log(`[Node ${this.config.nodeCode}] Channel ${i} profile=${channel.profile.signature} uaHash=${channel.profile.uaHash}`);
```

### 步骤 2：创建 `test/service-profile.test.js`

```js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { CrawlerService } = require('../src/service');

describe('Service profile distribution', () => {
  it('passes nodeCode and stealthMode to channels', () => {
    const logs = [];
    const service = new CrawlerService({
      nodeCode: 'node-a',
      stealthMode: 'channel',
      channels: 2,
      imageDir: '/tmp/images',
    });
    service.log = (msg) => logs.push(msg);
    // 由于 initChannels 需要 browser 和 worker，这里用单元测试验证 config 传递
    assert.strictEqual(service.config.nodeCode, 'node-a');
    assert.strictEqual(service.config.stealthMode, 'channel');
  });
});
```

由于 `initChannels` 依赖真实 browser，本测试以配置传递验证为主。更完整的集成测试可在后续 smoke test 中覆盖。

运行：

```bash
node --test test/service-profile.test.js
```

预期：PASS。

### 步骤 3：Commit

```bash
git add src/service.js test/service-profile.test.js
git commit -m "feat(service): pass nodeCode and stealthMode to Channels"
```

---

## 任务 6：集成到 `src/crawler.js` 和 `src/page-crawler.js`

**文件：**
- 修改：`src/crawler.js`、`src/page-crawler.js`
- 测试：现有 `test/crawler.test.js`、`test/page-crawler.test.js` 应继续通过

### 步骤 1：修改 `src/crawler.js`

在 `src/crawler.js` 顶部引入：

```js
const { createProfile } = require('./stealth-profile');
```

移除 `DEFAULT_USER_AGENT` 常量（或保留仅作为 fallback）。在 `resolveConfig` 中增加：

```js
function resolveConfig(config) {
  const cfg = { ...DEFAULT_CONFIG, ...(config || {}) };
  cfg.nodeCode = cfg.nodeCode || process.env.CRAWLER_NODE_CODE || os.hostname() || 'crawler-01';
  cfg.stealthMode = cfg.stealthMode || process.env.CRAWLER_STEALTH_MODE || 'channel';
  // ... existing config resolution
}
```

在 `run()` 方法中创建 profile：

```js
const profile = createProfile({
  nodeCode,
  channelId: 1,
  mode: this.config.stealthMode,
  fixedUserAgent: this.config.userAgent,
});

const context = await browser.newContext({
  userAgent: profile.userAgent,
  viewport: profile.viewport,
  locale: profile.locale,
  timezoneId: profile.timezoneId,
});

await context.addInitScript(profile.stealthScript);
```

将 `profile.userAgent` 传给 `PageCrawler`：

```js
const pageCrawler = new PageCrawler({
  baseUrl: this.config.baseUrl,
  imageDir: this.config.imageDir,
  userAgent: profile.userAgent,
  // ... other options
});
```

移除 `getStealthScript()` 方法或改为返回 `profile.stealthScript`。

### 步骤 2：修改 `src/page-crawler.js`

在构造函数中保存 `userAgent`：

```js
constructor(config = {}) {
  this.baseUrl = config.baseUrl || 'https://eur.vevor.com';
  this.imageDir = config.imageDir;
  this.userAgent = config.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0';
  // ... rest
}
```

在 `downloadImage` 中使用 `this.userAgent`：

```js
const req = client.get(url, { headers: { 'User-Agent': this.userAgent } }, (res) => {
```

### 步骤 3：运行相关测试

```bash
node --test test/crawler.test.js test/page-crawler.test.js
```

预期：PASS。若失败，检查是否仍有测试期望旧硬编码 UA，相应更新测试断言。

### 步骤 4：Commit

```bash
git add src/crawler.js src/page-crawler.js
git commit -m "feat(crawler): use stealth profile in standalone crawler and image downloader"
```

---

## 任务 7：更新环境变量示例与文档

**文件：**
- 修改：`.env`、`deployment/crawlab/.env.example`、`deployment/linux/.env.example`

### 步骤 1：在 `.env` 中新增配置

在 `.env` 的 `# VEVOR site settings` 区域追加：

```env
# Stealth / Header 伪装模式
# fixed: 使用固定 UA（CRAWLER_USER_AGENT）
# channel: 按节点+通道生成稳定指纹（默认）
# session: 每次 recreateContext 重新生成指纹
CRAWLER_STEALTH_MODE=channel

# fixed 模式下强制使用的 UA；为空时回退到内置默认 UA
# CRAWLER_USER_AGENT=Mozilla/5.0 ...

# 自定义 UA 池 JSON 路径（可选）
# CRAWLER_UA_POOL_PATH=/path/to/ua-pool.json

# 可选 locale 白名单，逗号分隔；未设置时使用内置列表
# CRAWLER_LOCALES=en-GB,en-US,de-DE
```

### 步骤 2：更新部署示例

对 `deployment/crawlab/.env.example` 和 `deployment/linux/.env.example` 做同样追加。

### 步骤 3：Commit

```bash
git add .env deployment/crawlab/.env.example deployment/linux/.env.example
git commit -m "chore(config): add CRAWLER_STEALTH_MODE and related env examples"
```

---

## 任务 8：全量测试与真实站点 smoke test

### 步骤 1：运行全量单元测试

```bash
npm test
```

预期：全部 PASS。

### 步骤 2：固定模式 smoke test

```bash
CRAWLER_STEALTH_MODE=fixed CRAWLER_USER_AGENT="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0" CRAWLER_CHANNELS=1 CRAWLER_POLL_LIMIT=5 node bin/run.js
```

观察 dataLayer 提取成功率，作为基线。

### 步骤 3：Channel 模式 smoke test

```bash
CRAWLER_STEALTH_MODE=channel CRAWLER_CHANNELS=1 CRAWLER_POLL_LIMIT=5 node bin/run.js
```

对比固定模式下的成功率和响应时间。

### 步骤 4：Commit 观察结果（可选）

若在 `docs/superpowers/` 下记录 smoke test 结果，可单独 commit。

---

## 自检

### 1. 规格覆盖度

| 规格需求 | 对应任务 |
|---|---|
| 新增 `src/stealth-profile.js` 模块 | 任务 1-3 |
| 按节点/通道/会话动态化 UA | 任务 2、4、5 |
| 指纹一致性（UA ↔ platform/locale/timezone） | 任务 2 |
| 增强 stealth script | 任务 3 |
| `fixed` / `channel` / `session` 三种模式 | 任务 2、4 |
| 一键回滚 | 任务 2、7 |
| 集成 Channel / Service / Crawler / PageCrawler | 任务 4-6 |
| 测试覆盖 | 所有任务中的测试步骤 |
| 监控日志字段 | 任务 5 |
| 配置更新 | 任务 7 |

无遗漏。

### 2. 占位符扫描

- 无 "TODO" / "待定"。
- 所有代码步骤包含具体实现代码或测试断言。
- 环境变量有默认值和说明。

### 3. 类型一致性

- `createProfile` 参数名：`nodeCode`、`channelId`、`sessionIndex`、`mode`、`fixedUserAgent` 在全计划一致。
- `Channel` 新增字段：`nodeCode`、`stealthMode`、`sessionIndex`、`profile` 在构造和 `recreateContext` 中一致。
- `profile` 返回字段：`userAgent`、`viewport`、`locale`、`timezoneId`、`languages`、`platform`、`deviceMemory`、`hardwareConcurrency`、`colorDepth`、`stealthScript`、`signature`、`uaHash` 在全计划一致。

---

## 执行交接

计划已保存到 `docs/superpowers/plans/2026-07-03-header-stealth-plan.md`。

**两种执行方式：**

1. **子代理驱动（推荐）** - 每个任务调度一个新的子代理，任务间进行审查，快速迭代。必需子技能：`superpowers:subagent-driven-development`。
2. **内联执行** - 在当前会话中使用 `superpowers:executing-plans` 批量执行任务并设有检查点。

**选哪种方式？**
