const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLogger, createFileLogger, createStdoutLogger, createBroadcastLogger, cleanupRotatedLogs } = require('../src/logger');

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

  it('serializes BigInt extra fields instead of dropping the log line', () => {
    const logs = [];
    const logger = createLogger({
      nodeCode: 'test-node',
      write: (line) => logs.push(line),
    });

    // poller.js 把数值型任务 id 转成原生 BigInt（防精度丢失），
    // 普通 JSON.stringify 遇到 BigInt 会抛 "Do not know how to serialize a BigInt"
    logger.info('task', 'finished', { crawlerTaskId: BigInt('2079038831085428737'), retries: 1 });

    assert.strictEqual(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assert.strictEqual(parsed.crawlerTaskId, '2079038831085428737');
    assert.strictEqual(parsed.retries, 1);
  });

  it('serializes small BigInt values as numbers', () => {
    const logs = [];
    const logger = createLogger({
      nodeCode: 'test-node',
      write: (line) => logs.push(line),
    });

    logger.info('task', 'finished', { crawlerTaskId: BigInt(1001) });

    const parsed = JSON.parse(logs[0]);
    assert.strictEqual(parsed.crawlerTaskId, 1001);
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

describe('createFileLogger rotation', () => {
  function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-log-test-'));
  }

  it('rotates crawler.jsonl when size exceeds maxBytes', () => {
    const dir = makeTempDir();
    const logger = createFileLogger({ nodeCode: 'test-node', logDir: dir, maxBytes: 200, retentionDays: 7 });

    // 每行约 100+ 字节，写几行必然超过 200 字节上限
    for (let i = 0; i < 5; i++) {
      logger.info('comp', `line-${i}`, { payload: 'x'.repeat(50) });
    }

    const files = fs.readdirSync(dir);
    const rotated = files.filter((f) => /^crawler-\d{8}-\d{6}(-\d+)?\.jsonl$/.test(f));
    assert.ok(rotated.length >= 1, `expected rotated files, got: ${files.join(',')}`);
    // 当前文件仍在继续写入
    assert.ok(files.includes('crawler.jsonl'));
    const currentSize = fs.statSync(path.join(dir, 'crawler.jsonl')).size;
    assert.ok(currentSize > 0 && currentSize <= 400, `current log size ${currentSize} should stay small after rotation`);
  });

  it('continues byte counting across restarts (existing file size is honored)', () => {
    const dir = makeTempDir();
    // 模拟重启前已存在的 150 字节日志
    fs.writeFileSync(path.join(dir, 'crawler.jsonl'), 'x'.repeat(150));

    const logger = createFileLogger({ nodeCode: 'test-node', logDir: dir, maxBytes: 200, retentionDays: 7 });
    logger.info('comp', 'after restart', { payload: 'y'.repeat(50) });

    const files = fs.readdirSync(dir);
    const rotated = files.filter((f) => /^crawler-\d{8}-\d{6}(-\d+)?\.jsonl$/.test(f));
    assert.strictEqual(rotated.length, 1, 'should rotate immediately because pre-existing file already near limit');
  });

  it('cleanupRotatedLogs deletes rotated files older than retentionDays', () => {
    const dir = makeTempDir();
    const oldFile = path.join(dir, 'crawler-20200101-000000.jsonl');
    const newFile = path.join(dir, 'crawler-20990101-000000.jsonl');
    const currentFile = path.join(dir, 'crawler.jsonl');
    fs.writeFileSync(oldFile, 'old');
    fs.writeFileSync(newFile, 'new');
    fs.writeFileSync(currentFile, 'current');
    // 把 oldFile 的 mtime 改成 30 天前
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldFile, thirtyDaysAgo, thirtyDaysAgo);

    cleanupRotatedLogs(dir, 7);

    assert.ok(!fs.existsSync(oldFile), 'old rotated file should be deleted');
    assert.ok(fs.existsSync(newFile), 'future-dated rotated file should be kept');
    assert.ok(fs.existsSync(currentFile), 'active crawler.jsonl should never be deleted');
  });

  it('cleanupRotatedLogs with retentionDays=0 disables cleanup', () => {
    const dir = makeTempDir();
    const oldFile = path.join(dir, 'crawler-20200101-000000.jsonl');
    fs.writeFileSync(oldFile, 'old');
    const longAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldFile, longAgo, longAgo);

    cleanupRotatedLogs(dir, 0);

    assert.ok(fs.existsSync(oldFile), 'retentionDays=0 should not delete anything');
  });
});
