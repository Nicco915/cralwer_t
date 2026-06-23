const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { startStubServer } = require('./stub-server');

function request(options) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const data = body ? JSON.parse(body) : null;
          resolve({ status: res.statusCode, data });
        } catch {
          resolve({ status: res.statusCode, body });
        }
      });
    });
    req.on('error', reject);
    if (options.body) {
      req.write(JSON.stringify(options.body));
    }
    req.end();
  });
}

describe('Stub Server', () => {
  let server;
  let port;

  before(async () => {
    server = await startStubServer({ port: 0, taskCount: 5 });
    port = server.port;
  });

  after(() => {
    server.close();
  });

  it('responds to health check', async () => {
    const res = await request({ hostname: '127.0.0.1', port, path: '/health', method: 'GET' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.status, 'ok');
  });

  it('returns tasks via POST body per nodeCode', async () => {
    const res = await request({
      hostname: '127.0.0.1',
      port,
      path: '/renren-api/classify/open/crawler/tasks',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { nodeCode: 'node-a', nodeToken: 'token-a', limit: 10 },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.code, 0);
    assert.ok(Array.isArray(res.data.data));
    assert.strictEqual(res.data.data.length, 5);
    assert.ok(res.data.data[0].crawlerTaskId);
    assert.ok(res.data.data[0].sku);
  });

  it('records callbacks and exposes statistics', async () => {
    const callbackRes = await request({
      hostname: '127.0.0.1',
      port,
      path: '/renren-api/classify/open/crawler/callback',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { crawlerTaskId: 1, sku: 'SKU-001', nodeCode: 'node-a', success: true },
    });
    assert.strictEqual(callbackRes.status, 200);
    assert.strictEqual(callbackRes.data.code, 0);

    const statsRes = await request({
      hostname: '127.0.0.1',
      port,
      path: '/stats',
      method: 'GET',
    });
    assert.strictEqual(statsRes.status, 200);
    assert.strictEqual(statsRes.data.callbackCount, 1);
    assert.strictEqual(statsRes.data.uniqueCallbackCount, 1);
  });

  it('detects duplicate callbacks', async () => {
    for (let i = 0; i < 2; i++) {
      await request({
        hostname: '127.0.0.1',
        port,
        path: '/renren-api/classify/open/crawler/callback',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { crawlerTaskId: 2, sku: 'SKU-002', nodeCode: 'node-a', success: true },
      });
    }

    const statsRes = await request({
      hostname: '127.0.0.1',
      port,
      path: '/stats',
      method: 'GET',
    });
    assert.strictEqual(statsRes.data.callbackCount, 3);
    assert.strictEqual(statsRes.data.uniqueCallbackCount, 2);
  });

  it('returns search page with dataLayer for SKU', async () => {
    const res = await request({
      hostname: '127.0.0.1',
      port,
      path: '/s/SKU-001',
      method: 'GET',
    });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.includes('window.dataLayer'));
    assert.ok(res.body.includes('/p/SKU-001'));
    assert.ok(res.body.includes('SKU-001 Product Name'));
  });

  it('returns fake product page for SKU', async () => {
    const res = await request({
      hostname: '127.0.0.1',
      port,
      path: '/p/SKU-001',
      method: 'GET',
    });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.includes('SKU-001'));
    assert.ok(res.body.includes('Product Specification'));
  });
});
