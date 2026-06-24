const { describe, it } = require('node:test');
const assert = require('node:assert');
const { isServiceOnline, waitForService } = require('../../deployment/windows/lib/health-check.js');

describe('health-check', () => {
  it('isServiceOnline returns false when pm2 not running', () => {
    const result = isServiceOnline('non-existent-app');
    assert.strictEqual(result, false);
  });

  it('waitForService resolves false when service not online', async () => {
    const result = await waitForService('crawler', 50, 10);
    assert.strictEqual(result, false);
  });
});
