const { describe, it } = require('node:test');
const assert = require('node:assert');
const { buildServiceConfig } = require('../bin/run.js');

describe('buildServiceConfig region passthrough', () => {
  it('passes regions / defaultRegion / clearCookiesOnRegionSwitch through', () => {
    const cfg = buildServiceConfig({
      regions: 'EU=https://eur.vevor.com,CN=',
      defaultRegion: 'GB',
      clearCookiesOnRegionSwitch: true,
    });
    assert.strictEqual(cfg.regions, 'EU=https://eur.vevor.com,CN=');
    assert.strictEqual(cfg.defaultRegion, 'GB');
    assert.strictEqual(cfg.clearCookiesOnRegionSwitch, true);
  });

  it('defaults defaultRegion to EU and the cookie guard to off', () => {
    const cfg = buildServiceConfig({});
    assert.strictEqual(cfg.defaultRegion, 'EU');
    assert.strictEqual(cfg.clearCookiesOnRegionSwitch, false);
    assert.strictEqual(cfg.regions, undefined);
  });

  it('tolerates string "true" from programmatic callers', () => {
    const cfg = buildServiceConfig({ clearCookiesOnRegionSwitch: 'true' });
    assert.strictEqual(cfg.clearCookiesOnRegionSwitch, true);
  });
});
