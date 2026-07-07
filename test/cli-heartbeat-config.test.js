const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const { parse } = require('../src/cli');

describe('cli heartbeat config', () => {
  afterEach(() => {
    delete process.env.CRAWLER_HEARTBEAT_INTERVAL;
  });

  it('CLI flag --heartbeat-interval maps to heartbeatInterval (seconds)', () => {
    const config = parse(['--heartbeat-interval', '45']);
    assert.strictEqual(config.heartbeatInterval, 45);
  });

  it('env var CRAWLER_HEARTBEAT_INTERVAL maps to heartbeatInterval when flag missing', () => {
    process.env.CRAWLER_HEARTBEAT_INTERVAL = '90';
    const config = parse([]);
    assert.strictEqual(config.heartbeatInterval, 90);
  });

  it('CLI flag overrides env var', () => {
    process.env.CRAWLER_HEARTBEAT_INTERVAL = '90';
    const config = parse(['--heartbeat-interval', '10']);
    assert.strictEqual(config.heartbeatInterval, 10);
  });

  it('omitted both flag and env yields undefined heartbeatInterval', () => {
    const config = parse([]);
    assert.strictEqual(config.heartbeatInterval, undefined);
  });
});
