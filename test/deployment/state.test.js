const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { getStatePath, readState, writeState, recordCurrent, setCurrentCommit } = require('../../deployment/windows/lib/state.js');

describe('state', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-test-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('文件不存在时返回默认值', () => {
    const installDir = path.join(tmpDir, 'nonexistent');
    const state = readState(installDir);
    assert.deepStrictEqual(state, { current: null, previous: null, history: [] });
  });

  it('write/read 往返一致', () => {
    const installDir = path.join(tmpDir, 'write-read-test');
    fs.mkdirSync(installDir, { recursive: true });
    const expected = { current: 'abc123', previous: 'def456', history: ['abc123', 'def456'] };
    writeState(installDir, expected);
    const actual = readState(installDir);
    assert.deepStrictEqual(actual, expected);
  });

  it('recordCurrent 更新 current/previous/history', () => {
    const installDir = tmpDir;
    recordCurrent(installDir, 'commit-1');
    let state = readState(installDir);
    assert.strictEqual(state.current, 'commit-1');
    assert.strictEqual(state.previous, null);
    assert.deepStrictEqual(state.history, ['commit-1']);

    recordCurrent(installDir, 'commit-2');
    state = readState(installDir);
    assert.strictEqual(state.current, 'commit-2');
    assert.strictEqual(state.previous, 'commit-1');
    assert.deepStrictEqual(state.history, ['commit-2', 'commit-1']);
  });

  it('history 保留最近 20 条', () => {
    const installDir = path.join(tmpDir, 'history-test');
    fs.mkdirSync(installDir, { recursive: true });
    for (let i = 0; i < 25; i++) {
      recordCurrent(installDir, `commit-${i}`);
    }
    const state = readState(installDir);
    assert.strictEqual(state.history.length, 20);
    assert.strictEqual(state.history[0], 'commit-24');
    assert.strictEqual(state.history[19], 'commit-5');
  });

  it('setCurrentCommit 更新 current 和 previous', () => {
    const installDir = path.join(tmpDir, 'set-current-test');
    fs.mkdirSync(installDir, { recursive: true });
    writeState(installDir, { current: 'v2', previous: 'v1', history: ['v2', 'v1', 'v0'] });
    setCurrentCommit(installDir, 'v1', 'v0');
    const state = readState(installDir);
    assert.strictEqual(state.current, 'v1');
    assert.strictEqual(state.previous, 'v0');
  });
});
