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

  it('error without errorCode -> false (defensive; 兜底已于阶段 2 PR-4 删除)', () => {
    // 所有 error result 必带码（page-crawler 通用 catch + worker buildErrorResult
    // 双产出点），无码形态防御性判 false
    assert.strictEqual(verdict.shouldRetryWithNewIp({
      status: 'error', error: 'page.goto: Timeout 30000ms exceeded',
    }), false);
    assert.strictEqual(verdict.shouldRetryWithNewIp({
      status: 'error', error: 'net::ERR_TUNNEL_CONNECTION_FAILED',
    }), false);
  });

  it('error without error string -> false', () => {
    assert.strictEqual(verdict.shouldRetryWithNewIp({ status: 'error' }), false);
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

  it('status=error + Timeout 文案 -> true（load-bearing：goto 超时耗尽被吞成的 error result）', () => {
    // 无码旧形态
    assert.strictEqual(verdict.isTimeoutResult({
      status: 'error', error: 'page.goto: Timeout 30000ms exceeded',
    }), true);
    // 带码 live 形态：page-crawler 通用 catch 产出 NAVIGATION_FAILED_RETRYABLE，
    // 文案正则仍负责识别其超时语义（PR-4 保留，见 verdict 注释）
    assert.strictEqual(verdict.isTimeoutResult({
      status: 'error', errorCode: ERROR_CODES.NAVIGATION_FAILED_RETRYABLE,
      error: 'page.goto: Timeout 30000ms exceeded',
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

// ── 阶段 2 增补（docs/plan-信号重构-阶段2.md §3.1 / §6.2）──

describe('result-verdict deriveDataLayerOutcome', () => {
  it('errorCode=PAGE_NO_RESULT -> business_empty（布尔位无关，矛盾时 errorCode 优先）', () => {
    assert.strictEqual(verdict.deriveDataLayerOutcome({
      status: 'not_found', errorCode: ERROR_CODES.PAGE_NO_RESULT,
      dataLayerFailed: false, dataLayerNotFound: true,
    }), 'business_empty');
    // 矛盾形态：布尔位像失败，errorCode 胜出
    assert.strictEqual(verdict.deriveDataLayerOutcome({
      status: 'not_found', errorCode: ERROR_CODES.PAGE_NO_RESULT,
      dataLayerFailed: true, dataLayerNotFound: false,
    }), 'business_empty');
  });

  it('errorCode ∈ {CF_CHALLENGE_UNRESOLVED, DATA_LAYER_NEVER_PUSHED, DATA_LAYER_MISSING} -> failed', () => {
    for (const errorCode of [
      ERROR_CODES.CF_CHALLENGE_UNRESOLVED,
      ERROR_CODES.DATA_LAYER_NEVER_PUSHED,
      ERROR_CODES.DATA_LAYER_MISSING,
    ]) {
      assert.strictEqual(verdict.deriveDataLayerOutcome({
        status: 'not_found', errorCode, dataLayerFailed: true,
      }), 'failed', errorCode);
    }
    // 矛盾形态：notFound=true 也被 errorCode 压过
    assert.strictEqual(verdict.deriveDataLayerOutcome({
      status: 'not_found', errorCode: ERROR_CODES.CF_CHALLENGE_UNRESOLVED,
      dataLayerFailed: true, dataLayerNotFound: true,
    }), 'failed');
  });

  it('status=success 且非失败/无结果形态 -> hit（布尔位是过程信号，不压过 success）', () => {
    assert.strictEqual(verdict.deriveDataLayerOutcome({ status: 'success' }), 'hit');
    // HTML 兜底成功形态：dataLayerFailed=true 是过程信号，终态语义 hit
    assert.strictEqual(verdict.deriveDataLayerOutcome({
      status: 'success', dataLayerFailed: true, dataLayerNotFound: false,
    }), 'hit');
    assert.strictEqual(verdict.deriveDataLayerOutcome({
      status: 'success', dataLayerNotFound: true,
    }), 'hit');
  });

  it('无 errorCode 时布尔位兜底：notFound=true -> business_empty', () => {
    assert.strictEqual(verdict.deriveDataLayerOutcome({
      status: 'not_found', dataLayerFailed: false, dataLayerNotFound: true,
    }), 'business_empty');
    // dataLayerFailed=true 也被 notFound=true 压过（业务无结果优先）
    assert.strictEqual(verdict.deriveDataLayerOutcome({
      status: 'not_found', dataLayerFailed: true, dataLayerNotFound: true,
    }), 'business_empty');
  });

  it('无 errorCode 时布尔位兜底：failed=true 且 notFound!==true -> failed', () => {
    assert.strictEqual(verdict.deriveDataLayerOutcome({
      status: 'not_found', dataLayerFailed: true, dataLayerNotFound: undefined,
    }), 'failed');
    assert.strictEqual(verdict.deriveDataLayerOutcome({
      status: 'not_found', dataLayerFailed: true, dataLayerNotFound: false,
    }), 'failed');
    assert.strictEqual(verdict.deriveDataLayerOutcome({
      status: 'not_found', dataLayerFailed: true,
    }), 'failed');
  });

  it('errorCode 不带 dataLayer 语义时仍走布尔位兜底', () => {
    assert.strictEqual(verdict.deriveDataLayerOutcome({
      status: 'error', errorCode: ERROR_CODES.NO_PRODUCT_URL, dataLayerFailed: true,
    }), 'failed');
    assert.strictEqual(verdict.deriveDataLayerOutcome({
      status: 'error', errorCode: ERROR_CODES.NO_PRODUCT_URL, dataLayerNotFound: true,
    }), 'business_empty');
  });

  it('其余形态 -> unknown（通用 catch / sku_mismatch / timeout / 无 dataLayer 信号）', () => {
    assert.strictEqual(verdict.deriveDataLayerOutcome({
      status: 'error', errorCode: ERROR_CODES.NAVIGATION_FAILED_RETRYABLE,
    }), 'unknown');
    assert.strictEqual(verdict.deriveDataLayerOutcome({
      status: 'error', errorCode: ERROR_CODES.UNEXPECTED_ERROR,
    }), 'unknown');
    assert.strictEqual(verdict.deriveDataLayerOutcome({
      status: 'sku_mismatch', errorCode: ERROR_CODES.SKU_MISMATCH,
    }), 'unknown');
    assert.strictEqual(verdict.deriveDataLayerOutcome({
      status: 'timeout', errorCode: ERROR_CODES.GOTO_TIMEOUT,
    }), 'unknown');
    assert.strictEqual(verdict.deriveDataLayerOutcome({ status: 'not_found' }), 'unknown');
    assert.strictEqual(verdict.deriveDataLayerOutcome({
      status: 'not_found', dataLayerFailed: false, dataLayerNotFound: false,
    }), 'unknown');
  });

  it('null/undefined result -> unknown', () => {
    assert.strictEqual(verdict.deriveDataLayerOutcome(null), 'unknown');
    assert.strictEqual(verdict.deriveDataLayerOutcome(undefined), 'unknown');
  });
});

describe('result-verdict shouldRetryWithNewIp outcome 驱动（阶段 2）', () => {
  it('not_found + CF errorCode + notFound=true（矛盾形态）-> true（errorCode 优先 -> failed）', () => {
    // 真实产出不存在的矛盾形态；钉住"errorCode 优先"这一有意语义
    assert.strictEqual(verdict.shouldRetryWithNewIp({
      status: 'not_found', errorCode: ERROR_CODES.CF_CHALLENGE_UNRESOLVED,
      dataLayerFailed: true, dataLayerNotFound: true,
    }), true);
  });

  it('not_found + DATA_LAYER_MISSING errorCode（无布尔位）-> true', () => {
    assert.strictEqual(verdict.shouldRetryWithNewIp({
      status: 'not_found', errorCode: ERROR_CODES.DATA_LAYER_MISSING,
    }), true);
  });
});

describe('result-verdict isTimeoutError（Error 对象变体）', () => {
  it('name === TimeoutError -> true（无需文案）', () => {
    const e = new Error('page.goto: Timeout 30000ms exceeded');
    e.name = 'TimeoutError';
    assert.strictEqual(verdict.isTimeoutError(e), true);
    const bare = new Error('whatever');
    bare.name = 'TimeoutError';
    assert.strictEqual(verdict.isTimeoutError(bare), true);
  });

  it('文案匹配 /Timeout \\d+ms exceeded/ -> true', () => {
    assert.strictEqual(verdict.isTimeoutError(new Error('page.waitForSelector: Timeout 5000ms exceeded')), true);
  });

  it('非 timeout 异常 -> false', () => {
    assert.strictEqual(verdict.isTimeoutError(new Error('page.goto: net::ERR_TUNNEL_CONNECTION_FAILED')), false);
    assert.strictEqual(verdict.isTimeoutError(new Error('Some random error')), false);
    assert.strictEqual(verdict.isTimeoutError(new Error('timeout but no pattern')), false);
  });

  it('null / 无 message -> false', () => {
    assert.strictEqual(verdict.isTimeoutError(null), false);
    assert.strictEqual(verdict.isTimeoutError({}), false);
  });
});

describe('result-verdict isHeadedFallbackError（Error 对象变体）', () => {
  // 与 channel.js catch 原内联判定逐一对照的预期表：
  //   isTimeout || classifyGotoError(e) === 'retryable' || e.message.includes('net::ERR')
  const cases = [
    // [message, name, expected, 说明]
    ['page.goto: Timeout 30000ms exceeded', 'TimeoutError', true, 'TimeoutError 名'],
    ['page.goto: Timeout 30000ms exceeded', 'Error', true, 'Timeout 文案正则'],
    ['page.goto: net::ERR_TUNNEL_CONNECTION_FAILED', 'Error', true, 'proxy 类经 net::ERR 析取项命中'],
    ['page.goto: net::ERR_PROXY_CONNECTION_FAILED', 'Error', true, 'proxy 类'],
    ['page.goto: net::ERR_CONNECTION_RESET', 'Error', true, 'proxy 类'],
    ['page.goto: net::ERR_TIMED_OUT', 'Error', true, 'net::ERR 非代理类'],
    ['page.goto: net::ERR_NAME_NOT_RESOLVED', 'Error', true, 'net::ERR 非代理类'],
    ['net::ERR_HTTP_RESPONSE_CODE_FAILURE', 'Error', true, '宽集合保留：classify 判 non-retryable 但 includes(net::ERR) 命中'],
    ['page.goto: Navigation failed because browser has disconnected', 'Error', true, 'Navigation failed'],
    ['Connection timeout', 'Error', true, 'classify retryable（timeout includes），无 net::ERR'],
    ['ERR_NAME_NOT_RESOLVED', 'Error', true, 'classify retryable（裸 ERR_NAME，无 net:: 前缀）'],
    ['page.goto: status code 404', 'Error', false, 'HTTP 4xx 文案无 net::ERR -> non-retryable'],
    ['status code 500', 'Error', false, 'HTTP 5xx 文案无 net::ERR'],
    ['Some random error', 'Error', false, '普通错误'],
    ['page.evaluate: TypeError: foo is not a function', 'Error', false, 'evaluate 抛错'],
  ];
  for (const [message, name, expected, note] of cases) {
    it(`[${expected}] ${note}: ${message}`, () => {
      const e = new Error(message);
      e.name = name;
      assert.strictEqual(verdict.isHeadedFallbackError(e), expected);
    });
  }

  it('null / 无 message -> false', () => {
    assert.strictEqual(verdict.isHeadedFallbackError(null), false);
    assert.strictEqual(verdict.isHeadedFallbackError({}), false);
  });

  it('语料对齐：与 channel 原内联判定（classifyGotoError + 正则）全语料等价', () => {
    // 旧实现参考式（channel.js 阶段 1 前 L369-370 原样）
    function legacyInline(e) {
      const isTimeout = e.name === 'TimeoutError' || (e.message && /Timeout \d+ms exceeded/.test(e.message));
      const isRetryableNetwork = classifyGotoError(e) === 'retryable' || (e.message && e.message.includes('net::ERR'));
      return Boolean(isTimeout || isRetryableNetwork);
    }
    const corpus = [
      'page.goto: Timeout 30000ms exceeded',
      'page.waitForFunction: Timeout 20000ms exceeded.',
      'page.goto: net::ERR_TUNNEL_CONNECTION_FAILED',
      'page.goto: net::ERR_PROXY_CONNECTION_FAILED',
      'page.goto: net::ERR_CONNECTION_RESET',
      'page.goto: net::ERR_TIMED_OUT',
      'page.goto: net::ERR_NAME_NOT_RESOLVED',
      'page.goto: net::ERR_CONNECTION_REFUSED',
      'net::ERR_HTTP_RESPONSE_CODE_FAILURE',
      'page.goto: Navigation failed because browser has disconnected',
      'page.goto: status code 404',
      'page.goto: status code 503',
      'Connection timeout',
      'timeout',
      'Timeout',
      'ERR_NAME_NOT_RESOLVED',
      'Some random error',
      'Target closed',
      '',
    ];
    for (const message of corpus) {
      for (const name of ['Error', 'TimeoutError']) {
        const e = new Error(message);
        e.name = name;
        assert.strictEqual(
          verdict.isHeadedFallbackError(e), legacyInline(e),
          `mismatch for name=${name} message=${JSON.stringify(message)}`,
        );
      }
    }
  });
});
