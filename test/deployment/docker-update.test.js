const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');

const originalExecSync = cp.execSync;
const originalExecFileSync = cp.execFileSync;
const updateModulePath = path.resolve(__dirname, '../../deployment/docker/lib/update.js');
let tmpDir;
let commands;
let execFileOutput;
let pullShouldFail;
let composeShouldFail;

describe('docker update', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-update-test-'));
    commands = [];
    execFileOutput = 'running\n';
    pullShouldFail = false;
    composeShouldFail = false;
    cp.execSync = originalExecSync;
    cp.execFileSync = (file, args, opts) => {
      commands.push({ file, args, cwd: opts?.cwd, env: opts?.env });
      if (file === 'docker' && args.includes('pull')) {
        if (pullShouldFail) throw new Error('pull failed');
        return '';
      }
      if (file === 'docker' && args.includes('inspect')) {
        return execFileOutput;
      }
      if (file === 'docker' && args.includes('compose') && args.includes('up')) {
        if (composeShouldFail) throw new Error('docker compose up failed');
        return '';
      }
      return originalExecFileSync(file, args, opts);
    };
    delete require.cache[updateModulePath];
  });

  afterEach(() => {
    cp.execSync = originalExecSync;
    cp.execFileSync = originalExecFileSync;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[updateModulePath];
  });

  it('update throws when .env is missing', async () => {
    const { update } = require(updateModulePath);
    const installDir = path.join(tmpDir, 'no-env');
    fs.mkdirSync(installDir, { recursive: true });
    await assert.rejects(async () => update({ installDir, imageTag: 'registry/a:2' }), /\.env not found/);
  });

  it('update throws when installDir is missing', async () => {
    const { update } = require(updateModulePath);
    await assert.rejects(async () => update({ imageTag: 'registry/a:2' }), /installDir is required/);
  });

  it('update throws when imageTag is missing', async () => {
    const { update } = require(updateModulePath);
    const installDir = path.join(tmpDir, 'no-tag');
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(path.join(installDir, '.env'), 'TEST=1\n');
    await assert.rejects(async () => update({ installDir }), /imageTag is required/);
  });

  it('update records previous and switches image on success', async () => {
    const { update, readState } = require(updateModulePath);
    const installDir = path.join(tmpDir, 'update-ok');
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(path.join(installDir, '.env'), 'TEST=1\n');

    await update({ installDir, imageTag: 'registry/a:2', healthCheckTimeoutMs: 100 });

    const pullCmd = commands.find(c => c.file === 'docker' && c.args.includes('pull'));
    assert.ok(pullCmd);
    assert.ok(pullCmd.args.includes('registry/a:2'));
    const composeCmd = commands.find(c => c.file === 'docker' && c.args.includes('compose') && c.args.includes('up'));
    assert.ok(composeCmd);
    assert.strictEqual(composeCmd.env?.CRAWLER_IMAGE, 'registry/a:2');
    const state = readState(installDir);
    assert.strictEqual(state.current, 'registry/a:2');
    assert.strictEqual(state.previous, null);
  });

  it('update rolls back to previous image on health check failure', async () => {
    const { update, readState } = require(updateModulePath);
    const installDir = path.join(tmpDir, 'update-rollback');
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(path.join(installDir, '.env'), 'TEST=1\n');
    const { recordCurrent } = require(path.resolve(__dirname, '../../deployment/docker/lib/state.js'));
    recordCurrent(installDir, 'registry/a:1');
    execFileOutput = 'exited\n';

    await assert.rejects(
      async () => update({ installDir, imageTag: 'registry/a:2', healthCheckTimeoutMs: 100 }),
      /Update failed/
    );

    const rollbackCmd = commands.find(c => c.file === 'docker' && c.args.includes('compose') && c.args.includes('up') && c.env?.CRAWLER_IMAGE === 'registry/a:1');
    assert.ok(rollbackCmd, 'rollback docker compose up should use previous image');
    const state = readState(installDir);
    assert.strictEqual(state.current, 'registry/a:1');
  });

  it('update rolls back to previous image on docker pull failure', async () => {
    const { update, readState } = require(updateModulePath);
    const installDir = path.join(tmpDir, 'update-pull-fail');
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(path.join(installDir, '.env'), 'TEST=1\n');
    const { recordCurrent } = require(path.resolve(__dirname, '../../deployment/docker/lib/state.js'));
    recordCurrent(installDir, 'registry/a:1');
    pullShouldFail = true;

    await assert.rejects(
      async () => update({ installDir, imageTag: 'registry/a:2', healthCheckTimeoutMs: 100 }),
      /Update failed/
    );

    const state = readState(installDir);
    assert.strictEqual(state.current, 'registry/a:1');
  });

  it('update rolls back to previous image on docker compose up failure', async () => {
    const { update, readState } = require(updateModulePath);
    const installDir = path.join(tmpDir, 'update-compose-fail');
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(path.join(installDir, '.env'), 'TEST=1\n');
    const { recordCurrent } = require(path.resolve(__dirname, '../../deployment/docker/lib/state.js'));
    recordCurrent(installDir, 'registry/a:1');
    composeShouldFail = true;

    await assert.rejects(
      async () => update({ installDir, imageTag: 'registry/a:2', healthCheckTimeoutMs: 100 }),
      /Update failed/
    );

    const state = readState(installDir);
    assert.strictEqual(state.current, 'registry/a:1');
  });
});
