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

describe('Service integration', { timeout: 120000 }, () => {
  it('polls tasks, crawls, and calls back with failure for missing SKU', async () => {
    let callbackReceived = null;
    let service = null;

    const { server, port, getCallbacks } = await startMockUpstream({
      tasks: [{ crawlerTaskId: 999, sku: 'DEFINITELY-NOT-A-REAL-SKU-12345' }],
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
      });

      // Wait for callback or timeout
      const start = Date.now();
      while (!callbackReceived && Date.now() - start < 90000) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      assert.ok(callbackReceived, 'callback was not received');
      assert.strictEqual(callbackReceived.crawlerTaskId, 999);
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
