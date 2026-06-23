const http = require('http');
const https = require('https');

function getJson(urlString) {
  return new Promise((resolve, reject) => {
    const client = urlString.startsWith('https:') ? https : http;
    const url = new URL(urlString);
    const req = client.get({ hostname: url.hostname, port: url.port, path: url.pathname + url.search }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => reject(new Error('request timeout')));
  });
}

async function main() {
  const statsUrl = process.argv[2] || 'http://127.0.0.1:3456/stats';
  const stats = await getJson(statsUrl);

  console.log(`[validate-remote] taskCount=${stats.taskCount}, callbackCount=${stats.callbackCount}, unique=${stats.uniqueCallbackCount}, success=${stats.successCallbacks}, failed=${stats.failedCallbacks}, duplicates=${stats.duplicateCallbacks}`);

  if (stats.uniqueCallbackCount !== stats.taskCount) {
    throw new Error(`Expected ${stats.taskCount} unique callbacks, got ${stats.uniqueCallbackCount}`);
  }
  if (stats.callbackCount !== stats.taskCount) {
    throw new Error(`Expected ${stats.taskCount} total callbacks (no duplicates), got ${stats.callbackCount}`);
  }
  if (stats.duplicateCallbacks !== 0) {
    throw new Error(`Expected 0 duplicate callbacks, got ${stats.duplicateCallbacks}`);
  }
  if (stats.failedCallbacks !== 0) {
    throw new Error(`Expected 0 failed callbacks, got ${stats.failedCallbacks}`);
  }

  console.log('[validate-remote] Multi-machine deployment validation PASSED');
}

main().catch((e) => {
  console.error('[validate-remote] FAILED:', e.message);
  process.exit(1);
});
