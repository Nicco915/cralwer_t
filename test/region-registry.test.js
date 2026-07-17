const { describe, it } = require('node:test');
const assert = require('node:assert');
const { RegionRegistry, parseRegions } = require('../src/region-registry');

describe('parseRegions', () => {
  it('parses code=url pairs', () => {
    assert.deepStrictEqual(parseRegions('EU=https://eur.vevor.com,CA=https://www.vevor.ca'), {
      EU: 'https://eur.vevor.com',
      CA: 'https://www.vevor.ca',
    });
  });

  it('keeps empty value for disabled codes and uppercases codes', () => {
    assert.deepStrictEqual(parseRegions('cn=, us = https://www.vevor.com'), {
      CN: '',
      US: 'https://www.vevor.com',
    });
  });

  it('returns empty object for missing/garbage input', () => {
    assert.deepStrictEqual(parseRegions(undefined), {});
    assert.deepStrictEqual(parseRegions(''), {});
    assert.deepStrictEqual(parseRegions(' , ,'), {});
  });
});

describe('RegionRegistry', () => {
  it('resolves built-in region codes with zero config', () => {
    const reg = new RegionRegistry();
    assert.strictEqual(reg.resolve('EU'), 'https://eur.vevor.com');
    assert.strictEqual(reg.resolve('GB'), 'https://www.vevor.co.uk');
    assert.strictEqual(reg.resolve('CA'), 'https://www.vevor.ca');
  });

  it('treats US as enabled by default with Cookie-based geo bypass', async () => {
    // 2026-07-17：page-crawler.js 注入 cdn_toggle_domain Cookie 绕过 DE geo 重定向，
    // 因此 US 任务可在 DE 代理的 VPS 上正常访问 www.vevor.com。
    const reg = new RegionRegistry();
    assert.strictEqual(reg.isKnown('US'), true);
    assert.strictEqual(reg.resolve('US'), 'https://www.vevor.com');
  });

  it('treats CN as known but disabled (null)', () => {
    const reg = new RegionRegistry();
    assert.strictEqual(reg.isKnown('CN'), true);
    assert.strictEqual(reg.resolve('CN'), null);
  });

  it('returns null and isKnown=false for unknown codes', () => {
    const reg = new RegionRegistry();
    assert.strictEqual(reg.isKnown('AU'), false);
    assert.strictEqual(reg.resolve('AU'), null);
  });

  it('normalizes case/whitespace and falls back to defaultRegion when empty', () => {
    const reg = new RegionRegistry();
    assert.strictEqual(reg.resolve('  gb '), 'https://www.vevor.co.uk');
    assert.strictEqual(reg.resolve(''), 'https://eur.vevor.com');
    assert.strictEqual(reg.resolve(undefined), 'https://eur.vevor.com');
  });

  it('lets CRAWLER_REGIONS override built-ins', () => {
    const reg = new RegionRegistry({ regions: 'US=https://us.internal.example' });
    assert.strictEqual(reg.resolve('US'), 'https://us.internal.example');
    assert.strictEqual(reg.resolve('GB'), 'https://www.vevor.co.uk');
  });

  it('legacyBaseUrl maps the default region when regions omits it (back-compat)', () => {
    const reg = new RegionRegistry({ legacyBaseUrl: 'https://legacy.example' });
    assert.strictEqual(reg.resolve('EU'), 'https://legacy.example');
    assert.strictEqual(reg.resolve(''), 'https://legacy.example');
  });

  it('regions entry beats legacyBaseUrl for the default region', () => {
    const reg = new RegionRegistry({ regions: 'EU=https://explicit.example', legacyBaseUrl: 'https://legacy.example' });
    assert.strictEqual(reg.resolve('EU'), 'https://explicit.example');
  });

  it('legacyBaseUrl applies to a non-EU defaultRegion too (deterministic rule)', () => {
    const reg = new RegionRegistry({ defaultRegion: 'GB', legacyBaseUrl: 'https://legacy.example' });
    assert.strictEqual(reg.resolve(''), 'https://legacy.example');
  });

  it('honors a non-EU defaultRegion without legacyBaseUrl', () => {
    const reg = new RegionRegistry({ defaultRegion: 'gb' });
    assert.strictEqual(reg.resolve(''), 'https://www.vevor.co.uk');
  });
});
