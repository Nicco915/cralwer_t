const { execFileSync } = require('node:child_process');

function isContainerRunning(containerName = 'hs-sku-crawler') {
  try {
    const output = execFileSync(
      'docker',
      ['inspect', '--format={{.State.Status}}', containerName],
      { encoding: 'utf-8', timeout: 10000 }
    );
    return output.trim() === 'running';
  } catch {
    return false;
  }
}

function waitForContainer(containerName = 'hs-sku-crawler', timeoutMs = 30000, intervalMs = 2000) {
  return new Promise((resolve) => {
    const start = Date.now();
    let timer = null;
    function check() {
      if (isContainerRunning(containerName)) {
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
  isContainerRunning,
  waitForContainer,
};
