const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { CrawlerService } = require('../src/service');

// This test file locks in the contract: the /health endpoint must reflect the
// real channel health by calling channel.isHealthy() — not by reading the dead
// `channel.healthy` field, which is never assigned and would always report false.
//
// See commit message for the bug context.

describe('CrawlerService /health reflects channel.isHealthy()', { timeout: 30000 }, () => {
  let service;
  let healthPort;

  async function fetchHealth(port) {
    return new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
    });
  }

  before(async () => {
    service = new CrawlerService({
      nodeCode: 'test-node-ishealthy',
      nodeToken: '',
      taskUrl: 'http://127.0.0.1:1/tasks',
      callbackUrl: 'http://127.0.0.1:1/callback',
      channels: 1,
      imageDir: '/tmp/test-health-ishealthy',
      healthPort: 0,
    });
    service.ensureImageDir();
    await service.startHealthServer();
    healthPort = service.healthServer.address().port;
  });

  after(async () => {
    try { await service.stop(); } catch (e) {}
  });

  it('reports healthy=true when channel.isHealthy() resolves true', async () => {
    // Stub minimal dependencies required by the health handler.
    service.browser = { isConnected: () => true };
    service.worker = { taskQueue: [], channels: [] };
    service.channels = [
      { id: 1, isHealthy: async () => true, busy: false },
    ];
    service.proxyPool = null;
    service.config.proxy = 'http://user:pass@proxy.example.com:8080';

    const res = await fetchHealth(healthPort);
    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    assert.strictEqual(json.channels.length, 1);
    assert.strictEqual(json.channels[0].id, 1);
    assert.strictEqual(json.channels[0].healthy, true,
      'healthy must be true when channel.isHealthy() resolves true (was using dead c.healthy field)');
  });

  it('reports healthy=false when channel.isHealthy() resolves false', async () => {
    service.browser = { isConnected: () => true };
    service.worker = { taskQueue: [], channels: [] };
    service.channels = [
      { id: 1, isHealthy: async () => false, busy: false },
    ];
    service.proxyPool = null;
    service.config.proxy = 'http://user:pass@proxy.example.com:8080';

    const res = await fetchHealth(healthPort);
    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    assert.strictEqual(json.channels[0].healthy, false,
      'healthy must be false when channel.isHealthy() resolves false');
  });

  it('awaits all channel isHealthy() checks via Promise.all', async () => {
    service.browser = { isConnected: () => true };
    service.worker = { taskQueue: [], channels: [] };

    // Both channels resolve after a delay; we must observe both completed values
    // in the response. If Promise.all is missing (e.g. .map(async) without await),
    // one of the channels would appear as undefined and the test would fail.
    service.channels = [
      { id: 1, isHealthy: async () => {
        await new Promise(r => setTimeout(r, 20));
        return true;
      }, busy: false },
      { id: 2, isHealthy: async () => {
        await new Promise(r => setTimeout(r, 20));
        return false;
      }, busy: false },
    ];
    service.proxyPool = null;
    service.config.proxy = null;

    const res = await fetchHealth(healthPort);
    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    assert.strictEqual(json.channels.length, 2);
    assert.strictEqual(json.channels[0].healthy, true);
    assert.strictEqual(json.channels[1].healthy, false);
  });

  it('preserves proxy masking and other channel fields', async () => {
    service.browser = { isConnected: () => true };
    service.worker = { taskQueue: [], channels: [] };
    service.channels = [
      { id: 1, isHealthy: async () => true, busy: false },
    ];
    service.proxyPool = {
      getProxyForChannel: (cid) => `http://u:p@proxy-for-${cid}.example.com:8080`,
    };

    const res = await fetchHealth(healthPort);
    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    assert.strictEqual(json.channels.length, 1);
    // proxy must be present, masked (no user:pass leak), and tied to channel id
    assert.ok(json.channels[0].proxy, 'proxy field must be present');
    assert.ok(!json.channels[0].proxy.includes('u:p'),
      'proxy must be masked (no credentials in URL)');
    assert.ok(json.channels[0].proxy.includes('ch-1'),
      'proxy must resolve from proxyPool for the channel id');
    assert.strictEqual(json.channels[0].healthy, true);
  });

});
