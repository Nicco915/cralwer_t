const { describe, it } = require('node:test');
const assert = require('node:assert');
const { Channel } = require('../src/channel');

describe('Channel', () => {
  it('counts consecutive failures and detects proxy errors', async () => {
    const channel = new Channel({ id: 1, config: {}, log: () => {} });
    channel.page = { evaluate: async () => 'title' };
    channel.browserContext = { browser: () => ({ isConnected: () => true }) };

    assert.strictEqual(channel.isProxyError(new Error('page.goto: net::ERR_TUNNEL_CONNECTION_FAILED')), true);
    assert.strictEqual(channel.isProxyError(new Error('page.goto: net::ERR_CONNECTION_RESET')), true);
    assert.strictEqual(channel.isProxyError(new Error('page.goto: timeout')), false);

    channel.consecutiveFailures = 2;
    channel.lastFailureWasProxy = true;
    assert.strictEqual(channel.consecutiveFailures, 2);
    assert.strictEqual(channel.lastFailureWasProxy, true);
  });
});
