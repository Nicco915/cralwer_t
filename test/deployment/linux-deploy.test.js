const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

describe('Linux deploy.sh', () => {
  const scriptPath = path.resolve('deployment/linux/deploy.sh');

  it('exists and is executable', () => {
    assert.ok(fs.existsSync(scriptPath), 'deploy.sh should exist');
    const stats = fs.statSync(scriptPath);
    assert.ok(stats.mode & 0o111, 'deploy.sh should be executable');
  });

  it('requires image tag argument', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('${1:?'), 'deploy.sh should require image tag argument');
  });

  it('requires .env file', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('.env'), 'deploy.sh should check for .env file');
  });

  it('validates CRAWLER_IMAGE_BASE trailing slash', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('CRAWLER_IMAGE_BASE') && content.includes('*/'), 'deploy.sh should validate CRAWLER_IMAGE_BASE');
  });
});

describe('deploy.sh behavior', () => {
  it('exits with error when image tag is missing', () => {
    const scriptPath = path.resolve('deployment/linux/deploy.sh');
    const result = require('child_process').spawnSync('bash', [scriptPath], {
      cwd: path.resolve('deployment/linux'),
      encoding: 'utf-8',
    });
    assert.notStrictEqual(result.status, 0);
    assert.ok(result.stderr.includes('镜像 tag'));
  });

  it('exits with error when .env is missing', () => {
    const scriptPath = path.resolve('deployment/linux/deploy.sh');
    const tmpDir = require('os').tmpdir();
    const testDir = path.join(tmpDir, `deploy-test-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
    fs.copyFileSync(scriptPath, path.join(testDir, 'deploy.sh'));
    try {
      const result = require('child_process').spawnSync('bash', [path.join(testDir, 'deploy.sh'), 'abc123'], {
        cwd: testDir,
        encoding: 'utf-8',
        env: { ...process.env, CRAWLER_IMAGE_BASE: 'test' },
      });
      assert.notStrictEqual(result.status, 0);
      assert.ok(result.stderr.includes('.env'));
    } finally {
      try { fs.rmSync(testDir, { recursive: true }); } catch (e) {}
    }
  });
});
