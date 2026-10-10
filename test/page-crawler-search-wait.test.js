const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PageCrawler, captureDiagnostics } = require('../src/page-crawler');

// docs/plan-datalayer判定修复.md
// PR-1：拦截页识别（isAwsWafChallenge）+ 诊断 HTML 截断 8K→200K。
// PR-2 将在本文件追加 waitForSearchPageReady / crawlSingleSku 接线测试。

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
