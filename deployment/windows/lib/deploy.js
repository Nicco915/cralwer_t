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
  const repoUrl = getArg('--repo-url');
  const branch = getArg('--branch') || 'main';
  const installDir = getArg('--install-dir') || 'C:\\hs-sku-crawler';
  if (!repoUrl) {
    console.error('Usage: node deploy.js --repo-url <url> [--branch <branch>] [--install-dir <dir>]');
    process.exit(1);
  }
  deploy({ repoUrl, branch, installDir })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
