const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { parse } = require('../src/cli');

const ENV_KEYS = ['CRAWLER_REGIONS', 'CRAWLER_DEFAULT_REGION', 'CRAWLER_CLEAR_COOKIES_ON_REGION_SWITCH'];
const saved = {};
beforeEach(() => { for (const k of ENV_KEYS) saved[k] = process.env[k]; });
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('cli region config', () => {
  it('maps CRAWLER_REGIONS / CRAWLER_DEFAULT_REGION env', () => {
    process.env.CRAWLER_REGIONS = 'EU=https://eur.vevor.com,CN=';
    process.env.CRAWLER_DEFAULT_REGION = 'GB';
    const config = parse([]);
    assert.strictEqual(config.regions, 'EU=https://eur.vevor.com,CN=');
    assert.strictEqual(config.defaultRegion, 'GB');
  });

  it('maps --regions / --default-region flags', () => {
    delete process.env.CRAWLER_REGIONS;
    delete process.env.CRAWLER_DEFAULT_REGION;
    const config = parse(['--regions=EU=https://eur.vevor.com', '--default-region', 'CA']);
    assert.strictEqual(config.regions, 'EU=https://eur.vevor.com');
    assert.strictEqual(config.defaultRegion, 'CA');
  });

  it('parses CRAWLER_CLEAR_COOKIES_ON_REGION_SWITCH as boolean', () => {
    process.env.CRAWLER_CLEAR_COOKIES_ON_REGION_SWITCH = 'true';
    assert.strictEqual(parse([]).clearCookiesOnRegionSwitch, true);
    process.env.CRAWLER_CLEAR_COOKIES_ON_REGION_SWITCH = 'false';
    assert.strictEqual(parse([]).clearCookiesOnRegionSwitch, false);
  });

  it('parses --clear-cookies-on-region-switch / --no-clear-cookies-on-region-switch', () => {
    delete process.env.CRAWLER_CLEAR_COOKIES_ON_REGION_SWITCH;
    assert.strictEqual(parse(['--clear-cookies-on-region-switch']).clearCookiesOnRegionSwitch, true);
    assert.strictEqual(parse(['--no-clear-cookies-on-region-switch']).clearCookiesOnRegionSwitch, false);
  });
});
