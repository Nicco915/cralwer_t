const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const ExcelJS = require('exceljs');
const { DashboardServer } = require('./dashboard');

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
      req.write(options.body);
    }
    req.end();
  });
}

function buildMultipartBody(filename, buffer, boundary) {
  const prefix = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`;
  const suffix = `\r\n--${boundary}--\r\n`;
  return Buffer.concat([Buffer.from(prefix), buffer, Buffer.from(suffix)]);
}

describe('Dashboard Server', { timeout: 60000 }, () => {
  let dashboard;
  let port;
  let mockUrl = null;

  before(async () => {
    dashboard = new DashboardServer({ port: 0, host: '127.0.0.1' });
    const info = await dashboard.start();
    port = info.port;
  });

  after(async () => {
    await dashboard.stopUpstream();
    await dashboard.close();
  });

  async function ensureUpstream() {
    const status = await request({ hostname: '127.0.0.1', port, path: '/api/status', method: 'GET' });
    if (!status.data.upstreamRunning) {
      const start = await request({ hostname: '127.0.0.1', port, path: '/api/upstream/start', method: 'POST' });
      mockUrl = start.data.data.url;
    } else {
      mockUrl = status.data.upstreamUrl;
    }
  }

  it('serves the dashboard HTML page', async () => {
    const res = await request({ hostname: '127.0.0.1', port, path: '/', method: 'GET' });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.includes('模拟生产测试 Dashboard'));
  });

  it('starts and stops the upstream mock server via API', async () => {
    const start = await request({
      hostname: '127.0.0.1',
      port,
      path: '/api/upstream/start',
      method: 'POST',
    });
    assert.strictEqual(start.status, 200);
    assert.strictEqual(start.data.code, 0);
    assert.ok(start.data.data.url);
    mockUrl = start.data.data.url;

    const status = await request({ hostname: '127.0.0.1', port, path: '/api/status', method: 'GET' });
    assert.strictEqual(status.data.upstreamRunning, true);
    assert.ok(status.data.upstreamUrl);

    const stop = await request({ hostname: '127.0.0.1', port, path: '/api/upstream/stop', method: 'POST' });
    assert.strictEqual(stop.status, 200);

    const statusAfter = await request({ hostname: '127.0.0.1', port, path: '/api/status', method: 'GET' });
    assert.strictEqual(statusAfter.data.upstreamRunning, false);
  });

  it('adds tasks and lists them', async () => {
    await ensureUpstream();

    const add = await request({
      hostname: '127.0.0.1',
      port,
      path: '/api/tasks/add',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skus: ['SKU-A', 'SKU-B', 'SKU-C'] }),
    });
    assert.strictEqual(add.status, 200);
    assert.strictEqual(add.data.data.count, 3);

    const list = await request({ hostname: '127.0.0.1', port, path: '/api/tasks', method: 'GET' });
    assert.strictEqual(list.data.data.length, 3);
    assert.strictEqual(list.data.data[0].sku, 'SKU-A');
  });

  it('uploads Excel file to set tasks', async () => {
    await ensureUpstream();

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Test');
    worksheet.addRow(['SKU']);
    worksheet.addRow(['EXCEL-001']);
    worksheet.addRow(['EXCEL-002']);
    const buffer = await workbook.xlsx.writeBuffer();

    const boundary = '----DashboardTestBoundary';
    const body = buildMultipartBody('test.xlsx', Buffer.from(buffer), boundary);

    const upload = await request({
      hostname: '127.0.0.1',
      port,
      path: '/api/tasks/upload',
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    assert.strictEqual(upload.status, 200);
    assert.strictEqual(upload.data.data.count, 2);

    const list = await request({ hostname: '127.0.0.1', port, path: '/api/tasks', method: 'GET' });
    assert.strictEqual(list.data.data.length, 2);
    assert.strictEqual(list.data.data[0].sku, 'EXCEL-001');
  });

  it('receives callbacks and exposes them via /api/callbacks', async () => {
    await ensureUpstream();
    await request({
      hostname: '127.0.0.1',
      port,
      path: '/api/tasks/add',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skus: ['CALLBACK-TEST'] }),
    });

    const list = await request({ hostname: '127.0.0.1', port, path: '/api/tasks', method: 'GET' });
    const taskId = list.data.data[0].id;

    const parsed = new URL('/renren-api/classify/open/crawler/callback', mockUrl);
    await request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        crawlerTaskId: taskId,
        sku: 'CALLBACK-TEST',
        nodeCode: 'crawler-04',
        success: true,
        goodsName: 'Test',
      }),
    });

    const callbacks = await request({ hostname: '127.0.0.1', port, path: '/api/callbacks', method: 'GET' });
    assert.ok(callbacks.data.data.length >= 1);
    assert.strictEqual(callbacks.data.data[0].callback.crawlerTaskId, taskId);
  });

  it('streams callback events to SSE clients', async () => {
    await ensureUpstream();
    await request({
      hostname: '127.0.0.1',
      port,
      path: '/api/tasks/add',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skus: ['SSE-TEST'] }),
    });

    const tasks = await request({ hostname: '127.0.0.1', port, path: '/api/tasks', method: 'GET' });
    const taskId = tasks.data.data[0].id;

    const ssePromise = new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/api/callbacks/stream',
        method: 'GET',
      }, (res) => {
        let buffer = '';
        res.on('data', (chunk) => {
          buffer += chunk.toString();
          const match = buffer.match(/data: (.+)/);
          if (match) {
            try {
              const record = JSON.parse(match[1]);
              if (record.callback && record.callback.crawlerTaskId === taskId) {
                resolve(record);
              }
            } catch (e) {}
          }
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
      setTimeout(() => reject(new Error('SSE timeout')), 10000);
    });

    await new Promise(r => setTimeout(r, 200));

    const parsed = new URL('/renren-api/classify/open/crawler/callback', mockUrl);
    await request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        crawlerTaskId: taskId,
        sku: 'SSE-TEST',
        nodeCode: 'crawler-04',
        success: true,
      }),
    });

    const record = await ssePromise;
    assert.strictEqual(record.callback.sku, 'SSE-TEST');
  });

  it('passes crawler env vars via exec options instead of inline shell syntax', async () => {
    const calls = [];
    const fakeExec = async (cmd, options) => {
      calls.push({ cmd, options });
      return { stdout: '[PM2] Done', stderr: '' };
    };

    const dash = new DashboardServer({ port: 0, host: '127.0.0.1', execAsync: fakeExec });
    const info = await dash.start();

    const upstream = await request({
      hostname: '127.0.0.1',
      port: info.port,
      path: '/api/upstream/start',
      method: 'POST',
    });
    const mockUrl = upstream.data.data.url;

    const res = await request({
      hostname: '127.0.0.1',
      port: info.port,
      path: '/api/crawler/start',
      method: 'POST',
    });
    assert.strictEqual(res.status, 200);

    const startCall = calls.find(c => c.cmd.startsWith('pm2 start'));
    assert.ok(startCall, 'expected a pm2 start call');
    assert.ok(
      !startCall.cmd.includes('CRAWLER_MODE='),
      'command must not use inline env var syntax, which fails on Windows cmd'
    );
    assert.strictEqual(startCall.options.env.CRAWLER_MODE, 'service');
    assert.strictEqual(startCall.options.env.CRAWLER_NODE_CODE, 'crawler-dashboard-test');
    assert.strictEqual(startCall.options.env.CRAWLER_TASK_URL, `${mockUrl}/renren-api/classify/open/crawler/tasks`);
    assert.strictEqual(startCall.options.env.CRAWLER_CALLBACK_URL, `${mockUrl}/renren-api/classify/open/crawler/callback`);

    await dash.stopUpstream();
    await dash.close();
  });
});
