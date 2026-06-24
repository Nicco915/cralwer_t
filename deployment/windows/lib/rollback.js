const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { readState, setCurrentCommit } = require('./state.js');
const { waitForService } = require('./health-check.js');
const { reloadPm2 } = require('./pm2.js');

async function rollback({ installDir, targetCommit = null, healthCheckTimeoutMs = 30000 }) {
  if (!installDir || typeof installDir !== 'string') {
    throw new Error('installDir is required and must be a string');
  }

  const envPath = path.join(installDir, '.env');
  if (!fs.existsSync(envPath)) {
    throw new Error(`.env not found at ${envPath}`);
  }

  const state = readState(installDir);
  const oldCurrent = state.current;
  const commit = targetCommit || state.previous;
  if (!commit) {
    throw new Error('No previous commit recorded. Cannot rollback automatically.');
  }

  try {
    execSync(`git reset --hard ${commit}`, { cwd: installDir, encoding: 'utf-8', timeout: 60000 });
  } catch (err) {
    throw new Error(`[rollback] git reset failed: ${err.message}`);
  }

  try {
    execSync('npm ci', { cwd: installDir, encoding: 'utf-8', timeout: 120000 });
  } catch (err) {
    throw new Error(`[rollback] npm ci failed: ${err.message}`);
  }

  try {
    reloadPm2(installDir);
  } catch (err) {
    throw new Error(`[rollback] reloadPm2 failed: ${err.message}`);
  }

  const healthy = await waitForService('crawler', healthCheckTimeoutMs);
  if (!healthy) {
    throw new Error('[rollback] health check failed after rollback');
  }

  // 计算新的 previous：在 history 中找到 commit 后面的一个版本
  const historyIndex = state.history.indexOf(commit);
  let newPrevious = null;
  if (historyIndex !== -1 && historyIndex + 1 < state.history.length) {
    newPrevious = state.history[historyIndex + 1];
  }
  // 如果 history 中找不到，使用 oldCurrent 作为 fallback（可逆回滚）
  if (newPrevious === null) {
    newPrevious = oldCurrent;
  }

  setCurrentCommit(installDir, commit, newPrevious);

  return { success: true, commit };
}

module.exports = {
  rollback,
};
