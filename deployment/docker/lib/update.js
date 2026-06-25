const fs = require('node:fs');
const path = require('node:path');
const { execSync, execFileSync } = require('node:child_process');
const { readState, writeState, recordCurrent, setCurrentImage } = require('./state.js');
const { waitForContainer, DEFAULT_CONTAINER_NAME } = require('./health-check.js');

async function update({ installDir, imageTag, healthCheckTimeoutMs = 30000 }) {
  if (!installDir || typeof installDir !== 'string') {
    throw new Error('installDir is required and must be a string');
  }
  if (!imageTag || typeof imageTag !== 'string') {
    throw new Error('imageTag is required and must be a string');
  }

  const envPath = path.join(installDir, '.env');
  if (!fs.existsSync(envPath)) {
    throw new Error(`.env not found at ${envPath}`);
  }

  const state = readState(installDir);
  const previousImage = state.current;
  const oldPrevious = state.previous;
  state.previous = previousImage;
  writeState(installDir, state);

  const newImage = imageTag.includes(':') ? imageTag : `${imageTag}:latest`;

  try {
    return await performUpdate(installDir, newImage, healthCheckTimeoutMs, previousImage, oldPrevious);
  } catch (err) {
    if (previousImage) {
      console.error(`Update failed, rolling back to ${previousImage}...`);
      try {
        execSync('docker compose up -d', {
          cwd: installDir,
          encoding: 'utf-8',
          stdio: 'inherit',
          env: { ...process.env, CRAWLER_IMAGE: previousImage },
        });
        const online = await waitForContainer(DEFAULT_CONTAINER_NAME, healthCheckTimeoutMs);
        if (!online) {
          throw new Error('[update] health check failed after rollback');
        }
        setCurrentImage(installDir, previousImage, oldPrevious);
      } catch (rollbackErr) {
        console.error(`Rollback also failed: ${rollbackErr.message}`);
        throw new Error(`Update failed and rollback failed: ${err.message}\nRollback error: ${rollbackErr.message}`);
      }
    }
    throw new Error(`Update failed: ${err.message}`);
  }
}

async function performUpdate(installDir, newImage, healthCheckTimeoutMs, previousImage, oldPrevious) {
  try {
    execFileSync('docker', ['pull', newImage], { encoding: 'utf-8', stdio: 'inherit', timeout: 120000 });
  } catch (err) {
    throw new Error(`[update] docker pull failed: ${err.message}`);
  }

  try {
    execSync('docker compose up -d', {
      cwd: installDir,
      encoding: 'utf-8',
      stdio: 'inherit',
      env: { ...process.env, CRAWLER_IMAGE: newImage },
    });
  } catch (err) {
    throw new Error(`[update] docker compose up failed: ${err.message}`);
  }

  const healthy = await waitForContainer(DEFAULT_CONTAINER_NAME, healthCheckTimeoutMs);
  if (!healthy) {
    throw new Error('[update] health check failed after update');
  }

  recordCurrent(installDir, newImage);

  return { success: true, previousImage, currentImage: newImage };
}

module.exports = {
  update,
  performUpdate,
  readState,
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
  const imageTag = getArg('--image-tag');
  if (!imageTag) {
    console.error('Usage: node update.js --image-tag <tag> [--install-dir <dir>]');
    process.exit(1);
  }
  update({ installDir, imageTag })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
