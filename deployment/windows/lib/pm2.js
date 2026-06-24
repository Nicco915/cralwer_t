const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

function getEcosystemPath(installDir) {
  return path.join(installDir, 'deployment', 'windows', 'ecosystem.config.js');
}

function startPm2(installDir) {
  const ecosystemPath = getEcosystemPath(installDir);
  if (fs.existsSync(ecosystemPath)) {
    execSync(`pm2 start "${ecosystemPath}"`, { cwd: installDir, stdio: 'inherit' });
  } else {
    execSync('pm2 start bin/run.js --name crawler -- --mode=service', { cwd: installDir, stdio: 'inherit' });
  }
  execSync('pm2 save', { cwd: installDir, stdio: 'inherit' });
}

function reloadPm2(installDir) {
  const ecosystemPath = getEcosystemPath(installDir);
  if (fs.existsSync(ecosystemPath)) {
    execSync(`pm2 reload "${ecosystemPath}"`, { cwd: installDir, stdio: 'inherit' });
  } else {
    execSync('pm2 reload crawler', { cwd: installDir, stdio: 'inherit' });
  }
}

module.exports = { startPm2, reloadPm2 };
