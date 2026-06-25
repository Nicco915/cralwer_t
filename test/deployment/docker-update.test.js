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

describe('docker update', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-update-test-'));
    commands = [];
    cp.execSync = (cmd, opts) => {
      commands.push({ cmd, cwd: opts?.cwd, env: opts?.env });
      if (cmd.includes('docker pull')) return '';
      if (cmd.includes('docker compose')) return '';
      return originalExecSync(cmd, opts);
    };
    cp.execFileSync = (file, args, opts) => {
      commands.push({ cmd: `${file} ${args.join(' ')}`, cwd: opts?.cwd, env: opts?.env });
      if (file === 'docker' && args[0] === 'inspect') return 'running';
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

    await assert.rejects(
      async () => update({ installDir, imageTag: 'registry/a:2' }),
      /\.env not found/
    );
  });

  it('update records previous and switches image on success', async () => {
    const { update, readState } = require(updateModulePath);
    const installDir = path.join(tmpDir, 'update-ok');
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(path.join(installDir, '.env'), 'TEST=1\n');

    await update({ installDir, imageTag: 'registry/a:2', healthCheckTimeoutMs: 100 });

    const state = readState(installDir);
    assert.strictEqual(state.current, 'registry/a:2');
    assert.strictEqual(state.previous, null);
  });
});
