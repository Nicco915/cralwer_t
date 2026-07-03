const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '../..');
const DEPLOY_SH = path.join(REPO_ROOT, 'deployment', 'crawlab', 'deploy.sh');

test('deploy.sh sources .env at startup before git sync', () => {
  const content = fs.readFileSync(DEPLOY_SH, 'utf-8');
  const gitSyncIndex = content.indexOf('cd /opt/crawler/repo');
  assert.ok(gitSyncIndex > 0, 'should contain git sync block');

  const beforeGitSync = content.slice(0, gitSyncIndex);
  assert.ok(
    beforeGitSync.includes('SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"'),
    'should define SCRIPT_DIR before git sync'
  );
  assert.ok(
    beforeGitSync.includes('set -a') &&
    beforeGitSync.includes('source .env') &&
    beforeGitSync.includes('set +a'),
    'should source .env with set -a/source .env/set +a before git sync'
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

test('deploy.sh env-loading idiom exports CRAWLER_IMAGE_BASE from .env', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-test-'));
  try {
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      'CRAWLER_IMAGE_BASE=ghcr.io/nicco915/cralwer_t\n'
    );

    const harness = `#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi
echo "BASE=\${CRAWLER_IMAGE_BASE:-}"`;

    const harnessPath = path.join(tmpDir, 'harness.sh');
    fs.writeFileSync(harnessPath, harness, { mode: 0o755 });

    const output = execFileSync(harnessPath, [], {
      encoding: 'utf-8',
      cwd: tmpDir,
    }).trim();

    assert.match(output, /BASE=ghcr\.io\/nicco915\/cralwer_t/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
