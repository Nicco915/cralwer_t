const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const JSONbig = require('json-bigint')({ useNativeBigInt: true });
const { Pusher, cleanupOldCallbacks } = require('../src/pusher');

describe('Pusher.push', () => {
  it('posts success result with mapped fields', async () => {
    const fetched = [];
    const fakeFetch = async (url, options) => {
      fetched.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ code: 0 }) };
    };

    const pusher = new Pusher({
      callbackUrl: 'http://example.com/callback',
      nodeCode: 'node-1',
      nodeToken: 'token-1',
      fetch: fakeFetch,
    });

    await pusher.push({
      crawlerTaskId: 1,
      sku: 'ABC-001',
      status: 'success',
      product_name: 'Product Name',
      features_details: 'Features details',
      product_specification: 'Specification',
      product_url: 'https://example.com/item',
      error: '',
    });

    assert.strictEqual(fetched.length, 1);
    assert.strictEqual(fetched[0].url, 'http://example.com/callback');
    assert.strictEqual(fetched[0].options.method, 'POST');
    const body = JSON.parse(fetched[0].options.body);
    assert.strictEqual(body.crawlerTaskId, 1);
    assert.strictEqual(body.sku, 'ABC-001');
    assert.strictEqual(body.nodeCode, 'node-1');
    assert.strictEqual(body.nodeToken, 'token-1');
    assert.strictEqual(body.goodsName, 'Product Name');
    assert.strictEqual(body.goodsDesc, 'Features details');
    assert.strictEqual(body.sourceUrl, 'https://example.com/item');
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.errorMessage, '');
  });

  it('posts failure result when status is error', async () => {
    const fetched = [];
    const fakeFetch = async (url, options) => {
      fetched.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ code: 0 }) };
    };

    const pusher = new Pusher({
      callbackUrl: 'http://example.com/callback',
      nodeCode: 'node-1',
      nodeToken: 'token-1',
      fetch: fakeFetch,
    });

    await pusher.push({
      crawlerTaskId: 2,
      sku: 'ABC-002',
      status: 'error',
      product_name: '',
      features_details: '',
      product_specification: '',
      product_url: '',
      error: 'Cloudflare challenge not resolved',
    });

    const body = JSON.parse(fetched[0].options.body);
    assert.strictEqual(body.success, false);
    assert.strictEqual(body.errorMessage, 'Cloudflare challenge not resolved');
    assert.strictEqual(body.goodsName, '');
  });

  it('posts not_found as failure', async () => {
    const fetched = [];
    const fakeFetch = async (url, options) => {
      fetched.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ code: 0 }) };
    };

    const pusher = new Pusher({
      callbackUrl: 'http://example.com/callback',
      nodeCode: 'node-1',
      nodeToken: 'token-1',
      fetch: fakeFetch,
    });

    await pusher.push({
      crawlerTaskId: 3,
      sku: 'ABC-003',
      status: 'not_found',
      product_name: '',
      features_details: '',
      product_specification: '',
      product_url: '',
      error: 'Page shows no result',
    });

    const body = JSON.parse(fetched[0].options.body);
    assert.strictEqual(body.success, false);
    assert.strictEqual(body.errorMessage, 'Page shows no result');
  });

  it('retries on network failure then throws after max retries', async () => {
    let callCount = 0;
    const fakeFetch = async () => {
      callCount++;
      if (callCount < 3) {
        throw new Error('network error');
      }
      return { ok: true, status: 200, json: async () => ({ code: 0 }) };
    };

    const pusher = new Pusher({
      callbackUrl: 'http://example.com/callback',
      nodeCode: 'node-1',
      nodeToken: 'token-1',
      maxRetries: 3,
      retryDelays: [10, 10, 10],
      fetch: fakeFetch,
    });

    await pusher.push({
      crawlerTaskId: 4,
      sku: 'ABC-004',
      status: 'success',
      product_name: 'Name',
      features_details: 'Desc',
      product_specification: '',
      product_url: '',
      error: '',
    });

    assert.strictEqual(callCount, 3);
  });

  it('throws when callback returns non-ok status', async () => {
    const fakeFetch = async () => ({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    });

    const pusher = new Pusher({
      callbackUrl: 'http://example.com/callback',
      nodeCode: 'node-1',
      nodeToken: 'token-1',
      fetch: fakeFetch,
    });

    await assert.rejects(
      () => pusher.push({
        crawlerTaskId: 5,
        sku: 'ABC-005',
        status: 'success',
        product_name: 'Name',
        features_details: 'Desc',
        product_specification: '',
        product_url: '',
        error: '',
      }),
      /Callback failed: 500/
    );
  });

  it('serializes large crawlerTaskId as JSON number without precision loss', async () => {
    const fetched = [];
    const fakeFetch = async (url, options) => {
      fetched.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ code: 0 }) };
    };

    const pusher = new Pusher({
      callbackUrl: 'http://example.com/callback',
      nodeCode: 'node-1',
      nodeToken: 'token-1',
      fetch: fakeFetch,
    });

    await pusher.push({
      crawlerTaskId: 2070043611483398145n,
      sku: 'ABC-BIG',
      status: 'success',
      product_name: 'Product Name',
      features_details: 'Features details',
      product_specification: 'Specification',
      product_url: 'https://example.com/item',
      error: '',
    });

    assert.strictEqual(fetched.length, 1);
    const rawBody = fetched[0].options.body;
    // The raw JSON body must contain the 19-digit id as an unquoted number.
    assert.ok(rawBody.includes('"crawlerTaskId":2070043611483398145,'), `body did not preserve precision: ${rawBody}`);
    const body = JSONbig.parse(rawBody);
    assert.strictEqual(body.crawlerTaskId, 2070043611483398145n);
  });
});

describe('cleanupOldCallbacks', () => {
  function makeCallbacksDir() {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pusher-callbacks-test-'));
    const callbacksRoot = path.join(baseDir, 'logs', 'callbacks');
    fs.mkdirSync(callbacksRoot, { recursive: true });
    return { baseDir, callbacksRoot };
  }

  function daysAgo(n) {
    const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
    const pad = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  it('deletes date directories older than retentionDays, keeps recent ones', () => {
    const { baseDir, callbacksRoot } = makeCallbacksDir();
    const oldDir = path.join(callbacksRoot, daysAgo(30));
    const recentDir = path.join(callbacksRoot, daysAgo(1));
    fs.mkdirSync(oldDir);
    fs.mkdirSync(recentDir);
    fs.writeFileSync(path.join(oldDir, 'a.json'), '{}');
    fs.writeFileSync(path.join(recentDir, 'b.json'), '{}');
    // cleanupOldCallbacks 要求 mtime 与目录名日期都过期才删除
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldDir, longAgo, longAgo);

    cleanupOldCallbacks(7, baseDir);

    assert.ok(!fs.existsSync(oldDir), 'old callbacks dir should be deleted');
    assert.ok(fs.existsSync(recentDir), 'recent callbacks dir should be kept');
  });

  it('ignores non-date entries and missing callbacks root', () => {
    const { baseDir, callbacksRoot } = makeCallbacksDir();
    const otherDir = path.join(callbacksRoot, 'not-a-date');
    fs.mkdirSync(otherDir);

    assert.doesNotThrow(() => cleanupOldCallbacks(7, baseDir));
    assert.ok(fs.existsSync(otherDir), 'non-date directory should be kept');
    assert.doesNotThrow(() => cleanupOldCallbacks(7, fs.mkdtempSync(path.join(os.tmpdir(), 'pusher-empty-'))));
  });

  it('retentionDays=0 disables cleanup', () => {
    const { baseDir, callbacksRoot } = makeCallbacksDir();
    const oldDir = path.join(callbacksRoot, daysAgo(30));
    fs.mkdirSync(oldDir);
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldDir, longAgo, longAgo);

    cleanupOldCallbacks(0, baseDir);

    assert.ok(fs.existsSync(oldDir));
  });
});
