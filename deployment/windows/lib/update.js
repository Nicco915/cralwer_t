const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { readState, writeState, recordCurrent, setCurrentCommit } = require('./state.js');
const { waitForService } = require('./health-check.js');
const { reloadPm2 } = require('./pm2.js');

async function update({ installDir, branch = 'main', healthCheckTimeoutMs = 30000 }) {
  if (!installDir || typeof installDir !== 'string') {
    throw new Error('installDir is required and must be a string');
  }

  const envPath = path.join(installDir, '.env');
  if (!fs.existsSync(envPath)) {
    throw new Error(`.env not found at ${envPath}`);
  }

  const state = readState(installDir);
  const previousCommit = state.current;
  const oldPrevious = state.previous;
  state.previous = previousCommit;
  writeState(installDir, state);

  try {
    return await performUpdate(installDir, branch, healthCheckTimeoutMs, previousCommit, oldPrevious);
  } catch (err) {
    if (previousCommit) {
      console.error(`Update failed, rolling back to ${previousCommit}...`);
      try {
        execSync(`git reset --hard ${previousCommit}`, { cwd: installDir, stdio: 'inherit' });
        execSync('npm ci', { cwd: installDir, stdio: 'inherit' });
        reloadPm2(installDir);
        const online = await waitForService('crawler', healthCheckTimeoutMs);
        if (!online) {
          throw new Error('[update] waitForService failed after rollback');
        }
        setCurrentCommit(installDir, previousCommit, oldPrevious);
      } catch (rollbackErr) {
        console.error(`Rollback also failed: ${rollbackErr.message}`);
        throw new Error(`Update failed and rollback failed: ${err.message}\nRollback error: ${rollbackErr.message}`);
      }
    }
    throw new Error(`Update failed: ${err.message}`);
  }
}

async function performUpdate(installDir, branch, healthCheckTimeoutMs, previousCommit, oldPrevious) {
  try {
    execSync('git fetch origin', { cwd: installDir, encoding: 'utf-8', timeout: 60000 });
  } catch (err) {
    throw new Error(`[update] git fetch failed: ${err.message}`);
  }
  try {
    execSync(`git reset --hard origin/${branch}`, { cwd: installDir, encoding: 'utf-8', timeout: 60000 });
  } catch (err) {
    throw new Error(`[update] git reset failed: ${err.message}`);
  }
  try {
    execSync('npm ci', { cwd: installDir, encoding: 'utf-8', timeout: 120000 });
  } catch (err) {
    throw new Error(`[update] npm ci failed: ${err.message}`);
  }
  try {
    reloadPm2(installDir);
  } catch (err) {
    throw new Error(`[update] reloadPm2 failed: ${err.message}`);
  }

  const healthy = await waitForService('crawler', healthCheckTimeoutMs);
  if (!healthy) {
    throw new Error('[update] health check failed after update');
  }

  const newCommit = execSync('git rev-parse HEAD', { cwd: installDir, encoding: 'utf-8', timeout: 10000 }).trim();
  recordCurrent(installDir, newCommit);

  return { success: true, previousCommit, currentCommit: newCommit };
}

module.exports = {
  update,
  performUpdate,
};
