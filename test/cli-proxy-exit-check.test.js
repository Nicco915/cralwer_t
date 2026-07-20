const test = require('node:test');
const assert = require('node:assert');
const { parse } = require('../src/cli');

test('maps proxy exit check environment variables to config', () => {
  process.env.CRAWLER_PROXY_EXIT_VERIFY_ATTEMPTS = '5';
  process.env.CRAWLER_PROXY_EXIT_CHECK_TIMEOUT_MS = '12000';

  try {
    const config = parse([]);
    assert.strictEqual(config.proxyExitVerifyAttempts, 5);
    assert.strictEqual(config.proxyExitCheckTimeoutMs, 12000);
  } finally {
    delete process.env.CRAWLER_PROXY_EXIT_VERIFY_ATTEMPTS;
    delete process.env.CRAWLER_PROXY_EXIT_CHECK_TIMEOUT_MS;
  }
});
