const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readState, writeState } = require('./state.js');
const { waitForContainer, DEFAULT_CONTAINER_NAME } = require('./health-check.js');

async function rollback({ installDir, targetImage = null, healthCheckTimeoutMs = 30000 }) {
  if (typeof installDir !== 'string') {
    throw new Error('installDir is required and must be a string');
  }

  const envPath = path.join(installDir, '.env');
  if (!fs.existsSync(envPath)) {
    throw new Error(`.env not found at ${envPath}`);
  }

  const state = readState(installDir);
  const image = targetImage || state.previous;
  if (!image) {
    throw new Error('No target image available for rollback');
  }

  execFileSync('docker', ['compose', 'up', '-d'], {
    cwd: installDir,
    encoding: 'utf-8',
    stdio: 'inherit',
    env: { ...process.env, CRAWLER_IMAGE: image },
  });

  const healthy = await waitForContainer(DEFAULT_CONTAINER_NAME, healthCheckTimeoutMs);
  if (!healthy) {
    // Rollback itself failed to become healthy; there is no further automatic
    // fallback. The operator must inspect the container and intervene manually.
    throw new Error('[rollback] health check failed after rollback');
  }

  const originalCurrent = state.current;
  let newPrevious = originalCurrent;
  // history is maintained newest-first by state.js; the entry before the target
  // in the array is the image deployed immediately after it.
  const idx = state.history.indexOf(image);
  if (idx !== -1 && idx > 0) {
    newPrevious = state.history[idx - 1];
  }
  // When the target is the newest image in history (idx === 0) or not in
  // history at all, fall back to the original current as the previous reference.

  state.current = image;
  state.previous = newPrevious;
  writeState(installDir, state);

  return { success: true, image };
}

module.exports = { rollback };

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
  const targetImage = getArg('--target-image') || null;
  rollback({ installDir, targetImage })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
