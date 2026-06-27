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

  it('classifies 403 as non-retryable', () => {
    const err = new Error('net::ERR_HTTP_RESPONSE_CODE_FAILURE');
    assert.strictEqual(classifyGotoError(err), 'non-retryable');
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
});
