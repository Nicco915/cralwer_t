const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs, setupCliproxyIfNeeded } = require('../test-sku');

describe('test-sku parseArgs', () => {
  it('uses default SKU when no positional argument', () => {
    const args = parseArgs(['node', 'test-sku.js']);
    assert.strictEqual(args.sku, 'GXSBSJSGWLGXVOLJBV0');
    assert.strictEqual(args.mockUpload, false);
  });

  it('parses SKU positional argument', () => {
    const args = parseArgs(['node', 'test-sku.js', 'ABC-001']);
    assert.strictEqual(args.sku, 'ABC-001');
  });

  it('detects --mock-upload flag', () => {
    const args = parseArgs(['node', 'test-sku.js', 'ABC-001', '--mock-upload']);
    assert.strictEqual(args.sku, 'ABC-001');
    assert.strictEqual(args.mockUpload, true);
  });

  it('parses --proxy override', () => {
    const args = parseArgs(['node', 'test-sku.js', '--proxy=http://proxy:8080']);
    assert.strictEqual(args.rawConfig.proxy, 'http://proxy:8080');
  });
});

describe('test-sku setupCliproxyIfNeeded proxy params', () => {
  const ENV_KEYS = [
    'CLIPROXY_HOST', 'CLIPROXY_PORT', 'CLIPROXY_USERNAME', 'CLIPROXY_PASSWORD',
    'CLIPROXY_REGION', 'CLIPROXY_ASN', 'CLIPROXY_STICKY_MINUTES', 'CLIPROXY_SESSION_PREFIX',
    'CLIPROXY_ASSIGNMENTS_FILE', 'CLIPROXY_REGION_PARAM_NAME', 'CLIPROXY_ASN_PARAM_NAME',
    'CLIPROXY_SESSION_PARAM_NAME', 'CLIPROXY_STICKY_PARAM_NAME',
  ];
  const saved = {};
  beforeEach(() => { for (const k of ENV_KEYS) saved[k] = process.env[k]; });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('threads configured param names (region/asn/sid/t) into the proxy username', async () => {
    process.env.CLIPROXY_HOST = 'us2.cliproxy.io';
    process.env.CLIPROXY_PORT = '3010';
    process.env.CLIPROXY_USERNAME = 'u';
    process.env.CLIPROXY_PASSWORD = 'p';
    process.env.CLIPROXY_REGION = 'DE';
    process.env.CLIPROXY_ASN = 'AS12897';
    process.env.CLIPROXY_STICKY_MINUTES = '5';
    process.env.CLIPROXY_SESSION_PREFIX = 'smoke';
    process.env.CLIPROXY_REGION_PARAM_NAME = 'region';
    process.env.CLIPROXY_ASN_PARAM_NAME = 'asn';
    process.env.CLIPROXY_SESSION_PARAM_NAME = 'sid';
    process.env.CLIPROXY_STICKY_PARAM_NAME = 't';
    const tmp = path.join(os.tmpdir(), `cliproxy-assign-${process.pid}-${Date.now()}.json`);
    process.env.CLIPROXY_ASSIGNMENTS_FILE = tmp;

    const config = {};
    try {
      await setupCliproxyIfNeeded(config);
      assert.ok(config.proxy, 'proxy should be set');
      const user = decodeURIComponent(new URL(config.proxy).username);
      assert.match(user, /(^|-)region-DE-/, 'region param name should be "region"');
      assert.match(user, /(^|-)asn-AS12897-/, 'asn should be present');
      assert.match(user, /(^|-)sid-smoke-/, 'session param name should be "sid"');
      assert.match(user, /(^|-)t-5$/, 'sticky param name should be "t"');
    } finally {
      try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
    }
  });

  it('is a no-op when credentials are missing', async () => {
    delete process.env.CLIPROXY_USERNAME;
    delete process.env.CLIPROXY_PASSWORD;
    const config = {};
    await setupCliproxyIfNeeded(config);
    assert.strictEqual(config.proxy, undefined);
  });
});
