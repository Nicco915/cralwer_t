const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

describe('Linux rollback.sh', () => {
  const scriptPath = path.resolve('deployment/linux/rollback.sh');

  it('exists and is executable', () => {
    assert.ok(fs.existsSync(scriptPath), 'rollback.sh should exist');
    const stats = fs.statSync(scriptPath);
    assert.ok(stats.mode & 0o111, 'rollback.sh should be executable');
  });

  it('requires .last_image file', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('.last_image'), 'rollback.sh should check for .last_image');
  });

  it('requires .env file', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('.env'), 'rollback.sh should check for .env file');
  });
});
