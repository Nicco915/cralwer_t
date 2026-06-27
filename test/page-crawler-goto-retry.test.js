const { describe, it } = require('node:test');
const assert = require('node:assert');
const { classifyGotoError, gotoWithRetry } = require('../src/page-crawler');

describe('classifyGotoError', () => {
  it('classifies timeout as retryable', () => {
    const err = new Error('page.goto: Timeout 30000ms exceeded');
    assert.strictEqual(classifyGotoError(err), 'retryable');
  });

  it('classifies proxy tunnel error as proxy', () => {
    const err = new Error('net::ERR_TUNNEL_CONNECTION_FAILED');
    assert.strictEqual(classifyGotoError(err), 'proxy');
  });

  it('classifies ERR_HTTP_RESPONSE_CODE_FAILURE as non-retryable', () => {
    const err = new Error('net::ERR_HTTP_RESPONSE_CODE_FAILURE');
    assert.strictEqual(classifyGotoError(err), 'non-retryable');
  });

  it('classifies ERR_CONNECTION_RESET as proxy', () => {
    const err = new Error('net::ERR_CONNECTION_RESET');
    assert.strictEqual(classifyGotoError(err), 'proxy');
  });

  it('classifies ERR_NAME_NOT_RESOLVED as retryable', () => {
    const err = new Error('net::ERR_NAME_NOT_RESOLVED');
    assert.strictEqual(classifyGotoError(err), 'retryable');
  });

  it('does not classify URL containing 404 as HTTP 404', () => {
    const err = new Error('Navigation to https://example.com/404-page failed');
    assert.strictEqual(classifyGotoError(err), 'non-retryable');
  });

  it('classifies status code 403 as non-retryable', () => {
    const err = new Error('page.goto: status code 403');
    assert.strictEqual(classifyGotoError(err), 'non-retryable');
  });

  it('classifies unknown error as non-retryable', () => {
    const err = new Error('Something went wrong');
    assert.strictEqual(classifyGotoError(err), 'non-retryable');
  });

  it('returns non-retryable for null input', () => {
    assert.strictEqual(classifyGotoError(null), 'non-retryable');
  });

  it('returns non-retryable for undefined input', () => {
    assert.strictEqual(classifyGotoError(undefined), 'non-retryable');
  });
});

describe('gotoWithRetry', () => {
  it('returns on first success', async () => {
    const calls = [];
    const page = {
      goto: async (url, opts) => {
        calls.push({ url, opts });
      },
    };
    await gotoWithRetry(page, 'https://example.com', { sku: 'SKU-1', gotoMaxRetries: 3, gotoTimeout: 30000, gotoRetryDelays: [100, 100, 100] });
    assert.strictEqual(calls.length, 1);
  });

  it('retries on timeout and succeeds on second attempt', async () => {
    const calls = [];
    const page = {
      goto: async (url, opts) => {
        calls.push({ url, opts });
        if (calls.length === 1) {
          throw new Error('page.goto: Timeout 30000ms exceeded');
        }
      },
    };
    await gotoWithRetry(page, 'https://example.com', { sku: 'SKU-1', gotoMaxRetries: 3, gotoTimeout: 30000, gotoRetryDelays: [50, 50, 50] });
    assert.strictEqual(calls.length, 2);
  });

  it('throws on non-retryable error without retrying', async () => {
    const calls = [];
    const page = {
      goto: async (url, opts) => {
        calls.push({ url, opts });
        throw new Error('net::ERR_HTTP_RESPONSE_CODE_FAILURE');
      },
    };
    await assert.rejects(
      () => gotoWithRetry(page, 'https://example.com', { sku: 'SKU-1', gotoMaxRetries: 3, gotoTimeout: 30000, gotoRetryDelays: [50, 50, 50] }),
      /ERR_HTTP_RESPONSE_CODE_FAILURE/
    );
    assert.strictEqual(calls.length, 1);
  });

  it('only executes once when gotoMaxRetries = 1', async () => {
    const calls = [];
    const page = {
      goto: async (url, opts) => {
        calls.push({ url, opts });
      },
    };
    await gotoWithRetry(page, 'https://example.com', { sku: 'SKU-1', gotoMaxRetries: 1, gotoTimeout: 30000, gotoRetryDelays: [50] });
    assert.strictEqual(calls.length, 1);
  });

  it('uses 0 delay when gotoRetryDelays contains 0', async () => {
    const calls = [];
    const delays = [];
    const page = {
      goto: async (url, opts) => {
        calls.push({ url, opts });
        if (calls.length === 1) {
          throw new Error('page.goto: Timeout 30000ms exceeded');
        }
      },
    };
    const start = Date.now();
    await gotoWithRetry(page, 'https://example.com', {
      sku: 'SKU-1',
      gotoMaxRetries: 2,
      gotoTimeout: 30000,
      gotoRetryDelays: [0],
      log: () => {},
    });
    const elapsed = Date.now() - start;
    assert.strictEqual(calls.length, 2);
    assert.ok(elapsed < 300, `Expected near-instant retry, but took ${elapsed}ms`);
  });

  it('calls recreateContext before the final attempt when maxRetries > 1', async () => {
    const calls = [];
    let recreateCalled = false;
    const page = {
      goto: async (url, opts) => {
        calls.push({ url, opts });
        throw new Error('page.goto: Timeout 30000ms exceeded');
      },
    };
    const newPage = {
      goto: async (url, opts) => {
        calls.push({ url, opts, newPage: true });
        throw new Error('page.goto: Timeout 30000ms exceeded');
      },
    };
    await assert.rejects(
      () =>
        gotoWithRetry(page, 'https://example.com', {
          sku: 'SKU-1',
          gotoMaxRetries: 3,
          gotoTimeout: 30000,
          gotoRetryDelays: [10, 10],
          log: () => {},
          recreateContext: async () => {
            recreateCalled = true;
            return newPage;
          },
        }),
      /Timeout/
    );
    assert.strictEqual(calls.length, 3);
    assert.strictEqual(recreateCalled, true);
    assert.strictEqual(calls[2].newPage, true);
  });

  it('throws the last error when all retries fail', async () => {
    const calls = [];
    const page = {
      goto: async (url, opts) => {
        calls.push({ url, opts });
        throw new Error(`page.goto: Timeout ${calls.length}000ms exceeded`);
      },
    };
    await assert.rejects(
      () =>
        gotoWithRetry(page, 'https://example.com', {
          sku: 'SKU-1',
          gotoMaxRetries: 2,
          gotoTimeout: 30000,
          gotoRetryDelays: [10],
          log: () => {},
        }),
      /Timeout 2000ms exceeded/
    );
    assert.strictEqual(calls.length, 2);
  });

  it('throws when gotoMaxRetries <= 0', async () => {
    const page = { goto: async () => {} };
    await assert.rejects(
      () =>
        gotoWithRetry(page, 'https://example.com', {
          sku: 'SKU-1',
          gotoMaxRetries: 0,
          gotoTimeout: 30000,
          gotoRetryDelays: [10],
        }),
      /gotoMaxRetries must be > 0/
    );
  });

  it('passes through the return value of page.goto', async () => {
    const expected = { response: 'ok' };
    const page = {
      goto: async () => expected,
    };
    const result = await gotoWithRetry(page, 'https://example.com', {
      sku: 'SKU-1',
      gotoMaxRetries: 1,
      gotoTimeout: 30000,
      gotoRetryDelays: [10],
    });
    assert.strictEqual(result, expected);
  });
});
