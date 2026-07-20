const { describe, it } = require('node:test');
const assert = require('node:assert');
const { Channel } = require('../src/channel');

// Channel.rotateProxy 出口校验：配置了 cliproxyAsn 且注入了 proxyExitChecker 时，
// 换 IP 前先验证新出口 org 命中目标 ASN（cliproxy 对无效 ASN 会静默回落其他池，
// 也可能分到挂起的出口）；不匹配/查询失败则用 force 轮换拉下一个候选，
// 全部候选都不匹配时接受最后一个并以 degraded=true 标记降级。

function makeChannel(overrides = {}) {
  const channel = new Channel({
    id: 1,
    config: {
      cliproxyRotationCooldownMs: 30000,
      cliproxyAsn: 'AS9145',
      ...(overrides.config || {}),
    },
    log: () => {},
    proxyExitChecker: overrides.proxyExitChecker,
  });
  channel.browserContext = {
    browser: () => ({ isConnected: () => true }),
  };
  channel.proxyPool = overrides.proxyPool || {
    calls: [],
    nextForChannel: async (channelId, options) => {
      const url = `http://proxy-candidate-${channel.proxyPool.calls.length}-for-${channelId}`;
      channel.proxyPool.calls.push({ channelId, options, url });
      return url;
    },
  };
  channel.reinitializing = false;
  channel.lastIpRotationAt = 0;
  channel.reinit = async function (_browser, proxy) {
    channel._lastReinitProxy = proxy;
  };
  channel.recordIpRotation = function () {
    channel.lastIpRotationAt = Date.now();
  };
  return channel;
}

describe('Channel.rotateProxy exit ASN verification', () => {
  it('accepts the first candidate when exit org matches the configured ASN', async () => {
    const checked = [];
    const channel = makeChannel({
      proxyExitChecker: async (proxyUrl) => {
        checked.push(proxyUrl);
        return { ip: '1.2.3.4', org: 'AS9145 EWE TEL GmbH' };
      },
    });

    const result = await channel.rotateProxy('task-timeout');

    assert.strictEqual(result.rotated, true);
    assert.strictEqual(result.degraded, false);
    assert.strictEqual(checked.length, 1);
    assert.strictEqual(channel._lastReinitProxy, 'http://proxy-candidate-0-for-ch-1');
  });

  it('re-rolls with force when exit org silently falls back to another ASN', async () => {
    const channel = makeChannel({
      proxyExitChecker: async (proxyUrl) => {
        if (proxyUrl.includes('candidate-0')) {
          return { ip: '5.6.7.8', org: 'AS3320 Deutsche Telekom AG' };
        }
        return { ip: '9.9.9.9', org: 'AS9145 EWE TEL GmbH' };
      },
    });

    const result = await channel.rotateProxy('task-timeout');

    assert.strictEqual(result.rotated, true);
    assert.strictEqual(result.degraded, false);
    assert.strictEqual(channel.proxyPool.calls.length, 2);
    assert.deepStrictEqual(channel.proxyPool.calls[1].options, { force: true });
    assert.strictEqual(channel._lastReinitProxy, 'http://proxy-candidate-1-for-ch-1');
  });

  it('treats checker failure (hung exit) as a bad candidate and re-rolls', async () => {
    let calls = 0;
    const channel = makeChannel({
      proxyExitChecker: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error('exit check timeout after 8000ms');
        }
        return { ip: '9.9.9.9', org: 'AS9145 EWE TEL GmbH' };
      },
    });

    const result = await channel.rotateProxy('task-timeout');

    assert.strictEqual(result.rotated, true);
    assert.strictEqual(calls, 2);
    assert.strictEqual(channel._lastReinitProxy, 'http://proxy-candidate-1-for-ch-1');
  });

  it('accepts the last candidate as degraded when all candidates mismatch', async () => {
    const channel = makeChannel({
      config: { proxyExitVerifyAttempts: 3 },
      proxyExitChecker: async () => ({ ip: '5.6.7.8', org: 'AS3320 Deutsche Telekom AG' }),
    });

    const result = await channel.rotateProxy('task-timeout');

    assert.strictEqual(result.rotated, true);
    assert.strictEqual(result.degraded, true);
    assert.strictEqual(result.exitOrg, 'AS3320 Deutsche Telekom AG');
    assert.strictEqual(channel.proxyPool.calls.length, 3);
    assert.strictEqual(channel._lastReinitProxy, 'http://proxy-candidate-2-for-ch-1');
  });

  it('matches on the asn field when the checker returns mayips-style output', async () => {
    const channel = makeChannel({
      proxyExitChecker: async () => ({ country: 'DE', ip: '31.150.181.142', asn: 'AS9145', at: 'isp' }),
    });

    const result = await channel.rotateProxy('task-timeout');

    assert.strictEqual(result.rotated, true);
    assert.strictEqual(result.degraded, false);
    assert.strictEqual(channel.proxyPool.calls.length, 1);
  });

  it('re-rolls when the asn field mismatches even if org is absent', async () => {
    let calls = 0;
    const channel = makeChannel({
      proxyExitChecker: async () => {
        calls += 1;
        return calls === 1
          ? { country: 'DE', ip: '5.6.7.8', asn: 'AS3320', at: 'isp' }
          : { country: 'DE', ip: '9.9.9.9', asn: 'AS9145', at: 'isp' };
      },
    });

    const result = await channel.rotateProxy('task-timeout');

    assert.strictEqual(result.rotated, true);
    assert.strictEqual(result.degraded, false);
    assert.strictEqual(channel.proxyPool.calls.length, 2);
  });

  it('skips verification when no ASN is configured', async () => {
    let checkerCalled = false;
    const channel = makeChannel({
      config: { cliproxyAsn: '' },
      proxyExitChecker: async () => {
        checkerCalled = true;
        return { ip: '1.2.3.4', org: 'AS3320 Deutsche Telekom AG' };
      },
    });

    const result = await channel.rotateProxy('task-timeout');

    assert.strictEqual(result.rotated, true);
    assert.strictEqual(checkerCalled, false);
    assert.strictEqual(channel.proxyPool.calls.length, 1);
  });

  it('skips verification when no checker is injected', async () => {
    const channel = makeChannel({ proxyExitChecker: undefined });

    const result = await channel.rotateProxy('task-timeout');

    assert.strictEqual(result.rotated, true);
    assert.strictEqual(channel.proxyPool.calls.length, 1);
  });
});
