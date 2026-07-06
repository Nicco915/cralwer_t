const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
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

  it('passes cliproxy config to service config', () => {
    const config = buildServiceConfig({
      cliproxyHost: 'us.cliproxy.io',
      cliproxyPort: '3010',
      cliproxyUsername: 'user',
      cliproxyPassword: 'pass',
      cliproxyRegion: 'EU',
      cliproxyStickyMinutes: '120',
      cliproxySessionPrefix: 'crawler-01',
      cliproxyAssignmentsFile: './cliproxy.json',
      cliproxyRegionParamName: 'country',
      cliproxySessionParamName: 'session',
      cliproxyStickyParamName: 'sticky',
    });
    assert.strictEqual(config.cliproxyHost, 'us.cliproxy.io');
    assert.strictEqual(config.cliproxyPort, 3010);
    assert.strictEqual(config.cliproxyUsername, 'user');
    assert.strictEqual(config.cliproxyPassword, 'pass');
    assert.strictEqual(config.cliproxyRegion, 'EU');
    assert.strictEqual(config.cliproxyStickyMinutes, 120);
    assert.strictEqual(config.cliproxySessionPrefix, 'crawler-01');
    assert.strictEqual(config.cliproxyAssignmentsFile, './cliproxy.json');
    assert.strictEqual(config.cliproxyRegionParamName, 'country');
    assert.strictEqual(config.cliproxySessionParamName, 'session');
    assert.strictEqual(config.cliproxyStickyParamName, 'sticky');
  });

  it('uses cliproxy defaults when not provided', () => {
    const config = buildServiceConfig({});
    assert.strictEqual(config.cliproxyHost, undefined);
    assert.strictEqual(config.cliproxyPort, 1080);
    assert.strictEqual(config.cliproxyRegion, 'EU');
    assert.strictEqual(config.cliproxyStickyMinutes, 30);
    assert.ok(config.cliproxyAssignmentsFile.includes(path.join('output', 'cliproxy-assignments.json')));
    assert.strictEqual(config.cliproxyRegionParamName, 'country');
    assert.strictEqual(config.cliproxySessionParamName, 'session');
    assert.strictEqual(config.cliproxyStickyParamName, 'sticky');
  });

  it('uses proxy pool defaults when not provided', () => {
    const config = buildServiceConfig({});
    assert.ok(config.proxyAssignmentsFile.includes(path.join('output', 'proxy-assignments.json')));
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
    assert.strictEqual(config.dataLayerMaxRetries, 1);
    assert.strictEqual(config.dataLayerFailureThreshold, 3);
  });

  it('passes image upload config to service config', () => {
    const config = buildServiceConfig({
      imageUploadUrl: 'http://example.com/upload',
      imageUploadConcurrency: '3',
      imageUploadRetries: '5',
    });
    assert.strictEqual(config.imageUploadUrl, 'http://example.com/upload');
    assert.strictEqual(config.imageUploadConcurrency, 3);
    assert.strictEqual(config.imageUploadRetries, 5);
  });

  it('uses image upload defaults when not provided', () => {
    const config = buildServiceConfig({});
    assert.strictEqual(config.imageUploadUrl, '');
    assert.strictEqual(config.imageUploadConcurrency, 2);
    assert.strictEqual(config.imageUploadRetries, 3);
  });

  it('passes adaptive stealth config to service config', () => {
    const config = buildServiceConfig({
      stealthMode: 'adaptive',
      adaptiveTimeoutThreshold: '3',
      adaptiveRecoverySuccesses: '5',
      adaptiveDataLayerThreshold: '2',
      dataLayerProxyRotationThreshold: '3',
      cliproxyRotationCooldownMs: '60000',
    });
    assert.strictEqual(config.stealthMode, 'adaptive');
    assert.strictEqual(config.adaptiveTimeoutThreshold, 3);
    assert.strictEqual(config.adaptiveRecoverySuccesses, 5);
    assert.strictEqual(config.adaptiveDataLayerThreshold, 2);
    assert.strictEqual(config.dataLayerProxyRotationThreshold, 3);
    assert.strictEqual(config.cliproxyRotationCooldownMs, 60000);
  });

  it('uses adaptive stealth defaults when not provided', () => {
    const config = buildServiceConfig({});
    assert.strictEqual(config.stealthMode, 'channel');
    assert.strictEqual(config.adaptiveTimeoutThreshold, 1);
    assert.strictEqual(config.adaptiveRecoverySuccesses, 3);
    assert.strictEqual(config.adaptiveDataLayerThreshold, 1);
    assert.strictEqual(config.dataLayerProxyRotationThreshold, 1);
    assert.strictEqual(config.cliproxyRotationCooldownMs, 30000);
  });
});

describe('loadEnvFile', () => {
  const { loadEnvFile } = require('../src/cli');

  it('returns silently when .env is missing (Docker / env_file 场景)', () => {
    // 容器内不挂载 .env 文件时，env 变量已由 env_file/environment 注入
    assert.doesNotThrow(() => loadEnvFile('/nonexistent/crawler/dir'));
  });
});

describe('loadEnvFile', () => {
  const { loadEnvFile } = require('../src/cli');

  it('returns silently when .env is missing (Docker / env_file 场景)', () => {
    // 容器内不挂载 .env 文件时，env 变量已由 env_file/environment 注入
    assert.doesNotThrow(() => loadEnvFile('/nonexistent/crawler/dir'));
  });
});
