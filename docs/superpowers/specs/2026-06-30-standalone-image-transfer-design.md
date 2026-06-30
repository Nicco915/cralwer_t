# 独立图片传输脚本 — 设计规格

**日期**：2026-06-30
**会话**：图片传输-2
**作者**：claude
**状态**：草案 → 实施前

---

## 1. 背景与目标

爬虫已有完整图片上传链路：`Worker.runTask()` → 成功后 `ImageUploader.upload(result)` → 远端 `/classify/open/image/upload`。

但目前没有"独立调图片传输"的入口：离线补传、批次重试、调试验证都得跑整个爬虫流程。

**目标**：新增独立 CLI 脚本，使用真实接口（默认从 `.env` 读），支持 1 个或多个本地图片路径，输出统一 JSON 报告，不影响现有 `test-sku.js` / `bin/run.js` / `ImageUploader` 默认行为。

## 2. 范围

### 在范围内

- 新建 `bin/transfer-images.js` 可执行脚本
- 支持 1+ 个本地图片文件路径作为位置参数
- 默认走 `.env` 中 `CRAWLER_IMAGE_UPLOAD_URL` 真实接口
- 支持 `--mock-upload` 启动内置 mock server（覆盖真实接口，便于 CI / 离线）
- 终态打印 JSON：`{ total, success, failed, results: [...] }`
- 复用 `ImageUploader` 现有并发 / 重试 / magic bytes 逻辑
- 仓库 README 增加使用说明

### 不在范围内（YAGNI）

- 不下载 URL 图片（用户已选 A：仅本地）
- 不调度 / 不轮询 / 不定时
- 不与现有 service / test-sku / 爬虫运行模式共存
- 不重写 ImageUploader
- 不引入新依赖

## 3. 设计决策记录

| 维度 | 选择 | 理由 |
|---|---|---|
| 输入源 | 本地文件路径 | 用户选择 A |
| SKU 来源 | fileName 去扩展名 | 用户选择 B；最少参数 |
| fileName | basename 原样 | 用户选择 A |
| 输出 | JSON 总览 | 用户选择 A；可重定向 / 管道消费 |
| mock 兜底 | `--mock-upload` 保留 | 用户选择需要，便于 CI / 离线 |
| 与 ImageUploader 关系 | 复用 + adapter | 用户选择方案 1 |
| 接口地址来源 | `.env` 默认 / `--upload-url=` 覆盖 | 与既有 CLI 一致 |

## 4. 架构

```
test/transfer-images.test.js  ─►  单元 + 集成
                                       │
bin/transfer-images.js  ─►  parseTransferArgs()
                                       │
                                       ▼
                              loadEnvFile()         ← 复用 src/cli.js
                                       │
                                       ▼
                              for each path: read + detect
                                       │
                                       ▼
                              buildStandaloneConfig() ← 自定义
                                       │
                                       ▼
                              ImageUploader({ ..., skuForImage })
                                       │
                                       ▼
                              .upload(fakeResult)   ← 复用 src/image-uploader.js
                                       │
                                       ▼
                              console.log(JSON.stringify(report, null, 2))
```

**职责边界**：

| 模块 | 责任 | 不应负责 |
|---|---|---|
| `bin/transfer-images.js` | 参数解析 / 读文件 / sku 推断 / 终态输出 | 上传协议 / 重试 / 并发 / mock |
| `ImageUploader` | 上传流水线（含并发、重试、magic bytes） | 文件读取 / SKU 推断 |

## 5. CLI 接口

```
node bin/transfer-images.js [options] <path1> [<path2> ...]
```

### 参数

| 参数 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| 位置参数 | ✅ | — | 一个或多个本地图片文件路径，空格分隔 |
| `--upload-url=` | ❌ | `process.env.CRAWLER_IMAGE_UPLOAD_URL` | 覆盖真实接口地址 |
| `--upload-concurrency=` | ❌ | `process.env.CRAWLER_IMAGE_UPLOAD_CONCURRENCY`（=2） | 并发上传数 |
| `--upload-retries=` | ❌ | `process.env.CRAWLER_IMAGE_UPLOAD_RETRIES`（=3） | 单图最大重试次数 |
| `--node-code=` | ❌ | `process.env.CRAWLER_NODE_CODE`（=空） | 透传 header / payload |
| `--node-token=` | ❌ | `process.env.CRAWLER_NODE_TOKEN`（=空） | 透传 header / payload |
| `--mock-upload` | ❌ | `false` | 启动内置 mock server，覆盖 `--upload-url` |
| `--no-progress` | ❌ | `false` | 关闭逐张上传过程中的 `[UPLOAD]` 日志 |

### 退出码

| 码 | 含义 |
|---|---|
| `0` | 至少 1 张上传成功（即便其它失败） |
| `1` | 全部失败 或 启动阶段就出错（路径不存在 / URL 缺失 / mock 启动失败） |
| `2` | 已知配置错误（如上传 URL 未配置且非 mock） |

## 6. 模块导出

```js
// bin/transfer-images.js
module.exports = {
  parseTransferArgs, // (argv) => { paths, options }
  transferImages,    // ({ paths, options, deps? }) => Promise<Report>
  main,              // (argv?) => Promise<int>    入口；返回 exit code
};
```

### `parseTransferArgs(argv)`

签名：`parseTransferArgs(argv: string[]): { paths: string[], options: TransferOptions }`

- 跳过前两位（node / script）
- 收集非 `--` 开头的为 `paths`（去重保序）
- 解析 `--key=value` 与 `--key` 布尔
- `--mock-upload` → `options.mockUpload = true`
- `--no-progress` → `options.progress = false`
- 返回对象

### `transferImages({ paths, options, deps? })`

输入：
```ts
{
  paths: string[],                    // 要上传的文件路径
  options: {                           // 已在 parseTransferArgs 完成 env 合并
    uploadUrl?: string,                // ← 缺省时由 deps.uploadUrlGetter 提供；抛错
    uploadConcurrency?: number,
    uploadRetries?: number,
    nodeCode?: string,
    nodeToken?: string,
    mockUpload?: boolean,
    progress?: boolean,
  },
  deps?: {                             // 注入用于测试
    loadEnvFile?: Function,             // 默认 src/cli.js.loadEnvFile
    readFile?: (p) => Buffer,           // 默认 fs.readFileSync
    pathExists?: (p) => boolean,       // 默认 fs.existsSync
    startMockUploadServer?: Function,  // 默认 test-sku.startMockUploadServer（提升到共享模块后再调整）
    fetchImpl?: Function,               // 注入到 ImageUploader
    log?: (...args) => void,
  },
}
```

输出：`Promise<Report>`，形状：
```js
{
  total: number,
  success: number,
  failed: number,
  results: Array<{
    path: string,
    sku: string,
    fileName: string,
    contentType: string | null,
    fileSize: number,
    ok: boolean,
    response?: object,           // 上游 data 字段；失败时省略
    error?: string,              // 失败原因；成功时省略
  }>,
}
```

行为：
- `paths` 为空 → 立即抛 `Error('no paths provided')`
- 任一路径不存在 → 抛 `Error('path not found: <p>')`
- 任一路径为空文件 → 计入 `results`（`ok=false, error='empty file'`）并继续
- magic bytes / 扩展名均无法识别 → 计入 `results`（`ok=false, error='unknown content type'`）并继续
- 上传失败（含重试耗尽）→ 计入 `results`（`ok=false, error=<message>`）并继续其它
- 任一张上传成功 → Promise 成功 resolve
- `mockUpload=true` → 先启动 mock，再覆盖 `options.uploadUrl`，退出时关 mock

**关键**：本函数永不 reject（除非启动阶段错误）；批量失败不抛错，由调用方看 `failed > 0` 决定退出码。

### `main(argv?)`

1. `loadEnvFile(process.cwd())`
2. `parseTransferArgs(argv || process.argv)`
3. 构建 `options`，合并 env（命令行显式优先于 env）
4. 若 `mockUpload` → `startMockUploadServer()`，覆盖 `options.uploadUrl`
5. 若 `!options.uploadUrl` → 抛 `ConfigError('upload url required, pass --upload-url= or set CRAWLER_IMAGE_UPLOAD_URL')`
6. 准备 `ImageUploader`，注入 `skuForImage` 钩子（见 §7.2）
7. 构造伪 `result`，调 `transferImages()`
8. 按 `success/failed` 选择退出码
9. 始终打印最终 JSON

## 7. ImageUploader 改动

### 7.1 现状

`ImageUploader.upload(result)` 当前签名：
- 读 `result.image_paths`（字符串，分隔为多路径）
- 读 `result.status === 'success'` 才上传
- 用 `result.sku` 拼所有图的 payload.sku
- 拼装 `payload = { nodeCode, nodeToken, sku, contentType, fileName, imageBase64 }`

**问题**：脚本有 N 张图来自 N 个不同 SKU（按 fileName 推断），无法共用一个 `result.sku`。

### 7.2 最小改动：新增 skuForImage 钩子 + _preloadedItems 旁路

**构造器新增 `skuForImage` 字段**：
```js
// src/image-uploader.js（构造器内）
this.skuForImage = typeof options.skuForImage === 'function'
  ? options.skuForImage
  : null;
```

**顶层新增 `resolveImageSku` 函数**（与 `isNonRetryableError` 同级）：
```js
function resolveImageSku(uploader, buf, index, imageRecord, result) {
  if (typeof uploader.skuForImage === 'function') {
    return uploader.skuForImage(buf, index, imageRecord);
  }
  if (uploader.nodeCode) return `${uploader.nodeCode}_${index}`;
  if (result && result.crawlerTaskId) return `${result.crawlerTaskId}_${index}`;
  return '';
}
```

**upload() 拆 SKU 拼装到 `_preloadedItems` 路径**：调用方通过 `result._preloadedItems` 传预加载的 items，并依赖 `resolveImageSku` 计算每图独立 SKU。`image_paths` 路径保留原 `result.sku` 共用语义（兼容爬虫）。

```js
// upload() 内（伪代码）
const usePreloaded = Array.isArray(result._preloadedItems);
const uploadItems = usePreloaded
  ? result._preloadedItems
  : this._resolveFromPaths(result.image_paths, summary);

const outputs = await this.limitConcurrency(
  uploadItems,
  async (item, index) => {
    const sku = usePreloaded
      ? resolveImageSku(this, item.buffer, index, item, result)
      : result.sku;
    // ...
  },
  ...
);
```

> **决策说明**：规格最初尝试全局三选一 sku 拼装，但发现 `image_paths` 路径有 18 个原 case 期望 `payload.sku === result.sku`，全局改会全部回归失败。改为"两条路径两条语义"：脚本用 `_preloadedItems` 走三选一；爬虫走 `image_paths` 保持 `result.sku` 共用，零回归。

**契约**：
- `skuForImage(buffer, index, imageRecord)` → `string`
- `imageRecord` 形如 `{ fileName, buffer, contentType }`（与 `uploadItems` 项一致）
- 仅在 `result._preloadedItems` 路径生效

**bin/transfer-images.js 注入**：
```js
const uploader = new ImageUploader({
  uploadUrl,
  nodeCode,
  nodeToken,
  concurrency,
  maxRetries,
  skuForImage: (_buf, _index, image) => {
    // sku = fileName 去扩展名
    return path.basename(image.fileName, path.extname(image.fileName));
  },
});
```

### 7.3 行为兼容性

| 场景 | 路径 | 修改前 | 修改后 |
|---|---|---|---|
| 爬虫调用（不传 skuForImage） | `image_paths` | `payload.sku = result.sku` | 完全相同 |
| 爬虫调用（不传 skuForImage，走 _preloadedItems） | `_preloadedItems` | 不支持 | `payload.sku = nodeCode_${index}` 或 taskId_${index} 或 `''` |
| 脚本调用（传 skuForImage，走 _preloadedItems） | `_preloadedItems` | 不支持 | `payload.sku = skuForImage(...)` |
| 脚本调用（传 skuForImage，走 image_paths） | `image_paths` | 无此路径 | 同爬虫：`result.sku` |

两条路径互不影响；原 18 个 case 在 `image_paths` 路径下零回归。

## 8. 数据流

### 8.1 读图 & 推断

```js
const records = paths.map((p) => {
  if (!fs.existsSync(p)) {
    throw new Error(`path not found: ${p}`);
  }
  const stats = fs.statSync(p);
  const buffer = fs.readFileSync(p);
  const ext = path.extname(p);
  const fileName = path.basename(p);
  const contentType = ImageUploader.prototype.detectContentType(buffer, ext);
  return {
    path: p,
    buffer,
    fileName,
    contentType,                            // ← 可能为 null
    fileSize: stats.size,
    isEmpty: stats.size === 0,
    sku: path.basename(fileName, path.extname(fileName)),
  };
});
```

注意：`detectContentType` 是实例方法，但内部不依赖 this 状态，调用 prototype 方法即可（无副作用）。

### 8.2 处理三类空 / 未知

```js
// 在 transferImages 里同步执行：
for (const r of records) {
  if (r.isEmpty) {
    results.push({ ...r, ok: false, error: 'empty file' });
    continue;
  }
  if (!r.contentType) {
    results.push({ ...r, ok: false, error: 'unknown content type' });
    continue;
  }
  uploadItems.push(r);
}
```

### 8.3 adapter：让 ImageUploader.upload() 接收

```js
const fakeResult = {
  crawlerTaskId: `cli-transfer-${Date.now()}`,
  status: 'success',
  image_paths: uploadItems.map((i) => i.path).join(','),  // upload() 读这个判 success/list
  sku: '',                                                  // 不再使用（被 skuForImage 覆盖）
  images: uploadItems,                                      // 备查，本规格不强制消费
};
const summary = await uploader.upload(fakeResult);
// ↑ upload() 返回 { uploaded, failed, skipped }
```

⚠️ 这里有微妙处：upload() 内部会自己再读一次文件、detect 内容类型、再 limitConcurrency。
为避免**重复读盘 / 重复 detect**，本规格**收紧 ImageUploader 改动面**，给 upload() 加一个可选的预解析 items 旁路 —— 这是方案真正落地最干净的做法，详见 §8.4。

### 8.4 ImageUploader.upload() 加预解析旁路（推荐实际实现）

为消除重复工作，把 ImageUploader.upload() 调整成支持 `result._preloadedItems`：

```js
async upload(result) {
  const summary = { sku: result.sku, uploaded: [], failed: [], skipped: [] };

  if (result.status !== 'success' || (!result.image_paths && !result._preloadedItems)) {
    return summary;
  }

  // 路径 1：预解析 items（脚本用）
  // 路径 2：从 image_paths 解析（爬虫用，原逻辑）
  let uploadItems;
  if (Array.isArray(result._preloadedItems)) {
    uploadItems = result._preloadedItems;
  } else {
    uploadItems = this._resolveFromPaths(result.image_paths, summary);
  }
  // ...后续 limitConcurrency 不变
}
```

这样：
- **爬虫调用**：行为完全不变（不传 `_preloadedItems` → 走 `_resolveFromPaths`）
- **脚本调用**：传 `_preloadedItems` → 跳过 `_resolveFromPaths` 的 fs 操作
- **代码量净增**：约 10 行

## 9. 错误处理

| 场景 | 行为 | 退出码 |
|---|---|---|
| `--upload-url=` 未提供且非 mock | `ConfigError` → `main()` catch → stderr + JSON | `2` |
| `paths` 为空 | `Error('no paths provided')` | `1` |
| 路径不存在 | `Error('path not found: ...')` | `1` |
| mock server 启动失败 | `Error('mock server failed: ...')` | `1` |
| 全部图 magic bytes 空/未知 | 继续，全部 `ok=false`，`failed === total` | `1` |
| 部分失败 | 继续，`failed` 计入；`success > 0` | `0` |
| 全部成功 | 正常 | `0` |
| 任意未捕获异常 | `main()` 顶层 catch → stderr + 简化 JSON | `1` |

### Report schema（成功/失败共用）

```json
{
  "total": 3,
  "success": 2,
  "failed": 1,
  "results": [
    {
      "path": "./img/ABC-001_1.jpg",
      "sku": "ABC-001_1",
      "fileName": "ABC-001_1.jpg",
      "contentType": "image/jpeg",
      "fileSize": 12345,
      "ok": true,
      "response": { "code": 0, "data": { "id": 999, ... } }
    },
    {
      "path": "./img/foo.png",
      "sku": "foo",
      "fileName": "foo.png",
      "contentType": "image/png",
      "fileSize": 8192,
      "ok": false,
      "error": "Upload failed: 500 server error"
    }
  ]
}
```

注意：`response` 只取上游 `data` 字段，不暴露整包响应（避免契约漂移）。

## 10. 测试

### 10.1 文件

- 新建 `test/transfer-images.test.js`

### 10.2 测试矩阵

**`parseTransferArgs` (单元)**

1. 默认无参数返回 `{ paths: [], options: {} }`，`progress: true`，`mockUpload: false`
2. 单个位置参数落入 `paths`
3. 多个位置参数按顺序落入 `paths`
4. `--upload-url=` 解析到 `options.uploadUrl`
5. `--upload-concurrency=4` 解析为数字
6. `--mock-upload` 转为布尔 true
7. `--no-progress` 转为 `progress: false`
8. 重复位置参数去重（保留首次）

**`transferImages`（用 mock fetch + 临时目录）**

9. 单张图，mock fetch 返回 200，报告 `ok: true`
10. 多张图，部分失败（第一次 fetch 返回 500，第 N 次返回 200），最终 `success+failed === total`
11. 空文件计入 `ok=false, error='empty file'`，不调用 fetch
12. magic bytes + 扩展名均无法识别 → `ok=false, error='unknown content type'`，不调用 fetch
13. 并发参数生效（同时只跑 N 个 worker）
14. mock fetch 抛 401 → 4xx 立即 break，不重试（与现有 `image-uploader` 行为一致）
15. 重试耗尽 → 计入 `ok=false, error` 含 `retries`
16. SKU 是 fileName 去扩展名

**ImageUploader 钩子（新 case，加到 `test/image-uploader.test.js`）**

17. `skuForImage` 注入后被调用，返回值注入 payload
18. 不注入 `skuForImage` → 行为完全兼容（爬虫测无回归）

### 10.3 不改动的测试

- `test/image-uploader.test.js` 现 18 个 case（除新增 2 个）
- `test/worker-image-upload.test.js`
- `test/cli-image-upload-config.test.js`
- `test/test-sku.test.js`
- `test/bin-run.test.js`
- `test/service.integration.test.js`

## 11. 文件改动清单

| 文件 | 操作 | 行数预估 |
|---|---|---|
| `bin/transfer-images.js` | 新建 | ~180 |
| `test/transfer-images.test.js` | 新建 | ~250 |
| `src/image-uploader.js` | 改：构造器加 `skuForImage`；upload() 加 `_preloadedItems` 旁路；`uploadSingle()` 改 sku 拼装 | +15 ~ +20 |
| `test/image-uploader.test.js` | 改：加 2 个 case（钩子 + 兼容性） | +30 |
| `README.md` | 改：新增"独立图片传输脚本"段落 | +30 |

## 12. 工作流

1. spec-review（用户审查本文档）
2. writing-plans 技能 → `docs/superpowers/plans/2026-06-30-standalone-image-transfer-plan.md`
3. executing-plans 技能 → TDD 实现
4. 提交 + 推送

## 13. 风险与对策

| 风险 | 概率 | 影响 | 对策 |
|---|---|---|---|
| `_preloadedItems` 命名泄漏到上游 payload | 低 | 中 | 文档化为"以 `_` 开头的字段不进 payload"；代码加注释 |
| `detectContentType` 改为 prototype 方法调用的可读性下降 | 低 | 低 | 抽出工具模块 `src/image-content-type.js` 或保留 prototype 调用加注释 |
| startMockUploadServer 与 test-sku 重复引入 | 中 | 中 | 提取到 `src/mock-upload-server.js`，test-sku 与 transfer-images 都引用 |
| 用户多 SKU 场景期望错了（多文件共用一个 SKU） | 低 | 低 | 文档明确"每文件一个 SKU，按 fileName 推断" |
| 部分服务器返回 5xx 时 `isNonRetryableError` 误判 | 低 | 低 | 复用现有逻辑（已覆盖 4xx 不重试）；不动 |

## 14. 开放问题

（无；所有不确定性已在 §2、§3 决策表中收敛。）
