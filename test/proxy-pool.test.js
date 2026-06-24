const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ProxyPool } = require('../src/proxy-pool');

test('partitions proxies by machine index and assigns per channel', async () => {
  const assignmentsFile = path.join(os.tmpdir(), `pool-${Date.now()}.json`);
  const client = {
    getKpsProxies: async () => [
      '1.1.1.1:8080', '2.2.2.2:8080', '3.3.3.3:8080',
      '4.4.4.4:8080', '5.5.5.5:8080', '6.6.6.6:8080',
    ],
  };
  const pool = new ProxyPool({
    client,
    machineIndex: 0,
    machineTotal: 2,
    channels: 2,
    assignmentsFile,
  });
  const map = await pool.assign();
  assert.deepStrictEqual(Object.keys(map).sort(), ['ch-1', 'ch-2']);
  assert.ok(map['ch-1'].startsWith('1.1.') || map['ch-1'].startsWith('3.3.') || map['ch-1'].startsWith('5.5.'));
  assert.ok(map['ch-2'].startsWith('1.1.') || map['ch-2'].startsWith('3.3.') || map['ch-2'].startsWith('5.5.'));
  assert.notStrictEqual(map['ch-1'], map['ch-2']);

  const saved = JSON.parse(fs.readFileSync(assignmentsFile, 'utf-8'));
  assert.deepStrictEqual(saved, map);

  try { fs.unlinkSync(assignmentsFile); } catch (e) {}
});

test('reuses previous assignment when IP is still in partition', async () => {
  const assignmentsFile = path.join(os.tmpdir(), `pool-${Date.now()}.json`);
  fs.writeFileSync(assignmentsFile, JSON.stringify({ 'ch-1': '2.2.2.2:8080' }));
  const client = {
    getKpsProxies: async () => [
      '1.1.1.1:8080', '2.2.2.2:8080', '3.3.3.3:8080', '4.4.4.4:8080',
    ],
  };
  const pool = new ProxyPool({ client, machineIndex: 1, machineTotal: 2, channels: 1, assignmentsFile });
  const map = await pool.assign();
  assert.strictEqual(map['ch-1'], '2.2.2.2:8080');
  try { fs.unlinkSync(assignmentsFile); } catch (e) {}
});

test('refresh reports changed channels', async () => {
  const assignmentsFile = path.join(os.tmpdir(), `pool-${Date.now()}.json`);
  const client = {
    getKpsProxies: async () => ['1.1.1.1:8080', '2.2.2.2:8080'],
  };
  const pool = new ProxyPool({ client, machineIndex: 0, machineTotal: 1, channels: 2, assignmentsFile });
  await pool.assign();
  // Mutate the underlying partition by changing the client response
  pool.client = {
    getKpsProxies: async () => ['3.3.3.3:8080', '4.4.4.4:8080'],
  };
  const changed = await pool.refresh();
  assert.strictEqual(changed.length, 2);
  try { fs.unlinkSync(assignmentsFile); } catch (e) {}
});

test('throws when partition is smaller than channel count', async () => {
  const client = {
    getKpsProxies: async () => ['1.1.1.1:8080'],
  };
  const pool = new ProxyPool({ client, machineIndex: 0, machineTotal: 1, channels: 2, assignmentsFile: path.join(os.tmpdir(), `pool-${Date.now()}.json`) });
  await assert.rejects(() => pool.assign(), /Proxy partition too small/);
});
