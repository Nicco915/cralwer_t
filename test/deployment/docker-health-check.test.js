const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const cp = require('node:child_process');

const originalExecSync = cp.execSync;
let calls = [];

describe('docker health-check', () => {
  before(() => {
    calls = [];
    cp.execSync = (cmd, opts) => {
      calls.push(cmd);
      if (cmd.includes('docker inspect')) {
        return 'running\n';
      }
      return originalExecSync(cmd, opts);
    };
  });

  it('isContainerRunning returns true when container is running', () => {
    // clear module cache to ensure mocked execSync is used
    delete require.cache[require.resolve('../../deployment/docker/lib/health-check.js')];
    const { isContainerRunning } = require('../../deployment/docker/lib/health-check.js');
    assert.strictEqual(isContainerRunning('hs-sku-crawler'), true);
    assert.ok(calls.some(c => c.includes('docker inspect')));
  });

  it('waitForContainer resolves true when container is running', async () => {
    delete require.cache[require.resolve('../../deployment/docker/lib/health-check.js')];
    const { waitForContainer } = require('../../deployment/docker/lib/health-check.js');
    const result = await waitForContainer('hs-sku-crawler', 1000, 100);
    assert.strictEqual(result, true);
  });

  it('waitForContainer resolves false when container never runs', async () => {
    delete require.cache[require.resolve('../../deployment/docker/lib/health-check.js')];
    cp.execSync = (cmd, opts) => {
      calls.push(cmd);
      if (cmd.includes('docker inspect')) {
        return 'exited\n';
      }
      return originalExecSync(cmd, opts);
    };
    const { waitForContainer } = require('../../deployment/docker/lib/health-check.js');
    const result = await waitForContainer('hs-sku-crawler', 200, 50);
    assert.strictEqual(result, false);
  });
});
