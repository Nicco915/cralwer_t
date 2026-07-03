# Header 伪装与反检测增强设计

## 背景

当前爬虫使用原生 Playwright，所有节点/通道共享同一个硬编码 User-Agent 和同一套简单 stealth 脚本：

- 固定 UA：`Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0`
- 自定义 stealth 脚本覆盖 `navigator.webdriver`、`navigator.plugins`、`navigator.languages`、`window.chrome`、`navigator.permissions.query`
- 启动参数包含 `--disable-blink-features=AutomationControlled`
- 未使用 `playwright-extra` 或 `puppeteer-extra-plugin-stealth`
- 多节点部署已按节点区分 `CRAWLER_NODE_CODE` 和 `CLIPROXY_SESSION_PREFIX`，但 UA/Header 仍全局固定

在大规模多节点部署（6+ 节点、高并发）场景下，固定 Header 容易被目标站通过统计聚类识别。本设计采用**原生 Playwright 自研增强**路线，在不引入外部社区封装层的前提下，实现按节点/通道/会话动态化 Header 与基础指纹。

## 目标

1. 消除所有节点/通道共用固定 UA 的风险。
2. 保证同一节点重启后指纹稳定，便于问题定位。
3. 保证不同节点、不同通道之间的指纹充分分散。
4. 提供一键回滚到当前固定 UA 行为的配置开关。
5. 新增可测试、可监控的 stealth 模块，不引入 `playwright-extra` 等第三方封装依赖。

## 非目标

- 不追求 100% 通过所有高级指纹检测（如 Canvas/WebGL 像素级对抗），优先解决 Header 聚类风险。
- 不引入 `puppeteer-extra-plugin-stealth` 等社区插件作为默认方案；保留未来作为试点对比的扩展空间。
- 不改动现有代理池、任务调度、Excel 输出等业务逻辑。

## 方案概述

新增 `src/stealth-profile.js` 模块，负责根据节点标识、通道号、会话索引生成一份自洽的浏览器指纹配置（UA、viewport、locale、timezone、platform、deviceMemory、hardwareConcurrency、stealthScript 等）。

`Channel`、`Service`、`Crawler` 在初始化时调用该模块获取 profile，替代当前硬编码的 `DEFAULT_USER_AGENT` 和内联 stealth 脚本。

## 详细设计

### 1. 新增模块 `src/stealth-profile.js`

#### 职责

- 维护内置 UA 池、locale 池、viewport 池。
- 根据输入 seed 确定性选择一份自洽配置。
- 生成与配置匹配的 `stealthScript`。
- 支持通过环境变量覆盖/扩展 UA 池。

#### 接口

```js
const { createProfile, listSupportedLocales } = require('./src/stealth-profile');

const profile = createProfile({
  nodeCode: 'crawler-eu-01', // 节点标识
  channelId: 1,              // 通道号
  sessionIndex: 0,           // 会话索引，recreateContext 时递增
  mode: 'channel',           // 'fixed' | 'channel' | 'session'
  fixedUserAgent: null,      // mode='fixed' 时强制使用的 UA
});
```

返回对象示例：

```js
{
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  viewport: { width: 1920, height: 1080 },
  locale: 'en-GB',
  timezoneId: 'Europe/London',
  platform: 'Win32',
  colorDepth: 24,
  deviceMemory: 8,
  hardwareConcurrency: 8,
  languages: ['en-GB', 'en'],
  stealthScript: '() => { ... }',
  signature: 'a1b2c3d4', // 对 profile 关键字段做 sha256 后取前 8 位，用于日志
}
```

#### 内置 UA 池

- 覆盖 Chrome、Edge、Firefox、Safari 的常见桌面版本。
- 按市场占有率加权，桌面端占绝大多数。
- UA 字符串中的操作系统决定 `platform` 和 `navigator.platform` 返回值。
- UA 池以 JSON 文件形式内置在模块旁，支持通过 `CRAWLER_UA_POOL_PATH` 指定外部文件覆盖。

#### 确定性随机

- `seed = fnv1a(nodeCode + ':' + channelId + ':' + sessionIndex)`，使用确定性字符串哈希（如 `crypto.createHash('sha256').update(str).digest('hex')` 或 `fnv1a`）。
- 同一节点同一通道重启后基础指纹稳定。
- 不同节点、不同通道之间分散。
- `mode='session'` 时每次 `recreateContext` 递增 `sessionIndex`，生成新指纹。

#### 指纹一致性规则

| 字段 | 来源规则 |
|---|---|
| `userAgent` | 从 UA 池按 seed 选择 |
| `platform` | 由 UA 中的操作系统推导 |
| `viewport` | 按 seed 从常见桌面分辨率选择，与平台一致 |
| `locale` | 从 locale 池按 seed 选择 |
| `timezoneId` | 与 `locale` 绑定 |
| `languages` | 与 `locale` 一致，如 `['en-GB', 'en']` |
| `deviceMemory` | 按 seed 从 `[4, 8, 16]` 选择 |
| `hardwareConcurrency` | 按 seed 从 `[4, 8, 12, 16]` 选择 |
| `colorDepth` | 固定 `24` |

#### 增强的 `stealthScript`

在现有脚本基础上扩展：

```js
() => {
  // 已有
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  window.chrome = { runtime: {} };
  const originalQuery = window.navigator.permissions.query;
  window.navigator.permissions.query = (parameters) =>
    parameters.name === 'notifications'
      ? Promise.resolve({ state: Notification.permission })
      : originalQuery(parameters);

  // 新增/增强（以下 profile.* 在生成 stealthScript 时会被序列化为具体值）
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
  Object.defineProperty(navigator, 'languages', { get: () => /* profile.languages JSON 序列化 */ });
  Object.defineProperty(navigator, 'platform', { get: () => /* profile.platform JSON 序列化 */ });
  Object.defineProperty(navigator, 'deviceMemory', { get: () => /* profile.deviceMemory JSON 序列化 */ });
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => /* profile.hardwareConcurrency JSON 序列化 */ });
  Object.defineProperty(screen, 'colorDepth', { get: () => /* profile.colorDepth JSON 序列化 */ });
  // outerWidth/outerHeight：在 viewport 高度基础上加上浏览器 UI 高度（约 85-135px，按平台取固定值）
};
```

### 2. 修改 `src/channel.js`

- 移除硬编码 `DEFAULT_USER_AGENT`。
- 构造函数接收 `nodeCode` 和 `stealthMode`。
- `_buildContextOptions()` 调用 `createProfile(...)` 生成 `userAgent`、`viewport`、`locale`、`timezoneId` 等。
- `getStealthScript()` 改为返回 `this.profile.stealthScript`。
- `recreateContext()` 在 `mode='session'` 时递增 `sessionIndex` 并重新生成 profile。

### 3. 修改 `src/service.js`

- 从 `this.config.nodeCode` 读取节点标识，默认 `crawler-01`。
- 创建 Channel 时传入 `nodeCode` 和 `stealthMode`。
- 启动日志增加：`[Node crawler-eu-01] Channel 1 profile=a1b2c3d4 uaHash=xxx`，其中 `uaHash` 为 `userAgent` 的 sha256 前 8 位。

### 4. 修改 `src/crawler.js`

- 独立运行模式使用 `createProfile({ nodeCode: os.hostname(), mode: config.stealthMode })`。
- `getStealthScript()` 改为使用 profile 生成的脚本。
- 保留 `--disable-blink-features=AutomationControlled` 等启动参数。

### 5. 修改 `src/page-crawler.js`

- 图片下载时的 `User-Agent` 从传入的 `userAgent` 获取，不再使用硬编码。

### 6. 配置项

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `CRAWLER_NODE_CODE` | `crawler-01` | 节点标识，已存在 |
| `CRAWLER_STEALTH_MODE` | `channel` | `fixed` / `channel` / `session` |
| `CRAWLER_USER_AGENT` | 空 | `fixed` 模式下强制使用的 UA；为空时回退到内置默认 UA |
| `CRAWLER_UA_POOL_PATH` | 内置 | 自定义 UA 池 JSON 路径 |
| `CRAWLER_LOCALES` | 内置 | 可选 locale/timezone 白名单，逗号分隔；未设置时使用内置列表 |

#### 模式说明

- `fixed`：完全回退到当前行为，使用 `CRAWLER_USER_AGENT` 或内置默认 UA。
- `channel`：按节点 + 通道生成稳定指纹，同一通道内会话复用。
- `session`：每次 `recreateContext` 都重新生成指纹，分散度最高，但不利问题定位。

### 7. 回滚策略

- **完全回滚**：设置 `CRAWLER_STEALTH_MODE=fixed` 并可选设置 `CRAWLER_USER_AGENT=旧UA`，即可恢复到当前行为。
- **部分回滚**：如果某个 UA/指纹导致失败率异常，可通过 `CRAWLER_UA_POOL_PATH` 快速剔除。
- **灰度发布**：先在一个节点启用 `channel` 模式，其余节点保持 `fixed`，观察 dataLayer 成功率和响应时间后再全量推广。

## 测试策略

### 单元测试

1. **`test/stealth-profile.test.js`**
   - 同一 `nodeCode + channelId` 两次调用返回相同 profile。
   - 不同 `channelId` 返回不同 `userAgent`。
   - `UA` 与 `platform`、`locale`、`timezoneId` 一致。
   - 内置 UA 池非空且格式合法。
   - `mode='session'` 时不同 `sessionIndex` 返回不同 UA。
   - `mode='fixed'` 时无论 seed 如何都返回固定 UA。

2. **`test/channel-profile.test.js`**
   - Channel 初始化后 `browserContext.options.userAgent` 来自 profile。
   - `recreateContext` 后若 `mode='session'` 则 UA 改变；若 `mode='channel'` 则 UA 不变。
   - `mode='fixed'` 时始终使用 `CRAWLER_USER_AGENT`。

3. **`test/stealth-script.test.js`**
   - 在真实 Playwright page 中执行 `addInitScript` 后，`navigator.webdriver === undefined`。
   - `navigator.languages` 与 profile 一致。
   - `navigator.platform` 与 profile 一致。

4. **`test/service-profile.test.js`**
   - Service 启动多个 Channel 时，每个 Channel 拿到不同 profile。
   - 日志中包含节点和 profile signature。

### 集成测试

- 在 1 个节点上跑小批量真实 SKU，对比 `fixed` vs `channel` 模式下的：
  - dataLayer 提取成功率
  - 页面 goto 失败率
  - 平均响应时间
- 连续运行至少 30 分钟，观察是否有异常上升。

## 监控

- 日志字段：新增 `nodeCode`、`channelId`、`profileSignature`、`uaHash`。
- 告警阈值：连续 N 个 SKU dataLayer 提取失败，或整体成功率较基线下降超过 X%。
- 保留一份固定 UA 基线数据，便于对比新模式效果。

## 风险与应对

| 风险 | 应对 |
|---|---|
| 动态 UA 与目标站期望不匹配导致失败率上升 | 提供 `fixed` 模式一键回滚；灰度发布；保留 UA 池白名单 |
| 自研 stealth 脚本覆盖不完整 | 优先解决 Header 聚类；后续可试点 `puppeteer-extra-plugin-stealth` 对比收益 |
| UA 池维护成本 | 内置常见 UA 足够长期运行；支持外部 JSON 热更新 |
| 同一节点指纹稳定后仍被标记 | 切换到 `session` 模式；或缩短 `pageRefreshAfterTasks` 周期 |

## 后续扩展

- **第二阶段试点**：在部分节点启用 `playwright-extra + puppeteer-extra-plugin-stealth`，与原生方案做 A/B 对比。
- **高级指纹对抗**：根据实际检测结果，可选加入 Canvas/WebGL 噪声。
- **UA 池自动更新**：定期从真实浏览器统计源更新 UA 池版本分布。
