const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execSync } = require('node:child_process');

describe('deployment/crawlab/update.sh', () => {
  const scriptPath = path.resolve(__dirname, '../../deployment/crawlab/update.sh');
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crawlab-update-test-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exists and is executable', () => {
    assert.ok(fs.existsSync(scriptPath), 'update.sh should exist');
    const stats = fs.statSync(scriptPath);
    assert.ok(stats.mode & 0o111, 'update.sh should be executable');
  });

  it('sources .env before checking IMAGE_TAG', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    const imageTagCheckIndex = content.indexOf('IMAGE_TAG="${1:?');
    assert.ok(imageTagCheckIndex > 0, 'should contain IMAGE_TAG argument check');

    const beforeImageTag = content.slice(0, imageTagCheckIndex);
    assert.ok(
      beforeImageTag.includes('set -a') &&
      beforeImageTag.includes('source .env') &&
      beforeImageTag.includes('set +a'),
      'should source .env with set -a/source .env/set +a before IMAGE_TAG check'
    );
  });

  it('exports CRAWLER_IMAGE_BASE from .env using the same source pattern', () => {
    const envPath = path.join(tmpDir, '.env');
    fs.writeFileSync(envPath, 'CRAWLER_IMAGE_BASE=registry.example.com/crawler\n');

    const output = execSync(
      'set -a; source .env; set +a; printf "%s" "$CRAWLER_IMAGE_BASE"',
      { cwd: tmpDir, encoding: 'utf-8', shell: '/bin/bash' }
    );

    assert.strictEqual(output, 'registry.example.com/crawler');
  });

  it('pulls the repo before running docker compose', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(
      content.includes('cd /opt/crawler/repo'),
      'should cd to /opt/crawler/repo'
    );
    assert.ok(
      content.includes('git -c safe.directory=/opt/crawler/repo fetch origin main'),
      'should fetch origin main'
    );
    assert.ok(
      content.includes('git -c safe.directory=/opt/crawler/repo update-ref refs/heads/main FETCH_HEAD'),
      'should update local main to FETCH_HEAD'
    );
    assert.ok(
      content.includes('git -c safe.directory=/opt/crawler/repo checkout -f main'),
      'should force checkout main'
    );
  });
});
