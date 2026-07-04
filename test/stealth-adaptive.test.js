const { describe, it } = require('node:test');
const assert = require('node:assert');
const { Channel } = require('../src/channel');

function createMockBrowser() {
  return {
    isConnected() { return true; },
    async newContext() {
      return {
        browser: () => this,
        async addInitScript() {},
        async newPage() { return { close: async () => {} }; },
        async close() {},
      };
    },
    async close() {},
  };
}

const browser = createMockBrowser();

describe('Channel adaptive stealth mode', () => {
  it('starts in channel-like effective mode', async () => {
    const channel = new Channel({
      id: 1,
      config: {
        nodeCode: 'crawler-01',
        stealthMode: 'adaptive',
        adaptiveTimeoutThreshold: 2,
        adaptiveRecoverySuccesses: 3,
      },
      log: () => {},
    });

    assert.strictEqual(channel.stealthMode, 'adaptive');
    assert.strictEqual(channel.effectiveStealthMode, 'channel');
  });

  it('switches to session after consecutive timeouts', async () => {
    const logs = [];
    const channel = new Channel({
      id: 1,
      config: {
        nodeCode: 'crawler-01',
        stealthMode: 'adaptive',
        adaptiveTimeoutThreshold: 2,
        adaptiveRecoverySuccesses: 3,
      },
      log: (msg) => logs.push(msg),
    });

    await channel.init(browser);
    const initialProfile = channel.profile.signature;

    channel.updateAdaptiveState('timeout', true);
    assert.strictEqual(channel.effectiveStealthMode, 'channel');

    channel.updateAdaptiveState('timeout', true);
    assert.strictEqual(channel.effectiveStealthMode, 'session');
    assert.ok(logs.some(msg => msg.includes('switching to session mode')));

    await channel.recreateContext(browser);
    assert.notStrictEqual(channel.profile.signature, initialProfile);
  });

  it('switches back to channel after consecutive successes', async () => {
    const logs = [];
    const channel = new Channel({
      id: 1,
      config: {
        nodeCode: 'crawler-01',
        stealthMode: 'adaptive',
        adaptiveTimeoutThreshold: 2,
        adaptiveRecoverySuccesses: 3,
      },
      log: (msg) => logs.push(msg),
    });

    await channel.init(browser);
    channel.updateAdaptiveState('timeout', true);
    channel.updateAdaptiveState('timeout', true);
    assert.strictEqual(channel.effectiveStealthMode, 'session');

    channel.updateAdaptiveState('success', false);
    channel.updateAdaptiveState('success', false);
    assert.strictEqual(channel.effectiveStealthMode, 'session');

    channel.updateAdaptiveState('success', false);
    assert.strictEqual(channel.effectiveStealthMode, 'channel');
    assert.ok(logs.some(msg => msg.includes('switching back to channel mode')));
  });

  it('resets timeout counter on non-timeout results', async () => {
    const channel = new Channel({
      id: 1,
      config: {
        nodeCode: 'crawler-01',
        stealthMode: 'adaptive',
        adaptiveTimeoutThreshold: 2,
        adaptiveRecoverySuccesses: 3,
      },
      log: () => {},
    });

    channel.updateAdaptiveState('timeout', true);
    channel.updateAdaptiveState('error', false);
    assert.strictEqual(channel.effectiveStealthMode, 'channel');
    assert.strictEqual(channel.consecutiveTimeouts, 0);

    channel.updateAdaptiveState('timeout', true);
    channel.updateAdaptiveState('timeout', true);
    assert.strictEqual(channel.effectiveStealthMode, 'session');
  });

  it('does not switch modes in plain channel mode', async () => {
    const channel = new Channel({
      id: 1,
      config: {
        nodeCode: 'crawler-01',
        stealthMode: 'channel',
      },
      log: () => {},
    });

    channel.updateAdaptiveState('timeout', true);
    channel.updateAdaptiveState('timeout', true);
    channel.updateAdaptiveState('timeout', true);
    assert.strictEqual(channel.stealthMode, 'channel');
    assert.strictEqual(channel.effectiveStealthMode, 'channel');
  });
});
