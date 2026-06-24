const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execSync } = require('node:child_process');

const { rollback } = require('../../deployment/windows/lib/rollback.js');
const { readState, setCurrentCommit, writeState } = require('../../deployment/windows/lib/state.js');

function createTempGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollback-git-test-'));
  execSync('git init', { cwd: dir });
  execSync('git config user.email "test@test.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  fs.writeFileSync(path.join(dir, 'init.txt'), 'init');
  execSync('git add . && git commit -m init', { cwd: dir });
  return dir;
}

describe('rollback', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollback-test-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rollback throws when installDir is missing', async () => {
    await assert.rejects(
      async () => rollback({}),
      /installDir is required/
    );
  });

  it('rollback throws when .env is missing', async () => {
    const installDir = path.join(tmpDir, 'no-env');
    fs.mkdirSync(installDir, { recursive: true });

    await assert.rejects(
      async () => rollback({ installDir }),
      /\.env not found/
    );
  });

  it('rollback throws when no previous commit and no target', async () => {
    const installDir = path.join(tmpDir, 'no-prev');
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(path.join(installDir, '.env'), 'FOO=bar\n');

    await assert.rejects(
      async () => rollback({ installDir }),
      /No previous commit recorded\. Cannot rollback automatically\./
    );
  });
});
