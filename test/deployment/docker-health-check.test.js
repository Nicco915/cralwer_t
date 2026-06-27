const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const cp = require('node:child_process');

const originalExecSync = cp.execSync;
const originalExecFileSync = cp.execFileSync;
let calls = [];
const modulePath = require.resolve('../../deployment/docker/lib/health-check.js');

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
    cp.execFileSync = (file, args, opts) => {
      calls.push([file, args].join(' '));
      if (file === 'docker' && args.includes('inspect')) {
        return 'running\n';
      }
      return originalExecFileSync(file, args, opts);
    };
  });

  after(() => {
    cp.execSync = originalExecSync;
    cp.execFileSync = originalExecFileSync;
    delete require.cache[modulePath];
  });

  it('isContainerRunning returns true when container is running', () => {
    delete require.cache[modulePath];
    const { isContainerRunning } = require(modulePath);
    assert.strictEqual(isContainerRunning('hs-sku-crawler'), true);
    assert.ok(calls.some(c => c.includes('docker inspect')));
  });

  it('waitForContainer resolves true when container is running', async () => {
    delete require.cache[modulePath];
    const { waitForContainer } = require(modulePath);
    const result = await waitForContainer('hs-sku-crawler', 1000, 100);
    assert.strictEqual(result, true);
  });

  it('waitForContainer resolves false when container never runs', async () => {
    delete require.cache[modulePath];
    cp.execFileSync = (file, args, opts) => {
      calls.push([file, args].join(' '));
      if (file === 'docker' && args.includes('inspect')) {
        return 'exited\n';
      }
      return originalExecFileSync(file, args, opts);
    };
    const { waitForContainer } = require(modulePath);
    const result = await waitForContainer('hs-sku-crawler', 200, 50);
    assert.strictEqual(result, false);
  });

  it('isContainerRunning returns false when docker inspect fails', () => {
    delete require.cache[modulePath];
    cp.execFileSync = (file, args, opts) => {
      throw new Error('docker not found');
    };
    const { isContainerRunning } = require(modulePath);
    assert.strictEqual(isContainerRunning('hs-sku-crawler'), false);
  });
});
