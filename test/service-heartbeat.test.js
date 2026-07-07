const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { CrawlerService } = require('../src/service');

const TMP = path.resolve(__dirname, '.tmp/heartbeat');

describe('CrawlerService heartbeat', { timeout: 30000 }, () => {
  before(() => fs.mkdirSync(TMP, { recursive: true }));
  after(() => fs.rmSync(TMP, { recursive: true, force: true }));

  it('emits a heartbeat JSON line within heartbeatInterval * 1.5 seconds', async () => {
    const lines = [];
    const { createStdoutLogger } = require('../src/logger');
    const svc = new CrawlerService({
      nodeCode: 'hb-node',
      nodeToken: '',
      taskUrl: 'http://127.0.0.1:1/tasks',
      callbackUrl: 'http://127.0.0.1:1/callback',
      channels: 0,
      imageDir: '/tmp/hb-img',
      healthPort: 0,
      heartbeatInterval: 0.2,
    });
    // Replace default logger with one capturing to local lines[]
    svc.logger = createStdoutLogger({ nodeCode: 'hb-node', write: l => lines.push(l) });

    svc.startHeartbeat();
    await new Promise(r => setTimeout(r, 350));
    svc.stopHeartbeat();

    const hb = lines.map(l => JSON.parse(l)).find(e => e.component === 'heartbeat');
    assert.ok(hb, 'should emit heartbeat log');
    assert.strictEqual(hb.nodeCode, 'hb-node');
    assert.ok(typeof hb.uptime === 'number');
    assert.strictEqual(hb.channels, 0);
  });

  it('startHeartbeat is idempotent (second call does not start a new timer)', () => {
    const svc = new CrawlerService({
      nodeCode: 'hb-node-2', nodeToken: '',
      taskUrl: 'http://127.0.0.1:1/tasks',
      callbackUrl: 'http://127.0.0.1:1/callback',
      channels: 0, imageDir: '/tmp/hb-img2', healthPort: 0,
      heartbeatInterval: 60,
    });
    svc.startHeartbeat();
    const first = svc.heartbeatTimer;
    svc.startHeartbeat();
    assert.strictEqual(svc.heartbeatTimer, first);
    svc.stopHeartbeat();
  });

  it('stopHeartbeat clears the timer', () => {
    const svc = new CrawlerService({
      nodeCode: 'hb-node-3', nodeToken: '',
      taskUrl: 'http://127.0.0.1:1/tasks',
      callbackUrl: 'http://127.0.0.1:1/callback',
      channels: 0, imageDir: '/tmp/hb-img3', healthPort: 0,
      heartbeatInterval: 60,
    });
    svc.startHeartbeat();
    svc.stopHeartbeat();
    assert.strictEqual(svc.heartbeatTimer, null);
  });
});
