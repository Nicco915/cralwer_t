const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');

const originalExecFileSync = cp.execFileSync;
const rollbackModulePath = path.resolve(__dirname, '../../deployment/docker/lib/rollback.js');
const stateModulePath = path.resolve(__dirname, '../../deployment/docker/lib/state.js');
const healthCheckModulePath = path.resolve(__dirname, '../../deployment/docker/lib/health-check.js');
let tmpDir;
let commands;
let execFileOutput;

describe('docker rollback', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-rollback-test-'));
    commands = [];
    execFileOutput = 'running\n';
    cp.execFileSync = (file, args, opts) => {
      commands.push({ file, args, cwd: opts?.cwd, env: opts?.env });
      if (file === 'docker' && args.includes('inspect')) {
        return execFileOutput;
      }
      if (file === 'docker' && args.includes('compose') && args.includes('up')) {
        return '';
      }
      return originalExecFileSync(file, args, opts);
    };
    delete require.cache[rollbackModulePath];
    delete require.cache[stateModulePath];
    delete require.cache[healthCheckModulePath];
  });

  afterEach(() => {
    cp.execFileSync = originalExecFileSync;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[rollbackModulePath];
    delete require.cache[stateModulePath];
    delete require.cache[healthCheckModulePath];
  });

  it('throws when installDir is not a string', async () => {
    const { rollback } = require(rollbackModulePath);
    await assert.rejects(async () => rollback({ installDir: 123 }), /installDir is required and must be a string/);
  });

  it('throws when .env is missing', async () => {
    const { rollback } = require(rollbackModulePath);
    const installDir = path.join(tmpDir, 'no-env');
    fs.mkdirSync(installDir, { recursive: true });
    await assert.rejects(async () => rollback({ installDir }), /\.env not found/);
  });

  it('throws when no target image and no previous in state', async () => {
    const { rollback } = require(rollbackModulePath);
    const installDir = path.join(tmpDir, 'no-prev');
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(path.join(installDir, '.env'), 'FOO=bar\n');
    await assert.rejects(async () => rollback({ installDir }), /No target image/);
  });

  it('rolls back to previous image when targetImage is not provided', async () => {
    const { rollback } = require(rollbackModulePath);
    const { recordCurrent, readState } = require(stateModulePath);
    const installDir = path.join(tmpDir, 'rollback-prev');
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(path.join(installDir, '.env'), 'FOO=bar\n');
    recordCurrent(installDir, 'registry/a:1');
    recordCurrent(installDir, 'registry/a:2');

    const result = await rollback({ installDir, healthCheckTimeoutMs: 100 });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.image, 'registry/a:1');
    const composeCmd = commands.find(c => c.file === 'docker' && c.args.includes('compose') && c.args.includes('up'));
    assert.ok(composeCmd);
    assert.strictEqual(composeCmd.env?.CRAWLER_IMAGE, 'registry/a:1');
    const state = readState(installDir);
    assert.strictEqual(state.current, 'registry/a:1');
    assert.strictEqual(state.previous, 'registry/a:2');
  });

  it('rolls back to specified targetImage', async () => {
    const { rollback } = require(rollbackModulePath);
    const { recordCurrent, readState } = require(stateModulePath);
    const installDir = path.join(tmpDir, 'rollback-target');
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(path.join(installDir, '.env'), 'FOO=bar\n');
    recordCurrent(installDir, 'registry/a:1');
    recordCurrent(installDir, 'registry/a:2');

    const result = await rollback({ installDir, targetImage: 'registry/a:1', healthCheckTimeoutMs: 100 });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.image, 'registry/a:1');
    const composeCmd = commands.find(c => c.file === 'docker' && c.args.includes('compose') && c.args.includes('up'));
    assert.ok(composeCmd);
    assert.strictEqual(composeCmd.env?.CRAWLER_IMAGE, 'registry/a:1');
    const state = readState(installDir);
    assert.strictEqual(state.current, 'registry/a:1');
    assert.strictEqual(state.previous, 'registry/a:2');
  });

  it('throws when health check fails', async () => {
    const { rollback } = require(rollbackModulePath);
    const { recordCurrent } = require(stateModulePath);
    const installDir = path.join(tmpDir, 'rollback-fail');
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(path.join(installDir, '.env'), 'FOO=bar\n');
    recordCurrent(installDir, 'registry/a:1');
    recordCurrent(installDir, 'registry/a:2');
    execFileOutput = 'exited\n';

    await assert.rejects(async () => rollback({ installDir, healthCheckTimeoutMs: 100 }), /health check failed/);
  });

  it('sets previous to original current when targetImage is not in history', async () => {
    const { rollback } = require(rollbackModulePath);
    const { recordCurrent, readState } = require(stateModulePath);
    const installDir = path.join(tmpDir, 'rollback-history');
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(path.join(installDir, '.env'), 'FOO=bar\n');
    recordCurrent(installDir, 'registry/a:1');
    recordCurrent(installDir, 'registry/a:2');
    recordCurrent(installDir, 'registry/a:3');

    const result = await rollback({ installDir, targetImage: 'registry/a:0', healthCheckTimeoutMs: 100 });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.image, 'registry/a:0');
    const state = readState(installDir);
    assert.strictEqual(state.current, 'registry/a:0');
    assert.strictEqual(state.previous, 'registry/a:3');
  });

  it('sets previous to the image after targetImage in history when targetImage is in history', async () => {
    const { rollback } = require(rollbackModulePath);
    const { recordCurrent, readState } = require(stateModulePath);
    const installDir = path.join(tmpDir, 'rollback-history-prev');
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(path.join(installDir, '.env'), 'FOO=bar\n');
    recordCurrent(installDir, 'registry/a:1');
    recordCurrent(installDir, 'registry/a:2');
    recordCurrent(installDir, 'registry/a:3');

    const result = await rollback({ installDir, targetImage: 'registry/a:2', healthCheckTimeoutMs: 100 });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.image, 'registry/a:2');
    const state = readState(installDir);
    assert.strictEqual(state.current, 'registry/a:2');
    assert.strictEqual(state.previous, 'registry/a:3');
  });
});
