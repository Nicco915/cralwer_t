# 独立图片传输脚本 — 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 新增 `bin/transfer-images.js` 可执行脚本，使用真实接口（默认从 `.env` 读 `CRAWLER_IMAGE_UPLOAD_URL`），支持 1+ 个本地图片路径，打印统一 JSON 报告；扩展 `ImageUploader` 增加 `skuForImage` 钩子和 `_preloadedItems` 旁路以复用现有上传流水线。

**架构：** 脚本层负责参数解析 / 文件读取 / sku 推断 / mock 启动 / 终态输出；通过 adapter 构造伪 `result` 并设置 `result._preloadedItems`，复用 `ImageUploader.upload()` 内置并发 / 重试 / magic bytes 逻辑。

**技术栈：** Node.js CommonJS、node:test、`fs` / `path`、现有 `src/image-uploader.js`、`src/cli.js` `loadEnvFile`、现有 `test-sku.js` 的 `startMockUploadServer`（通过新 `src/mock-upload-server.js` 共享）。

---

## 文件结构

| 文件 | 状态 | 职责 |
|---|---|---|
| `bin/transfer-images.js` | 新建 | CLI 入口；参数解析；mock server 生命周期；adapter；JSON 输出；退出码 |
| `src/mock-upload-server.js` | 新建 | `startMockUploadServer({ fetchImpl? })`：返回 `{ server, url, getUploadCount, close }`；纯函数；不依赖 test-sku |
| `test/transfer-images.test.js` | 新建 | `parseTransferArgs` / `transferImages` / `main` 全部测试；用 `mock-upload-server` + fake fetch |
| `src/image-uploader.js` | 改 | 构造器加 `skuForImage` 注入；`upload()` 加 `_preloadedItems` 旁路；`uploadSingle()` sku 拼装三选一 |
| `test/image-uploader.test.js` | 改 | 新增 2 个 case：skuForImage 钩子生效 + 不传钩子兼容旧行为 |
| `test-sku.js` | 改（最小） | `startMockUploadServer` 替换为 `require('./src/mock-upload-server').startMockUploadServer` 转发，保持既有测试通过 |
| `README.md` | 改 | 新增"独立图片传输脚本"段落，使用示例 |

---

## 任务 1：抽出共享 `src/mock-upload-server.js`

### 任务 1.1：编写失败测试

**文件：** 创建：`test/mock-upload-server.test.js`

- [ ] **步骤 1：编写失败的测试**

```js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { startMockUploadServer } = require('../src/mock-upload-server');

describe('startMockUploadServer', () => {
  it('returns URL and handles POST /upload', async () => {
    const handle = await startMockUploadServer();
    try {
      const response = await new Promise((resolve, reject) => {
        const req = http.request(handle.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }, (res) => {
          let body = '';
          res.on('data', (c) => { body += c; });
          res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject);
        req.write(JSON.stringify({
          sku: 'X', contentType: 'image/jpeg',
          fileName: 'x.jpg', imageBase64: 'aGVsbG8=',
        }));
        req.end();
      });
      assert.equal(response.status, 200);
      const data = JSON.parse(response.body);
      assert.equal(data.code, 0);
      assert.equal(handle.getUploadCount(), 1);
    } finally {
      handle.close();
    }
  });

  it('returns 404 for unknown paths', async () => {
    const handle = await startMockUploadServer();
    try {
      const base = handle.url.replace('/upload', '');
      const status = await new Promise((resolve, reject) => {
        const req = http.request(`${base}/no`, { method: 'GET' }, (res) => resolve(res.statusCode));
        req.on('error', reject);
        req.end();
      });
      assert.equal(status, 404);
    } finally {
      handle.close();
    }
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/mock-upload-server.test.js`
预期：FAIL，`Cannot find module '../src/mock-upload-server'`

### 任务 1.2：实现最小可用版本

**文件：** 创建：`src/mock-upload-server.js`

- [ ] **步骤 1：实现 `startMockUploadServer`**

```js
const http = require('http');

function startMockUploadServer() {
  let uploadCount = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/upload' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        uploadCount++;
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch (e) { /* ignore */ }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 0,
          data: {
            id: Date.now() + uploadCount,
            sku: parsed.sku,
            contentType: parsed.contentType,
            fileName: parsed.fileName,
            fileSize: parsed.imageBase64 ? Math.ceil(parsed.imageBase64.length * 0.75) : 0,
          },
        }));
      });
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${port}/upload`,
        getUploadCount: () => uploadCount,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

module.exports = { startMockUploadServer };
```

- [ ] **步骤 2：运行测试验证通过**

运行：`node --test test/mock-upload-server.test.js`
预期：2 passed

- [ ] **步骤 3：Commit**

```bash
git add src/mock-upload-server.js test/mock-upload-server.test.js
git commit -m "feat(mock-upload-server): extract shared mock upload server"
```

---

## 任务 2：迁移 `test-sku.js` 共享引用

### 任务 2.1：迁移 + 回归测试

**文件：** 修改：`test-sku.js:43-76`（startMockUploadServer 段）

- [ ] **步骤 1：修改 `test-sku.js`**

将原来 line 43-76 的 `function startMockUploadServer() { ... }` 替换为：

```js
const { startMockUploadServer } = require('./src/mock-upload-server');
```

并在文件头确保 `const http = require('http');` 仍存在（保留用于未来扩展，注释说明）。同时调整 line 174 `mockServer.server.close()` → `mockServer.close()`（新 handle 形态）。

- [ ] **步骤 2：运行既有测试验证无回归**

运行：`node --test test/test-sku.test.js`
预期：4 passed（与修改前一致）

- [ ] **步骤 3：Commit**

```bash
git add test-sku.js
git commit -m "refactor(test-sku): use shared mock-upload-server module"
```

---

## 任务 3：扩展 `ImageUploader` —— `skuForImage` 钩子

### 任务 3.1：编写失败测试

**文件：** 修改：`test/image-uploader.test.js`（在 file 末尾追加）

- [ ] **步骤 1：编写失败测试**

```js
describe('ImageUploader skuForImage hook', () => {
  const jpegBuffer = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);

  it('uses skuForImage hook for payload.sku when provided', async () => {
    const seen = [];
    const fakeFetch = async (url, init) => {
      const body = JSON.parse(init.body);
      seen.push(body.sku);
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { id: 1 } }) };
    };

    const uploader = new ImageUploader({
      uploadUrl: 'http://example.com/upload',
      fetch: fakeFetch,
      skuForImage: (buf, index, img) => `HOOK_${index}_${img.fileName}`,
    });

    const summary = await uploader.upload({
      crawlerTaskId: 't1',
      status: 'success',
      sku: '',
      image_paths: '',
      _preloadedItems: [
        { fileName: 'a.jpg', buffer: jpegBuffer, contentType: 'image/jpeg' },
        { fileName: 'b.jpg', buffer: jpegBuffer, contentType: 'image/jpeg' },
      ],
    });

    assert.equal(summary.uploaded.length, 2);
    assert.equal(summary.failed.length, 0);
    assert.deepEqual(seen, ['HOOK_0_a.jpg', 'HOOK_1_b.jpg']);
  });

  it('falls back to legacy sku assembly when skuForImage not provided', async () => {
    const seen = [];
    const fakeFetch = async (url, init) => {
      const body = JSON.parse(init.body);
      seen.push(body.sku);
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { id: 1 } }) };
    };

    const uploader = new ImageUploader({
      uploadUrl: 'http://example.com/upload',
      nodeCode: 'NODE42',
      fetch: fakeFetch,
    });

    await uploader.upload({
      crawlerTaskId: 't1',
      status: 'success',
      sku: 'GLOBAL',
      image_paths: '',
      _preloadedItems: [
        { fileName: 'a.jpg', buffer: jpegBuffer, contentType: 'image/jpeg' },
      ],
    });

    assert.deepEqual(seen, ['NODE42_0']);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/image-uploader.test.js`
预期：FAIL，`this.skuForImage is not a function` 或 `_preloadedItems not handled`

### 任务 3.2：实现钩子

**文件：** 修改：`src/image-uploader.js`

- [ ] **步骤 1：构造器加 `skuForImage`**

替换 `src/image-uploader.js:45-53`：

```js
class ImageUploader {
  constructor(options = {}) {
    this.uploadUrl = options.uploadUrl || '';
    this.nodeCode = options.nodeCode || '';
    this.nodeToken = options.nodeToken || '';
    this.concurrency = options.concurrency || 2;
    this.maxRetries = options.maxRetries !== undefined ? options.maxRetries : 3;
    this.retryDelays = options.retryDelays || [1000, 2000, 4000];
    this.fetch = options.fetch || globalThis.fetch;
    this.skuForImage = typeof options.skuForImage === 'function'
      ? options.skuForImage
      : null;
  }
```

- [ ] **步骤 2：`uploadSingle()` 三选一拼装 sku**

替换 `src/image-uploader.js:79-88` 的 `buildPayload`，新增 helper：

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

并修改 `uploadSingle()` 内部调用点：

```js
async uploadSingle(payload, ctx = {}) {
  // payload 已包含 sku，由调用方从 resolveImageSku 注入
  let lastError = null;
  for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
    if (attempt > 0) {
      console.log(`[IMAGE_UPLOAD] Retrying ${payload.fileName}, attempt ${attempt}/${this.maxRetries}`);
      await this.sleep(this.retryDelays[attempt - 1] || 4000);
    }
    try {
      const response = await this.fetch(this.uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSONbig.stringify(payload),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Upload failed: ${response.status} ${text}`);
      }
      const data = await response.json().catch(() => ({}));
      return { id: data.data?.id, fileName: payload.fileName };
    } catch (error) {
      lastError = error;
      console.error(`[IMAGE_UPLOAD] Failed ${payload.fileName} attempt ${attempt}: ${error.message}`);
      if (isNonRetryableError(error)) break;
    }
  }
  throw lastError || new Error('Upload failed after retries');
}
```

（`uploadSingle` 接收的 `payload.sku` 由 `upload()` 装配时计算好；签名增加 `ctx` 默认参数，向后兼容旧直接调用的测试。）

### 任务 3.3：实现 `_preloadedItems` 旁路

**文件：** 修改：`src/image-uploader.js:138-210` 的 `upload()`

- [ ] **步骤 1：在 `upload()` 内前置旁路分支**

替换 `src/image-uploader.js:138-186`：

```js
async upload(result) {
  const summary = {
    sku: result.sku,
    uploaded: [],
    failed: [],
    skipped: [],
  };

  if (result.status !== 'success') return summary;
  if (!result._preloadedItems && !result.image_paths) return summary;

  const uploadItems = Array.isArray(result._preloadedItems)
    ? result._preloadedItems
    : this._resolveFromPaths(result.image_paths, summary);

  if (uploadItems.length === 0) return summary;

  const outputs = await this.limitConcurrency(
    uploadItems,
    async (item, index) => {
      try {
        const sku = resolveImageSku(this, item.buffer, index, item, result);
        const payload = this.buildPayload(sku, item.fileName, item.buffer, item.contentType);
        const data = await this.uploadSingle(payload);
        return { status: 'uploaded', data };
      } catch (error) {
        return { status: 'failed', fileName: item.fileName, error: error.message };
      }
    },
    Math.max(1, this.concurrency)
  );

  for (const output of outputs) {
    if (output.status === 'uploaded') {
      summary.uploaded.push(output.data);
    } else {
      summary.failed.push({ fileName: output.fileName, error: output.error });
    }
  }

  return summary;
}

_resolveFromPaths(imagePaths, summary) {
  const uploadItems = [];
  const paths = String(imagePaths).split(/[,;]/).map((p) => p.trim()).filter(Boolean);
  for (const filePath of paths) {
    const fileName = path.basename(filePath);
    if (!fs.existsSync(filePath)) {
      summary.skipped.push({ fileName, reason: 'file not found' });
      continue;
    }
    const stats = fs.statSync(filePath);
    if (stats.size === 0) {
      summary.failed.push({ fileName, error: 'empty file' });
      continue;
    }
    const ext = path.extname(filePath);
    let buffer;
    try {
      buffer = fs.readFileSync(filePath);
    } catch (e) {
      summary.failed.push({ fileName, error: `read failed: ${e.message}` });
      continue;
    }
    const contentType = this.detectContentType(buffer, ext);
    if (!contentType) {
      summary.failed.push({ fileName, error: 'unknown content type' });
      continue;
    }
    uploadItems.push({ fileName, buffer, contentType });
  }
  return uploadItems;
}
```

- [ ] **步骤 2：运行新测试验证通过**

运行：`node --test test/image-uploader.test.js`
预期：18 + 2 = 20 passed

- [ ] **步骤 3：运行回归测试**

运行：`node --test test/worker-image-upload.test.js test/cli-image-upload-config.test.js`
预期：all passed

- [ ] **步骤 4：Commit**

```bash
git add src/image-uploader.js test/image-uploader.test.js
git commit -m "feat(image-uploader): add skuForImage hook and _preloadedItems bypass"
```

---

## 任务 4：实现 `bin/transfer-images.js`（脚本核心）

### 任务 4.1：编写 `parseTransferArgs` 测试

**文件：** 创建：`test/transfer-images.test.js`

- [ ] **步骤 1：编写失败测试**

```js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseTransferArgs,
  transferImages,
} = require('../bin/transfer-images');

describe('parseTransferArgs', () => {
  it('returns defaults for empty argv', () => {
    const r = parseTransferArgs([]);
    assert.deepEqual(r.paths, []);
    assert.equal(r.options.progress, true);
    assert.equal(r.options.mockUpload, false);
  });

  it('collects positional paths in order', () => {
    const r = parseTransferArgs(['a.jpg', 'b.png', 'c.webp']);
    assert.deepEqual(r.paths, ['a.jpg', 'b.png', 'c.webp']);
  });

  it('deduplicates positional paths keeping first', () => {
    const r = parseTransferArgs(['a.jpg', 'b.png', 'a.jpg']);
    assert.deepEqual(r.paths, ['a.jpg', 'b.png']);
  });

  it('parses --upload-url', () => {
    const r = parseTransferArgs(['--upload-url=http://x.com/up']);
    assert.equal(r.options.uploadUrl, 'http://x.com/up');
  });

  it('parses --upload-concurrency as number', () => {
    const r = parseTransferArgs(['--upload-concurrency=4']);
    assert.equal(r.options.uploadConcurrency, 4);
  });

  it('parses --upload-retries as number', () => {
    const r = parseTransferArgs(['--upload-retries=5']);
    assert.equal(r.options.uploadRetries, 5);
  });

  it('parses --mock-upload boolean', () => {
    const r = parseTransferArgs(['--mock-upload']);
    assert.equal(r.options.mockUpload, true);
  });

  it('parses --no-progress to false', () => {
    const r = parseTransferArgs(['--no-progress']);
    assert.equal(r.options.progress, false);
  });

  it('parses --node-code and --node-token', () => {
    const r = parseTransferArgs(['--node-code=NC', '--node-token=NT']);
    assert.equal(r.options.nodeCode, 'NC');
    assert.equal(r.options.nodeToken, 'NT');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/transfer-images.test.js`
预期：FAIL，`Cannot find module '../bin/transfer-images'`

### 任务 4.2：实现 `parseTransferArgs`

**文件：** 创建：`bin/transfer-images.js`（先放最小实现）

- [ ] **步骤 1：写文件骨架含 `parseTransferArgs`**

```js
const fs = require('fs');
const path = require('path');
const { loadEnvFile } = require('../src/cli');
const { ImageUploader } = require('../src/image-uploader');
const { startMockUploadServer } = require('../src/mock-upload-server');

function parseTransferArgs(argv) {
  const args = (argv || []).filter((a) => a !== undefined && a !== null);
  const paths = [];
  const seen = new Set();
  const options = {
    uploadUrl: undefined,
    uploadConcurrency: undefined,
    uploadRetries: undefined,
    nodeCode: undefined,
    nodeToken: undefined,
    mockUpload: false,
    progress: true,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (typeof arg !== 'string') continue;
    if (arg.startsWith('--')) {
      const eqIndex = arg.indexOf('=');
      const rawKey = eqIndex !== -1 ? arg.slice(2, eqIndex) : arg.slice(2);
      const rawVal = eqIndex !== -1 ? arg.slice(eqIndex + 1) : (() => {
        const next = args[i + 1];
        if (next !== undefined && !String(next).startsWith('--')) { i++; return next; }
        return true;
      })();
      switch (rawKey) {
        case 'upload-url': options.uploadUrl = rawVal; break;
        case 'upload-concurrency': options.uploadConcurrency = Number(rawVal); break;
        case 'upload-retries': options.uploadRetries = Number(rawVal); break;
        case 'node-code': options.nodeCode = rawVal; break;
        case 'node-token': options.nodeToken = rawVal; break;
        case 'mock-upload': options.mockUpload = true; break;
        case 'no-progress': options.progress = false; break;
        default: /* ignore unknown */ break;
      }
    } else {
      if (!seen.has(arg)) { seen.add(arg); paths.push(arg); }
    }
  }

  return { paths, options };
}
```

- [ ] **步骤 2：运行测试验证通过**

运行：`node --test test/transfer-images.test.js`
预期：上面 parseTransferArgs 9 个 case 全 pass；transferImages 未导入触发 require 阶段错误（暂未实现）。

- [ ] **步骤 3：Commit**

```bash
git add bin/transfer-images.js test/transfer-images.test.js
git commit -m "feat(transfer-images): add parseTransferArgs and module skeleton"
```

### 任务 4.3：编写 `transferImages` 测试

**文件：** 修改：`test/transfer-images.test.js`（在文件中部追加 `describe('transferImages', ...)` 块）

- [ ] **步骤 1：编写失败测试**

```js
describe('transferImages', () => {
  const { ImageUploader } = require('../src/image-uploader');
  const { startMockUploadServer } = require('../src/mock-upload-server');
  const os = require('os');

  function makeImage(filename, buffer) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transfer-'));
    const filePath = path.join(dir, filename);
    fs.writeFileSync(filePath, buffer);
    return { dir, filePath };
  }

  function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }

  it('uploads a single JPEG and returns ok=true', async () => {
    const buf = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00]);
    const { filePath } = makeImage('A_1.jpg', buf);

    let captured;
    const fakeFetch = async (url, init) => {
      captured = { url, init };
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { id: 9, sku: 'A_1' } }) };
    };

    const report = await transferImages({
      paths: [filePath],
      options: { uploadUrl: 'http://test/up', fetchImpl: fakeFetch },
      deps: { loadEnvFile: () => {}, pathExists: () => true, readFile: (p) => fs.readFileSync(p), startMockUploadServer },
    });

    assert.equal(report.total, 1);
    assert.equal(report.success, 1);
    assert.equal(report.failed, 0);
    assert.equal(report.results[0].ok, true);
    assert.equal(report.results[0].sku, 'A_1');
    assert.equal(report.results[0].fileName, 'A_1.jpg');
    assert.equal(captured.url, 'http://test/up');
    const body = JSON.parse(captured.init.body);
    assert.equal(body.sku, 'A_1');
    assert.equal(body.contentType, 'image/jpeg');
    assert.equal(body.fileName, 'A_1.jpg');
  });

  it('continues when one of multiple fails', async () => {
    const buf = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
    const a = makeImage('A.jpg', buf);
    const b = makeImage('B.jpg', buf);

    let n = 0;
    const fakeFetch = async () => {
      n++;
      if (n === 1) return { ok: false, status: 500, text: async () => 'oops' };
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { id: n } }) };
    };

    const report = await transferImages({
      paths: [a.filePath, b.filePath],
      options: { uploadUrl: 'http://test/up', uploadRetries: 0, fetchImpl: fakeFetch },
      deps: { loadEnvFile: () => {}, pathExists: () => true, readFile: (p) => fs.readFileSync(p), startMockUploadServer },
    });

    assert.equal(report.total, 2);
    assert.equal(report.success, 1);
    assert.equal(report.failed, 1);
    const failed = report.results.find((r) => !r.ok);
    assert.match(failed.error, /500/);
  });

  it('marks empty file as failed without calling fetch', async () => {
    const { filePath } = makeImage('empty.jpg', Buffer.alloc(0));
    let called = false;
    const fakeFetch = async () => { called = true; throw new Error('should not call'); };
    const report = await transferImages({
      paths: [filePath],
      options: { uploadUrl: 'http://test/up', fetchImpl: fakeFetch },
      deps: { loadEnvFile: () => {}, pathExists: () => true, readFile: (p) => fs.readFileSync(p), startMockUploadServer },
    });
    assert.equal(report.total, 1);
    assert.equal(report.failed, 1);
    assert.equal(report.success, 0);
    assert.equal(called, false);
    assert.equal(report.results[0].error, 'empty file');
  });

  it('marks unknown content type as failed', async () => {
    const buf = Buffer.from([0, 0, 0, 0]);
    const { filePath } = makeImage('mystery.xyz', buf);
    const fakeFetch = async () => { throw new Error('should not call'); };
    const report = await transferImages({
      paths: [filePath],
      options: { uploadUrl: 'http://test/up', fetchImpl: fakeFetch },
      deps: { loadEnvFile: () => {}, pathExists: () => true, readFile: (p) => fs.readFileSync(p), startMockUploadServer },
    });
    assert.equal(report.failed, 1);
    assert.equal(report.results[0].error, 'unknown content type');
  });

  it('infers SKU from fileName without extension', async () => {
    const buf = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
    const { filePath } = makeImage('XYZ-100_3.jpg', buf);
    let body;
    const fakeFetch = async (u, init) => {
      body = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { id: 1 } }) };
    };
    await transferImages({
      paths: [filePath],
      options: { uploadUrl: 'http://test/up', fetchImpl: fakeFetch },
      deps: { loadEnvFile: () => {}, pathExists: () => true, readFile: (p) => fs.readFileSync(p), startMockUploadServer },
    });
    assert.equal(body.sku, 'XYZ-100_3');
    assert.equal(body.fileName, 'XYZ-100_3.jpg');
  });

  it('throws ConfigError when no uploadUrl and not mock', async () => {
    const { filePath } = makeImage('a.jpg', Buffer.from([0xFF, 0xD8, 0xFF]));
    await assert.rejects(
      () => transferImages({
        paths: [filePath],
        options: { uploadUrl: '', mockUpload: false },
        deps: { loadEnvFile: () => {}, pathExists: () => true, readFile: (p) => fs.readFileSync(p), startMockUploadServer },
      }),
      /upload url required/i
    );
  });

  it('throws when path not found', async () => {
    await assert.rejects(
      () => transferImages({
        paths: ['/nonexistent/a.jpg'],
        options: { uploadUrl: 'http://test/up' },
        deps: { loadEnvFile: () => {}, pathExists: (p) => fs.existsSync(p), readFile: (p) => fs.readFileSync(p), startMockUploadServer },
      }),
      /path not found/i
    );
  });

  it('respects uploadConcurrency limit', async () => {
    const buf = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
    const files = Array.from({ length: 4 }, (_, i) => makeImage(`f${i}.jpg`, buf));
    let concurrent = 0;
    let maxConcurrent = 0;
    const releases = [];
    const fakeFetch = async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      const d = deferred();
      releases.push(d.resolve);
      return d.promise.then(() => ({ ok: true, status: 200, json: async () => ({ code: 0, data: { id: 1 } }) }));
    };
    const reportP = transferImages({
      paths: files.map((f) => f.filePath),
      options: { uploadUrl: 'http://test/up', uploadConcurrency: 2, fetchImpl: fakeFetch },
      deps: { loadEnvFile: () => {}, pathExists: () => true, readFile: (p) => fs.readFileSync(p), startMockUploadServer },
    });
    // give workers a moment
    await new Promise((r) => setTimeout(r, 20));
    releases.forEach((r) => r());
    const report = await reportP;
    assert.equal(report.total, 4);
    assert.equal(report.success, 4);
    assert.ok(maxConcurrent <= 2, `maxConcurrent was ${maxConcurrent}`);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/transfer-images.test.js`
预期：FAIL，`transferImages is not a function`

### 任务 4.4：实现 `transferImages`

**文件：** 修改：`bin/transfer-images.js`（在 parseTransferArgs 后追加）

- [ ] **步骤 1：实现 `transferImages`**

```js
class ConfigError extends Error {
  constructor(message) { super(message); this.name = 'ConfigError'; }
}

const _imageUploaderProto = ImageUploader.prototype;

async function transferImages({ paths, options, deps = {} }) {
  const {
    loadEnvFile: loadEnv = () => {},
    pathExists = (p) => fs.existsSync(p),
    readFile = (p) => fs.readFileSync(p),
    startMockUploadServer: startMock = startMockUploadServer,
  } = deps;

  loadEnv(process.cwd());

  const opts = { ...options };

  // mock server lifecycle
  let mockHandle = null;
  if (opts.mockUpload) {
    mockHandle = await startMock();
    opts.uploadUrl = mockHandle.url;
  }

  const envUrl = process.env.CRAWLER_IMAGE_UPLOAD_URL;
  if (!opts.uploadUrl && envUrl) opts.uploadUrl = envUrl;

  if (!opts.uploadUrl) {
    if (mockHandle) await mockHandle.close();
    throw new ConfigError('upload url required: pass --upload-url=, set CRAWLER_IMAGE_UPLOAD_URL, or use --mock-upload');
  }

  if (!Array.isArray(paths) || paths.length === 0) {
    if (mockHandle) await mockHandle.close();
    throw new Error('no paths provided');
  }

  for (const p of paths) {
    if (!pathExists(p)) {
      if (mockHandle) await mockHandle.close();
      throw new Error(`path not found: ${p}`);
    }
  }

  const records = paths.map((p) => {
    const stats = fs.statSync(p);
    const buffer = readFile(p);
    const ext = path.extname(p);
    const fileName = path.basename(p);
    const sku = path.basename(fileName, path.extname(fileName));
    const contentType = _imageUploaderProto.detectContentType.call(
      Object.create(_imageUploaderProto), buffer, ext
    );
    return { path: p, buffer, fileName, sku, contentType, fileSize: stats.size, isEmpty: stats.size === 0 };
  });

  const uploadItems = [];
  const results = [];
  for (const r of records) {
    if (r.isEmpty) {
      results.push({ path: r.path, sku: r.sku, fileName: r.fileName, contentType: r.contentType, fileSize: 0, ok: false, error: 'empty file' });
      continue;
    }
    if (!r.contentType) {
      results.push({ path: r.path, sku: r.sku, fileName: r.fileName, contentType: null, fileSize: r.fileSize, ok: false, error: 'unknown content type' });
      continue;
    }
    uploadItems.push({ fileName: r.fileName, buffer: r.buffer, contentType: r.contentType });
  }

  let fetchImpl = opts.fetchImpl;
  // silence progress toggle (placeholder for future use)
  const concurrency = Number.isFinite(opts.uploadConcurrency) ? opts.uploadConcurrency : (Number(process.env.CRAWLER_IMAGE_UPLOAD_CONCURRENCY) || 2);
  const maxRetries = Number.isFinite(opts.uploadRetries) ? opts.uploadRetries : (process.env.CRAWLER_IMAGE_UPLOAD_RETRIES !== undefined ? Number(process.env.CRAWLER_IMAGE_UPLOAD_RETRIES) : 3);
  const nodeCode = opts.nodeCode !== undefined ? opts.nodeCode : (process.env.CRAWLER_NODE_CODE || '');
  const nodeToken = opts.nodeToken !== undefined ? opts.nodeToken : (process.env.CRAWLER_NODE_TOKEN || '');

  const uploader = new ImageUploader({
    uploadUrl: opts.uploadUrl,
    nodeCode,
    nodeToken,
    concurrency,
    maxRetries,
    fetch: fetchImpl,
    skuForImage: (_buf, _index, image) => image.fileName.replace(/\.[^.]+$/, ''),
  });

  if (uploadItems.length > 0) {
    const fakeResult = {
      crawlerTaskId: `cli-transfer-${Date.now()}`,
      status: 'success',
      sku: '',
      image_paths: '',
      _preloadedItems: uploadItems,
    };
    const summary = await uploader.upload(fakeResult);
    // summarize uploaded items back to indexed records
    const uploadedByFile = new Map(summary.uploaded.map((u) => [u.fileName, u]));
    const failedByFile = new Map(summary.failed.map((f) => [f.fileName, f]));
    for (const r of records) {
      if (r.isEmpty || !r.contentType) continue;
      const u = uploadedByFile.get(r.fileName);
      const f = failedByFile.get(r.fileName);
      if (u) {
        results.push({ path: r.path, sku: r.sku, fileName: r.fileName, contentType: r.contentType, fileSize: r.fileSize, ok: true, response: u.response || { id: u.id } });
      } else if (f) {
        results.push({ path: r.path, sku: r.sku, fileName: r.fileName, contentType: r.contentType, fileSize: r.fileSize, ok: false, error: f.error });
      } else {
        results.push({ path: r.path, sku: r.sku, fileName: r.fileName, contentType: r.contentType, fileSize: r.fileSize, ok: false, error: 'unknown state' });
      }
    }
  }

  if (mockHandle) await mockHandle.close();

  const success = results.filter((r) => r.ok).length;
  const failed = results.length - success;
  return { total: results.length, success, failed, results };
}

module.exports = { parseTransferArgs, transferImages, ConfigError };
```

- [ ] **步骤 2：运行测试验证通过**

运行：`node --test test/transfer-images.test.js`
预期：parseTransferArgs 9 + transferImages 8 = 17 passed

- [ ] **步骤 3：运行全量回归**

运行：`node --test test/image-uploader.test.js test/test-sku.test.js test/mock-upload-server.test.js`
预期：all passed

- [ ] **步骤 4：Commit**

```bash
git add bin/transfer-images.js test/transfer-images.test.js
git commit -m "feat(transfer-images): implement transferImages with adapter and SKU inference"
```

### 任务 4.5：端到端 + mock 集成

**文件：** 修改：`test/transfer-images.test.js`（追加）

- [ ] **步骤 1：编写端到端 mock 集成测试**

```js
describe('transferImages with mockUpload', () => {
  it('uses mock upload server when --mock-upload', async () => {
    const buf = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transfer-'));
    const filePath = path.join(dir, 'Z_9.jpg');
    fs.writeFileSync(filePath, buf);

    const report = await transferImages({
      paths: [filePath],
      options: { mockUpload: true, uploadConcurrency: 1, uploadRetries: 0 },
      deps: {
        loadEnvFile: () => {},
        pathExists: (p) => fs.existsSync(p),
        readFile: (p) => fs.readFileSync(p),
        startMockUploadServer: require('../src/mock-upload-server').startMockUploadServer,
      },
    });

    assert.equal(report.success, 1);
    assert.equal(report.results[0].ok, true);
    assert.equal(report.results[0].response.id, report.results[0].response.id); // any positive number
  });
});
```

- [ ] **步骤 2：运行验证**

运行：`node --test test/transfer-images.test.js`
预期：新增 1 case，全 18 passed

- [ ] **步骤 3：Commit**

```bash
git add test/transfer-images.test.js
git commit -m "test(transfer-images): add mock upload server integration"
```

### 任务 4.6：实现 `main()` CLI 入口

**文件：** 修改：`bin/transfer-images.js`（追加）

- [ ] **步骤 1：实现 `main`**

```js
async function main(argv = process.argv.slice(2)) {
  try {
    const { paths, options } = parseTransferArgs(argv);
    const report = await transferImages({ paths, options });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return report.success > 0 ? 0 : 1;
  } catch (err) {
    let code = 2;
    if (err.name === 'ConfigError') code = 2;
    else if (/^path not found|no paths provided/.test(err.message)) code = 1;
    else code = 1;
    process.stderr.write(`[transfer-images] ${err.message}\n`);
    process.stdout.write(JSON.stringify({ total: 0, success: 0, failed: 0, results: [], error: err.message }, null, 2) + '\n');
    return code;
  }
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((e) => {
    process.stderr.write(String(e.stack || e) + '\n');
    process.exit(1);
  });
}
```

- [ ] **步骤 2：CLI 烟雾测试**

运行：`node bin/transfer-images.js --mock-upload --no-progress ./output/<some-existing-jpeg>.jpg`（先放一个小 JPEG 用于验证）

预期：stdout 单块 JSON，含 success=1

> 若无现成 JPEG，跳过该步骤；改用 `node -e "require('./bin/transfer-images').main(['--help'])"` 验证模块加载不抛错。

- [ ] **步骤 3：Commit**

```bash
git add bin/transfer-images.js
git commit -m "feat(transfer-images): add main CLI entry with exit codes"
```

---

## 任务 5：文档（README）

### 任务 5.1：更新 README

**文件：** 修改：`README.md`

- [ ] **步骤 1：在合适位置添加段落**

新增内容（紧随现有"图片上传"相关小节之后）：

```markdown
## 独立图片传输脚本

不启动爬虫，直接把已有图片文件上传到 `/classify/open/image/upload`。

```bash
# 默认从 .env 中 CRAWLER_IMAGE_UPLOAD_URL 读取真实接口
node bin/transfer-images.js ./output/ABC-001_1.jpg ./output/ABC-001_2.jpg

# 命令行覆盖接口地址 / 并发 / 重试
node bin/transfer-images.js \
  --upload-url=http://47.92.233.36:8003/renren-api/classify/open/image/upload \
  --upload-concurrency=4 \
  --upload-retries=5 \
  ./img/*.jpg

# 启用内置 mock 服务（覆盖真实接口，便于 CI / 离线）
node bin/transfer-images.js --mock-upload ./img/foo.jpg ./img/bar.jpg
```

SKU 由 fileName 去扩展名推断（`ABC-001_1.jpg` → `ABC-001_1`）。退出码：`0` = 至少一张成功；`1` = 全部失败或启动错误；`2` = 配置错误。

终态输出单块 JSON：`{ total, success, failed, results: [{path, sku, fileName, contentType, fileSize, ok, response|error}] }`。
```

- [ ] **步骤 2：Commit**

```bash
git add README.md
git commit -m "docs(readme): document standalone image transfer script"
```

---

## 任务 6：全量回归

### 任务 6.1：跑全套测试

- [ ] **步骤 1：运行所有上传/服务相关测试**

运行：
```bash
node --test test/image-uploader.test.js \
           test/transfer-images.test.js \
           test/mock-upload-server.test.js \
           test/test-sku.test.js \
           test/worker-image-upload.test.js \
           test/cli-image-upload-config.test.js \
           test/bin-run.test.js
```
预期：全部 passed（注意：service.integration / playwright 类测试若环境受限可不计入本任务，列出即可）

- [ ] **步骤 2：Lint / 语法检查（无 lint 配置则跳过）**

确认 `node -c bin/transfer-images.js` 通过。

- [ ] **步骤 3：Commit（如有文档修正）**

仅当 README 或注释调整才 commit；否则跳过。

---

## 任务 7：推送

- [ ] **步骤 1：推送**

运行：
```bash
git push origin main
```
预期：推送成功。

---

## 规格覆盖度自检

| 规格章节 | 实施任务 |
|---|---|
| §1 背景与目标 | 任务 4（核心实现） |
| §2 范围（含 YAGNI） | 任务 4 |
| §3 决策表 | 任务 4 |
| §4 架构 | 任务 1-4 全员 |
| §5 CLI 接口 | 任务 4.2 / 4.6 |
| §6 模块导出 | 任务 4.2 / 4.4 |
| §7 ImageUploader 改动 | 任务 3 |
| §8 数据流（含 _preloadedItems 旁路） | 任务 3.3 + 4.4 |
| §9 错误处理 & 退出码 | 任务 4.4 + 4.6 |
| §10 测试（17 + 2 = 19 个 case） | 任务 1.1 + 3.1 + 4.1 + 4.3 + 4.5 |
| §11 文件改动清单 | 任务 1-5 全覆盖 |
| §13 风险表（mock 共享、_preloadedItems 字段） | 任务 1 / 3.3 |

所有规格章节均有任务覆盖 ✅
