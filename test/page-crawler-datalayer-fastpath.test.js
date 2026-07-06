const { describe, it } = require('node:test');
const assert = require('node:assert');
const { PageCrawler } = require('../src/page-crawler');

// 模拟带 dataLayer 的 Playwright page。
// fast-path 用 page.evaluate 同步检查；
// slow-path 用 page.waitForFunction 等目标 sku 出现在 goods_list_params。
function createDataLayerPage(options) {
  const calls = [];
  const dataLayerProvider = options.dataLayerAt || (() => null);
  const page = {
    url: () => 'https://eur.vevor.com/s/SKU',
    async waitForFunction(fn, arg, opts = {}) {
      calls.push({ type: 'waitForFunction', arg, opts });
      const dataLayer = dataLayerProvider('waitForFunction');
      const verdict = runInVm(fn, arg, dataLayer);
      if (verdict !== false) {
        return { jsonValue: async () => verdict };
      }
      const err = new Error(`page.waitForFunction: Timeout ${opts.timeout || 20000}ms exceeded.`);
      throw err;
    },
    async evaluate(fn, arg) {
      calls.push({ type: 'evaluate', arg });
      const dataLayer = dataLayerProvider('evaluate');
      return runInVm(fn, arg, dataLayer);
    },
    async title() { return 'Search SKU | VEVOR EU'; },
    async content() { return '<html></html>'; },
    async screenshot({ path }) { return path; },
  };
  page.calls = calls;
  return page;
}

function runInVm(fn, arg, dataLayer) {
  const prevWindow = global.window;
  global.window = { dataLayer };
  try {
    return fn(arg);
  } finally {
    if (prevWindow === undefined) delete global.window;
    else global.window = prevWindow;
  }
}

describe('PageCrawler.extractProductUrlFromDataLayer fast-path', () => {
  it('returns empty tuple via evaluate fast-path when result_number is 0', async () => {
    // 无结果：fast-path 一次 evaluate 直接判定 → ['', '']，不进 waitForFunction
    const page = createDataLayerPage({
      dataLayerAt: () => [{ search: { result_number: 0, goods_list_params: null } }],
    });
    const crawler = new PageCrawler({});

    const result = await crawler.extractProductUrlFromDataLayer(page, 'NO-RESULT-SKU', 20000);

    assert.strictEqual(result[0], '');
    assert.strictEqual(result[1], '');
    // fast-path 应当只调用了一次 evaluate，没进 waitForFunction
    assert.strictEqual(page.calls.filter(c => c.type === 'evaluate').length, 1);
    assert.strictEqual(page.calls.filter(c => c.type === 'waitForFunction').length, 0);
  });

  it('returns url and title via evaluate fast-path when sku is in goods_list_params', async () => {
    // 有结果且 sku 在列表中 → fast-path 返回 [url, title]
    const page = createDataLayerPage({
      dataLayerAt: () => [{
        search: {
          result_number: 1,
          goods_list_params: {
            'GOOD-SKU': { goodsUrl: 'https://eur.vevor.com/p/X', title: 'X Title' }
          }
        }
      }],
    });
    const crawler = new PageCrawler({});

    const result = await crawler.extractProductUrlFromDataLayer(page, 'GOOD-SKU', 20000);

    assert.strictEqual(result[0], 'https://eur.vevor.com/p/X');
    assert.strictEqual(result[1], 'X Title');
    assert.strictEqual(page.calls.filter(c => c.type === 'waitForFunction').length, 0);
  });

  it('throws DATA_LAYER_NEVER_PUSHED when dataLayer never appears', async () => {
    // fast-path 看到 page.dataLayer 为空 → 直接抛错
    const page = createDataLayerPage({
      dataLayerAt: () => null,
    });
    const crawler = new PageCrawler({});

    await assert.rejects(
      crawler.extractProductUrlFromDataLayer(page, 'STUB-SKU', 20000),
      /DATA_LAYER_NEVER_PUSHED/
    );
  });

  it('throws DATA_LAYER_MISSING after slow wait when result_number > 0 but sku not in params', async () => {
    // fast-path 看到 result_number > 0 但 sku 不在 params → 进 slow-path
    // slow-path 等不到 → 抛 DATA_LAYER_MISSING
    const page = createDataLayerPage({
      dataLayerAt: () => [{ search: { result_number: 5, goods_list_params: null } }],
    });
    const crawler = new PageCrawler({});

    await assert.rejects(
      crawler.extractProductUrlFromDataLayer(page, 'GHOST-SKU', 20000),
      /DATA_LAYER_MISSING/
    );

    // fast-path 调过一次 evaluate，slow-path 调过一次 waitForFunction
    const evaluates = page.calls.filter(c => c.type === 'evaluate').length;
    const waitFns = page.calls.filter(c => c.type === 'waitForFunction').length;
    assert.strictEqual(evaluates, 1);
    assert.strictEqual(waitFns, 1);
  });

  it('saves diagnostics when DATA_LAYER_NEVER_PUSHED', async () => {
    // fast-path 抛错前应当保存诊断，标签为 dataLayer-never-pushed
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-never-'));
    try {
      const page = createDataLayerPage({
        dataLayerAt: () => null,
      });
      // 记录 screenshot 调用以确认诊断执行了
      const screenshots = [];
      page.screenshot = async ({ path }) => { screenshots.push(path); return path; };
      const htmlSnippets = [];
      page.content = async () => { htmlSnippets.push('html'); return '<html></html>'; };
      const crawler = new PageCrawler({ diagnosticDir: tmpDir });

      await assert.rejects(
        crawler.extractProductUrlFromDataLayer(page, 'STUB-SKU', 20000),
        /DATA_LAYER_NEVER_PUSHED/
      );

      // 诊断文件应该被创建（captureDiagnostics 写入 outputDir/YYYY-MM-DD/）
      const allFiles = [];
      (function walk(d) {
        for (const f of fs.readdirSync(d)) {
          const p = path.join(d, f);
          const st = fs.statSync(p);
          if (st.isDirectory()) walk(p);
          else allFiles.push(p);
        }
      })(tmpDir);
      assert.ok(allFiles.some(f => f.includes('dataLayer-never-pushed-STUB-SKU')),
        `should write diagnostic file, got: ${allFiles.join(',')}`);
      assert.ok(screenshots.length > 0, 'screenshot should be taken');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('labels DATA_LAYER_MISSING diagnostic with "dataLayer-missing" (not "dataLayer-timeout")', async () => {
    // slow-path 抛错前的诊断标签要区分，不能再用旧的 dataLayer-timeout
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-missing-'));
    try {
      const page = createDataLayerPage({
        dataLayerAt: () => [{ search: { result_number: 5, goods_list_params: null } }],
      });
      const crawler = new PageCrawler({ diagnosticDir: tmpDir });

      await assert.rejects(
        crawler.extractProductUrlFromDataLayer(page, 'GHOST-SKU', 20000),
        /DATA_LAYER_MISSING/
      );

      const allFiles = [];
      (function walk(d) {
        for (const f of fs.readdirSync(d)) {
          const p = path.join(d, f);
          const st = fs.statSync(p);
          if (st.isDirectory()) walk(p);
          else allFiles.push(p);
        }
      })(tmpDir);
      assert.ok(allFiles.some(f => f.includes('dataLayer-missing-GHOST-SKU')),
        `should write diagnostic file with new label, got: ${allFiles.join(',')}`);
      // 不应该再用旧标签
      assert.ok(!allFiles.some(f => f.includes('dataLayer-timeout-GHOST-SKU')),
        `should NOT use legacy dataLayer-timeout label, got: ${allFiles.join(',')}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});