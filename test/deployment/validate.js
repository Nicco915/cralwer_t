const http = require('http');

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: 3456, path }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function waitForTasks(taskCount, timeoutMs = 300000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const stats = await getJson('/stats');
    console.log(`[validate] unique=${stats.uniqueCallbackCount}/${taskCount}, total=${stats.callbackCount}, success=${stats.successCallbacks}, failed=${stats.failedCallbacks}, duplicates=${stats.duplicateCallbacks}`);
    if (stats.uniqueCallbackCount >= taskCount) {
      return stats;
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error(`Timeout waiting for ${taskCount} unique callbacks`);
}

async function main() {
  const taskCount = 30;
  const stats = await waitForTasks(taskCount);

  if (stats.uniqueCallbackCount !== taskCount) {
    throw new Error(`Expected ${taskCount} unique callbacks, got ${stats.uniqueCallbackCount}`);
  }
  if (stats.callbackCount !== taskCount) {
    throw new Error(`Expected ${taskCount} total callbacks (no duplicates), got ${stats.callbackCount}`);
  }
  if (stats.duplicateCallbacks !== 0) {
    throw new Error(`Expected 0 duplicate callbacks, got ${stats.duplicateCallbacks}`);
  }
  if (stats.successCallbacks !== taskCount) {
    throw new Error(`Expected ${taskCount} successful callbacks, got ${stats.successCallbacks}`);
  }
  if (stats.failedCallbacks !== 0) {
    throw new Error(`Expected 0 failed callbacks, got ${stats.failedCallbacks}`);
  }

  console.log('[validate] Multi-machine deployment test PASSED');
}

main().catch((e) => {
  console.error('[validate] FAILED:', e.message);
  process.exit(1);
});
