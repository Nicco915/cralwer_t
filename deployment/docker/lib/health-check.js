const { execFileSync } = require('node:child_process');

const DEFAULT_CONTAINER_NAME = 'hs-sku-crawler';

function isContainerRunning(containerName = DEFAULT_CONTAINER_NAME) {
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

function waitForContainer(containerName = DEFAULT_CONTAINER_NAME, timeoutMs = 30000, intervalMs = 2000) {
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
  DEFAULT_CONTAINER_NAME,
  isContainerRunning,
  waitForContainer,
};
