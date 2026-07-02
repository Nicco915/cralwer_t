# transfer-images 流式 + 断点续传 — 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** `bin/transfer-images.js` 支持 25k+ 张大目录批量传输：流式（内存峰值 < 1MB）+ NDJSON 状态文件断点续传 + `--force` 强制重传。`ImageUploader` 零改动。

**架构：** `transferImages` 启动时一次性 `stat`（不 readFile），通过 `async function*` 生成器逐项 yield；`ImageUploader.limitConcurrency` worker 池内同步 `readFile` → `uploadSingle` → 成功后 `appendState`。状态键 = basename；状态文件 = NDJSON，按 `--dir` 派生（`.transfer-state/<sha1>.ndjson`）。

**技术栈：** Node.js CommonJS、`node:test`、`fs.promises`/`fs.readFileSync`、`node:crypto`（sha1，无新依赖）、现有 `ImageUploader`（不改）。

---

## 文件结构

| 文件 | 状态 | 职责 |
|---|---|---|
| `bin/transfer-images.js` | 改 | 加 `loadState` / `appendState` / `defaultStatePath`；CLI 解析加 `--state-file` / `--force`；`transferImages` 改为流式 + state 集成 |
| `test/transfer-images.test.js` | 改 | 新增 13 case：3 工具函数 + 2 CLI 解析 + 8 transferImages 集成 |
| `README.md` | 改 | 新增"断点续传 / state 文件"段落 |

**ImageUploader / `src/image-uploader.js`：零改动**（保护 18 个 legacy case + 已通过的 9 个 onProgress case）。

---

## 任务 1：实现 `loadState`（TDD）

### 任务 1.1：编写失败测试

**文件：** 修改：`test/transfer-images.test.js`（追加到文件末尾）

- [ ] **步骤 1：编写 4 个失败测试**

```js
const { loadState } = require('../bin/transfer-images');

describe('loadState', () => {
  it('returns empty Map when state file does not exist', () => {
    const missing = path.join(os.tmpdir(), `state-missing-${Date.now()}-${Math.random()}.ndjson`);
    const map = loadState(missing);
    assert.equal(map.size, 0);
  });

  it('returns empty Map for empty file', () => {
    const f = path.join(os.tmpdir(), `state-empty-${Date.now()}.ndjson`);
    fs.writeFileSync(f, '');
    try {
      assert.equal(loadState(f).size, 0);
    } finally {
      fs.rmSync(f, { force: true });
    }
  });

  it('skips malformed lines with a warning', () => {
    const f = path.join(os.tmpdir(), `state-bad-${Date.now()}.ndjson`);
    fs.writeFileSync(f, [
      JSON.stringify({ basename: 'a_1.jpg', sku: 'a', id: 1, ts: 't', uploadUrl: 'u' }),
      'not-json-line',
      JSON.stringify({ basename: 'b_1.jpg', sku: 'b', id: 2, ts: 't', uploadUrl: 'u' }),
      '',
    ].join('\n'));
    try {
      const map = loadState(f);
      assert.equal(map.size, 2);
      assert.ok(map.has('a_1.jpg'));
      assert.ok(map.has('b_1.jpg'));
    } finally {
      fs.rmSync(f, { force: true });
    }
  });

  it('keeps first entry on duplicate basename', () => {
    const f = path.join(os.tmpdir(), `state-dup-${Date.now()}.ndjson`);
    fs.writeFileSync(f, [
      JSON.stringify({ basename: 'a_1.jpg', sku: 'a', id: 1, ts: 't', uploadUrl: 'u' }),
      JSON.stringify({ basename: 'a_1.jpg', sku: 'a', id: 999, ts: 't2', uploadUrl: 'u' }),
    ].join('\n'));
    try {
      const map = loadState(f);
      assert.equal(map.size, 1);
      assert.equal(map.get('a_1.jpg').id, 1);  // first write wins
    } finally {
      fs.rmSync(f, { force: true });
    }
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/transfer-images.test.js -g "loadState" -v`
预期：FAIL，`loadState is not a function`

### 任务 1.2：实现 `loadState`

**文件：** 修改：`bin/transfer-images.js`（在 `makeLogger` 之前插入）

- [ ] **步骤 1：实现 `loadState` 函数**

```js
function loadState(stateFile, deps = {}) {
  const logger = deps.logger || null;
  if (!fs.existsSync(stateFile)) return new Map();
  const content = fs.readFileSync(stateFile, 'utf-8');
  const map = new Map();
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry.basename === 'string' && !map.has(entry.basename)) {
        map.set(entry.basename, entry);
      }
    } catch (_e) {
      if (logger) logger.warn(`skipping malformed state line: ${line.slice(0, 80)}`);
    }
  }
  return map;
}
```

- [ ] **步骤 2：在 module.exports 暴露**

修改 `bin/transfer-images.js` 末尾的 `module.exports`，加入 `loadState`：

```js
module.exports = {
  parseTransferArgs,
  transferImages,
  scanImages,
  makeLogger,
  loadState,             // ← 新增
  IMAGE_EXTS,
  ConfigError,
  main,
};
```

- [ ] **步骤 3：运行测试验证通过**

运行：`node --test test/transfer-images.test.js -g "loadState" -v`
预期：4/4 PASS

- [ ] **步骤 4：Commit**

```bash
git add bin/transfer-images.js test/transfer-images.test.js
git commit -m "feat(transfer-images): loadState function with NDJSON parsing"
```

---

## 任务 2：实现 `appendState`（TDD）

### 任务 2.1：编写失败测试

**文件：** 修改：`test/transfer-images.test.js`

- [ ] **步骤 1：编写 3 个失败测试**

```js
const { appendState } = require('../bin/transfer-images');

describe('appendState', () => {
  it('appends a JSON line + newline to state file', () => {
    const f = path.join(os.tmpdir(), `append-${Date.now()}.ndjson`);
    try {
      appendState(f, { basename: 'x_1.jpg', sku: 'x', id: 42, ts: '2026-07-01T00:00:00Z', uploadUrl: 'http://up' });
      appendState(f, { basename: 'y_1.jpg', sku: 'y', id: 43, ts: '2026-07-01T00:00:01Z', uploadUrl: 'http://up' });
      const content = fs.readFileSync(f, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      assert.equal(lines.length, 2);
      assert.deepEqual(JSON.parse(lines[0]), { basename: 'x_1.jpg', sku: 'x', id: 42, ts: '2026-07-01T00:00:00Z', uploadUrl: 'http://up' });
      assert.deepEqual(JSON.parse(lines[1]).basename, 'y_1.jpg');
    } finally {
      fs.rmSync(f, { force: true });
    }
  });

  it('creates parent directory if missing', () => {
    const dir = path.join(os.tmpdir(), `append-mkdir-${Date.now()}-${Math.random()}`);
    const f = path.join(dir, 'sub', 'state.ndjson');
    try {
      appendState(f, { basename: 'a.jpg', sku: 'a', id: 1, ts: 't', uploadUrl: 'u' });
      assert.ok(fs.existsSync(f));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not throw when write fails (logs error instead)', () => {
    // Read-only directory → write should fail
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'append-ro-'));
    fs.chmodSync(dir, 0o500);
    const f = path.join(dir, 'state.ndjson');
    try {
      // Should not throw
      appendState(f, { basename: 'a.jpg', sku: 'a', id: 1, ts: 't', uploadUrl: 'u' });
      // File may or may not exist depending on platform; we just assert no throw
      assert.ok(true);
    } finally {
      fs.chmodSync(dir, 0o700);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/transfer-images.test.js -g "appendState" -v`
预期：FAIL，`appendState is not a function`

### 任务 2.2：实现 `appendState`

**文件：** 修改：`bin/transfer-images.js`

- [ ] **步骤 1：实现 `appendState` 函数**

```js
function appendState(stateFile, entry, deps = {}) {
  const logger = deps.logger || null;
  try {
    const dir = path.dirname(stateFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.appendFileSync(stateFile, JSON.stringify(entry) + '\n');
  } catch (e) {
    if (logger) logger.error(`failed to append state: ${e.message}`);
  }
}
```

- [ ] **步骤 2：在 module.exports 暴露**

```js
module.exports = {
  parseTransferArgs,
  transferImages,
  scanImages,
  makeLogger,
  loadState,
  appendState,          // ← 新增
  IMAGE_EXTS,
  ConfigError,
  main,
};
```

- [ ] **步骤 3：运行测试验证通过**

运行：`node --test test/transfer-images.test.js -g "appendState" -v`
预期：3/3 PASS

- [ ] **步骤 4：Commit**

```bash
git add bin/transfer-images.js test/transfer-images.test.js
git commit -m "feat(transfer-images): appendState with auto-mkdir + non-throwing failure"
```

---

## 任务 3：实现 `defaultStatePath`（TDD）

### 任务 3.1：编写失败测试

**文件：** 修改：`test/transfer-images.test.js`

- [ ] **步骤 1：编写 3 个失败测试**

```js
const { defaultStatePath } = require('../bin/transfer-images');

describe('defaultStatePath', () => {
  it('returns same hash for same dir + same cwd', () => {
    const dir = '/tmp/test-dir-A';
    const prevCwd = process.cwd();
    process.chdir('/tmp');
    try {
      const a = defaultStatePath(dir);
      const b = defaultStatePath(dir);
      assert.equal(a, b);
    } finally {
      process.chdir(prevCwd);
    }
  });

  it('returns different hash for different dirs', () => {
    const prevCwd = process.cwd();
    process.chdir('/tmp');
    try {
      const a = defaultStatePath('/tmp/test-dir-A');
      const b = defaultStatePath('/tmp/test-dir-B');
      assert.notEqual(a, b);
    } finally {
      process.chdir(prevCwd);
    }
  });

  it('places file under .transfer-state/ in cwd', () => {
    const prevCwd = process.cwd();
    process.chdir('/tmp');
    try {
      const p = defaultStatePath('/tmp/some/dir');
      assert.match(p, /\.transfer-state\/[a-f0-9]{12}\.ndjson$/);
      assert.ok(p.startsWith('/tmp/.transfer-state/'));
    } finally {
      process.chdir(prevCwd);
    }
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/transfer-images.test.js -g "defaultStatePath" -v`
预期：FAIL，`defaultStatePath is not a function`

### 任务 3.2：实现 `defaultStatePath`

**文件：** 修改：`bin/transfer-images.js`

- [ ] **步骤 1：添加 `node:crypto` import**

```js
const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');           // ← 新增
const { loadEnvFile } = require('../src/cli');
```

- [ ] **步骤 2：实现 `defaultStatePath` 函数**

```js
function defaultStatePath(dir) {
  const resolved = path.resolve(dir);
  const hash = crypto.createHash('sha1').update(resolved).digest('hex').slice(0, 12);
  return path.join(process.cwd(), '.transfer-state', `${hash}.ndjson`);
}
```

- [ ] **步骤 3：在 module.exports 暴露**

```js
module.exports = {
  parseTransferArgs,
  transferImages,
  scanImages,
  makeLogger,
  loadState,
  appendState,
  defaultStatePath,     // ← 新增
  IMAGE_EXTS,
  ConfigError,
  main,
};
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test test/transfer-images.test.js -g "defaultStatePath" -v`
预期：3/3 PASS

- [ ] **步骤 5：Commit**

```bash
git add bin/transfer-images.js test/transfer-images.test.js
git commit -m "feat(transfer-images): defaultStatePath with sha1(dir) under .transfer-state/"
```

---

## 任务 4：CLI 解析增加 `--state-file` / `--force`

### 任务 4.1：编写失败测试

**文件：** 修改：`test/transfer-images.test.js`

- [ ] **步骤 1：在现有 `describe('parseTransferArgs', ...)` 块中追加 2 个 case**

```js
it('parses --state-file', () => {
  const r = parseTransferArgs(['--state-file=/tmp/custom.ndjson']);
  assert.equal(r.options.stateFile, '/tmp/custom.ndjson');
});

it('parses --force', () => {
  const r = parseTransferArgs(['--force']);
  assert.equal(r.options.force, true);
});
```

同时在 `parseTransferArgs` 顶部的 `BOOLEAN_FLAGS` Set 里加 `'force'`，并在 `options` 初始化里加：

```js
const BOOLEAN_FLAGS = new Set(['mock-upload', 'no-progress', 'recursive', 'quiet', 'force']);

const options = {
  ...
  stateFile: undefined,
  force: false,
};
```

并在 `switch (rawKey)` 加 case：

```js
case 'state-file': options.stateFile = rawVal; break;
case 'force': options.force = true; break;
```

- [ ] **步骤 2：运行新测试验证失败**

运行：`node --test test/transfer-images.test.js -g "parseTransferArgs" -v`
预期：新加 2 个 FAIL（其它不变 PASS）

### 任务 4.2：实现 CLI 解析

**文件：** 修改：`bin/transfer-images.js`（`parseTransferArgs` 函数）

- [ ] **步骤 1：修改 `BOOLEAN_FLAGS`、`options` 初始化、switch**

按上面步骤 1 给的代码片段打补丁。

- [ ] **步骤 2：运行测试验证通过**

运行：`node --test test/transfer-images.test.js -g "parseTransferArgs" -v`
预期：所有 parseTransferArgs case PASS（包括新加的 2 个）

- [ ] **步骤 3：Commit**

```bash
git add bin/transfer-images.js test/transfer-images.test.js
git commit -m "feat(transfer-images): parseTransferArgs accepts --state-file and --force"
```

---

## 任务 5：重构 `transferImages` 为流式（worker 内 readFile）

> 这是本计划的核心重构。完成后所有现有 transferImages 测试 + 即将新增的 resume/streaming 测试都将通过此实现验证。

### 任务 5.1：编写流式行为测试

**文件：** 修改：`test/transfer-images.test.js`

- [ ] **步骤 1：编写 1 个流式行为测试**

```js
describe('transferImages streaming', () => {
  const os = require('os');

  it('does not preload all buffers before first fetch', async () => {
    // 5 items, mock fetch delayed 50ms, concurrency=2
    // streaming → readFile calls interleave with fetchStart (≤ 2-3 reads before first fetchStart)
    // eager → all 5 readFile calls happen before first fetchStart
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-'));
    const files = [];
    for (let i = 0; i < 5; i++) {
      const p = path.join(dir, `img${i}_1.jpg`);
      fs.writeFileSync(p, Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]));
      files.push(p);
    }

    const log = [];
    const trackingReadFile = (p) => {
      log.push({ event: 'readFile', file: path.basename(p) });
      return fs.readFileSync(p);
    };
    const trackingFetch = async (url, init) => {
      log.push({ event: 'fetchStart', file: JSON.parse(init.body).fileName });
      await new Promise((r) => setTimeout(r, 50));
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { id: 1 } }) };
    };

    try {
      const report = await transferImages({
        paths: files,
        options: { uploadUrl: 'http://test/up', uploadConcurrency: 2, fetchImpl: trackingFetch },
        deps: {
          loadEnvFile: () => {},
          pathExists: () => true,
          readFile: trackingReadFile,
          startMockUploadServer: require('../src/mock-upload-server').startMockUploadServer,
          loadState: () => new Map(),       // isolate from state in this test
          appendState: () => {},
          defaultStatePath: () => '/tmp/should-not-be-used',
        },
      });
      assert.equal(report.success, 5);

      const firstFetchIdx = log.findIndex((e) => e.event === 'fetchStart');
      const readsBeforeFirstFetch = log.slice(0, firstFetchIdx).filter((e) => e.event === 'readFile').length;
      // concurrency=2, allow +1 tolerance for microtask ordering
      assert.ok(
        readsBeforeFirstFetch <= 3,
        `expected streaming (≤3 reads before first fetch), got ${readsBeforeFirstFetch}`
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **步骤 2：运行新测试验证失败**

运行：`node --test test/transfer-images.test.js -g "streaming" -v`
预期：FAIL（因为当前实现 `paths.map` 预读全部）

### 任务 5.2：实现流式 transferImages

**文件：** 修改：`bin/transfer-images.js`（重写 `transferImages` 函数）

- [ ] **步骤 1：替换 `transferImages` 实现**

**整体策略**：把 `records` 数组的预读 buffer（line 180-192）替换为 async iterator；worker 在 `limitConcurrency` 内同步 readFile；`skuForImage` 钩子保留但现在接收的是 `{ path, fileName, ext, sku, size }` 元数据而不是 buffer。

完整替换为：

```js
async function transferImages({ paths, options, deps = {} }) {
  const {
    loadEnvFile: loadEnv = loadEnvFile,
    pathExists = (p) => fs.existsSync(p),
    readFile = (p) => fs.readFileSync(p),
    startMockUploadServer: startMock = startMockUploadServer,
    scanImages: scanDep = scanImages,
    loadState: loadStateDep = loadState,
    appendState: appendStateDep = appendState,
    defaultStatePath: defaultStatePathDep = defaultStatePath,
  } = deps;

  loadEnv(process.cwd());

  const opts = { ...options };
  const logger = makeLogger({ quiet: opts.quiet, logFile: opts.logFile });

  let mockHandle = null;
  try {
    if (opts.mockUpload) {
      mockHandle = await startMock();
      opts.uploadUrl = mockHandle.url;
    }

    const envUrl = process.env.CRAWLER_IMAGE_UPLOAD_URL;
    if (!opts.uploadUrl && envUrl) opts.uploadUrl = envUrl;

    if (!opts.uploadUrl) {
      throw new ConfigError('upload url required: pass --upload-url=, set CRAWLER_IMAGE_UPLOAD_URL, or use --mock-upload');
    }

    // Expand --dir into individual image paths
    let allPaths = [...paths];
    if (opts.dir) {
      if (!pathExists(opts.dir)) {
        throw new Error(`directory not found: ${opts.dir}`);
      }
      const scanned = await scanDep(opts.dir, !!opts.recursive);
      logger.info(`Scanned ${scanned.length} images from ${opts.dir}${opts.recursive ? ' (recursive)' : ''}`);
      allPaths = allPaths.concat(scanned);
    }
    // Dedup, preserve order
    const seenSet = new Set();
    allPaths = allPaths.filter((p) => (seenSet.has(p) ? false : (seenSet.add(p), true)));

    if (!Array.isArray(allPaths) || allPaths.length === 0) {
      throw new Error('no paths provided (pass positional paths or --dir=)');
    }

    for (const p of allPaths) {
      if (!pathExists(p)) {
        throw new Error(`path not found: ${p}`);
      }
    }

    // ★ Resolve state file path
    const stateFile = opts.stateFile
      || (opts.dir ? defaultStatePathDep(opts.dir) : null);

    // ★ Load existing state (basename → entry)
    const doneMap = stateFile ? loadStateDep(stateFile, { logger }) : new Map();
    if (stateFile && doneMap.size > 0) {
      logger.info(`State: ${doneMap.size} basenames already uploaded at ${stateFile}`);
    }

    // ★ Filter skipped (basename in doneMap) unless --force
    const skipped = [];
    let toUpload = allPaths;
    if (!opts.force && doneMap.size > 0) {
      const before = allPaths.length;
      toUpload = allPaths.filter((p) => {
        const basename = path.basename(p);
        if (doneMap.has(basename)) {
          skipped.push({ basename, sku: doneMap.get(basename).sku });
          return false;
        }
        return true;
      });
      if (before !== toUpload.length) {
        logger.info(`Resume: skipping ${before - toUpload.length} already-uploaded, ${toUpload.length} to upload`);
      }
    } else if (opts.force && doneMap.size > 0) {
      logger.info(`--force set: ignoring state, will upload all ${toUpload.length}`);
    }

    logger.info(`Starting transfer: ${toUpload.length} images, uploadUrl=${opts.uploadUrl}`);

    // ★ Async iterator: yields { path, fileName, ext, sku, size } — NO buffer
    //    Worker reads buffer inside limitConcurrency (single readFileSync < 200KB)
    async function* iter() {
      for (const p of toUpload) {
        const stats = fs.statSync(p);
        const ext = path.extname(p);
        const fileName = path.basename(p);
        const sku = fileName.replace(/_\d+\.[^.]+$/, '');
        yield { path: p, fileName, ext, sku, size: stats.size };
      }
    }

    const fetchImpl = opts.fetchImpl;
    const concurrency = Number.isFinite(opts.uploadConcurrency)
      ? opts.uploadConcurrency
      : (Number(process.env.CRAWLER_IMAGE_UPLOAD_CONCURRENCY) || 2);
    const maxRetries = Number.isFinite(opts.uploadRetries)
      ? opts.uploadRetries
      : (process.env.CRAWLER_IMAGE_UPLOAD_RETRIES !== undefined
          ? Number(process.env.CRAWLER_IMAGE_UPLOAD_RETRIES)
          : 3);
    const nodeCode = opts.nodeCode !== undefined ? opts.nodeCode : (process.env.CRAWLER_NODE_CODE || '');
    const nodeToken = opts.nodeToken !== undefined ? opts.nodeToken : (process.env.CRAWLER_NODE_TOKEN || '');

    const uploader = new ImageUploader({
      uploadUrl: opts.uploadUrl,
      nodeCode,
      nodeToken,
      concurrency,
      maxRetries,
      fetch: fetchImpl,
    });

    const startTime = Date.now();
    let summary = { uploaded: [], failed: [], skipped: [] };

    if (toUpload.length > 0) {
      const fakeResult = {
        crawlerTaskId: `cli-transfer-${Date.now()}`,
        status: 'success',
        sku: '',
        image_paths: '',
      };

      // We need our own iterator-aware worker (not direct _preloadedItems),
      // because the worker reads the buffer. So we don't pass _preloadedItems.
      // Instead: manually drive an iterator-driven concurrency loop.
      const indexedIter = (async function* () {
        let idx = 0;
        for await (const item of iter()) {
          yield { item, index: idx++ };
        }
      })();

      const outputs = await uploader.limitConcurrency(
        await (async () => {
          // Materialize iterator into array for limitConcurrency's index access.
          // limitConcurrency uses items.length and items[index], not async iter.
          const arr = [];
          for await (const x of indexedIter) arr.push(x);
          return arr;
        })(),
        async ({ item, index }) => {
          // ★ 流式核心：在 worker 内同步 readFile
          let buffer;
          try {
            buffer = readFile(item.path);
          } catch (e) {
            logger.uploadFail(index + 1, toUpload.length, item.fileName, `read failed: ${e.message}`);
            return { status: 'failed', fileName: item.fileName, error: `read failed: ${e.message}` };
          }
          const contentType = ImageUploader.prototype.detectContentType(buffer, item.ext);
          if (!contentType) {
            logger.uploadFail(index + 1, toUpload.length, item.fileName, 'unknown content type');
            return { status: 'failed', fileName: item.fileName, error: 'unknown content type' };
          }
          if (buffer.length === 0) {
            logger.uploadFail(index + 1, toUpload.length, item.fileName, 'empty file');
            return { status: 'failed', fileName: item.fileName, error: 'empty file' };
          }

          const sku = item.sku;
          const payload = uploader.buildPayload(sku, item.fileName, buffer, contentType);
          const sizeKB = Math.ceil(item.size / 1024);
          logger.uploadStart(index + 1, toUpload.length, item.fileName, sizeKB);
          try {
            const data = await uploader.uploadSingle(payload);
            logger.uploadOk(index + 1, toUpload.length, item.fileName, data.id);

            // ★ 成功后写 state
            if (stateFile) {
              appendStateDep(stateFile, {
                basename: item.fileName,
                sku,
                id: data.id,
                ts: new Date().toISOString(),
                uploadUrl: opts.uploadUrl,
              }, { logger });
            }

            return { status: 'uploaded', data, item };
          } catch (error) {
            logger.uploadFail(index + 1, toUpload.length, item.fileName, error.message);
            return { status: 'failed', fileName: item.fileName, error: error.message, item };
          }
        },
        Math.max(1, concurrency)
      );

      summary = {
        uploaded: outputs.filter((o) => o.status === 'uploaded').map((o) => ({
          id: o.data.id, response: o.data.response, fileName: o.item.fileName,
        })),
        failed: outputs.filter((o) => o.status === 'failed').map((o) => ({
          fileName: o.fileName, error: o.error,
        })),
        skipped: [],
      };
    }

    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
    const attempted = summary.uploaded.length + summary.failed.length;
    const rate = elapsedSec > 0 ? (attempted / Number(elapsedSec)).toFixed(2) : '0.00';
    logger.info(`Done: ${attempted} attempted, ${summary.uploaded.length} success, ${summary.failed.length} failed, ${elapsedSec}s elapsed, ${rate} img/s`);

    // ★ Build final results with consistent shape (uploaded/failed/skipped all share fields)
    const uploadedByFile = new Map(summary.uploaded.map((u) => [u.fileName, u]));
    const failedByFile = new Map(summary.failed.map((f) => [f.fileName, f]));

    const results = [];
    // 1. uploaded / failed items (use original path / sku)
    for (const p of toUpload) {
      const fileName = path.basename(p);
      const sku = fileName.replace(/_\d+\.[^.]+$/, '');
      const stats = fs.statSync(p);
      const u = uploadedByFile.get(fileName);
      const f = failedByFile.get(fileName);
      if (u) {
        // Re-derive contentType from upload response if available; fallback to detect
        let contentType = null;
        try {
          // Try to detect from buffer (re-read is acceptable here; this is post-processing)
          const buf = readFile(p);
          contentType = ImageUploader.prototype.detectContentType(buf, path.extname(p));
        } catch (_e) { /* ignore */ }
        results.push({
          path: p, sku, fileName, contentType, fileSize: stats.size,
          ok: true, response: u.response || { id: u.id },
        });
      } else if (f) {
        results.push({
          path: p, sku, fileName, contentType: null, fileSize: stats.size,
          ok: false, error: f.error,
        });
      }
    }
    // 2. skipped items (from state recovery)
    for (const s of skipped) {
      results.push({
        path: s.basename, sku: s.sku, fileName: s.basename,
        contentType: null, fileSize: 0,
        ok: true, skipped: true,
      });
    }

    const success = results.filter((r) => r.ok).length;
    const failed = results.length - success;
    return { total: results.length, success, failed, results };
  } finally {
    if (mockHandle) {
      try { await mockHandle.close(); } catch (e) { /* ignore */ }
    }
  }
}
```

> **设计要点**：
> - iter() yield 的每项不带 buffer；worker 内 `readFile`（流式核心）
> - worker 直接调 `uploader.uploadSingle(payload)`（已有重试 + 业务码检查）；不再走 `_preloadedItems` 旁路（因为我们需要在 worker 里读 buffer 并调 appendState）
> - `limitConcurrency` 仍复用 — 它的实现 (`uploader.limitConcurrency(items, fn, limit)`) 对 items 数组友好
> - iterator 先 materialize 成数组（items.length 已知）；materialize 阶段仅 stat 不 readFile
> - 失败的 readFile / 未知 contentType / 空文件都在 worker 内被识别并走 failed 路径
> - `appendState` 失败不抛错（任务 2 已保证）

- [ ] **步骤 2：运行新测试验证通过**

运行：`node --test test/transfer-images.test.js -g "streaming" -v`
预期：PASS

- [ ] **步骤 3：运行**所有 transfer-images + image-uploader 测试验证零回归

运行：`node --test test/transfer-images.test.js test/image-uploader.test.js`
预期：全部通过（旧 74 + 新增流式 1 = 75）

- [ ] **步骤 4：Commit**

```bash
git add bin/transfer-images.js test/transfer-images.test.js
git commit -m "refactor(transfer-images): async-iterator streaming; worker reads buffer"
```

---

## 任务 6：resume 跳过已上传（state 集成测试）

### 任务 6.1：编写失败测试

**文件：** 修改：`test/transfer-images.test.js`

- [ ] **步骤 1：编写 1 个 resume 测试**

```js
describe('transferImages resume', () => {
  const os = require('os');

  it('skips basenames already in state file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-'));
    const stateFile = path.join(dir, 'state.ndjson');
    // Pre-populate state with one basename
    fs.writeFileSync(stateFile, JSON.stringify({
      basename: 'a_1.jpg', sku: 'a', id: 100, ts: 't', uploadUrl: 'http://test/up',
    }) + '\n');

    const files = [];
    for (const name of ['a_1.jpg', 'b_1.jpg']) {
      const p = path.join(dir, name);
      fs.writeFileSync(p, Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]));
      files.push(p);
    }

    let fetchCalls = 0;
    const fakeFetch = async () => {
      fetchCalls++;
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { id: fetchCalls } }) };
    };

    try {
      const report = await transferImages({
        paths: files,
        options: { uploadUrl: 'http://test/up', stateFile, fetchImpl: fakeFetch },
        deps: {
          loadEnvFile: () => {},
          pathExists: () => true,
          readFile: (p) => fs.readFileSync(p),
          startMockUploadServer: require('../src/mock-upload-server').startMockUploadServer,
          loadState: require('../bin/transfer-images').loadState,
          appendState: () => {},
          defaultStatePath: () => '/tmp/should-not-be-used',
        },
      });
      // 2 files, 1 already in state → only 1 fetch
      assert.equal(fetchCalls, 1);
      assert.equal(report.total, 2);
      assert.equal(report.success, 2);     // 1 uploaded + 1 skipped
      const skipped = report.results.find((r) => r.skipped);
      assert.ok(skipped);
      assert.equal(skipped.basename || skipped.fileName, 'a_1.jpg');
      assert.equal(skipped.ok, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **步骤 2：运行测试验证**

运行：`node --test test/transfer-images.test.js -g "skips basenames already in state" -v`
预期：PASS（任务 5 的重构已经实现了 state 过滤）

### 任务 6.2：Commit

- [ ] **步骤 1：Commit**

```bash
git add test/transfer-images.test.js
git commit -m "test(transfer-images): resume skips basenames in state file"
```

---

## 任务 7：`--force` 强制重传测试

### 任务 7.1：编写测试

**文件：** 修改：`test/transfer-images.test.js`

- [ ] **步骤 1：编写 1 个 force 测试**

```js
describe('transferImages --force', () => {
  const os = require('os');

  it('re-uploads basenames already in state when --force set', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'force-'));
    const stateFile = path.join(dir, 'state.ndjson');
    fs.writeFileSync(stateFile, JSON.stringify({
      basename: 'a_1.jpg', sku: 'a', id: 100, ts: 't', uploadUrl: 'http://test/up',
    }) + '\n');

    const files = [];
    for (const name of ['a_1.jpg', 'b_1.jpg']) {
      const p = path.join(dir, name);
      fs.writeFileSync(p, Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]));
      files.push(p);
    }

    let fetchCalls = 0;
    const fakeFetch = async () => {
      fetchCalls++;
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { id: fetchCalls } }) };
    };

    try {
      const report = await transferImages({
        paths: files,
        options: { uploadUrl: 'http://test/up', stateFile, force: true, fetchImpl: fakeFetch },
        deps: {
          loadEnvFile: () => {},
          pathExists: () => true,
          readFile: (p) => fs.readFileSync(p),
          startMockUploadServer: require('../src/mock-upload-server').startMockUploadServer,
          loadState: require('../bin/transfer-images').loadState,
          appendState: () => {},
          defaultStatePath: () => '/tmp/should-not-be-used',
        },
      });
      // force → both files fetched
      assert.equal(fetchCalls, 2);
      assert.equal(report.success, 2);
      const skipped = report.results.find((r) => r.skipped);
      assert.equal(skipped, undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **步骤 2：运行测试验证通过**

运行：`node --test test/transfer-images.test.js -g "force" -v`
预期：PASS（任务 5 重构已实现 force 分支）

- [ ] **步骤 3：Commit**

```bash
git add test/transfer-images.test.js
git commit -m "test(transfer-images): --force re-uploads state entries"
```

---

## 任务 8：`--state-file=` 覆盖默认派生路径

### 任务 8.1：编写测试

**文件：** 修改：`test/transfer-images.test.js`

- [ ] **步骤 1：编写 1 个 state-file 测试**

```js
describe('transferImages --state-file override', () => {
  const os = require('os');

  it('uses --state-file instead of defaultStatePath', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'override-'));
    const customState = path.join(workDir, 'custom.ndjson');

    const imgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'override-imgs-'));
    const p = path.join(imgDir, 'x_1.jpg');
    fs.writeFileSync(p, Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]));

    const fakeFetch = async () => ({
      ok: true, status: 200, json: async () => ({ code: 0, data: { id: 1 } }),
    });

    try {
      const report = await transferImages({
        paths: [p],
        options: { uploadUrl: 'http://test/up', stateFile: customState, fetchImpl: fakeFetch },
        deps: {
          loadEnvFile: () => {},
          pathExists: () => true,
          readFile: (p) => fs.readFileSync(p),
          startMockUploadServer: require('../src/mock-upload-server').startMockUploadServer,
          loadState: require('../bin/transfer-images').loadState,
          appendState: require('../bin/transfer-images').appendState,
          defaultStatePath: () => { throw new Error('defaultStatePath should NOT be called when --state-file set'); },
        },
      });
      assert.equal(report.success, 1);
      assert.ok(fs.existsSync(customState), 'state file should be created at --state-file path');
      const content = fs.readFileSync(customState, 'utf-8');
      assert.match(content, /"basename":"x_1.jpg"/);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
      fs.rmSync(imgDir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **步骤 2：运行测试验证通过**

运行：`node --test test/transfer-images.test.js -g "state-file override" -v`
预期：PASS

- [ ] **步骤 3：Commit**

```bash
git add test/transfer-images.test.js
git commit -m "test(transfer-images): --state-file overrides defaultStatePath"
```

---

## 任务 9：成功时 appendState 写入 NDJSON

### 任务 9.1：编写测试

**文件：** 修改：`test/transfer-images.test.js`

- [ ] **步骤 1：编写 1 个 append-after-success 测试**

```js
describe('transferImages appendState on success', () => {
  const os = require('os');

  it('writes one NDJSON line per successful upload', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'append-success-'));
    const stateFile = path.join(dir, 'state.ndjson');

    const files = [];
    for (let i = 0; i < 3; i++) {
      const p = path.join(dir, `img${i}_1.jpg`);
      fs.writeFileSync(p, Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]));
      files.push(p);
    }

    let idCounter = 0;
    const fakeFetch = async () => {
      idCounter++;
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { id: idCounter * 100 } }) };
    };

    try {
      await transferImages({
        paths: files,
        options: { uploadUrl: 'http://test/up', stateFile, fetchImpl: fakeFetch },
        deps: {
          loadEnvFile: () => {},
          pathExists: () => true,
          readFile: (p) => fs.readFileSync(p),
          startMockUploadServer: require('../src/mock-upload-server').startMockUploadServer,
          loadState: () => new Map(),
          appendState: require('../bin/transfer-images').appendState,
          defaultStatePath: () => '/tmp/should-not-be-used',
        },
      });
      assert.ok(fs.existsSync(stateFile));
      const lines = fs.readFileSync(stateFile, 'utf-8').split('\n').filter(Boolean);
      assert.equal(lines.length, 3);
      const entries = lines.map((l) => JSON.parse(l));
      assert.deepEqual(entries.map((e) => e.id), [100, 200, 300]);
      assert.ok(entries.every((e) => e.uploadUrl === 'http://test/up'));
      assert.ok(entries.every((e) => typeof e.ts === 'string' && e.ts.length > 0));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **步骤 2：运行测试验证通过**

运行：`node --test test/transfer-images.test.js -g "writes one NDJSON line per successful" -v`
预期：PASS

- [ ] **步骤 3：Commit**

```bash
git add test/transfer-images.test.js
git commit -m "test(transfer-images): appendState writes NDJSON on success"
```

---

## 任务 10：失败时**不**写 state

### 任务 10.1：编写测试

**文件：** 修改：`test/transfer-images.test.js`

- [ ] **步骤 1：编写 1 个失败不写 state 测试**

```js
describe('transferImages no state write on failure', () => {
  const os = require('os');

  it('does not append state when upload fails', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fail-no-state-'));
    const stateFile = path.join(dir, 'state.ndjson');

    const okPath = path.join(dir, 'ok_1.jpg');
    const failPath = path.join(dir, 'fail_1.jpg');
    fs.writeFileSync(okPath, Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]));
    fs.writeFileSync(failPath, Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]));

    let n = 0;
    const fakeFetch = async () => {
      n++;
      if (n === 1) return { ok: false, status: 500, text: async () => 'server error' };
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { id: 1 } }) };
    };

    try {
      const report = await transferImages({
        paths: [failPath, okPath],
        options: { uploadUrl: 'http://test/up', stateFile, uploadRetries: 0, fetchImpl: fakeFetch },
        deps: {
          loadEnvFile: () => {},
          pathExists: () => true,
          readFile: (p) => fs.readFileSync(p),
          startMockUploadServer: require('../src/mock-upload-server').startMockUploadServer,
          loadState: () => new Map(),
          appendState: require('../bin/transfer-images').appendState,
          defaultStatePath: () => '/tmp/should-not-be-used',
        },
      });
      assert.equal(report.success, 1);
      assert.equal(report.failed, 1);

      const lines = fs.readFileSync(stateFile, 'utf-8').split('\n').filter(Boolean);
      assert.equal(lines.length, 1, 'only the successful upload should write state');
      const entry = JSON.parse(lines[0]);
      assert.equal(entry.basename, 'ok_1.jpg');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **步骤 2：运行测试验证通过**

运行：`node --test test/transfer-images.test.js -g "does not append state when upload fails" -v`
预期：PASS

- [ ] **步骤 3：Commit**

```bash
git add test/transfer-images.test.js
git commit -m "test(transfer-images): failed uploads do not write state"
```

---

## 任务 11：完整跨进程 resume 集成测试

### 任务 11.1：编写测试

**文件：** 修改：`test/transfer-images.test.js`

- [ ] **步骤 1：编写跨进程模拟测试**

```js
describe('transferImages cross-run resume', () => {
  const os = require('os');

  it('second run with same stateFile skips already-uploaded', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-run-'));
    const stateFile = path.join(dir, 'state.ndjson');

    const files = [];
    for (let i = 0; i < 4; i++) {
      const p = path.join(dir, `img${i}_1.jpg`);
      fs.writeFileSync(p, Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]));
      files.push(p);
    }

    const makeFetch = () => {
      let calls = 0;
      const fetchImpl = async () => {
        calls++;
        return { ok: true, status: 200, json: async () => ({ code: 0, data: { id: calls } }) };
      };
      return { fetchImpl, getCalls: () => calls };
    };

    const deps = {
      loadEnvFile: () => {},
      pathExists: () => true,
      readFile: (p) => fs.readFileSync(p),
      startMockUploadServer: require('../src/mock-upload-server').startMockUploadServer,
      loadState: require('../bin/transfer-images').loadState,
      appendState: require('../bin/transfer-images').appendState,
      defaultStatePath: () => '/tmp/should-not-be-used',
    };

    try {
      // First run: 4 fetches
      const f1 = makeFetch();
      const r1 = await transferImages({
        paths: files,
        options: { uploadUrl: 'http://test/up', stateFile, fetchImpl: f1.fetchImpl },
        deps,
      });
      assert.equal(f1.getCalls(), 4);
      assert.equal(r1.success, 4);

      // Second run: same stateFile → 0 fetches (all skipped via state)
      const f2 = makeFetch();
      const r2 = await transferImages({
        paths: files,
        options: { uploadUrl: 'http://test/up', stateFile, fetchImpl: f2.fetchImpl },
        deps,
      });
      assert.equal(f2.getCalls(), 0, 'second run should skip all already-uploaded basenames');
      assert.equal(r2.total, 4);
      assert.equal(r2.success, 4);
      assert.ok(r2.results.every((r) => r.skipped === true));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **步骤 2：运行测试验证通过**

运行：`node --test test/transfer-images.test.js -g "second run with same stateFile" -v`
预期：PASS

- [ ] **步骤 3：Commit**

```bash
git add test/transfer-images.test.js
git commit -m "test(transfer-images): cross-run resume skips all already-uploaded"
```

---

## 任务 12：README 新增"断点续传"段落

### 任务 12.1：编写 README 更新

**文件：** 修改：`README.md`（在"独立图片传输脚本" / "批量上传整个目录 + 日志监控"段落后追加新段落）

- [ ] **步骤 1：找到 README 中"批量上传整个目录 + 日志监控"段落的尾部**

- [ ] **步骤 2：在该段落后追加新段落**

```markdown
### 断点续传 / State 文件

跑大目录（> 1000 张）时，进程崩溃或上游恢复后想继续跑，没必要从头传：

```bash
# 第一次：传 25k 张；中途 kill -9 也行（最多丢 ≤ concurrency 张）
node bin/transfer-images.js --dir=/mnt/d/.../images --log-file=/tmp/xfer.log

# 第二次：自动跳过已成功的，只传剩下的
node bin/transfer-images.js --dir=/mnt/d/.../images --log-file=/tmp/xfer.log
```

**state 文件位置**：默认 `<cwd>/.transfer-state/<sha1-of-dir>.ndjson`（按 `--dir` 派生）。
**覆盖**：`--state-file=/path/to/state.ndjson`
**强制重传**：`--force`（忽略 state，全部重新传）

state 文件每行一条 NDJSON：

```json
{"basename":"100PCSGXBSYT00001V0_1.jpg","sku":"100PCSGXBSYT00001V0","id":12345,"ts":"2026-07-01T14:50:04Z","uploadUrl":"http://.../upload"}
```

**内存**：流式扫描 + worker 内逐张 readFile，25k 张峰值 < 1MB。
**注意**：不要同时跑两个 `transfer-images` 进程处理同一 `--dir`，会双写 state 文件混乱。
```

- [ ] **步骤 3：手动 sanity 检查 README 格式**

运行：`grep -A 1 "断点续传" README.md | head -30`
预期：能看到新段落，markdown 格式正确

- [ ] **步骤 4：Commit**

```bash
git add README.md
git commit -m "docs(readme): document resume / state-file usage"
```

---

## 任务 13：完整测试套件验证 + 推送

### 任务 13.1：跑全套测试

- [ ] **步骤 1：跑 transfer-images + image-uploader 全部测试**

运行：`node --test test/transfer-images.test.js test/image-uploader.test.js 2>&1 | tail -50`
预期：所有 case 通过；总数 = 87（74 旧 + 13 新增：4 loadState + 3 appendState + 3 defaultStatePath + 2 parseTransferArgs + 1 streaming）

- [ ] **步骤 2：跑全套测试**

运行：`node --test test/ 2>&1 | tail -30`
预期：所有 case 通过；总数应等于项目当前数量 + 13

- [ ] **步骤 3：Commit + push**

```bash
git status                                # 确认 working tree clean
git log --oneline -10                     # 检查 commit 历史
git push origin main
```

预期：push 成功；远端 main 比本地 main 旧 4-7 个 commit

---

## 自检

**规格覆盖度**：

| 规格章节 | 覆盖任务 |
|---|---|
| §6 `loadState` | 任务 1 |
| §6 `appendState` | 任务 2 |
| §6 `defaultStatePath` | 任务 3 |
| §5 `--state-file` / `--force` CLI | 任务 4 |
| §6 `transferImages` 改动（流式） | 任务 5 |
| §8 数据流（resume 跳过） | 任务 6 |
| §3 `--force` 行为 | 任务 7 |
| §3 `--state-file` 覆盖 | 任务 8 |
| §8.2 worker 写 state | 任务 9 |
| §9 错误表（失败不写 state） | 任务 10 |
| §8.3 跨进程 resume | 任务 11 |
| 文档 | 任务 12 |
| 全套验证 | 任务 13 |

**占位符扫描**：所有步骤均含具体代码，无 TODO / "类似" / "补充细节"。

**类型一致性**：所有任务使用一致的 `entry` shape `{ basename, sku, id, ts, uploadUrl }`；`appendState(stateFile, entry, deps)`；`loadState(stateFile, deps)`；`defaultStatePath(dir)`。