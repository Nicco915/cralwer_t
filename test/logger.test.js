const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createLogger } = require('../src/logger');

describe('Logger', () => {
  it('formats log as JSON line', () => {
    const logs = [];
    const logger = createLogger({
      nodeCode: 'test-node',
      write: (line) => logs.push(line),
    });

    logger.info('service', 'started', { channel: 1 });

    assert.strictEqual(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assert.strictEqual(parsed.level, 'INFO');
    assert.strictEqual(parsed.component, 'service');
    assert.strictEqual(parsed.msg, 'started');
    assert.strictEqual(parsed.nodeCode, 'test-node');
    assert.strictEqual(parsed.channel, 1);
    assert.ok(parsed.time);
  });

  it('supports warn and error levels', () => {
    const logs = [];
    const logger = createLogger({
      nodeCode: 'test-node',
      write: (line) => logs.push(line),
    });

    logger.warn('channel', 'proxy rotation');
    logger.error('service', 'browser launch failed', { error: 'timeout' });

    assert.strictEqual(JSON.parse(logs[0]).level, 'WARN');
    assert.strictEqual(JSON.parse(logs[1]).level, 'ERROR');
  });

  it('does not let extra override core fields', () => {
    const logs = [];
    const logger = createLogger({
      nodeCode: 'test-node',
      write: (line) => logs.push(line),
    });

    logger.info('service', 'started', { level: 'FAKE', nodeCode: 'spoofed', time: '1970' });

    const parsed = JSON.parse(logs[0]);
    assert.strictEqual(parsed.level, 'INFO');
    assert.strictEqual(parsed.nodeCode, 'test-node');
    assert.notStrictEqual(parsed.time, '1970');
  });

  it('handles circular extra objects', () => {
    const logs = [];
    const logger = createLogger({
      nodeCode: 'test-node',
      write: (line) => logs.push(line),
    });

    const extra = { a: 1 };
    extra.self = extra;
    logger.info('service', 'circular', extra);

    const parsed = JSON.parse(logs[0]);
    assert.strictEqual(parsed.msg, 'circular');
    assert.strictEqual(parsed.self.self, '[Circular]');
  });
});
