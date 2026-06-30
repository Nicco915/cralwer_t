# 通用 HTTP 代理 Provider 设计（方案 A：彻底删除 Kuaidaili）

## 背景

当前系统通过 `KuaidailiClient`（快代理）获取动态 IP 列表，与 HMAC-SHA1 签名深度耦合。

经过评估，决定：

1. 切到 **cliproxy** 作为主要代理服务商（API 动态提取形式）
2. **彻底删除 Kuaidaili 专有代码**
3. 采用 **通用 HTTP 适配器** 设计：任何返回代理列表的 HTTP API 都能通过 `.env` 配置接入，无需改代码

## 目标

- 切换代理服务商（cliproxy → 任何其他 API）时，**只改 `.env` 配置**，不改任何代码
- 删除 Kuaidaili 专有代码（约 120 行 + 测试）
- 保留现有的机器分区、按 Channel 分配、定时刷新、失败轮换能力
- 保留静态代理 `CRAWLER_PROXY` 作为回退

## 架构

```
┌──────────────────────────────────────────────┐
│  ProxyPool                                    │
│    - 按 Channel 分配 IP                      │
│    - 机器分区（machineIndex/machineTotal）    │
│    - 持久化到 proxy-assignments.json          │
│    - 定时刷新                                │
│    - 失败轮换 nextForChannel()                │
└──────────────────┬───────────────────────────┘
                   │ 依赖 getProxies()
                   ▼
┌──────────────────────────────────────────────┐
│  HttpProxyProvider（唯一 Provider）          │
│    - URL / Method / Headers                  │
│    - JSONPath 提取数组                       │
│    - 字段映射 → ProxyEntry                   │
│    - ProxyEntry → "http://user:pass@host:port"│
└──────────────────────────────────────────────┘
```

不再需要 `ProxyProvider` 抽象基类。`HttpProxyProvider` 是唯一实现。

## 数据标准化

### ProxyEntry（内部标准结构）

```js
{
  host: '1.2.3.4',
  port: 8080,
  username: 'user',   // 可选
  password: 'pass',   // 可选
  protocol: 'http'    // 可选，默认 http
}
```

### 不同 API 的适配示例

#### Cliproxy 动态 IP 列表

返回：
```json
{
  "code": 0,
  "data": {
    "proxies": [
      { "ip": "1.2.3.4", "port": 8080, "user": "u", "pass": "p", "type": "http" }
    ]
  }
}
```

`.env` 配置：
```env
PROXY_PROVIDER_URL=https://api.cliproxy.com/extract
PROXY_PROVIDER_METHOD=GET
PROXY_PROVIDER_API_KEY=your_token
PROXY_PROVIDER_HEADER_NAME=Authorization
PROXY_PROVIDER_HEADER_VALUE_PREFIX=Bearer
PROXY_PROVIDER_RESPONSE_PATH=data.proxies
PROXY_PROVIDER_FIELD_HOST=ip
PROXY_PROVIDER_FIELD_PORT=port
PROXY_PROVIDER_FIELD_USERNAME=user
PROXY_PROVIDER_FIELD_PASSWORD=pass
PROXY_PROVIDER_FIELD_PROTOCOL=type
```

#### 纯字符串数组

返回：
```json
["1.2.3.4:8080", "5.6.7.8:3128"]
```

`.env` 配置：
```env
PROXY_PROVIDER_URL=https://example.com/proxies
PROXY_PROVIDER_API_KEY=xxx
PROXY_PROVIDER_RESPONSE_PATH=$
```

#### 简单对象数组（最常见情况）

返回：
```json
[
  { "host": "1.2.3.4", "port": 8080 },
  { "host": "5.6.7.8", "port": 3128 }
]
```

`.env` 配置：
```env
PROXY_PROVIDER_URL=https://example.com/proxies
PROXY_PROVIDER_API_KEY=xxx
PROXY_PROVIDER_RESPONSE_PATH=$
PROXY_PROVIDER_FIELD_HOST=host
PROXY_PROVIDER_FIELD_PORT=port
```

## 配置项全集

| CLI Flag | 环境变量 | Config Key | 必填 | 默认 | 说明 |
|---------|---------|-----------|------|------|------|
| - | `PROXY_PROVIDER_URL` | `proxyProviderUrl` | ✅ | - | API 地址 |
| - | `PROXY_PROVIDER_METHOD` | `proxyProviderMethod` | | `GET` | GET / POST |
| - | `PROXY_PROVIDER_API_KEY` | `proxyProviderApiKey` | | - | 认证值 |
| - | `PROXY_PROVIDER_HEADER_NAME` | `proxyProviderHeaderName` | | `Authorization` | 认证 Header 名 |
| - | `PROXY_PROVIDER_HEADER_VALUE_PREFIX` | `proxyProviderHeaderValuePrefix` | | - | Header 值前缀，如 `Bearer ` |
| - | `PROXY_PROVIDER_CONTENT_TYPE` | `proxyProviderContentType` | | `application/json` | POST 请求 Content-Type |
| - | `PROXY_PROVIDER_BODY` | `proxyProviderBody` | | - | POST body（字符串） |
| - | `PROXY_PROVIDER_PRESET` | `proxyProviderPreset` | | - | 预设名称（`cliproxy` 等） |
| - | `PROXY_PROVIDER_STRICT_BUSINESS_CODE` | `proxyProviderStrictBusinessCode` | | `true` | 是否将 `code != 0` 视为错误 |
| - | `PROXY_PROVIDER_RESPONSE_PATH` | `proxyProviderResponsePath` | | `$` | JSONPath，定位代理数组 |
| - | `PROXY_PROVIDER_FIELD_HOST` | `proxyProviderFieldHost` | | `host` | host 字段名 |
| - | `PROXY_PROVIDER_FIELD_PORT` | `proxyProviderFieldPort` | | `port` | port 字段名 |
| - | `PROXY_PROVIDER_FIELD_USERNAME` | `proxyProviderFieldUsername` | | - | username 字段名 |
| - | `PROXY_PROVIDER_FIELD_PASSWORD` | `proxyProviderFieldPassword` | | - | password 字段名 |
| - | `PROXY_PROVIDER_FIELD_PROTOCOL` | `proxyProviderFieldProtocol` | | - | protocol 字段名 |
| - | `PROXY_PROVIDER_FILTER_PROTOCOL` | `proxyProviderFilterProtocol` | | - | 过滤协议，如只保留 `http` |

## 文件变更清单

### 删除

| 文件 | 说明 |
|------|------|
| `src/kuaidaili-client.js` | 快代理专有客户端 |
| `src/proxy-provider.js` | 抽象基类（HttpProxyProvider 是唯一实现，不需要基类） |
| `test/kuaidaili-client.test.js` | Kuaidaili 测试 |

### 新建

| 文件 | 说明 |
|------|------|
| `src/http-proxy-provider.js` | 通用 HTTP 适配器（含 preset 机制） |
| `test/http-proxy-provider.test.js` | HTTP Provider 测试 |
| `bin/run-test-proxy-provider.js`（或集成到 `bin/run-test.js`） | dry-run 工具 |

### 修改

| 文件 | 修改内容 |
|------|---------|
| `src/proxy-pool.js` | 构造函数参数 `client` → `provider`；调用 `provider.getProxies()` |
| `src/service.js` | 删除 Kuaidaili 导入；直接 `new HttpProxyProvider(config)` |
| `src/cli.js` | 删除 `kuaidaili-*` flag 和 `KUAIDAILI_*` env；新增 `proxy-provider-*` flag |
| `bin/run.js` | `buildServiceConfig` 删除 Kuaidaili 默认值，新增 `proxyProvider*` 默认值 |
| `.env` | 删除 Kuaidaili 示例；新增 HttpProxyProvider 示例（cliproxy） |
| `test/proxy-pool.test.js` | mock 改为 `{ getProxies: async () => [...] }` |
| `test/service-proxy-pool.test.js` | 移除 `kuaidailiSecretId/Key` 配置，改用 `proxyProvider*` |
| `test/proxy-config.test.js` | 新增 HttpProxyProvider + Channel 集成测试 |
| `package.json` | 新增 `jsonpath-plus` 依赖 |

## 关键实现细节

### `HttpProxyProvider` 核心逻辑

#### Preset 模板机制

减少配置项，cliproxy 等常见服务商只需 1 行 preset + 1 行 token：

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
  // 未来扩展：kuaidaili, abcproxy...
};
```

用户配置：
```env
PROXY_PROVIDER_PRESET=cliproxy
PROXY_PROVIDER_URL=https://api.cliproxy.com/extract
PROXY_PROVIDER_API_KEY=xxx
```

显式传入的 `PROXY_PROVIDER_FIELD_*` 等可覆盖 preset 默认值。

#### 核心实现（含加固）

```js
const { JSONPath } = require('jsonpath-plus');

class HttpProxyProvider {
  constructor(options) {
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

  async getProxies() {
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

    // 业务错误码检测（默认开启）
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

    return list
      .map(item => this.toProxyEntry(item))
      .filter(entry => entry !== null)
      .filter(entry => !this.filterProtocol ||
        this.normalizeProtocol(entry.protocol) === this.normalizeProtocol(this.filterProtocol))
      .map(entry => this.toProxyString(entry));
  }

  normalizeProtocol(p) {
    return (p || '').toLowerCase();
  }

  toProxyEntry(item) {
    if (typeof item === 'string') {
      // 支持 "host:port" / "http://host:port" / "http://user:pass@host:port" / IPv6
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
      return null; // 静默丢弃无效端口
    }

    return {
      host: String(host),
      port: portNum,
      username: this.fieldUsername ? item[this.fieldUsername] : undefined,
      password: this.fieldPassword ? item[this.fieldPassword] : undefined,
      protocol: this.fieldProtocol
        ? this.normalizeProtocol(item[this.fieldProtocol])
        : undefined,
    };
  }

  toProxyString(entry) {
    const auth = entry.username && entry.password
      ? `${entry.username}:${entry.password}@`
      : '';
    return `${entry.protocol || 'http'}://${auth}${entry.host}:${entry.port}`;
  }
}

function extractByPath(obj, path) {
  if (!path || path === '$') return obj;
  return JSONPath({ path, json: obj });
}
```

### `ProxyPool` 关键改动

```js
class ProxyPool {
  constructor(options) {
    this.provider = options.provider;  // 原 client
    this.machineIndex = Number(options.machineIndex || 0);
    // ... 其余不变
  }

  async loadProxies() {
    const all = await this.provider.getProxies();  // 原 getKpsProxies
    return all.filter((_, idx) => idx % this.machineTotal === this.machineIndex);
  }
}
```

### `service.js` 简化

```js
// 删除：
//   const { KuaidailiClient } = require('./kuaidaili-client');
//   const { ProxyProvider } = require('./proxy-provider');

// 新增：
const { HttpProxyProvider } = require('./http-proxy-provider');

// 替换原来的 Kuaidaili 构造逻辑：
if (!this.config.proxy && this.config.proxyProviderUrl) {
  this.proxyPool = new ProxyPool({
    provider: new HttpProxyProvider({
      url: this.config.proxyProviderUrl,
      method: this.config.proxyProviderMethod,
      apiKey: this.config.proxyProviderApiKey,
      headerName: this.config.proxyProviderHeaderName,
      headerValuePrefix: this.config.proxyProviderHeaderValuePrefix,
      body: this.config.proxyProviderBody,
      responsePath: this.config.proxyProviderResponsePath,
      fieldHost: this.config.proxyProviderFieldHost,
      fieldPort: this.config.proxyProviderFieldPort,
      fieldUsername: this.config.proxyProviderFieldUsername,
      fieldPassword: this.config.proxyProviderFieldPassword,
      fieldProtocol: this.config.proxyProviderFieldProtocol,
      filterProtocol: this.config.proxyProviderFilterProtocol,
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

## 测试计划

### `test/http-proxy-provider.test.js`（新建）

**基础功能：**
1. GET 请求带 `Authorization: Bearer xxx` Header
2. 自定义 Header 名（如 `X-API-Key`）
3. POST 请求带 body（自动加 Content-Type）
4. JSONPath `data.proxies` 提取
5. JSONPath `$` 提取根数组
6. JSONPath 数组下标 `data.proxies[0]`
7. 字符串数组 `"host:port"` 解析
8. 对象数组 + 字段映射
9. 字段映射 username/password
10. 协议过滤
11. 输出统一为 `http://user:pass@host:port` 格式

**Preset 机制：**
12. preset 正确填充默认值
13. 显式传入的字段覆盖 preset 默认值
14. 未命中 preset 时使用内置默认值

**错误处理：**
15. 非 200 响应报错并附 response body
16. 路径不指向数组报错并附原始响应
17. API 返回业务错误码 (`code != 0`) 时抛出明确错误
18. `strictBusinessCode=false` 时业务错误不抛错

**容错：**
19. 字段映射指向不存在字段时丢弃该项
20. 端口超出 1-65535 范围时丢弃该项
21. 协议过滤大小写不敏感（`HTTP` 也能匹配 `http`）
22. IPv6 地址解析 `[::1]:8080`
23. 带 `http://` 前缀的字符串解析
24. 含认证信息的字符串解析 `http://u:p@host:port`
25. IP 数量 < channels 时抛清晰错误（在 ProxyPool 层）

### `test/proxy-pool.test.js`（修改）

- mock 对象从 `{ getKpsProxies }` 改为 `{ getProxies }`
- 其余逻辑（分区、分配、刷新、轮换、持久化）测试不变

### `test/service-proxy-pool.test.js`（修改）

- 删除所有 `kuaidailiSecretId` / `kuaidailiSecretKey` 配置
- 改用 `proxyProviderUrl: 'http://mock'` + mock `HttpProxyProvider`
- 保留 Channel 不同代理、轮换、静态代理回退测试

### `test/proxy-config.test.js`（修改）

- 保留 `--proxy` flag 解析测试
- 新增 `HttpProxyProvider` + `Channel` 集成测试

### 全量测试

- `npm test` 全部通过

## Dry-Run 工具

### `bin/run-test.js proxy-provider`

启动前独立验证代理配置，**不启动浏览器，不分配 channel**：

```bash
node bin/run-test.js proxy-provider
```

输出示例：

```
[DRY-RUN] Proxy provider config:
  preset:   cliproxy
  url:      https://api.cliproxy.com/extract
  method:   GET
  response: data.proxies
[DRY-RUN] Fetching...
[DRY-RUN] Got 42 proxies
[DRY-RUN] First 3 sample:
  http://u:p@1.2.3.4:8080
  http://u:p@5.6.7.8:3128
  http://u:p@9.10.11.12:8888
[DRY-RUN] After partition (machine=0/1): 21 proxies available
[DRY-RUN] OK
```

错误时：

```
[DRY-RUN] Proxy provider config:
  ...
[DRY-RUN] Fetching...
[DRY-RUN] FAILED: Proxy provider business error: code=401, msg=invalid token
[DRY-RUN] Exit 1
```

## 加固项总结

| 漏洞 | 加固方案 | 投入 |
|------|---------|------|
| 1. 配置项过多 | Preset 模板机制 | 加 30 行 |
| 2. JSONPath 太简陋 | 引入 `jsonpath-plus` | 加 1 个依赖 |
| 3. 协议大小写 | 归一化 lowercase | 1 行 |
| 4. host:port 解析 | 用 `URL` 解析 | 重构 10 行 |
| 5. 错误信息缺上下文 | 附 response body / 业务错误码检测 | 加 10 行 |
| 6. 端口无校验 | 范围检查 + 静默丢弃 | 加 5 行 |
| 8. 缺 dry-run | 新增 `bin/run-test.js proxy-provider` 子命令 | 加 1 个文件 |
| 9. Content-Type 硬编码 | 可配置 `PROXY_PROVIDER_CONTENT_TYPE` | 加 1 个 config |
| 10. 测试盲区 | 新增 14 个 case | 加测试 |
| 7. 并发互斥锁 | **延后**（当前调度场景不致命） | - |

## 验收标准

**删除：**
- [ ] `src/kuaidaili-client.js` 已删除
- [ ] `src/proxy-provider.js` 已删除
- [ ] `test/kuaidaili-client.test.js` 已删除
- [ ] `.env` 不再含 `KUAIDAILI_*` 配置
- [ ] `.env` 包含 cliproxy 的 `PROXY_PROVIDER_*` 示例配置

**核心功能：**
- [ ] `npm test` 全部通过
- [ ] 切换代理 API 时**只改 `.env`**，零代码改动
- [ ] `HttpProxyProvider` 支持字符串数组和对象数组两种格式
- [ ] `HttpProxyProvider` 支持 JSONPath 任意层级提取（含数组下标）
- [ ] `HttpProxyProvider` 支持字段映射标准化
- [ ] `ProxyPool` 机器分区、按 Channel 分配、定时刷新、失败轮换功能保持

**加固项：**
- [ ] `HttpProxyProvider` 内置 `cliproxy` preset，cliproxy 接入只需 2 行 `.env`
- [ ] 引入 `jsonpath-plus` 依赖
- [ ] 协议过滤大小写不敏感
- [ ] 字符串解析支持 `host:port` / `http://host:port` / `http://u:p@host:port` / IPv6
- [ ] 端口超出 1-65535 静默丢弃
- [ ] 非 200 响应错误信息附 response body
- [ ] 业务错误码 `code != 0` 抛出明确错误（可关闭）
- [ ] `Content-Type` 可通过 `PROXY_PROVIDER_CONTENT_TYPE` 配置
- [ ] `node bin/run-test.js proxy-provider` dry-run 工具可用
- [ ] 测试覆盖 25 个 case（含 preset、错误处理、容错）

## 范围外（YAGNI）

- 不实现 HMAC-SHA1 签名生成（如果将来想换回 Kuaidaili 单独加）
- 不支持代理认证以外的复杂协议（如 SOCKS5 over WebSocket）
- 不实现配置热加载（需要重启服务）
- 不实现 Redis 共享代理池
