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

// dataLayer 复合信号：dataLayer 异常且非业务无结果。
// `dataLayerNotFound !== true`（而非 `!`）：undefined 也算失败——extract 未跑完
// 的路径（CF / DATA_LAYER_* 异常）按 dataLayer 失败对待，这是现有 worker.js
// 语义的显式化；在 true/false/undefined 值域内与 channel 的 `!` 判读等价。
function isDataLayerSignal(result) {
  return !!result && result.dataLayerFailed === true && result.dataLayerNotFound !== true;
}

// 该 result 是否值得换 IP 重试一次。
// 不含 channel 状态（reinitializing）与全局开关（retryOnTimeout）两个守卫，
// 那两个留在 worker。
//
// classifyFallback（可选，阶段 2 末删除）：旧 result 无 errorCode 时的兼容兜底。
// 由调用方注入 classifyGotoError，本模块保持零依赖、不解析 error 文案；
// 注入后按 { retryable, proxy } 判定，等价于接入前的 worker.js 行为。
function shouldRetryWithNewIp(result, classifyFallback) {
  if (!result) return false;

  if (result.status === 'not_found' && isDataLayerSignal(result)) {
    return true;
  }

  if (result.status === 'error') {
    if (result.errorCode) {
      return RETRYABLE_ERROR_CODES.has(result.errorCode);
    }
    // 兼容兜底（阶段 2 末删除）：防御 cli 模式/测试构造的无码 result
    if (typeof classifyFallback === 'function' && typeof result.error === 'string') {
      const category = classifyFallback({ message: result.error });
      return category === 'retryable' || category === 'proxy';
    }
    return false;
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
// 阶段 1 只交付判定并用单测钉住语义，channel 计数段代码不动；
// 阶段 2 重写计数段时才由它驱动。
//
// 语义（channel.js 计数段 + success 清零的合并净效果）：
// - success → reset（优先级最高：现状是"先 ++ 后清零"的顺序抵消，净效果即清零）
// - dataLayer 复合信号（见 isDataLayerSignal）→ increment
// - 非业务无结果（dataLayerNotFound !== true）→ reset
// - 业务无结果（dataLayerNotFound === true）→ hold（保留计数）
function dataLayerCounterAction(result) {
  if (result && result.status === 'success') return 'reset';
  const r = result || {};
  if (r.dataLayerFailed === true && r.dataLayerNotFound !== true) return 'increment';
  if (r.dataLayerNotFound !== true) return 'reset';
  return 'hold';
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
// 最后一段 error 文案正则是旧 result（无 errorCode）兼容兜底，阶段 2 末可删。
function isTimeoutResult(result) {
  if (!result) return false;
  if (result.status === 'timeout') return true;
  if (result.errorCode === ERROR_CODES.TASK_DEADLINE_EXCEEDED ||
      result.errorCode === ERROR_CODES.GOTO_TIMEOUT) {
    return true;
  }
  // 过渡兼容（阶段 2 末可删）：无 errorCode 的旧 result 回落文案正则
  return /Timeout \d+ms exceeded/.test(result.error || '');
}

module.exports = {
  ERROR_CODES,
  isDataLayerSignal,
  shouldRetryWithNewIp,
  isRegionFallbackCandidate,
  dataLayerCounterAction,
  isHeadedFallbackCandidate,
  isTimeoutResult,
};
