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
    sessionPrefix: 'crawler-01',
    channels: 2,
    assignmentsFile: assignmentsFile || path.join(os.tmpdir(), `cliproxy-${Date.now()}.json`),
    ...options,
  });
}

describe('CliproxyPool', () => {
  it('generates a sticky proxy URL per channel using provider-compatible defaults', async () => {
    const pool = createPool();
    const map = await pool.assign();

    assert.deepStrictEqual(Object.keys(map).sort(), ['ch-1', 'ch-2']);
    assert.ok(
      map['ch-1'].startsWith('http://testuser-country-EU-session-crawler-01-ch1-'),
      `unexpected URL format: ${map['ch-1']}`
    );
    assert.ok(map['ch-1'].includes('-sticky-30'));
    assert.ok(map['ch-1'].includes(':testpass@test.cliproxy.io:1080'));
    assert.notStrictEqual(map['ch-1'], map['ch-2']);

    try { fs.unlinkSync(pool.assignmentsFile); } catch (e) {}
  });

  it('supports legacy username format via param name overrides', async () => {
    const pool = createPool({
      regionParamName: 'region',
      sessionParamName: 'sid',
      stickyParamName: 't',
    });
    const map = await pool.assign();

    assert.ok(
      map['ch-1'].startsWith('http://testuser-region-EU-sid-crawler-01-ch1-'),
      `unexpected legacy URL format: ${map['ch-1']}`
    );
    assert.ok(map['ch-1'].includes('-t-30'));

    try { fs.unlinkSync(pool.assignmentsFile); } catch (e) {}
  });

  it('supports ASN parameter in username when configured', async () => {
    const pool = createPool({
      regionParamName: 'region',
      asn: 'AS12897',
      asnParamName: 'asn',
      sessionParamName: 'sid',
      stickyParamName: 't',
      stickyMinutes: 5,
    });
    const map = await pool.assign();

    assert.ok(
      map['ch-1'].startsWith('http://testuser-region-EU-asn-AS12897-sid-crawler-01-ch1-'),
      `unexpected ASN URL format: ${map['ch-1']}`
    );
    assert.ok(map['ch-1'].includes('-t-5'));

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

  it('force rotation bypasses cooldown and returns a fresh session', async () => {
    const pool = createPool({ rotationCooldownMs: 60000 });
    await pool.assign();

    const first = await pool.nextForChannel('ch-1');
    const second = await pool.nextForChannel('ch-1', { force: true });
    const third = await pool.nextForChannel('ch-1', { force: true });

    assert.notStrictEqual(second, first);
    assert.notStrictEqual(third, second);
    assert.strictEqual(pool.getProxyForChannel('ch-1'), third);

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

  it('refresh returns the assignments object (channelId -> url), not an array', async () => {
    const pool = createPool();
    await pool.assign();

    const result = await pool.refresh();

    assert.ok(result && typeof result === 'object' && !Array.isArray(result));
    assert.deepStrictEqual(Object.keys(result).sort(), ['ch-1', 'ch-2']);
    assert.strictEqual(result['ch-1'], pool.getProxyForChannel('ch-1'));

    try { fs.unlinkSync(pool.assignmentsFile); } catch (e) {}
  });

  it('writes assignments atomically and keeps a .bak of the previous file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cliproxy-atomic-'));
    try {
      const assignmentsFile = path.join(dir, 'assignments.json');
      const logs = [];
      const pool = createPool({ log: (msg) => logs.push(msg) }, assignmentsFile);

      const first = await pool.assign();
      const firstContent = fs.readFileSync(assignmentsFile, 'utf-8');
      assert.deepStrictEqual(JSON.parse(firstContent), first);
      assert.ok(!fs.existsSync(assignmentsFile + '.bak'), 'first save has no previous file to back up');

      await pool.nextForChannel('ch-1', { force: true });
      const secondContent = fs.readFileSync(assignmentsFile, 'utf-8');

      assert.strictEqual(fs.readFileSync(assignmentsFile + '.bak', 'utf-8'), firstContent,
        '.bak should hold the previous assignments file');
      assert.notStrictEqual(secondContent, firstContent);
      assert.ok(!fs.existsSync(assignmentsFile + '.tmp'), 'tmp file should be renamed away after save');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to .bak when the main assignments file is corrupted', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cliproxy-bak-'));
    try {
      const assignmentsFile = path.join(dir, 'assignments.json');
      const pool1 = createPool({}, assignmentsFile);
      const map1 = await pool1.assign();
      // 模拟崩溃把主文件截断，.bak 保留上一次完整写入
      fs.copyFileSync(assignmentsFile, assignmentsFile + '.bak');
      fs.writeFileSync(assignmentsFile, '{"ch-1": "http://truncated', 'utf-8');

      const logs = [];
      const pool2 = createPool({ log: (msg) => logs.push(msg) }, assignmentsFile);
      const map2 = await pool2.assign();

      assert.strictEqual(map2['ch-1'], map1['ch-1'], 'nonce should be recovered from .bak, keeping the same IP');
      assert.strictEqual(map2['ch-2'], map1['ch-2']);
      assert.ok(logs.some((m) => m.includes('.bak')), 'should log that .bak fallback was used');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns empty assignments when both main file and .bak are corrupted', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cliproxy-bothbad-'));
    try {
      const assignmentsFile = path.join(dir, 'assignments.json');
      fs.writeFileSync(assignmentsFile, '{"ch-1":', 'utf-8');
      fs.writeFileSync(assignmentsFile + '.bak', 'not json at all', 'utf-8');

      const logs = [];
      const pool = createPool({ log: (msg) => logs.push(msg) }, assignmentsFile);
      const loaded = pool.loadAssignments();

      assert.deepStrictEqual(loaded, {});
      assert.ok(logs.some((m) => m.includes('回退为空')), 'should warn about falling back to empty assignments');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('saveAssignments failure only warns and does not throw', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cliproxy-writefail-'));
    try {
      // assignmentsFile 指向已存在的目录，writeFileSync 必失败（EISDIR）
      const logs = [];
      const pool = createPool({ log: (msg) => logs.push(msg) }, dir);

      const map = await pool.assign();

      assert.ok(map['ch-1'], 'assign should still return in-memory assignments');
      assert.ok(logs.some((m) => m.includes('写盘失败')), 'should warn about the write failure');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
