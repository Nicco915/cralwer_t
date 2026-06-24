const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const { CrawlerService } = require('../src/service');

test('service assigns different proxies per channel from pool', async () => {
  const assignmentsFile = path.join(os.tmpdir(), `svc-pool-${Date.now()}.json`);
  const proxies = ['1.1.1.1:8080', '2.2.2.2:8080'];
  const service = new CrawlerService({
    baseUrl: 'https://example.com',
    imageDir: path.join(os.tmpdir(), 'imgs'),
    headless: true,
    channels: 2,
    pollInterval: 10000,
    pollLimit: 10,
    pushRetries: 1,
    callbackUrl: 'http://localhost:9999/callback',
    nodeCode: 'test-node',
    nodeToken: '',
    taskUrl: 'http://localhost:9999/tasks',
    kuaidailiSecretId: 'sid',
    kuaidailiSecretKey: 'skey',
    proxyMachineIndex: 0,
    proxyMachineTotal: 1,
    proxyRefreshIntervalMs: 60000,
    proxyAssignmentsFile: assignmentsFile,
  });

  const fakeBrowser = {
    isConnected: () => true,
    close: async () => {},
    newContext: async (opts) => ({
      addInitScript: async () => {},
      newPage: async () => ({
        isClosed: () => false,
        evaluate: async () => document.title,
      }),
      close: async () => {},
    }),
  };
  service.initBrowser = async () => { service.browser = fakeBrowser; };
  service.worker = { addChannel: () => {}, stop: () => {}, drain: async () => {}, resetChannels: () => {}, start: () => {} };
  service.poller = { stop: () => {} };
  service.proxyPool = {
    assign: async () => ({ 'ch-1': proxies[0], 'ch-2': proxies[1] }),
    getProxyForChannel: (id) => ({ 'ch-1': proxies[0], 'ch-2': proxies[1] }[id]),
    refresh: async () => [],
    nextForChannel: async (id) => ({ 'ch-1': proxies[1], 'ch-2': proxies[0] }[id]),
  };

  await service.initBrowser();
  await service.initChannels();
  assert.strictEqual(service.channels.length, 2);
  assert.notStrictEqual(service.channels[0].config.proxy, service.channels[1].config.proxy);

  await service.stop();
});

test('service uses static proxy for all channels when configured', async () => {
  const service = new CrawlerService({
    baseUrl: 'https://example.com',
    imageDir: path.join(os.tmpdir(), 'imgs'),
    headless: true,
    channels: 2,
    pollInterval: 10000,
    pollLimit: 10,
    pushRetries: 1,
    callbackUrl: 'http://localhost:9999/callback',
    nodeCode: 'test-node',
    nodeToken: '',
    taskUrl: 'http://localhost:9999/tasks',
    proxy: 'http://static-proxy:8080',
  });

  const fakeBrowser = {
    isConnected: () => true,
    close: async () => {},
    newContext: async (opts) => ({
      addInitScript: async () => {},
      newPage: async () => ({
        isClosed: () => false,
        evaluate: async () => document.title,
      }),
      close: async () => {},
    }),
  };
  service.initBrowser = async () => { service.browser = fakeBrowser; };
  service.worker = { addChannel: () => {}, stop: () => {}, drain: async () => {}, resetChannels: () => {}, start: () => {} };
  service.poller = { stop: () => {} };

  await service.initBrowser();
  await service.initChannels();
  assert.strictEqual(service.channels[0].config.proxy, 'http://static-proxy:8080');
  assert.strictEqual(service.channels[1].config.proxy, 'http://static-proxy:8080');

  await service.stop();
});
