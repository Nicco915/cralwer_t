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

  it('passes proxy pool config to service config', () => {
    const config = buildServiceConfig({
      kuaidailiSecretId: 'sid',
      kuaidailiSecretKey: 'skey',
      proxyMachineIndex: '1',
      proxyMachineTotal: '3',
      proxyRefreshIntervalMs: '60000',
      proxyAssignmentsFile: './pool.json',
      kuaidailiProxyNum: '500',
    });
    assert.strictEqual(config.kuaidailiSecretId, 'sid');
    assert.strictEqual(config.kuaidailiSecretKey, 'skey');
    assert.strictEqual(config.kuaidailiProxyType, 'kps');
    assert.strictEqual(config.kuaidailiTokenCacheFile, '.kdl_token');
    assert.strictEqual(config.proxyMachineIndex, 1);
    assert.strictEqual(config.proxyMachineTotal, 3);
    assert.strictEqual(config.proxyRefreshIntervalMs, 60000);
    assert.strictEqual(config.proxyAssignmentsFile, './pool.json');
    assert.strictEqual(config.kuaidailiProxyNum, 500);
  });

  it('uses proxy pool defaults when not provided', () => {
    const config = buildServiceConfig({});
    assert.ok(config.proxyAssignmentsFile.includes('proxy-assignments.json'));
    assert.strictEqual(config.proxyMachineIndex, 0);
    assert.strictEqual(config.proxyMachineTotal, 1);
    assert.strictEqual(config.proxyRefreshIntervalMs, 300000);
    assert.strictEqual(config.kuaidailiProxyType, 'kps');
    assert.strictEqual(config.kuaidailiTokenCacheFile, '.kdl_token');
    assert.strictEqual(config.kuaidailiProxyNum, 1000);
  });

  it('passes dataLayer retry config to service config', () => {
    const config = buildServiceConfig({
      dataLayerMaxRetries: '5',
      dataLayerFailureThreshold: '10',
    });
    assert.strictEqual(config.dataLayerMaxRetries, 5);
    assert.strictEqual(config.dataLayerFailureThreshold, 10);
  });

  it('uses dataLayer retry defaults when not provided', () => {
    const config = buildServiceConfig({});
    assert.strictEqual(config.dataLayerMaxRetries, 2);
    assert.strictEqual(config.dataLayerFailureThreshold, 3);
  });
});

describe('loadEnvFile', () => {
  const { loadEnvFile } = require('../src/cli');

  it('throws clear error when .env is missing', () => {
    assert.throws(
      () => loadEnvFile('/nonexistent/crawler/dir'),
      /\.env file not found/
    );
  });
});
