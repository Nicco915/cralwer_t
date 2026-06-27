const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

describe('Linux update.sh', () => {
  const scriptPath = path.resolve('deployment/linux/update.sh');

  it('exists and is executable', () => {
    assert.ok(fs.existsSync(scriptPath), 'update.sh should exist');
    const stats = fs.statSync(scriptPath);
    assert.ok(stats.mode & 0o111, 'update.sh should be executable');
  });

  it('records current image before updating', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('.last_image'), 'update.sh should record last image');
  });

  it('requires image tag argument', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('${1:?'), 'update.sh should require image tag argument');
  });
});
