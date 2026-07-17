const { describe, it } = require('node:test');
const assert = require('node:assert');
const { PageCrawler } = require('../src/page-crawler');

function createMockPage(opts = {}) {
  let currentUrl = opts.url || '';
  const customGoto = opts.goto;
  const cookies = [];
  return {
    goto: async (url) => { if (customGoto) await customGoto(url); currentUrl = url; },
    url: () => currentUrl,
    evaluate: async () => '',
    content: async () => '',
    $: async () => null,
    mouse: { move: async () => {} },
    context: () => ({
      addCookies: async (batch) => { cookies.push(...batch); },
      cookies: async () => cookies,
    }),
    _cookies: cookies,
  };
}

function stubCrawler(crawler, productUrl) {
  crawler.sleep = async () => {};
  crawler.isCloudflareChallenge = async () => false;
  crawler.extractProductUrlFromDataLayer = async () => [productUrl, ''];
  crawler.extractFromHtml = async () => ['', ''];
  crawler.extractPageSku = async () => 'A-123';
  crawler.extractAllProductImages = async () => [];
}

describe('PageCrawler.crawlSingleSku per-call baseUrl', () => {
  it('uses options.baseUrl for the search URL when provided', async () => {
    const crawler = new PageCrawler({ baseUrl: 'https://eur.vevor.com' });
    stubCrawler(crawler, 'https://www.vevor.ca/p/A-123');
    const visited = [];
    const page = createMockPage({
      url: 'https://www.vevor.ca/p/A-123',
      goto: async (u) => { visited.push(u); },
      elements: { 'h1': { innerText: async () => 'T' } },
    });

    await crawler.crawlSingleSku('A-123', page, undefined, { baseUrl: 'https://www.vevor.ca' });

    assert.strictEqual(visited[0], 'https://www.vevor.ca/s/A%2D123');
  });

  it('falls back to config.baseUrl when options.baseUrl is absent', async () => {
    const crawler = new PageCrawler({ baseUrl: 'https://eur.vevor.com' });
    stubCrawler(crawler, 'https://eur.vevor.com/p/A-123');
    const visited = [];
    const page = createMockPage({
      url: 'https://eur.vevor.com/p/A-123',
      goto: async (u) => { visited.push(u); },
      elements: { 'h1': { innerText: async () => 'T' } },
    });

    await crawler.crawlSingleSku('A-123', page);

    assert.strictEqual(visited[0], 'https://eur.vevor.com/s/A%2D123');
  });

  it('injects cdn_toggle_domain cookie for US domain to bypass geo redirect', async () => {
    const crawler = new PageCrawler({ baseUrl: 'https://eur.vevor.com' });
    stubCrawler(crawler, 'https://www.vevor.com/p/A-123');
    const page = createMockPage({
      url: 'https://www.vevor.com/p/A-123',
      goto: async () => {},
    });

    await crawler.crawlSingleSku('A-123', page, undefined, { baseUrl: 'https://www.vevor.com' });

    assert.deepStrictEqual(page._cookies, [
      { name: 'cdn_toggle_domain', value: '1', domain: 'www.vevor.com', path: '/' },
    ]);
  });

  it('does not inject geo bypass cookie for non-US domains', async () => {
    const crawler = new PageCrawler({ baseUrl: 'https://eur.vevor.com' });
    stubCrawler(crawler, 'https://www.vevor.ca/p/A-123');
    const page = createMockPage({
      url: 'https://www.vevor.ca/p/A-123',
      goto: async () => {},
    });

    await crawler.crawlSingleSku('A-123', page, undefined, { baseUrl: 'https://www.vevor.ca' });

    assert.strictEqual(page._cookies.length, 0);
  });
});
