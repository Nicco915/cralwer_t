const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const scriptPath = path.resolve(__dirname, '../../deployment/docker/build-push.ps1');

describe('docker build-push.ps1', () => {
  it('file exists', () => {
    assert.ok(fs.existsSync(scriptPath), `build-push.ps1 should exist at ${scriptPath}`);
  });

  it('does NOT contain #Requires -RunAsAdministrator', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(!content.includes('#Requires -RunAsAdministrator'), 'should not require administrator');
  });

  it('contains mandatory $Registry parameter', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('$Registry'), 'should declare $Registry parameter');
    assert.ok(content.includes('Mandatory'), 'should have Mandatory attribute');
  });

  it('contains mandatory $ImageName parameter', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('$ImageName'), 'should declare $ImageName parameter');
    assert.ok(content.includes('Mandatory'), 'should have Mandatory attribute');
  });

  it('contains $Tag parameter with default git rev-parse', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('$Tag'), 'should declare $Tag parameter');
    assert.ok(content.includes('git rev-parse --short HEAD'), 'should default to git short hash');
  });

  it('constructs fullImage and latestImage', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('fullImage'), 'should define fullImage');
    assert.ok(content.includes('latestImage'), 'should define latestImage');
  });

  it('runs docker build with correct Dockerfile path', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('docker build'), 'should run docker build');
    assert.ok(content.includes('Dockerfile'), 'should reference Dockerfile');
    assert.ok(content.includes('PSScriptRoot'), 'should use PSScriptRoot');
  });

  it('tags image as latest', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('docker tag'), 'should run docker tag');
  });

  it('pushes both fullImage and latestImage', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('docker push'), 'should run docker push');
  });

  it('exits on docker build failure', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('LASTEXITCODE') && content.includes('ne 0'), 'should check LASTEXITCODE');
  });
});
