// result-verdict.js — 单 SKU 抓取结果的判读逻辑收拢模块（信号重构 · 阶段 1）
//
// 纯函数、零依赖（不 require 任何项目模块）。worker / channel 中对 result 的
// 判读（换 IP 重试、区域回退、headed 回退、timeout 识别、dataLayer 计数动作）
// 统一调用本模块，判定语义只在这里定义。
//
// ── undefined 怪癖的显式化约定（来自源码核实，勿凭直觉修改）──
// 1. result.dataLayerNotFound 只可能取 true / false / undefined 三值；
//    undefined 出现在"extract 未跑或未跑完"的路径：搜索页 CF 分支、
//    DATA_LAYER_* 异常分支、通用 catch 分支（page-crawler.js crawlSingleSku）。
// 2. 现有两个消费点判读符号不同（worker `!== true`、channel `!`），在上述
//    值域内等价（值域中不存在 0/'' 等其他 falsy）；本模块统一用 `!== true`。
// 3. 商品页 CF 分支（page-crawler.js）的 dataLayerNotFound 是布尔值
//    （extract 已在 goto 商品页之前跑完并赋值），不是 undefined——排查时勿误判。

const ERROR_CODES = Object.freeze({
  CF_CHALLENGE_UNRESOLVED: 'CF_CHALLENGE_UNRESOLVED',
  PAGE_NO_RESULT: 'PAGE_NO_RESULT',
  NO_PRODUCT_URL: 'NO_PRODUCT_URL',
  SKU_MISMATCH: 'SKU_MISMATCH',
  DATA_LAYER_NEVER_PUSHED: 'DATA_LAYER_NEVER_PUSHED',
  DATA_LAYER_MISSING: 'DATA_LAYER_MISSING',
  NAVIGATION_FAILED_RETRYABLE: 'NAVIGATION_FAILED_RETRYABLE',
  PROXY_CONNECTION_FAILED: 'PROXY_CONNECTION_FAILED',
  UNEXPECTED_ERROR: 'UNEXPECTED_ERROR',
  TASK_DEADLINE_EXCEEDED: 'TASK_DEADLINE_EXCEEDED',
  GOTO_TIMEOUT: 'GOTO_TIMEOUT',
});

// 换 IP 重试 / headed 回退共用的 error 类码集合：
// classifyGotoError 的 retryable（goto 超时、net::ERR 非代理类、Navigation failed）
// 与 proxy（ERR_TUNNEL / PROXY_CONNECTION_FAILED / CONNECTION_RESET）两类。
const RETRYABLE_ERROR_CODES = new Set([
  ERROR_CODES.NAVIGATION_FAILED_RETRYABLE,
  ERROR_CODES.PROXY_CONNECTION_FAILED,
]);

// dataLayer 维度失败类码（阶段 2）：产出点语义最明确的 dataLayer 抽取失败终态。
const DATA_LAYER_FAILED_CODES = new Set([
  ERROR_CODES.CF_CHALLENGE_UNRESOLVED,
  ERROR_CODES.DATA_LAYER_NEVER_PUSHED,
  ERROR_CODES.DATA_LAYER_MISSING,
]);

// timeout 文案判定共享实现（isTimeoutResult / isTimeoutError 共用）。
const TIMEOUT_MESSAGE_RE = /Timeout \d+ms exceeded/;

// dataLayer 复合信号：dataLayer 异常且非业务无结果。
// `dataLayerNotFound !== true`（而非 `!`）：undefined 也算失败——extract 未跑完
// 的路径（CF / DATA_LAYER_* 异常）按 dataLayer 失败对待，这是现有 worker.js
// 语义的显式化；在 true/false/undefined 值域内与 channel 的 `!` 判读等价。
function isDataLayerSignal(result) {
  return !!result && result.dataLayerFailed === true && result.dataLayerNotFound !== true;
}

// ── 阶段 2：dataLayerOutcome 三态（全项目唯一派生点，雷①）──
// 从 errorCode + 布尔位派生 dataLayer 维度的事实结论：
//   'hit'            dataLayer 正常命中（success 且非失败/无结果形态）
//   'business_empty' 业务无结果（SKU 在该区域确实没有）
//   'failed'         dataLayer 抽取失败（CF 未过 / dataLayer 未推送或缺失 / 重试耗尽）
//   'unknown'        extract 未跑或未跑完（通用 catch、非 dataLayer 路径），
//                    等价于现状 undefined 的处理
// 优先级：errorCode 为准（产出点语义最明确），布尔位兜底（兼容无码 result 形态）。
// success 先于布尔位兜底判定：HTML 兜底成功场景（success + dataLayerFailed=true）
// 的布尔位是过程信号不是终态，终态语义是 hit。
function deriveDataLayerOutcome(result) {
  if (!result) return 'unknown';
  if (result.errorCode === ERROR_CODES.PAGE_NO_RESULT) return 'business_empty';
  if (DATA_LAYER_FAILED_CODES.has(result.errorCode)) return 'failed';
  if (result.status === 'success') return 'hit';
  // 布尔位兜底（无 errorCode 或 errorCode 不带 dataLayer 语义时的兼容路径）
  if (result.dataLayerNotFound === true) return 'business_empty';
  if (result.dataLayerFailed === true) return 'failed';
  return 'unknown';
}

// 该 result 是否值得换 IP 重试一次。
// 不含 channel 状态（reinitializing）与全局开关（retryOnTimeout）两个守卫，
// 那两个留在 worker。
//
// error 分支只认 errorCode：所有 error result 必带码（page-crawler 通用 catch
// + worker buildErrorResult 双产出点打码）；阶段 1 的无码 classify 兜底已于
// 阶段 2 PR-4 删除，无码形态防御性判 false。
function shouldRetryWithNewIp(result) {
  if (!result) return false;

  // outcome 驱动（阶段 2）：failed → 换 IP；business_empty / unknown → 不换。
  // 与接入前 isDataLayerSignal（`!== true` 语义）逐案等价，唯一差异是 errorCode
  // 与布尔位矛盾时 errorCode 优先（真实产出不存在矛盾形态，见 deriveDataLayerOutcome）。
  if (result.status === 'not_found' && deriveDataLayerOutcome(result) === 'failed') {
    return true;
  }

  if (result.status === 'error') {
    return RETRYABLE_ERROR_CODES.has(result.errorCode);
  }

  // timeout 双产地（TASK_DEADLINE_EXCEEDED / GOTO_TIMEOUT）合并在此，
  // 消费方不感知差异；日志/Grafana 可按 errorCode 区分。
  if (result.status === 'timeout') {
    return true;
  }

  return false;
}

// 该 result 是否满足"区域无结果回退 US 站"的入口条件。
// 不含 NO_RESULT_FALLBACKS 映射与 regionRegistry 检查，留在 worker。
function isRegionFallbackCandidate(result) {
  return !!result && result.status === 'not_found' && result.errorCode === ERROR_CODES.PAGE_NO_RESULT;
}

// 该 result 对 channel.dataLayerFailureCount 应执行的动作（显式三态）。
// 阶段 1 交付判定并用单测钉住语义；阶段 2 起由 outcome 驱动，
// channel 计数段重写后由它单点驱动（一个 result 只产生一个动作）。
//
// 语义（channel.js 计数段 + success 清零的合并净效果）：
// - failed（dataLayer 抽取失败）→ increment
// - business_empty（业务无结果）→ hold（保留计数）
// - hit（含 success + HTML 兜底的顺序抵消场景）→ reset
// - unknown（无 dataLayer 信号）→ reset（对齐 channel `!undefined` reset 分支）
function dataLayerCounterAction(result) {
  const outcome = deriveDataLayerOutcome(result);
  if (outcome === 'failed') return 'increment';
  if (outcome === 'business_empty') return 'hold';
  return 'reset';
}

// error 终态的 result 是否值得启动 headed 浏览器重试。
// 不含 headedFallback / headedBrowserLauncher 配置守卫，留在 channel。
//
// 等价性：接入前 channel.js 用文案正则（net::ERR / Timeout \d+ms exceeded /
// Navigation failed）判定，这些文案全部来自 page.goto 抛错、经通用 catch 产出，
// classifyGotoError 判为 retryable 或 proxy，两集合的并恰为 RETRYABLE_ERROR_CODES。
// 已识别的行为差异（有意为之，plan 已批准）：HTTP 4xx/5xx 等文案含 net::ERR 的
// 非网络错误（classifyGotoError 判 non-retryable → UNEXPECTED_ERROR）不再触发
// headed 重试——现状下 HTTP 500 页面会浪费一次 headed 启动，新行为更合理。
function isHeadedFallbackCandidate(result) {
  if (!result || result.status !== 'error') return false;
  return RETRYABLE_ERROR_CODES.has(result.errorCode);
}

// result 是否为超时终态（任一产地）。
// status === 'timeout' 为主判定；errorCode 双码为辅。
// 末尾的 error 文案正则不是纯遗留兜底，而是 live 行为（阶段 2 PR-4 决定保留，
// 与 plan §3.3 的删除项有偏差，理由如下）：page-crawler 通用 catch 会把
// goto 重试耗尽的 Timeout 异常吞成 status=error + NAVIGATION_FAILED_RETRYABLE
// 的 result（errorCode 不含超时语义），channel 的 adaptive timeout 记账依赖
// 本正则识别该形态；删除会把这类 result 从 timeout 改判为普通 error
// （consecutiveTimeouts 清零而非累加）。是否将其归并为新 errorCode 另行评估。
function isTimeoutResult(result) {
  if (!result) return false;
  if (result.status === 'timeout') return true;
  if (result.errorCode === ERROR_CODES.TASK_DEADLINE_EXCEEDED ||
      result.errorCode === ERROR_CODES.GOTO_TIMEOUT) {
    return true;
  }
  // goto 超时耗尽被 page-crawler 吞成的 error result（见函数头注释）
  return TIMEOUT_MESSAGE_RE.test(result.error || '');
}

// ── 阶段 2：Error 对象变体（channel 异常路径没有 errorCode 可用，判定收进 verdict）──

// Error 是否为 timeout 异常（与 isTimeoutResult 共享正则实现）。
// 原 channel.js catch 内联：e.name === 'TimeoutError' || /Timeout \d+ms exceeded/.test(e.message)
function isTimeoutError(e) {
  if (!e) return false;
  if (e.name === 'TimeoutError') return true;
  return TIMEOUT_MESSAGE_RE.test(e.message || '');
}

// classifyGotoError 的零依赖副本（源头：page-crawler.js classifyGotoError；
// verdict 不 require 项目模块。test/result-verdict.test.js 用语料逐条对齐两者）。
function classifyGotoMessageLocal(message) {
  const msg = message || '';
  if (
    msg.includes('ERR_TUNNEL_CONNECTION_FAILED') ||
    msg.includes('ERR_PROXY_CONNECTION_FAILED') ||
    msg.includes('ERR_CONNECTION_RESET')
  ) {
    return 'proxy';
  }
  if (
    msg.includes('ERR_HTTP_RESPONSE_CODE_FAILURE') ||
    /(?:status\s+code\s+|\s)([45]\d{2})(?:\s|$|:)/i.test(msg) ||
    msg.includes('status code')
  ) {
    return 'non-retryable';
  }
  if (
    msg.includes('Timeout') ||
    msg.includes('timeout') ||
    msg.includes('ERR_NAME_NOT_RESOLVED') ||
    (
      msg.includes('net::ERR') &&
      !msg.includes('ERR_TUNNEL_CONNECTION_FAILED') &&
      !msg.includes('ERR_PROXY_CONNECTION_FAILED') &&
      !msg.includes('ERR_CONNECTION_RESET')
    ) ||
    msg.includes('Navigation failed')
  ) {
    return 'retryable';
  }
  return 'non-retryable';
}

// 异常路径的 headed fallback 判定（作用在 Error 对象上，异常没有 errorCode）。
// 原样搬运 channel.js catch 内联语义：
//   isTimeout || classifyGotoError(e) === 'retryable' || e.message.includes('net::ERR')
// 注意：`includes('net::ERR')` 析取项比 classify 的 retryable 集合宽（涵盖
// non-retryable 的 HTTP 4xx/5xx 文案如 ERR_HTTP_RESPONSE_CODE_FAILURE），
// 为保持行为等价原样保留；是否收窄单独评估（docs/plan-信号重构-阶段2.md §3.3）。
function isHeadedFallbackError(e) {
  if (!e) return false;
  if (isTimeoutError(e)) return true;
  const msg = e.message || '';
  return classifyGotoMessageLocal(msg) === 'retryable' || msg.includes('net::ERR');
}

module.exports = {
  ERROR_CODES,
  isDataLayerSignal,
  deriveDataLayerOutcome,
  shouldRetryWithNewIp,
  isRegionFallbackCandidate,
  dataLayerCounterAction,
  isHeadedFallbackCandidate,
  isTimeoutResult,
  isTimeoutError,
  isHeadedFallbackError,
};
