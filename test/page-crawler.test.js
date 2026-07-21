const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { PageCrawler, encodeSkuForSearchPath, captureDiagnostics } = require('../src/page-crawler');

function createMockPage(opts = {}) {
  let currentUrl = opts.url || '';
  const customGoto = opts.goto;
  return {
    goto: async (url) => {
      if (customGoto) await customGoto(url);
      currentUrl = url;
    },
    url: () => currentUrl,
    evaluate: async (fn) => {
      if (opts.evaluate) return opts.evaluate(fn);
      return '';
    },
    content: async () => opts.html || '',
    $: async (selector) => {
      if (opts.elements && opts.elements[selector]) return opts.elements[selector];
      return null;
    },
    mouse: { move: async () => {} },
  };
}

// 在 Node 环境中，window 不存在；通过 vm 在隔离上下文执行 evaluate 回调，
// 让函数内部的 `window` 引用解析为 mock 对象。
// 这里采用更直接的方式：调用 fn 之前临时设置 global.window，
// 调用结束后还原，避免污染全局。
function runEvaluateWithWindow(fn, mockWindow) {
  const prevWindow = global.window;
  global.window = mockWindow;
  try {
    return fn.call(mockWindow, mockWindow);
  } finally {
    if (prevWindow === undefined) {
      delete global.window;
    } else {
      global.window = prevWindow;
    }
  }
}

describe('PageCrawler.extractPageSku', () => {
  it('extracts SKU from dataLayer.product.sku', async () => {
    const crawler = new PageCrawler();
    const page = createMockPage({
      evaluate: (fn) => {
        const mockWindow = { dataLayer: [{ product: { sku: 'ABC-123' } }] };
        return runEvaluateWithWindow(fn, mockWindow);
      },
    });
    const sku = await crawler.extractPageSku(page);
    assert.strictEqual(sku, 'ABC-123');
  });

  it('extracts SKU from dataLayer.ecommerce.detail.products', async () => {
    const crawler = new PageCrawler();
    const page = createMockPage({
      evaluate: (fn) => {
        const mockWindow = {
          dataLayer: [{
            ecommerce: {
              detail: {
                products: [{ sku: 'ECO-456' }]
              }
            }
          }]
        };
        return runEvaluateWithWindow(fn, mockWindow);
      },
    });
    const sku = await crawler.extractPageSku(page);
    assert.strictEqual(sku, 'ECO-456');
  });

  it('falls back to HTML regex when dataLayer is empty', async () => {
    const crawler = new PageCrawler();
    const page = createMockPage({
      evaluate: (fn) => {
        const mockWindow = { dataLayer: [] };
        return runEvaluateWithWindow(fn, mockWindow);
      },
      html: '<script>window.__INITIAL_STATE__ = {"sku":"XYZ-999"};</script>',
    });
    const sku = await crawler.extractPageSku(page);
    assert.strictEqual(sku, 'XYZ-999');
  });

  it('falls back to meta tag with name before content', async () => {
    const crawler = new PageCrawler();
    const page = createMockPage({
      evaluate: (fn) => {
        const mockWindow = { dataLayer: [] };
        return runEvaluateWithWindow(fn, mockWindow);
      },
      html: '<meta name="sku" content="META-001">',
    });
    const sku = await crawler.extractPageSku(page);
    assert.strictEqual(sku, 'META-001');
  });

  it('falls back to meta tag with content before name', async () => {
    const crawler = new PageCrawler();
    const page = createMockPage({
      evaluate: (fn) => {
        const mockWindow = { dataLayer: [] };
        return runEvaluateWithWindow(fn, mockWindow);
      },
      html: '<meta content="META-002" name="sku">',
    });
    const sku = await crawler.extractPageSku(page);
    assert.strictEqual(sku, 'META-002');
  });

  it('returns empty string when SKU is not found', async () => {
    const crawler = new PageCrawler();
    const page = createMockPage({
      evaluate: (fn) => {
        const mockWindow = { dataLayer: [] };
        return runEvaluateWithWindow(fn, mockWindow);
      },
      html: '<html></html>',
    });
    const sku = await crawler.extractPageSku(page);
    assert.strictEqual(sku, '');
  });

  it('returns empty string when evaluate throws', async () => {
    const crawler = new PageCrawler();
    const page = createMockPage({
      evaluate: () => { throw new Error('evaluate failed'); },
    });
    const sku = await crawler.extractPageSku(page);
    assert.strictEqual(sku, '');
  });

  it('returns empty string when content throws', async () => {
    const crawler = new PageCrawler();
    const page = createMockPage({
      evaluate: (fn) => {
        const mockWindow = { dataLayer: [] };
        return runEvaluateWithWindow(fn, mockWindow);
      },
      content: () => { throw new Error('content failed'); },
    });
    const sku = await crawler.extractPageSku(page);
    assert.strictEqual(sku, '');
  });
});

describe('PageCrawler.crawlSingleSku SKU mismatch interception', () => {
  it('returns sku_mismatch when page SKU differs from searched SKU', async () => {
    const crawler = new PageCrawler();
    crawler.sleep = async () => {};
    crawler.isCloudflareChallenge = async () => false;
    crawler.extractProductUrlFromDataLayer = async () => ['https://eur.vevor.com/p/B-123', ''];
    crawler.extractFromHtml = async () => ['', ''];
    crawler.extractPageSku = async () => 'B-123';

    const page = createMockPage({ url: 'https://eur.vevor.com/p/B-123' });
    const result = await crawler.crawlSingleSku('A-123', page);

    assert.strictEqual(result.status, 'sku_mismatch');
    assert.ok(result.error.includes('A-123'));
    assert.ok(result.error.includes('B-123'));
    assert.strictEqual(result.product_url, 'https://eur.vevor.com/p/B-123');
    assert.strictEqual(result.product_name, '');
    assert.strictEqual(result.features_details, '');
    assert.strictEqual(result.product_specification, '');
  });

  it('continues crawling when page SKU matches searched SKU', async () => {
    const crawler = new PageCrawler();
    crawler.sleep = async () => {};
    crawler.isCloudflareChallenge = async () => false;
    crawler.extractProductUrlFromDataLayer = async () => ['https://eur.vevor.com/p/A-123', ''];
    crawler.extractFromHtml = async () => ['', ''];
    crawler.extractPageSku = async () => 'A-123';
    crawler.extractAllProductImages = async () => [];

    const page = createMockPage({
      url: 'https://eur.vevor.com/p/A-123',
      elements: { 'h1': { innerText: async () => 'Product A' } },
    });
    const result = await crawler.crawlSingleSku('A-123', page);

    assert.strictEqual(result.status, 'success');
    assert.strictEqual(result.product_name, 'Product A');
  });

  it('continues crawling when page SKU cannot be extracted', async () => {
    const crawler = new PageCrawler();
    crawler.sleep = async () => {};
    crawler.isCloudflareChallenge = async () => false;
    crawler.extractProductUrlFromDataLayer = async () => ['https://eur.vevor.com/p/A-123', ''];
    crawler.extractFromHtml = async () => ['', ''];
    crawler.extractPageSku = async () => '';
    crawler.extractAllProductImages = async () => [];

    const page = createMockPage({
      url: 'https://eur.vevor.com/p/A-123',
      elements: { 'h1': { innerText: async () => 'Product A' } },
    });
    const result = await crawler.crawlSingleSku('A-123', page);

    assert.strictEqual(result.status, 'success');
  });
});

describe('PageCrawler.encodeSkuForSearchPath', () => {
  it('encodes hyphens as %2D to avoid Vevor tokenizing the SKU', () => {
    assert.strictEqual(
      encodeSkuForSearchPath('PQFJYNF-250-2T001V7'),
      'PQFJYNF%2D250%2D2T001V7'
    );
  });

  it('leaves SKUs without hyphens unchanged', () => {
    assert.strictEqual(encodeSkuForSearchPath('ABC123'), 'ABC123');
  });

  it('replaces slashes with commas so the search route is not truncated', () => {
    assert.strictEqual(
      encodeSkuForSearchPath('HJLGY32.2525/24OOV0'),
      'HJLGY32.2525,24OOV0'
    );
  });
});

describe('PageCrawler.crawlSingleSku search URL encoding', () => {
  it('uses encoded SKU path for the initial search', async () => {
    const crawler = new PageCrawler();
    crawler.sleep = async () => {};
    crawler.isCloudflareChallenge = async () => false;
    crawler.extractProductUrlFromDataLayer = async () => ['https://eur.vevor.com/p/A-123', ''];
    crawler.extractFromHtml = async () => ['', ''];
    crawler.extractPageSku = async () => 'A-123';
    crawler.extractAllProductImages = async () => [];

    const visitedUrls = [];
    const page = createMockPage({
      url: 'https://eur.vevor.com/p/A-123',
      goto: async (url) => { visitedUrls.push(url); },
      elements: { 'h1': { innerText: async () => 'Product A' } },
    });

    await crawler.crawlSingleSku('A-123', page);

    assert.strictEqual(visitedUrls.length, 2);
    assert.strictEqual(visitedUrls[0], 'https://eur.vevor.com/s/A%2D123');
    assert.strictEqual(visitedUrls[1], 'https://eur.vevor.com/p/A-123');
  });
});

describe('PageCrawler.crawlSingleSku image filename sanitization', () => {
  it('saves images without path separators when SKU contains a slash', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'img-test-'));
    const crawler = new PageCrawler({ imageDir: tmpDir });
    crawler.sleep = async () => {};
    crawler.isCloudflareChallenge = async () => false;
    crawler.extractProductUrlFromDataLayer = async () => ['https://eur.vevor.com/p/X-1', ''];
    crawler.extractFromHtml = async () => ['', ''];
    crawler.extractPageSku = async () => 'HJLGY32.2525/24OOV0';
    crawler.extractAllProductImages = async () => ['https://img.vevorstatic.com/goods_img/a.jpg'];
    crawler.downloadImage = async () => Buffer.from('fake-jpg');

    const page = createMockPage({
      url: 'https://eur.vevor.com/p/X-1',
      elements: { 'h1': { innerText: async () => 'Product X' } },
    });

    try {
      const result = await crawler.crawlSingleSku('HJLGY32.2525/24OOV0', page);
      assert.strictEqual(result.status, 'success');
      assert.ok(result.image_paths, 'image_paths should not be empty');
      const rel = path.relative(tmpDir, result.image_paths);
      assert.ok(!rel.includes('/') && !rel.includes('\\'), `image path must stay flat in imageDir, got: ${result.image_paths}`);
      assert.ok(rel.startsWith('HJLGY32.2525%2F24OOV0_1.'), `filename should encode slash as %2F, got: ${rel}`);
      assert.ok(fs.existsSync(result.image_paths), 'image file should exist on disk');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('captureDiagnostics', () => {
  it('saves screenshot, html snippet, and metadata when outputDir is set', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-test-'));
    const page = {
      title: async () => 'Challenge Page',
      url: () => 'https://eur.vevor.com/s/TEST-123',
      screenshot: async ({ path: screenshotPath }) => {
        fs.writeFileSync(screenshotPath, 'fake-png');
      },
      content: async () => '<html><body>robot check</body></html>',
      evaluate: async () => ({ ip: '198.51.100.1', country: 'US' }),
    };

    const meta = await captureDiagnostics(page, 'TEST-123', 'dataLayer-timeout', tmpDir);

    try {
      assert.ok(meta, 'should return metadata');
      assert.strictEqual(meta.title, 'Challenge Page');
      assert.strictEqual(meta.url, 'https://eur.vevor.com/s/TEST-123');
      assert.ok(meta.screenshot, 'screenshot path should be set');
      assert.ok(fs.existsSync(meta.screenshot), 'screenshot file should exist');
      assert.ok(meta.htmlSnippet, 'html snippet path should be set');
      assert.ok(fs.existsSync(meta.htmlSnippet), 'html snippet file should exist');
      assert.deepStrictEqual(meta.ipInfo, { ip: '198.51.100.1', country: 'US' });

      const jsonPath = path.join(path.dirname(meta.screenshot), path.basename(meta.screenshot, '.png') + '.json');
      assert.ok(fs.existsSync(jsonPath), 'metadata json should exist');
      const saved = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      assert.strictEqual(saved.sku, 'TEST-123');
      assert.strictEqual(saved.label, 'dataLayer-timeout');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns null and does nothing when outputDir is empty', async () => {
    const page = {
      title: async () => { throw new Error('should not be called'); },
      url: () => 'https://example.com',
    };
    const meta = await captureDiagnostics(page, 'SKU', 'timeout', '');
    assert.strictEqual(meta, null);
  });

  it('keeps diagnostic files flat in the date dir when SKU contains a slash', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-slash-'));
    const page = {
      title: async () => 'No Results',
      url: () => 'https://www.vevor.ca/s/HJLGY32.2525/24OOV0',
      screenshot: async ({ path: screenshotPath }) => {
        fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
        fs.writeFileSync(screenshotPath, 'fake-png');
      },
      content: async () => '<html><body>no results</body></html>',
      evaluate: async () => ({ ip: '198.51.100.1' }),
    };

    const meta = await captureDiagnostics(page, 'HJLGY32.2525/24OOV0', 'dataLayer-never-pushed', tmpDir);

    try {
      const dateDir = fs.readdirSync(tmpDir)[0];
      for (const p of [meta.screenshot, meta.htmlSnippet]) {
        assert.ok(p, 'diagnostic path should be set');
        assert.strictEqual(path.dirname(p), path.join(tmpDir, dateDir),
          `diagnostic file must sit directly in the date dir, got: ${p}`);
        assert.ok(fs.existsSync(p), `diagnostic file should exist: ${p}`);
      }
      assert.ok(path.basename(meta.screenshot).includes('HJLGY32.2525%2F24OOV0'),
        `diagnostic filename should encode slash as %2F, got: ${meta.screenshot}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
