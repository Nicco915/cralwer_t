const test = require('node:test');
const assert = require('node:assert');
const { parse } = require('../src/cli');

test('parses Kuaidaili proxy pool flags', () => {
  const config = parse([
    '--kuaidaili-secret-id', 'sid',
    '--kuaidaili-secret-key', 'skey',
    '--kuaidaili-proxy-type', 'kps',
    '--kuaidaili-token-cache-file', '/tmp/.kdl_token',
    '--proxy-machine-index', '1',
    '--proxy-machine-total', '3',
    '--proxy-refresh-interval-ms', '60000',
    '--proxy-assignments-file', './pool.json',
  ]);
  assert.strictEqual(config.kuaidailiSecretId, 'sid');
  assert.strictEqual(config.kuaidailiSecretKey, 'skey');
  assert.strictEqual(config.kuaidailiProxyType, 'kps');
  assert.strictEqual(config.kuaidailiTokenCacheFile, '/tmp/.kdl_token');
  assert.strictEqual(config.proxyMachineIndex, 1);
  assert.strictEqual(config.proxyMachineTotal, 3);
  assert.strictEqual(config.proxyRefreshIntervalMs, 60000);
  assert.strictEqual(config.proxyAssignmentsFile, './pool.json');
});
