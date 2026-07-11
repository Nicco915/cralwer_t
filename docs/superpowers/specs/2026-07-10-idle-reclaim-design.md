# 空闲收池（Idle Reclaim）设计

- 状态：草稿（待审查）
- 日期：2026-07-10
- 关联：crawlab 退役（主题 A，已 `docker stop` 进入 24–48h 观察期）

## 1. 背景与目标

VPS 上 8 个 `hs-sku-crawler-*` 容器以 service 模式常驻。每个容器：`CrawlerService` 持有 1 个 `browser`，`channels=1` 即 1 个 `Channel`，`Channel` 持有 1 个 `browserContext` + 1 个 `page`。无任务时（`heartbeat: pending=0, running=0, browserConnected=true`）`page` 仍停在最后一个商品详情页上；又由于 launch 参数带了 `--disable-background-timer-throttling`，后台页面里的 `setInterval`/动画/指纹/追踪脚本全速运行，导致 `crawler-2/6/7/8` 四个容器 CPU 长期 36–41%（另四个碰巧停在轻页，5–6%）。

目标：空闲超过阈值时回收 channel 的 `context+page`（关 renderer、清掉残留页面 JS），来任务时按需重建；不动 `browser`、不动节流参数、不改 Worker。预期把高 CPU 容器降到个位数，首个任务增加约 1–2s 重建延迟。

## 2. 现状证据

- 进程树（每容器）：`1 browser main + 1 gpu + 1 renderer + 4 utility + 2 zygote + 2 crashpad`，仅 1 个 `renderer` ↔ 1 个 page。
- `CrawlerService.initBrowser()` launch args 含 `--disable-background-timer-throttling`。
- `Channel.crawl()` 直接使用 `this.page`（`crawlSingleSku(task.sku, this.page, …)`），无 page 时不会自愈。
- `Channel.refreshPageIfNeeded()` 按 task 计数（默认每 20 个）刷新，空闲不触发。
- `CrawlerService.restartBrowser()` 已存在完整"关 channel→关 browser→重 launch"逻辑，可复用其"关"的语义；但当前无任何"空闲超时回收"逻辑。
- `crawler-8` 的 `output/browser-temp/` 下出现两个 profile（活跃 `…-2VOTjy`、残留 `…-MQy9WG`）+ `playwright-artifacts-*`，疑似异常退出遗留（本期不自动清理，见 §6/§12）。

## 3. 范围

**做**：Channel 空闲回收 `context+page` + 按需重建；CrawlerService 增加空闲扫描定时器；配置项；单元与集成测试。

**不做**：关闭 `browser`（方案 3 已否决）；改动 `--disable-background-timer-throttling`；自动清理 orphan profile；修改 Worker；删除 crawlab 之外的容器/卷。

## 4. 架构与组件接口

### 4.1 `Channel`（`src/channel.js`）

新增字段：

- `this.browser: Browser | null` — 在 `init` / `reinit` / `recreateContext` 中赋值为传入的 `browser`，供按需重建使用。
- `this.lastActivityAt: number` — ms epoch，构造时初始化为 `Date.now()`。

新增方法：

- `markActivity(): void` — `this.lastActivityAt = Date.now()`。
- `async ensureContext(): Promise<Page>` — **无副作用重建**，必须保持 channel 的 profile/指纹不变：
  - 若 `this.browserContext && this.page && !this.page.isClosed()` 直接 `return this.page;`（仍有活性，无需重建）。
  - 否则若 `!this.browser || !this.browser.isConnected()`，`throw new Error('Browser not available for ensureContext')`，由 `runHealthCheck → restartBrowser()` 接管。
  - 若 `this.browserContext` 仍在（page 已关但 context 未关），先 `await this.browserContext.close()` 并置 `null`，避免 context 泄漏。
  - 用 `this._buildContextOptions()`（基于现有 `this.profile`）`await this.browser.newContext(...)` → `addInitScript(this.getStealthScript())` → `newPage()`，写一行 `[Channel i] context re-created after idle reclaim` 日志。
  - **不得调用 `recreateContext`**：`recreateContext` 在 `stealthMode==='session'` 时会 `sessionIndex += 1` 并重建 profile，会改变 channel 指纹；空闲回收只省资源、不换身份。
- `isIdleReclaimable(now, idleMs): boolean` — `return !this.busy && !this.reinitializing && !!this.browserContext && (now - this.lastActivityAt) > idleMs;`。

改动点：

- `constructor`：初始化 `this.browser = null; this.lastActivityAt = Date.now();`。
- `init(browser, proxyOverride)`：首句 `this.browser = browser;`；末尾 `this.markActivity();`。
- `recreateContext(browser)`：首句 `this.browser = browser;`。
- `reinit(browser, proxyOverride)`：沿用 `await this.close(); await this.init(browser, proxyOverride);`（`init` 已负责更新 `this.browser`）。
- `crawl(task)`：在 `this.currentTask = task;` 之后、业务逻辑之前插入 `this.markActivity(); await this.ensureContext();`。
- `close()`：语义与幂等性不变；仍置 `this.browserContext = null; this.page = null;`，**保留** `this.browser` 引用（`browser` 由 service 持有；若 service 后续 `restartBrowser` 换 browser，`init/reinit` 会刷新该引用）。

### 4.2 `CrawlerService`（`src/service.js`）

新增字段：`this.idleReapTimer = null;`

配置（在 `constructor` 合并，默认与禁用语义）：

- `this.config.idleReclaimMs`：默认 `300000`（5min）；`<= 0` 表示禁用收池（灰度开关）。
- `this.config.idleReapIntervalMs`：默认 `30000`（30s）。

新增方法：

- `startIdleReaper(): void` — 若 `this.config.idleReclaimMs <= 0` 则记录一行 `[IDLE] reclaim disabled` 并直接返回（不启动定时器）；否则 `this.idleReapTimer = setInterval(() => this.reapOnce().catch(e => this.log('[IDLE] reap error:', e.message)), this.config.idleReapIntervalMs);`。
- `stopIdleReaper(): void` — `clearInterval(this.idleReapTimer); this.idleReapTimer = null;`。
- `async reapOnce(): Promise<void>` — 遍历 `this.channels`；对每个 `channel.isIdleReclaimable(Date.now(), this.config.idleReclaimMs)` 为真的 channel：
  ```
  if (channel.reinitializing) continue;            // 双保险
  try {
    channel.reinitializing = true;                  // 让 Worker.getIdleChannel 跳过它
    if (!channel.isIdleReclaimable(Date.now(), idleMs)) continue;  // 置位后复判，防与 runTask 竞态
    await channel.close();
    this.log(`[IDLE] channel ${channel.id} reclaimed after ${Math.round((Date.now()-channel.lastActivityAt)/1000)}s idle`);
  } catch (e) {
    this.log(`[IDLE] channel ${channel.id} reclaim failed: ${e.message}`);
  } finally {
    channel.reinitializing = false;
  }
  ```

接入点：

- `start()`：在 `this.startHealthCheck(); this.startHeartbeat();` 之后调用 `this.startIdleReaper();`。
- `stop()`：在 `this.stopHealthCheck(); this.stopHeartbeat();` 之后调用 `this.stopIdleReaper();`。

### 4.3 `Worker`（`src/worker.js`）

不修改。兼容性说明：`hasCapacity()` / `getIdleChannel()` 仅依据 `busy` / `reinitializing`；被 `close()` 的 channel `busy=false` 仍被视为 idle，Poller 继续拉任务、`loop()` 继续派发，进入 `runTask → crawl → ensureContext()` 自动重建。reaper 在 `close()` 期间置 `reinitializing=true`，`getIdleChannel()` 会跳过，避免把任务派给正在回收的 channel。

## 5. 时序

```
任务结束:  runTask finally → busy=false → channel.markActivity()
Reaper:    每 30s 扫描 → channel 空闲 > 5min 且 !busy && !reinitializing
           → reinitializing=true → 复判 → channel.close() → reinitializing=false
           (renderer 回收，残留页面 JS 消失)
来任务:    loop 取 busy=false 的 channel → runTask busy=true
           → crawl → ensureContext() 重建 context+page (~1-2s) → 正常 crawl
关闭/重启: stop() / restartBrowser() 路径不变；close() 幂等
```

`busy=true` 期间 reaper 绝不回收，长任务不会被误杀；空闲计时仅从 `busy=false` 之后开始。

## 6. 错误处理与竞态

- **reaper ↔ runTask**：reaper 以 `reinitializing=true` 包裹整个 `close()`（`getIdleChannel` 跳过 `reinitializing` 的 channel），且置位后复判 `isIdleReclaimable`，避免"刚判空闲、任务刚到"的窗口。`ensureContext()` 在 `busy=true` 之后执行，即便 page 刚被关也能重建——不丢任务。
- **browser 已断**：`ensureContext()` 检测到 `browser.isConnected()===false` 直接抛错；现有 `runHealthCheck → restartBrowser()` 接管重建，无需新增逻辑。
- **ensureContext 自身失败**：作为 crawl error 冒泡，走原有 timeout/error 推送路径。
- **reaper 与 healthCheck 同操作 channel**：二者共用 `reinitializing` 标志互斥；`checkChannelForRotation` 本身也以 `busy=false` 为前置，不会与 runTask 冲突。

## 7. 配置

```
CRAWLER_IDLE_RECLAIM_MS=300000       # 空闲 5min 回收；<=0 表示禁用（灰度开关）
CRAWLER_IDLE_REAP_INTERVAL_MS=30000  # 扫描间隔 30s
```

透传位置：`deployment/linux/.env.example`（新增示例与注释）与 `deployment/linux/docker-compose.yml`（`environment` 列表），命名风格同现有 `CRAWLER_*`。收池逻辑在 `src/`，跨平台共享；Windows/PM2 侧（`deployment/windows/ecosystem.config.js`）同步新增同名环境变量键以保持多平台一致，纳入本期范围。

## 8. 测试

单元（`test/channel.test.js` 新增或扩展）：

1. `ensureContext` 在 `this.page === null` 时重建 context+page 并返回可用 page。
2. `ensureContext` 在 `page.isClosed() === true` 时重建。
3. `isIdleReclaimable` 四边界：`busy=true`→false、`reinitializing=true`→false、`browserContext=null`→false、超时且空闲→true。

集成（`test/service.integration.test.js`，用 `test/fixtures/stub-server`）：

4. 启动 service（`idleReclaimMs` 调小如 1500ms）→ 空转超过阈值 → 断言 `channel.page.isClosed() === true` 且存在 `[IDLE] … reclaimed` 日志 → 注入 1 个任务 → 断言 crawl 成功（`ensureContext` 重建生效）。

## 9. 监控与可观测

- 复用现有日志：reaper 输出 `[IDLE] channel i reclaimed after Xs idle`；`ensureContext` 重建沿用 `[Channel i] initialized`。
- `heartbeat` 结构不变（仍报 `browserConnected`；收池期间 browser 不断开，故恒为 true，符合预期）。
- 验收观察：Grafana `crawler-nodes` 看 `crawler-2/6/7/8` CPU 在空转超过阈值后降至个位数；首个任务延迟增加约 1–2s。

## 10. 回滚

- 运行时：`CRAWLER_IDLE_RECLAIM_MS=0` 重启即禁用收池（恢复常驻行为）。
- 代码：`git revert` 对应提交即可；不触及任务链路、数据、代理逻辑，回滚无副作用。

## 11. 验收标准

- 空转超过 `idleReclaimMs` 后，8 个容器的 renderer 均被回收（`docker stats` CPU 降至个位数；`ps` 不再见常驻高 CPU renderer）。
- 来首个任务时 `ensureContext` 在约 1–2s 内重建并正常完成 crawl，任务成功率与改动前一致。
- healthcheck、heartbeat、proxy 轮换、`restartBrowser` 行为不变。

## 12. 风险与未决

- **orphan profile 残留**：本期不自动清理，先观察正常 `close()` 路径是否仍会遗留 `playwright_chromiumdev_profile-*`；若仍残留，单独立项做启动期 orphan 清理（需严格排除活跃 profile，避免误删）。
- **首个任务延迟**：约 1–2s，对 Poller 10s 间隔与 taskTimeoutMs 130s 可接受。
- **`disable-background-timer-throttling`**：保留不动；收池后空转 page 已关闭，节流参数对空转 CPU 不再相关，改动反而影响任务期行为。
