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
| - | `PROXY_PROVIDER_BODY` | `proxyProviderBody` | | - | POST body（JSON 字符串） |
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
| `src/http-proxy-provider.js` | 通用 HTTP 适配器 |
| `test/http-proxy-provider.test.js` | HTTP Provider 测试 |

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

## 关键实现细节

### `HttpProxyProvider` 核心逻辑

```js
class HttpProxyProvider {
  constructor(options) {
    this.url = options.url;
    this.method = options.method || 'GET';
    this.apiKey = options.apiKey;
    this.headerName = options.headerName || 'Authorization';
    this.headerValuePrefix = options.headerValuePrefix || '';
    this.body = options.body;
    this.responsePath = options.responsePath || '$';
    this.fieldHost = options.fieldHost || 'host';
    this.fieldPort = options.fieldPort || 'port';
    this.fieldUsername = options.fieldUsername;
    this.fieldPassword = options.fieldPassword;
    this.fieldProtocol = options.fieldProtocol;
    this.filterProtocol = options.filterProtocol;
    this.fetch = options.fetch || globalThis.fetch;
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
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      init.body = this.body;
    }

    const res = await this.fetch(this.url, init);
    if (!res.ok) {
      throw new Error(`Proxy provider fetch failed: ${res.status}`);
    }

    const data = await res.json();
    const list = extractByPath(data, this.responsePath);
    if (!Array.isArray(list)) {
      throw new Error(`Proxy provider response path "${this.responsePath}" did not return array`);
    }

    return list
      .map(item => this.toProxyEntry(item))
      .filter(entry => entry !== null)
      .filter(entry => !this.filterProtocol || entry.protocol === this.filterProtocol)
      .map(entry => this.toProxyString(entry));
  }

  toProxyEntry(item) {
    if (typeof item === 'string') {
      // "host:port" 格式
      const m = item.match(/^([^:]+):(\d+)$/);
      if (!m) return null;
      return { host: m[1], port: Number(m[2]) };
    }
    if (typeof item !== 'object' || item === null) return null;

    const host = item[this.fieldHost];
    const port = item[this.fieldPort];
    if (!host || !port) return null;

    return {
      host: String(host),
      port: Number(port),
      username: this.fieldUsername ? item[this.fieldUsername] : undefined,
      password: this.fieldPassword ? item[this.fieldPassword] : undefined,
      protocol: this.fieldProtocol ? item[this.fieldProtocol] : undefined,
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
  return path.split('.').reduce((acc, key) => {
    if (acc == null) return undefined;
    return acc[key];
  }, obj);
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

1. GET 请求带 `Authorization: Bearer xxx` Header
2. 自定义 Header 名（如 `X-API-Key`）
3. POST 请求带 body
4. JSONPath `data.proxies` 提取
5. JSONPath `$` 提取根数组
6. 字符串数组 `"host:port"` 解析
7. 对象数组 + 字段映射
8. 字段映射 username/password
9. 协议过滤
10. 非 200 响应报错
11. 路径不指向数组报错
12. 输出统一为 `http://user:pass@host:port` 格式

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

## 验收标准

- [ ] `src/kuaidaili-client.js` 已删除
- [ ] `src/proxy-provider.js` 已删除
- [ ] `test/kuaidaili-client.test.js` 已删除
- [ ] `.env` 不再含 `KUAIDAILI_*` 配置
- [ ] `.env` 包含 cliproxy 的 `PROXY_PROVIDER_*` 示例配置
- [ ] `npm test` 全部通过
- [ ] 切换代理 API 时**只改 `.env`**，零代码改动
- [ ] `HttpProxyProvider` 支持字符串数组和对象数组两种格式
- [ ] `HttpProxyProvider` 支持 JSONPath 任意层级提取
- [ ] `HttpProxyProvider` 支持字段映射标准化
- [ ] `ProxyPool` 机器分区、按 Channel 分配、定时刷新、失败轮换功能保持

## 范围外（YAGNI）

- 不实现 HMAC-SHA1 签名生成（如果将来想换回 Kuaidaili 单独加）
- 不支持代理认证以外的复杂协议（如 SOCKS5 over WebSocket）
- 不实现配置热加载（需要重启服务）
- 不实现 Redis 共享代理池
