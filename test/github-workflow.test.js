const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

describe('.github/workflows/deploy-vps.yml', () => {
  const workflowPath = path.resolve(__dirname, '../.github/workflows/deploy-vps.yml');

  it('exists', () => {
    assert.ok(fs.existsSync(workflowPath), 'workflow should exist');
  });

  it('triggers on tag push', () => {
    const content = fs.readFileSync(workflowPath, 'utf-8');
    assert.ok(content.includes("tags:\n      - 'v*'"), 'should trigger on v* tags');
  });

  it('builds and pushes image to ghcr', () => {
    const content = fs.readFileSync(workflowPath, 'utf-8');
    assert.ok(content.includes('ghcr.io/${{ github.repository }}'), 'should use ghcr');
    assert.ok(content.includes('docker/build-push-action'), 'should build and push');
  });

  it('deploys via SSH using secrets', () => {
    const content = fs.readFileSync(workflowPath, 'utf-8');
    assert.ok(content.includes('secrets.VPS_HOST'), 'should use VPS_HOST secret');
    assert.ok(content.includes('secrets.VPS_USER'), 'should use VPS_USER secret');
    assert.ok(content.includes('secrets.VPS_SSH_KEY'), 'should use VPS_SSH_KEY secret');
    assert.ok(content.includes('appleboy/ssh-action'), 'should use ssh action');
  });

  it('quotes ref_name in ssh script', () => {
    const content = fs.readFileSync(workflowPath, 'utf-8');
    assert.ok(content.includes('./update.sh "${{ github.ref_name }}"'), 'should quote ref_name');
  });

  it('declares workflow permissions', () => {
    const content = fs.readFileSync(workflowPath, 'utf-8');
    assert.ok(content.includes('permissions:'), 'should declare permissions');
  });

  it('lowercases repository for image base', () => {
    const content = fs.readFileSync(workflowPath, 'utf-8');
    assert.ok(content.includes("tr '[:upper:]' '[:lower:]'"), 'should lowercase repo');
  });
});
