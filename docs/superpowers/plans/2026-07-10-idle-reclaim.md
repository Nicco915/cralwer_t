# 空闲收池（Idle Reclaim）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 service 常驻模式下，空闲超过 `idleReclaimMs`（默认 5min）时回收 channel 的 `browserContext+page`（关 renderer、清掉残留页面 JS），来任务时 `ensureContext()` 按需重建，把空转高 CPU 容器（`crawler-2/6/7/8` 36–41%）降到个位数。

**架构：** `Channel` 新增 `this.browser` 引用、`lastActivityAt`、`markActivity()`、`ensureContext()`（无副作用重建、保持指纹不变、禁止调 `recreateContext`）、`isIdleReclaimable()`；`crawl()` 入口先 `markActivity()` 再 `ensureContext()`。`CrawlerService` 新增 `startIdleReaper/stopIdleReaper/reapOnce`（仿 `startHealthCheck`），reaper 用 `reinitializing` 包裹 `close()` 防与 `runTask` 竞态；`Worker` 不改（`hasCapacity/getIdleChannel` 仅看 `busy/reinitializing`，close 后 channel 仍 idle，来任务经 `crawl→ensureContext` 自动重建）。

**技术栈：** Node.js，`node:test` + `node:assert`，Playwright（`chromium.launch`），Conventional Commits（中文描述）。

---

## 文件结构

| 文件 | 操作 | 职责 |
|---|---|---|
| `src/channel.js` | 修改 | 新增空闲状态字段/谓词/无副作用重建；`crawl` 入口接入 |
| `src/service.js` | 修改 | 新增空闲回收定时器与配置读取；`start/stop` 接入 |
| `test/channel.test.js` | 修改（追加 `describe`/`it`） | `ensureContext` / `isIdleReclaimable` / `markActivity` / crawl 重建 单元测试 |
| `test/service-idle-reaper.test.js` | 创建 | `reapOnce` / `startIdleReaper` / `stopIdleReaper` / 竞态 单元测试（mock channel，不起浏览器） |
| `test/service.integration.test.js` | 修改（追加 1 个 `it`） | 真 Chromium 空转超过阈值后 `channel.page` 被回收的集成验证 |
| `deployment/linux/.env.example` | 修改 | 新增 `CRAWLER_IDLE_RECLAIM_MS` / `CRAWLER_IDLE_REAP_INTERVAL_MS` 示例与注释 |
| `deployment/linux/docker-compose.yml` | 修改 | `environment` 列表透传上述两个变量 |
| `deployment/windows/ecosystem.config.js` | 修改 | `env` 段同步新增同名键（PM2 从系统环境读，给默认值） |
| `test/deployment/linux-docker-compose.test.js` | 修改（追加断言） | 断言 compose 透传两个新环境变量 |

> Worker 不改；`src/worker.js` 不在变更清单。

---

## 任务 1：Channel 空闲状态字段、`markActivity()`、`isIdleReclaimable()`

**文件：**
- 修改：`src/channel.js`（`constructor` 末尾；`Channel` 类内新增两个方法）
- 测试：`test/channel.test.js`（在 `describe('Channel')` 内追加 `it`）

- [ ] **步骤 1：编写失败的测试（追加到 `test/channel.test.js` 的 `describe('Channel', ...)` 内）**

```js
  it('initializes idle state and markActivity updates lastActivityAt', async () => {
    const channel = new Channel({ id: 1, config: {}, log: () => {} });
    assert.strictEqual(channel.browser, null);
    assert.ok(typeof channel.lastActivityAt === 'number' && channel.lastActivityAt > 0);
    const before = channel.lastActivityAt;
    await new Promise((r) => setTimeout(r, 5));
    channel.markActivity();
    assert.ok(channel.lastActivityAt > before, 'lastActivityAt should advance');
  });

  it('isIdleReclaimable reflects busy/reinitializing/context/timeout', () => {
    const channel = new Channel({ id: 1, config: {}, log: () => {} });
    const now = Date.now();
    channel.lastActivityAt = now - 10000;
    channel.busy = false;
    channel.reinitializing = false;

    channel.browserContext = null;
    assert.strictEqual(channel.isIdleReclaimable(now, 5000), false, 'no context -> false');

    channel.browserContext = {};
    assert.strictEqual(channel.isIdleReclaimable(now, 5000), true, 'idle > threshold -> true');

    channel.busy = true;
    assert.strictEqual(channel.isIdleReclaimable(now, 5000), false, 'busy -> false');
    channel.busy = false;

    channel.reinitializing = true;
    assert.strictEqual(channel.isIdleReclaimable(now, 5000), false, 'reinitializing -> false');
    channel.reinitializing = false;

    channel.lastActivityAt = now - 1000;
    assert.strictEqual(channel.isIdleReclaimable(now, 5000), false, 'within threshold -> false');
  });
```

- [ ] **步骤 2：运行测试确认失败**

运行：`node --test test/channel.test.js`
预期：两个新 `it` FAIL（`markActivity` / `isIdleReclaimable` is not a function）。

- [ ] **步骤 3：实现（`src/channel.js`）**

在 `constructor` 末尾（`this.lastIpRotationAt = 0;` 之后）追加：
```js
    this.browser = null;
    this.lastActivityAt = Date.now();
```

在 `recreateContext` 方法首行（`async recreateContext(browser) {` 之后）插入：
```js
    this.browser = browser;
```

在 `init` 方法首行（`async init(browser, proxyOverride) {` 之后）插入：
```js
    this.browser = browser;
```
并在 `init` 末尾（`this.log(\`[Channel ${this.id}] initialized\`);` 之后）插入：
```js
    this.markActivity();
```

在 `needsProxyRotation()` 方法之前（类内任意方法区）新增两个方法：
```js
  markActivity() {
    this.lastActivityAt = Date.now();
  }

  isIdleReclaimable(now, idleMs) {
    return !this.busy && !this.reinitializing && !!this.browserContext && (now - this.lastActivityAt) > idleMs;
  }
```

- [ ] **步骤 4：运行测试确认通过**

运行：`node --test test/channel.test.js`
预期：全部 PASS（含原有 3 个 + 新增 2 个）。

- [ ] **步骤 5：Commit**

```bash
git add src/channel.js test/channel.test.js
git commit -m "feat(crawler): Channel 增加空闲状态字段与 isIdleReclaimable 谓词"
```

---

## 任务 2：`Channel.ensureContext()` 无副作用重建 + `crawl()` 入口接入

**文件：**
- 修改：`src/channel.js`（新增 `ensureContext`；`crawl` 入口）
- 测试：`test/channel.test.js`（追加 `it`）

> 关键约束：`ensureContext` 必须保持 profile/指纹不变，**禁止调用 `recreateContext`**（其在 `stealthMode==='session'` 会 `sessionIndex += 1` 并重建 profile）。

- [ ] **步骤 1：编写失败的测试（追加到 `test/channel.test.js` 的 `describe('Channel', ...)` 内）**

在本 `describe` 顶部（`it` 之前）新增一个带可控 `isClosed` 的 mock browser 工厂（与文件内现有 `createMockBrowser` 并存，命名 `createMockBrowser2`）：
```js
function createMockBrowser2({ connected = true } = {}) {
  return {
    connected,
    isConnected() { return this.connected; },
    async newContext() {
      return {
        _closed: false,
        async addInitScript() {},
        async newPage() {
          return {
            _closed: false,
            isClosed() { return this._closed; },
            async close() { this._closed = true; },
          };
        },
        async close() { this._closed = true; },
      };
    },
    async close() {},
  };
}
```

追加测试：
```js
  it('ensureContext creates context+page when none exist', async () => {
    const channel = new Channel({ id: 1, config: {}, log: () => {} });
    channel.browser = createMockBrowser2();
    channel.browserContext = null;
    channel.page = null;

    const page = await channel.ensureContext();
    assert.ok(page, 'page should be created');
    assert.strictEqual(channel.page, page);
    assert.ok(channel.browserContext && channel.browserContext._closed === false);
  });

  it('ensureContext re-creates when page is closed', async () => {
    const channel = new Channel({ id: 1, config: {}, log: () => {} });
    await channel.init(createMockBrowser2());
    const oldPage = channel.page;
    await oldPage.close();
    assert.strictEqual(oldPage.isClosed(), true);

    const newPage = await channel.ensureContext();
    assert.notStrictEqual(newPage, oldPage);
    assert.strictEqual(newPage.isClosed(), false);
  });

  it('ensureContext throws when browser disconnected', async () => {
    const channel = new Channel({ id: 1, config: {}, log: () => {} });
    channel.browser = createMockBrowser2({ connected: false });
    channel.browserContext = null;
    channel.page = null;
    await assert.rejects(() => channel.ensureContext(), /Browser not available/);
  });

  it('ensureContext keeps profile stable (no session/profile side effects)', async () => {
    const channel = new Channel({ id: 1, config: { stealthMode: 'session' }, log: () => {} });
    await channel.init(createMockBrowser2());
    const sigBefore = channel.profile.signature;
    const sessionBefore = channel.sessionIndex;
    await channel.page.close();

    await channel.ensureContext();
    assert.strictEqual(channel.profile.signature, sigBefore, 'profile signature must not change');
    assert.strictEqual(channel.sessionIndex, sessionBefore, 'sessionIndex must not increment');
  });

  it('crawl recovers after context reclaimed (ensureContext at crawl entry)', async () => {
    const channel = new Channel({ id: 1, config: {}, log: () => {} });
    await channel.init(createMockBrowser2());
    channel.pageCrawler.crawlSingleSku = async () => ({
      status: 'success', sku: 'T', product_name: '', features_details: '',
      product_specification: '', product_url: '', error: '',
    });
    await channel.close(); // 模拟 reaper 回收：page/context 置 null
    assert.strictEqual(channel.page, null);

    const res = await channel.crawl({ crawlerTaskId: 1n, sku: 'T' });
    assert.strictEqual(res.status, 'success');
    assert.ok(channel.page, 'page re-created by crawl via ensureContext');
  });
```

- [ ] **步骤 2：运行测试确认失败**

运行：`node --test test/channel.test.js`
预期：5 个新 `it` FAIL（`ensureContext` is not a function；最后一个 crawl 在 `page=null` 时报错）。

- [ ] **步骤 3：实现（`src/channel.js`）**

在 `isIdleReclaimable` 方法之后新增 `ensureContext`：
```js
  async ensureContext() {
    if (this.browserContext && this.page && !this.page.isClosed()) {
      return this.page;
    }
    if (!this.browser || !this.browser.isConnected()) {
      throw new Error('Browser not available for ensureContext');
    }
    if (this.browserContext) {
      try { await this.browserContext.close(); } catch (e) { /* already closed */ }
      this.browserContext = null;
      this.page = null;
    }
    const contextOptions = this._buildContextOptions();
    this.browserContext = await this.browser.newContext(contextOptions);
    await this.browserContext.addInitScript(this.getStealthScript());
    this.page = await this.browserContext.newPage();
    this.log(`[Channel ${this.id}] context re-created after idle reclaim`);
    return this.page;
  }
```

修改 `crawl(task)` 入口。原开头：
```js
  async crawl(task) {
    this.currentTask = task;

    try {
      const delay = this.pageCrawler.randomDelay();
```
改为：
```js
  async crawl(task) {
    this.currentTask = task;

    try {
      this.markActivity();
      await this.ensureContext();
      const delay = this.pageCrawler.randomDelay();
```

- [ ] **步骤 4：运行测试确认通过**

运行：`node --test test/channel.test.js`
预期：全部 PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/channel.js test/channel.test.js
git commit -m "feat(crawler): Channel.ensureContext 无副作用重建并在 crawl 入口接入"
```

---

## 任务 3：`CrawlerService` 空闲回收器（`reapOnce` + 启停 + 配置 + 竞态）

**文件：**
- 修改：`src/service.js`（`constructor` 配置读取与字段；新增 `startIdleReaper/stopIdleReaper/reapOnce`）
- 测试：`test/service-idle-reaper.test.js`（新建）

> 测试用 fake channel 注入 `service.channels`，不启动真实浏览器，速度快且确定。

- [ ] **步骤 1：编写失败的测试（创建 `test/service-idle-reaper.test.js`）**

```js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { CrawlerService } = require('../src/service');

function makeFakeChannel({ id = 1, idle = false, busy = false, reinitializing = false } = {}) {
  return {
    id,
    busy,
    reinitializing,
    closed: false,
    lastActivityAt: Date.now() - 600000,
    isIdleReclaimable() {
      return idle && !this.busy && !this.reinitializing;
    },
    async close() {
      this.closed = true;
    },
  };
}

describe('CrawlerService idle reaper', () => {
  it('reapOnce closes idle-reclaimable channels and resets reinitializing', async () => {
    const svc = new CrawlerService({ nodeCode: 't' });
    svc.config.idleReclaimMs = 300000;
    const c1 = makeFakeChannel({ id: 1, idle: true });
    const c2 = makeFakeChannel({ id: 2, idle: false });
    svc.channels = [c1, c2];

    await svc.reapOnce();
    assert.strictEqual(c1.closed, true);
    assert.strictEqual(c2.closed, false);
    assert.strictEqual(c1.reinitializing, false, 'reinitializing reset after close');
  });

  it('reapOnce skips busy and reinitializing channels', async () => {
    const svc = new CrawlerService({ nodeCode: 't' });
    svc.config.idleReclaimMs = 300000;
    const busy = makeFakeChannel({ id: 1, idle: true, busy: true });
    const reinit = makeFakeChannel({ id: 2, idle: true, reinitializing: true });
    svc.channels = [busy, reinit];

    await svc.reapOnce();
    assert.strictEqual(busy.closed, false);
    assert.strictEqual(reinit.closed, false);
  });

  it('reapOnce sets reinitializing=true during close', async () => {
    const svc = new CrawlerService({ nodeCode: 't' });
    svc.config.idleReclaimMs = 300000;
    let seenReinitDuringClose = false;
    const c = {
      id: 1,
      busy: false,
      reinitializing: false,
      closed: false,
      lastActivityAt: Date.now() - 600000,
      isIdleReclaimable() { return !this.reinitializing && !this.busy; },
      async close() { seenReinitDuringClose = this.reinitializing; this.closed = true; },
    };
    svc.channels = [c];

    await svc.reapOnce();
    assert.strictEqual(seenReinitDuringClose, true, 'reinitializing true while closing');
    assert.strictEqual(c.reinitializing, false);
  });

  it('startIdleReaper is disabled when idleReclaimMs <= 0', () => {
    const svc = new CrawlerService({ nodeCode: 't', idleReclaimMs: 0 });
    svc.startIdleReaper();
    assert.strictEqual(svc.idleReapTimer, null);
  });

  it('startIdleReaper sets timer and stopIdleReaper clears it', () => {
    const svc = new CrawlerService({ nodeCode: 't', idleReclaimMs: 300000, idleReapIntervalMs: 100000 });
    svc.startIdleReaper();
    assert.ok(svc.idleReapTimer, 'timer should be set');
    svc.stopIdleReaper();
    assert.strictEqual(svc.idleReapTimer, null);
  });

  it('config defaults: idleReclaimMs=300000, idleReapIntervalMs=30000', () => {
    const svc = new CrawlerService({ nodeCode: 't' });
    assert.strictEqual(svc.config.idleReclaimMs, 300000);
    assert.strictEqual(svc.config.idleReapIntervalMs, 30000);
  });

  it('config honors explicit idleReclaimMs=0 (disabled, not defaulted)', () => {
    const svc = new CrawlerService({ nodeCode: 't', idleReclaimMs: 0 });
    assert.strictEqual(svc.config.idleReclaimMs, 0);
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`node --test test/service-idle-reaper.test.js`
预期：FAIL（`reapOnce` / `startIdleReaper` / `stopIdleReaper` is not a function；配置默认值断言失败）。

- [ ] **步骤 3：实现（`src/service.js`）**

在 `constructor` 中 `this.config` 合并块之后（`this.config = { ...config, nodeCode: ..., stealthMode: ... };` 之后）追加配置读取（区分"未配置"与"显式 0"）：
```js
    const idleReclaimRaw = config?.idleReclaimMs ?? process.env.CRAWLER_IDLE_RECLAIM_MS;
    this.config.idleReclaimMs = idleReclaimRaw === undefined ? 300000 : Number(idleReclaimRaw);
    const idleReapRaw = config?.idleReapIntervalMs ?? process.env.CRAWLER_IDLE_REAP_INTERVAL_MS;
    this.config.idleReapIntervalMs = idleReapRaw === undefined ? 30000 : Number(idleReapRaw);
```

在 `constructor` 字段区（`this.heartbeatTimer = null;` 附近）追加：
```js
    this.idleReapTimer = null;
```

在 `stopHeartbeat()` 方法之后、`checkChannelForRotation()` 之前新增三个方法：
```js
  startIdleReaper() {
    if (this.config.idleReclaimMs <= 0) {
      this.log('[IDLE] reclaim disabled (idleReclaimMs<=0)');
      return;
    }
    this.idleReapTimer = setInterval(() => {
      this.reapOnce().catch((e) => this.log('[IDLE] reap error:', e.message));
    }, this.config.idleReapIntervalMs);
  }

  stopIdleReaper() {
    if (this.idleReapTimer) {
      clearInterval(this.idleReapTimer);
      this.idleReapTimer = null;
    }
  }

  async reapOnce() {
    const idleMs = this.config.idleReclaimMs;
    for (const channel of this.channels) {
      if (channel.reinitializing) continue;
      if (!channel.isIdleReclaimable(Date.now(), idleMs)) continue;
      try {
        channel.reinitializing = true;
        await channel.close();
        this.log(`[IDLE] channel ${channel.id} reclaimed after ${Math.round((Date.now() - channel.lastActivityAt) / 1000)}s idle`);
      } catch (e) {
        this.log(`[IDLE] channel ${channel.id} reclaim failed: ${e.message}`);
      } finally {
        channel.reinitializing = false;
      }
    }
  }
```

- [ ] **步骤 4：运行测试确认通过**

运行：`node --test test/service-idle-reaper.test.js`
预期：全部 PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/service.js test/service-idle-reaper.test.js
git commit -m "feat(crawler): CrawlerService 增加空闲回收器 reapOnce 与启停控制"
```

---

## 任务 4：`start()` / `stop()` 接入 reaper

**文件：**
- 修改：`src/service.js`（`start()` 内 `startHealthCheck/startHeartbeat` 之后；`stop()` 内 `stopHealthCheck/stopHeartbeat` 之后）

> 接入是 2 行 wiring，**不写脆弱的 mock 单测**（`start()` 内部会 `new Worker/Poller` 覆盖外部 stub，mock 接入测试信噪比低）。其端到端正确性由任务 5 集成测试兜底：若 `start()` 未接入 reaper，集成测试中"空转 4s 后 `ch.page` 被回收"的断言会失败。reaper 自身行为已在任务 3 单测覆盖。

- [ ] **步骤 1：确认 reaper 单测基线通过**

运行：`node --test test/service-idle-reaper.test.js`
预期：全部 PASS（任务 3 成果，作为接入前的行为基线）。

- [ ] **步骤 2：实现 `start()` 接入（`src/service.js`）**

定位：
```js
    this.startHealthCheck();
    this.startHeartbeat();
    await this.startHealthServer();
```
在 `this.startHeartbeat();` 之后插入：
```js
    this.startIdleReaper();
```

- [ ] **步骤 3：实现 `stop()` 接入（`src/service.js`）**

定位：
```js
    this.stopHealthCheck();
    this.stopHeartbeat();
    this.stopProxyRefresh();
```
在 `this.stopHeartbeat();` 之后插入：
```js
    this.stopIdleReaper();
```

- [ ] **步骤 4：回归 reaper 单测（确认接入未破坏 reaper 本身）**

运行：`node --test test/service-idle-reaper.test.js`
预期：全部 PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/service.js
git commit -m "feat(crawler): service start/stop 接入空闲回收器"
```

---

## 任务 5：集成测试——空转超过阈值后 page 被回收（真 Chromium，兼作任务 4 接入的端到端验证）

**文件：**
- 测试：`test/service.integration.test.js`（在 `describe('Service integration', { timeout: 120000 }, ...)` 内追加 1 个 `it`）

> 该测试会真 `chromium.launch`，与现有集成测试同级（耗时 10–30s）。仅验证"回收路径"，重建路径由任务 2 单元测试覆盖。

- [ ] **步骤 1：编写测试（追加 `it`）**

```js
  it('reclaims idle channel page after idleReclaimMs (no tasks)', async () => {
    let service = null;
    const { server, port } = await startMockUpstream({ tasks: [] });
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      service = await runService({
        baseUrl: 'https://eur.vevor.com',
        imageDir: './output/test-idle-reclaim',
        headless: true,
        nodeCode: 'idle-node',
        nodeToken: 'test-token',
        taskUrl: `${baseUrl}/tasks`,
        callbackUrl: `${baseUrl}/callback`,
        channels: 1,
        pollInterval: 1000,
        pollLimit: 1,
        pushRetries: 1,
        idleReclaimMs: 1500,
        idleReapIntervalMs: 500,
      });

      const ch = service.channels[0];
      const start = Date.now();
      while (!ch.page && Date.now() - start < 30000) {
        await new Promise((r) => setTimeout(r, 200));
      }
      assert.ok(ch.page, 'page initialized');

      await new Promise((r) => setTimeout(r, 4000));
      assert.ok(ch.page === null || ch.page.isClosed(), 'page should be reclaimed by idle reaper');
    } finally {
      if (service) await service.stop();
      server.close();
    }
  });
```

- [ ] **步骤 2：运行测试确认通过**

运行：`node --test test/service.integration.test.js --test-name-pattern "reclaims idle"`
预期：PASS（首次运行可能因 Chromium 冷启动较慢，属正常）。

- [ ] **步骤 3：Commit**

```bash
git add test/service.integration.test.js
git commit -m "test(crawler): 集成验证空闲超阈值后 channel page 被回收"
```

---

## 任务 6：配置透传（linux compose / .env.example / windows ecosystem）

**文件：**
- 修改：`deployment/linux/.env.example`
- 修改：`deployment/linux/docker-compose.yml`
- 修改：`deployment/windows/ecosystem.config.js`
- 测试：`test/deployment/linux-docker-compose.test.js`（追加断言）

- [ ] **步骤 1：编写失败的部署测试断言（追加到 `test/deployment/linux-docker-compose.test.js` 的 `it` 内）**

在现有 `it('exists and disables headed fallback explicitly', ...)` 的 `assert` 序列末尾追加：
```js
    assert.ok(content.includes('CRAWLER_IDLE_RECLAIM_MS'), 'should expose CRAWLER_IDLE_RECLAIM_MS');
    assert.ok(content.includes('CRAWLER_IDLE_REAP_INTERVAL_MS'), 'should expose CRAWLER_IDLE_REAP_INTERVAL_MS');
```

- [ ] **步骤 2：运行部署测试确认失败**

运行：`node --test test/deployment/linux-docker-compose.test.js`
预期：FAIL（缺少 `CRAWLER_IDLE_RECLAIM_MS` / `CRAWLER_IDLE_REAP_INTERVAL_MS`）。

- [ ] **步骤 3：修改 `deployment/linux/.env.example`**

在"服务配置"区段（`CRAWLER_PUSH_RETRIES=3` 之后）追加：
```ini

# 空闲收池：无任务超过该毫秒数则关闭 channel 的浏览器上下文（回收 renderer），来任务时按需重建
# <=0 表示禁用收池（恢复常驻行为）；默认 300000（5 分钟）
CRAWLER_IDLE_RECLAIM_MS=300000
# 空闲扫描间隔（毫秒），默认 30000（30 秒）
CRAWLER_IDLE_REAP_INTERVAL_MS=30000
```

- [ ] **步骤 4：修改 `deployment/linux/docker-compose.yml`**

在 `services.crawler.environment` 列表（`CRAWLER_HEADED_FALLBACK=false` 之后）追加：
```yaml
      - CRAWLER_IDLE_RECLAIM_MS=${CRAWLER_IDLE_RECLAIM_MS:-300000}
      - CRAWLER_IDLE_REAP_INTERVAL_MS=${CRAWLER_IDLE_REAP_INTERVAL_MS:-30000}
```

- [ ] **步骤 5：修改 `deployment/windows/ecosystem.config.js`**

在 `apps[0].env` 对象内（`PLAYWRIGHT_BROWSERS_PATH` 之后）追加：
```js
      CRAWLER_IDLE_RECLAIM_MS: process.env.CRAWLER_IDLE_RECLAIM_MS || '300000',
      CRAWLER_IDLE_REAP_INTERVAL_MS: process.env.CRAWLER_IDLE_REAP_INTERVAL_MS || '30000',
```

- [ ] **步骤 6：运行部署测试确认通过**

运行：`node --test test/deployment/linux-docker-compose.test.js`
预期：PASS。

- [ ] **步骤 7：Commit**

```bash
git add deployment/linux/.env.example deployment/linux/docker-compose.yml deployment/windows/ecosystem.config.js test/deployment/linux-docker-compose.test.js
git commit -m "feat(deploy): 透传 CRAWLER_IDLE_RECLAIM_MS / CRAWLER_IDLE_REAP_INTERVAL_MS"
```

---

## 任务 7：全量回归 + 自检

- [ ] **步骤 1：运行全量单元/集成测试**

运行：`npm test`
预期：全部 PASS。若失败，回到对应任务修复，不要跳过。

- [ ] **步骤 2：定向验证关键路径**

运行：`node --test test/channel.test.js test/service-idle-reaper.test.js test/service.integration.test.js`
预期：全部 PASS。

- [ ] **步骤 3：Commit（仅当步骤 1/2 有修复时）**

```bash
git add -A
git commit -m "chore(crawler): 空闲收池全量回归修复"
```

---

## VPS 部署注记（灰度，代码合并后执行，不在本计划 commit 内）

VPS 上 8 个 `hs-sku-crawler-*` 容器的环境变量由 `/opt/crawler/.env` 注入（`env_file: .env`）。代码合并镜像更新后：

1. 先以**禁用**状态灰度：在 `/opt/crawler/.env` 设 `CRAWLER_IDLE_RECLAIM_MS=0`，滚动重启 8 容器，确认无回归（行为同改动前）。
2. 再启用：`CRAWLER_IDLE_RECLAIM_MS=300000`（5min），`CRAWLER_IDLE_REAP_INTERVAL_MS=30000`，滚动重启。
3. 观察 Grafana `crawler-nodes`：`crawler-2/6/7/8` 在空转超过 5min 后 CPU 应降至个位数；日志出现 `[IDLE] channel i reclaimed after Xs idle`；首个任务延迟增加约 1–2s，成功率不变。
4. 回滚：`CRAWLER_IDLE_RECLAIM_MS=0` 重启即可。

> 主题 A（crawlab 退役）处于 `docker stop` 24–48h 观察期；观察期结束且无异常后，再执行硬删除（`docker rm` + `docker volume rm`），与本特性独立。

---

## 自检

**1. 规格覆盖度：**
- §4.1 Channel 字段/方法 → 任务 1、2 ✓
- §4.2 CrawlerService reaper/配置 → 任务 3、4 ✓
- §4.3 Worker 不改 → 未列入变更 ✓
- §5 时序 → 任务 2（markActivity/ensureContext 入口）+ 任务 3（reaper 复判）覆盖 ✓
- §6 错误处理/竞态 → 任务 3（reinitializing 包裹、browser 断开 throw）+ 任务 2 测试 ✓
- §7 配置透传（含 Windows） → 任务 6 ✓
- §8 测试（3 单元 + 1 集成） → 任务 1/2（channel 单测 7 条）+ 任务 3/4（service 单测 7 条）+ 任务 5（集成 1 条）✓（超过规格的 3 条单元，覆盖更全）
- §9 监控日志 → 任务 3 `reapOnce` 内 `[IDLE]` 日志 ✓
- §10 回滚 → VPS 部署注记 ✓
- §11 验收标准 → 任务 7 + VPS 注记第 3 步 ✓
- §12 风险未决 → VPS 注记 + 任务 2 指纹不变约束 ✓

**2. 占位符扫描：** 无 TODO/待定；每个代码步骤含完整代码块；命令与预期输出齐全。

**3. 类型一致性：** `ensureContext` / `isIdleReclaimable` / `markActivity` / `reapOnce` / `startIdleReaper` / `stopIdleReaper` 在任务 1–7 中命名一致；`idleReclaimMs` / `idleReapIntervalMs` 命名一致；`lastActivityAt` / `reinitializing` / `browserContext` 复用 Channel 既有字段名，未引入别名冲突。
