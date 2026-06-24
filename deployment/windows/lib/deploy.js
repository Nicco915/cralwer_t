const path = require('node:path');
const fs = require('node:fs');
const { execSync } = require('node:child_process');
const { recordCurrent } = require('./state.js');
const { startPm2 } = require('./pm2.js');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function getCurrentCommit(repoDir) {
  try {
    const output = execSync('git rev-parse HEAD', { cwd: repoDir, encoding: 'utf-8' });
    return output.trim();
  } catch (err) {
    throw new Error(`[deploy] getCurrentCommit failed: ${err.message}`);
  }
}

async function deploy({ installDir, repoUrl, branch = 'main' }) {
  ensureDir(installDir);

  const envPath = path.join(installDir, '.env');
  if (!fs.existsSync(envPath)) {
    throw new Error(`.env not found at ${envPath}. Please place it before deploying.`);
  }

  ensureDir(path.join(installDir, 'logs'));

  const gitDir = path.join(installDir, '.git');
  if (fs.existsSync(gitDir)) {
    try {
      execSync('git fetch origin', { cwd: installDir, encoding: 'utf-8', stdio: 'inherit' });
    } catch (err) {
      throw new Error(`[deploy] git fetch failed: ${err.message}`);
    }
    try {
      execSync(`git reset --hard origin/${branch}`, { cwd: installDir, encoding: 'utf-8', stdio: 'inherit' });
    } catch (err) {
      throw new Error(`[deploy] git reset failed: ${err.message}`);
    }
  } else {
    const entries = fs.readdirSync(installDir);
    if (entries.length > 0) {
      throw new Error(`Install directory ${installDir} is not empty and not a git repository.`);
    }
    try {
      execSync(`git clone --branch ${branch} --single-branch "${repoUrl}" "${installDir}"`, { encoding: 'utf-8', stdio: 'inherit' });
    } catch (err) {
      throw new Error(`[deploy] git clone failed: ${err.message}`);
    }
  }

  try {
    execSync('npm ci', { cwd: installDir, encoding: 'utf-8', stdio: 'inherit' });
  } catch (err) {
    throw new Error(`[deploy] npm ci failed: ${err.message}`);
  }

  startPm2(installDir);

  const commit = getCurrentCommit(installDir);
  recordCurrent(installDir, commit);

  return { success: true, commit };
}

module.exports = {
  deploy,
  ensureDir,
  getCurrentCommit,
};
