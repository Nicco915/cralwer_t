# 临时调度任务（temp-dispatcher）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 实现一个独立 dispatcher（Excel → tasks 协议派发、callback → 结果 Excel + 图片收集），复用现有爬虫镜像与容器，跑完 5570 个 SKU 的临时任务后不污染正式链路。

**架构：** 5 个 CommonJS 小模块（excel-source / task-store / result-writer / http-server / index）放在 `scripts/temp-dispatcher/`，以 volume 挂进现有 `CRAWLER_IMAGE` 容器运行；协议端点路径与上游完全一致（`/renren-api/classify/open/crawler/{tasks,callback}`），crawler 容器零适配。

**技术栈：** Node 20、exceljs（生产依赖，镜像内已有）、json-bigint（与 poller/pusher 一致）、node:test。

**设计规格：** `docs/superpowers/specs/2026-07-13-temp-dispatcher-design.md`

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `scripts/temp-dispatcher/excel-source.js` | 读 Sheet1，返回 sku 数组 + `Map<sku,{hsCode,productName}>` + 重复清单 |
| `scripts/temp-dispatcher/task-store.js` | 任务状态机（pending/issued/completed）+ lease 回收 + state.json 原子持久化 |
| `scripts/temp-dispatcher/result-writer.js` | callback → results.jsonl 追加；导出 result.xlsx（join 税号/品名 + 扫描图片名） |
| `scripts/temp-dispatcher/http-server.js` | 3 个端点（tasks/callback/stats/export）协议层 |
| `scripts/temp-dispatcher/index.js` | 入口：env 装配、lease 定时器、完成自动导出、优雅退出 |
| `scripts/temp-dispatcher/deploy/dispatcher.compose.yml` | dispatcher 容器（复用镜像，command 覆盖） |
| `scripts/temp-dispatcher/deploy/crawler.compose.yml` | 临时 crawler 模板（`--scale` 起 8~10 个） |
| `scripts/temp-dispatcher/deploy/runbook.md` | bwg 操作手册 |
| `test/temp-dispatcher/*.test.js` | 4 个测试文件 |
| `package.json` | test 脚本追加 `test/temp-dispatcher/*.test.js` |

约定：测试命令统一 `node --test test/temp-dispatcher/<file>.test.js`；每个任务结束 commit。

---

### 任务 1：excel-source — Excel 读取与去重

**文件：**
- 创建：`scripts/temp-dispatcher/excel-source.js`
- 测试：`test/temp-dispatcher/excel-source.test.js`
- 修改：`package.json`（test 脚本）

- [ ] **步骤 1：编写失败的测试**

```js
// test/temp-dispatcher/excel-source.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ExcelJS = require('exceljs');
const { loadSkuSource } = require('../../scripts/temp-dispatcher/excel-source');

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xl-src-')), 'in.xlsx');
}

async function writeFixture(filePath, { sheetName = 'Sheet1', headers = ['sku', '建议税号', '建议品名'], rows }) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  ws.addRow(headers);
  for (const r of rows) ws.addRow(r);
  await wb.xlsx.writeFile(filePath);
}

describe('excel-source', () => {
  it('reads sku/hsCode/productName and skips empty rows', async () => {
    const file = tmpFile();
    await writeFixture(file, { rows: [
      ['SKU-A', 8458990000, 'LATHE'],
      [null, null, null],
      ['SKU-B', '7315820020', 'CHAIN SLING'],
    ] });
    const { skus, meta, duplicates } = await loadSkuSource(file, 'Sheet1');
    assert.deepStrictEqual(skus, ['SKU-A', 'SKU-B']);
    assert.deepStrictEqual(meta.get('SKU-A'), { hsCode: '8458990000', productName: 'LATHE' });
    assert.deepStrictEqual(meta.get('SKU-B'), { hsCode: '7315820020', productName: 'CHAIN SLING' });
    assert.deepStrictEqual(duplicates, []);
  });

  it('locates the SKU header case-insensitively', async () => {
    const file = tmpFile();
    await writeFixture(file, { headers: ['Sku', '建议税号', '建议品名'], rows: [['X1', 1, 'a']] });
    const { skus } = await loadSkuSource(file, 'Sheet1');
    assert.deepStrictEqual(skus, ['X1']);
  });

  it('dedupes duplicate sku keeping first occurrence and reporting row numbers', async () => {
    const file = tmpFile();
    await writeFixture(file, { rows: [
      ['DUP', 1, 'first'],
      ['OTHER', 2, 'x'],
      ['DUP', 3, 'second'],
    ] });
    const { skus, meta, duplicates } = await loadSkuSource(file, 'Sheet1');
    assert.deepStrictEqual(skus, ['DUP', 'OTHER']);
    assert.deepStrictEqual(meta.get('DUP'), { hsCode: '1', productName: 'first' });
    assert.deepStrictEqual(duplicates, [{ sku: 'DUP', rowNumber: 4 }]);
  });

  it('throws when the sheet does not exist', async () => {
    const file = tmpFile();
    await writeFixture(file, { rows: [['A', 1, 'a']] });
    await assert.rejects(() => loadSkuSource(file, 'Nope'), /Worksheet Nope not found/);
  });

  it('throws when the SKU column is missing', async () => {
    const file = tmpFile();
    await writeFixture(file, { headers: ['code', '建议税号', '建议品名'], rows: [['A', 1, 'a']] });
    await assert.rejects(() => loadSkuSource(file, 'Sheet1'), /SKU column not found/);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/temp-dispatcher/excel-source.test.js`
预期：FAIL，报错 `Cannot find module '../../scripts/temp-dispatcher/excel-source'`

- [ ] **步骤 3：实现 excel-source.js**

```js
// scripts/temp-dispatcher/excel-source.js
const ExcelJS = require('exceljs');

function cellText(cell) {
  if (!cell || cell.value == null) return '';
  const v = cell.value;
  if (typeof v === 'object') return String(v.text ?? v.result ?? '').trim();
  return String(v).trim();
}

async function loadSkuSource(excelPath, sheetName) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(excelPath);
  const worksheet = sheetName ? workbook.getWorksheet(sheetName) : workbook.worksheets[0];
  if (!worksheet) {
    throw new Error(`Worksheet ${sheetName || '(first)'} not found in ${excelPath}`);
  }

  let skuCol = -1;
  let hsCol = -1;
  let nameCol = -1;
  worksheet.getRow(1).eachCell((cell, colNumber) => {
    const v = cellText(cell).toUpperCase();
    if (v === 'SKU') skuCol = colNumber;
    else if (v === '建议税号') hsCol = colNumber;
    else if (v === '建议品名') nameCol = colNumber;
  });
  if (skuCol === -1) throw new Error('SKU column not found in header row');

  const skus = [];
  const meta = new Map();
  const duplicates = [];
  const seen = new Set();
  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber++) {
    const row = worksheet.getRow(rowNumber);
    const sku = cellText(row.getCell(skuCol));
    if (!sku) continue;
    if (seen.has(sku)) {
      duplicates.push({ sku, rowNumber });
      continue;
    }
    seen.add(sku);
    skus.push(sku);
    meta.set(sku, {
      hsCode: hsCol === -1 ? '' : cellText(row.getCell(hsCol)),
      productName: nameCol === -1 ? '' : cellText(row.getCell(nameCol)),
    });
  }
  return { skus, meta, duplicates };
}

module.exports = { loadSkuSource };
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test test/temp-dispatcher/excel-source.test.js`
预期：PASS 5/5

- [ ] **步骤 5：把新测试目录加入 npm test**

修改 `package.json` 的 scripts.test：
```json
"test": "node --test test/*.test.js test/fixtures/stub-server.test.js test/mock-production/*.test.js test/temp-dispatcher/*.test.js",
```

- [ ] **步骤 6：Commit**

```bash
git add scripts/temp-dispatcher/excel-source.js test/temp-dispatcher/excel-source.test.js package.json
git commit -m "feat(dispatcher): excel-source 读取 Sheet1 并防御性去重"
```

---

### 任务 2：task-store — 状态机、lease 回收、持久化

**文件：**
- 创建：`scripts/temp-dispatcher/task-store.js`
- 测试：`test/temp-dispatcher/task-store.test.js`

状态规则（来自规格）：success → completed；"Page shows no result"（大小写不敏感）→ completed 不重试；其他失败 attempts<2 → 退回 pending；否则 completed。issued 超过 leaseMs → 退回 pending。

- [ ] **步骤 1：编写失败的测试**

```js
// test/temp-dispatcher/task-store.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TaskStore, TASK_ID_OFFSET } = require('../../scripts/temp-dispatcher/task-store');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'task-store-'));
}

function makeStore(dir, opts = {}) {
  const store = new TaskStore({ stateDir: dir, leaseMs: opts.leaseMs ?? 1000, now: opts.now });
  store.init(['SKU-1', 'SKU-2', 'SKU-3']);
  return store;
}

describe('task-store', () => {
  it('issues pending tasks up to limit with upstream protocol shape', () => {
    const store = makeStore(tmpDir());
    const tasks = store.issue(2);
    assert.strictEqual(tasks.length, 2);
    assert.strictEqual(tasks[0].sku, 'SKU-1');
    assert.strictEqual(tasks[0].id, String(TASK_ID_OFFSET));
    assert.strictEqual(tasks[0].status, 'CRAWLING');
    assert.deepStrictEqual(store.stats(), { total: 3, pending: 1, issued: 2, completed: 0 });
    // nothing left beyond limit-1 pending
    assert.strictEqual(store.issue(10).length, 1);
    assert.strictEqual(store.issue(10).length, 0);
  });

  it('completes a task on success', () => {
    const store = makeStore(tmpDir());
    const [t] = store.issue(1);
    const v = store.complete({ taskId: t.id, success: true, errorMessage: '' });
    assert.strictEqual(v.outcome, 'completed');
    assert.strictEqual(store.stats().completed, 1);
  });

  it('does not retry "Page shows no result" failures', () => {
    const store = makeStore(tmpDir());
    const [t] = store.issue(1);
    const v = store.complete({ taskId: t.id, success: false, errorMessage: 'Page shows no result' });
    assert.strictEqual(v.outcome, 'completed');
    assert.strictEqual(store.stats().completed, 1);
  });

  it('retries other failures once, then marks final failure', () => {
    const store = makeStore(tmpDir());
    const [t] = store.issue(1);
    const v1 = store.complete({ taskId: t.id, success: false, errorMessage: 'Timeout 30000ms exceeded' });
    assert.strictEqual(v1.outcome, 'retry');
    assert.strictEqual(store.stats().pending, 3);
    const [t2] = store.issue(1);
    assert.strictEqual(t2.id, t.id); // same task re-issued
    const v2 = store.complete({ taskId: t2.id, success: false, errorMessage: 'Timeout 30000ms exceeded' });
    assert.strictEqual(v2.outcome, 'completed');
    assert.strictEqual(store.stats().completed, 1);
  });

  it('reclaims expired leases back to pending', () => {
    let clock = 100000;
    const store = makeStore(tmpDir(), { leaseMs: 60000, now: () => clock });
    store.issue(2);
    assert.strictEqual(store.reclaimExpiredLeases(), 0); // not expired yet
    clock += 61000;
    assert.strictEqual(store.reclaimExpiredLeases(), 2);
    assert.deepStrictEqual(store.stats(), { total: 3, pending: 3, issued: 0, completed: 0 });
  });

  it('persists state and restores it after restart', () => {
    const dir = tmpDir();
    const store1 = makeStore(dir);
    const [t] = store1.issue(1);
    store1.complete({ taskId: t.id, success: true, errorMessage: '' });
    const store2 = new TaskStore({ stateDir: dir });
    store2.init(['SKU-1', 'SKU-2', 'SKU-3']); // same sku list; state file wins
    assert.deepStrictEqual(store2.stats(), { total: 3, pending: 2, issued: 0, completed: 1 });
  });

  it('treats duplicate complete as duplicate and unknown id as orphan', () => {
    const store = makeStore(tmpDir());
    const [t] = store.issue(1);
    store.complete({ taskId: t.id, success: true, errorMessage: '' });
    assert.strictEqual(store.complete({ taskId: t.id, success: true, errorMessage: '' }).outcome, 'duplicate');
    assert.strictEqual(store.complete({ taskId: '999999', success: true, errorMessage: '' }).outcome, 'orphan');
    assert.strictEqual(store.isCompleted(t.id), true);
    assert.strictEqual(store.isCompleted('999999'), false);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/temp-dispatcher/task-store.test.js`
预期：FAIL，`Cannot find module '../../scripts/temp-dispatcher/task-store'`

- [ ] **步骤 3：实现 task-store.js**

```js
// scripts/temp-dispatcher/task-store.js
const fs = require('fs');
const path = require('path');

// 临时任务 ID 段，避开 mock(2070...) 与正式库 ID 段
const TASK_ID_OFFSET = 3070310839000000000n;
const NO_RESULT_PATTERN = /page shows no result/i;

class TaskStore {
  constructor(options) {
    this.stateDir = options.stateDir;
    this.leaseMs = options.leaseMs ?? 600000;
    this.maxAttempts = options.maxAttempts ?? 2;
    this.now = options.now || (() => Date.now());
    this.tasks = [];
    this.byId = new Map();
    this.statePath = path.join(this.stateDir, 'state.json');
  }

  init(skus) {
    fs.mkdirSync(this.stateDir, { recursive: true });
    if (fs.existsSync(this.statePath)) {
      const saved = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      this.tasks = saved.tasks;
    } else {
      this.tasks = skus.map((sku, index) => ({
        id: String(TASK_ID_OFFSET + BigInt(index)),
        sku,
        status: 'pending',
        attempts: 0,
        issuedAt: null,
      }));
      this.persist();
    }
    this.byId = new Map(this.tasks.map(t => [t.id, t]));
    return this.tasks.length;
  }

  issue(limit) {
    const out = [];
    for (const task of this.tasks) {
      if (out.length >= limit) break;
      if (task.status !== 'pending') continue;
      task.status = 'issued';
      task.issuedAt = this.now();
      out.push({ id: task.id, sku: task.sku, status: 'CRAWLING' });
    }
    if (out.length > 0) this.persist();
    return out;
  }

  complete({ taskId, success, errorMessage }) {
    const task = this.byId.get(String(taskId));
    if (!task) return { outcome: 'orphan' };
    if (task.status === 'completed') return { outcome: 'duplicate', sku: task.sku };

    task.attempts += 1;
    const noResult = !success && NO_RESULT_PATTERN.test(errorMessage || '');
    if (success || noResult || task.attempts >= this.maxAttempts) {
      task.status = 'completed';
      task.issuedAt = null;
      this.persist();
      return { outcome: 'completed', sku: task.sku };
    }
    task.status = 'pending';
    task.issuedAt = null;
    this.persist();
    return { outcome: 'retry', sku: task.sku };
  }

  isCompleted(taskId) {
    const task = this.byId.get(String(taskId));
    return !!task && task.status === 'completed';
  }

  reclaimExpiredLeases() {
    const cutoff = this.now() - this.leaseMs;
    let reclaimed = 0;
    for (const task of this.tasks) {
      if (task.status === 'issued' && task.issuedAt != null && task.issuedAt <= cutoff) {
        task.status = 'pending';
        task.issuedAt = null;
        reclaimed++;
      }
    }
    if (reclaimed > 0) this.persist();
    return reclaimed;
  }

  stats() {
    const counts = { pending: 0, issued: 0, completed: 0 };
    for (const t of this.tasks) counts[t.status]++;
    return { total: this.tasks.length, ...counts };
  }

  persist() {
    const tmp = `${this.statePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({
      version: 1,
      savedAt: new Date(this.now()).toISOString(),
      tasks: this.tasks,
    }));
    fs.renameSync(tmp, this.statePath);
  }
}

module.exports = { TaskStore, TASK_ID_OFFSET };
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test test/temp-dispatcher/task-store.test.js`
预期：PASS 7/7

- [ ] **步骤 5：Commit**

```bash
git add scripts/temp-dispatcher/task-store.js test/temp-dispatcher/task-store.test.js
git commit -m "feat(dispatcher): task-store 状态机 + lease 回收 + 原子持久化"
```

---

### 任务 3：result-writer — jsonl 追加与 Excel 导出

**文件：**
- 创建：`scripts/temp-dispatcher/result-writer.js`
- 测试：`test/temp-dispatcher/result-writer.test.js`

要点：append 失败必须抛错（HTTP 层据此回 500）；export 按源 sku 顺序输出全量行（无结果的 sku 结果列留空）；jsonl 中 `duplicate:true` 行跳过，同 sku 多行取首行；图片扫描按 `sku_序号.ext` 填入 image_1~5。

- [ ] **步骤 1：编写失败的测试**

```js
// test/temp-dispatcher/result-writer.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ExcelJS = require('exceljs');
const { ResultWriter } = require('../../scripts/temp-dispatcher/result-writer');

function makeWriter(opts = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-state-'));
  const imagesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-img-'));
  const writer = new ResultWriter({
    stateDir,
    imagesDir,
    skus: opts.skus || ['SKU-1', 'SKU-2', 'SKU-3'],
    meta: opts.meta || new Map([
      ['SKU-1', { hsCode: '8458990000', productName: 'LATHE' }],
      ['SKU-2', { hsCode: '7315820020', productName: 'CHAIN' }],
      ['SKU-3', { hsCode: '', productName: '' }],
    ]),
  });
  return { writer, stateDir, imagesDir };
}

describe('result-writer', () => {
  it('appends one jsonl line per callback with crawledAt', () => {
    const { writer, stateDir } = makeWriter();
    writer.append({ sku: 'SKU-1', success: true, goodsName: 'X' });
    const lines = fs.readFileSync(path.join(stateDir, 'results.jsonl'), 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 1);
    const row = JSON.parse(lines[0]);
    assert.strictEqual(row.sku, 'SKU-1');
    assert.strictEqual(row.success, true);
    assert.ok(row.crawledAt);
  });

  it('propagates write errors so the HTTP layer can return 500', () => {
    const { writer } = makeWriter();
    // 让 jsonl 路径变成一个目录 → appendFileSync 抛 EISDIR
    fs.mkdirSync(writer.jsonlPath);
    assert.throws(() => writer.append({ sku: 'SKU-1', success: true }));
  });

  it('export joins meta and image filenames, skips duplicate lines, first row wins', async () => {
    const { writer, stateDir, imagesDir } = makeWriter();
    fs.writeFileSync(path.join(imagesDir, 'SKU-1_1.jpg'), 'x');
    fs.writeFileSync(path.join(imagesDir, 'SKU-1_2.png'), 'x');
    fs.writeFileSync(path.join(imagesDir, 'SKU-2_1.webp'), 'x');
    fs.writeFileSync(path.join(imagesDir, 'unrelated.txt'), 'x');

    writer.append({ sku: 'SKU-1', success: true, goodsName: 'FIRST' });
    writer.append({ sku: 'SKU-1', success: true, goodsName: 'DUP-LINE', duplicate: true });
    writer.append({ sku: 'SKU-2', success: false, errorMessage: 'Page shows no result' });
    // SKU-3 没有 callback

    const excelPath = await writer.export();
    assert.strictEqual(excelPath, path.join(stateDir, 'result.xlsx'));

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(excelPath);
    const ws = wb.getWorksheet('Results');
    assert.strictEqual(ws.rowCount, 4); // header + 3 skus

    const r1 = ws.getRow(2);
    assert.strictEqual(r1.getCell(1).value, 'SKU-1');
    assert.strictEqual(String(r1.getCell(2).value), '8458990000');
    assert.strictEqual(r1.getCell(4).value, 'FIRST'); // first row wins, duplicate skipped
    assert.strictEqual(r1.getCell(10).value, 'SKU-1_1.jpg');
    assert.strictEqual(r1.getCell(11).value, 'SKU-1_2.png');

    const r2 = ws.getRow(3);
    assert.strictEqual(r2.getCell(9).value, 'Page shows no result');
    assert.strictEqual(r2.getCell(10).value, 'SKU-2_1.webp');

    const r3 = ws.getRow(4); // SKU-3: 无结果，结果列留空
    assert.strictEqual(r3.getCell(1).value, 'SKU-3');
    assert.strictEqual(r3.getCell(4).value, '');
    assert.strictEqual(r3.getCell(10).value, '');
  });
});
```

列顺序（getCell 索引）：1 sku、2 建议税号、3 建议品名、4 goodsName、5 goodsDesc、6 sourceUrl、7 rawContent、8 success、9 errorMessage、10~14 image_1~5、15 crawledAt。

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/temp-dispatcher/result-writer.test.js`
预期：FAIL，`Cannot find module '../../scripts/temp-dispatcher/result-writer'`

- [ ] **步骤 3：实现 result-writer.js**

```js
// scripts/temp-dispatcher/result-writer.js
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const IMAGE_RE = /^(.*)_(\d+)\.(jpe?g|png|webp)$/i;

class ResultWriter {
  constructor({ stateDir, imagesDir, skus, meta }) {
    this.stateDir = stateDir;
    this.imagesDir = imagesDir;
    this.skus = skus;
    this.meta = meta;
    this.jsonlPath = path.join(stateDir, 'results.jsonl');
    this.excelPath = path.join(stateDir, 'result.xlsx');
  }

  append(record) {
    // 抛错由调用方处理（HTTP 层回 500，触发爬虫侧 pusher 重推）
    fs.appendFileSync(this.jsonlPath, JSON.stringify({ ...record, crawledAt: new Date().toISOString() }) + '\n');
  }

  readResults() {
    const map = new Map();
    if (!fs.existsSync(this.jsonlPath)) return map;
    for (const line of fs.readFileSync(this.jsonlPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      if (r.duplicate) continue;
      if (!map.has(r.sku)) map.set(r.sku, r); // first row wins
    }
    return map;
  }

  scanImages() {
    const bySku = new Map();
    if (!fs.existsSync(this.imagesDir)) return bySku;
    for (const file of fs.readdirSync(this.imagesDir)) {
      const m = IMAGE_RE.exec(file);
      if (!m) continue;
      const sku = m[1];
      const n = Number(m[2]);
      if (!bySku.has(sku)) bySku.set(sku, []);
      bySku.get(sku)[n - 1] = file;
    }
    return bySku;
  }

  async export() {
    const results = this.readResults();
    const images = this.scanImages();
    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet('Results');
    ws.columns = [
      { header: 'sku', key: 'sku', width: 28 },
      { header: '建议税号', key: 'hsCode', width: 14 },
      { header: '建议品名', key: 'productName', width: 30 },
      { header: 'goodsName', key: 'goodsName', width: 40 },
      { header: 'goodsDesc', key: 'goodsDesc', width: 50 },
      { header: 'sourceUrl', key: 'sourceUrl', width: 50 },
      { header: 'rawContent', key: 'rawContent', width: 40 },
      { header: 'success', key: 'success', width: 9 },
      { header: 'errorMessage', key: 'errorMessage', width: 30 },
      ...[1, 2, 3, 4, 5].map(i => ({ header: `image_${i}`, key: `image_${i}`, width: 26 })),
      { header: 'crawledAt', key: 'crawledAt', width: 22 },
    ];
    for (const sku of this.skus) {
      const r = results.get(sku) || {};
      const m = this.meta.get(sku) || {};
      const imgs = images.get(sku) || [];
      const row = {
        sku,
        hsCode: m.hsCode ?? '',
        productName: m.productName ?? '',
        goodsName: r.goodsName ?? '',
        goodsDesc: r.goodsDesc ?? '',
        sourceUrl: r.sourceUrl ?? '',
        rawContent: r.rawContent ?? '',
        success: r.success ?? '',
        errorMessage: r.errorMessage ?? '',
        crawledAt: r.crawledAt ?? '',
      };
      for (let i = 0; i < 5; i++) row[`image_${i + 1}`] = imgs[i] || '';
      ws.addRow(row);
    }
    await workbook.xlsx.writeFile(this.excelPath);
    return this.excelPath;
  }
}

module.exports = { ResultWriter };
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test test/temp-dispatcher/result-writer.test.js`
预期：PASS 3/3

- [ ] **步骤 5：Commit**

```bash
git add scripts/temp-dispatcher/result-writer.js test/temp-dispatcher/result-writer.test.js
git commit -m "feat(dispatcher): result-writer jsonl 真相源 + result.xlsx 导出"
```

---

### 任务 4：http-server — 协议端点 + 真实 Poller/Pusher 端到端

**文件：**
- 创建：`scripts/temp-dispatcher/http-server.js`
- 测试：`test/temp-dispatcher/http-server.test.js`

callback 处理顺序（关键）：先 append jsonl（失败 → 500，不改状态），再 complete 状态机；duplicate 由 complete 判定后把该条记录标记 `duplicate:true` 再追加。即：
1. `wasCompleted = taskStore.isCompleted(taskId)`
2. `resultWriter.append({...record, duplicate: wasCompleted || undefined})`（抛错 → 500）
3. `verdict = taskStore.complete(...)`
4. 全部 completed → 触发 onAllCompleted

- [ ] **步骤 1：编写失败的测试**

```js
// test/temp-dispatcher/http-server.test.js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TaskStore } = require('../../scripts/temp-dispatcher/task-store');
const { ResultWriter } = require('../../scripts/temp-dispatcher/result-writer');
const { createDispatcherServer } = require('../../scripts/temp-dispatcher/http-server');
const { Poller } = require('../../src/poller');
const { Pusher } = require('../../src/pusher');

function getJSON(url) {
  return fetch(url).then(r => r.json());
}

describe('http-server', () => {
  let server, base, store, writer, stateDir, imagesDir, completions;

  before(async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-state-'));
    imagesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-img-'));
    store = new TaskStore({ stateDir });
    store.init(['SKU-1', 'SKU-2']);
    writer = new ResultWriter({ stateDir, imagesDir, skus: ['SKU-1', 'SKU-2'], meta: new Map() });
    completions = 0;
    server = createDispatcherServer({ taskStore: store, resultWriter: writer, onAllCompleted: () => completions++ });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server.close());

  it('end-to-end: Poller fetches tasks, Pusher callback completes them', async () => {
    const poller = new Poller({
      taskUrl: `${base}/renren-api/classify/open/crawler/tasks`,
      nodeCode: 'node-1', limit: 10,
    });
    const tasks = await poller.fetchTasks();
    assert.strictEqual(tasks.length, 2);
    assert.strictEqual(tasks[0].sku, 'SKU-1');
    assert.strictEqual(typeof tasks[0].crawlerTaskId, 'string'); // BigInt 精度无损地以字符串传递

    const pusher = new Pusher({
      callbackUrl: `${base}/renren-api/classify/open/crawler/callback`,
      nodeCode: 'node-1', maxRetries: 0,
    });
    await pusher.push({
      crawlerTaskId: tasks[0].crawlerTaskId, sku: 'SKU-1', status: 'success',
      product_name: 'LATHE', features_details: 'd', product_specification: 's', product_url: 'http://x',
    });
    const stats = await getJSON(`${base}/stats`);
    assert.strictEqual(stats.completed, 1);
    assert.strictEqual(stats.issued, 1);

    // 第二个任务用 "Page shows no result" 完成 → 触发 onAllCompleted
    await pusher.push({
      crawlerTaskId: tasks[1].crawlerTaskId, sku: 'SKU-2', status: 'not_found',
      error: 'Page shows no result',
    });
    assert.strictEqual(completions, 1);
    const stats2 = await getJSON(`${base}/stats`);
    assert.strictEqual(stats2.completed, 2);
  });

  it('failed callback (non no-result) is re-issued on next poll', async () => {
    // 新起独立 server 避免干扰
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-retry-'));
    const s2 = new TaskStore({ stateDir: dir });
    s2.init(['SKU-R']);
    const w2 = new ResultWriter({ stateDir: dir, imagesDir, skus: ['SKU-R'], meta: new Map() });
    const srv = createDispatcherServer({ taskStore: s2, resultWriter: w2 });
    await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
    const b2 = `http://127.0.0.1:${srv.address().port}`;
    try {
      const poller = new Poller({ taskUrl: `${b2}/renren-api/classify/open/crawler/tasks`, nodeCode: 'n', limit: 1 });
      const [t] = await poller.fetchTasks();
      const pusher = new Pusher({ callbackUrl: `${b2}/renren-api/classify/open/crawler/callback`, nodeCode: 'n', maxRetries: 0 });
      await pusher.push({ crawlerTaskId: t.crawlerTaskId, sku: 'SKU-R', status: 'error', error: 'Timeout 30000ms exceeded' });
      assert.strictEqual(s2.stats().pending, 1); // 退回 pending
      const [tAgain] = await poller.fetchTasks();
      assert.strictEqual(tAgain.id, t.id); // 同一任务重发
    } finally {
      srv.close();
    }
  });

  it('returns 500 when result writer fails (pusher will retry)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-500-'));
    const s3 = new TaskStore({ stateDir: dir });
    s3.init(['SKU-E']);
    const w3 = new ResultWriter({ stateDir: dir, imagesDir, skus: ['SKU-E'], meta: new Map() });
    fs.mkdirSync(w3.jsonlPath); // append 必然 EISDIR
    const srv = createDispatcherServer({ taskStore: s3, resultWriter: w3 });
    await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
    const b3 = `http://127.0.0.1:${srv.address().port}`;
    try {
      const pusher = new Pusher({ callbackUrl: `${b3}/renren-api/classify/open/crawler/callback`, nodeCode: 'n', maxRetries: 0 });
      await assert.rejects(() => pusher.push({ crawlerTaskId: '1', sku: 'SKU-E', status: 'success' }), /Callback failed: 500/);
      assert.strictEqual(s3.stats().completed, 0); // 状态未被推进
    } finally {
      srv.close();
    }
  });

  it('/export writes result.xlsx and returns its path', async () => {
    const res = await fetch(`${base}/export`);
    const body = await res.json();
    assert.strictEqual(res.status, 200);
    assert.ok(body.path.endsWith('result.xlsx'));
    assert.ok(fs.existsSync(body.path));
  });
});
```

注意：第一个测试里 `pusher.push` 的 result 用 `status/error/product_name` 等字段，Pusher.buildBody 会把它们映射成 callback body（`success`、`errorMessage`、`goodsName` 等）——这是真实链路的形状，测试即验证。

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/temp-dispatcher/http-server.test.js`
预期：FAIL，`Cannot find module '../../scripts/temp-dispatcher/http-server'`

- [ ] **步骤 3：实现 http-server.js**

```js
// scripts/temp-dispatcher/http-server.js
const http = require('http');
const JSONbig = require('json-bigint')({ useNativeBigInt: true });

const TASKS_PATH = '/renren-api/classify/open/crawler/tasks';
const CALLBACK_PATH = '/renren-api/classify/open/crawler/callback';

function createDispatcherServer({ taskStore, resultWriter, onAllCompleted }) {
  function send(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSONbig.stringify(obj));
  }

  function handleCallback(req, res, parsed) {
    const record = {
      crawlerTaskId: parsed.crawlerTaskId != null ? String(parsed.crawlerTaskId) : null,
      sku: parsed.sku || '',
      success: parsed.success === true,
      errorMessage: parsed.errorMessage || '',
      goodsName: parsed.goodsName || '',
      goodsDesc: parsed.goodsDesc || '',
      sourceUrl: parsed.sourceUrl || '',
      rawContent: parsed.rawContent || '',
      nodeCode: parsed.nodeCode || '',
    };
    try {
      const duplicate = record.crawlerTaskId != null && taskStore.isCompleted(record.crawlerTaskId);
      // 先落 jsonl（真相源）：失败则 500，状态机不动，pusher 会重推
      resultWriter.append(duplicate ? { ...record, duplicate: true } : record);
      const verdict = taskStore.complete({
        taskId: record.crawlerTaskId,
        success: record.success,
        errorMessage: record.errorMessage,
      });
      const stats = taskStore.stats();
      if (onAllCompleted && stats.completed === stats.total) onAllCompleted();
      send(res, 200, { code: 0, outcome: verdict.outcome });
    } catch (e) {
      send(res, 500, { code: 500, error: e.message });
    }
  }

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/stats') {
      return send(res, 200, { code: 0, ...taskStore.stats() });
    }
    if (req.method === 'GET' && req.url === '/export') {
      resultWriter.export()
        .then(p => send(res, 200, { code: 0, path: p }))
        .catch(e => send(res, 500, { code: 500, error: e.message }));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(404);
      res.end('not found');
      return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let parsed;
      try {
        parsed = body ? JSONbig.parse(body) : {};
      } catch (e) {
        return send(res, 400, { code: 400, error: 'invalid JSON' });
      }
      if (req.url === TASKS_PATH) {
        const limit = Number(parsed.limit) || 10;
        return send(res, 200, { code: 0, data: taskStore.issue(limit) });
      }
      if (req.url === CALLBACK_PATH) {
        return handleCallback(req, res, parsed);
      }
      res.writeHead(404);
      res.end('not found');
    });
  });

  return server;
}

module.exports = { createDispatcherServer };
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test test/temp-dispatcher/http-server.test.js`
预期：PASS 4/4

- [ ] **步骤 5：全量回归**

运行：`npm test`
预期：既有测试 + 新测试全部 PASS

- [ ] **步骤 6：Commit**

```bash
git add scripts/temp-dispatcher/http-server.js test/temp-dispatcher/http-server.test.js
git commit -m "feat(dispatcher): http-server 协议端点 + poller/pusher 端到端测试"
```

---

### 任务 5：index.js — 入口装配

**文件：**
- 创建：`scripts/temp-dispatcher/index.js`

无单元测试（纯装配）；由任务 7 的本地集成验证覆盖。

- [ ] **步骤 1：实现 index.js**

```js
// scripts/temp-dispatcher/index.js
const { loadSkuSource } = require('./excel-source');
const { TaskStore } = require('./task-store');
const { ResultWriter } = require('./result-writer');
const { createDispatcherServer } = require('./http-server');

async function main() {
  const port = Number(process.env.DISPATCHER_PORT) || 18080;
  const excelPath = process.env.DISPATCHER_EXCEL || '/data/SKU_database_01.xlsx';
  const sheetName = process.env.DISPATCHER_SHEET || 'Sheet1';
  const stateDir = process.env.DISPATCHER_STATE_DIR || '/data/state';
  const imagesDir = process.env.DISPATCHER_IMAGES_DIR || '/data/images';
  const leaseMs = Number(process.env.DISPATCHER_TASK_LEASE_MS) || 600000;

  const { skus, meta, duplicates } = await loadSkuSource(excelPath, sheetName);
  if (duplicates.length > 0) {
    console.log(`[DISPATCHER] ${duplicates.length} duplicate sku(s) skipped: ` +
      duplicates.map(d => `${d.sku}@row${d.rowNumber}`).join(', '));
  }
  console.log(`[DISPATCHER] Loaded ${skus.length} sku(s) from ${excelPath} sheet=${sheetName}`);

  const taskStore = new TaskStore({ stateDir, leaseMs });
  taskStore.init(skus);
  console.log('[DISPATCHER] Task store ready:', JSON.stringify(taskStore.stats()));

  const resultWriter = new ResultWriter({ stateDir, imagesDir, skus, meta });

  let exported = false;
  const autoExport = () => {
    if (exported) return;
    exported = true;
    resultWriter.export()
      .then(p => console.log(`[DISPATCHER] All tasks completed, exported: ${p}`))
      .catch(e => console.error('[DISPATCHER] Auto export failed:', e.message));
  };

  const server = createDispatcherServer({ taskStore, resultWriter, onAllCompleted: autoExport });
  server.listen(port, '0.0.0.0', () => console.log(`[DISPATCHER] Listening on ${port}`));

  const leaseTimer = setInterval(() => {
    const n = taskStore.reclaimExpiredLeases();
    if (n > 0) console.log(`[DISPATCHER] Reclaimed ${n} expired lease(s)`);
  }, 30000);
  leaseTimer.unref();

  const shutdown = (sig) => {
    console.log(`[DISPATCHER] ${sig} received, shutting down`);
    clearInterval(leaseTimer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(e => {
  console.error('[DISPATCHER] Fatal:', e);
  process.exit(1);
});
```

- [ ] **步骤 2：冒烟运行（本地，不起服务器爬取）**

```bash
mkdir -p /tmp/disp-smoke/state /tmp/disp-smoke/images
cp /Users/nz/Downloads/SKU_database_01.xlsx /tmp/disp-smoke/
DISPATCHER_PORT=18099 \
DISPATCHER_EXCEL=/tmp/disp-smoke/SKU_database_01.xlsx \
DISPATCHER_STATE_DIR=/tmp/disp-smoke/state \
DISPATCHER_IMAGES_DIR=/tmp/disp-smoke/images \
node scripts/temp-dispatcher/index.js &
sleep 2
curl -s 127.0.0.1:18099/stats
curl -s -X POST 127.0.0.1:18099/renren-api/classify/open/crawler/tasks -H 'Content-Type: application/json' -d '{"limit":2}'
kill %1
```
预期：stats 返回 `total: 5570, pending: 5570`；tasks 返回 2 个任务（id 为 3070... 段字符串、含 sku、status CRAWLING）。

- [ ] **步骤 3：Commit**

```bash
git add scripts/temp-dispatcher/index.js
git commit -m "feat(dispatcher): index 入口装配 + lease 定时器 + 完成自动导出"
```

---

### 任务 6：部署产物 — compose 文件与 runbook

**文件：**
- 创建：`scripts/temp-dispatcher/deploy/dispatcher.compose.yml`
- 创建：`scripts/temp-dispatcher/deploy/crawler.compose.yml`
- 创建：`scripts/temp-dispatcher/deploy/runbook.md`

说明：crawler compose 用 `--scale` 起多实例，因此**不设置 container_name**（compose 自动生成 `hs-sku-temp-crawler-1..N`），取代规格中逐容器命名的写法。

- [ ] **步骤 1：dispatcher.compose.yml**

```yaml
# /opt/hs-sku-temp/dispatcher.compose.yml
services:
  dispatcher:
    image: ${CRAWLER_IMAGE:?未设置 CRAWLER_IMAGE}
    container_name: hs-sku-dispatcher
    restart: unless-stopped
    command: ["node", "/app/temp-dispatcher/index.js"]
    ports:
      - "127.0.0.1:18080:18080"
    volumes:
      - ./dispatcher:/app/temp-dispatcher:ro
      - ./SKU_database_01.xlsx:/data/SKU_database_01.xlsx:ro
      - ./state:/data/state
      - ./images:/data/images:ro
    environment:
      - DISPATCHER_PORT=18080
      - DISPATCHER_EXCEL=/data/SKU_database_01.xlsx
      - DISPATCHER_SHEET=Sheet1
      - DISPATCHER_STATE_DIR=/data/state
      - DISPATCHER_IMAGES_DIR=/data/images
      - DISPATCHER_TASK_LEASE_MS=600000
    logging:
      driver: "json-file"
      options:
        max-size: "20m"
        max-file: "3"
```

- [ ] **步骤 2：crawler.compose.yml**

```yaml
# /opt/hs-sku-temp/crawler.compose.yml
# 起 8~10 个：docker compose -p hs-sku-temp -f crawler.compose.yml up -d --scale crawler=8
services:
  crawler:
    image: ${CRAWLER_IMAGE:?未设置 CRAWLER_IMAGE}
    restart: "no"
    env_file: .env                       # 复制正式 .env 后改下面 4 项
    environment:
      - CRAWLER_MODE=service
      - CRAWLER_TASK_URL=http://172.17.0.1:18080/renren-api/classify/open/crawler/tasks
      - CRAWLER_CALLBACK_URL=http://172.17.0.1:18080/renren-api/classify/open/crawler/callback
      - CRAWLER_HEADED_FALLBACK=false
    volumes:
      - ./images:/app/output/images      # 共享图片目录（所有实例同一挂载）
      - ./logs:/app/logs
    logging:
      driver: "json-file"
      options:
        max-size: "50m"
        max-file: "5"
```

说明：不写 `CRAWLER_NODE_CODE`——bin/run.js 默认用 `os.hostname()`（容器内即容器 ID，多实例天然唯一）。

`.env` 准备：`cp` 正式容器 .env，**删除** `CRAWLER_TASK_URL` / `CRAWLER_CALLBACK_URL` / `CRAWLER_NODE_CODE`（前两个由 environment 覆盖，第三个用默认 hostname），cliproxy 配置（`CLIPROXY_*`）原样保留。

- [ ] **步骤 3：runbook.md**

```markdown
# 临时调度任务运行手册（bwg）

## 准备
1. 上传文件：
   scp SKU_database_01.xlsx bwg:/opt/hs-sku-temp/
   scp -r scripts/temp-dispatcher/* bwg:/opt/hs-sku-temp/dispatcher/
   scp scripts/temp-dispatcher/deploy/*.compose.yml bwg:/opt/hs-sku-temp/
2. 准备临时 .env：复制正式 .env，删除 CRAWLER_TASK_URL/CALLBACK_URL/NODE_CODE 三行
3. mkdir -p /opt/hs-sku-temp/{state,images,logs}

## 运行
1. 停正式容器：docker stop $(docker ps -q --filter name=hs-sku-crawler)
2. 起调度：CRAWLER_IMAGE=<正式镜像tag> docker compose -f dispatcher.compose.yml up -d
   验证：curl 127.0.0.1:18080/stats → total=5570
3. 起爬虫：CRAWLER_IMAGE=<正式镜像tag> docker compose -p hs-sku-temp -f crawler.compose.yml up -d --scale crawler=8
4. 监控：watch 'curl -s 127.0.0.1:18080/stats'；日志 docker logs hs-sku-dispatcher
5. 完成判定：completed == total，日志出现 "exported: /data/state/result.xlsx"
   中途想看进度：curl 127.0.0.1:18080/export（部分结果也导出，缺失 sku 结果列留空）

## 收尾
1. tar czf images.tar.gz -C /opt/hs-sku-temp images
2. scp bwg:/opt/hs-sku-temp/state/result.xlsx bwg:/opt/hs-sku-temp/images.tar.gz ./
3. docker compose -p hs-sku-temp -f crawler.compose.yml down
   docker compose -f dispatcher.compose.yml down
   rm -rf /opt/hs-sku-temp
4. 恢复正式：docker start $(docker ps -aq --filter name=hs-sku-crawler)
   验证正式容器 /health 正常、上游开始派活
```

- [ ] **步骤 4：Commit**

```bash
git add scripts/temp-dispatcher/deploy/
git commit -m "feat(dispatcher): 部署 compose 与 bwg 运行手册"
```

---

### 任务 7：本地集成验证（手动检查点，verification-before-completion）

不写代码，按序执行并记录输出。任一失败 → 回到对应任务修复。

- [ ] **步骤 1：制作 10 行小 Excel**

```bash
python3 - <<'EOF'
import openpyxl
wb = openpyxl.load_workbook('/Users/nz/Downloads/SKU_database_01.xlsx')
ws = wb['Sheet1']
out = openpyxl.Workbook(); o = out.active; o.title = 'Sheet1'
for i, row in enumerate(ws.iter_rows(max_row=11, values_only=True)):
    o.append(list(row))
out.save('/tmp/disp-mini.xlsx')
EOF
```

- [ ] **步骤 2：本地 docker 起 dispatcher + 1 个 crawler 跑通全链路**

用任务 6 的 compose，`--scale crawler=1`，`DISPATCHER_EXCEL` 指向 mini 文件，crawler 用 `CRAWLER_PROXY` 或本机 cliproxy 配置（任选可用的）。
验证：mini 10 个 sku 全部 completed；`state/result.xlsx` 生成且列齐全；`images/` 有 `sku_1.jpg` 类文件。

- [ ] **步骤 3：验证 dispatcher 重启恢复**

跑到一半 `docker restart hs-sku-dispatcher` → 日志显示从 state.json 恢复，stats 不丢已完成数；issued 未回调的任务在 lease 后重发。

- [ ] **步骤 4：验证正式链路零影响**

`git status` 确认 `src/`、`bin/`、`deployment/` 无改动；`npm test` 全绿；正式容器 env/镜像/卷未触碰（仅 stop/start）。

- [ ] **步骤 5：Commit（如有 runbook 修正）**

```bash
git add -A && git commit -m "docs(dispatcher): 本地集成验证记录与 runbook 修正"
```

---

## 自检结论

- 规格覆盖：Excel 读取(任务1)、状态机+lease+持久化(任务2)、重试规则(任务2/4)、jsonl+导出+图片列(任务3)、协议端点+BigInt(任务4)、自动导出+优雅退出(任务5)、compose/runbook(任务6)、集成验证(任务7) — 全部覆盖
- 与规格的唯一偏差：crawler 多实例用 `--scale`（compose 自动命名）替代逐容器 `container_name`，已在任务 6 注明
- 类型一致性：`loadSkuSource` 返回 `{skus, meta, duplicates}`；`TaskStore` 方法 `init/issue/complete/isCompleted/reclaimExpiredLeases/stats/persist`；`ResultWriter` 方法 `append/readResults/scanImages/export`；`createDispatcherServer({taskStore, resultWriter, onAllCompleted})` — 跨任务一致
