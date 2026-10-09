const { describe, it } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { runService } = require('../src/service');

function startMockUpstream({ tasks = [] }) {
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
      resolve({ server, port });
    });
  });
}

describe('Service integration', { timeout: 30000 }, () => {
  // baseUrl 仅在 crawl 时使用；本测试不下发任务，channel init 只建 context/page，
  // 不会真正访问该地址。用不可达地址避免误触真实站点。
  it('reclaims idle channel page after idleReclaimMs (no tasks)', async () => {
    let service = null;
    const { server, port } = await startMockUpstream({ tasks: [] });
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      service = await runService({
        baseUrl: 'http://127.0.0.1:1',
        imageDir: './output/test-idle-reclaim',
        headless: true,
        nodeCode: 'idle-node',
        nodeToken: 'test-token',
        taskUrl: `${baseUrl}/tasks`,
        callbackUrl: `${baseUrl}/callback`,
        channels: 1,
        pollInterval: 1000,
        pollLimit: 1,
        pushRetries: 1,
        idleReclaimMs: 1500,
        idleReapIntervalMs: 500,
      });

      const ch = service.channels[0];
      const start = Date.now();
      while (!ch.page && Date.now() - start < 30000) {
        await new Promise((r) => setTimeout(r, 200));
      }
      assert.ok(ch.page, 'page initialized');

      await new Promise((r) => setTimeout(r, 4000));
      assert.ok(ch.page === null || ch.page.isClosed(), 'page should be reclaimed by idle reaper');
    } finally {
      if (service) await service.stop();
      server.close();
    }
  });
});
