const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createLogger, createStdoutLogger, createBroadcastLogger } = require('../src/logger');

function createMockLogger() {
  const records = [];
  return {
    records,
    info: (c, m, e) => records.push({ level: 'INFO', component: c, msg: m, ...(e || {}) }),
    warn: (c, m, e) => records.push({ level: 'WARN', component: c, msg: m, ...(e || {}) }),
    error: (c, m, e) => records.push({ level: 'ERROR', component: c, msg: m, ...(e || {}) }),
  };
}

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

describe('createStdoutLogger / createBroadcastLogger', () => {
  it('createStdoutLogger writes JSON line to a custom write function', () => {
    const lines = [];
    const logger = createStdoutLogger({
      nodeCode: 'test-node',
      write: (line) => lines.push(line),
    });
    logger.info('comp', 'hello', { foo: 'bar' });
    assert.strictEqual(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.strictEqual(entry.level, 'INFO');
    assert.strictEqual(entry.component, 'comp');
    assert.strictEqual(entry.msg, 'hello');
    assert.strictEqual(entry.nodeCode, 'test-node');
    assert.strictEqual(entry.foo, 'bar');
  });

  it('createBroadcastLogger fans out to all underlying loggers', () => {
    const a = createMockLogger();
    const b = createMockLogger();
    const logger = createBroadcastLogger([a, b]);
    logger.warn('comp', 'ohno', { x: 1 });
    assert.strictEqual(a.records.length, 1);
    assert.strictEqual(b.records.length, 1);
    assert.deepStrictEqual(a.records[0], b.records[0]);
  });

  it('createBroadcastLogger swallows errors from one underlying logger', () => {
    const failing = { info: () => { throw new Error('boom'); }, warn: () => { throw new Error('boom'); }, error: () => { throw new Error('boom'); } };
    const ok = createMockLogger();
    const logger = createBroadcastLogger([failing, ok]);
    assert.doesNotThrow(() => logger.info('comp', 'x'));
    assert.strictEqual(ok.records.length, 1);
  });
});
