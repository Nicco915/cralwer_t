const test = require('node:test');
const assert = require('node:assert');
const { parse } = require('../src/cli');

test('parses Kuaidaili proxy pool flags', () => {
  const config = parse([
    '--kuaidaili-secret-id', 'sid',
    '--kuaidaili-secret-key', 'skey',
    '--kuaidaili-proxy-type', 'kps',
    '--kuaidaili-token-cache-file', '/tmp/.kdl_token',
    '--kuaidaili-proxy-num', '500',
    '--proxy-machine-index', '1',
    '--proxy-machine-total', '3',
    '--proxy-refresh-interval-ms', '60000',
    '--proxy-assignments-file', './pool.json',
  ]);
  assert.strictEqual(config.kuaidailiSecretId, 'sid');
  assert.strictEqual(config.kuaidailiSecretKey, 'skey');
  assert.strictEqual(config.kuaidailiProxyType, 'kps');
  assert.strictEqual(config.kuaidailiTokenCacheFile, '/tmp/.kdl_token');
  assert.strictEqual(config.kuaidailiProxyNum, 500);
  assert.strictEqual(config.proxyMachineIndex, 1);
  assert.strictEqual(config.proxyMachineTotal, 3);
  assert.strictEqual(config.proxyRefreshIntervalMs, 60000);
  assert.strictEqual(config.proxyAssignmentsFile, './pool.json');
});

test('maps CLIPROXY_* environment variables to config', () => {
  process.env.CLIPROXY_HOST = 'eu.cliproxy.io';
  process.env.CLIPROXY_PORT = '1080';
  process.env.CLIPROXY_USERNAME = 'user';
  process.env.CLIPROXY_PASSWORD = 'pass';
  process.env.CLIPROXY_REGION = 'EU';
  process.env.CLIPROXY_ASN = 'AS12897';
  process.env.CLIPROXY_STICKY_MINUTES = '30';
  process.env.CLIPROXY_SESSION_PREFIX = 'crawler-01';
  process.env.CRAWLER_CLIPROXY_SESSION_PREFIX = 'crawler-02';
  process.env.CLIPROXY_ASSIGNMENTS_FILE = '/tmp/cliproxy.json';
  process.env.CLIPROXY_REGION_PARAM_NAME = 'region';
  process.env.CLIPROXY_ASN_PARAM_NAME = 'asn';
  process.env.CLIPROXY_SESSION_PARAM_NAME = 'sid';
  process.env.CLIPROXY_STICKY_PARAM_NAME = 't';

  try {
    const config = parse([]);
    assert.strictEqual(config.cliproxyHost, 'eu.cliproxy.io');
    assert.strictEqual(config.cliproxyPort, 1080);
    assert.strictEqual(config.cliproxyUsername, 'user');
    assert.strictEqual(config.cliproxyPassword, 'pass');
    assert.strictEqual(config.cliproxyRegion, 'EU');
    assert.strictEqual(config.cliproxyAsn, 'AS12897');
    assert.strictEqual(config.cliproxyStickyMinutes, 30);
    assert.strictEqual(config.cliproxySessionPrefix, 'crawler-02');
    assert.strictEqual(config.cliproxyAssignmentsFile, '/tmp/cliproxy.json');
    assert.strictEqual(config.cliproxyRegionParamName, 'region');
    assert.strictEqual(config.cliproxyAsnParamName, 'asn');
    assert.strictEqual(config.cliproxySessionParamName, 'sid');
    assert.strictEqual(config.cliproxyStickyParamName, 't');
  } finally {
    delete process.env.CLIPROXY_HOST;
    delete process.env.CLIPROXY_PORT;
    delete process.env.CLIPROXY_USERNAME;
    delete process.env.CLIPROXY_PASSWORD;
    delete process.env.CLIPROXY_REGION;
    delete process.env.CLIPROXY_ASN;
    delete process.env.CLIPROXY_STICKY_MINUTES;
    delete process.env.CLIPROXY_SESSION_PREFIX;
    delete process.env.CRAWLER_CLIPROXY_SESSION_PREFIX;
    delete process.env.CLIPROXY_ASSIGNMENTS_FILE;
    delete process.env.CLIPROXY_REGION_PARAM_NAME;
    delete process.env.CLIPROXY_ASN_PARAM_NAME;
    delete process.env.CLIPROXY_SESSION_PARAM_NAME;
    delete process.env.CLIPROXY_STICKY_PARAM_NAME;
  }
});
