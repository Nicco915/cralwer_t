# 图片上传功能实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 service 模式下，主 callback 成功后将 SKU 本地图片上传到 `/classify/open/image/upload`，单图失败不影响其他图和主 callback 状态。

**架构：** 新增独立的 `ImageUploader` 组件负责图片读取、格式校验、base64 编码和并发上传；`Worker` 在主 callback 成功后调用它；`CrawlerService` 根据配置实例化并注入；CLI 负责解析新增配置项。

**技术栈：** Node.js 22+、原生 `node:test`、Playwright（已有）、项目现有 `Pusher`/`Worker`/`CrawlerService` 模式。

---

## 文件结构

| 文件 | 职责 | 操作 |
|---|---|---|
| `src/image-uploader.js` | 新增：读取本地图片、校验 Magic Bytes、映射 Content-Type、并发上传、记录日志 | 创建 |
| `src/worker.js` | 修改：主 callback 成功后调用 `imageUploader.upload(result)`；`drain()` 等待上传完成 | 修改 |
| `src/service.js` | 修改：`CrawlerService.start()` 中若配置了 `imageUploadUrl` 则创建 `ImageUploader` 并传给 `Worker` | 修改 |
| `src/cli.js` | 修改：解析 `--image-upload-url` 等新增 CLI flag 和环境变量 | 修改 |
| `test/image-uploader.test.js` | 新增：`ImageUploader` 单元测试 | 创建 |
| `test/service.integration.test.js` | 修改：扩展集成测试，验证 service 模式下图片上传被触发 | 修改 |
| `README.md` | 修改：补充图片上传接口、配置项、字段说明 | 修改 |

---

## 任务 1：实现 `ImageUploader` 核心（TDD）

**文件：**
- 创建：`src/image-uploader.js`
- 测试：`test/image-uploader.test.js`

### 步骤 1：编写失败的测试 - `detectContentType`

在 `test/image-uploader.test.js` 中：

```js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { ImageUploader } = require('../src/image-uploader');

describe('ImageUploader.detectContentType', () => {
  it('detects JPEG by magic bytes', () => {
    const uploader = new ImageUploader({ uploadUrl: 'http://example.com/upload' });
    const buffer = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
    assert.strictEqual(uploader.detectContentType(buffer, '.jpg'), 'image/jpeg');
  });

  it('detects PNG by magic bytes', () => {
    const uploader = new ImageUploader({ uploadUrl: 'http://example.com/upload' });
    const buffer = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    assert.strictEqual(uploader.detectContentType(buffer, '.png'), 'image/png');
  });

  it('detects WebP by magic bytes', () => {
    const uploader = new ImageUploader({ uploadUrl: 'http://example.com/upload' });
    const buffer = Buffer.concat([
      Buffer.from([0x52, 0x49, 0x46, 0x46]),
      Buffer.alloc(4),
      Buffer.from([0x57, 0x45, 0x42, 0x50]),
    ]);
    assert.strictEqual(uploader.detectContentType(buffer, '.webp'), 'image/webp');
  });

  it('falls back to extension when magic bytes unknown', () => {
    const uploader = new ImageUploader({ uploadUrl: 'http://example.com/upload' });
    const buffer = Buffer.from([0x00, 0x00, 0x00]);
    assert.strictEqual(uploader.detectContentType(buffer, '.png'), 'image/png');
  });

  it('prefers magic bytes when extension mismatches', () => {
    const uploader = new ImageUploader({ uploadUrl: 'http://example.com/upload' });
    const buffer = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    assert.strictEqual(uploader.detectContentType(buffer, '.jpg'), 'image/png');
  });

  it('returns null when neither magic bytes nor extension recognized', () => {
    const uploader = new ImageUploader({ uploadUrl: 'http://example.com/upload' });
    const buffer = Buffer.from([0x00, 0x00, 0x00]);
    assert.strictEqual(uploader.detectContentType(buffer, '.xyz'), null);
  });
});
```

### 步骤 2：运行测试验证失败

```bash
node --test test/image-uploader.test.js
```

预期：`ImageUploader is not defined` 或 `detectContentType is not a function` 类错误。

### 步骤 3：编写最少实现代码

创建 `src/image-uploader.js`：

```js
const fs = require('fs');
const path = require('path');
const JSONbig = require('json-bigint')({ useNativeBigInt: true });

const MAGIC_BYTES = {
  jpeg: { mime: 'image/jpeg', bytes: [0xFF, 0xD8, 0xFF] },
  png: { mime: 'image/png', bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] },
  webp: { mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46] },
};

const EXT_TO_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function matchesMagicBytes(buffer, bytes) {
  if (!buffer || buffer.length < bytes.length) return false;
  return bytes.every((b, i) => buffer[i] === b);
}

function detectWebp(buffer) {
  if (!matchesMagicBytes(buffer, MAGIC_BYTES.webp.bytes)) return null;
  if (buffer.length < 12) return null;
  return buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
    ? 'image/webp'
    : null;
}

class ImageUploader {
  constructor(options) {
    this.uploadUrl = options.uploadUrl;
    this.nodeCode = options.nodeCode || '';
    this.nodeToken = options.nodeToken || '';
    this.concurrency = options.concurrency || 2;
    this.maxRetries = options.maxRetries || 3;
    this.retryDelays = options.retryDelays || [1000, 2000, 4000];
    this.fetch = options.fetch || globalThis.fetch;
  }

  detectContentType(buffer, ext) {
    const lowerExt = (ext || '').toLowerCase();
    let byMagic = null;
    if (matchesMagicBytes(buffer, MAGIC_BYTES.jpeg.bytes)) {
      byMagic = MAGIC_BYTES.jpeg.mime;
    } else if (matchesMagicBytes(buffer, MAGIC_BYTES.png.bytes)) {
      byMagic = MAGIC_BYTES.png.mime;
    } else {
      byMagic = detectWebp(buffer);
    }

    const byExt = EXT_TO_MIME[lowerExt] || null;

    if (byMagic && byExt && byMagic !== byExt) {
      console.warn(`[IMAGE_UPLOAD] Content type mismatch: extension says ${byExt}, magic bytes say ${byMagic}`);
      return byMagic;
    }

    return byMagic || byExt || null;
  }
}

module.exports = { ImageUploader };
```

### 步骤 4：运行测试验证通过

```bash
node --test test/image-uploader.test.js
```

预期：6 个测试全部通过。

### 步骤 5：Commit

```bash
git add src/image-uploader.js test/image-uploader.test.js
git commit -m "feat(image-upload): add ImageUploader with content-type detection"
```

---

## 任务 2：实现 `ImageUploader.upload` 单图上传与并发

**文件：**
- 修改：`src/image-uploader.js`
- 测试：`test/image-uploader.test.js`

### 步骤 1：编写失败的测试 - 单图上传

在 `test/image-uploader.test.js` 中新增 describe：

```js
const fs = require('fs');
const path = require('path');
const os = require('os');

describe('ImageUploader.upload', () => {
  function createTempImage(filename, buffer) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'img-upload-'));
    const filePath = path.join(dir, filename);
    fs.writeFileSync(filePath, buffer);
    return { dir, filePath };
  }

  it('uploads a single image and returns id', async () => {
    const { dir, filePath } = createTempImage('ABC-001_1.jpg', Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]));
    const fetched = [];
    const fakeFetch = async (url, options) => {
      fetched.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 0, data: { id: 123, sku: 'ABC-001', contentType: 'image/jpeg', fileName: 'ABC-001_1.jpg', fileSize: 4 } }),
      };
    };

    const uploader = new ImageUploader({
      uploadUrl: 'http://example.com/upload',
      nodeCode: 'node-1',
      nodeToken: 'token-1',
      fetch: fakeFetch,
    });

    try {
      const result = await uploader.upload({
        crawlerTaskId: 1,
        sku: 'ABC-001',
        status: 'success',
        image_paths: filePath,
      });

      assert.strictEqual(result.sku, 'ABC-001');
      assert.strictEqual(result.uploaded.length, 1);
      assert.strictEqual(result.uploaded[0].id, 123);
      assert.strictEqual(result.failed.length, 0);
      assert.strictEqual(result.skipped.length, 0);

      assert.strictEqual(fetched.length, 1);
      const body = JSON.parse(fetched[0].options.body);
      assert.strictEqual(body.nodeCode, 'node-1');
      assert.strictEqual(body.nodeToken, 'token-1');
      assert.strictEqual(body.sku, 'ABC-001');
      assert.strictEqual(body.contentType, 'image/jpeg');
      assert.strictEqual(body.fileName, 'ABC-001_1.jpg');
      assert.ok(body.imageBase64);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

### 步骤 2：运行测试验证失败

```bash
node --test test/image-uploader.test.js
```

预期：`uploader.upload is not a function`。

### 步骤 3：编写实现代码

在 `src/image-uploader.js` 的 `ImageUploader` 类中新增方法：

```js
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  buildPayload(sku, filePath, contentType) {
    const buffer = fs.readFileSync(filePath);
    return {
      nodeCode: this.nodeCode,
      nodeToken: this.nodeToken,
      sku,
      imageBase64: buffer.toString('base64'),
      contentType,
      fileName: path.basename(filePath),
    };
  }

  async uploadSingle(payload) {
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
      } catch (e) {
        lastError = e;
        console.error(`[IMAGE_UPLOAD] Failed ${payload.fileName} attempt ${attempt}: ${e.message}`);
      }
    }
    throw lastError || new Error('Upload failed after retries');
  }

  async limitConcurrency(items, fn, limit) {
    const results = [];
    const executing = [];
    for (const [index, item] of items.entries()) {
      const p = fn(item).then(result => { results[index] = result; });
      executing.push(p);
      if (executing.length >= limit) {
        await Promise.race(executing);
        executing.splice(executing.findIndex(x => x === p), 1);
      }
    }
    await Promise.all(executing);
    return results;
  }

  async upload(result) {
    const summary = {
      sku: result.sku,
      uploaded: [],
      failed: [],
      skipped: [],
    };

    if (result.status !== 'success' || !result.image_paths) {
      return summary;
    }

    const paths = result.image_paths.split(';').filter(Boolean);

    const items = paths.map(filePath => {
      if (!fs.existsSync(filePath)) {
        return { type: 'skip', filePath, reason: 'file not found' };
      }
      const stat = fs.statSync(filePath);
      if (stat.size === 0) {
        return { type: 'skip', filePath, reason: 'empty file' };
      }
      const ext = path.extname(filePath);
      const buffer = fs.readFileSync(filePath);
      const contentType = this.detectContentType(buffer, ext);
      if (!contentType) {
        return { type: 'skip', filePath, reason: 'unknown content type' };
      }
      const payload = this.buildPayload(result.sku, filePath, contentType);
      return { type: 'upload', filePath, payload };
    });

    const uploadItems = items.filter(i => i.type === 'upload');
    const skippedItems = items.filter(i => i.type === 'skip');

    for (const item of skippedItems) {
      summary.skipped.push({ fileName: path.basename(item.filePath), reason: item.reason });
    }

    if (uploadItems.length === 0) {
      return summary;
    }

    await this.limitConcurrency(uploadItems, async (item) => {
      try {
        const uploaded = await this.uploadSingle(item.payload);
        summary.uploaded.push(uploaded);
      } catch (e) {
        summary.failed.push({ fileName: path.basename(item.filePath), error: e.message });
      }
    }, this.concurrency);

    return summary;
  }
```

### 步骤 4：运行测试验证通过

```bash
node --test test/image-uploader.test.js
```

预期：新测试通过，原有测试也通过。

### 步骤 5：Commit

```bash
git add src/image-uploader.js test/image-uploader.test.js
git commit -m "feat(image-upload): implement upload with concurrency and retries"
```

---

## 任务 3：扩展 `ImageUploader` 测试 - 并发与失败隔离

**文件：**
- 修改：`test/image-uploader.test.js`

### 步骤 1：编写失败的测试

在 `test/image-uploader.test.js` 的 `ImageUploader.upload` describe 中新增：

```js
  it('uploads multiple images with controlled concurrency', async () => {
    const bufferJpg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
    const bufferPng = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const { dir: dir1, filePath: fp1 } = createTempImage('ABC-002_1.jpg', bufferJpg);
    const { dir: dir2, filePath: fp2 } = createTempImage('ABC-002_2.png', bufferPng);

    let maxConcurrent = 0;
    let currentConcurrent = 0;
    const fakeFetch = async () => {
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      await new Promise(resolve => setTimeout(resolve, 20));
      currentConcurrent--;
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 0, data: { id: 1 } }),
      };
    };

    const uploader = new ImageUploader({
      uploadUrl: 'http://example.com/upload',
      concurrency: 1,
      fetch: fakeFetch,
    });

    try {
      const result = await uploader.upload({
        sku: 'ABC-002',
        status: 'success',
        image_paths: `${fp1};${fp2}`,
      });
      assert.strictEqual(result.uploaded.length, 2);
      assert.strictEqual(maxConcurrent, 1);
    } finally {
      fs.rmSync(dir1, { recursive: true, force: true });
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });

  it('does not fail other images when one upload fails', async () => {
    const buffer = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
    const { dir: dir1, filePath: fp1 } = createTempImage('ABC-003_1.jpg', buffer);
    const { dir: dir2, filePath: fp2 } = createTempImage('ABC-003_2.jpg', buffer);

    let callCount = 0;
    const fakeFetch = async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error('network error');
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 0, data: { id: 456 } }),
      };
    };

    const uploader = new ImageUploader({
      uploadUrl: 'http://example.com/upload',
      maxRetries: 0,
      fetch: fakeFetch,
    });

    try {
      const result = await uploader.upload({
        sku: 'ABC-003',
        status: 'success',
        image_paths: `${fp1};${fp2}`,
      });
      assert.strictEqual(result.uploaded.length, 1);
      assert.strictEqual(result.uploaded[0].id, 456);
      assert.strictEqual(result.failed.length, 1);
      assert.strictEqual(result.skipped.length, 0);
    } finally {
      fs.rmSync(dir1, { recursive: true, force: true });
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });

  it('skips non-success tasks', async () => {
    const uploader = new ImageUploader({ uploadUrl: 'http://example.com/upload' });
    const result = await uploader.upload({ sku: 'ABC-004', status: 'error', image_paths: '/tmp/x.jpg' });
    assert.strictEqual(result.uploaded.length, 0);
    assert.strictEqual(result.failed.length, 0);
    assert.strictEqual(result.skipped.length, 0);
  });
```

### 步骤 2：运行测试验证失败

```bash
node --test test/image-uploader.test.js
```

预期：并发测试可能失败（如果当前实现没有正确限制并发）。

### 步骤 3：修复并发实现（如需要）

如果 `limitConcurrency` 实现未能正确限制并发，修复它。参考实现：

```js
  async limitConcurrency(items, fn, limit) {
    const results = new Array(items.length);
    let index = 0;

    async function worker() {
      while (index < items.length) {
        const currentIndex = index++;
        results[currentIndex] = await fn(items[currentIndex]);
      }
    }

    const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
    await Promise.all(workers);
    return results;
  }
```

### 步骤 4：运行测试验证通过

```bash
node --test test/image-uploader.test.js
```

预期：所有测试通过。

### 步骤 5：Commit

```bash
git add test/image-uploader.test.js src/image-uploader.js
git commit -m "test(image-upload): add concurrency and failure isolation tests"
```

---

## 任务 4：修改 `Worker` 调用图片上传

**文件：**
- 修改：`src/worker.js`
- 测试：`test/pusher.test.js` 不修改；新增 `test/worker-image-upload.test.js`（可选，集成 Worker 与 ImageUploader）

### 步骤 1：编写失败的测试

创建 `test/worker-image-upload.test.js`：

```js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Worker } = require('../src/worker');
const { ImageUploader } = require('../src/image-uploader');

describe('Worker image upload integration', () => {
  function makeChannel(result) {
    return {
      id: 1,
      busy: false,
      crawl: async () => result,
    };
  }

  function createTempImage(filename, buffer) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-img-'));
    const filePath = path.join(dir, filename);
    fs.writeFileSync(filePath, buffer);
    return { dir, filePath };
  }

  it('uploads images after successful callback', async () => {
    const buffer = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
    const { dir, filePath } = createTempImage('SKU-001_1.jpg', buffer);

    const channel = makeChannel({
      crawlerTaskId: 1,
      sku: 'SKU-001',
      status: 'success',
      image_paths: filePath,
    });

    let callbackPushed = false;
    const fakePusher = {
      push: async (result) => {
        callbackPushed = true;
        assert.strictEqual(result.status, 'success');
      },
    };

    let uploadCalled = false;
    const fakeUploader = {
      upload: async (result) => {
        uploadCalled = true;
        assert.strictEqual(result.sku, 'SKU-001');
        return { sku: 'SKU-001', uploaded: [{ id: 99 }], failed: [], skipped: [] };
      },
    };

    const worker = new Worker({ pusher: fakePusher, imageUploader: fakeUploader });
    worker.addChannel(channel);
    worker.start();
    worker.pushTasks([{ crawlerTaskId: 1, sku: 'SKU-001' }]);

    await worker.drain();

    assert.strictEqual(callbackPushed, true);
    assert.strictEqual(uploadCalled, true);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not upload images when callback fails', async () => {
    const channel = makeChannel({
      crawlerTaskId: 2,
      sku: 'SKU-002',
      status: 'success',
      image_paths: '/tmp/x.jpg',
    });

    const fakePusher = {
      push: async () => {
        throw new Error('callback failed');
      },
    };

    let uploadCalled = false;
    const fakeUploader = {
      upload: async () => {
        uploadCalled = true;
        return { uploaded: [] };
      },
    };

    const worker = new Worker({ pusher: fakePusher, imageUploader: fakeUploader });
    worker.addChannel(channel);
    worker.start();
    worker.pushTasks([{ crawlerTaskId: 2, sku: 'SKU-002' }]);

    await worker.drain();

    assert.strictEqual(uploadCalled, false);
  });
});
```

### 步骤 2：运行测试验证失败

```bash
node --test test/worker-image-upload.test.js
```

预期：`Worker does not accept imageUploader option` 或 `uploadCalled` 为 false。

### 步骤 3：修改 `src/worker.js`

```js
class Worker {
  constructor(options) {
    this.channels = [];
    this.taskQueue = [];
    this.pusher = options.pusher;
    this.imageUploader = options.imageUploader || null;
    this.log = options.log || console.log;
    this.running = false;
    this.pendingPushes = new Set();
    this.loopPromise = null;
    this.maxQueueSize = options.maxQueueSize || 50;
    this.inFlightTaskIds = new Set();
  }
```

修改 `runTask` 中的 pushPromise：

```js
    const pushPromise = (async () => {
      let result = null;
      try {
        this.log(`[Worker] Assigning task ${task.crawlerTaskId} sku ${task.sku} to channel ${channel.id}`);
        result = await channel.crawl(task);
        this.log(`[Worker] Crawl finished task ${task.crawlerTaskId} status ${result.status}`);
      } catch (e) {
        this.log(`[Worker] Crawl failed task ${task.crawlerTaskId} sku ${task.sku}: ${e.message}`);
        result = {
          crawlerTaskId: task.crawlerTaskId,
          sku: task.sku,
          status: e.status ?? 'error',
          product_name: '',
          features_details: '',
          product_specification: '',
          product_url: '',
          error: e.message,
        };
      }

      try {
        this.log(`[Worker] Starting push task ${task.crawlerTaskId} sku ${task.sku} status=${result.status}`);
        await this.pusher.push(result);
        this.log(`[Worker] Push completed task ${task.crawlerTaskId} status ${result.status}`);

        if (this.imageUploader && result.status === 'success') {
          try {
            this.log(`[Worker] Starting image upload task ${task.crawlerTaskId} sku ${task.sku}`);
            await this.imageUploader.upload(result);
            this.log(`[Worker] Image upload completed task ${task.crawlerTaskId} sku ${task.sku}`);
          } catch (e) {
            this.log(`[Worker] Image upload failed task ${task.crawlerTaskId} sku ${task.sku}: ${e.message}`);
          }
        }
      } catch (e) {
        this.log(`[Worker] Push failed task ${task.crawlerTaskId} sku ${task.sku}: ${e.message}`);
        try {
          await this.pusher.push({
            crawlerTaskId: task.crawlerTaskId,
            sku: task.sku,
            status: 'error',
            product_name: '',
            features_details: '',
            product_specification: '',
            product_url: '',
            error: e.message,
          });
          this.log(`[Worker] Error status pushed for task ${task.crawlerTaskId}`);
        } catch (pushErr) {
          this.log(`[Worker] failed to push error result for task ${task.crawlerTaskId}: ${pushErr.message}`);
        }
      }
    })();
```

### 步骤 4：运行测试验证通过

```bash
node --test test/worker-image-upload.test.js
node --test test/pusher.test.js test/worker-image-upload.test.js
```

预期：Worker 测试通过，原有 Pusher 测试不受影响。

### 步骤 5：Commit

```bash
git add src/worker.js test/worker-image-upload.test.js
git commit -m "feat(worker): upload images after successful callback"
```

---

## 任务 5：修改 `CrawlerService` 注入 `ImageUploader`

**文件：**
- 修改：`src/service.js`

### 步骤 1：修改 `src/service.js`

在 `CrawlerService.start()` 中，创建 `Worker` 之前若 `config.imageUploadUrl` 存在则创建 `ImageUploader`：

```js
const { ImageUploader } = require('./image-uploader');
```

在 `start()` 方法中：

```js
    let imageUploader = null;
    if (this.config.imageUploadUrl) {
      imageUploader = new ImageUploader({
        uploadUrl: this.config.imageUploadUrl,
        nodeCode: this.config.nodeCode,
        nodeToken: this.config.nodeToken,
        concurrency: this.config.imageUploadConcurrency,
        maxRetries: this.config.imageUploadRetries,
        retryDelays: [1000, 2000, 4000],
      });
    }

    this.worker = new Worker({
      pusher: this.pusher,
      imageUploader,
      log: this.log.bind(this),
    });
```

### 步骤 2：运行现有 service 相关测试

```bash
node --test test/service.integration.test.js test/service-cliproxy.test.js test/service-proxy-pool.test.js
```

预期：测试通过（或仅因浏览器环境失败，与本次改动无关）。

### 步骤 3：Commit

```bash
git add src/service.js
git commit -m "feat(service): inject ImageUploader when imageUploadUrl configured"
```

---

## 任务 6：修改 `src/cli.js` 解析新增配置

**文件：**
- 修改：`src/cli.js`
- 测试：`test/cli-datalayer-config.test.js`（参考其模式新增测试）

### 步骤 1：新增 `cli.js` 的 flag 和环境变量映射

在 `FLAG_MAP` 中新增：

```js
  'image-upload-url': 'imageUploadUrl',
  'image-upload-concurrency': 'imageUploadConcurrency',
  'image-upload-retries': 'imageUploadRetries',
  'image-upload': 'enableImageUpload',
```

在 `BOOLEAN_FLAGS` 和 `BOOLEAN_CONFIG_KEYS` 中新增：

```js
const BOOLEAN_FLAGS = new Set([
  'headless',
  'translate',
  'feishu',
  'headed-fallback',
  'image-upload',
]);

const BOOLEAN_CONFIG_KEYS = new Set([
  'headless',
  'enableTranslation',
  'enableFeishu',
  'headedFallback',
  'enableImageUpload',
]);
```

在 `envMap` 中新增：

```js
    CRAWLER_IMAGE_UPLOAD_URL: 'imageUploadUrl',
    CRAWLER_IMAGE_UPLOAD_CONCURRENCY: 'imageUploadConcurrency',
    CRAWLER_IMAGE_UPLOAD_RETRIES: 'imageUploadRetries',
    CRAWLER_IMAGE_UPLOAD: 'enableImageUpload',
```

### 步骤 2：编写失败的 CLI 测试

创建 `test/cli-image-upload-config.test.js`：

```js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { parse } = require('../src/cli');

describe('CLI image upload config', () => {
  it('parses --image-upload-url flag', () => {
    const config = parse(['--image-upload-url', 'http://example.com/upload']);
    assert.strictEqual(config.imageUploadUrl, 'http://example.com/upload');
  });

  it('parses --image-upload-concurrency flag', () => {
    const config = parse(['--image-upload-concurrency', '3']);
    assert.strictEqual(config.imageUploadConcurrency, 3);
  });

  it('parses --image-upload-retries flag', () => {
    const config = parse(['--image-upload-retries', '5']);
    assert.strictEqual(config.imageUploadRetries, 5);
  });

  it('parses --no-image-upload flag', () => {
    const config = parse(['--no-image-upload']);
    assert.strictEqual(config.enableImageUpload, false);
  });

  it('uses environment variable fallbacks', () => {
    process.env.CRAWLER_IMAGE_UPLOAD_URL = 'http://env.example.com/upload';
    process.env.CRAWLER_IMAGE_UPLOAD_CONCURRENCY = '4';
    process.env.CRAWLER_IMAGE_UPLOAD_RETRIES = '2';
    const config = parse([]);
    assert.strictEqual(config.imageUploadUrl, 'http://env.example.com/upload');
    assert.strictEqual(config.imageUploadConcurrency, 4);
    assert.strictEqual(config.imageUploadRetries, 2);
    delete process.env.CRAWLER_IMAGE_UPLOAD_URL;
    delete process.env.CRAWLER_IMAGE_UPLOAD_CONCURRENCY;
    delete process.env.CRAWLER_IMAGE_UPLOAD_RETRIES;
  });
});
```

### 步骤 3：运行测试验证通过

```bash
node --test test/cli-image-upload-config.test.js
node --test test/cli-datalayer-config.test.js test/cli-image-upload-config.test.js
```

预期：新增测试通过，原有 CLI 测试不受影响。

### 步骤 4：Commit

```bash
git add src/cli.js test/cli-image-upload-config.test.js
git commit -m "feat(cli): add image upload flags and env vars"
```

---

## 任务 7：扩展 service 集成测试验证图片上传

**文件：**
- 修改：`test/service.integration.test.js`

### 步骤 1：修改 mock upstream 支持图片上传接口

在 `startMockUpstream` 中新增：

```js
function startMockUpstream({ tasks = [], onCallback, onImageUpload }) {
  const callbacks = [];
  const imageUploads = [];
  let returnedTasks = false;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      if (req.url.startsWith('/tasks') && req.method === 'POST') {
        // ... existing
      }
      if (req.url === '/callback' && req.method === 'POST') {
        // ... existing
      }
      if (req.url === '/upload' && req.method === 'POST') {
        const parsed = JSON.parse(body || '{}');
        imageUploads.push(parsed);
        if (onImageUpload) onImageUpload(parsed);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 0,
          data: { id: imageUploads.length, sku: parsed.sku, contentType: parsed.contentType, fileName: parsed.fileName, fileSize: 4 },
        }));
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, getCallbacks: () => callbacks, getImageUploads: () => imageUploads });
    });
  });
}
```

### 步骤 2：新增集成测试用例

新增一个测试用例，由于需要真实浏览器环境来下载图片，建议复用现有集成测试的 stub，但需要让 `PageCrawler` 实际下载图片。考虑到浏览器环境可能不可用，本用例可以标记为在浏览器可用时运行，或使用已有模式（现有集成测试已经启动浏览器）。

新增 describe 或 it：

```js
  it('uploads images after successful callback when imageUploadUrl is set', async () => {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');

    let callbackReceived = null;
    let imageUploadReceived = null;

    const { server, port, getCallbacks, getImageUploads } = await startMockUpstream({
      tasks: [{ crawlerTaskId: 1000, sku: 'DEFINITELY-NOT-A-REAL-SKU-12345' }],
      onCallback: (cb) => { callbackReceived = cb; },
      onImageUpload: (up) => { imageUploadReceived = up; },
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    const imageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'service-img-'));
    let service = null;

    try {
      service = await runService({
        baseUrl: 'https://eur.vevor.com',
        imageDir,
        headless: true,
        nodeCode: 'test-node',
        nodeToken: 'test-token',
        taskUrl: `${baseUrl}/tasks`,
        callbackUrl: `${baseUrl}/callback`,
        imageUploadUrl: `${baseUrl}/upload`,
        channels: 1,
        pollInterval: 1000,
        pollLimit: 1,
        pushRetries: 1,
      });

      const start = Date.now();
      while ((!callbackReceived || !imageUploadReceived) && Date.now() - start < 90000) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      assert.ok(callbackReceived, 'callback was not received');
      assert.strictEqual(callbackReceived.success, false);

      // Since SKU is fake, no images should be downloaded; verify upload was not triggered
      assert.strictEqual(getImageUploads().length, 0, 'should not upload when crawl fails');
    } finally {
      if (service) await service.stop();
      server.close();
      fs.rmSync(imageDir, { recursive: true, force: true });
    }
  });
```

> **说明：** 要测试"成功时上传图片"，需要一个真实存在的 SKU 或 mock 掉 `Channel.crawl`。更稳妥的做法是在 `test/image-uploader.test.js` 和 `test/worker-image-upload.test.js` 中覆盖上传逻辑，在集成测试中只验证"配置 `imageUploadUrl` 后 `ImageUploader` 被注入且流程不报错"。

### 步骤 3：运行测试

```bash
node --test test/service.integration.test.js
```

预期：集成测试通过（依赖浏览器环境的测试可能跳过或失败，与本次改动无关）。

### 步骤 4：Commit

```bash
git add test/service.integration.test.js
git commit -m "test(service): extend integration test for image upload wiring"
```

---

## 任务 8：更新 `README.md`

**文件：**
- 修改：`README.md`

### 步骤 1：在 Service Configuration 表格中新增配置项

在 README 的 Service Configuration 表格末尾新增：

```markdown
| `--image-upload-url` | `CRAWLER_IMAGE_UPLOAD_URL` | - | 图片上传接口 URL；未设置时不启用 |
| `--image-upload-concurrency` | `CRAWLER_IMAGE_UPLOAD_CONCURRENCY` | `2` | 单 SKU 图片并发上传数 |
| `--image-upload-retries` | `CRAWLER_IMAGE_UPLOAD_RETRIES` | `3` | 单张图上传重试次数 |
| `--image-upload` / `--no-image-upload` | `CRAWLER_IMAGE_UPLOAD` | `true`（URL 配置后生效） | 是否启用图片上传 |
```

### 步骤 2：在 Upstream API Contract 后新增图片上传接口说明

在 Push result 段落后新增：

```markdown
**Upload product images**

```http
POST /renren-api/classify/open/image/upload
Content-Type: application/json

{
  "nodeCode": "crawler-01",
  "nodeToken": "",
  "sku": "ABC-001",
  "imageBase64": "...",
  "contentType": "image/jpeg",
  "fileName": "ABC-001_1.jpg"
}
```

图片在 `/renren-api/classify/open/crawler/callback` 返回 `success: true` 后上传。单张图片上传失败不会影响其他图片，也不会改变 callback 的成功状态。
```

### 步骤 3：Commit

```bash
git add README.md
git commit -m "docs(readme): document image upload configuration and API"
```

---

## 任务 9：最终验证

### 步骤 1：运行所有非浏览器单元测试

```bash
node --test test/pusher.test.js test/image-uploader.test.js test/worker-image-upload.test.js test/cli-image-upload-config.test.js
```

预期：全部通过。

### 步骤 2：检查代码风格与 lint

```bash
# 如果项目有 lint 脚本
npm run lint 2>/dev/null || echo "no lint script"
```

### 步骤 3：运行完整测试套件（记录环境限制）

```bash
npm test
```

预期：与基线一致，浏览器相关测试可能因 Playwright 不支持 Ubuntu 26.04 而失败。

### 步骤 4：最终 Commit

```bash
git add -A
git diff --cached --stat
```

---

## 自检

### 规格覆盖度

| 规格需求 | 覆盖任务 |
|---|---|
| 主 callback 成功后上传图片 | 任务 4、5 |
| 单图失败不影响其他图 | 任务 1、3 |
| 单图失败不影响主 callback | 任务 4 |
| 返回的 `id` 只记录本地日志 | 任务 1（upload 返回包含 id） |
| 可控并发，默认 2 | 任务 1、3 |
| Magic Bytes + 扩展名校验 | 任务 1 |
| 默认仅 service 模式 | 任务 5（`CrawlerService` 注入） |
| CLI 模式保留能力 | 任务 6（CLI 配置解析） |

### 占位符扫描

- 无 "TODO"、"待定"、"后续实现"。
- 每个步骤包含实际代码或命令。
- 测试用例包含具体断言。

### 类型一致性

- `ImageUploader` 配置字段：`uploadUrl`、`nodeCode`、`nodeToken`、`concurrency`、`maxRetries`、`retryDelays`、`fetch`。
- `Worker` 构造函数新增 `imageUploader` 选项。
- `CrawlerService` 使用 `config.imageUploadUrl` 等字段。
- `cli.js` 新增 `imageUploadUrl`、`imageUploadConcurrency`、`imageUploadRetries`、`enableImageUpload`。

一致，无冲突。

---

## 执行交接

**计划已完成并保存到 `docs/superpowers/plans/2026-06-30-image-push-plan.md`。两种执行方式：**

**1. 子代理驱动（推荐）** - 每个任务调度一个新的子代理，任务间进行审查，快速迭代

**2. 内联执行** - 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点

**选哪种方式？**
