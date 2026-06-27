const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  isWindows,
  getPm2Home,
  readPm2Log,
  readEventLog,
  getServiceStatus,
} = require('../../deployment/windows/lib/diagnostics.js');

describe('diagnostics', () => {
  it('isWindows returns a boolean', () => {
    assert.strictEqual(typeof isWindows(), 'boolean');
  });

  it('getPm2Home returns a string', () => {
    const home = getPm2Home();
    assert.strictEqual(typeof home, 'string');
    assert.ok(home.length > 0);
  });

  it('readPm2Log returns a result object', () => {
    const result = readPm2Log(10);
    assert.strictEqual(typeof result, 'object');
    assert.ok('path' in result);
    assert.ok('content' in result);
    assert.strictEqual(typeof result.content, 'string');
  });

  it('readEventLog returns a string', () => {
    const output = readEventLog('PM2', 5);
    assert.strictEqual(typeof output, 'string');
  });

  it('getServiceStatus returns a string', () => {
    const status = getServiceStatus('PM2');
    assert.strictEqual(typeof status, 'string');
  });
});
