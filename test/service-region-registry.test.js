const { describe, it } = require('node:test');
const assert = require('node:assert');
const { CrawlerService } = require('../src/service');

describe('CrawlerService region registry wiring', () => {
  it('builds a RegionRegistry honoring regions + defaultRegion', () => {
    const service = new CrawlerService({
      regions: 'CN=,US=https://www.vevor.com',
      defaultRegion: 'GB',
      imageDir: './output/test-region-svc',
    });
    assert.strictEqual(service.regionRegistry.resolve('US'), 'https://www.vevor.com');
    assert.strictEqual(service.regionRegistry.resolve('CN'), null);
    assert.strictEqual(service.regionRegistry.resolve(''), 'https://www.vevor.co.uk');
  });

  it('back-compat: no regions config → EU via legacy baseUrl, other regions via built-ins', () => {
    const service = new CrawlerService({
      baseUrl: 'https://eur.vevor.com',
      imageDir: './output/test-region-svc',
    });
    assert.strictEqual(service.regionRegistry.resolve('EU'), 'https://eur.vevor.com');
    assert.strictEqual(service.regionRegistry.resolve(''), 'https://eur.vevor.com');
    assert.strictEqual(service.regionRegistry.resolve('CA'), 'https://www.vevor.ca');
  });
});
