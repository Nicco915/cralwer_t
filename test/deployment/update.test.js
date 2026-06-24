const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execSync } = require('node:child_process');

const { readState, recordCurrent } = require('../../deployment/windows/lib/state.js');

// monkey-patch execSync before requiring update.js so the cached module sees the mock
const cp = require('node:child_process');
const originalExecSync = cp.execSync;
let updateNpmCiCalled = false;
let rollbackNpmCiCalled = false;

function mockExecSync(cmd, opts) {
  if (cmd === 'git fetch origin' || cmd.startsWith('git reset --hard origin/')) {
    return '';
  }
  if (cmd === 'npm ci') {
    if (!updateNpmCiCalled) {
      updateNpmCiCalled = true;
      throw new Error('npm ci failed');
    }
    rollbackNpmCiCalled = true;
    return '';
  }
  return originalExecSync(cmd, opts);
}

cp.execSync = mockExecSync;
const { update } = require('../../deployment/windows/lib/update.js');

describe('update', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-test-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('update throws when .env is missing', async () => {
    const installDir = path.join(tmpDir, 'no-env');
    fs.mkdirSync(installDir, { recursive: true });

    await assert.rejects(
      async () => update({ installDir }),
      /\.env not found/
    );
  });

  it('update throws when installDir is missing', async () => {
    await assert.rejects(
      async () => update({}),
      /installDir is required and must be a string/
    );
  });

  it('update rolls back to previous commit on npm ci failure', async () => {
    const dir = path.join(tmpDir, 'rollback-test');
    fs.mkdirSync(dir, { recursive: true });

    // init git repo
    execSync('git init', { cwd: dir, encoding: 'utf-8' });
    fs.writeFileSync(path.join(dir, 'file.txt'), 'v1');
    execSync('git add file.txt', { cwd: dir, encoding: 'utf-8' });
    execSync('git -c user.email="test@test.com" -c user.name="Test" commit -m "init"', { cwd: dir, encoding: 'utf-8' });
    const initialCommit = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf-8' }).trim();

    // create a second commit
    fs.writeFileSync(path.join(dir, 'file.txt'), 'v2');
    execSync('git add file.txt', { cwd: dir, encoding: 'utf-8' });
    execSync('git -c user.email="test@test.com" -c user.name="Test" commit -m "second"', { cwd: dir, encoding: 'utf-8' });

    fs.writeFileSync(path.join(dir, '.env'), 'TEST=1\n');
    recordCurrent(dir, initialCommit);

    // reset flags for this test
    updateNpmCiCalled = false;
    rollbackNpmCiCalled = false;

    await assert.rejects(
      async () => update({ installDir: dir }),
      /Update failed/
    );

    assert.strictEqual(updateNpmCiCalled, true);
    assert.strictEqual(rollbackNpmCiCalled, true);
    const state = readState(dir);
    assert.strictEqual(state.current, initialCommit);
  });
});
