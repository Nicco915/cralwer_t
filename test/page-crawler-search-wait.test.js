const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PageCrawler, captureDiagnostics } = require('../src/page-crawler');
const verdict = require('../src/result-verdict');

// docs/plan-datalayer判定修复.md
// PR-1：拦截页识别（isAwsWafChallenge）+ 诊断 HTML 截断 8K→200K。
// PR-2：waitForSearchPageReady 就绪等待 + crawlSingleSku 接线（逃生门 / no_results 早退 /
// blocked:* 挑战处理）。

const AWS_WAF_FIXTURE = path.join(__dirname, 'fixtures', 'aws-waf-challenge.html');

describe('PageCrawler.isAwsWafChallenge', () => {
  it('identifies the real AWS WAF challenge page from crawler-09 snapshot', async () => {
    // fixture 是 2026-10-09 crawler-09 真实快照 HTML（gokuProps + awswaf challenge.js +
    // #challenge-container + 空 title），原样复制，未做删减。
    const html = fs.readFileSync(AWS_WAF_FIXTURE, 'utf8');
    const page = {
      async content() { return html; },
      async title() { return ''; },
      url: () => 'https://eur.vevor.com/s/WZZDMHS28INC3LLQY001V0',
    };
    const crawler = new PageCrawler({});
    assert.strictEqual(await crawler.isAwsWafChallenge(page), true);
  });

  it('does not flag a normal rendered search page', async () => {
    const page = {
      async content() {
        return '<html><head><title>Search for "ABC" | VEVOR EU</title></head>' +
          '<body><div id="app"><a href="/p/ABC">product</a></div></body></html>';
      },
      async title() { return 'Search for "ABC" | VEVOR EU'; },
      url: () => 'https://eur.vevor.com/s/ABC',
    };
    const crawler = new PageCrawler({});
    assert.strictEqual(await crawler.isAwsWafChallenge(page), false);
  });

  it('does not flag a Cloudflare challenge page (separate vendor path)', async () => {
    const page = {
      async content() { return '<html><body>cf-browser-verification challenge-platform</body></html>'; },
      async title() { return 'Just a moment...'; },
      url: () => 'https://eur.vevor.com/s/ABC',
    };
    const crawler = new PageCrawler({});
    assert.strictEqual(await crawler.isAwsWafChallenge(page), false);
  });

  it('returns false when content() throws', async () => {
    const page = {
      async content() { throw new Error('page closed'); },
      async title() { return ''; },
      url: () => 'https://eur.vevor.com/s/ABC',
    };
    const crawler = new PageCrawler({});
    crawler.log = () => {};
    assert.strictEqual(await crawler.isAwsWafChallenge(page), false);
  });
});

describe('captureDiagnostics HTML truncation', () => {
  it('keeps up to 200KB of HTML so the rendered body survives the cut', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-trunc-'));
    try {
      // VEVOR 搜索页 head 即超 8KB；构造 8KB head + body 标记的页面，
      // 旧截断下 body 永远不可见，新截断（200KB）必须保留 body。
      const headPad = '<!-- ' + 'x'.repeat(10000) + ' -->';
      const html = `<html><head>${headPad}</head><body><div id="search-results">BODY_MARKER</div></body></html>`;
      const page = {
        title: async () => 'Search',
        url: () => 'https://eur.vevor.com/s/TEST',
        screenshot: async ({ path: p }) => { fs.writeFileSync(p, 'fake-png'); },
        content: async () => html,
        evaluate: async () => ({ stubbed: true }),
      };

      const meta = await captureDiagnostics(page, 'TEST', 'dataLayer-never-pushed', tmpDir);

      const saved = fs.readFileSync(meta.htmlSnippet, 'utf8');
      assert.ok(saved.includes('BODY_MARKER'), 'body marker must survive the truncation');
      assert.ok(saved.length > 8000, `saved HTML should exceed the old 8000-char cut, got ${saved.length}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('caps oversized HTML at 200000 characters', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-cap-'));
    try {
      const html = '<html><body>' + 'y'.repeat(300000) + '</body></html>';
      const page = {
        title: async () => 'Big',
        url: () => 'https://eur.vevor.com/s/BIG',
        screenshot: async ({ path: p }) => { fs.writeFileSync(p, 'fake-png'); },
        content: async () => html,
        evaluate: async () => ({ stubbed: true }),
      };

      const meta = await captureDiagnostics(page, 'BIG', 'dataLayer-never-pushed', tmpDir);

      const saved = fs.readFileSync(meta.htmlSnippet, 'utf8');
      assert.strictEqual(saved.length, 200000);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── PR-2 测试基建 ──────────────────────────────────────────────────────────

// waitForSearchPageReady 的页面侧判定函数引用 window/document，在 Node 里临时挂
// global 执行（与 page-crawler-datalayer-fastpath.test.js 的 runInVm 同款思路）。
function emptyDocument() {
  return { title: '', querySelector: () => null, body: { innerText: '' } };
}

function runPageSide(fn, snapshot = {}) {
  const prevWindow = global.window;
  const prevDocument = global.document;
  global.window = snapshot.window || {};
  global.document = snapshot.document || emptyDocument();
  try {
    return fn();
  } finally {
    if (prevWindow === undefined) delete global.window;
    else global.window = prevWindow;
    if (prevDocument === undefined) delete global.document;
    else global.document = prevDocument;
  }
}

// crawlSingleSku 集成测试用的完整 page mock。
// callSnapshots：按 waitForFunction 调用次序出队的快照数组；每次调用按数组顺序
// 模拟 500ms 轮询，命中即返回 handle，全落空按真实行为抛 Timeout。
function createCrawlPage(opts = {}) {
  const stats = { polls: 0, waitForFunctionCalls: 0, evaluateCalls: 0 };
  const callSnapshots = (opts.callSnapshots || []).slice();
  const page = {
    _url: opts.url || 'https://eur.vevor.com/s/TEST-SKU',
    async goto(url) { page._url = url; },
    url: () => page._url,
    async title() { return opts.title || 'Search | VEVOR EU'; },
    async content() { return opts.html || '<html><body>normal page</body></html>'; },
    async waitForFunction(fn, arg, o = {}) {
      stats.waitForFunctionCalls++;
      const snaps = callSnapshots.length ? callSnapshots.shift() : [{}];
      for (const snap of snaps) {
        stats.polls++;
        const v = runPageSide(fn, snap);
        if (v !== false) return { jsonValue: async () => v };
      }
      throw new Error(`page.waitForFunction: Timeout ${o.timeout || 20000}ms exceeded.`);
    },
    // evaluate 同时服务 fast-path dataLayer 判定与商品页 features/specs 提取：
    // 前者引用 window（提供 dataLayer），后者引用 document（空壳返回 ''）。
    async evaluate(fn, arg) {
      stats.evaluateCalls++;
      try {
        return runPageSide(() => fn(arg), {
          window: { dataLayer: opts.dataLayer || [] },
          document: emptyDocument(),
        });
      } catch {
        return '';
      }
    },
    $: async () => null,
    mouse: { move: async () => {} },
    async screenshot() {},
  };
  return { page, stats };
}

function stubDownstream(crawler) {
  crawler.sleep = async () => {};
  crawler.extractPageSku = async () => '';
  crawler.extractAllProductImages = async () => [];
}

describe('PageCrawler searchResultWaitMs config', () => {
  it('defaults to 15000 and allows 0 / negative as escape hatch (no clamping)', () => {
    assert.strictEqual(new PageCrawler({}).searchResultWaitMs, 15000);
    assert.strictEqual(new PageCrawler({ searchResultWaitMs: 0 }).searchResultWaitMs, 0);
    assert.strictEqual(new PageCrawler({ searchResultWaitMs: -1 }).searchResultWaitMs, -1);
    assert.strictEqual(new PageCrawler({ searchResultWaitMs: 50 }).searchResultWaitMs, 50);
  });
});

describe('PageCrawler.waitForSearchPageReady', () => {
  const crawler = () => new PageCrawler({ searchResultWaitMs: 50 });

  it('hits datalayer when the search event only appears on a later poll', async () => {
    const { page, stats } = createCrawlPage({
      callSnapshots: [[
        {},
        {},
        { window: { dataLayer: [{ search: { result_number: 1, goods_list_params: {} } }] } },
      ]],
    });
    const state = await crawler().waitForSearchPageReady(page, 'SKU');
    assert.strictEqual(state, 'datalayer');
    assert.strictEqual(stats.polls, 3);
  });

  it('hits dom_results when a /p/ link renders without any dataLayer search event', async () => {
    const { page } = createCrawlPage({
      callSnapshots: [[
        { document: { ...emptyDocument(), querySelector: (sel) => sel === 'a[href*="/p/"]' ? {} : null } },
      ]],
    });
    const state = await crawler().waitForSearchPageReady(page, 'SKU');
    assert.strictEqual(state, 'dom_results');
  });

  it('hits no_results on the real "No Results For" wording', async () => {
    const { page } = createCrawlPage({
      callSnapshots: [[
        { document: { ...emptyDocument(), body: { innerText: 'No Results For "WXQJTZSMXWJH4VGZT001V9". Please check your spelling or use different keywords.' } } },
      ]],
    });
    const state = await crawler().waitForSearchPageReady(page, 'SKU');
    assert.strictEqual(state, 'no_results');
  });

  it('identifies AWS WAF markers on the first poll (fast fail, no waiting out the window)', async () => {
    const { page, stats } = createCrawlPage({
      callSnapshots: [[
        {
          window: { gokuProps: { key: 'k' } },
          document: { ...emptyDocument(), querySelector: (sel) => sel === '#challenge-container' ? {} : null },
        },
        // 后面还有快照也不应被消费（立即返回）
        { window: { dataLayer: [{ search: {} }] } },
      ]],
    });
    const state = await crawler().waitForSearchPageReady(page, 'SKU');
    assert.strictEqual(state, 'blocked:aws_waf');
    assert.strictEqual(stats.polls, 1);
  });

  it('identifies Cloudflare markers as blocked:cf', async () => {
    const { page } = createCrawlPage({
      callSnapshots: [[
        { document: { ...emptyDocument(), title: 'Just a moment...' } },
      ]],
    });
    const state = await crawler().waitForSearchPageReady(page, 'SKU');
    assert.strictEqual(state, 'blocked:cf');
  });

  it('identifies PerimeterX markers as blocked:perimeterx', async () => {
    const { page } = createCrawlPage({
      callSnapshots: [[
        { window: { _pxAppId: 'PX123' } },
      ]],
    });
    const state = await crawler().waitForSearchPageReady(page, 'SKU');
    assert.strictEqual(state, 'blocked:perimeterx');
  });

  it('returns timeout when nothing becomes ready within the window', async () => {
    const { page } = createCrawlPage({
      callSnapshots: [[{}, {}, {}]],
    });
    const state = await crawler().waitForSearchPageReady(page, 'SKU');
    assert.strictEqual(state, 'timeout');
  });
});

describe('crawlSingleSku 搜索页就绪等待接线', () => {
  it('delayed dataLayer push still extracts the product url (core regression)', async () => {
    const crawler = new PageCrawler({ searchResultWaitMs: 50, imageDir: '/tmp/img' });
    stubDownstream(crawler);
    const dataLayer = [{
      search: {
        result_number: 1,
        goods_list_params: { 'GOOD-SKU': { goodsUrl: 'https://eur.vevor.com/p/X', title: 'X Title' } },
      },
    }];
    const { page, stats } = createCrawlPage({
      dataLayer,
      callSnapshots: [[{}, {}, { window: { dataLayer } }]],
    });

    const result = await crawler.crawlSingleSku('GOOD-SKU', page);

    assert.strictEqual(result.status, 'success');
    assert.strictEqual(result.product_url, 'https://eur.vevor.com/p/X');
    assert.ok(stats.polls >= 3, `should have waited for the delayed push, polls=${stats.polls}`);
  });

  it('no_results early-exits with PAGE_NO_RESULT + dataLayerNotFound, without running extract', async () => {
    const crawler = new PageCrawler({ searchResultWaitMs: 50, imageDir: '/tmp/img' });
    stubDownstream(crawler);
    let extractCalls = 0;
    crawler.extractProductUrlWithRetry = async () => { extractCalls++; throw new Error('should not be called'); };
    const { page } = createCrawlPage({
      callSnapshots: [[
        { document: { ...emptyDocument(), body: { innerText: 'No Results For "FOO". Please check your spelling or use different keywords.' } } },
      ]],
    });

    const result = await crawler.crawlSingleSku('FOO', page);

    assert.strictEqual(result.status, 'not_found');
    assert.strictEqual(result.errorCode, 'PAGE_NO_RESULT');
    assert.strictEqual(result.error, 'Page shows no result');
    assert.strictEqual(result.dataLayerNotFound, true);
    assert.notStrictEqual(result.dataLayerFailed, true);
    assert.strictEqual(extractCalls, 0, 'extract must be skipped on no_results');
    // business_empty 语义：不换 IP
    assert.strictEqual(verdict.shouldRetryWithNewIp(result), false);
  });

  it('AWS WAF page is identified immediately and unresolved wait yields WAF_CHALLENGE_UNRESOLVED', async () => {
    const crawler = new PageCrawler({ searchResultWaitMs: 50, cloudflareMaxWait: 2, imageDir: '/tmp/img' });
    stubDownstream(crawler);
    crawler.isAwsWafChallenge = async () => true; // 挑战始终未过
    let extractCalls = 0;
    crawler.extractProductUrlWithRetry = async () => { extractCalls++; return { productUrl: '', productName: '', dataLayerFailed: true }; };
    const { page, stats } = createCrawlPage({
      callSnapshots: [[
        { window: { gokuProps: { key: 'k' } }, document: { ...emptyDocument(), querySelector: (sel) => sel === '#challenge-container' ? {} : null } },
      ]],
    });

    const result = await crawler.crawlSingleSku('BLOCKED-SKU', page);

    assert.strictEqual(stats.polls, 1, 'WAF page must be identified on the first poll, not after the full window');
    assert.strictEqual(result.status, 'not_found');
    assert.strictEqual(result.errorCode, 'WAF_CHALLENGE_UNRESOLVED');
    assert.strictEqual(result.error, 'WAF_CHALLENGE_UNRESOLVED: aws_waf');
    assert.strictEqual(result.dataLayerFailed, true);
    assert.strictEqual(result.cfChallengeFailed, true);
    assert.strictEqual(extractCalls, 0);
    // 挑战未过语义：换 IP 重试（与 CF_CHALLENGE_UNRESOLVED 同款）
    assert.strictEqual(verdict.shouldRetryWithNewIp(result), true);
  });

  it('AWS WAF auto-reload release continues to a normal extract', async () => {
    const crawler = new PageCrawler({ searchResultWaitMs: 50, cloudflareMaxWait: 3, imageDir: '/tmp/img' });
    stubDownstream(crawler);
    // 挑战等待期间第二次检查即放行
    let wafChecks = 0;
    crawler.isAwsWafChallenge = async () => (++wafChecks >= 2 ? false : true);
    const dataLayer = [{
      search: {
        result_number: 1,
        goods_list_params: { 'WAF-SKU': { goodsUrl: 'https://eur.vevor.com/p/WAF', title: 'Waf Title' } },
      },
    }];
    const { page, stats } = createCrawlPage({
      dataLayer,
      callSnapshots: [
        [{ window: { gokuProps: { key: 'k' } } }],   // 第一次判定：blocked:aws_waf
        [{ window: { dataLayer } }],                  // 放行后重新判定：datalayer
      ],
    });

    const result = await crawler.crawlSingleSku('WAF-SKU', page);

    assert.strictEqual(stats.waitForFunctionCalls, 2, 'should re-check readiness exactly once after release');
    assert.strictEqual(result.status, 'success');
    assert.strictEqual(result.product_url, 'https://eur.vevor.com/p/WAF');
  });

  it('PerimeterX fails immediately without waiting (no challenge wait entered)', async () => {
    const crawler = new PageCrawler({ searchResultWaitMs: 50, imageDir: '/tmp/img' });
    stubDownstream(crawler);
    let cfWaitCalls = 0;
    let wafWaitCalls = 0;
    crawler.waitForCloudflare = async () => { cfWaitCalls++; return false; };
    crawler.waitForAwsWafChallenge = async () => { wafWaitCalls++; return false; };
    const { page, stats } = createCrawlPage({
      callSnapshots: [[{ window: { _pxAppId: 'PX123' } }]],
    });

    const result = await crawler.crawlSingleSku('PX-SKU', page);

    assert.strictEqual(stats.polls, 1);
    assert.strictEqual(cfWaitCalls, 0);
    assert.strictEqual(wafWaitCalls, 0);
    assert.strictEqual(result.status, 'not_found');
    assert.strictEqual(result.errorCode, 'WAF_CHALLENGE_UNRESOLVED');
    assert.strictEqual(result.error, 'WAF_CHALLENGE_UNRESOLVED: perimeterx');
    assert.strictEqual(result.dataLayerFailed, true);
    assert.strictEqual(result.cfChallengeFailed, true);
  });

  it('window timeout falls through to extract which throws DATA_LAYER_NEVER_PUSHED', async () => {
    const crawler = new PageCrawler({ searchResultWaitMs: 50, imageDir: '/tmp/img' });
    stubDownstream(crawler);
    const { page } = createCrawlPage({
      dataLayer: [],
      callSnapshots: [[{}, {}]], // 等满窗口无一命中
    });

    const result = await crawler.crawlSingleSku('GHOST-SKU', page);

    assert.strictEqual(result.status, 'not_found');
    assert.strictEqual(result.error, 'DATA_LAYER_NEVER_PUSHED');
    assert.strictEqual(result.errorCode, 'DATA_LAYER_NEVER_PUSHED');
    assert.strictEqual(result.dataLayerFailed, true);
  });

  it('searchResultWaitMs=0 takes the legacy fixed-sleep path (escape hatch)', async () => {
    const crawler = new PageCrawler({ searchResultWaitMs: 0, imageDir: '/tmp/img' });
    stubDownstream(crawler);
    let sleepCalls = 0;
    const realSleepStub = crawler.sleep;
    crawler.sleep = async (ms) => { sleepCalls++; return realSleepStub(ms); };
    let extractCalls = 0;
    crawler.extractProductUrlWithRetry = async () => {
      extractCalls++;
      return { productUrl: 'https://eur.vevor.com/p/X', productName: 'X', dataLayerFailed: false, dataLayerNotFound: false };
    };
    // 旧路径页面没有 waitForFunction：若新等待被调用会直接抛 TypeError
    const { page, stats } = createCrawlPage({});
    delete page.waitForFunction;

    const result = await crawler.crawlSingleSku('LEGACY-SKU', page);

    assert.strictEqual(stats.waitForFunctionCalls, 0);
    assert.strictEqual(extractCalls, 1);
    assert.ok(sleepCalls >= 1, 'legacy fixed sleep must still run');
    assert.strictEqual(result.product_url, 'https://eur.vevor.com/p/X');
    assert.strictEqual(result.status, 'success');
  });
});
