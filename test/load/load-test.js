const { describe, it } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { startStubServer } = require('../fixtures/stub-server');
const { runService } = require('../../src/service');

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

describe('Load test', { timeout: 180000 }, () => {
  it('processes all stub tasks without duplicates using 4 channels', async () => {
    const taskCount = 12;
    const stub = await startStubServer({ port: 0, taskCount });
    const baseUrl = `http://127.0.0.1:${stub.port}`;
    let service;

    try {
      service = await runService({
        baseUrl,
        imageDir: './output/test-load-images',
        headless: true,
        nodeCode: 'load-test-node',
        nodeToken: 'load-token',
        taskUrl: `${baseUrl}/renren-api/classify/open/crawler/tasks`,
        callbackUrl: `${baseUrl}/renren-api/classify/open/crawler/callback`,
        channels: 4,
        pollInterval: 1000,
        pollLimit: 12,
        pushRetries: 2,
        minDelay: 0,
        maxDelay: 0,
      });

      const statsUrl = `${baseUrl}/stats`;
      const start = Date.now();
      let stats;
      while (Date.now() - start < 120000) {
        stats = await getJson(statsUrl);
        if (stats.uniqueCallbackCount >= taskCount) break;
        await new Promise(r => setTimeout(r, 1000));
      }

      assert.ok(stats, 'stats should be available');
      assert.strictEqual(stats.uniqueCallbackCount, taskCount, `expected ${taskCount} unique callbacks, got ${stats.uniqueCallbackCount}`);
      assert.strictEqual(stats.callbackCount, taskCount, `expected no duplicate callbacks, got ${stats.callbackCount} total`);
      assert.strictEqual(stats.duplicateCallbacks, 0, 'expected zero duplicate callbacks');
      assert.strictEqual(stats.successCallbacks, taskCount, `expected ${taskCount} successful callbacks, got ${stats.successCallbacks}`);
      assert.strictEqual(stats.failedCallbacks, 0, 'expected zero failed callbacks');
    } finally {
      if (service) {
        await service.stop();
      }
      await stub.close();
    }
  });
});
