const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const deployJs = path.resolve(__dirname, '../../deployment/windows/lib/deploy.js');
const updateJs = path.resolve(__dirname, '../../deployment/windows/lib/update.js');
const rollbackJs = path.resolve(__dirname, '../../deployment/windows/lib/rollback.js');

describe('CLI entry points', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-test-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('deploy.js exits non-zero when .env is missing', () => {
    const installDir = path.join(tmpDir, 'no-env-deploy');
    fs.mkdirSync(installDir, { recursive: true });
    const result = spawnSync(process.execPath, [
      deployJs,
      '--repo-url', 'https://example.com/repo.git',
      '--install-dir', installDir,
    ], { encoding: 'utf-8' });
    assert.notStrictEqual(result.status, 0, `Expected non-zero exit, got stdout: ${result.stdout}, stderr: ${result.stderr}`);
  });

  it('update.js exits non-zero when .env is missing', () => {
    const installDir = path.join(tmpDir, 'no-env-update');
    fs.mkdirSync(installDir, { recursive: true });
    const result = spawnSync(process.execPath, [
      updateJs,
      '--install-dir', installDir,
    ], { encoding: 'utf-8' });
    assert.notStrictEqual(result.status, 0, `Expected non-zero exit, got stdout: ${result.stdout}, stderr: ${result.stderr}`);
  });

  it('rollback.js exits non-zero when .env is missing', () => {
    const installDir = path.join(tmpDir, 'no-env-rollback');
    fs.mkdirSync(installDir, { recursive: true });
    const result = spawnSync(process.execPath, [
      rollbackJs,
      '--install-dir', installDir,
    ], { encoding: 'utf-8' });
    assert.notStrictEqual(result.status, 0, `Expected non-zero exit, got stdout: ${result.stdout}, stderr: ${result.stderr}`);
  });

  it('deploy.js exits non-zero when repo-url is missing', () => {
    const installDir = path.join(tmpDir, 'missing-repo-url');
    fs.mkdirSync(installDir, { recursive: true });
    const result = spawnSync(process.execPath, [
      deployJs,
      '--install-dir', installDir,
    ], { encoding: 'utf-8' });
    assert.notStrictEqual(result.status, 0, `Expected non-zero exit, got stdout: ${result.stdout}, stderr: ${result.stderr}`);
  });

  it('update.js exits non-zero when installDir is invalid', () => {
    const result = spawnSync(process.execPath, [
      updateJs,
      '--install-dir', '',
    ], { encoding: 'utf-8' });
    assert.notStrictEqual(result.status, 0, `Expected non-zero exit, got stdout: ${result.stdout}, stderr: ${result.stderr}`);
  });

  it('rollback.js exits non-zero when installDir is invalid', () => {
    const result = spawnSync(process.execPath, [
      rollbackJs,
      '--install-dir', '',
    ], { encoding: 'utf-8' });
    assert.notStrictEqual(result.status, 0, `Expected non-zero exit, got stdout: ${result.stdout}, stderr: ${result.stderr}`);
  });
});
