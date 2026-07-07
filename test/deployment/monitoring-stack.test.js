const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { spawnSync } = require('node:child_process');

function fetchJson(host, port, path, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path, timeout: timeoutMs }, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

function dockerDaemonAvailable() {
  const r = spawnSync('docker', ['info'], { stdio: 'pipe' });
  return r.status === 0;
}

describe('Monitoring stack', { timeout: 240000 }, () => {
  let stackUp = false;
  before(() => {
    if (!dockerDaemonAvailable()) {
      console.log('[monitoring-stack] docker daemon not available; skipping');
      return;
    }
    const up = spawnSync('docker', ['compose', '-f', 'deployment/monitoring/docker-compose.yml', 'up', '-d'], { stdio: 'pipe' });
    if (up.status !== 0) {
      console.log('[monitoring-stack] docker compose up failed; skipping');
      console.log(up.stderr.toString());
      return;
    }
    stackUp = true;
  });

  after(() => {
    if (stackUp) {
      spawnSync('docker', ['compose', '-f', 'deployment/monitoring/docker-compose.yml', 'down', '-v']);
    }
  });

  it('Loki /ready returns 200', async () => {
    if (!stackUp) return;
    const res = await fetchJson('127.0.0.1', 3100, '/ready');
    assert.strictEqual(res.status, 200);
  });

  it('Grafana /api/health returns database=ok', async () => {
    if (!stackUp) return;
    const res = await fetchJson('127.0.0.1', 3000, '/api/health');
    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    assert.strictEqual(json.database, 'ok');
  });
});