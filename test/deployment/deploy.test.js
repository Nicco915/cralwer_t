const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execSync } = require('node:child_process');

const { deploy, ensureDir, getCurrentCommit } = require('../../deployment/windows/lib/deploy.js');

describe('deploy', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-test-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('deploy throws when .env is missing', async () => {
    const installDir = path.join(tmpDir, 'no-env');
    fs.mkdirSync(installDir, { recursive: true });

    await assert.rejects(
      async () => deploy({ installDir, repoUrl: 'https://example.com/repo.git' }),
      {
        message: new RegExp(`\\.env not found at .* Please place it before deploying\\.`),
      }
    );
  });

  it('ensureDir creates directory recursively', () => {
    const deepDir = path.join(tmpDir, 'a', 'b', 'c');
    assert.strictEqual(fs.existsSync(deepDir), false);
    ensureDir(deepDir);
    assert.strictEqual(fs.existsSync(deepDir), true);
    assert.strictEqual(fs.statSync(deepDir).isDirectory(), true);
  });

  it('getCurrentCommit returns commit hash', () => {
    const repoDir = path.join(tmpDir, 'git-repo');
    fs.mkdirSync(repoDir, { recursive: true });
    execSync('git init', { cwd: repoDir, encoding: 'utf-8' });
    fs.writeFileSync(path.join(repoDir, 'file.txt'), 'hello');
    execSync('git add file.txt', { cwd: repoDir, encoding: 'utf-8' });
    execSync('git -c user.email="test@test.com" -c user.name="Test" commit -m "init"', { cwd: repoDir, encoding: 'utf-8' });

    const commit = getCurrentCommit(repoDir);
    assert.strictEqual(typeof commit, 'string');
    assert.strictEqual(commit.length, 40);
    assert.match(commit, /^[a-f0-9]{40}$/);
  });

  it('deploy throws when install directory is not empty and not a git repo', async () => {
    const dir = path.join(tmpDir, 'non-empty-not-git');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.env'), 'TEST=1\n');
    fs.writeFileSync(path.join(dir, 'existing-file.txt'), 'hello');
    const repoDir = path.join(tmpDir, 'repo-for-non-empty');
    fs.mkdirSync(repoDir, { recursive: true });
    await assert.rejects(
      () => deploy({ installDir: dir, repoUrl: repoDir, branch: 'main' }),
      /not empty and not a git repository/
    );
  });
});
