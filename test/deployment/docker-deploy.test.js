const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');

const originalExecSync = cp.execSync;
let commands = [];

describe('docker deploy', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-deploy-test-'));
    commands = [];
    cp.execSync = (cmd, opts) => {
      commands.push({ cmd, cwd: opts?.cwd, env: opts?.env });
      if (cmd.includes('docker compose')) return '';
      return originalExecSync(cmd, opts);
    };
  });

  after(() => {
    cp.execSync = originalExecSync;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('deploy throws when .env is missing', async () => {
    delete require.cache[require.resolve('../../deployment/docker/lib/deploy.js')];
    const { deploy } = require('../../deployment/docker/lib/deploy.js');
    const installDir = path.join(tmpDir, 'no-env');
    fs.mkdirSync(installDir, { recursive: true });

    await assert.rejects(
      async () => deploy({ installDir, image: 'registry/a:1' }),
      {
        message: new RegExp(`\\.env not found at .* Please place it before deploying\\.`),
      }
    );
  });

  it('deploy creates directories and runs docker compose', async () => {
    delete require.cache[require.resolve('../../deployment/docker/lib/deploy.js')];
    const { deploy } = require('../../deployment/docker/lib/deploy.js');
    const installDir = path.join(tmpDir, 'deploy-ok');
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(path.join(installDir, '.env'), 'TEST=1\n');

    const result = await deploy({ installDir, image: 'registry/a:1' });

    assert.strictEqual(result.success, true);
    assert.ok(fs.existsSync(path.join(installDir, 'logs')));
    assert.ok(fs.existsSync(path.join(installDir, 'output')));
    assert.ok(fs.existsSync(path.join(installDir, 'images')));
    assert.ok(fs.existsSync(path.join(installDir, 'docker-compose.yml')));
    assert.ok(commands.some(c => c.cmd.includes('docker compose up -d')));
    const composeCmd = commands.find(c => c.cmd.includes('docker compose up -d'));
    assert.strictEqual(composeCmd.env.CRAWLER_IMAGE, 'registry/a:1');
  });
});
