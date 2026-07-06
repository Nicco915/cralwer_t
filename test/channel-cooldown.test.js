const { describe, it } = require('node:test');
const assert = require('node:assert');
const { Channel } = require('../src/channel');

// 验证 channel.maybeTriggerReinstall 在 cooldown 内的行为：
// - 第一次（lastIpRotationAt = 0）：真正触发 reinit
// - cooldown 内：跳过 reinit，只递增 dataLayerFailureCount
// - cooldown 后：再次触发 reinit

function createMockBrowser() {
  return {
    isConnected: () => true,
    async newContext() {
      const ctx = {
        closed: false,
        async addInitScript() {},
        async newPage() { return { closed: false, async close() {} }; },
        async close() { this.closed = true; },
      };
      ctx.browser = () => mock;
      const mock = { _ctx: ctx, isConnected: () => true, async close() {} };
      ctx.browser = () => mock;
      return ctx;
    },
  };
}

async function createInitializedChannel(options = {}) {
  const log = () => {};
  const channel = new Channel({
    id: 1,
    config: {
      dataLayerProxyRotationThreshold: 1,
      dataLayerFailureThreshold: 100,  // 不让 WARNING 干扰
      ...options,
    },
    log,
  });
  const browser = createMockBrowser();
  await channel.init(browser);
  return channel;
}

describe('Channel maybeTriggerReinstall cooldown gating', () => {
  it('triggers reinit when lastIpRotationAt is 0 (first failure)', async () => {
    const channel = await createInitializedChannel();
    let reinitCalls = 0;
    channel.reinit = async () => { reinitCalls++; };

    const didReinstall = await channel.maybeTriggerReinstall(30000);

    assert.strictEqual(didReinstall, true);
    assert.strictEqual(reinitCalls, 1);
    assert.ok(channel.lastIpRotationAt > 0);
  });

  it('skips reinit within cooldown window', async () => {
    const channel = await createInitializedChannel();
    let reinitCalls = 0;
    channel.reinit = async () => { reinitCalls++; };

    // 第一次：换 IP
    await channel.maybeTriggerReinstall(30000);
    assert.strictEqual(reinitCalls, 1);
    const firstRotationAt = channel.lastIpRotationAt;

    // 立即再触发：应在 cooldown 内，跳过
    const didReinstall = await channel.maybeTriggerReinstall(30000);

    assert.strictEqual(didReinstall, false);
    assert.strictEqual(reinitCalls, 1);  // 没增加
    assert.strictEqual(channel.lastIpRotationAt, firstRotationAt);  // 时间戳未更新
  });

  it('triggers reinit again after cooldown expires', async () => {
    const channel = await createInitializedChannel();
    let reinitCalls = 0;
    channel.reinit = async () => { reinitCalls++; };

    // 模拟第一次轮换
    await channel.maybeTriggerReinstall(30000);
    assert.strictEqual(reinitCalls, 1);

    // 手动回拨时间戳，模拟 cooldown 已过
    channel.lastIpRotationAt = Date.now() - 31000;

    const didReinstall = await channel.maybeTriggerReinstall(30000);
    assert.strictEqual(didReinstall, true);
    assert.strictEqual(reinitCalls, 2);
  });
});

describe('Channel DATA_LAYER_* failure path honors cooldown', () => {
  it('first DATA_LAYER_NEVER_PUSHED triggers reinit and increments counter', async () => {
    const channel = await createInitializedChannel();
    let reinitCalls = 0;
    channel.reinit = async () => { reinitCalls++; };
    channel.pageCrawler.crawlSingleSku = async () => {
      throw new Error('DATA_LAYER_NEVER_PUSHED');
    };

    await channel.crawl({ sku: 'A', crawlerTaskId: 1 });

    assert.strictEqual(channel.dataLayerFailureCount, 1);
    assert.strictEqual(reinitCalls, 1);
  });

  it('second DATA_LAYER_NEVER_PUSHED within cooldown does NOT reinit', async () => {
    const channel = await createInitializedChannel();
    let reinitCalls = 0;
    channel.reinit = async () => { reinitCalls++; };
    channel.pageCrawler.crawlSingleSku = async () => {
      throw new Error('DATA_LAYER_NEVER_PUSHED');
    };

    await channel.crawl({ sku: 'A', crawlerTaskId: 1 });
    await channel.crawl({ sku: 'B', crawlerTaskId: 2 });

    // 失败 2 次但只在第一次触发 reinstall
    assert.strictEqual(channel.dataLayerFailureCount, 2);
    assert.strictEqual(reinitCalls, 1);
  });
});

describe('Channel recordIpRotation updates lastIpRotationAt', () => {
  it('updates lastIpRotationAt when called', async () => {
    const channel = await createInitializedChannel();
    channel.recordIpRotation();
    assert.ok(channel.lastIpRotationAt > 0);
  });
});