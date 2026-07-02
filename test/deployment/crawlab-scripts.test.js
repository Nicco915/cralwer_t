const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

function assertScript(name) {
  const p = path.resolve(__dirname, `../../deployment/crawlab/${name}`);
  assert.ok(fs.existsSync(p), `${name} should exist`);
  const stats = fs.statSync(p);
  assert.ok(stats.mode & 0o111, `${name} should be executable`);
}

describe('deployment/crawlab scripts', () => {
  it('deploy.sh exists and is executable', () => assertScript('deploy.sh'));
  it('update.sh exists and is executable', () => assertScript('update.sh'));
  it('rollback.sh exists and is executable', () => assertScript('rollback.sh'));
});
