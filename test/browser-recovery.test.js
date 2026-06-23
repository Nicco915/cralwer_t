const { describe, it } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { runService } = require('../src/service');

function startMockUpstream({ tasks = [], onCallback }) {
  const callbacks = [];
  let returnedTasks = false;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      if (req.url.startsWith('/tasks') && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (!returnedTasks) {
          returnedTasks = true;
          res.end(JSON.stringify({ code: 0, data: tasks }));
        } else {
          res.end(JSON.stringify({ code: 0, data: [] }));
        }
        return;
      }
      if (req.url === '/callback' && req.method === 'POST') {
        const parsed = JSON.parse(body || '{}');
        callbacks.push(parsed);
        if (onCallback) onCallback(parsed);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 0 }));
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, getCallbacks: () => callbacks });
    });
  });
}

describe('Browser crash recovery', { timeout: 120000 }, () => {
  it('restarts browser and channels after browser process is killed, then completes a new task', async () => {
    let callbackReceived = null;
    let service = null;

    const { server, port, getCallbacks } = await startMockUpstream({
      tasks: [{ crawlerTaskId: 1001, sku: 'DEFINITELY-NOT-A-REAL-SKU-12345' }],
      onCallback: (cb) => {
        callbackReceived = cb;
      },
    });

    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      service = await runService({
        baseUrl: 'https://eur.vevor.com',
        imageDir: './output/test-service-images',
        headless: true,
        nodeCode: 'test-node',
        nodeToken: 'test-token',
        taskUrl: `${baseUrl}/tasks`,
        callbackUrl: `${baseUrl}/callback`,
        channels: 1,
        pollInterval: 1000,
        pollLimit: 1,
        pushRetries: 1,
        browserHealthCheckInterval: 2000,
      });

      // Wait for first callback or timeout
      const start = Date.now();
      while (!callbackReceived && Date.now() - start < 30000) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      assert.ok(callbackReceived, 'first callback was not received');
      assert.strictEqual(callbackReceived.crawlerTaskId, 1001);

      // Reset callback
      callbackReceived = null;

      // Simulate browser crash by closing it abruptly
      assert.ok(service.browser, 'browser should exist');
      assert.ok(service.browser.isConnected(), 'browser should be connected');
      await service.browser.close();

      // Wait for health check to detect and restart
      const restartStart = Date.now();
      while ((!service.browser || !service.browser.isConnected()) && Date.now() - restartStart < 30000) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      assert.ok(service.browser && service.browser.isConnected(), 'browser should be restarted and connected');

      // Push a new task manually via worker
      service.worker.pushTasks([{ crawlerTaskId: 1002, sku: 'DEFINITELY-NOT-A-REAL-SKU-12345' }]);

      // Wait for second callback
      const secondStart = Date.now();
      while (!callbackReceived && Date.now() - secondStart < 60000) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      assert.ok(callbackReceived, 'second callback after browser restart was not received');
      assert.strictEqual(callbackReceived.crawlerTaskId, 1002);
      assert.strictEqual(callbackReceived.sku, 'DEFINITELY-NOT-A-REAL-SKU-12345');
      assert.strictEqual(callbackReceived.nodeCode, 'test-node');
      assert.strictEqual(callbackReceived.nodeToken, 'test-token');
      assert.strictEqual(callbackReceived.success, false);
      assert.ok(callbackReceived.errorMessage && callbackReceived.errorMessage.length > 0);
    } finally {
      if (service) {
        await service.stop();
      }
      server.close();
    }
  });
});
