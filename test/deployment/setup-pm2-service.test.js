const { describe, it } = require('node:test');
const assert = require('node:assert');
const { execSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');

const scriptPath = path.resolve(__dirname, '../../deployment/windows/setup-pm2-service.ps1');

function invokePwshFunction(functionName, args = []) {
  const argString = args.map((a) => `"${a}"`).join(' ');
  return execSync(
    `powershell -NoProfile -Command "& { . '${scriptPath}'; ${functionName} ${argString} }"`,
    { encoding: 'utf-8', timeout: 30000 }
  );
}

describe('setup-pm2-service.ps1 functions', () => {
  it('Test-NpmPrefixInUserProfile returns True or False', { skip: os.platform() !== 'win32' }, () => {
    const output = invokePwshFunction('Test-NpmPrefixInUserProfile');
    const result = output.trim();
    assert.ok(result === 'True' || result === 'False', `Unexpected output: ${result}`);
  });

  it('Wait-ServiceStatus returns False for a non-existent service', { skip: os.platform() !== 'win32' }, () => {
    const output = invokePwshFunction('Wait-ServiceStatus', [
      'NonExistentServiceForTest',
      'Running',
      '3',
      '1',
    ]);
    const result = output.trim();
    assert.strictEqual(result, 'False');
  });

  it('Get-ProjectRootFromScriptRoot returns a string path', { skip: os.platform() !== 'win32' }, () => {
    const output = invokePwshFunction('Get-ProjectRootFromScriptRoot');
    const result = output.trim();
    assert.ok(result.length > 0, `Unexpected output: ${result}`);
  });

  it('Get-Pm2ServiceLog does not throw', { skip: os.platform() !== 'win32' }, () => {
    const output = invokePwshFunction('Get-Pm2ServiceLog');
    assert.strictEqual(typeof output, 'string');
  });
});
