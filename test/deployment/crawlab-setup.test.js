const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

describe('deployment/crawlab/setup-vps.sh', () => {
  const scriptPath = path.resolve(__dirname, '../../deployment/crawlab/setup-vps.sh');

  it('exists and is executable', () => {
    assert.ok(fs.existsSync(scriptPath), 'setup-vps.sh should exist');
    const stats = fs.statSync(scriptPath);
    assert.ok(stats.mode & 0o111, 'setup-vps.sh should be executable');
  });

  it('requires VPS_IP argument', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('VPS_IP="${1:?'), 'should require VPS_IP');
  });

  it('installs docker and docker-compose-plugin', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('get.docker.com'), 'should install docker');
    assert.ok(content.includes('docker-compose-plugin'), 'should install compose plugin');
  });

  it('creates crawler user and /opt/crawler directory', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('useradd'), 'should create crawler user');
    assert.ok(content.includes('/opt/crawler'), 'should create /opt/crawler');
  });

  it('validates environment variables', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('GITHUB_OWNER="${GITHUB_OWNER:?'), 'should require GITHUB_OWNER');
    assert.ok(content.includes('REPO="${REPO:?'), 'should require REPO');
  });

  it('uses StrictHostKeyChecking=accept-new', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('StrictHostKeyChecking=accept-new'), 'should accept new host keys');
  });
});
