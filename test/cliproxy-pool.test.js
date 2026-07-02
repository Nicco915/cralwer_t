const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CliproxyPool } = require('../src/cliproxy-pool');

function createPool(options = {}, assignmentsFile = null) {
  return new CliproxyPool({
    host: 'test.cliproxy.io',
    port: 1080,
    username: 'testuser',
    password: 'testpass',
    region: 'EU',
    stickyMinutes: 30,
    sessionPrefix: 'crawler-eu-01',
    channels: 2,
    assignmentsFile: assignmentsFile || path.join(os.tmpdir(), `cliproxy-${Date.now()}.json`),
    ...options,
  });
}

describe('CliproxyPool', () => {
  it('generates a sticky proxy URL per channel', async () => {
    const pool = createPool();
    const map = await pool.assign();

    assert.deepStrictEqual(Object.keys(map).sort(), ['ch-1', 'ch-2']);
    assert.ok(map['ch-1'].startsWith('http://testuser-region-EU-sid-crawler-eu-01-ch1-'));
    assert.ok(map['ch-1'].includes(':testpass@test.cliproxy.io:1080'));
    assert.notStrictEqual(map['ch-1'], map['ch-2']);

    try { fs.unlinkSync(pool.assignmentsFile); } catch (e) {}
  });

  it('reuses previous assignment on restart', async () => {
    const assignmentsFile = path.join(os.tmpdir(), `cliproxy-${Date.now()}.json`);
    const pool1 = createPool({}, assignmentsFile);
    const map1 = await pool1.assign();

    const pool2 = createPool({}, assignmentsFile);
    const map2 = await pool2.assign();

    assert.strictEqual(map1['ch-1'], map2['ch-1']);
    assert.strictEqual(map1['ch-2'], map2['ch-2']);

    try { fs.unlinkSync(assignmentsFile); } catch (e) {}
  });

  it('rotates to a new URL on nextForChannel', async () => {
    const pool = createPool();
    await pool.assign();
    const oldUrl = pool.getProxyForChannel('ch-1');

    const newUrl = await pool.nextForChannel('ch-1');

    assert.notStrictEqual(newUrl, oldUrl);
    assert.strictEqual(pool.getProxyForChannel('ch-1'), newUrl);

    try { fs.unlinkSync(pool.assignmentsFile); } catch (e) {}
  });

  it('respects rotation cooldown', async () => {
    const pool = createPool({ rotationCooldownMs: 1000 });
    await pool.assign();
    const oldUrl = pool.getProxyForChannel('ch-1');

    const newUrl = await pool.nextForChannel('ch-1');
    const newUrl2 = await pool.nextForChannel('ch-1');

    assert.notStrictEqual(newUrl, oldUrl);
    assert.strictEqual(newUrl, newUrl2);

    try { fs.unlinkSync(pool.assignmentsFile); } catch (e) {}
  });

  it('reuses nonce from previous URL even when sessionPrefix contains dashes', async () => {
    const assignmentsFile = path.join(os.tmpdir(), `cliproxy-${Date.now()}.json`);
    const pool1 = createPool({ sessionPrefix: 'crawler-t-01' }, assignmentsFile);
    const map1 = await pool1.assign();

    const pool2 = createPool({ sessionPrefix: 'crawler-t-01' }, assignmentsFile);
    const map2 = await pool2.assign();

    assert.strictEqual(map1['ch-1'], map2['ch-1']);
    assert.strictEqual(map1['ch-2'], map2['ch-2']);

    try { fs.unlinkSync(assignmentsFile); } catch (e) {}
  });
});
