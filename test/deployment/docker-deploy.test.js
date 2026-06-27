const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');

const originalExecFileSync = cp.execFileSync;
const deployModulePath = path.resolve(__dirname, '../../deployment/docker/lib/deploy.js');
let tmpDir;
let commands;

describe('docker deploy', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-deploy-test-'));
    commands = [];
    cp.execFileSync = (file, args, opts) => {
      commands.push({ file, args, cwd: opts?.cwd, env: opts?.env });
      if (file === 'docker' && args.includes('compose') && args.includes('up')) {
        return '';
      }
      return originalExecFileSync(file, args, opts);
    };
    delete require.cache[deployModulePath];
  });

  afterEach(() => {
    cp.execFileSync = originalExecFileSync;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[deployModulePath];
  });

  it('deploy throws when .env is missing', async () => {
    const { deploy } = require(deployModulePath);
    const installDir = path.join(tmpDir, 'no-env');
    fs.mkdirSync(installDir, { recursive: true });

    await assert.rejects(
      async () => deploy({ installDir, image: 'registry/a:1' }),
      /\.env not found at .* Please place it before deploying\./
    );
  });

  it('deploy throws when installDir is missing', async () => {
    const { deploy } = require(deployModulePath);
    await assert.rejects(
      async () => deploy({ image: 'registry/a:1' }),
      /installDir is required and must be a string/
    );
  });

  it('deploy throws when image is missing', async () => {
    const { deploy } = require(deployModulePath);
    const installDir = path.join(tmpDir, 'no-image');
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(path.join(installDir, '.env'), 'TEST=1\n');

    await assert.rejects(
      async () => deploy({ installDir }),
      /image is required and must be a string/
    );
  });

  it('deploy creates directories and runs docker compose', async () => {
    const { deploy } = require(deployModulePath);
    const installDir = path.join(tmpDir, 'deploy-ok');
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(path.join(installDir, '.env'), 'TEST=1\n');

    const result = await deploy({ installDir, image: 'registry/a:1' });

    assert.strictEqual(result.success, true);
    assert.ok(fs.existsSync(path.join(installDir, 'logs')));
    assert.ok(fs.existsSync(path.join(installDir, 'output')));
    assert.ok(fs.existsSync(path.join(installDir, 'images')));
    assert.ok(fs.existsSync(path.join(installDir, 'docker-compose.yml')));
    const composeCmd = commands.find(c => c.file === 'docker' && c.args.includes('compose') && c.args.includes('up'));
    assert.ok(composeCmd, 'docker compose up -d should be called');
    assert.strictEqual(composeCmd.env?.CRAWLER_IMAGE, 'registry/a:1');
  });

  it('deploy skips copying docker-compose.yml if it already exists', async () => {
    const { deploy } = require(deployModulePath);
    const installDir = path.join(tmpDir, 'compose-exists');
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(path.join(installDir, '.env'), 'TEST=1\n');
    fs.writeFileSync(path.join(installDir, 'docker-compose.yml'), 'existing');

    await deploy({ installDir, image: 'registry/a:1' });

    const content = fs.readFileSync(path.join(installDir, 'docker-compose.yml'), 'utf-8');
    assert.strictEqual(content, 'existing');
  });

  it('deploy throws when docker compose fails', async () => {
    cp.execFileSync = (file, args, opts) => {
      if (file === 'docker' && args.includes('compose') && args.includes('up')) {
        throw new Error('docker compose up failed');
      }
      return originalExecFileSync(file, args, opts);
    };
    const { deploy } = require(deployModulePath);
    const installDir = path.join(tmpDir, 'compose-fail');
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(path.join(installDir, '.env'), 'TEST=1\n');

    await assert.rejects(
      async () => deploy({ installDir, image: 'registry/a:1' }),
      /\[deploy\] docker compose up failed/
    );
    assert.ok(!fs.existsSync(path.join(installDir, '.deployment-state.json')), 'state file should not be written on failure');
  });
});
