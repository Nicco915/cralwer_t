const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { getStatePath, readState, writeState, recordCurrent, setCurrentImage } = require('../../deployment/docker/lib/state.js');

describe('docker state', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-state-test-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns default state when file does not exist', () => {
    const state = readState(path.join(tmpDir, 'nonexistent'));
    assert.deepStrictEqual(state, { current: null, previous: null, history: [] });
  });

  it('write/read roundtrip', () => {
    const dir = path.join(tmpDir, 'roundtrip');
    fs.mkdirSync(dir, { recursive: true });
    const expected = { current: 'registry/a:1', previous: 'registry/a:0', history: ['registry/a:1', 'registry/a:0'] };
    writeState(dir, expected);
    assert.deepStrictEqual(readState(dir), expected);
  });

  it('recordCurrent updates current/previous/history', () => {
    const dir = path.join(tmpDir, 'record-current');
    fs.mkdirSync(dir, { recursive: true });
    recordCurrent(dir, 'registry/a:1');
    let state = readState(dir);
    assert.strictEqual(state.current, 'registry/a:1');
    assert.strictEqual(state.previous, null);
    assert.deepStrictEqual(state.history, ['registry/a:1']);

    recordCurrent(dir, 'registry/a:2');
    state = readState(dir);
    assert.strictEqual(state.current, 'registry/a:2');
    assert.strictEqual(state.previous, 'registry/a:1');
    assert.deepStrictEqual(state.history, ['registry/a:2', 'registry/a:1']);
  });

  it('keeps last 20 history entries', () => {
    const dir = path.join(tmpDir, 'history');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 25; i++) {
      recordCurrent(dir, `registry/a:${i}`);
    }
    const state = readState(dir);
    assert.strictEqual(state.history.length, 20);
  });

  it('setCurrentImage updates current and previous', () => {
    const dir = path.join(tmpDir, 'set-current');
    fs.mkdirSync(dir, { recursive: true });
    writeState(dir, { current: 'registry/a:2', previous: 'registry/a:1', history: ['registry/a:2', 'registry/a:1', 'registry/a:0'] });
    setCurrentImage(dir, 'registry/a:1', 'registry/a:0');
    const state = readState(dir);
    assert.strictEqual(state.current, 'registry/a:1');
    assert.strictEqual(state.previous, 'registry/a:0');
  });
});
