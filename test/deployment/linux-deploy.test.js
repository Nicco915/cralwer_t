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
