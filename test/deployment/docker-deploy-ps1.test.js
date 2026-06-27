const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const scriptPath = path.resolve(__dirname, '../../deployment/docker/deploy.ps1');

describe('docker deploy.ps1', () => {
  it('file exists', () => {
    assert.ok(fs.existsSync(scriptPath), `deploy.ps1 should exist at ${scriptPath}`);
  });

  it('contains #Requires -RunAsAdministrator', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('#Requires -RunAsAdministrator'), 'should require administrator');
  });

  it('contains mandatory $ImageTag parameter', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('$ImageTag'), 'should declare $ImageTag parameter');
    assert.ok(content.includes('Mandatory'), 'should have Mandatory attribute');
  });

  it('contains $InstallDir parameter with default', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('$InstallDir'), 'should declare $InstallDir parameter');
    assert.ok(content.includes("C:\\hs-sku-crawler"), 'should default to C:\\hs-sku-crawler');
  });

  it('contains $Registry parameter with default', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('$Registry'), 'should declare $Registry parameter');
    assert.ok(content.includes('registry.example.com'), 'should default to registry.example.com');
  });

  it('contains $ImageName parameter with default', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('$ImageName'), 'should declare $ImageName parameter');
    assert.ok(content.includes('hs-sku-crawler'), 'should default to hs-sku-crawler');
  });

  it('checks administrator privileges', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('WindowsPrincipal'), 'should check WindowsPrincipal');
    assert.ok(content.includes('Administrator'), 'should check Administrator role');
  });

  it('checks Docker and Docker Compose installation', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('docker') && content.includes('Get-Command'), 'should check docker command');
    assert.ok(content.includes('docker compose') || content.includes('docker-compose'), 'should check docker compose');
  });

  it('creates install directory and subdirectories', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('logs'), 'should mention logs directory');
    assert.ok(content.includes('output'), 'should mention output directory');
    assert.ok(content.includes('images'), 'should mention images directory');
  });

  it('checks .env existence', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('.env'), 'should check .env file');
  });

  it('copies docker-compose.yml', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('docker-compose.yml'), 'should copy docker-compose.yml');
  });

  it('constructs full image name and calls node lib\deploy.js', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('deploy.js'), 'should call deploy.js');
    assert.ok(content.includes('--image'), 'should pass --image');
    assert.ok(content.includes('--install-dir'), 'should pass --install-dir');
  });

  it('exits on non-zero node exit code', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('LASTEXITCODE') && content.includes('ne 0'), 'should check LASTEXITCODE');
  });
});
