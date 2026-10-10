const { describe, it } = require('node:test');
const assert = require('node:assert');
const { Channel } = require('../src/channel');

// channel 计数段（channel.js L340-430）黄金基线 —— docs/plan-信号重构-阶段2.md §2。
// 本文件在重写前钉住现状行为（含已识别怪癖），重写后除两条显式偏差用例
// （用例 4 的 WARNING 误发）外必须零修改通过。
//
// result 形态与 page-crawler 真实产出一一对齐（阶段 1 起 errorCode 全量带码）：
// - CF 搜索页：not_found + CF_CHALLENGE_UNRESOLVED + dataLayerFailed=true +
//   cfChallengeFailed=true + dataLayerNotFound 缺省（undefined，extract 未跑）
// - CF 商品页：同上但 dataLayerNotFound=false（extract 已跑完并赋值）
// - 业务无结果：not_found + PAGE_NO_RESULT + dataLayerFailed=false + dataLayerNotFound=true
// - HTML 兜底成功：success + dataLayerFailed=true + dataLayerNotFound=false（success 不设码）

function createMockBrowser() {
  const browser = {
    isConnected: () => true,
    async newContext() {
      const ctx = {
        closed: false,
        async addInitScript() {},
        async newPage() {
          return { closed: false, isClosed: () => false, async close() {} };
        },
        async close() { this.closed = true; },
      };
      ctx.browser = () => browser;
      return ctx;
    },
  };
  return browser;
}

async function createChannel(config = {}) {
  const logs = [];
  const channel = new Channel({
    id: 1,
    config: {
      dataLayerFailureThreshold: 3,
      dataLayerProxyRotationThreshold: 2,
      ...config,
    },
    log: (m) => logs.push(m),
  });
  await channel.init(createMockBrowser());
  return { channel, logs };
}

// crawlSingleSku 每次返回全新对象（channel 会原地写 crawlerTaskId）
function cfSearchPageFailure(sku) {
  return {
    sku,
    status: 'not_found',
    error: 'CF_CHALLENGE_UNRESOLVED',
    errorCode: 'CF_CHALLENGE_UNRESOLVED',
    dataLayerFailed: true,
    cfChallengeFailed: true,
    // dataLayerNotFound 缺省 = undefined（extract 未跑）
  };
}

function cfProductPageFailure(sku) {
  return { ...cfSearchPageFailure(sku), dataLayerNotFound: false };
}

function businessNoResult(sku) {
  return {
    sku,
    status: 'not_found',
    error: 'Page shows no result',
    errorCode: 'PAGE_NO_RESULT',
    dataLayerFailed: false,
    dataLayerNotFound: true,
  };
}

function successResult(sku) {
  return {
    sku,
    status: 'success',
    product_name: 'X',
    product_url: 'https://example.com/p/x',
    images: [],
  };
}

function htmlFallbackSuccess(sku) {
  return {
    ...successResult(sku),
    dataLayerFailed: true,
    dataLayerNotFound: false,
  };
}

async function crawlTimes(channel, makeResult, n, skuPrefix = 'SKU') {
  for (let i = 0; i < n; i++) {
    channel.pageCrawler.crawlSingleSku = async () => makeResult(`${skuPrefix}-${i}`);
    await channel.crawl({ sku: `${skuPrefix}-${i}`, crawlerTaskId: `${skuPrefix}-${i}` });
  }
}

function warningLogs(logs) {
  return logs.filter(l => l.includes('WARNING') && l.includes('dataLayer extraction failed'));
}

describe('channel 计数段基线（plan 阶段2 §2）', () => {
  // 用例 1：连续 3 次 CF 搜索页形态 → 计数 1→2→3，第 3 次触发 WARNING；
  // needsProxyRotation（阈值 2）从第 2 次起为 true
  it('case 1: 连续 CF 搜索页失败计数 1→2→3，第 3 次 WARNING，第 2 次起 needsProxyRotation', async () => {
    const { channel, logs } = await createChannel();
    channel.pageCrawler.crawlSingleSku = async () => cfSearchPageFailure('A');

    await channel.crawl({ sku: 'A', crawlerTaskId: 't1' });
    assert.strictEqual(channel.dataLayerFailureCount, 1);
    assert.strictEqual(channel.needsProxyRotation(), false);
    assert.strictEqual(warningLogs(logs).length, 0);

    await channel.crawl({ sku: 'A', crawlerTaskId: 't2' });
    assert.strictEqual(channel.dataLayerFailureCount, 2);
    assert.strictEqual(channel.needsProxyRotation(), true);
    assert.strictEqual(warningLogs(logs).length, 0);

    await channel.crawl({ sku: 'A', crawlerTaskId: 't3' });
    assert.strictEqual(channel.dataLayerFailureCount, 3);
    assert.strictEqual(channel.needsProxyRotation(), true);
    assert.strictEqual(warningLogs(logs).length, 1);
  });

  // 用例 2：上述序列后接业务无结果（dataLayerNotFound=true）→ 计数保持 3（hold 语义）
  it('case 2: 失败序列后接业务无结果，计数保持不变（hold）', async () => {
    const { channel } = await createChannel();
    await crawlTimes(channel, cfSearchPageFailure, 3);
    assert.strictEqual(channel.dataLayerFailureCount, 3);

    channel.pageCrawler.crawlSingleSku = async () => businessNoResult('B');
    await channel.crawl({ sku: 'B', crawlerTaskId: 't4' });
    assert.strictEqual(channel.dataLayerFailureCount, 3, 'business no-result must hold the counter');
  });

  // 用例 3：上述序列后接一次 success → 计数清零
  it('case 3: 失败序列后接 success，计数清零', async () => {
    const { channel } = await createChannel();
    await crawlTimes(channel, cfSearchPageFailure, 3);
    assert.strictEqual(channel.dataLayerFailureCount, 3);

    channel.pageCrawler.crawlSingleSku = async () => successResult('C');
    await channel.crawl({ sku: 'C', crawlerTaskId: 't4' });
    assert.strictEqual(channel.dataLayerFailureCount, 0);
    assert.strictEqual(channel.needsProxyRotation(), false);
  });

  // 用例 4（顺序抵消场景）：success + dataLayerFailed=true + dataLayerNotFound=false
  // （HTML 兜底成功）。旧现状事实：计数先 ++ 到阈值触发一次 WARNING，随后被 success
  // 清零，最终计数为 0。
  // ⚠ 显式偏差用例（plan §3.3，PR-3 已落地）：重写后单点判定 outcome='hit' → reset，
  // WARNING 误发消失；最终计数=0 与不触发 adaptive 的净行为不变。
  // Grafana 若对 WARNING 日志有告警需同步摘除（用户侧处理）。
  it('case 4: HTML 兜底成功达阈值不再误发 WARNING、最终计数 0、不触发 adaptive', async () => {
    const { channel, logs } = await createChannel({
      stealthMode: 'adaptive',
      adaptiveTimeoutThreshold: 2,
      adaptiveDataLayerThreshold: 2,
      adaptiveRecoverySuccesses: 3,
    });
    await crawlTimes(channel, cfSearchPageFailure, 2);
    assert.strictEqual(channel.dataLayerFailureCount, 2);

    channel.pageCrawler.crawlSingleSku = async () => htmlFallbackSuccess('D');
    await channel.crawl({ sku: 'D', crawlerTaskId: 't3' });

    assert.strictEqual(channel.dataLayerFailureCount, 0, 'net effect must be reset');
    assert.strictEqual(
      warningLogs(logs).length, 0,
      'PR-3 deviation: WARNING misfire removed (single-shot verdict, outcome=hit -> reset)',
    );
    // 扩展断言：adaptive 不被该形态触发（outcome='hit' → dataLayer 维度不计）
    assert.strictEqual(channel.effectiveStealthMode, 'channel');
    assert.strictEqual(channel.consecutiveTimeouts, 0);
    assert.strictEqual(channel.consecutiveSuccesses, 1);
  });

  // 用例 5：not_found + dataLayerFailed=false + dataLayerNotFound=false
  // （PAGE_NO_RESULT 但 extract 未失败的理论形态，真实 result 无此组合，故不带 errorCode）
  // → 计数清零（channel L356 `!dataLayerNotFound` 分支）
  it('case 5: not_found 且无 dataLayer 信号（双 false、无 errorCode）→ 计数清零', async () => {
    const { channel } = await createChannel();
    await crawlTimes(channel, cfSearchPageFailure, 2);
    assert.strictEqual(channel.dataLayerFailureCount, 2);

    channel.pageCrawler.crawlSingleSku = async () => ({
      sku: 'E',
      status: 'not_found',
      error: 'Page shows no result',
      dataLayerFailed: false,
      dataLayerNotFound: false,
    });
    await channel.crawl({ sku: 'E', crawlerTaskId: 't3' });
    assert.strictEqual(channel.dataLayerFailureCount, 0);
  });

  // 用例 6：商品页 CF 形态（dataLayerNotFound=false 布尔，非 undefined）→ 计数 ++
  it('case 6: CF 商品页形态（dataLayerNotFound=false 布尔）→ 计数 ++', async () => {
    const { channel } = await createChannel();
    channel.pageCrawler.crawlSingleSku = async () => cfProductPageFailure('F');

    await channel.crawl({ sku: 'F', crawlerTaskId: 't1' });
    assert.strictEqual(channel.dataLayerFailureCount, 1);
  });

  // 用例 7：crawl 抛 ERR_TUNNEL_CONNECTION_FAILED → consecutiveFailures=1，
  // lastFailureWasProxy=true
  it('case 7: 抛代理错误 → consecutiveFailures=1, lastFailureWasProxy=true', async () => {
    const { channel } = await createChannel();
    channel.pageCrawler.crawlSingleSku = async () => {
      throw new Error('page.goto: net::ERR_TUNNEL_CONNECTION_FAILED');
    };

    await assert.rejects(channel.crawl({ sku: 'G', crawlerTaskId: 't1' }), /ERR_TUNNEL/);
    assert.strictEqual(channel.consecutiveFailures, 1);
    assert.strictEqual(channel.lastFailureWasProxy, true);
    assert.strictEqual(channel.dataLayerFailureCount, 0, 'exception path must not touch dataLayer counter');
  });

  // 用例 8：上例后接一次普通 error → consecutiveFailures=2，lastFailureWasProxy=false
  it('case 8: 代理错误后接普通 error → consecutiveFailures=2, lastFailureWasProxy=false', async () => {
    const { channel } = await createChannel();
    channel.pageCrawler.crawlSingleSku = async () => {
      throw new Error('page.goto: net::ERR_PROXY_CONNECTION_FAILED');
    };
    await assert.rejects(channel.crawl({ sku: 'H', crawlerTaskId: 't1' }));
    assert.strictEqual(channel.consecutiveFailures, 1);
    assert.strictEqual(channel.lastFailureWasProxy, true);

    channel.pageCrawler.crawlSingleSku = async () => {
      throw new Error('page.evaluate: Some random error');
    };
    await assert.rejects(channel.crawl({ sku: 'H', crawlerTaskId: 't2' }), /Some random error/);
    assert.strictEqual(channel.consecutiveFailures, 2);
    assert.strictEqual(channel.lastFailureWasProxy, false);
  });

  // 用例 9：连续 2 次代理错误 → channel 字段侧断言（service.checkChannelForRotation
  // 的 proxyFailed 判定见 service-health-check-rotation.test.js，此处只钉 channel 字段）
  it('case 9: 连续 2 次代理错误 → consecutiveFailures=2, lastFailureWasProxy=true', async () => {
    const { channel } = await createChannel();
    channel.pageCrawler.crawlSingleSku = async () => {
      throw new Error('page.goto: net::ERR_CONNECTION_RESET');
    };

    await assert.rejects(channel.crawl({ sku: 'I', crawlerTaskId: 't1' }));
    await assert.rejects(channel.crawl({ sku: 'I', crawlerTaskId: 't2' }));
    assert.strictEqual(channel.consecutiveFailures, 2);
    assert.strictEqual(channel.lastFailureWasProxy, true);
  });

  // 用例 10：crawl 抛 TimeoutError → e.status='timeout'，consecutiveTimeouts+1，
  // 达 adaptiveTimeoutThreshold=2 后 effectiveStealthMode 切 session
  it('case 10: 抛 TimeoutError → status=timeout，adaptive 两次后切 session', async () => {
    const { channel } = await createChannel({
      stealthMode: 'adaptive',
      adaptiveTimeoutThreshold: 2,
      adaptiveRecoverySuccesses: 3,
    });

    function timeoutError() {
      const err = new Error('page.goto: Timeout 30000ms exceeded');
      err.name = 'TimeoutError';
      return err;
    }
    channel.pageCrawler.crawlSingleSku = async () => { throw timeoutError(); };

    const err1 = await channel.crawl({ sku: 'J', crawlerTaskId: 't1' }).catch(e => e);
    assert.strictEqual(err1.status, 'timeout', 'channel must tag timeout status on the error');
    assert.strictEqual(channel.consecutiveTimeouts, 1);
    assert.strictEqual(channel.effectiveStealthMode, 'channel');

    const err2 = await channel.crawl({ sku: 'J', crawlerTaskId: 't2' }).catch(e => e);
    assert.strictEqual(err2.status, 'timeout');
    assert.strictEqual(channel.consecutiveTimeouts, 2);
    assert.strictEqual(channel.effectiveStealthMode, 'session');
    assert.strictEqual(channel.consecutiveFailures, 2);
    assert.strictEqual(channel.lastFailureWasProxy, false);
  });

  // 用例 11：result 形态 status=error + error 含 'Timeout 30000ms exceeded'
  // （无 errorCode 的旧形态）→ isTimeoutResult 正则命中，同样驱动 adaptive timeouts 路径
  it('case 11: error result 含 Timeout 文案（无 errorCode）→ 驱动 adaptive timeouts', async () => {
    const { channel } = await createChannel({
      stealthMode: 'adaptive',
      adaptiveTimeoutThreshold: 2,
      adaptiveRecoverySuccesses: 3,
    });
    channel.pageCrawler.crawlSingleSku = async () => ({
      sku: 'K',
      status: 'error',
      error: 'page.goto: Timeout 30000ms exceeded',
    });

    await channel.crawl({ sku: 'K', crawlerTaskId: 't1' });
    assert.strictEqual(channel.consecutiveTimeouts, 1);
    assert.strictEqual(channel.effectiveStealthMode, 'channel');
    assert.strictEqual(channel.consecutiveFailures, 0, 'result path resets consecutiveFailures');

    await channel.crawl({ sku: 'K', crawlerTaskId: 't2' });
    assert.strictEqual(channel.consecutiveTimeouts, 2);
    assert.strictEqual(channel.effectiveStealthMode, 'session');
  });

  // 用例 12：timeout 后接 success → consecutiveTimeouts 清零、consecutiveSuccesses 累计；
  // session 模式下连续 adaptiveRecoverySuccesses=3 次 success 切回 channel 模式
  it('case 12: session 模式下 3 次 success 切回 channel，计数器随之清零/累计', async () => {
    const { channel } = await createChannel({
      stealthMode: 'adaptive',
      adaptiveTimeoutThreshold: 2,
      adaptiveRecoverySuccesses: 3,
    });

    function timeoutError() {
      const err = new Error('page.goto: Timeout 30000ms exceeded');
      err.name = 'TimeoutError';
      return err;
    }
    channel.pageCrawler.crawlSingleSku = async () => { throw timeoutError(); };
    await channel.crawl({ sku: 'L', crawlerTaskId: 't1' }).catch(() => {});
    await channel.crawl({ sku: 'L', crawlerTaskId: 't2' }).catch(() => {});
    assert.strictEqual(channel.effectiveStealthMode, 'session');
    assert.strictEqual(channel.consecutiveTimeouts, 2);

    channel.pageCrawler.crawlSingleSku = async () => successResult('L');
    await channel.crawl({ sku: 'L', crawlerTaskId: 't3' });
    assert.strictEqual(channel.consecutiveTimeouts, 0, 'success clears timeout streak');
    assert.strictEqual(channel.consecutiveSuccesses, 1);
    assert.strictEqual(channel.effectiveStealthMode, 'session');

    await channel.crawl({ sku: 'L', crawlerTaskId: 't4' });
    assert.strictEqual(channel.consecutiveSuccesses, 2);
    assert.strictEqual(channel.effectiveStealthMode, 'session');

    await channel.crawl({ sku: 'L', crawlerTaskId: 't5' });
    assert.strictEqual(channel.consecutiveSuccesses, 3);
    assert.strictEqual(channel.effectiveStealthMode, 'channel', 'back to channel after 3 successes');
  });

  // 用例 13：timeout 后接 not_found（非 timeout 失败）→ consecutiveTimeouts 清零、
  // consecutiveSuccesses 清零
  it('case 13: timeout 后接 not_found → consecutiveTimeouts / consecutiveSuccesses 均清零', async () => {
    const { channel } = await createChannel({
      stealthMode: 'adaptive',
      adaptiveTimeoutThreshold: 2,
      adaptiveRecoverySuccesses: 3,
    });

    // 先攒一次 success（consecutiveSuccesses=1）
    channel.pageCrawler.crawlSingleSku = async () => successResult('M');
    await channel.crawl({ sku: 'M', crawlerTaskId: 't1' });
    assert.strictEqual(channel.consecutiveSuccesses, 1);

    // 一次 timeout（timeouts=1, successes 清零）
    const err = new Error('page.goto: Timeout 30000ms exceeded');
    err.name = 'TimeoutError';
    channel.pageCrawler.crawlSingleSku = async () => { throw err; };
    await channel.crawl({ sku: 'M', crawlerTaskId: 't2' }).catch(() => {});
    assert.strictEqual(channel.consecutiveTimeouts, 1);
    assert.strictEqual(channel.consecutiveSuccesses, 0);

    // 再一次 success（timeouts 清零, successes=1）
    channel.pageCrawler.crawlSingleSku = async () => successResult('M');
    await channel.crawl({ sku: 'M', crawlerTaskId: 't3' });
    assert.strictEqual(channel.consecutiveTimeouts, 0);
    assert.strictEqual(channel.consecutiveSuccesses, 1);

    // not_found（非 timeout 失败）→ 两个计数都清零
    channel.pageCrawler.crawlSingleSku = async () => businessNoResult('M');
    await channel.crawl({ sku: 'M', crawlerTaskId: 't4' });
    assert.strictEqual(channel.consecutiveTimeouts, 0);
    assert.strictEqual(channel.consecutiveSuccesses, 0);
    assert.strictEqual(channel.effectiveStealthMode, 'channel');
  });

  // 用例 14：deadline 作废后迟到完成（isStale）→ 所有计数/刷新/adaptive/currentTask
  // 一律不动（worker-late-completion.test.js 覆盖部分场景，此处补齐计数器字段断言）
  it('case 14: 僵尸迟到完成不触碰任何计数/刷新/adaptive/currentTask', async () => {
    const { channel, logs } = await createChannel({
      stealthMode: 'adaptive',
      adaptiveTimeoutThreshold: 2,
    });

    let resolveZombie;
    const zombie = new Promise((res) => { resolveZombie = res; });
    channel.pageCrawler.crawlSingleSku = async () => zombie;

    const crawlPromise = channel.crawl({ sku: 'N', crawlerTaskId: 't9' });
    channel.cancelActiveCrawl();

    // 僵尸迟到 resolve：dataLayer 失败形态（若在正常路径会计数）
    resolveZombie(cfSearchPageFailure('N'));
    await crawlPromise;
    await new Promise(r => setTimeout(r, 20));

    assert.strictEqual(channel.dataLayerFailureCount, 0, 'zombie must not touch dataLayerFailureCount');
    assert.strictEqual(channel.consecutiveFailures, 0);
    assert.strictEqual(channel.lastFailureWasProxy, false);
    assert.strictEqual(channel.consecutiveTimeouts, 0);
    assert.strictEqual(channel.consecutiveSuccesses, 0);
    assert.strictEqual(channel.tasksSincePageRefresh, 0);
    assert.strictEqual(channel.currentTask, null);
    assert.strictEqual(channel.effectiveStealthMode, 'channel');
    assert.ok(logs.some(m => m.includes('late completion dropped') && m.includes('t9')));
  });
});

describe('channel 计数段重写后新增行为钉例（plan 阶段2 §3.2 / §6.3）', () => {
  // §3.2：计数作用在 headed fallback 之后的最终 result 上。
  // 旧实现计数作用在 headless result（error 无布尔位 → reset），headed 结果不再
  // 参与计数；重写后由最终 result 单点判定。此处钉住新行为。
  it('headed fallback 后的最终 result 参与计数（error-result 回退路径）', async () => {
    const mockHeadedBrowser = {
      isConnected: () => true,
      async newContext() {
        const ctx = {
          closed: false,
          async addInitScript() {},
          async newPage() { return { closed: false, isClosed: () => false, async close() {} }; },
          async close() { this.closed = true; },
        };
        ctx.browser = () => mockHeadedBrowser;
        return ctx;
      },
      async close() { this.closed = true; },
      closed: false,
    };
    const { channel } = await createChannel();
    channel.headedFallback = true;
    channel.headedBrowserLauncher = async () => mockHeadedBrowser;

    let call = 0;
    channel.pageCrawler.crawlSingleSku = async () => {
      call++;
      if (call === 1) {
        // headless：error + retryable 码 → 触发 error-result headed 回退
        return {
          sku: 'HF', status: 'error',
          error: 'page.goto: net::ERR_TIMED_OUT',
          errorCode: 'NAVIGATION_FAILED_RETRYABLE',
        };
      }
      // headed：dataLayer 失败形态 → 最终 result，计数 ++
      return cfSearchPageFailure('HF');
    };

    const result = await channel.crawl({ sku: 'HF', crawlerTaskId: 'hf1' });
    assert.strictEqual(result.status, 'not_found');
    assert.strictEqual(channel.dataLayerFailureCount, 1, 'final (headed) result drives the counter');
  });

  // §6.3：混合序列 increment → hold → increment(WARNING) → reset → hold
  it('混合序列：increment 后 hold 后 increment 后 reset 后 hold', async () => {
    const { channel, logs } = await createChannel();

    channel.pageCrawler.crawlSingleSku = async () => cfSearchPageFailure('S1');
    await channel.crawl({ sku: 'S1', crawlerTaskId: 's1' });
    assert.strictEqual(channel.dataLayerFailureCount, 1);

    channel.pageCrawler.crawlSingleSku = async () => businessNoResult('S2');
    await channel.crawl({ sku: 'S2', crawlerTaskId: 's2' });
    assert.strictEqual(channel.dataLayerFailureCount, 1, 'hold keeps the counter');

    channel.pageCrawler.crawlSingleSku = async () => cfSearchPageFailure('S3');
    await channel.crawl({ sku: 'S3', crawlerTaskId: 's3' });
    await channel.crawl({ sku: 'S3', crawlerTaskId: 's4' });
    assert.strictEqual(channel.dataLayerFailureCount, 3);
    assert.strictEqual(warningLogs(logs).length, 1, 'WARNING fires exactly once at threshold');

    channel.pageCrawler.crawlSingleSku = async () => successResult('S4');
    await channel.crawl({ sku: 'S4', crawlerTaskId: 's5' });
    assert.strictEqual(channel.dataLayerFailureCount, 0, 'success resets');

    channel.pageCrawler.crawlSingleSku = async () => businessNoResult('S5');
    await channel.crawl({ sku: 'S5', crawlerTaskId: 's6' });
    assert.strictEqual(channel.dataLayerFailureCount, 0, 'hold at zero stays zero');
    assert.strictEqual(warningLogs(logs).length, 1, 'no additional WARNING');
  });
});
