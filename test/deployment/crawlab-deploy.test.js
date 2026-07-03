const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '../..');
const DEPLOY_SH = path.join(REPO_ROOT, 'deployment', 'crawlab', 'deploy.sh');

test('deploy.sh sources .env at startup before git pull', () => {
  const content = fs.readFileSync(DEPLOY_SH, 'utf-8');
  const expectedBlock = `SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

cd /opt/crawler/repo && git pull origin main

cd "$SCRIPT_DIR"`;
  assert.ok(
    content.includes(expectedBlock),
    'deploy.sh 应在 git pull 之前先 source .env 文件'
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
