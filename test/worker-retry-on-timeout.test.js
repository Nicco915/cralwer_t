const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const { Worker } = require('../src/worker');

describe('Worker.shouldRetryWithNewIp', () => {
  let worker;
  beforeEach(() => {
    worker = new Worker({
      pusher: { push: async () => {} },
      log: () => {},
    });
  });

  it('returns false when retryOnTimeout is disabled', () => {
    worker.retryOnTimeout = false;
    const channel = { reinitializing: false };
    const result = { status: 'not_found', dataLayerFailed: true };
    assert.strictEqual(worker.shouldRetryWithNewIp(result, channel), false);
  });

  it('returns false when channel is reinitializing', () => {
    const channel = { reinitializing: true };
    const result = { status: 'not_found', dataLayerFailed: true };
    assert.strictEqual(worker.shouldRetryWithNewIp(result, channel), false);
  });

  it('returns false for business no-result (dataLayerNotFound=true)', () => {
    const channel = { reinitializing: false };
    const result = { status: 'not_found', dataLayerFailed: true, dataLayerNotFound: true };
    assert.strictEqual(worker.shouldRetryWithNewIp(result, channel), false);
  });

  it('returns true for dataLayer anomaly not_found', () => {
    const channel = { reinitializing: false };
    const result = { status: 'not_found', dataLayerFailed: true, dataLayerNotFound: false };
    assert.strictEqual(worker.shouldRetryWithNewIp(result, channel), true);
  });

  it('returns true for page.goto timeout error', () => {
    const channel = { reinitializing: false };
    const result = { status: 'error', error: 'page.goto: Timeout 30000ms exceeded.' };
    assert.strictEqual(worker.shouldRetryWithNewIp(result, channel), true);
  });

  it('returns true for timeout status', () => {
    const channel = { reinitializing: false };
    const result = { status: 'timeout' };
    assert.strictEqual(worker.shouldRetryWithNewIp(result, channel), true);
  });

  it('returns true for net::ERR_TIMED_OUT goto error', () => {
    const channel = { reinitializing: false };
    const result = {
      status: 'error',
      error: 'page.goto: net::ERR_TIMED_OUT at https://www.vevor.ca/s/ABC\nCall log:\n  - navigating to "https://www.vevor.ca/s/ABC", waiting until "domcontentloaded"\n',
    };
    assert.strictEqual(worker.shouldRetryWithNewIp(result, channel), true);
  });

  it('returns true for proxy-class goto error (tunnel failed)', () => {
    const channel = { reinitializing: false };
    const result = { status: 'error', error: 'page.goto: net::ERR_TUNNEL_CONNECTION_FAILED' };
    assert.strictEqual(worker.shouldRetryWithNewIp(result, channel), true);
  });

  it('returns true for proxy-class goto error (proxy connection failed)', () => {
    const channel = { reinitializing: false };
    const result = { status: 'error', error: 'page.goto: net::ERR_PROXY_CONNECTION_FAILED' };
    assert.strictEqual(worker.shouldRetryWithNewIp(result, channel), true);
  });

  it('returns false for non-retryable HTTP status errors', () => {
    const channel = { reinitializing: false };
    const result = { status: 'error', error: 'page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE' };
    assert.strictEqual(worker.shouldRetryWithNewIp(result, channel), false);
  });

  it('returns false for other errors', () => {
    const channel = { reinitializing: false };
    const result = { status: 'error', error: 'Protocol error: Target closed' };
    assert.strictEqual(worker.shouldRetryWithNewIp(result, channel), false);
  });

  it('returns false for success results', () => {
    const channel = { reinitializing: false };
    const result = { status: 'success', product_url: 'https://...' };
    assert.strictEqual(worker.shouldRetryWithNewIp(result, channel), false);
  });
});

describe('Worker.runTask retry behavior', () => {
  it('rotates IP and retries when first crawl returns dataLayer anomaly', async () => {
    let crawlCalls = 0;
    const channel = {
      id: 1,
      busy: false,
      reinitializing: false,
      crawl: async () => {
        crawlCalls += 1;
        if (crawlCalls === 1) {
          return {
            crawlerTaskId: 't1', sku: 'SKU1', status: 'not_found',
            dataLayerFailed: true, dataLayerNotFound: false,
            error: 'DATA_LAYER_MISSING', product_url: '', product_name: '',
          };
        }
        return {
          crawlerTaskId: 't1', sku: 'SKU1', status: 'success',
          product_url: 'https://hit', product_name: 'Hit',
        };
      },
      rotateProxy: async () => ({ rotated: true, reason: 'success' }),
    };

    const pushed = [];
    const worker = new Worker({
      pusher: { push: async (r) => { pushed.push(r); } },
      log: () => {},
    });
    worker.retryOnTimeout = true;

    await worker.runTask({ crawlerTaskId: 't1', sku: 'SKU1' }, channel);

    assert.strictEqual(crawlCalls, 2, 'should crawl twice');
    assert.strictEqual(pushed.length, 1);
    assert.strictEqual(pushed[0].status, 'success', 'should push the retry success result');
  });

  it('does NOT retry on business no-result', async () => {
    let crawlCalls = 0;
    const channel = {
      id: 1,
      busy: false,
      reinitializing: false,
      crawl: async () => {
        crawlCalls += 1;
        return {
          crawlerTaskId: 't1', sku: 'NO-RESULT', status: 'not_found',
          dataLayerFailed: false, dataLayerNotFound: true,
          product_url: '', product_name: '',
        };
      },
      rotateProxy: async () => { throw new Error('should not be called'); },
    };

    const pushed = [];
    const worker = new Worker({
      pusher: { push: async (r) => { pushed.push(r); } },
      log: () => {},
    });
    worker.retryOnTimeout = true;

    await worker.runTask({ crawlerTaskId: 't1', sku: 'NO-RESULT' }, channel);

    assert.strictEqual(crawlCalls, 1);
    assert.strictEqual(pushed[0].status, 'not_found');
    assert.strictEqual(pushed[0].dataLayerNotFound, true);
  });

  it('does NOT retry when rotateProxy returns cooldown', async () => {
    let crawlCalls = 0;
    const channel = {
      id: 1,
      busy: false,
      reinitializing: false,
      crawl: async () => {
        crawlCalls += 1;
        return {
          crawlerTaskId: 't1', sku: 'SKU', status: 'not_found',
          dataLayerFailed: true, dataLayerNotFound: false,
        };
      },
      rotateProxy: async () => ({ rotated: false, reason: 'cooldown' }),
    };

    const pushed = [];
    const worker = new Worker({
      pusher: { push: async (r) => { pushed.push(r); } },
      log: () => {},
    });
    worker.retryOnTimeout = true;

    await worker.runTask({ crawlerTaskId: 't1', sku: 'SKU' }, channel);

    assert.strictEqual(crawlCalls, 1, 'should not re-crawl');
    assert.strictEqual(pushed[0].status, 'not_found');
  });

  it('does NOT retry when rotateProxy returns error', async () => {
    let crawlCalls = 0;
    const channel = {
      id: 1,
      busy: false,
      reinitializing: false,
      crawl: async () => {
        crawlCalls += 1;
        return {
          crawlerTaskId: 't1', sku: 'SKU', status: 'not_found',
          dataLayerFailed: true, dataLayerNotFound: false,
        };
      },
      rotateProxy: async () => ({ rotated: false, reason: 'error', error: 'pool exhausted' }),
    };

    const pushed = [];
    const worker = new Worker({
      pusher: { push: async (r) => { pushed.push(r); } },
      log: () => {},
    });
    worker.retryOnTimeout = true;

    await worker.runTask({ crawlerTaskId: 't1', sku: 'SKU' }, channel);

    assert.strictEqual(crawlCalls, 1, 'should not re-crawl');
    assert.strictEqual(pushed[0].status, 'not_found');
  });

  it('does NOT retry when rotateProxy returns reinitializing', async () => {
    let crawlCalls = 0;
    const channel = {
      id: 1,
      busy: false,
      reinitializing: false,
      crawl: async () => {
        crawlCalls += 1;
        return {
          crawlerTaskId: 't1', sku: 'SKU', status: 'not_found',
          dataLayerFailed: true, dataLayerNotFound: false,
        };
      },
      rotateProxy: async () => ({ rotated: false, reason: 'reinitializing' }),
    };

    const pushed = [];
    const worker = new Worker({
      pusher: { push: async (r) => { pushed.push(r); } },
      log: () => {},
    });
    worker.retryOnTimeout = true;

    await worker.runTask({ crawlerTaskId: 't1', sku: 'SKU' }, channel);

    assert.strictEqual(crawlCalls, 1, 'should not re-crawl');
    assert.strictEqual(pushed[0].status, 'not_found');
  });

  it('rotates IP and retries when first crawl throws timeout exception', async () => {
    let crawlCalls = 0;
    const channel = {
      id: 1,
      busy: false,
      reinitializing: false,
      crawl: async () => {
        crawlCalls += 1;
        if (crawlCalls === 1) {
          const err = new Error('page.goto: Timeout 30000ms exceeded.');
          err.status = 'timeout';
          throw err;
        }
        return {
          crawlerTaskId: 't1', sku: 'SKU1', status: 'success',
          product_url: 'https://hit', product_name: 'Hit',
        };
      },
      rotateProxy: async () => ({ rotated: true, reason: 'success' }),
    };

    const pushed = [];
    const worker = new Worker({
      pusher: { push: async (r) => { pushed.push(r); } },
      log: () => {},
    });
    worker.retryOnTimeout = true;

    await worker.runTask({ crawlerTaskId: 't1', sku: 'SKU1' }, channel);

    assert.strictEqual(crawlCalls, 2, 'should crawl twice after exception');
    assert.strictEqual(pushed.length, 1);
    assert.strictEqual(pushed[0].status, 'success', 'should push retry success result');
  });

  it('translates second crawl exception to result and pushes', async () => {
    let crawlCalls = 0;
    const channel = {
      id: 1,
      busy: false,
      reinitializing: false,
      crawl: async () => {
        crawlCalls += 1;
        if (crawlCalls === 1) {
          return { crawlerTaskId: 't1', sku: 'SKU', status: 'not_found', dataLayerFailed: true, dataLayerNotFound: false };
        }
        throw new Error('renderer crash after rotate');
      },
      rotateProxy: async () => ({ rotated: true, reason: 'success' }),
    };

    const pushed = [];
    const worker = new Worker({
      pusher: { push: async (r) => { pushed.push(r); } },
      log: () => {},
    });
    worker.retryOnTimeout = true;

    await worker.runTask({ crawlerTaskId: 't1', sku: 'SKU' }, channel);

    assert.strictEqual(crawlCalls, 2);
    assert.strictEqual(pushed[0].status, 'error');
    assert.ok(pushed[0].error.includes('renderer crash'));
  });
});
