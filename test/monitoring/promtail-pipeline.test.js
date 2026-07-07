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

describe('Promtail pipeline (Loki query)', { timeout: 60000 }, () => {
  let skipReason = null;
  before(async () => {
    if (!lokiAvailable()) {
      skipReason = 'Loki not running on 127.0.0.1:3100';
      console.log(`[promtail-pipeline] ${skipReason}; skipping`);
    }
  });

  it('pushed line with sku field is queryable by sku', async () => {
    if (skipReason) return;
    const sku = `PROMTAIL-TEST-${Date.now()}`;
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level: 'INFO',
      component: 'task',
      msg: 'finished',
      sku,
      status: 'error',
      error: 'timeout exceeded',
      durationMs: 12345,
      channelId: 2,
      crawlerTaskId: 9001,
      nodeCode: 'crawler-test',
    });
    const status = await lokiPush({ app: 'crawler', job: 'pipeline-test' }, line);
    assert.strictEqual(status, 204);

    await new Promise(r => setTimeout(r, 3000));
    const r = await lokiQuery(`{app="crawler"} | json | sku="${sku}"`);
    assert.strictEqual(r.status, 'success');
    assert.ok(r.data.result.length > 0, 'Loki must return at least one stream');
  });

  it('pushed line with status field is queryable by status', async () => {
    if (skipReason) return;
    const status = 'success';
    const sku = `STATUS-TEST-${Date.now()}`;
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level: 'INFO',
      component: 'task',
      msg: 'finished',
      sku,
      status,
      error: '',
      durationMs: 1000,
      channelId: 1,
      crawlerTaskId: 9002,
      nodeCode: 'crawler-test',
    });
    const pushStatus = await lokiPush({ app: 'crawler', job: 'pipeline-test' }, line);
    assert.strictEqual(pushStatus, 204);

    await new Promise(r => setTimeout(r, 3000));
    const r = await lokiQuery(`{app="crawler"} | json | sku="${sku}" | status="${status}"`);
    assert.strictEqual(r.status, 'success');
    assert.ok(r.data.result.length > 0);
  });
});
