const { describe, it } = require('node:test');
const assert = require('node:assert');
const { Channel } = require('../src/channel');

// Channel.rotateProxy(reason) — 由 worker.runTask 在任务失败时调用。
// 返回 { rotated, reason } 让 caller 决定是否重试：
//   - rotated=true: 已换 IP，可重试
//   - rotated=false: 跳过换 IP（cooldown / 正在重建 / 无 pool / 错误），直接提交原 result

function makeMockPool() {
  return {
    nextForChannel: async (channelId) => `http://new-proxy-for-${channelId}`,
  };
}

function makeChannel(overrides = {}) {
  const channel = new Channel({
    id: 1,
    config: {
      cliproxyRotationCooldownMs: 30000,
      ...(overrides.config || {}),
    },
    log: () => {},
  });
  channel.browserContext = {
    browser: () => ({ isConnected: () => true }),
  };
  channel.proxyPool = overrides.proxyPool !== undefined ? overrides.proxyPool : makeMockPool();
  channel.reinitializing = false;
  channel.lastIpRotationAt = 0;
  // mock reinit 和 recordIpRotation
  channel.reinit = async function (_browser, proxy) {
    channel._lastReinitProxy = proxy;
  };
  channel.recordIpRotation = function () {
    channel.lastIpRotationAt = Date.now();
  };
  return channel;
}

describe('Channel.rotateProxy', () => {
  it('rotates IP when conditions are met', async () => {
    const channel = makeChannel();
    const result = await channel.rotateProxy('task-timeout');

    assert.strictEqual(result.rotated, true);
    assert.strictEqual(result.reason, 'success');
    assert.strictEqual(channel._lastReinitProxy, 'http://new-proxy-for-ch-1');
    assert.ok(channel.lastIpRotationAt > 0, 'should record IP rotation timestamp');
  });

  it('skips rotation within cooldown window', async () => {
    const channel = makeChannel();
    channel.lastIpRotationAt = Date.now() - 10000; // 10s ago, cooldown=30s
    let called = false;
    channel.proxyPool.nextForChannel = async () => { called = true; return 'proxy'; };

    const result = await channel.rotateProxy('task-timeout');

    assert.strictEqual(result.rotated, false);
    assert.strictEqual(result.reason, 'cooldown');
    assert.strictEqual(called, false, 'should not call nextForChannel');
  });

  it('allows rotation after cooldown elapsed', async () => {
    const channel = makeChannel();
    channel.lastIpRotationAt = Date.now() - 31000; // 31s ago
    const result = await channel.rotateProxy('task-timeout');
    assert.strictEqual(result.rotated, true);
    assert.strictEqual(result.reason, 'success');
  });

  it('skips rotation when channel is already reinitializing', async () => {
    const channel = makeChannel();
    channel.reinitializing = true;
    let called = false;
    channel.proxyPool.nextForChannel = async () => { called = true; return 'proxy'; };

    const result = await channel.rotateProxy('task-timeout');

    assert.strictEqual(result.rotated, false);
    assert.strictEqual(result.reason, 'reinitializing');
    assert.strictEqual(called, false);
  });

  it('returns no_pool when proxyPool is not configured', async () => {
    const channel = makeChannel();
    channel.proxyPool = null;
    const result = await channel.rotateProxy('task-timeout');
    assert.strictEqual(result.rotated, false);
    assert.strictEqual(result.reason, 'no_pool');
  });

  it('returns error when nextForChannel throws', async () => {
    const channel = makeChannel();
    channel.proxyPool.nextForChannel = async () => { throw new Error('pool exhausted'); };

    const result = await channel.rotateProxy('task-timeout');

    assert.strictEqual(result.rotated, false);
    assert.strictEqual(result.reason, 'error');
    assert.ok(result.error.includes('pool exhausted'));
    assert.strictEqual(channel.reinitializing, false, 'should release reinitializing in finally');
  });

  it('returns error when reinit throws', async () => {
    const channel = makeChannel();
    channel.reinit = async () => { throw new Error('browser dead'); };

    const result = await channel.rotateProxy('task-timeout');

    assert.strictEqual(result.rotated, false);
    assert.strictEqual(result.reason, 'error');
    assert.ok(result.error.includes('browser dead'));
    assert.strictEqual(channel.reinitializing, false);
  });

  it('rotates IP against a real initialized channel', async () => {
    const channel = new Channel({ id: 1, config: { cliproxyRotationCooldownMs: 30000 }, log: () => {} });
    const mockBrowser = {
      isConnected: () => true,
      newContext: async () => ({
        addInitScript: async () => {},
        newPage: async () => ({ close: async () => {} }),
        browser: () => mockBrowser,
        close: async () => {},
      }),
    };
    channel.proxyPool = {
      nextForChannel: async () => 'http://rotated-proxy:8080',
    };
    await channel.init(mockBrowser);
    const result = await channel.rotateProxy('task-timeout');
    assert.strictEqual(result.rotated, true);
    assert.strictEqual(result.reason, 'success');
    assert.ok(channel.config.proxy.includes('rotated-proxy'));
  });
});
