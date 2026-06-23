const { describe, it } = require('node:test');
const assert = require('node:assert');
const { buildServiceConfig } = require('../bin/run');

describe('bin/run service config', () => {
  it('passes proxy to service config', () => {
    const config = buildServiceConfig({ proxy: 'http://proxy:8080' });
    assert.strictEqual(config.proxy, 'http://proxy:8080');
  });

  it('uses defaults when proxy is not provided', () => {
    const config = buildServiceConfig({});
    assert.strictEqual(config.proxy, undefined);
  });
});
