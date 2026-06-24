const { execSync } = require('node:child_process');

function isServiceOnline(appName = 'crawler') {
  try {
    const output = execSync('pm2 jlist', { encoding: 'utf-8', timeout: 10000 });
    const list = JSON.parse(output);
    const app = list.find(item => item.name === appName);
    if (!app || !app.pm2_env) {
      return false;
    }
    return app.pm2_env.status === 'online';
  } catch {
    return false;
  }
}

function waitForService(appName = 'crawler', timeoutMs = 30000, intervalMs = 2000) {
  return new Promise((resolve) => {
    const start = Date.now();
    let timer = null;
    function check() {
      if (isServiceOnline(appName)) {
        if (timer) clearTimeout(timer);
        resolve(true);
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        resolve(false);
        return;
      }
      timer = setTimeout(check, intervalMs);
    }
    check();
  });
}

module.exports = {
  isServiceOnline,
  waitForService,
};
