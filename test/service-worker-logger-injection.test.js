const { describe, it } = require('node:test');
const assert = require('node:assert');
const { CrawlerService } = require('../src/service');
const { Worker } = require('../src/worker');

describe('CrawlerService passes logger to Worker', () => {
  it('Worker constructed with logger=svc.logger is the same instance', () => {
    const svc = new CrawlerService({
      nodeCode: 'inject',
      taskUrl: 'http://127.0.0.1:1/tasks',
      callbackUrl: 'http://127.0.0.1:1/callback',
      channels: 0,
      imageDir: '/tmp/inject-img',
      healthPort: 0,
    });
    svc.ensureImageDir();
    svc.worker = new Worker({
      pusher: { push: async () => {} },
      log: svc.log.bind(svc),
      logger: svc.logger,
    });
    assert.strictEqual(svc.worker.logger, svc.logger);
  });

  it('start() injects svc.logger into the worker', async () => {
    const svc = new CrawlerService({
      nodeCode: 'inject-prod',
      taskUrl: 'http://127.0.0.1:1/tasks',
      callbackUrl: 'http://127.0.0.1:1/callback',
      channels: 0,
      imageDir: '/tmp/inject-prod-img',
      healthPort: 0,
    });
    try {
      await svc.start();
      assert.ok(svc.worker, 'start() should construct a worker');
      assert.strictEqual(svc.worker.logger, svc.logger);
    } finally {
      svc.stop();
    }
  });
});