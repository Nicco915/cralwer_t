const { describe, it } = require('node:test');
const assert = require('node:assert');
const { CrawlerService } = require('../src/service');

function makeFakeChannel({ id = 1, idle = false, busy = false, reinitializing = false } = {}) {
  return {
    id,
    busy,
    reinitializing,
    closed: false,
    lastActivityAt: Date.now() - 600000,
    isIdleReclaimable() {
      return idle && !this.busy && !this.reinitializing;
    },
    async close() {
      this.closed = true;
    },
  };
}

describe('CrawlerService idle reaper', () => {
  it('reapOnce closes idle-reclaimable channels and resets reinitializing', async () => {
    const svc = new CrawlerService({ nodeCode: 't' });
    svc.config.idleReclaimMs = 300000;
    const c1 = makeFakeChannel({ id: 1, idle: true });
    const c2 = makeFakeChannel({ id: 2, idle: false });
    svc.channels = [c1, c2];

    await svc.reapOnce();
    assert.strictEqual(c1.closed, true);
    assert.strictEqual(c2.closed, false);
    assert.strictEqual(c1.reinitializing, false, 'reinitializing reset after close');
  });

  it('reapOnce skips busy and reinitializing channels', async () => {
    const svc = new CrawlerService({ nodeCode: 't' });
    svc.config.idleReclaimMs = 300000;
    const busy = makeFakeChannel({ id: 1, idle: true, busy: true });
    const reinit = makeFakeChannel({ id: 2, idle: true, reinitializing: true });
    svc.channels = [busy, reinit];

    await svc.reapOnce();
    assert.strictEqual(busy.closed, false);
    assert.strictEqual(reinit.closed, false);
  });

  it('reapOnce sets reinitializing=true during close', async () => {
    const svc = new CrawlerService({ nodeCode: 't' });
    svc.config.idleReclaimMs = 300000;
    let seenReinitDuringClose = false;
    const c = {
      id: 1,
      busy: false,
      reinitializing: false,
      closed: false,
      lastActivityAt: Date.now() - 600000,
      isIdleReclaimable() { return !this.reinitializing && !this.busy; },
      async close() { seenReinitDuringClose = this.reinitializing; this.closed = true; },
    };
    svc.channels = [c];

    await svc.reapOnce();
    assert.strictEqual(seenReinitDuringClose, true, 'reinitializing true while closing');
    assert.strictEqual(c.reinitializing, false);
  });

  it('startIdleReaper is disabled when idleReclaimMs <= 0', () => {
    const svc = new CrawlerService({ nodeCode: 't', idleReclaimMs: 0 });
    svc.startIdleReaper();
    assert.strictEqual(svc.idleReapTimer, null);
  });

  it('startIdleReaper sets timer and stopIdleReaper clears it', () => {
    const svc = new CrawlerService({ nodeCode: 't', idleReclaimMs: 300000, idleReapIntervalMs: 100000 });
    svc.startIdleReaper();
    assert.ok(svc.idleReapTimer, 'timer should be set');
    svc.stopIdleReaper();
    assert.strictEqual(svc.idleReapTimer, null);
  });

  it('config defaults: idleReclaimMs=300000, idleReapIntervalMs=30000', () => {
    const svc = new CrawlerService({ nodeCode: 't' });
    assert.strictEqual(svc.config.idleReclaimMs, 300000);
    assert.strictEqual(svc.config.idleReapIntervalMs, 30000);
  });

  it('config honors explicit idleReclaimMs=0 (disabled, not defaulted)', () => {
    const svc = new CrawlerService({ nodeCode: 't', idleReclaimMs: 0 });
    assert.strictEqual(svc.config.idleReclaimMs, 0);
  });
});
