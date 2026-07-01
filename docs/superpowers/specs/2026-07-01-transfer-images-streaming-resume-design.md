# 独立图片传输脚本 — 流式 + 断点续传（设计规格）

**日期**：2026-07-01
**会话**：图片传输_2
**作者**：claude
**状态**：草案 → 实施前

---

## 1. 背景与目标

`bin/transfer-images.js`（详见 `2026-06-30-standalone-image-transfer-design.md`）已支持位置参数 / `--dir` / `--recursive` / `--log-file` / `--quiet` / `--mock-upload`。在 22k 张 3GB 真实目录（`/mnt/d/project/0625临时合并/images/images`）下暴露两个问题：

1. **内存爆炸**：当前实现 `paths.map(p => { const buffer = readFile(p); ... })` 在 `transferImages()` 启动阶段把所有图片一次性 `readFileSync` 进内存（≈3GB），OOM 风险高。
2. **不可靠**：进程中途崩溃 / 上游恢复后想重跑，必须从头再来；已上传的 SKU 全部重传浪费配额。

**目标**：在保留现有 CLI 接口与 `ImageUploader` 行为的前提下，把 `transferImages()` 改成 **pull-style 异步迭代器**（内存峰值降至 `concurrency × avg_image_size`），并引入 **NDJSON 状态文件** 支持**断点续传** + **`--force` 强制重传**。

## 2. 范围

### 在范围内

- `bin/transfer-images.js` 改为 pull-style 流式（异步迭代器）
- 新增 `--state-file=<path>` / `--force` 两个 CLI 标志
- 新增状态文件 `loadState` / `appendState` / `defaultStatePath` 三个工具函数
- 状态文件默认按 `--dir` 派生路径（`.transfer-state/<sha1-hash>.ndjson`）
- 内存峰值 < 1MB（22k 张 × concurrency=2）
- 保留现有 `--dir` / `--recursive` / `--log-file` / `--quiet` / `--mock-upload` 等所有标志
- `ImageUploader` 类**一行不改**（保护 18 个 legacy 测试 + onProgress 行为）
- `test/transfer-images.test.js` 新增 9 个测试 case

### 不在范围内（YAGNI）

- 不做并发文件锁（用户需自行避免同一目录并发跑两次）
- 不做"连续失败 N 张就早停"（用户上一轮明确未选）
- 不改 state 文件 schema 之外的内容（不存失败记录，不存时间窗口统计）
- 不引入新 npm 依赖（用 `node:crypto` 自带的 sha1）
- 不改 `ImageUploader.upload()` 的 worker 池实现（已有 onProgress + limitConcurrency 已够用）
- 不支持 `--state-file` 之外的远端状态（No S3 / Redis）

## 3. 设计决策记录

| 维度 | 选择 | 理由 |
|---|---|---|
| 整体方案 | 异步迭代器（pull-style） | 用户选择 A；改动局部，复用 limitConcurrency |
| 状态键 | basename (e.g. `100PCSGXBSYT00001V0_1.jpg`) | 用户选择；跨路径稳定、可读 |
| 状态格式 | NDJSON (append-only) | 用户选择；append 廉价、崩了丢最后一行、tail -f 可监控 |
| 状态位置 | per-`--dir` 派生 | 用户选择；不同目录互不干扰 |
| 强制重传 | `--force` 标志 | 用户选择；默认值仍跳过 |
| 报告输出 | stdout 仍输出汇总 JSON | 用户选择；25k 项 ~5-10MB，jq 可读 |
| ImageUploader | 一行不改 | 保护 18 个 legacy 测试 + 已通过 onProgress 测试 |
| 并发模型 | 复用现有 `limitConcurrency` (worker pool) | 已测试，零回归风险 |

## 4. 架构

```
                       bin/transfer-images.js
┌────────────────────────────────────────────────────────────┐
│  parseTransferArgs(argv)                                    │
│    → { paths, options: { dir, recursive, stateFile,        │
│                          force, logFile, quiet, ... } }    │
└────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────────┐
│  transferImages({ paths, options, deps? })                  │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ 1. loadEnv()                                         │  │
│  │ 2. resolveStatePath()  --state-file or defaultState  │  │
│  │ 3. loadState(stateFile) → doneMap: Map<basename,entry>│  │
│  │ 4. scanImages(opts.dir) → allPaths: string[]         │  │
│  │ 5. filter: doneMap 排除 (除非 --force)               │  │
│  │ 6. async function* iter():                           │  │
│  │       for path of remaining:                         │  │
│  │         { path, fileName, ext, size, sku }  ← 仅 stat│  │
│  │ 7. uploader.upload({ _preloadedItems: iter() })      │  │
│  │       → limitConcurrency(2, worker)                  │  │
│  │         worker: readFile → uploadSingle              │  │
│  │           ok → appendState(stateFile, line)          │  │
│  │ 8. emit { total, success, failed, results }          │  │
│  └──────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
                            │
                            ▼
                  src/image-uploader.js  (不变)
              limitConcurrency / uploadSingle
              onProgress(start/success/failure)
```

**职责边界**：

| 模块 | 责任 | 不应负责 |
|---|---|---|
| `bin/transfer-images.js` | 扫描目录 / 状态文件 IO / SKU 推断 / 流式迭代器 / 终态报告 | 上传协议 / 重试 / 并发 worker 池 |
| `ImageUploader` | 上传流水线（含并发、重试、magic bytes、onProgress） | 文件读取位置 / SKU 推断 / 状态文件 |

## 5. CLI 接口

```
node bin/transfer-images.js [options] [--dir=<path>] [<path1> <path2> ...]
```

### 新增 / 改动标志

| 参数 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `--state-file=<path>` | ❌ | `<cwd>/.transfer-state/<sha1-of-resolved-dir>.ndjson` | NDJSON 状态文件路径；不存在则视为空集 |
| `--force` | ❌ | `false` | 忽略 state 文件中已成功的 basename，全部重传 |

### 已有标志（不变）

`--upload-url=` / `--upload-concurrency=` / `--upload-retries=` / `--node-code=` / `--node-token=` / `--mock-upload` / `--no-progress` / `--dir=` / `--recursive` / `--log-file=` / `--quiet`

### 退出码（不变）

| 码 | 含义 |
|---|---|
| `0` | 至少 1 张上传成功 |
| `1` | 全部失败 或 启动阶段错误 |
| `2` | `ConfigError`（如 URL 未配置） |

## 6. 模块导出

```js
// bin/transfer-images.js（增量）
module.exports = {
  parseTransferArgs,    // (argv) => { paths, options }
  transferImages,       // ({ paths, options, deps? }) => Promise<Report>
  scanImages,           // (dir, recursive) => Promise<string[]>
  makeLogger,           // ({ quiet, logFile }) => Logger
  loadState,            // (stateFile) => Map<basename, Entry>      ← 新
  appendState,          // (stateFile, entry) => void                ← 新
  defaultStatePath,     // (dir) => string                            ← 新
  IMAGE_EXTS,
  ConfigError,
  main,
};
```

### `loadState(stateFile)`

签名：`loadState(stateFile: string): Map<string, Entry>`

行为：
- 文件不存在 → 返回空 `Map`
- 文件存在 → 按 `\n` split，逐行 trim
- 每行尝试 `JSON.parse`：成功则 `map.set(entry.basename, entry)`；失败 → `logger.warn(\`skipping malformed state line: <line>\`)`，跳过
- 重复 basename → 保留**首次**写入的 entry（防 --force 跑两次时 id 不稳定）

**Entry shape**：
```ts
{
  basename: string,     // 主键，例如 "100PCSGXBSYT00001V0_1.jpg"
  sku: string,          // 推断的 SKU
  id: number | null,    // 上游返回 id；data: null 时为 null
  ts: string,           // ISO 时间
  uploadUrl: string,    // 上传 endpoint（防换 endpoint 时误判）
}
```

### `appendState(stateFile, entry)`

签名：`appendState(stateFile: string, entry: Entry): void`

行为：
- 若 `stateFile` 所在目录不存在 → `fs.mkdirSync(dirname, { recursive: true })`
- `fs.appendFileSync(stateFile, JSON.stringify(entry) + '\n')`
- 失败（磁盘满 / 权限）→ `logger.error(\`failed to append state: ${e.message}\`)`，**不抛出**

### `defaultStatePath(dir)`

签名：`defaultStatePath(dir: string): string`

行为：
```js
const crypto = require('node:crypto');
function defaultStatePath(dir) {
  const resolved = path.resolve(dir);
  const hash = crypto.createHash('sha1').update(resolved).digest('hex').slice(0, 12);
  return path.join(process.cwd(), '.transfer-state', `${hash}.ndjson`);
}
```

例：`defaultStatePath('/mnt/d/project/0625临时合并/images/images')` → `/mnt/d/project/hs-sku-crawler/.transfer-state/3a4b5c6d7e8f.ndjson`

### `transferImages({ paths, options, deps? })` — **改动**

新增 deps（注入用于测试）：
```js
deps = {
  loadEnvFile,                 // 已有
  pathExists,                  // 已有
  readFile,                    // 已有；测试时可注入计数器
  startMockUploadServer,       // 已有
  scanImages,                  // 已有
  loadState,                   // 新
  appendState,                 // 新
  defaultStatePath,            // 新
}
```

新增 options（由 `parseTransferArgs` 填入）：
```js
options = {
  ...,
  stateFile: string | undefined,    // --state-file=<path>
  force: boolean,                   // --force
}
```

**改动后的执行流**（伪代码）：
```js
async function transferImages({ paths, options, deps = {} }) {
  const { loadState, appendState, defaultStatePath, scanImages, ... } = deps;
  const opts = { ...options };
  const logger = makeLogger({ quiet: opts.quiet, logFile: opts.logFile });

  // 1. mock / uploadUrl 解析同前
  let mockHandle = null;
  if (opts.mockUpload) { mockHandle = await startMock(); opts.uploadUrl = mockHandle.url; }
  if (!opts.uploadUrl && process.env.CRAWLER_IMAGE_UPLOAD_URL) opts.uploadUrl = process.env.CRAWLER_IMAGE_UPLOAD_URL;
  if (!opts.uploadUrl) throw new ConfigError('upload url required: ...');

  // 2. 解析扫描路径
  let allPaths = [...paths];
  if (opts.dir) {
    if (!pathExists(opts.dir)) throw new Error(`directory not found: ${opts.dir}`);
    const scanned = await scanImages(opts.dir, !!opts.recursive);
    logger.info(`Scanned ${scanned.length} images from ${opts.dir}${opts.recursive ? ' (recursive)' : ''}`);
    allPaths = allPaths.concat(scanned);
  }
  // dedup
  const seenSet = new Set();
  allPaths = allPaths.filter(p => seenSet.has(p) ? false : (seenSet.add(p), true));
  if (allPaths.length === 0) throw new Error('no paths provided (pass positional paths or --dir=)');

  // 3. ★ 加载状态文件
  const stateFile = opts.stateFile || (opts.dir ? defaultStatePath(opts.dir) : null);
  const doneMap = stateFile ? loadState(stateFile) : new Map();
  if (stateFile) {
    logger.info(`State: ${doneMap.size} basenames already uploaded at ${stateFile}`);
  }

  // 4. ★ 过滤已上传
  const skipped = [];
  let toUpload = allPaths;
  if (!opts.force && doneMap.size > 0) {
    const before = allPaths.length;
    toUpload = allPaths.filter(p => {
      const basename = path.basename(p);
      if (doneMap.has(basename)) {
        skipped.push({ basename, sku: doneMap.get(basename).sku });
        return false;
      }
      return true;
    });
    logger.info(`Resume: skipping ${before - toUpload.length} already-uploaded, ${toUpload.length} to upload${opts.force ? ' (force=true ignored due to flag absent)' : ''}`);
  } else if (opts.force) {
    logger.info(`--force set: ignoring state, will upload all ${toUpload.length}`);
  }

  // 5. ★ 流式迭代器（仅 stat, 不 readFile）
  async function* iter() {
    for (const p of toUpload) {
      const stats = fs.statSync(p);
      const ext = path.extname(p);
      const fileName = path.basename(p);
      const sku = fileName.replace(/_\d+\.[^.]+$/, '');
      yield { path: p, fileName, ext, sku, size: stats.size };
    }
  }

  // 6. ★ 构造 uploadItems：从迭代器里读 buffer 喂给 worker
  const fileSizeByName = new Map();
  const preloaded = [];   // 全部项（最终一次性 push 给 _preloadedItems）

  //   这里有微妙处：见 §8.2
  //   我们让 worker 自己 readFile，所以这里只传"路径 + 元信息"
  //   uploadSingle 不再接收 buffer 而接收 path
  //   ——但这需要改 ImageUploader。本规格选择**最小改动**：
  //   让 worker 同步 readFile 后调 uploadSingle（仍传 buffer）
  //   这样 _preloadedItems 形态不变

  // 7. 复用现有 uploader.upload()，注入 onProgress
  //   (略，与现状一致)
}
```

**关键决策**：流式迭代器只 yield `{path, fileName, ext, sku, size}`（不 yield buffer）。在 `limitConcurrency` 的 worker 内**同步 readFile**（单张 < 200KB，无事件循环饿死风险）→ 喂给现有 `uploadSingle(payload)`。

### `main(argv?)` — 改动

新增退出码分支不变；增加 `--state-file` / `--force` 解析。

## 7. ImageUploader 改动

**零改动**。所有流式 + state 逻辑在 `transferImages` 内。

理由：
- 现有 `_preloadedItems` 旁路已经接受 `{ fileName, buffer, contentType }` 形态
- 现有 `onProgress` 三阶段回调够用
- 现有 `limitConcurrency` worker pool 够用
- 改 `ImageUploader` 会触发 18 个 legacy case + 已有的 9 个 onProgress case 回归

## 8. 数据流

### 8.1 启动阶段

```
loadEnv()
  → 解析 options
  → resolve stateFile
  → loadState(stateFile) → doneMap
  → scanImages(dir) → allPaths
  → filter: 排除 doneMap 中的 basename（除非 --force）
  → async function* iter()  ← 仅 stat，不 readFile
  → 打印 [INFO] Resume: skipping X, Y to upload
```

### 8.2 worker 内（limitConcurrency 内）

```
loop:
  { value, done } = await iter.next()
  if done: break

  // ★ 在 worker 内读 buffer（流式核心）
  buffer = fs.readFileSync(value.path)
  contentType = ImageUploader.prototype.detectContentType(buffer, value.ext)
  if !contentType:
    onProgress({ phase: 'failure', error: 'unknown content type' })
    continue

  payload = { nodeCode, nodeToken, sku: value.sku, contentType, fileName: value.fileName, imageBase64: buffer.toString('base64') }

  try:
    result = await uploadSingle(payload)  // 现有，含重试 + 业务码检查
    onProgress({ phase: 'success', id: result.id })

    // ★ 成功后写 state
    entry = {
      basename: value.fileName,
      sku: value.sku,
      id: result.id,
      ts: new Date().toISOString(),
      uploadUrl: opts.uploadUrl,
    }
    appendState(stateFile, entry)

    return { status: 'uploaded', data: { id: result.id, response: result.response } }
  catch e:
    onProgress({ phase: 'failure', error: e.message })
    return { status: 'failed', fileName: value.fileName, error: e.message }
```

### 8.3 收敛阶段

```
summary = uploader.upload(...)
  → uploaded: [{ id, response, fileName, ... }, ...]
  → failed:   [{ fileName, error }, ...]

// 与 skipped（已上传 basename）合并为完整 results
results = [
  ...uploaded.map(u => ({ path, sku, fileName, ok: true, response, ... })),
  ...failed.map(f => ({ path, sku, fileName, ok: false, error, ... })),
  ...skipped.map(s => ({ basename: s.basename, sku: s.sku, ok: true, skipped: true })),
]

report = { total: results.length, success, failed, results }
stdout.write(JSON.stringify(report, null, 2))
```

## 9. 错误处理

| 场景 | 行为 | 退出码 |
|---|---|---|
| 启动错误（URL 缺失 / 路径不存在 / mock 启动失败） | `main()` catch → stderr + 简化 JSON | `1` 或 `2`（ConfigError） |
| state 文件不存在 | 当空集处理 | — |
| state 文件某行 JSON 损坏 | `logger.warn` 跳过该行 | — |
| state 文件 basename 冲突（多行） | 保留首次写入；`--force` 时正常覆盖 | — |
| `--state-file=` 路径所在目录不存在 | 自动 `mkdirSync({recursive: true})` | — |
| `appendState` 失败（磁盘满 / 权限） | `logger.error`，**不抛出**，继续 batch | — |
| 单张 readFile 失败 | 标记 failed，**不**写 state | — |
| 单张 upload 失败（含重试耗尽） | 标记 failed，**不**写 state（下次重启会重试） | — |
| 进程 SIGKILL 在 appendState 中途 | 最多丢 ≤ concurrency 行（正在处理的 N 张） | — |
| 同时跑两个 transfer-images 同一 dir | **不做文件锁**；state 可能双写混乱。README 注明 | — |
| state 文件已有但 basename 已被新文件占用 | **不感知**，按 basename 字符串匹配 | — |

**关键不变量**：
- state 文件里出现 basename ⇒ 那张图上一次完整成功过
- state 文件里没出现 basename ⇒ 没成功过（或刚失败）

## 10. 测试

### 10.1 新增测试（`test/transfer-images.test.js`）

**`loadState`（4 cases）**

1. 不存在的文件 → 空 Map
2. 损坏的 NDJSON 行 → 跳过 + warn
3. 重复 basename → 保留首次
4. 空文件 → 空 Map

**`defaultStatePath`（3 cases）**

5. 同 dir 同 CWD → 同 hash
6. 不同 dir → 不同 hash
7. 路径在 `.transfer-state/` 子目录下

**`transferImages` 流式 + resume 集成（6 cases）**

8. **流式行为**：mock fetch 让每张延迟 50ms；20 张 + concurrency=2 → 注入 `mockReadFile` 计数器，确认**未预读全部**（峰值 ≤ concurrency × 2）
9. **resume**：第一次跑 2 张成功 → state 文件有 2 行；第二次跑同 2 张 + 同 stateFile → 跳过（fetch 不被调用）
10. **`--force`**：第二次带 `--force` → fetch 被调用 N 次
11. **`--state-file=` 覆盖**：自定义 tmp 路径，验证 state 写到该路径
12. **state 写入时 fetch 失败**：失败项**不**进 state 文件
13. **state 文件追加**：跑 5 张成功 → 文件恰好 5 行 NDJSON，每行可 parse

### 10.2 现有测试（必须全部通过）

- `test/transfer-images.test.js` 现 65 个 case
- `test/image-uploader.test.js` 18 + 9 个 case（skuForImage + onProgress）
- 其他 test-sku / worker / cli-image-upload-config / bin-run / service.integration 不动

总计目标：**74 现有 + 13 新增 = 87 个 case 全部通过**。

## 11. 文件改动清单

| 文件 | 操作 | 行数预估 |
|---|---|---|
| `bin/transfer-images.js` | 改：流式 + state | +50 ~ +80 |
| `test/transfer-images.test.js` | 改：新增 13 case | +150 |
| `README.md` | 改：新增"断点续传"段落 + state 文件位置说明 | +30 |
| `node:crypto` | **新增 import**（已有 node 内置） | +1 |

**ImageUploader / src/image-uploader.js：零改动**。

## 12. 工作流

1. spec-review（用户审查本文档）
2. writing-plans 技能 → `docs/superpowers/plans/2026-07-01-transfer-images-streaming-resume-plan.md`
3. executing-plans 技能 → TDD 实现
4. 提交 + 推送

## 13. 风险与对策

| 风险 | 概率 | 影响 | 对策 |
|---|---|---|---|
| worker 内 `readFileSync` 阻塞事件循环 | 低 | 中 | 单张 ~150KB < Node 阈值；测试验证 20 张并发无事件循环饿死 |
| state 文件 basename 冲突（同目录两文件同名） | 低 | 高 | scanImages 当前去重保留首个；state 按 basename 也去重；冲突概率极低 |
| 并发跑同一目录导致 state 文件双写 | 中 | 中 | README 注明"不要并发跑同一 --dir"；不实现文件锁（YAGNI） |
| `--state-file` 路径不存在 | 低 | 低 | `appendState` 自动 `mkdirSync({recursive: true})` |
| `appendFileSync` 失败但进程继续 | 低 | 中 | `logger.error` + 不抛错；测试覆盖 |
| 25k 项 stdout JSON 输出过大 | 低 | 低 | 用户选择保留；jq 可处理 |
| state 文件 path 编码（中文路径） | 低 | 低 | `path.resolve` + sha1 编码稳定；测试覆盖 |
| ImageUploader 改动风险 | **零** | — | **本规格明确不修改 ImageUploader** |

## 14. 开放问题

（无；所有不确定性已在 §2、§3 决策表中收敛。）

---

**下一步**：用户审阅本文档 → 调用 `writing-plans` 技能创建实现计划。