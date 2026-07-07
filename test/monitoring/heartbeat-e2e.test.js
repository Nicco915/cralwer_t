const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { spawnSync } = require('node:child_process');

function lokiQuery(query, host = '127.0.0.1', port = 3100) {
  return new Promise((resolve, reject) => {
    const path = `/loki/api/v1/query?query=${encodeURIComponent(query)}`;
    const req = http.get({ host, port, path, timeout: 8000 }, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => {
        try {
          resolve(JSON.parse(buf));
        } catch (e) {
          reject(new Error(`Invalid JSON: ${buf}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

function lokiPush(stream, line, host = '127.0.0.1', port = 3100) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      streams: [{
        stream,
        values: [[String(Date.now() * 1e6), line]],
      }],
    });
    const req = http.request({
      host, port, method: 'POST', path: '/loki/api/v1/push',
      headers: { 'Content-Type': 'application/json' },
    }, res => {
      res.on('data', () => {});
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function lokiAvailable() {
  const r = spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', 'http://127.0.0.1:3100/ready']);
  return r.status === 0 && r.stdout.toString() === '200';
}

describe('Loki end-to-end with synthetic heartbeat', { timeout: 60000 }, () => {
  let skipReason = null;

  before(() => {
    if (!lokiAvailable()) {
      skipReason = 'Loki not running on 127.0.0.1:3100';
      console.log(`[heartbeat-e2e] ${skipReason}; skipping`);
    }
  });

  function dockerContainerAvailable() {
    const r = spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', 'monitoring-loki'], { stdio: 'pipe' });
    return r.status === 0 && r.stdout.toString().trim() === 'true';
  }

  it('heartbeat lines are queryable by nodeCode', async () => {
    if (skipReason) return;
    const nodeCode = `e2e-hb-${Date.now()}`;
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level: 'INFO',
      component: 'heartbeat',
      msg: 'alive',
      nodeCode,
      uptime: 60,
      channels: 0,
      pending: 0,
      running: 0,
      browserConnected: true,
    });
    const status = await lokiPush({ app: 'crawler', job: 'e2e' }, line);
    assert.strictEqual(status, 204);

    await new Promise(r => setTimeout(r, 3000));
    const r = await lokiQuery(`{app="crawler"} | json | component="heartbeat" | nodeCode="${nodeCode}"`);
    assert.strictEqual(r.status, 'success');
    assert.ok(r.data.result.length > 0, 'Loki must return at least one stream');
  });

  it('messages are queryable after restarting Loki within 60s', { timeout: 180000 }, async () => {
    if (skipReason) return;
    if (!dockerContainerAvailable()) {
      console.log('[heartbeat-e2e] monitoring-loki container not present; skipping restart test');
      return;
    }

    const nodeCode = `e2e-restart-${Date.now()}`;
    const baselineLine = JSON.stringify({
      time: new Date().toISOString(),
      level: 'INFO',
      component: 'heartbeat',
      msg: 'alive',
      nodeCode,
      uptime: 60,
    });
    const baselineStatus = await lokiPush({ app: 'crawler', job: 'e2e-restart' }, baselineLine);
    assert.strictEqual(baselineStatus, 204);

    // stop Loki
    spawnSync('docker', ['stop', 'monitoring-loki'], { stdio: 'pipe' });

    // 推一条到 disabled Loki 应失败
    await new Promise(r => setTimeout(r, 2000));
    const failStatus = await new Promise(resolve => {
      const req = http.request({
        host: '127.0.0.1', port: 3100, method: 'POST', path: '/loki/api/v1/push',
        timeout: 3000,
      }, res => {
        res.on('data', () => {});
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', () => resolve(0));
      req.on('timeout', () => { req.destroy(); resolve(0); });
      req.end();
    });
    assert.ok(failStatus === 0 || failStatus >= 500, `Loki should be unreachable while stopped, got ${failStatus}`);

    // restart
    spawnSync('docker', ['start', 'monitoring-loki'], { stdio: 'pipe' });
    await new Promise(r => setTimeout(r, 30000)); // wait for /ready

    // 推一条新
    const newLine = JSON.stringify({
      time: new Date().toISOString(),
      level: 'INFO',
      component: 'heartbeat',
      msg: 'alive',
      nodeCode: `${nodeCode}-after`,
      uptime: 90,
    });
    const newStatus = await lokiPush({ app: 'crawler', job: 'e2e-restart' }, newLine);
    assert.strictEqual(newStatus, 204);

    await new Promise(r => setTimeout(r, 3000));
    const r = await lokiQuery(`{app="crawler"} | json | nodeCode="${nodeCode}-after"`);
    assert.strictEqual(r.status, 'success');
    assert.ok(r.data.result.length > 0);
  });
});
