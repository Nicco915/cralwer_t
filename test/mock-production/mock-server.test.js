const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const JSONbig = require('json-bigint')({ useNativeBigInt: true });
const { MockProductionServer } = require('./mock-server');
const { Poller } = require('../../src/poller');
const { Pusher } = require('../../src/pusher');

function request(options) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const data = body ? JSON.parse(body) : null;
          resolve({ status: res.statusCode, data, body });
        } catch {
          resolve({ status: res.statusCode, body });
        }
      });
    });
    req.on('error', reject);
    if (options.body) {
      req.write(JSONbig.stringify(options.body));
    }
    req.end();
  });
}

describe('Mock Production Server', { timeout: 30000 }, () => {
  let server;
  let port;

  before(async () => {
    server = new MockProductionServer({
      port: 0,
      host: '127.0.0.1',
      excelPath: path.resolve(__dirname, '../../mock_test/mocktest.xlsx'),
    });
    const info = await server.start();
    port = info.port;
  });

  after(async () => {
    await server.close();
  });

  it('loads SKUs from mock_test Excel and exposes health check', async () => {
    assert.ok(server.skus.length > 0, 'should load SKUs from Excel');

    const res = await request({ hostname: '127.0.0.1', port, path: '/health', method: 'GET' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.status, 'ok');
    assert.strictEqual(res.data.skuCount, server.skus.length);
  });

  it('returns production-format tasks via upstream query endpoint', async () => {
    const res = await request({
      hostname: '127.0.0.1',
      port,
      path: '/renren-api/classify/open/crawler/tasks',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { nodeCode: 'crawler-04', nodeToken: 'test-token', limit: 3 },
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.code, 0);
    assert.ok(Array.isArray(res.data.data));
    assert.strictEqual(res.data.data.length, 3);

    const task = res.data.data[0];
    assert.ok(task.id, 'task should have id');
    assert.ok(task.sku, 'task should have sku');
    assert.strictEqual(task.nodeCode, 'crawler-04');
    assert.strictEqual(task.status, 'CRAWLING');
    assert.ok(task.assignTime, 'task should have assignTime');
    assert.ok(task.createDate, 'task should have createDate');
    assert.ok(task.updateDate, 'task should have updateDate');
    assert.ok(task.startTime, 'task should have startTime');
    assert.strictEqual(task.errorMessage, null);
    assert.strictEqual(task.finishTime, null);
    assert.ok(task.goodsItemId, 'task should have goodsItemId');
    assert.ok(task.importTaskId, 'task should have importTaskId');
    assert.strictEqual(task.retryCount, 0);
    assert.ok(task.nodeId, 'task should have nodeId');
    assert.ok(task.creator, 'task should have creator');
    assert.ok(task.updater, 'task should have updater');
  });

  it('re-polls the same task until a callback is received', async () => {
    const first = await request({
      hostname: '127.0.0.1',
      port,
      path: '/renren-api/classify/open/crawler/tasks',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { nodeCode: 'crawler-04', limit: 2 },
    });
    assert.strictEqual(first.data.data.length, 2);
    const taskId = first.data.data[0].id;

    // Without a callback, the same task is returned again on the next poll.
    const second = await request({
      hostname: '127.0.0.1',
      port,
      path: '/renren-api/classify/open/crawler/tasks',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { nodeCode: 'crawler-04', limit: 2 },
    });
    assert.strictEqual(second.data.data.length, 2);
    const secondIds = second.data.data.map(t => t.id);
    assert.ok(secondIds.includes(taskId), 'un-callbacked task should be re-pollable');

    // After callback, the task is no longer returned.
    await request({
      hostname: '127.0.0.1',
      port,
      path: '/renren-api/classify/open/crawler/callback',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        crawlerTaskId: taskId,
        sku: first.data.data[0].sku,
        nodeCode: 'crawler-04',
        success: true,
      },
    });

    const third = await request({
      hostname: '127.0.0.1',
      port,
      path: '/renren-api/classify/open/crawler/tasks',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { nodeCode: 'crawler-04', limit: 2 },
    });
    const thirdIds = third.data.data.map(t => t.id);
    assert.ok(!thirdIds.includes(taskId), 'callbacked task should not be re-polled');
  });

  it('excludes callbacked tasks from subsequent polls', async () => {
    const srv = new MockProductionServer({
      port: 0,
      host: '127.0.0.1',
      excelPath: path.resolve(__dirname, '../../mock_test/mocktest.xlsx'),
    });
    const info = await srv.start();

    try {
      const tasksRes = await request({
        hostname: '127.0.0.1',
        port: info.port,
        path: '/renren-api/classify/open/crawler/tasks',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { nodeCode: 'crawler-04', limit: 5 },
      });
      assert.strictEqual(tasksRes.data.data.length, 5);

      // Complete all fetched tasks via callbacks.
      for (const task of tasksRes.data.data) {
        await request({
          hostname: '127.0.0.1',
          port: info.port,
          path: '/renren-api/classify/open/crawler/callback',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: {
            crawlerTaskId: task.id,
            sku: task.sku,
            nodeCode: 'crawler-04',
            success: true,
          },
        });
      }

      const stats = srv.getStats();
      assert.strictEqual(stats.completedCount, 5);

      // Next poll skips the 5 callbacked tasks and returns new ones.
      const next = await request({
        hostname: '127.0.0.1',
        port: info.port,
        path: '/renren-api/classify/open/crawler/tasks',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { nodeCode: 'crawler-04', limit: 10 },
      });
      assert.strictEqual(next.data.data.length, 10);
      const returnedIds = next.data.data.map(t => t.id);
      for (const task of tasksRes.data.data) {
        assert.ok(!returnedIds.includes(task.id), 'callbacked task should not be returned');
      }
    } finally {
      await srv.close();
    }
  });

  it('accepts downstream callback and records it', async () => {
    const callback = {
      crawlerTaskId: 2070310839139160065n,
      sku: 'TEST-SKU',
      nodeCode: 'crawler-04',
      nodeToken: 'test-token',
      goodsName: 'Product Name',
      goodsDesc: 'Description',
      sourceUrl: 'https://eur.vevor.com/p/TEST-SKU',
      rawContent: 'Specification',
      success: true,
      errorMessage: '',
    };

    const res = await request({
      hostname: '127.0.0.1',
      port,
      path: '/renren-api/classify/open/crawler/callback',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: callback,
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.code, 0);

    const stats = server.getStats();
    assert.ok(stats.callbackCount >= 1);
    const recorded = server.callbacks.find(cb => cb.sku === 'TEST-SKU');
    assert.ok(recorded);
    assert.strictEqual(recorded.success, true);
  });

  it('detects duplicate callbacks', async () => {
    const callback = {
      crawlerTaskId: 2070310839139160066n,
      sku: 'TEST-SKU-DUP',
      nodeCode: 'crawler-04',
      nodeToken: 'test-token',
      goodsName: 'Product',
      goodsDesc: 'Desc',
      sourceUrl: '',
      rawContent: '',
      success: false,
      errorMessage: 'not found',
    };

    for (let i = 0; i < 2; i++) {
      await request({
        hostname: '127.0.0.1',
        port,
        path: '/renren-api/classify/open/crawler/callback',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: callback,
      });
    }

    const stats = server.getStats();
    const recorded = server.callbacks.filter(cb => cb.sku === 'TEST-SKU-DUP');
    assert.strictEqual(recorded.length, 2);
    assert.ok(stats.duplicateCallbacks >= 1);
  });

  it('completes a task even when the callback reports failure', async () => {
    const tasks = await request({
      hostname: '127.0.0.1',
      port,
      path: '/renren-api/classify/open/crawler/tasks',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { nodeCode: 'crawler-04', limit: 1 },
    });
    const taskId = tasks.data.data[0].id;

    await request({
      hostname: '127.0.0.1',
      port,
      path: '/renren-api/classify/open/crawler/callback',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        crawlerTaskId: taskId,
        sku: tasks.data.data[0].sku,
        nodeCode: 'crawler-04',
        success: false,
        errorMessage: 'crawl failed',
      },
    });

    const next = await request({
      hostname: '127.0.0.1',
      port,
      path: '/renren-api/classify/open/crawler/tasks',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { nodeCode: 'crawler-04', limit: 1 },
    });

    const returnedIds = next.data.data.map(t => t.id);
    assert.ok(!returnedIds.includes(taskId), 'failed callback should still complete the task');
  });

  it('exposes stats endpoint with task and callback counts', async () => {
    const res = await request({
      hostname: '127.0.0.1',
      port,
      path: '/stats',
      method: 'GET',
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.code, 0);
    assert.ok(typeof res.data.totalTasks === 'number');
    assert.ok(typeof res.data.issuedCount === 'number');
    assert.ok(typeof res.data.callbackCount === 'number');
    assert.ok(typeof res.data.uniqueCallbackCount === 'number');
  });
});

describe('Mock Production Server with failure rate', { timeout: 30000 }, () => {
  it('rejects callbacks with configured probability', async () => {
    const srv = new MockProductionServer({
      port: 0,
      host: '127.0.0.1',
      excelPath: path.resolve(__dirname, '../../mock_test/mocktest.xlsx'),
      failureRate: 1,
    });
    const info = await srv.start();

    try {
      const res = await request({
        hostname: '127.0.0.1',
        port: info.port,
        path: '/renren-api/classify/open/crawler/callback',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: {
          crawlerTaskId: 1,
          sku: 'TEST',
          nodeCode: 'crawler-04',
          success: true,
        },
      });

      assert.strictEqual(res.status, 500);
    } finally {
      await srv.close();
    }
  });
});

describe('Mock Production Server with real Poller/Pusher', { timeout: 30000 }, () => {
  it('Poller can fetch tasks and Pusher can push results end-to-end', async () => {
    const srv = new MockProductionServer({
      port: 0,
      host: '127.0.0.1',
      excelPath: path.resolve(__dirname, '../../mock_test/mocktest.xlsx'),
    });
    const info = await srv.start();
    const baseUrl = `http://${info.host}:${info.port}`;

    try {
      const poller = new Poller({
        taskUrl: `${baseUrl}/renren-api/classify/open/crawler/tasks`,
        nodeCode: 'crawler-04',
        nodeToken: 'test-token',
        limit: 2,
      });

      const tasks = await poller.fetchTasks();
      assert.strictEqual(tasks.length, 2);
      assert.strictEqual(typeof tasks[0].crawlerTaskId, 'string');
      assert.ok(tasks[0].sku);

      const pusher = new Pusher({
        callbackUrl: `${baseUrl}/renren-api/classify/open/crawler/callback`,
        nodeCode: 'crawler-04',
        nodeToken: 'test-token',
      });

      await pusher.push({
        crawlerTaskId: tasks[0].crawlerTaskId,
        sku: tasks[0].sku,
        status: 'success',
        product_name: 'Mock Product',
        features_details: 'Mock features',
        product_specification: 'Mock specification',
        product_url: `https://eur.vevor.com/p/${tasks[0].sku}`,
        error: '',
      });

      const stats = srv.getStats();
      assert.strictEqual(stats.callbackCount, 1);
      assert.strictEqual(stats.uniqueCallbackCount, 1);
    } finally {
      await srv.close();
    }
  });
});
