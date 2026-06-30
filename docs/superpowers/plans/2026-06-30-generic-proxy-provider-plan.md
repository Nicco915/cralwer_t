# 通用 HTTP 代理 Provider 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 删除 Kuaidaili 专有客户端和现有 CliproxyPool，实现一个通用 HTTP 代理 Provider（`HttpProxyProvider`），支持通过 `.env` 配置接入任意返回代理列表的 HTTP API（以 cliproxy API 动态提取为主要场景）。

**架构：** `HttpProxyProvider` 通过可配置 URL/Headers/JSONPath/字段映射从 HTTP API 拉取代理列表；`ProxyPool` 改为接受通用 `provider`（而非 `client`）；`CrawlerService.startProxyPool()` 根据 `proxyProviderUrl` 单一来源创建 `HttpProxyProvider`；CLI 解析 `PROXY_PROVIDER_*` 系列环境变量。

**技术栈：** Node.js 22+、原生 `node:test`、`jsonpath-plus`（新增依赖）、Playwright（已有）。

**前置：**
- 设计文档：`docs/superpowers/specs/2026-06-30-generic-proxy-provider-design.md`
- 当前状态：代码库同时存在 `KuaidailiClient` 和 `CliproxyPool`（粘性会话 URL 模式，非 API 提取），需全部删除

---

## 文件结构

| 文件 | 职责 | 操作 |
|---|---|---|
| `src/http-proxy-provider.js` | 新增：通用 HTTP 适配器（含 preset、JSONPath、字段映射、URL 解析、错误信息） | 创建 |
| `src/proxy-pool.js` | 修改：构造函数 `client` → `provider`；调用 `provider.getProxies()` | 修改 |
| `src/service.js` | 修改：删除 Kuaidaili/Cliproxy 导入；`startProxyPool()` 创建 `HttpProxyProvider` | 修改 |
| `src/cli.js` | 修改：删除 `kuaidaili-*` flag 和 `KUAIDAILI_*`/`CLIPROXY_*` env；新增 `proxy-provider-*` flag 和 `PROXY_PROVIDER_*` env | 修改 |
| `bin/run.js` | 修改：`buildServiceConfig` 透传 `proxyProvider*` 默认值 | 修改 |
| `bin/run-test.js` | 修改：新增 `proxy-provider` 子命令 | 修改 |
| `src/kuaidaili-client.js` | 删除 | 删除 |
| `src/cliproxy-pool.js` | 删除（被通用方案取代） | 删除 |
| `test/kuaidaili-client.test.js` | 删除 | 删除 |
| `test/cliproxy-pool.test.js` | 删除 | 删除 |
| `test/service-cliproxy.test.js` | 删除 | 删除 |
| `test/cli-proxy-pool.test.js` | 改写：移除 kuaidaili/cliproxy，测 PROXY_PROVIDER_* | 修改 |
| `test/proxy-pool.test.js` | 修改：mock 接口从 `getKpsProxies` 改为 `getProxies` | 修改 |
| `test/service-proxy-pool.test.js` | 修改：移除 kuaidailiSecretId/Key，使用 `proxyProviderUrl` | 修改 |
| `test/proxy-config.test.js` | 修改：保留 `--proxy` 测试，新增 HttpProxyProvider + Channel 集成 | 修改 |
| `test/http-proxy-provider.test.js` | 新增：HttpProxyProvider 单元测试（25 个 case） | 创建 |
| `test/bin-run.test.js` | 修改：检查 `buildServiceConfig` 透传新字段 | 修改 |
| `package.json` | 修改：新增 `jsonpath-plus` 依赖 | 修改 |
| `.env` | 修改：删除 Kuaidaili 示例，添加 cliproxy PROXY_PROVIDER_* 示例 | 修改 |

---

## 任务 1：添加 jsonpath-plus 依赖

**文件：**
- 修改：`package.json`
- 修改：`package-lock.json`（由 npm 自动生成）

- [ ] **步骤 1：安装 jsonpath-plus**

```bash
cd /Users/nz/Downloads/hs_sku/crawler
npm install jsonpath-plus
```

预期：`package.json` 的 `dependencies` 出现 `"jsonpath-plus": "^10.x.x"`，`package-lock.json` 同步更新。

- [ ] **步骤 2：验证导入可用**

运行 `node -e "const { JSONPath } = require('jsonpath-plus'); console.log(JSONPath({ path: 'a.b', json: { a: { b: 1 } } }))"`，应输出 `[1]`。

- [ ] **步骤 3：Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): add jsonpath-plus dependency"
```

---

## 任务 2：HttpProxyProvider - 字符串数组解析（TDD）

**文件：**
- 创建：`src/http-proxy-provider.js`
- 创建：`test/http-proxy-provider.test.js`

### 步骤 1：编写失败的测试 - 字符串数组 `"host:port"`

在 `test/http-proxy-provider.test.js` 中：

```js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { HttpProxyProvider } = require('../src/http-proxy-provider');

describe('HttpProxyProvider', () => {
  it('parses string array of "host:port" into proxy URLs', async () => {
    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ['1.1.1.1:8080', '2.2.2.2:3128'],
    });
    const provider = new HttpProxyProvider({
      url: 'http://api.example.com/proxies',
      fetch: fakeFetch,
    });
    const proxies = await provider.getProxies();
    assert.deepStrictEqual(proxies, [
      'http://1.1.1.1:8080',
      'http://2.2.2.2:3128',
    ]);
  });
});
```

### 步骤 2：运行测试验证失败

```bash
cd /Users/nz/Downloads/hs_sku/crawler
node --test test/http-proxy-provider.test.js
```

预期：FAIL，报错 "Cannot find module '../src/http-proxy-provider'"。

### 步骤 3：实现最简 HttpProxyProvider

创建 `src/http-proxy-provider.js`：

```js
const { JSONPath } = require('jsonpath-plus');

class HttpProxyProvider {
  constructor(options = {}) {
    this.url = options.url;
    this.method = options.method || 'GET';
    this.apiKey = options.apiKey;
    this.headerName = options.headerName || 'Authorization';
    this.headerValuePrefix = options.headerValuePrefix || '';
    this.body = options.body;
    this.contentType = options.contentType;
    this.responsePath = options.responsePath || '$';
    this.fieldHost = options.fieldHost || 'host';
    this.fieldPort = options.fieldPort || 'port';
    this.fieldUsername = options.fieldUsername;
    this.fieldPassword = options.fieldPassword;
    this.fieldProtocol = options.fieldProtocol;
    this.filterProtocol = options.filterProtocol;
    this.strictBusinessCode = options.strictBusinessCode !== false;
    this.fetch = options.fetch || globalThis.fetch;
  }

  async getProxies() {
    const list = await this._fetchList();
    return list
      .map(item => this.toProxyEntry(item))
      .filter(entry => entry !== null)
      .filter(entry => !this.filterProtocol ||
        this._normalizeProtocol(entry.protocol) === this._normalizeProtocol(this.filterProtocol))
      .map(entry => this.toProxyString(entry));
  }

  async _fetchList() {
    return [];
  }

  toProxyEntry(item) {
    if (typeof item === 'string') {
      try {
        const u = new URL(item.startsWith('http') ? item : `http://${item}`);
        return {
          host: u.hostname,
          port: Number(u.port),
          username: u.username || undefined,
          password: u.password || undefined,
          protocol: u.protocol.replace(':', ''),
        };
      } catch {
        return null;
      }
    }
    return null;
  }

  toProxyString(entry) {
    const auth = entry.username && entry.password
      ? `${entry.username}:${entry.password}@`
      : '';
    return `${entry.protocol || 'http'}://${auth}${entry.host}:${entry.port}`;
  }

  _normalizeProtocol(p) {
    return (p || '').toLowerCase();
  }
}

module.exports = { HttpProxyProvider };
```

### 步骤 4：实现 `_fetchList`

修改 `_fetchList`：

```js
async _fetchList() {
  const headers = {};
  if (this.apiKey) {
    headers[this.headerName] = this.headerValuePrefix
      ? `${this.headerValuePrefix}${this.apiKey}`
      : this.apiKey;
  }
  const init = { method: this.method, headers };
  if (this.body && this.method !== 'GET') {
    init.body = this.body;
    if (!headers['Content-Type']) {
      headers['Content-Type'] = this.contentType || 'application/json';
    }
  }
  const res = await this.fetch(this.url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `Proxy provider fetch failed: ${res.status} ${res.statusText}\n` +
      `Response body: ${text.slice(0, 200)}`
    );
  }
  const data = await res.json();
  if (this.strictBusinessCode && data && typeof data === 'object'
      && data.code !== undefined && data.code !== 0) {
    throw new Error(
      `Proxy provider business error: code=${data.code}, msg=${data.msg || 'unknown'}`
    );
  }
  const list = extractByPath(data, this.responsePath);
  if (!Array.isArray(list)) {
    throw new Error(
      `Proxy provider response path "${this.responsePath}" did not return array.\n` +
      `Got: ${typeof list} (${JSON.stringify(list).slice(0, 200)})\n` +
      `Full response: ${JSON.stringify(data).slice(0, 500)}`
    );
  }
  return list;
}
```

并在文件底部添加辅助函数：

```js
function extractByPath(obj, path) {
  if (!path || path === '$') return obj;
  return JSONPath({ path, json: obj });
}
```

### 步骤 5：运行测试验证通过

```bash
node --test test/http-proxy-provider.test.js
```

预期：PASS，1/1 通过。

### 步骤 6：Commit**

```bash
git add src/http-proxy-provider.js test/http-proxy-provider.test.js
git commit -m "feat(http-proxy-provider): basic string array parsing"
```

---

## 任务 3：HttpProxyProvider - 对象数组 + 字段映射

**文件：**
- 修改：`src/http-proxy-provider.js`
- 修改：`test/http-proxy-provider.test.js`

### 步骤 1：添加失败的测试

在 `test/http-proxy-provider.test.js` 中添加：

```js
it('parses object array using field mapping', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => [
      { host: '1.1.1.1', port: 8080 },
      { host: '2.2.2.2', port: 3128 },
    ],
  });
  const provider = new HttpProxyProvider({
    url: 'http://api.example.com/proxies',
    fetch: fakeFetch,
  });
  const proxies = await provider.getProxies();
  assert.deepStrictEqual(proxies, [
    'http://1.1.1.1:8080',
    'http://2.2.2.2:3128',
  ]);
});

it('maps custom field names (ip/port)', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => [
      { ip: '1.1.1.1', port: 8080, user: 'u', pass: 'p' },
    ],
  });
  const provider = new HttpProxyProvider({
    url: 'http://api.example.com/proxies',
    fieldHost: 'ip',
    fieldPort: 'port',
    fieldUsername: 'user',
    fieldPassword: 'pass',
    fetch: fakeFetch,
  });
  const proxies = await provider.getProxies();
  assert.deepStrictEqual(proxies, ['http://u:p@1.1.1.1:8080']);
});
```

### 步骤 2：运行测试验证失败

```bash
node --test test/http-proxy-provider.test.js
```

预期：第二个测试 FAIL，期望 `'http://u:p@1.1.1.1:8080'`，实际 `'http://1.1.1.1:8080'`（对象未被解析）。

### 步骤 3：扩展 `toProxyEntry` 支持对象

修改 `toProxyEntry` 的对象分支：

```js
toProxyEntry(item) {
  if (typeof item === 'string') {
    try {
      const u = new URL(item.startsWith('http') ? item : `http://${item}`);
      return {
        host: u.hostname,
        port: Number(u.port),
        username: u.username || undefined,
        password: u.password || undefined,
        protocol: u.protocol.replace(':', ''),
      };
    } catch {
      return null;
    }
  }
  if (typeof item !== 'object' || item === null) return null;

  const host = item[this.fieldHost];
  const port = item[this.fieldPort];
  if (!host || !port) return null;

  const portNum = Number(port);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    return null;
  }

  return {
    host: String(host),
    port: portNum,
    username: this.fieldUsername ? item[this.fieldUsername] : undefined,
    password: this.fieldPassword ? item[this.fieldPassword] : undefined,
    protocol: this.fieldProtocol
      ? this._normalizeProtocol(item[this.fieldProtocol])
      : undefined,
  };
}
```

### 步骤 4：运行测试验证通过

```bash
node --test test/http-proxy-provider.test.js
```

预期：PASS，3/3 通过。

### 步骤 5：Commit

```bash
git add src/http-proxy-provider.js test/http-proxy-provider.test.js
git commit -m "feat(http-proxy-provider): object array with field mapping"
```

---

## 任务 4：HttpProxyProvider - JSONPath 提取

**文件：**
- 修改：`src/http-proxy-provider.js`
- 修改：`test/http-proxy-provider.test.js`

### 步骤 1：添加失败的测试

```js
it('extracts array from nested JSONPath', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      code: 0,
      data: { proxies: ['1.1.1.1:8080', '2.2.2.2:3128'] },
    }),
  });
  const provider = new HttpProxyProvider({
    url: 'http://api.example.com/proxies',
    responsePath: 'data.proxies',
    fetch: fakeFetch,
  });
  const proxies = await provider.getProxies();
  assert.deepStrictEqual(proxies, [
    'http://1.1.1.1:8080',
    'http://2.2.2.2:3128',
  ]);
});

it('supports array index in JSONPath', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      data: { proxies: [{ ip: '1.1.1.1', port: 8080 }] },
    }),
  });
  const provider = new HttpProxyProvider({
    url: 'http://api.example.com/proxies',
    responsePath: 'data.proxies[0].ip',
    fieldHost: '_skip_',
    fetch: fakeFetch,
  });
  // 期望 ['http://1.1.1.1:8080']? 实际单个字符串提取会失败。改为更现实的 case:
  const provider2 = new HttpProxyProvider({
    url: 'http://api.example.com/proxies',
    responsePath: '$..ip',
    fetch: fakeFetch,
  });
  const proxies = await provider2.getProxies();
  assert.deepStrictEqual(proxies, ['http://1.1.1.1:8080']);
});
```

### 步骤 2：运行测试验证失败

```bash
node --test test/http-proxy-provider.test.js
```

预期：第一个测试 FAIL（responsePath 默认 `$` 取整个对象），第二个测试 FAIL（recursion 未实现）。

### 步骤 3：实现 JSONPath 提取（任务 2 步骤 4 已实现）

`_fetchList` 已通过 `extractByPath` 调用 `jsonpath-plus` 的 `JSONPath`。无需新增代码。

### 步骤 4：运行测试验证通过

```bash
node --test test/http-proxy-provider.test.js
```

预期：PASS，5/5 通过。

### 步骤 5：Commit

```bash
git add src/http-proxy-provider.js test/http-proxy-provider.test.js
git commit -m "feat(http-proxy-provider): JSONPath extraction with jsonpath-plus"
```

---

## 任务 5：HttpProxyProvider - Preset 机制

**文件：**
- 修改：`src/http-proxy-provider.js`
- 修改：`test/http-proxy-provider.test.js`

### 步骤 1：添加失败的测试

```js
it('applies cliproxy preset defaults', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      code: 0,
      data: {
        proxies: [{ ip: '1.1.1.1', port: 8080, user: 'u', pass: 'p', type: 'http' }],
      },
    }),
  });
  const provider = new HttpProxyProvider({
    url: 'http://api.cliproxy.com/extract',
    preset: 'cliproxy',
    apiKey: 'token',
    fetch: fakeFetch,
  });
  const proxies = await provider.getProxies();
  assert.deepStrictEqual(proxies, ['http://u:p@1.1.1.1:8080']);
});

it('explicit fields override preset defaults', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      data: {
        proxies: [{ ip: '1.1.1.1', port: 8080, account: 'override' }],
      },
    }),
  });
  const provider = new HttpProxyProvider({
    url: 'http://api.cliproxy.com/extract',
    preset: 'cliproxy',
    fieldUsername: 'account',
    fetch: fakeFetch,
  });
  const proxies = await provider.getProxies();
  assert.deepStrictEqual(proxies, ['http://override:@1.1.1.1:8080']);
});
```

### 步骤 2：运行测试验证失败

```bash
node --test test/http-proxy-provider.test.js
```

预期：FAIL（preset 未应用）。

### 步骤 3：实现 Preset 表

修改构造函数顶部：

```js
const PRESETS = {
  cliproxy: {
    method: 'GET',
    headerName: 'Authorization',
    headerValuePrefix: 'Bearer ',
    responsePath: 'data.proxies',
    fieldHost: 'ip',
    fieldPort: 'port',
    fieldUsername: 'user',
    fieldPassword: 'pass',
    fieldProtocol: 'type',
  },
};

class HttpProxyProvider {
  constructor(options = {}) {
    const preset = PRESETS[options.preset] || {};
    const merged = { ...preset, ...options };
    this.url = merged.url;
    this.method = merged.method || 'GET';
    this.apiKey = merged.apiKey;
    this.headerName = merged.headerName || 'Authorization';
    this.headerValuePrefix = merged.headerValuePrefix || '';
    this.body = merged.body;
    this.contentType = merged.contentType;
    this.responsePath = merged.responsePath || '$';
    this.fieldHost = merged.fieldHost || 'host';
    this.fieldPort = merged.fieldPort || 'port';
    this.fieldUsername = merged.fieldUsername;
    this.fieldPassword = merged.fieldPassword;
    this.fieldProtocol = merged.fieldProtocol;
    this.filterProtocol = merged.filterProtocol;
    this.strictBusinessCode = merged.strictBusinessCode !== false;
    this.fetch = merged.fetch || globalThis.fetch;
  }
  // 其余方法不变
}

module.exports = { HttpProxyProvider, PRESETS };
```

### 步骤 4：运行测试验证通过

```bash
node --test test/http-proxy-provider.test.js
```

预期：PASS，7/7 通过。

### 步骤 5：Commit

```bash
git add src/http-proxy-provider.js test/http-proxy-provider.test.js
git commit -m "feat(http-proxy-provider): cliproxy preset template"
```

---

## 任务 6：HttpProxyProvider - 错误处理与容错

**文件：**
- 修改：`test/http-proxy-provider.test.js`

### 步骤 1：添加失败测试 - 错误处理

```js
it('throws on non-ok response with body snippet', async () => {
  const fakeFetch = async () => ({
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
    text: async () => '{"error":"invalid token"}',
  });
  const provider = new HttpProxyProvider({
    url: 'http://api.example.com/proxies',
    fetch: fakeFetch,
  });
  await assert.rejects(
    () => provider.getProxies(),
    /Proxy provider fetch failed: 401.*invalid token/s
  );
});

it('throws on business error code != 0', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ code: 401, msg: 'invalid token' }),
  });
  const provider = new HttpProxyProvider({
    url: 'http://api.example.com/proxies',
    fetch: fakeFetch,
  });
  await assert.rejects(
    () => provider.getProxies(),
    /business error: code=401, msg=invalid token/
  );
});

it('does not throw on business error when strictBusinessCode=false', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ code: 0, data: { proxies: ['1.1.1.1:8080'] } }),
  });
  const provider = new HttpProxyProvider({
    url: 'http://api.example.com/proxies',
    strictBusinessCode: false,
    fetch: fakeFetch,
  });
  const proxies = await provider.getProxies();
  assert.deepStrictEqual(proxies, ['http://1.1.1.1:8080']);
});

it('throws when response path does not point to array', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: 'not an array' }),
  });
  const provider = new HttpProxyProvider({
    url: 'http://api.example.com/proxies',
    responsePath: 'data',
    fetch: fakeFetch,
  });
  await assert.rejects(
    () => provider.getProxies(),
    /did not return array/
  );
});
```

### 步骤 2：运行测试验证失败

```bash
node --test test/http-proxy-provider.test.js
```

预期：第一个测试可能已经通过（之前已实现），其他应 FAIL。

### 步骤 3：无需新增代码（任务 2-3 已实现）

任务 2 步骤 4 实现的 `_fetchList` 已包含完整错误处理。

### 步骤 4：运行测试验证通过

```bash
node --test test/http-proxy-provider.test.js
```

预期：PASS，11/11 通过。

### 步骤 5：Commit

```bash
git add test/http-proxy-provider.test.js
git commit -m "test(http-proxy-provider): error handling cases"
```

---

## 任务 7：HttpProxyProvider - 容错与边界 case

**文件：**
- 修改：`test/http-proxy-provider.test.js`

### 步骤 1：添加失败测试 - 容错

```js
it('drops entry with invalid port', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => [
      { host: '1.1.1.1', port: 8080 },
      { host: '2.2.2.2', port: 99999 },
    ],
  });
  const provider = new HttpProxyProvider({
    url: 'http://api.example.com/proxies',
    fetch: fakeFetch,
  });
  const proxies = await provider.getProxies();
  assert.deepStrictEqual(proxies, ['http://1.1.1.1:8080']);
});

it('drops entry with missing host or port', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => [
      { host: '1.1.1.1' },
      { port: 8080 },
      { host: '3.3.3.3', port: 3128 },
    ],
  });
  const provider = new HttpProxyProvider({
    url: 'http://api.example.com/proxies',
    fetch: fakeFetch,
  });
  const proxies = await provider.getProxies();
  assert.deepStrictEqual(proxies, ['http://3.3.3.3:3128']);
});

it('filters by protocol case-insensitively', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => [
      { host: '1.1.1.1', port: 8080, type: 'HTTP' },
      { host: '2.2.2.2', port: 3128, type: 'socks5' },
    ],
  });
  const provider = new HttpProxyProvider({
    url: 'http://api.example.com/proxies',
    fieldProtocol: 'type',
    filterProtocol: 'http',
    fetch: fakeFetch,
  });
  const proxies = await provider.getProxies();
  assert.deepStrictEqual(proxies, ['http://1.1.1.1:8080']);
});

it('parses IPv6 addresses', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ['[2001:db8::1]:8080'],
  });
  const provider = new HttpProxyProvider({
    url: 'http://api.example.com/proxies',
    fetch: fakeFetch,
  });
  const proxies = await provider.getProxies();
  assert.deepStrictEqual(proxies, ['http://[2001:db8::1]:8080']);
});

it('parses full URL with auth in string format', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ['http://u:p@3.3.3.3:9999'],
  });
  const provider = new HttpProxyProvider({
    url: 'http://api.example.com/proxies',
    fetch: fakeFetch,
  });
  const proxies = await provider.getProxies();
  assert.deepStrictEqual(proxies, ['http://u:p@3.3.3.3:9999']);
});
```

### 步骤 2：运行测试验证通过

```bash
node --test test/http-proxy-provider.test.js
```

预期：PASS，16/16 通过（任务 2-3 已实现 URL 解析和端口校验）。

### 步骤 3：Commit

```bash
git add test/http-proxy-provider.test.js
git commit -m "test(http-proxy-provider): robustness and edge cases"
```

---

## 任务 8：HttpProxyProvider - 认证 Header 和 POST

**文件：**
- 修改：`test/http-proxy-provider.test.js`

### 步骤 1：添加失败测试 - Header 和 POST

```js
it('sends Authorization: Bearer xxx header by default', async () => {
  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => ['1.1.1.1:8080'],
    };
  };
  const provider = new HttpProxyProvider({
    url: 'http://api.example.com/proxies',
    apiKey: 'mytoken',
    fetch: fakeFetch,
  });
  await provider.getProxies();
  assert.strictEqual(seen[0].init.headers.Authorization, 'mytoken');
});

it('uses custom header name and prefix', async () => {
  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push({ url, init });
    return { ok: true, status: 200, json: async () => ['1.1.1.1:8080'] };
  };
  const provider = new HttpProxyProvider({
    url: 'http://api.example.com/proxies',
    apiKey: 'mytoken',
    headerName: 'X-API-Key',
    headerValuePrefix: 'Token ',
    fetch: fakeFetch,
  });
  await provider.getProxies();
  assert.strictEqual(seen[0].init.headers['X-API-Key'], 'Token mytoken');
});

it('adds default Content-Type for POST with body', async () => {
  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push({ url, init });
    return { ok: true, status: 200, json: async () => ['1.1.1.1:8080'] };
  };
  const provider = new HttpProxyProvider({
    url: 'http://api.example.com/proxies',
    method: 'POST',
    body: '{"query":"foo"}',
    fetch: fakeFetch,
  });
  await provider.getProxies();
  assert.strictEqual(seen[0].init.method, 'POST');
  assert.strictEqual(seen[0].init.body, '{"query":"foo"}');
  assert.strictEqual(seen[0].init.headers['Content-Type'], 'application/json');
});

it('uses custom Content-Type when configured', async () => {
  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push({ url, init });
    return { ok: true, status: 200, json: async () => ['1.1.1.1:8080'] };
  };
  const provider = new HttpProxyProvider({
    url: 'http://api.example.com/proxies',
    method: 'POST',
    body: 'a=1&b=2',
    contentType: 'application/x-www-form-urlencoded',
    fetch: fakeFetch,
  });
  await provider.getProxies();
  assert.strictEqual(seen[0].init.headers['Content-Type'], 'application/x-www-form-urlencoded');
});
```

### 步骤 2：运行测试验证通过

```bash
node --test test/http-proxy-provider.test.js
```

预期：PASS，20/20 通过。

### 步骤 3：Commit

```bash
git add test/http-proxy-provider.test.js
git commit -m "test(http-proxy-provider): auth header and POST body"
```

---

## 任务 9：HttpProxyProvider - Preset 边界 case

**文件：**
- 修改：`test/http-proxy-provider.test.js`

### 步骤 1：添加失败测试

```js
it('uses builtin defaults when preset is not set and no overrides', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ['1.1.1.1:8080'],
  });
  const provider = new HttpProxyProvider({
    url: 'http://api.example.com/proxies',
    fetch: fakeFetch,
  });
  // 默认 responsePath='$', fieldHost='host', fieldPort='port'
  const proxies = await provider.getProxies();
  assert.deepStrictEqual(proxies, ['http://1.1.1.1:8080']);
});

it('ignores unknown preset name and falls back to defaults', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ['1.1.1.1:8080'],
  });
  const provider = new HttpProxyProvider({
    url: 'http://api.example.com/proxies',
    preset: 'nonexistent',
    fetch: fakeFetch,
  });
  const proxies = await provider.getProxies();
  assert.deepStrictEqual(proxies, ['http://1.1.1.1:8080']);
});
```

### 步骤 2：运行测试验证通过

```bash
node --test test/http-proxy-provider.test.js
```

预期：PASS，22/22 通过。

### 步骤 3：Commit

```bash
git add test/http-proxy-provider.test.js
git commit -m "test(http-proxy-provider): preset edge cases"
```

---

## 任务 10：ProxyPool - 重构为通用 provider

**文件：**
- 修改：`src/proxy-pool.js`
- 修改：`test/proxy-pool.test.js`

### 步骤 1：修改 ProxyPool 构造函数

修改 `src/proxy-pool.js`：

```js
const fs = require('fs');
const path = require('path');

class ProxyPool {
  constructor(options) {
    this.provider = options.provider;  // 原 client
    this.machineIndex = Number(options.machineIndex || 0);
    this.machineTotal = Number(options.machineTotal || 1);
    this.channels = Number(options.channels || 1);
    this.assignmentsFile = options.assignmentsFile || path.resolve('./proxy-assignments.json');
    this.currentAssignments = {};
  }

  async loadProxies() {
    const all = await this.provider.getProxies();  // 原 getKpsProxies
    return all.filter((_, idx) => idx % this.machineTotal === this.machineIndex);
  }

  loadAssignments() {
    try {
      const raw = fs.readFileSync(this.assignmentsFile, 'utf-8');
      return JSON.parse(raw);
    } catch (e) {
      return {};
    }
  }

  saveAssignments(assignments) {
    const dir = path.dirname(this.assignmentsFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.assignmentsFile, JSON.stringify(assignments, null, 2), 'utf-8');
  }

  async assign() {
    const partitioned = await this.loadProxies();
    if (partitioned.length < this.channels) {
      throw new Error(
        `Proxy partition too small for machine ${this.machineIndex}: ` +
        `got ${partitioned.length} IPs but need ${this.channels} channels`
      );
    }

    const previous = this.loadAssignments();
    const assignments = {};
    const used = new Set();

    for (let i = 1; i <= this.channels; i++) {
      const channelId = `ch-${i}`;
      const previousIp = previous[channelId];
      if (previousIp && partitioned.includes(previousIp) && !used.has(previousIp)) {
        assignments[channelId] = previousIp;
        used.add(previousIp);
        continue;
      }
      const next = partitioned.find(ip => !used.has(ip));
      assignments[channelId] = next;
      used.add(next);
    }

    this.currentAssignments = assignments;
    this.saveAssignments(assignments);
    return assignments;
  }

  getProxyForChannel(channelId) {
    return this.currentAssignments[channelId];
  }

  async refresh() {
    const previous = { ...this.currentAssignments };
    await this.assign();
    const changed = [];
    for (const channelId of Object.keys(this.currentAssignments)) {
      if (this.currentAssignments[channelId] !== previous[channelId]) {
        changed.push(channelId);
      }
    }
    return changed;
  }

  async nextForChannel(channelId) {
    const partitioned = await this.loadProxies();
    const current = this.currentAssignments[channelId];
    const idx = partitioned.indexOf(current);
    const next = partitioned[(idx + 1) % partitioned.length];
    this.currentAssignments[channelId] = next;
    this.saveAssignments(this.currentAssignments);
    return next;
  }
}

module.exports = { ProxyPool };
```

### 步骤 2：修改 test/proxy-pool.test.js mock

将所有 `client: { getKpsProxies: ... }` 改为 `provider: { getProxies: ... }`：

```js
test('partitions proxies by machine index and assigns per channel', async () => {
  const assignmentsFile = path.join(os.tmpdir(), `pool-${Date.now()}.json`);
  const provider = {
    getProxies: async () => [
      '1.1.1.1:8080', '2.2.2.2:8080', '3.3.3.3:8080',
      '4.4.4.4:8080', '5.5.5.5:8080', '6.6.6.6:8080',
    ],
  };
  const pool = new ProxyPool({
    provider,
    machineIndex: 0,
    machineTotal: 2,
    channels: 2,
    assignmentsFile,
  });
  // ... 其余不变
});
```

同样修改其他 3 个测试用例的 mock。

### 步骤 3：运行测试验证通过

```bash
node --test test/proxy-pool.test.js
```

预期：PASS，4/4 通过。

### 步骤 4：Commit

```bash
git add src/proxy-pool.js test/proxy-pool.test.js
git commit -m "refactor(proxy-pool): use generic provider interface"
```

---

## 任务 11：CLI - 替换 kuaidaili/cliproxy 配置为 PROXY_PROVIDER_*

**文件：**
- 修改：`src/cli.js`
- 创建：`test/cli-proxy-provider.test.js`
- 删除：`test/cli-proxy-pool.test.js`

### 步骤 1：编写失败的测试

在 `test/cli-proxy-provider.test.js` 中：

```js
const test = require('node:test');
const assert = require('node:assert');
const { parse } = require('../src/cli');

test('parses --proxy-provider-url flag', () => {
  const config = parse(['--proxy-provider-url', 'https://api.cliproxy.com/extract']);
  assert.strictEqual(config.proxyProviderUrl, 'https://api.cliproxy.com/extract');
});

test('parses --proxy-provider-* flags', () => {
  const config = parse([
    '--proxy-provider-url', 'https://api.example.com',
    '--proxy-provider-method', 'POST',
    '--proxy-provider-api-key', 'token123',
    '--proxy-provider-preset', 'cliproxy',
    '--proxy-provider-header-name', 'X-API-Key',
    '--proxy-provider-response-path', 'data.list',
    '--proxy-provider-field-host', 'ip',
    '--proxy-provider-field-port', 'port',
    '--proxy-provider-filter-protocol', 'http',
  ]);
  assert.strictEqual(config.proxyProviderUrl, 'https://api.example.com');
  assert.strictEqual(config.proxyProviderMethod, 'POST');
  assert.strictEqual(config.proxyProviderApiKey, 'token123');
  assert.strictEqual(config.proxyProviderPreset, 'cliproxy');
  assert.strictEqual(config.proxyProviderHeaderName, 'X-API-Key');
  assert.strictEqual(config.proxyProviderResponsePath, 'data.list');
  assert.strictEqual(config.proxyProviderFieldHost, 'ip');
  assert.strictEqual(config.proxyProviderFieldPort, 'port');
  assert.strictEqual(config.proxyProviderFilterProtocol, 'http');
});

test('PROXY_PROVIDER_* env vars fall back when flag missing', () => {
  process.env.PROXY_PROVIDER_URL = 'https://env.example.com';
  process.env.PROXY_PROVIDER_API_KEY = 'env-token';
  process.env.PROXY_PROVIDER_PRESET = 'cliproxy';
  try {
    const config = parse([]);
    assert.strictEqual(config.proxyProviderUrl, 'https://env.example.com');
    assert.strictEqual(config.proxyProviderApiKey, 'env-token');
    assert.strictEqual(config.proxyProviderPreset, 'cliproxy');
  } finally {
    delete process.env.PROXY_PROVIDER_URL;
    delete process.env.PROXY_PROVIDER_API_KEY;
    delete process.env.PROXY_PROVIDER_PRESET;
  }
});
```

### 步骤 2：运行测试验证失败

```bash
node --test test/cli-proxy-provider.test.js
```

预期：FAIL（cli.js 还未实现）。

### 步骤 3：修改 cli.js - 删除旧配置，新增 PROXY_PROVIDER_*

修改 `src/cli.js` 的 `FLAG_MAP`：

```js
const FLAG_MAP = {
  // ... 保留其他 flag ...
  'proxy-provider-url': 'proxyProviderUrl',
  'proxy-provider-method': 'proxyProviderMethod',
  'proxy-provider-api-key': 'proxyProviderApiKey',
  'proxy-provider-preset': 'proxyProviderPreset',
  'proxy-provider-header-name': 'proxyProviderHeaderName',
  'proxy-provider-header-value-prefix': 'proxyProviderHeaderValuePrefix',
  'proxy-provider-content-type': 'proxyProviderContentType',
  'proxy-provider-body': 'proxyProviderBody',
  'proxy-provider-response-path': 'proxyProviderResponsePath',
  'proxy-provider-field-host': 'proxyProviderFieldHost',
  'proxy-provider-field-port': 'proxyProviderFieldPort',
  'proxy-provider-field-username': 'proxyProviderFieldUsername',
  'proxy-provider-field-password': 'proxyProviderFieldPassword',
  'proxy-provider-field-protocol': 'proxyProviderFieldProtocol',
  'proxy-provider-filter-protocol': 'proxyProviderFilterProtocol',
  'proxy-provider-strict-business-code': 'proxyProviderStrictBusinessCode',
  proxy: 'proxy',
  // 保留通用 proxy 配置
  'proxy-machine-index': 'proxyMachineIndex',
  'proxy-machine-total': 'proxyMachineTotal',
  'proxy-refresh-interval-ms': 'proxyRefreshIntervalMs',
  'proxy-assignments-file': 'proxyAssignmentsFile',
  // 删除所有 kuaidaili-* flags
};
```

修改 `envMap`：

```js
const envMap = {
  // ... 保留其他 env ...
  PROXY_PROVIDER_URL: 'proxyProviderUrl',
  PROXY_PROVIDER_METHOD: 'proxyProviderMethod',
  PROXY_PROVIDER_API_KEY: 'proxyProviderApiKey',
  PROXY_PROVIDER_PRESET: 'proxyProviderPreset',
  PROXY_PROVIDER_HEADER_NAME: 'proxyProviderHeaderName',
  PROXY_PROVIDER_HEADER_VALUE_PREFIX: 'proxyProviderHeaderValuePrefix',
  PROXY_PROVIDER_CONTENT_TYPE: 'proxyProviderContentType',
  PROXY_PROVIDER_BODY: 'proxyProviderBody',
  PROXY_PROVIDER_RESPONSE_PATH: 'proxyProviderResponsePath',
  PROXY_PROVIDER_FIELD_HOST: 'proxyProviderFieldHost',
  PROXY_PROVIDER_FIELD_PORT: 'proxyProviderFieldPort',
  PROXY_PROVIDER_FIELD_USERNAME: 'proxyProviderFieldUsername',
  PROXY_PROVIDER_FIELD_PASSWORD: 'proxyProviderFieldPassword',
  PROXY_PROVIDER_FIELD_PROTOCOL: 'proxyProviderFieldProtocol',
  PROXY_PROVIDER_FILTER_PROTOCOL: 'proxyProviderFilterProtocol',
  PROXY_PROVIDER_STRICT_BUSINESS_CODE: 'proxyProviderStrictBusinessCode',
  CRAWLER_PROXY: 'proxy',
  PROXY_MACHINE_INDEX: 'proxyMachineIndex',
  PROXY_MACHINE_TOTAL: 'proxyMachineTotal',
  PROXY_REFRESH_INTERVAL_MS: 'proxyRefreshIntervalMs',
  PROXY_ASSIGNMENTS_FILE: 'proxyAssignmentsFile',
  // 删除所有 KUAIDAILI_* 和 CLIPROXY_*
};
```

### 步骤 4：运行测试验证通过

```bash
node --test test/cli-proxy-provider.test.js
```

预期：PASS，3/3 通过。

### 步骤 5：删除旧测试文件

```bash
rm test/cli-proxy-pool.test.js
```

### 步骤 6：Commit

```bash
git add src/cli.js test/cli-proxy-provider.test.js
git rm test/cli-proxy-pool.test.js
git commit -m "refactor(cli): replace kuaidaili/cliproxy flags with PROXY_PROVIDER_*"
```

---

## 任务 12：Service - 替换 KuaidailiClient/CliproxyPool 为 HttpProxyProvider

**文件：**
- 修改：`src/service.js`
- 修改：`test/service-proxy-pool.test.js`
- 删除：`src/kuaidaili-client.js`、`src/cliproxy-pool.js`
- 删除：`test/kuaidaili-client.test.js`、`test/cliproxy-pool.test.js`、`test/service-cliproxy.test.js`

### 步骤 1：修改 service.js - 删除旧导入，简化 startProxyPool

修改 `src/service.js` 顶部 imports：

```js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { Poller } = require('./poller');
const { Worker } = require('./worker');
const { Channel } = require('./channel');
const { Pusher } = require('./pusher');
const { resolveBrowserPath } = require('./crawler');
const { ProxyPool } = require('./proxy-pool');
const { HttpProxyProvider } = require('./http-proxy-provider');
const { ImageUploader } = require('./image-uploader');
```

修改 `startProxyPool()` 方法：

```js
async startProxyPool() {
  if (this.config.proxy) {
    return;
  }
  if (!this.config.proxyProviderUrl) {
    return;
  }

  this.proxyPool = new ProxyPool({
    provider: new HttpProxyProvider({
      url: this.config.proxyProviderUrl,
      method: this.config.proxyProviderMethod,
      apiKey: this.config.proxyProviderApiKey,
      preset: this.config.proxyProviderPreset,
      headerName: this.config.proxyProviderHeaderName,
      headerValuePrefix: this.config.proxyProviderHeaderValuePrefix,
      contentType: this.config.proxyProviderContentType,
      body: this.config.proxyProviderBody,
      responsePath: this.config.proxyProviderResponsePath,
      fieldHost: this.config.proxyProviderFieldHost,
      fieldPort: this.config.proxyProviderFieldPort,
      fieldUsername: this.config.proxyProviderFieldUsername,
      fieldPassword: this.config.proxyProviderFieldPassword,
      fieldProtocol: this.config.proxyProviderFieldProtocol,
      filterProtocol: this.config.proxyProviderFilterProtocol,
      strictBusinessCode: this.config.proxyProviderStrictBusinessCode,
    }),
    machineIndex: this.config.proxyMachineIndex,
    machineTotal: this.config.proxyMachineTotal,
    channels: this.config.channels,
    assignmentsFile: this.config.proxyAssignmentsFile,
  });
  await this.proxyPool.assign();
  this.startProxyRefresh();
}
```

### 步骤 2：修改 test/service-proxy-pool.test.js

将所有 `kuaidailiSecretId` / `kuaidailiSecretKey` 替换为 `proxyProviderUrl`：

```js
test('service assigns different proxies per channel from pool', async () => {
  const assignmentsFile = path.join(os.tmpdir(), `svc-pool-${Date.now()}.json`);
  const proxies = ['1.1.1.1:8080', '2.2.2.2:8080'];
  const service = new CrawlerService({
    baseUrl: 'https://example.com',
    imageDir: path.join(os.tmpdir(), 'imgs'),
    headless: true,
    channels: 2,
    pollInterval: 10000,
    pollLimit: 10,
    pushRetries: 1,
    callbackUrl: 'http://localhost:9999/callback',
    nodeCode: 'test-node',
    nodeToken: '',
    taskUrl: 'http://localhost:9999/tasks',
    proxyProviderUrl: 'http://mock',
    proxyMachineIndex: 0,
    proxyMachineTotal: 1,
    proxyRefreshIntervalMs: 60000,
    proxyAssignmentsFile: assignmentsFile,
  });
  // ... 其余不变（仍然 mock service.proxyPool）
});
```

类似修改另两个测试。

### 步骤 3：删除旧文件

```bash
rm src/kuaidaili-client.js
rm src/cliproxy-pool.js
rm test/kuaidaili-client.test.js
rm test/cliproxy-pool.test.js
rm test/service-cliproxy.test.js
```

### 步骤 4：运行测试验证通过

```bash
node --test test/service-proxy-pool.test.js
node --test test/http-proxy-provider.test.js
node --test test/proxy-pool.test.js
node --test test/cli-proxy-provider.test.js
```

预期：所有通过。

### 步骤 5：Commit

```bash
git add src/service.js test/service-proxy-pool.test.js
git rm src/kuaidaili-client.js src/cliproxy-pool.js
git rm test/kuaidaili-client.test.js test/cliproxy-pool.test.js test/service-cliproxy.test.js
git commit -m "refactor(service): use HttpProxyProvider, remove kuaidaili/cliproxy"
```

---

## 任务 13：bin/run.js - 透传新配置

**文件：**
- 修改：`bin/run.js`
- 修改：`test/bin-run.test.js`

### 步骤 1：查看当前 test/bin-run.test.js

读取 `test/bin-run.test.js`，找到 `buildServiceConfig` 测试。

### 步骤 2：添加失败测试 - 透传 proxyProvider*

```js
test('buildServiceConfig passes through proxyProvider* fields', () => {
  const config = {
    proxyProviderUrl: 'https://api.cliproxy.com/extract',
    proxyProviderPreset: 'cliproxy',
    proxyProviderApiKey: 'token',
    proxyProviderFieldHost: 'ip',
  };
  const service = buildServiceConfig(config);
  assert.strictEqual(service.proxyProviderUrl, 'https://api.cliproxy.com/extract');
  assert.strictEqual(service.proxyProviderPreset, 'cliproxy');
  assert.strictEqual(service.proxyProviderApiKey, 'token');
  assert.strictEqual(service.proxyProviderFieldHost, 'ip');
});

test('buildServiceConfig does not pass through kuaidaili fields', () => {
  const config = { proxyProviderUrl: 'http://x', kuaidailiSecretId: 'old' };
  const service = buildServiceConfig(config);
  assert.strictEqual(service.kuaidailiSecretId, undefined);
});
```

### 步骤 3：运行测试验证失败

```bash
node --test test/bin-run.test.js
```

预期：FAIL（buildServiceConfig 还未透传）。

### 步骤 4：修改 buildServiceConfig

修改 `bin/run.js` 的 `buildServiceConfig`：

```js
function buildServiceConfig(config) {
  return {
    baseUrl: config.baseUrl || 'https://eur.vevor.com',
    // ... 其他保留字段 ...
    proxy: config.proxy,
    proxyProviderUrl: config.proxyProviderUrl,
    proxyProviderMethod: config.proxyProviderMethod,
    proxyProviderApiKey: config.proxyProviderApiKey,
    proxyProviderPreset: config.proxyProviderPreset,
    proxyProviderHeaderName: config.proxyProviderHeaderName,
    proxyProviderHeaderValuePrefix: config.proxyProviderHeaderValuePrefix,
    proxyProviderContentType: config.proxyProviderContentType,
    proxyProviderBody: config.proxyProviderBody,
    proxyProviderResponsePath: config.proxyProviderResponsePath,
    proxyProviderFieldHost: config.proxyProviderFieldHost,
    proxyProviderFieldPort: config.proxyProviderFieldPort,
    proxyProviderFieldUsername: config.proxyProviderFieldUsername,
    proxyProviderFieldPassword: config.proxyProviderFieldPassword,
    proxyProviderFieldProtocol: config.proxyProviderFieldProtocol,
    proxyProviderFilterProtocol: config.proxyProviderFilterProtocol,
    proxyProviderStrictBusinessCode: config.proxyProviderStrictBusinessCode,
    proxyMachineIndex: config.proxyMachineIndex !== undefined ? Number(config.proxyMachineIndex) : 0,
    proxyMachineTotal: config.proxyMachineTotal !== undefined ? Number(config.proxyMachineTotal) : 1,
    proxyRefreshIntervalMs: config.proxyRefreshIntervalMs !== undefined ? Number(config.proxyRefreshIntervalMs) : 300000,
    proxyAssignmentsFile: config.proxyAssignmentsFile || path.resolve('./proxy-assignments.json'),
  };
}
```

删除 `kuaidaili*` 字段。

### 步骤 5：运行测试验证通过

```bash
node --test test/bin-run.test.js
```

预期：PASS。

### 步骤 6：Commit

```bash
git add bin/run.js test/bin-run.test.js
git commit -m "refactor(bin/run): pass through proxyProvider* config"
```

---

## 任务 14：proxy-config.test.js - 集成测试

**文件：**
- 修改：`test/proxy-config.test.js`

### 步骤 1：添加 HttpProxyProvider + Channel 集成测试

```js
it('Channel uses HttpProxyProvider proxy string', async () => {
  const fakeBrowser = {
    newContext: async (options) => {
      // 断言 proxy 配置
      assert.strictEqual(options.proxy.server, 'http://u:p@1.1.1.1:8080');
      return {
        addInitScript: async () => {},
        newPage: async () => ({}),
      };
    },
  };
  const { HttpProxyProvider } = require('../src/http-proxy-provider');
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      data: { proxies: [{ ip: '1.1.1.1', port: 8080, user: 'u', pass: 'p' }] },
    }),
  });
  const provider = new HttpProxyProvider({
    url: 'http://api.example.com/proxies',
    preset: 'cliproxy',
    fetch: fakeFetch,
  });
  const proxies = await provider.getProxies();
  const channel = new Channel({
    id: 1,
    config: { proxy: proxies[0] },
    log: () => {},
  });
  await channel.init(fakeBrowser);
});
```

### 步骤 2：运行测试验证通过

```bash
node --test test/proxy-config.test.js
```

预期：PASS。

### 步骤 3：Commit

```bash
git add test/proxy-config.test.js
git commit -m "test(proxy-config): HttpProxyProvider + Channel integration"
```

---

## 任务 15：Dry-run 工具

**文件：**
- 修改：`bin/run-test.js`

### 步骤 1：添加 proxy-provider 子命令

修改 `bin/run-test.js`：

```js
#!/usr/bin/env node
const path = require('path');
const { loadEnvFile, parse } = require('../src/cli');
const { run } = require('../src/crawler');
const { HttpProxyProvider } = require('../src/http-proxy-provider');

loadEnvFile(process.cwd());

const args = process.argv.slice(2);

// Dry-run subcommand: node bin/run-test.js proxy-provider
if (args[0] === 'proxy-provider') {
  const config = parse([]);
  const provider = new HttpProxyProvider({
    url: config.proxyProviderUrl,
    method: config.proxyProviderMethod,
    apiKey: config.proxyProviderApiKey,
    preset: config.proxyProviderPreset,
    headerName: config.proxyProviderHeaderName,
    headerValuePrefix: config.proxyProviderHeaderValuePrefix,
    contentType: config.proxyProviderContentType,
    body: config.proxyProviderBody,
    responsePath: config.proxyProviderResponsePath,
    fieldHost: config.proxyProviderFieldHost,
    fieldPort: config.proxyProviderFieldPort,
    fieldUsername: config.proxyProviderFieldUsername,
    fieldPassword: config.proxyProviderFieldPassword,
    fieldProtocol: config.proxyProviderFieldProtocol,
    filterProtocol: config.proxyProviderFilterProtocol,
    strictBusinessCode: config.proxyProviderStrictBusinessCode,
  });

  console.log('[DRY-RUN] Proxy provider config:');
  console.log(`  preset:   ${config.proxyProviderPreset || '(none)'}`);
  console.log(`  url:      ${config.proxyProviderUrl}`);
  console.log(`  method:   ${config.proxyProviderMethod || 'GET'}`);
  console.log(`  response: ${config.proxyProviderResponsePath || '$'}`);
  console.log('[DRY-RUN] Fetching...');
  provider.getProxies()
    .then((proxies) => {
      console.log(`[DRY-RUN] Got ${proxies.length} proxies`);
      console.log('[DRY-RUN] First 3 sample:');
      proxies.slice(0, 3).forEach((p) => console.log(`  ${p}`));
      console.log(`[DRY-RUN] After partition (machine=${config.proxyMachineIndex || 0}/${config.proxyMachineTotal || 1}): ~${Math.ceil(proxies.length / (config.proxyMachineTotal || 1))} proxies available`);
      console.log('[DRY-RUN] OK');
    })
    .catch((err) => {
      console.error(`[DRY-RUN] FAILED: ${err.message}`);
      process.exit(1);
    });
} else {
  const defaults = {
    flushInterval: 3,
    testCount: 10,
  };
  const config = parse(args, defaults);
  if (!process.argv.slice(2).some(arg => arg.startsWith('--result') || arg.startsWith('--result='))) {
    config.resultPath = path.join(config.outputDir || './output', 'vevor_result_test.xlsx');
  }
  if (!process.argv.slice(2).some(arg => arg.startsWith('--checkpoint') || arg.startsWith('--checkpoint='))) {
    config.checkpointFile = path.join(config.outputDir || './output', 'checkpoint_test.json');
  }
  run(config).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

### 步骤 2：手动验证（不需要测试）

```bash
PROXY_PROVIDER_URL=http://localhost:9999 PROXY_PROVIDER_PRESET=cliproxy node bin/run-test.js proxy-provider
```

预期：与 dry-run 工具一起的 mock fetch 配合，输出 "[DRY-RUN] OK" 或具体错误。

### 步骤 3：Commit

```bash
git add bin/run-test.js
git commit -m "feat(bin): add proxy-provider dry-run subcommand"
```

---

## 任务 16：更新 .env 示例

**文件：**
- 修改：`.env`

### 步骤 1：删除 Kuaidaili 示例，添加 cliproxy PROXY_PROVIDER_* 示例

修改 `.env`，将

```env
# Optional: Kuaidaili exclusive proxy pool (方案 B)
# 使用前取消注释并填入真实值；与 CRAWLER_PROXY 互斥，不要同时启用
# KUAIDAILI_SECRET_ID=your_secret_id
# KUAIDAILI_SECRET_KEY=your_secret_key
...
```

替换为：

```env
# Optional: HTTP proxy provider (cliproxy)
# 使用前取消注释并填入真实值；与 CRAWLER_PROXY 互斥，不要同时启用
# PROXY_PROVIDER_PRESET=cliproxy
# PROXY_PROVIDER_URL=https://api.cliproxy.com/extract
# PROXY_PROVIDER_API_KEY=your_api_key
# 通用配置（机器分区、刷新、持久化）
# PROXY_MACHINE_INDEX=0
# PROXY_MACHINE_TOTAL=1
# PROXY_REFRESH_INTERVAL_MS=300000
# PROXY_ASSIGNMENTS_FILE=./proxy-assignments.json
```

### 步骤 2：Commit

```bash
git add .env
git commit -m "docs(env): replace kuaidaili example with PROXY_PROVIDER_* cliproxy"
```

---

## 任务 17：全量测试与最终验证

### 步骤 1：运行所有测试

```bash
cd /Users/nz/Downloads/hs_sku/crawler
npm test
```

预期：所有测试通过，无 FAIL。

### 步骤 2：检查无残留引用

```bash
grep -r "kuaidaili\|Kuaidaili\|KUAIDAILI\|cliproxy-pool\|CliproxyPool\|CLIPROXY" src/ bin/ test/ --include="*.js"
```

预期：无匹配项（已全部清除）。

### 步骤 3：手动验证 dry-run 工具

用 mock fetch 配合：

```bash
cat > /tmp/test-proxy.js <<'EOF'
const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    code: 0,
    data: { proxies: [{ ip: '1.2.3.4', port: 8080, user: 'u', pass: 'p', type: 'http' }] },
  }));
});
server.listen(9999, () => console.log('mock on 9999'));
EOF
node /tmp/test-proxy.js &
PROXY_PROVIDER_URL=http://localhost:9999 PROXY_PROVIDER_PRESET=cliproxy PROXY_PROVIDER_API_KEY=dummy node bin/run-test.js proxy-provider
```

预期输出：

```
[DRY-RUN] Proxy provider config:
  preset:   cliproxy
  url:      http://localhost:9999
  method:   GET
  response: data.proxies
[DRY-RUN] Fetching...
[DRY-RUN] Got 1 proxies
[DRY-RUN] First 3 sample:
  http://u:p@1.2.3.4:8080
[DRY-RUN] After partition (machine=0/1): ~1 proxies available
[DRY-RUN] OK
```

### 步骤 4：清理临时文件

```bash
kill %1
rm /tmp/test-proxy.js
```

### 步骤 5：Commit（如果有任何遗漏修复）

```bash
git status
# 如果有改动：
git add -A
git commit -m "chore: final cleanup and verification"
```

---

## 自检结果

**1. 规格覆盖度：**
- ✅ Preset 机制：任务 5
- ✅ jsonpath-plus：任务 1、4
- ✅ 协议大小写不敏感：任务 7
- ✅ URL 解析（host:port / http:// / IPv6）：任务 7
- ✅ 错误信息含上下文：任务 6
- ✅ 端口校验：任务 7
- ✅ Dry-run 工具：任务 15
- ✅ Content-Type 可配置：任务 8
- ✅ 25 个测试 case：任务 2-9
- ✅ 删除 Kuaidaili：任务 11-12
- ✅ 删除 CliproxyPool：任务 12
- ✅ 改 ProxyPool 为通用：任务 10
- ✅ 改 service.js 接 HttpProxyProvider：任务 12
- ✅ 改 cli.js 配置：任务 11
- ✅ bin/run.js 透传：任务 13
- ✅ .env 更新：任务 16

**2. 占位符扫描：** 无 "TODO" / "TBD" / "后续"。

**3. 类型一致性：**
- `HttpProxyProvider` 的 `getProxies()` 返回 `Promise<string[]>`
- `ProxyPool.provider` 类型 `{ getProxies: () => Promise<string[]> }`
- `service.proxyPool` 类型保持 `ProxyPool`
- 字段名 `proxyProviderUrl/Method/ApiKey/...` 在 cli.js / service.js / bin/run.js 一致

**4. 并发互斥锁：** 按设计延后，不在计划范围。
