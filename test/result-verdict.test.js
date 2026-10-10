const { describe, it } = require('node:test');
const assert = require('node:assert');
const verdict = require('../src/result-verdict');
const { classifyGotoError } = require('../src/page-crawler');
const { ERROR_CODES } = verdict;

describe('result-verdict ERROR_CODES', () => {
  it('is frozen and contains all stage-1 codes', () => {
    assert.strictEqual(Object.isFrozen(ERROR_CODES), true);
    const expected = [
      'CF_CHALLENGE_UNRESOLVED', 'PAGE_NO_RESULT', 'NO_PRODUCT_URL', 'SKU_MISMATCH',
      'DATA_LAYER_NEVER_PUSHED', 'DATA_LAYER_MISSING', 'NAVIGATION_FAILED_RETRYABLE',
      'PROXY_CONNECTION_FAILED', 'UNEXPECTED_ERROR', 'TASK_DEADLINE_EXCEEDED', 'GOTO_TIMEOUT',
    ];
    assert.deepStrictEqual(Object.keys(ERROR_CODES).sort(), expected.sort());
    for (const key of expected) {
      assert.strictEqual(ERROR_CODES[key], key);
    }
  });
});

describe('result-verdict shouldRetryWithNewIp', () => {
  it('not_found + dataLayerFailed=true + dataLayerNotFound=undefined -> true (CF/DATA_LAYER_* shape)', () => {
    assert.strictEqual(verdict.shouldRetryWithNewIp({
      status: 'not_found', dataLayerFailed: true, dataLayerNotFound: undefined,
    }), true);
    // 字段缺失同样视为 undefined
    assert.strictEqual(verdict.shouldRetryWithNewIp({
      status: 'not_found', dataLayerFailed: true,
    }), true);
  });

  it('not_found + dataLayerFailed=true + dataLayerNotFound=false -> true (retry-exhausted shape)', () => {
    assert.strictEqual(verdict.shouldRetryWithNewIp({
      status: 'not_found', dataLayerFailed: true, dataLayerNotFound: false,
    }), true);
  });

  it('not_found + dataLayerFailed=true + dataLayerNotFound=true -> false (business no-result)', () => {
    assert.strictEqual(verdict.shouldRetryWithNewIp({
      status: 'not_found', dataLayerFailed: true, dataLayerNotFound: true,
    }), false);
  });

  it('not_found + dataLayerFailed=false + dataLayerNotFound=true -> false (PAGE_NO_RESULT shape)', () => {
    assert.strictEqual(verdict.shouldRetryWithNewIp({
      status: 'not_found', dataLayerFailed: false, dataLayerNotFound: true,
      errorCode: ERROR_CODES.PAGE_NO_RESULT,
    }), false);
  });

  it('not_found + no dataLayer fields -> false (dataLayerFailed not true)', () => {
    assert.strictEqual(verdict.shouldRetryWithNewIp({ status: 'not_found' }), false);
  });

  it('error + errorCode=NAVIGATION_FAILED_RETRYABLE -> true', () => {
    assert.strictEqual(verdict.shouldRetryWithNewIp({
      status: 'error', errorCode: ERROR_CODES.NAVIGATION_FAILED_RETRYABLE,
    }), true);
  });

  it('error + errorCode=PROXY_CONNECTION_FAILED -> true', () => {
    assert.strictEqual(verdict.shouldRetryWithNewIp({
      status: 'error', errorCode: ERROR_CODES.PROXY_CONNECTION_FAILED,
    }), true);
  });

  it('error + errorCode=UNEXPECTED_ERROR -> false', () => {
    assert.strictEqual(verdict.shouldRetryWithNewIp({
      status: 'error', errorCode: ERROR_CODES.UNEXPECTED_ERROR,
    }), false);
  });

  it('error without errorCode: goto timeout message -> true via injected classify fallback', () => {
    assert.strictEqual(verdict.shouldRetryWithNewIp({
      status: 'error', error: 'page.goto: Timeout 30000ms exceeded',
    }, classifyGotoError), true);
  });

  it('error without errorCode: tunnel failure message -> true via injected classify fallback', () => {
    assert.strictEqual(verdict.shouldRetryWithNewIp({
      status: 'error', error: 'net::ERR_TUNNEL_CONNECTION_FAILED',
    }, classifyGotoError), true);
  });

  it('error without errorCode: status code 404 -> false via injected classify fallback', () => {
    assert.strictEqual(verdict.shouldRetryWithNewIp({
      status: 'error', error: 'status code 404',
    }, classifyGotoError), false);
  });

  it('error without errorCode and without fallback -> false', () => {
    assert.strictEqual(verdict.shouldRetryWithNewIp({
      status: 'error', error: 'page.goto: Timeout 30000ms exceeded',
    }), false);
  });

  it('error without error string -> false', () => {
    assert.strictEqual(verdict.shouldRetryWithNewIp({ status: 'error' }, classifyGotoError), false);
  });

  it('status=timeout -> true regardless of origin', () => {
    assert.strictEqual(verdict.shouldRetryWithNewIp({ status: 'timeout' }), true);
    assert.strictEqual(verdict.shouldRetryWithNewIp({
      status: 'timeout', errorCode: ERROR_CODES.TASK_DEADLINE_EXCEEDED,
    }), true);
    assert.strictEqual(verdict.shouldRetryWithNewIp({
      status: 'timeout', errorCode: ERROR_CODES.GOTO_TIMEOUT,
    }), true);
  });

  it('success / sku_mismatch -> false', () => {
    assert.strictEqual(verdict.shouldRetryWithNewIp({ status: 'success' }), false);
    assert.strictEqual(verdict.shouldRetryWithNewIp({
      status: 'sku_mismatch', errorCode: ERROR_CODES.SKU_MISMATCH,
    }), false);
  });

  it('null/undefined result -> false', () => {
    assert.strictEqual(verdict.shouldRetryWithNewIp(null), false);
    assert.strictEqual(verdict.shouldRetryWithNewIp(undefined), false);
  });
});

describe('result-verdict isRegionFallbackCandidate', () => {
  it('not_found + PAGE_NO_RESULT -> true', () => {
    assert.strictEqual(verdict.isRegionFallbackCandidate({
      status: 'not_found', errorCode: ERROR_CODES.PAGE_NO_RESULT,
    }), true);
  });

  it('not_found + NO_PRODUCT_URL / CF_CHALLENGE_UNRESOLVED -> false', () => {
    assert.strictEqual(verdict.isRegionFallbackCandidate({
      status: 'not_found', errorCode: ERROR_CODES.NO_PRODUCT_URL,
    }), false);
    assert.strictEqual(verdict.isRegionFallbackCandidate({
      status: 'not_found', errorCode: ERROR_CODES.CF_CHALLENGE_UNRESOLVED,
    }), false);
  });

  it('error + PAGE_NO_RESULT -> false (wrong status)', () => {
    assert.strictEqual(verdict.isRegionFallbackCandidate({
      status: 'error', errorCode: ERROR_CODES.PAGE_NO_RESULT,
    }), false);
  });

  it('null result -> false', () => {
    assert.strictEqual(verdict.isRegionFallbackCandidate(null), false);
  });
});

describe('result-verdict dataLayerCounterAction', () => {
  it('success + dataLayerFailed=true + dataLayerNotFound=false -> reset (order-cancel net effect)', () => {
    // 现状 channel 先 ++ 后由 success 清零，净效果是清零；三态显式化后必须仍是 reset
    assert.strictEqual(verdict.dataLayerCounterAction({
      status: 'success', dataLayerFailed: true, dataLayerNotFound: false,
    }), 'reset');
  });

  it('success without dataLayer fields -> reset', () => {
    assert.strictEqual(verdict.dataLayerCounterAction({ status: 'success' }), 'reset');
  });

  it('not_found + dataLayerFailed=true + dataLayerNotFound=undefined -> increment', () => {
    assert.strictEqual(verdict.dataLayerCounterAction({
      status: 'not_found', dataLayerFailed: true, dataLayerNotFound: undefined,
    }), 'increment');
  });

  it('not_found + dataLayerFailed=true + dataLayerNotFound=false -> increment', () => {
    assert.strictEqual(verdict.dataLayerCounterAction({
      status: 'not_found', dataLayerFailed: true, dataLayerNotFound: false,
    }), 'increment');
  });

  it('not_found + dataLayerFailed=false + dataLayerNotFound=true -> hold', () => {
    assert.strictEqual(verdict.dataLayerCounterAction({
      status: 'not_found', dataLayerFailed: false, dataLayerNotFound: true,
    }), 'hold');
  });

  it('not_found + dataLayerFailed=false + dataLayerNotFound=false -> reset', () => {
    assert.strictEqual(verdict.dataLayerCounterAction({
      status: 'not_found', dataLayerFailed: false, dataLayerNotFound: false,
    }), 'reset');
  });

  it('not_found without dataLayer fields (both undefined) -> reset', () => {
    // 对应 channel 现状 `!undefined` 为真走 reset 分支
    assert.strictEqual(verdict.dataLayerCounterAction({ status: 'not_found' }), 'reset');
  });

  it('error result follows the same flag rules', () => {
    assert.strictEqual(verdict.dataLayerCounterAction({
      status: 'error', dataLayerFailed: true, dataLayerNotFound: undefined,
    }), 'increment');
    assert.strictEqual(verdict.dataLayerCounterAction({
      status: 'error', dataLayerFailed: false, dataLayerNotFound: true,
    }), 'hold');
    assert.strictEqual(verdict.dataLayerCounterAction({ status: 'error' }), 'reset');
  });

  it('null result -> reset (matches channel `!undefined` branch)', () => {
    assert.strictEqual(verdict.dataLayerCounterAction(null), 'reset');
  });
});

describe('result-verdict isHeadedFallbackCandidate', () => {
  it('error + NAVIGATION_FAILED_RETRYABLE / PROXY_CONNECTION_FAILED -> true', () => {
    assert.strictEqual(verdict.isHeadedFallbackCandidate({
      status: 'error', errorCode: ERROR_CODES.NAVIGATION_FAILED_RETRYABLE,
    }), true);
    assert.strictEqual(verdict.isHeadedFallbackCandidate({
      status: 'error', errorCode: ERROR_CODES.PROXY_CONNECTION_FAILED,
    }), true);
  });

  it('error + UNEXPECTED_ERROR -> false (behavior change: HTTP 500 no longer triggers headed retry)', () => {
    assert.strictEqual(verdict.isHeadedFallbackCandidate({
      status: 'error', errorCode: ERROR_CODES.UNEXPECTED_ERROR,
      error: 'net::ERR_HTTP_RESPONSE_CODE_FAILURE',
    }), false);
  });

  it('error without errorCode -> false', () => {
    assert.strictEqual(verdict.isHeadedFallbackCandidate({
      status: 'error', error: 'net::ERR_TIMED_OUT',
    }), false);
  });

  it('not_found / timeout / success -> false', () => {
    assert.strictEqual(verdict.isHeadedFallbackCandidate({
      status: 'not_found', errorCode: ERROR_CODES.NAVIGATION_FAILED_RETRYABLE,
    }), false);
    assert.strictEqual(verdict.isHeadedFallbackCandidate({
      status: 'timeout', errorCode: ERROR_CODES.GOTO_TIMEOUT,
    }), false);
    assert.strictEqual(verdict.isHeadedFallbackCandidate({ status: 'success' }), false);
  });

  it('null result -> false', () => {
    assert.strictEqual(verdict.isHeadedFallbackCandidate(null), false);
  });
});

describe('result-verdict isTimeoutResult', () => {
  it('status=timeout without errorCode -> true', () => {
    assert.strictEqual(verdict.isTimeoutResult({ status: 'timeout' }), true);
  });

  it('errorCode=TASK_DEADLINE_EXCEEDED / GOTO_TIMEOUT -> true', () => {
    assert.strictEqual(verdict.isTimeoutResult({
      status: 'timeout', errorCode: ERROR_CODES.TASK_DEADLINE_EXCEEDED,
    }), true);
    assert.strictEqual(verdict.isTimeoutResult({
      status: 'error', errorCode: ERROR_CODES.GOTO_TIMEOUT,
    }), true);
  });

  it('status=error + Timeout message without errorCode -> true (legacy fallback)', () => {
    assert.strictEqual(verdict.isTimeoutResult({
      status: 'error', error: 'page.goto: Timeout 30000ms exceeded',
    }), true);
  });

  it('status=error + non-Timeout message -> false', () => {
    assert.strictEqual(verdict.isTimeoutResult({
      status: 'error', error: 'net::ERR_TUNNEL_CONNECTION_FAILED',
    }), false);
  });

  it('status=error without error field -> false', () => {
    assert.strictEqual(verdict.isTimeoutResult({ status: 'error' }), false);
  });

  it('success / null -> false', () => {
    assert.strictEqual(verdict.isTimeoutResult({ status: 'success' }), false);
    assert.strictEqual(verdict.isTimeoutResult(null), false);
  });
});

describe('result-verdict isDataLayerSignal (full 3x3 truth table)', () => {
  const cases = [
    // [dataLayerFailed, dataLayerNotFound, expected]
    [true, true, false],
    [true, false, true],
    [true, undefined, true],
    [false, true, false],
    [false, false, false],
    [false, undefined, false],
    [undefined, true, false],
    [undefined, false, false],
    [undefined, undefined, false],
  ];
  for (const [failed, notFound, expected] of cases) {
    it(`dataLayerFailed=${failed} dataLayerNotFound=${notFound} -> ${expected}`, () => {
      assert.strictEqual(verdict.isDataLayerSignal({
        status: 'not_found', dataLayerFailed: failed, dataLayerNotFound: notFound,
      }), expected);
    });
  }

  it('null result -> false', () => {
    assert.strictEqual(verdict.isDataLayerSignal(null), false);
  });
});
