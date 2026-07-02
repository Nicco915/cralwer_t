const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { CrawlerService } = require('../src/service');

describe('CrawlerService health endpoint', { timeout: 30000 }, () => {
  let service;
  let healthPort;

  before(async () => {
    healthPort = 0;
    service = new CrawlerService({
      nodeCode: 'test-node',
      nodeToken: '',
      taskUrl: 'http://127.0.0.1:1/tasks',
      callbackUrl: 'http://127.0.0.1:1/callback',
      channels: 1,
      imageDir: '/tmp/test-health-images',
      healthPort,
    });
    service.ensureImageDir();
    await service.startHealthServer();
    healthPort = service.healthServer.address().port;
  });

  after(async () => {
    try { await service.stop(); } catch (e) {}
  });

  it('exposes /health returning status ok', async () => {
    service.browser = { isConnected: () => true };

    const res = await new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${healthPort}/health`, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
    });

    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    assert.strictEqual(json.status, 'ok');
    assert.strictEqual(json.nodeCode, 'test-node');
    assert.ok('uptime' in json);
  });

  it('returns 503 when browser is not connected', async () => {
    await service.startHealthServer();
    const actualPort = service.healthServer.address().port;
    service.browser = { isConnected: () => false };

    const res = await new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${actualPort}/health`, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
    });

    assert.strictEqual(res.status, 503);
    const json = JSON.parse(res.body);
    assert.strictEqual(json.status, 'degraded');
    assert.strictEqual(json.browserConnected, false);
  });
});
