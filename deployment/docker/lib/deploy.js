const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { recordCurrent } = require('./state.js');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function deploy({ installDir, image }) {
  if (!installDir || typeof installDir !== 'string') {
    throw new Error('installDir is required and must be a string');
  }
  if (!image || typeof image !== 'string') {
    throw new Error('image is required and must be a string');
  }

  ensureDir(installDir);

  const envPath = path.join(installDir, '.env');
  if (!fs.existsSync(envPath)) {
    throw new Error(`.env not found at ${envPath}. Please place it before deploying.`);
  }

  ensureDir(path.join(installDir, 'logs'));
  ensureDir(path.join(installDir, 'output'));
  ensureDir(path.join(installDir, 'images'));

  const composeSource = path.join(__dirname, '..', 'docker-compose.yml');
  const composeTarget = path.join(installDir, 'docker-compose.yml');
  if (!fs.existsSync(composeTarget)) {
    fs.copyFileSync(composeSource, composeTarget);
  }

  try {
    execFileSync('docker', ['compose', 'up', '-d'], {
      cwd: installDir,
      encoding: 'utf-8',
      stdio: 'inherit',
      env: { ...process.env, CRAWLER_IMAGE: image },
    });
  } catch (err) {
    throw new Error(`[deploy] docker compose up failed: ${err.message}`);
  }

  recordCurrent(installDir, image);

  return { success: true, image };
}

module.exports = {
  deploy,
  ensureDir,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  function getArg(flag) {
    const index = args.indexOf(flag);
    if (index === -1) return undefined;
    if (index + 1 >= args.length || args[index + 1].startsWith('--')) {
      console.error(`Missing value for ${flag}`);
      process.exit(1);
    }
    return args[index + 1];
  }
  const installDir = getArg('--install-dir') || 'C:\\hs-sku-crawler';
  const image = getArg('--image');
  if (!image) {
    console.error('Usage: node deploy.js --image <image> [--install-dir <dir>]');
    process.exit(1);
  }
  deploy({ installDir, image })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
