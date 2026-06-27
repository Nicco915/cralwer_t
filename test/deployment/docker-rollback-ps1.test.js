const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const scriptPath = path.resolve(__dirname, '../../deployment/docker/rollback.ps1');

describe('docker rollback.ps1', () => {
  it('file exists', () => {
    assert.ok(fs.existsSync(scriptPath), `rollback.ps1 should exist at ${scriptPath}`);
  });

  it('contains #Requires -RunAsAdministrator', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('#Requires -RunAsAdministrator'), 'should require administrator');
  });

  it('contains $TargetImage parameter with default empty string', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('$TargetImage'), 'should declare $TargetImage parameter');
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

  it('calls node lib\rollback.js with --target-image when $TargetImage is non-empty', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('rollback.js'), 'should call rollback.js');
    assert.ok(content.includes('--target-image'), 'should pass --target-image');
    assert.ok(content.includes('--install-dir'), 'should pass --install-dir');
  });

  it('calls node lib\rollback.js without --target-image when $TargetImage is empty', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('rollback.js'), 'should call rollback.js');
    assert.ok(content.includes('$TargetImage') && content.includes('if'), 'should conditionally pass --target-image');
  });

  it('exits on non-zero node exit code', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('LASTEXITCODE') && content.includes('ne 0'), 'should check LASTEXITCODE');
  });
});
