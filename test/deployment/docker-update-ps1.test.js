const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const scriptPath = path.resolve(__dirname, '../../deployment/docker/update.ps1');

describe('docker update.ps1', () => {
  it('file exists', () => {
    assert.ok(fs.existsSync(scriptPath), `update.ps1 should exist at ${scriptPath}`);
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

  it('checks administrator privileges', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('WindowsPrincipal'), 'should check WindowsPrincipal');
    assert.ok(content.includes('Administrator'), 'should check Administrator role');
  });

  it('calls node lib\\update.js with --image-tag and --install-dir', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('update.js'), 'should call update.js');
    assert.ok(content.includes('--image-tag'), 'should pass --image-tag');
    assert.ok(content.includes('--install-dir'), 'should pass --install-dir');
  });

  it('exits on non-zero node exit code', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('LASTEXITCODE') && content.includes('ne 0'), 'should check LASTEXITCODE');
  });
});
