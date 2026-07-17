# 区域无结果兜底到 US 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 当 UK/EU/CA 站点搜索页明确无结果时，自动到 US 站点兜底重试一次，并把全局任务超时从 130s 提高到 200s。

**架构：** 在 `Worker.runTask` 中，第一次 `channel.crawl` 返回 `not_found` 且 `error === 'Page shows no result'` 时，临时把 `task.baseUrl` 切换为 US URL 再 crawl 一次；`result.regionCode` 保持原请求区域。`RegionRegistry` 内置 US 重新启用。

**技术栈：** Node.js / Playwright / node:test / 原生 `git`

---

## 涉及文件

| 文件 | 职责 |
|---|---|
| `src/region-registry.js` | 内置 US 区域启用 |
| `src/crawler.js` | 默认 `taskTimeoutMs` 从 130000 改为 200000 |
| `src/worker.js` | 新增 `NO_RESULT_FALLBACKS` 常量，实现兜底重试逻辑 |
| `test/worker-region.test.js` | 新增兜底场景单元测试 |
| `scripts/deploy/windows/native/.env.example` | 更新多区域示例，移除 US 禁用说明 |
| `scripts/deploy/windows/docker/.env.example` | 同上 |
| `deployment/windows/ecosystem.canada.config.js` | 注入 `CRAWLER_REGIONS` / `CRAWLER_DEFAULT_REGION` |

---

### 任务 1：启用内置 US 区域

**文件：**
- 修改：`src/region-registry.js:7-13`

- [ ] **步骤 1：修改 BUILT_IN_REGIONS 并更新注释**

```js
// VEVOR 各区域站的 canonical URL（公开事实，非密钥）。
// 空字符串 = 已知区域但无目标站（禁用），resolve 返回 null。
// US 启用：2026-07-17 已通过 cdn_toggle_domain=1 Cookie 绕过 DE geo 重定向，
//          VPS/Windows 烟测均通过 www.vevor.com。
const BUILT_IN_REGIONS = {
  EU: 'https://eur.vevor.com',
  GB: 'https://www.vevor.co.uk',
  CA: 'https://www.vevor.ca',
  US: 'https://www.vevor.com',
  CN: '',
};
```

- [ ] **步骤 2：运行现有区域测试确认无回归**

```bash
node --test test/worker-region.test.js
```

预期：全部通过（6/6）。

- [ ] **步骤 3：Commit**

```bash
git add src/region-registry.js
git commit -m "feat(region): 内置 US 区域重新启用并更新注释"
```

---

### 任务 2：全局任务超时调整为 200s

**文件：**
- 修改：`src/crawler.js:46`
- 修改：`src/crawler.js:93-94`
- 修改：`src/worker.js:23`

- [ ] **步骤 1：修改 crawler.js 默认配置**

```js
// src/crawler.js:46
  taskTimeoutMs: 200000,
```

- [ ] **步骤 2：修改 crawler.js env 回退值**

```js
// src/crawler.js:93-94
  const taskTimeoutMsParsed = taskTimeoutMsRaw ? parseInt(taskTimeoutMsRaw, 10) : 200000;
  cfg.taskTimeoutMs = Number.isNaN(taskTimeoutMsParsed) ? 200000 : taskTimeoutMsParsed;
```

- [ ] **步骤 3：修改 worker.js 构造函数回退值**

```js
// src/worker.js:23
    this.taskTimeoutMs = (options && options.taskTimeoutMs) || 200000;
```

- [ ] **步骤 4：运行现有测试确认无回归**

```bash
node --test test/worker-region.test.js
```

预期：全部通过。

- [ ] **步骤 5：Commit**

```bash
git add src/crawler.js src/worker.js
git commit -m "feat(config): 默认任务超时从 130s 提高到 200s"
```

---

### 任务 3：编写兜底重试的测试（先写测试）

**文件：**
- 修改：`test/worker-region.test.js`

- [ ] **步骤 1：在文件末尾追加辅助函数和测试用例**

```js
function makeChannelWithFallbackResponse() {
  return {
    id: 1,
    busy: false,
    reinitializing: false,
    onTaskComplete: null,
    crawlCalls: [],
    async crawl(task) {
      this.crawlCalls.push(task);
      const region = task.regionCode;
      const baseUrl = task.baseUrl || '';
      // 第一次访问非 US 区域时模拟页面无结果
      if (this.crawlCalls.length === 1 && !baseUrl.includes('www.vevor.com')) {
        return {
          sku: task.sku,
          status: 'not_found',
          error: 'Page shows no result',
          product_name: '',
          product_url: '',
          features_details: '',
          product_specification: '',
        };
      }
      // 第二次访问 US 区域时返回成功
      return {
        sku: task.sku,
        status: 'success',
        product_name: 'X',
        product_url: `${baseUrl}/p/X`,
        features_details: '',
        product_specification: '',
      };
    },
  };
}

describe('Worker no-result fallback to US', () => {
  it('GB page shows no result -> fallback to US and keeps regionCode as GB', async () => {
    const pusher = makePusher();
    const channel = makeChannelWithFallbackResponse();
    const worker = new Worker({ pusher, log: () => {}, regionRegistry: new RegionRegistry() });
    const result = await worker.runTask({ crawlerTaskId: 10, sku: 'S10', regionCode: 'GB' }, channel);

    assert.strictEqual(channel.crawlCalls.length, 2);
    assert.strictEqual(channel.crawlCalls[0].baseUrl, 'https://www.vevor.co.uk');
    assert.strictEqual(channel.crawlCalls[1].baseUrl, 'https://www.vevor.com');
    assert.strictEqual(result.status, 'success');
    assert.strictEqual(result.regionCode, 'GB');
    assert.strictEqual(pusher.pushed.length, 1);
    assert.strictEqual(pusher.pushed[0].regionCode, 'GB');
  });

  it('EU page shows no result -> fallback to US', async () => {
    const pusher = makePusher();
    const channel = makeChannelWithFallbackResponse();
    const worker = new Worker({ pusher, log: () => {}, regionRegistry: new RegionRegistry() });
    const result = await worker.runTask({ crawlerTaskId: 11, sku: 'S11', regionCode: 'EU' }, channel);

    assert.strictEqual(channel.crawlCalls.length, 2);
    assert.strictEqual(channel.crawlCalls[1].baseUrl, 'https://www.vevor.com');
    assert.strictEqual(result.status, 'success');
    assert.strictEqual(result.regionCode, 'EU');
  });

  it('CA page shows no result -> fallback to US', async () => {
    const pusher = makePusher();
    const channel = makeChannelWithFallbackResponse();
    const worker = new Worker({ pusher, log: () => {}, regionRegistry: new RegionRegistry() });
    const result = await worker.runTask({ crawlerTaskId: 12, sku: 'S12', regionCode: 'CA' }, channel);

    assert.strictEqual(channel.crawlCalls.length, 2);
    assert.strictEqual(channel.crawlCalls[1].baseUrl, 'https://www.vevor.com');
    assert.strictEqual(result.status, 'success');
    assert.strictEqual(result.regionCode, 'CA');
  });

  it('US page shows no result -> does not fallback again', async () => {
    const pusher = makePusher();
    const channel = makeChannelWithFallbackResponse();
    const worker = new Worker({ pusher, log: () => {}, regionRegistry: new RegionRegistry() });
    const result = await worker.runTask({ crawlerTaskId: 13, sku: 'S13', regionCode: 'US' }, channel);

    assert.strictEqual(channel.crawlCalls.length, 1);
    assert.strictEqual(channel.crawlCalls[0].baseUrl, 'https://www.vevor.com');
    assert.strictEqual(result.status, 'not_found');
    assert.strictEqual(result.error, 'Page shows no result');
  });

  it('does not fallback for "No product URL found"', async () => {
    const pusher = makePusher();
    const channel = {
      id: 1,
      busy: false,
      reinitializing: false,
      onTaskComplete: null,
      crawlCalls: [],
      async crawl(task) {
        this.crawlCalls.push(task);
        return {
          sku: task.sku,
          status: 'not_found',
          error: 'No product URL found',
          product_name: '',
          product_url: '',
          features_details: '',
          product_specification: '',
        };
      },
    };
    const worker = new Worker({ pusher, log: () => {}, regionRegistry: new RegionRegistry() });
    const result = await worker.runTask({ crawlerTaskId: 14, sku: 'S14', regionCode: 'GB' }, channel);

    assert.strictEqual(channel.crawlCalls.length, 1);
    assert.strictEqual(result.status, 'not_found');
    assert.strictEqual(result.error, 'No product URL found');
  });

  it('does not fallback when US is disabled in RegionRegistry', async () => {
    const pusher = makePusher();
    const channel = makeChannelWithFallbackResponse();
    const worker = new Worker({
      pusher,
      log: () => {},
      regionRegistry: new RegionRegistry({ regions: 'US=' }),
    });
    const result = await worker.runTask({ crawlerTaskId: 15, sku: 'S15', regionCode: 'GB' }, channel);

    assert.strictEqual(channel.crawlCalls.length, 1);
    assert.strictEqual(result.status, 'not_found');
  });
});
```

- [ ] **步骤 2：运行测试，确认失败**

```bash
node --test test/worker-region.test.js
```

预期：新增的 fallback 测试失败（crawlCalls.length 期望 2 实际 1）。

- [ ] **步骤 3：Commit 失败的测试**

```bash
git add test/worker-region.test.js
git commit -m "test(worker): 区域无结果兜底到 US 的测试（待实现）"
```

---

### 任务 4：实现 Worker 层兜底重试

**文件：**
- 修改：`src/worker.js`

- [ ] **步骤 1：在文件顶部添加兜底映射常量**

在 `class Worker {` 之前插入：

```js
const NO_RESULT_FALLBACKS = {
  GB: 'US',
  EU: 'US',
  CA: 'US',
};
```

- [ ] **步骤 2：在第一次 crawl 后、换 IP 重试前插入兜底逻辑**

定位到 `src/worker.js:173` 附近的注释：

```js
      // 换 IP 重试：针对 crawl 抛异常或返回异常 result 的场景
```

在该注释**之前**插入：

```js
      // 区域无结果兜底：UK/EU/CA 搜索页明确无结果时，到 US 站点再试一次
      if (result && result.status === 'not_found' && result.error === 'Page shows no result') {
        const fallbackRegion = NO_RESULT_FALLBACKS[task.regionCode];
        if (fallbackRegion && this.regionRegistry) {
          const fallbackBaseUrl = this.regionRegistry.resolve(fallbackRegion);
          if (fallbackBaseUrl) {
            this.log(`[Worker] task ${task.crawlerTaskId} page shows no result on ${task.regionCode}, falling back to ${fallbackRegion}`);
            task.baseUrl = fallbackBaseUrl;
            try {
              result = await channel.crawl(task);
              this.log(`[Worker] Fallback crawl finished task ${task.crawlerTaskId} status ${result.status}`);
            } catch (fallbackErr) {
              this.log(`[Worker] Fallback crawl failed task ${task.crawlerTaskId}: ${fallbackErr.message}`);
              result = this.buildErrorResult(task, fallbackErr);
            }
          }
        }
      }
```

- [ ] **步骤 3：运行测试确认通过**

```bash
node --test test/worker-region.test.js
```

预期：全部通过（约 12 个测试）。

- [ ] **步骤 4：Commit**

```bash
git add src/worker.js
git commit -m "feat(worker): UK/EU/CA 无结果时兜底到 US 站点"
```

---

### 任务 5：更新 Windows 部署配置示例

**文件：**
- 修改：`scripts/deploy/windows/native/.env.example`
- 修改：`scripts/deploy/windows/docker/.env.example`
- 修改：`deployment/windows/ecosystem.canada.config.js`

- [ ] **步骤 1：更新 native .env.example**

把：

```bash
# 多区域映射（可选）：留空时默认区域=EU 且站点=CRAWLER_BASE_URL
# 区域码：EU 欧盟 / GB 英国 / CA 加拿大 / US 美国 / CN 中国（留空=禁用）
# 注意：US 内置禁用——2026-07-12 烟测证实 DE 出口访问 www.vevor.com 被按德国 IP 地理重定向到
#       www.vevor.de，返回错误区域数据。待 US 出口代理/US 节点就绪前，生产勿启用 US（保持 EU/GB/CA）。
# CRAWLER_REGIONS='EU=https://eur.vevor.com,GB=https://www.vevor.co.uk,CA=https://www.vevor.ca'
# CRAWLER_DEFAULT_REGION=EU
```

改为：

```bash
# 多区域映射（可选）：留空时默认区域=EU 且站点=CRAWLER_BASE_URL
# 区域码：EU 欧盟 / GB 英国 / CA 加拿大 / US 美国 / CN 中国（留空=禁用）
# US 已启用：2026-07-17 通过 cdn_toggle_domain Cookie 绕过 DE geo 重定向，VPS/Windows 烟测通过。
# CRAWLER_REGIONS='EU=https://eur.vevor.com,GB=https://www.vevor.co.uk,CA=https://www.vevor.ca,US=https://www.vevor.com'
# CRAWLER_DEFAULT_REGION=EU
```

- [ ] **步骤 2：更新 docker .env.example**

做与步骤 1 完全相同的替换。

- [ ] **步骤 3：更新加拿大 ecosystem 配置**

在 `deployment/windows/ecosystem.canada.config.js` 中，于 `SHARED_UPSTREAM` 之后新增：

```js
const SHARED_REGIONS = {
  CRAWLER_REGIONS: 'EU=https://eur.vevor.com,GB=https://www.vevor.co.uk,CA=https://www.vevor.ca,US=https://www.vevor.com',
  CRAWLER_DEFAULT_REGION: 'EU',
};
```

然后在 `makeApp` 的 `env` 对象中，于 `...SHARED_UPSTREAM,` 之后加入：

```js
      ...SHARED_REGIONS,
```

- [ ] **步骤 4：验证示例文件语法**

```bash
node -e "require('./deployment/windows/ecosystem.canada.config.js')"
```

预期：无报错，正常退出。

- [ ] **步骤 5：Commit**

```bash
git add scripts/deploy/windows/native/.env.example scripts/deploy/windows/docker/.env.example deployment/windows/ecosystem.canada.config.js
git commit -m "docs(deploy): Windows 部署示例包含 US 区域"
```

---

### 任务 6：全量回归测试

- [ ] **步骤 1：运行所有单元测试**

```bash
node --test test/*.test.js
```

预期：全部通过，无新增失败。

- [ ] **步骤 2：检查工作区状态**

```bash
git status --short
```

预期：只显示计划内的已提交变更，无未提交调试代码。

- [ ] **步骤 3：提交任何遗漏的变更（如有）**

如果上一步发现未提交文件，单独 commit 并说明原因。

---

## 自检

- **规格覆盖度：**
  - 兜底规则 ✓（任务 4）
  - result.regionCode 保持原区域 ✓（任务 3 测试断言）
  - US 内置启用 ✓（任务 1）
  - 全局超时 200s ✓（任务 2）
  - Windows 部署配置更新 ✓（任务 5）
- **占位符扫描：** 无 TODO/待定/“适当处理”等模糊描述。
- **类型一致性：** `task.baseUrl`、`result.status`、`result.error`、`result.regionCode` 与现有代码一致。
