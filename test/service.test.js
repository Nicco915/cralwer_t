const { describe, it } = require('node:test');
const assert = require('node:assert');
const { CrawlerService } = require('../src/service');

const REFRESH_INTERVAL_MS = 1000;

function createService(logs) {
  const service = new CrawlerService({
    nodeCode: 'test-node',
    nodeToken: '',
    taskUrl: 'http://127.0.0.1:1/tasks',
    callbackUrl: 'http://127.0.0.1:1/callback',
    channels: 2,
    imageDir: '/tmp/test-service-images',
    proxyRefreshIntervalMs: REFRESH_INTERVAL_MS,
  });
  service.log = (...args) => logs.push(args.map(String).join(' '));
  return service;
}

function setupChannelsAndPool(service, { busy = [], urls } = {}) {
  const proxyUrls = { 'ch-1': 'http://u:p@1.1.1.1:8080', 'ch-2': 'http://u:p@2.2.2.2:8080', ...urls };
  const reinitCalls = [];
  const pool = {
    refreshCalls: 0,
    nextUrls: null,
    refresh: async () => {
      pool.refreshCalls++;
      if (pool.nextUrls) Object.assign(proxyUrls, pool.nextUrls);
      // 与真实 CliproxyPool.refresh() 一致：返回 assignments 对象而非数组
      return { ...proxyUrls };
    },
    getProxyForChannel: (id) => proxyUrls[id],
  };
  service.proxyPool = pool;
  service.channels = [1, 2].map((id) => ({
    id,
    busy: busy.includes(id),
    reinit: async (browser, proxy) => { reinitCalls.push({ id, proxy }); },
  }));
  return { pool, reinitCalls, proxyUrls };
}

describe('CrawlerService proxy refresh timer', () => {
  it('skips refresh tick while any channel is busy', async () => {
    const logs = [];
    const service = createService(logs);
    const { pool } = setupChannelsAndPool(service, { busy: [1] });
    service.lastProxyRefreshAt = Date.now();

    await service.refreshProxiesOnce();

    assert.strictEqual(pool.refreshCalls, 0, 'refresh must not run while a channel is busy');
    assert.ok(logs.some((m) => m.includes('skipped') && m.includes('1 channel')),
      `expected skip log with busy count, got: ${JSON.stringify(logs)}`);
  });

  it('forces refresh after more than 3 intervals skipped while busy', async () => {
    const logs = [];
    const service = createService(logs);
    const { pool } = setupChannelsAndPool(service, { busy: [1, 2] });
    service.lastProxyRefreshAt = Date.now() - 3 * REFRESH_INTERVAL_MS - 1;

    await service.refreshProxiesOnce();

    assert.strictEqual(pool.refreshCalls, 1, 'refresh must be forced after >3 intervals without success');
    assert.ok(logs.some((m) => m.includes('forced') && m.includes('2 busy')),
      `expected forced warn log with busy count, got: ${JSON.stringify(logs)}`);
  });

  it('does not force refresh at exactly 3 intervals elapsed while busy', async () => {
    const logs = [];
    const service = createService(logs);
    const { pool } = setupChannelsAndPool(service, { busy: [1] });
    service.lastProxyRefreshAt = Date.now() - 3 * REFRESH_INTERVAL_MS + 500;

    await service.refreshProxiesOnce();

    assert.strictEqual(pool.refreshCalls, 0);
  });

  it('reinitializes only channels whose proxy URL changed (refresh returns assignments object)', async () => {
    const logs = [];
    const service = createService(logs);
    const { pool, reinitCalls } = setupChannelsAndPool(service);
    pool.nextUrls = { 'ch-2': 'http://u:p@9.9.9.9:8080' };
    service.lastProxyRefreshAt = Date.now();

    await service.refreshProxiesOnce();

    assert.strictEqual(pool.refreshCalls, 1);
    assert.deepStrictEqual(reinitCalls, [{ id: 2, proxy: 'http://u:p@9.9.9.9:8080' }],
      'only the channel with a changed proxy URL should be reinitialized');
    assert.strictEqual(service.lastProxyRefreshAt !== null, true);
  });

  it('does not reinit any channel when refresh leaves URLs unchanged', async () => {
    const logs = [];
    const service = createService(logs);
    const { pool, reinitCalls } = setupChannelsAndPool(service);
    service.lastProxyRefreshAt = Date.now();

    await service.refreshProxiesOnce();

    assert.strictEqual(pool.refreshCalls, 1, 'refresh still runs on schedule when idle');
    assert.deepStrictEqual(reinitCalls, []);
    assert.ok(!logs.some((m) => m.includes('Reinitializing')));
  });
});
