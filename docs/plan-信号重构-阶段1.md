# 信号重构 · 阶段 1：errorCode 全覆盖 + 判定收拢

> **现状问题（一句话）**：单 SKU 抓取结果的"判读逻辑"（换 IP 重试、区域回退、dataLayer 计数、headed 回退、timeout 识别）散落在 worker / channel 共 6 处，且各自用不同的布尔位组合与 error 文案正则做判定，语义依赖 `dataLayerNotFound` 的 undefined 怪癖和执行顺序。
> **方案（一句话）**：给 crawlSingleSku 的全部返回分支补上机器可读 `errorCode`（error 文案不动），新建零依赖纯函数模块 `src/result-verdict.js` 把所有判读逻辑收拢成一组可单测的判定函数，worker/channel 的消费点逐个换成 verdict 调用（channel 计数段内部本阶段不动）。
> **预估改动量**：源码 4 个文件（page-crawler.js / worker.js / channel.js / 新增 result-verdict.js），新增测试 1 个文件约 40~50 个用例；现有 521 个测试必须全绿不动。

---

## 1. 目标与非目标

### 目标

1. **errorCode 全场景覆盖**：crawlSingleSku 的 8 个返回分支 + timeout 双产地，每个终态结果都带稳定的机器可读 `errorCode`，内部判读不再依赖 error 文案正则。
2. **判定收拢**：worker / channel 中对 result 的判读（换 IP 重试、区域回退、headed 回退、timeout 识别、dataLayer 计数动作）全部改为调用 `src/result-verdict.js` 的纯函数，判定语义只在一个地方定义。
3. **语义钉住**：用单测把 `dataLayerNotFound === undefined` 的现有语义（含怪癖）显式钉在 verdict 模块上，为阶段 2 重写 channel 计数段提供对照基准。

### 非目标（本阶段明确不做）

- **不动 channel 计数逻辑内部**：channel.js L350-360（dataLayerFailureCount 增减）与 L391-399（success 清零 / adaptive 调用）的代码结构、执行顺序、计数结果保持不变；本阶段只产出 `dataLayerCounterAction()` 判定函数并用测试钉住语义，channel 里暂不接它（或仅以"等价替换"方式接入，见 §4 边界说明）。
- **不删布尔位**：`dataLayerFailed` / `dataLayerNotFound` / `cfChallengeFailed` 全部保留原样产出。
- **不动红线**：
  - pusher.js `buildBody`（src/pusher.js:103-118）：`success` 布尔由 `status === 'success'` 折叠、`errorMessage` 透传 `result.error`，payload 字段一字不动。
  - error 文案不变：`CF_CHALLENGE_UNRESOLVED`、`Page shows no result`、`No product URL found`、`SKU mismatch: ...`、`DATA_LAYER_*` 等 `result.error` 文案保持原样（pusher 透传 + channel 现存正则在本阶段仍可能读到）。
  - cli checkpoint 分类（src/crawler.js:449-454 `classifyResult`：success / not_found / sku_mismatch / failed_skus 兜底）不变。
  - status 枚举值（success / not_found / sku_mismatch / error / timeout / success_translate_error）不变。

---

## 2. errorCode 编码表设计

### 2.1 事实核查：当前 errorCode 的真实存量

写 plan 前对源码逐行核实（2026-10-10，main 分支）：

- **唯一现存的 errorCode 是 `PAGE_NO_RESULT`**（src/page-crawler.js:445），由 worker.js:189 的区域回退消费。
- `CF_CHALLENGE_UNRESOLVED`、`DATA_LAYER_NEVER_PUSHED`、`DATA_LAYER_MISSING` **目前只是 `result.error` 字符串**（page-crawler.js:408/471/584），**不是 errorCode**。本阶段是把它们"提升"为 errorCode，而非沿用已有码。
- CF 分支还产出 `cfChallengeFailed = true`（page-crawler.js:410、473），此前盘点遗漏，编码表需覆盖。
- 商品页 CF 分支（L470-475）的 `dataLayerNotFound` **不是 undefined**：L425 `result.dataLayerNotFound = !!extractResult.dataLayerNotFound` 在 goto 商品页之前已执行，该分支上它是布尔值。真正 undefined 的只有两处：搜索页 CF 分支（L407-413，extract 未跑）和 DATA_LAYER_* catch 分支（L582-588，extract 在 L421 抛错、L424-425 未执行）。

### 2.2 编码表全文

风格：全大写下划线。所有取值集中在 `src/result-verdict.js` 导出为 `ERROR_CODES` 常量（冻结对象），page-crawler / worker 引用常量赋值，杜绝字符串散落。

| errorCode | 产出位置（现状行号） | status | 现有 error 文案（不动） | 现有布尔位 | 说明 |
|---|---|---|---|---|---|
| `CF_CHALLENGE_UNRESOLVED` | page-crawler.js L407-413（搜索页 CF 未过）、L470-475（商品页 CF 未过） | not_found | `CF_CHALLENGE_UNRESOLVED` | dataLayerFailed=true, cfChallengeFailed=true；dataLayerNotFound 搜索页=undefined / 商品页=布尔 | 新增 errorCode（error 文案提升为码） |
| `PAGE_NO_RESULT` | page-crawler.js L438-448（hasNoResult 命中） | not_found | `Page shows no result` | 继承 extract 产出（通常 dataLayerFailed=false, dataLayerNotFound=true） | **已存在**，不动 |
| `NO_PRODUCT_URL` | page-crawler.js L438-448（hasNoResult 未命中） | not_found | `No product URL found` | 继承 extract 产出（dataLayerNotFound=true 或 dataLayerFailed=true 两种） | 新增 |
| `SKU_MISMATCH` | page-crawler.js L482-487 | sku_mismatch | `SKU mismatch: searched ${sku}, page SKU is ${pageSku}` | 无 dataLayer 位 | 新增 |
| `DATA_LAYER_NEVER_PUSHED` | page-crawler.js L582-588（catch 中 `e.message === 'DATA_LAYER_NEVER_PUSHED'`） | not_found | `DATA_LAYER_NEVER_PUSHED` | dataLayerFailed=true，dataLayerNotFound=undefined | 新增 errorCode（从 error 前缀派生） |
| `DATA_LAYER_MISSING` | page-crawler.js L582-588（catch 中 `e.message` 以 `DATA_LAYER_MISSING:` 开头） | not_found | `DATA_LAYER_MISSING: ${原始信息}` | dataLayerFailed=true，dataLayerNotFound=undefined | 新增 errorCode（error 文案保留完整后缀） |
| `NAVIGATION_FAILED_RETRYABLE` | page-crawler.js L589-590（通用 catch，`classifyGotoError(e) === 'retryable'`） | error | 原始 `e.message` | 无 | 新增。goto 超时、net::ERR（非代理类）、Navigation failed |
| `PROXY_CONNECTION_FAILED` | page-crawler.js L589-590（通用 catch，`classifyGotoError(e) === 'proxy'`） | error | 原始 `e.message` | 无 | 新增。ERR_TUNNEL/PROXY_CONNECTION_FAILED/CONNECTION_RESET |
| `UNEXPECTED_ERROR` | page-crawler.js L589-590（通用 catch，`classifyGotoError(e) === 'non-retryable'`） | error | 原始 `e.message` | 无 | 新增。含 goto 的 HTTP 4xx/5xx 与一切非导航异常（evaluate 抛错等），无法进一步区分时统一落此码 |
| `TASK_DEADLINE_EXCEEDED` | worker.js L292-294（deadline 兜底，`TaskDeadlineError.code` 已有此值，见 worker.js:4） | timeout | `Task deadline ${ms}ms exceeded` | 无 | 新增到 result.errorCode；码值直接复用现有 `TaskDeadlineError.code` |
| `GOTO_TIMEOUT` | channel.js L424-427（catch 中 `TimeoutError` / `Timeout \d+ms exceeded`，挂 `e.status='timeout'`）→ worker.js buildErrorResult 映射 | timeout | 原始 `e.message`（`Timeout 30000ms exceeded` 等） | 无 | 新增。与 `TASK_DEADLINE_EXCEEDED` 区分：前者是 page.goto 单次超时，后者是任务整体 200s 兜底，排查价值不同 |

**关于 timeout 双产地的设计决定**：不用单一 `TASK_TIMEOUT` 合并，而是 `TASK_DEADLINE_EXCEEDED`（worker deadline，worker.js:260-266 的 200s 兜底）与 `GOTO_TIMEOUT`（page.goto 超时，channel.js:424-427）两码并存。理由：两者运维含义不同——前者是"任务整体卡死"（可能是 CF 等待耗尽、慢代理），后者是"单次导航超时"（坏出口典型信号）；`isTimeoutResult()` 对两者都返回 true，消费方不感知差异，但日志/Grafana 可按码区分。worker.js 的 `buildErrorResult`（L67-79）需要补一段映射：`err.status === 'timeout'` 或 `err.name === 'TimeoutError'` → `errorCode = GOTO_TIMEOUT`；`err.code === 'TASK_DEADLINE_EXCEEDED'` → `errorCode = TASK_DEADLINE_EXCEEDED`。

**关于 goto/网络类 error 的设计决定（重点）**：通用 catch（L589-590）的 `e.message` 是任意字符串，两个候选方案——

- 方案 A：泛化码 `NAVIGATION_FAILED` 一统。
- 方案 B（**采纳**）：在产出点调用现成的 `classifyGotoError`（page-crawler.js:598-629），按类别派生三码 `PROXY_CONNECTION_FAILED` / `NAVIGATION_FAILED_RETRYABLE` / `UNEXPECTED_ERROR`。

选 B 的理由：
1. **消费方本来就在做同样的分类**——worker.js:48-53 的换 IP 判定正是 `classifyGotoError({message: result.error})` 后看 retryable/proxy。分类从"消费时解析文案"前移为"产出时打码"，消除对 error 文案的二次解析（这是雷③的一半）。
2. classifyGotoError 是现成的纯函数，产出点调用零成本、零新依赖。
3. 方案 A 把分类留给了下游，等于没解决文案解析问题。
4. 代价：B 把"classifyGotoError 的分类规则"固化进了 errorCode 的取值空间，未来改分类规则要同步改码表——可接受，因为码表集中在 verdict 模块常量里，单点修改。

**不设 errorCode 的场景**：

- **success 分支**（L573-575）：不设 errorCode（字段保持 undefined）。消费方判成功一律用 `status === 'success'`，不需要码。
- **extractProductUrlWithRetry 的内部中间态**（L276/284/286/291/301 的五组布尔位）：这些是过程信号不是终态，不单独设码；它们经由 crawlSingleSku 的分支归并到上表 8 个终态之一。布尔位原样透传到 result（不删）。
- **worker 合成的非 crawl 错误**（区域未知/禁用 L143、rotate 失败 L227/L243-246、push 失败兜底 L327-331）：本阶段不设码（区域拒绝已有明确 error 文案且无内部判读消费；rotate/push 失败保留原文案追加语义）。如未来需要再扩表。

---

## 3. 新模块设计：src/result-verdict.js

纯函数、零依赖（不 require 任何项目模块；`classifyGotoError` 的调用只发生在 page-crawler 产出侧，verdict 内部不再解析 error 文案——阶段 1 内 channel L384/L395 的正则在接入 verdict 时通过 errorCode 判定，不再碰 classifyGotoError）。

### 3.1 模块骨架

```js
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
```

### 3.2 API 清单（签名 + 语义 + 封装的现有判读）

**`shouldRetryWithNewIp(result) → boolean`**
- 语义：该 result 是否值得换 IP 重试一次（不含 channel 状态与全局开关，那两个守卫留在 worker）。
- 封装现有逻辑：worker.js:42-57。
  - `status==='not_found' && dataLayerFailed===true && dataLayerNotFound!==true` → true（注意 `!== true`：undefined 也算失败，这是雷①的显式化，函数内注释写明）
  - `status==='error' && errorCode ∈ {NAVIGATION_FAILED_RETRYABLE, PROXY_CONNECTION_FAILED}` → true（等价于现状的 classifyGotoError ∈ {retryable, proxy}；阶段 1 接入时 worker 改读 errorCode，旧 result 无 errorCode 的兜底见 §4）
  - `status==='timeout'` → true（双产地合并在此）
- 当前等价逻辑位置：src/worker.js:37-60（`Worker.shouldRetryWithNewIp` 去掉 retryOnTimeout / channel.reinitializing 两个守卫后的剩余部分）。

**`isRegionFallbackCandidate(result) → boolean`**
- 语义：该 result 是否满足"区域无结果回退 US 站"的入口条件（不含 NO_RESULT_FALLBACKS 映射与 regionRegistry 检查，留在 worker）。
- 封装：`status === 'not_found' && errorCode === 'PAGE_NO_RESULT'`。
- 当前等价逻辑位置：src/worker.js:189（已是 errorCode 化，本函数是纯搬运，让判读入口统一）。

**`dataLayerCounterAction(result) → 'increment' | 'hold' | 'reset'`**
- 语义：该 result 对 channel.dataLayerFailureCount 应执行的动作，显式三态。
- 封装现有逻辑（channel.js:350-360 与 391-394 的合并净效果）：
  - `status === 'success'` → `'reset'`（对应 L392-394；**优先级最高**，显式消除"先 ++ 后清零"的顺序抵消——见边界说明）
  - `dataLayerFailed && !dataLayerNotFound` → `'increment'`（对应 L351-355；`!` 判读：undefined 按失败计，雷①显式化）
  - `!dataLayerNotFound` → `'reset'`（对应 L356-360）
  - 否则（dataLayerNotFound === true）→ `'hold'`（业务无结果保留计数）
- 当前等价逻辑位置：src/channel.js:350-360 + src/channel.js:391-394。
- **边界（阶段 1/2 划分）**：本阶段该函数只作为"判定封装"交付并用单测钉住语义，channel.js 的计数代码**不改**；阶段 2 重写计数段时才真正由它驱动。若评审认为阶段 1 就接入更顺，可做等价替换，但替换后 WARNING 日志（L353-354）的触发时机必须逐一对齐现有行为并在 PR 描述中说明。

**`isHeadedFallbackCandidate(result) → boolean`**
- 语义：error 终态的 result 是否值得启动 headed 浏览器重试（不含 `this.headedFallback && this.headedBrowserLauncher` 配置守卫，留在 channel）。
- 封装现有逻辑：channel.js:382-389 的 `errMsg.includes('net::ERR') || /Timeout \d+ms exceeded/.test(errMsg) || errMsg.includes('Navigation failed')`，改为：`status === 'error' && errorCode ∈ {NAVIGATION_FAILED_RETRYABLE, PROXY_CONNECTION_FAILED}`。
- 等价性论证：现有正则覆盖的三类文案全部来自 page.goto 抛错，经通用 catch（L589-590）产出；classifyGotoError 对这些文案的判定：`net::ERR_TUNNEL/PROXY/RESET` → proxy，其余 `net::ERR` / `Timeout` / `Navigation failed` → retryable（page-crawler.js:600-627）。两集合的并恰为 {retryable, proxy}。非 goto 来源的 error（如 evaluate 抛错）现正则匹配不到、新判定落 UNEXPECTED_ERROR 也不匹配——等价。**例外**：`ERR_HTTP_RESPONSE_CODE_FAILURE` / 4xx/5xx 文案含 `net::ERR` 时现正则会命中 headed fallback，而 classifyGotoError 判 non-retryable → 新判定不命中。这是一个**已识别的行为差异**（现状下 HTTP 500 页面也会触发 headed 重试，浪费一次 headed 启动；新行为更合理），需在 PR 描述中显式声明，并用测试钉住新行为。
- 注意：channel.js:368-379 还有**异常路径**的 headed fallback 判定（crawl 抛异常时 `isTimeout || isRetryableNetwork`），它作用在 Error 对象上而非 result 上，本阶段不动；阶段 2 统一处理。

**`isTimeoutResult(result) → boolean`**
- 语义：result 是否为超时终态（任一产地）。
- 封装：`status === 'timeout' || errorCode ∈ {TASK_DEADLINE_EXCEEDED, GOTO_TIMEOUT} || /Timeout \d+ms exceeded/.test(result.error || '')`。第三阶段保留 error 文案正则作为**旧 result 兼容兜底**（无 errorCode 时），函数内注释标明这是过渡兼容，阶段 2 末可删。
- 当前等价逻辑位置：src/channel.js:395（`isTimeoutResult` 正则）、worker.js:272/293/355 的 timeout 判定。

**`isDataLayerSignal(result) → boolean`**（内部辅助，可导出供测试）
- 语义：`dataLayerFailed === true && dataLayerNotFound !== true`——即"dataLayer 异常且非业务无结果"的复合信号，worker 与 channel 判读的最小公共因子。
- 当前等价逻辑位置：src/worker.js:42、src/channel.js:351（两处判读符号不同：`!== true` vs `!`，对 undefined 行为一致、对 falsy 非 undefined 值（如 `0`/`''`）行为不同——实际产出只有 true/false/undefined 三种，两式等价；函数内注释钉死这一论证）。

### 3.3 undefined 怪癖的显式化约定

verdict 模块顶部注释固定写明三条事实（来自源码核实）：

1. `dataLayerNotFound` 只可能取 `true / false / undefined` 三值；undefined 出现在"extract 未跑或未跑完"的路径（搜索页 CF、DATA_LAYER_* 异常、通用 catch）。
2. 现有两个消费点判读符号不同（worker `!== true`、channel `!`），在上述值域内等价；verdict 统一用 `!== true` 并把等值论证写成注释。
3. 商品页 CF 分支（page-crawler.js:470-475）的 `dataLayerNotFound` 是布尔（L425 已赋值），不是 undefined——排查时勿误判。

---

## 4. 改动清单（按文件）

### src/result-verdict.js（新增）

- 上节全部内容：ERROR_CODES 常量 + 6 个导出函数。纯新增。

### src/page-crawler.js

| 位置 | 改动 | 类型 |
|---|---|---|
| L407-413（搜索页 CF） | 增 `result.errorCode = ERROR_CODES.CF_CHALLENGE_UNRESOLVED` | 纯新增赋值 |
| L438-448（无结果分支） | `noResult` 分支已有 PAGE_NO_RESULT 不动；else 分支增 `result.errorCode = ERROR_CODES.NO_PRODUCT_URL` | 纯新增赋值 |
| L470-475（商品页 CF） | 增 `result.errorCode = ERROR_CODES.CF_CHALLENGE_UNRESOLVED` | 纯新增赋值 |
| L482-487（SKU 校验） | 增 `result.errorCode = ERROR_CODES.SKU_MISMATCH` | 纯新增赋值 |
| L582-588（DATA_LAYER_* catch） | 增 errorCode 赋值：`e.message === 'DATA_LAYER_NEVER_PUSHED'` → NEVER_PUSHED；`e.message.startsWith('DATA_LAYER_MISSING')` → MISSING（用正则 `^DATA_LAYER_([A-Z_]+)` 提取后查表，未知值落 UNEXPECTED_ERROR 防呆） | 纯新增赋值 |
| L589-590（通用 catch） | 增 `result.errorCode = mapClassifyGotoError(classifyGotoError(e))`：proxy→PROXY_CONNECTION_FAILED，retryable→NAVIGATION_FAILED_RETRYABLE，non-retryable→UNEXPECTED_ERROR。映射函数放 page-crawler 内（它已 require 自己的 classifyGotoError，同文件直接用） | 纯新增赋值 |
| 全部 | error 文案、status、布尔位一行不动 | — |

### src/worker.js

| 位置 | 改动 | 类型 |
|---|---|---|
| L37-60 `shouldRetryWithNewIp` | 方法体重写为：守卫（retryOnTimeout / channel）保留 → `return verdict.shouldRetryWithNewIp(result)`。其中 error 分支由 classifyGotoError 文案解析改为 errorCode 判定；**兼容兜底**：`result.errorCode` 缺失时回落到旧 classifyGotoError 路径（防御 cli 模式/测试构造的无码 result），回落代码注释标注"阶段 2 末删除" | 需逻辑等价变换 |
| L189 区域回退 | `result.status === 'not_found' && result.errorCode === 'PAGE_NO_RESULT'` → `verdict.isRegionFallbackCandidate(result)` | 纯替换 |
| L292-294 deadline | `result.status='timeout'` 后增 `result.errorCode = ERROR_CODES.TASK_DEADLINE_EXCEEDED` | 纯新增赋值 |
| L67-79 `buildErrorResult` | 增 errorCode 映射：`err.code === 'TASK_DEADLINE_EXCEEDED'` → TASK_DEADLINE_EXCEEDED；`err.status === 'timeout'` 或 TimeoutError/`Timeout \d+ms exceeded` → GOTO_TIMEOUT；其余不设 | 纯新增赋值 |

### src/channel.js

| 位置 | 改动 | 类型 |
|---|---|---|
| L382-389（error-result 的 headed fallback） | `isNetworkError` 正则判定 → `verdict.isHeadedFallbackCandidate(result)` | 需逻辑等价变换（行为差异见 §3.2：HTTP 4xx/5xx 不再触发，PR 中声明） |
| L395-396（isTimeoutResult） | 正则 → `verdict.isTimeoutResult(result)` | 纯替换（verdict 内部含兜底正则，等价） |
| L350-360、L391-394（计数段） | **本阶段不动** | — |
| L368-379（异常路径 headed fallback） | **本阶段不动**（作用在 Error 上，阶段 2 处理） | — |

### 不动的文件（确认清单）

pusher.js、image-uploader.js（L167 门控只看 status）、crawler.js（cli 模式 L427/L438/L449-454）、service.js（L513-560 消费 channel 计数器字段，字段语义不变）、poller.js、region-registry.js。

---

## 5. 测试计划

### 5.1 新增 test/result-verdict.test.js（约 40~50 用例）

**shouldRetryWithNewIp**
- not_found + dataLayerFailed=true + dataLayerNotFound=undefined → true（雷①核心用例：CF 搜索页 / DATA_LAYER_* 形态）
- not_found + dataLayerFailed=true + dataLayerNotFound=false → true（重试耗尽形态，page-crawler L301）
- not_found + dataLayerFailed=true + dataLayerNotFound=true → false（业务无结果）
- not_found + dataLayerFailed=false + dataLayerNotFound=true → false（PAGE_NO_RESULT 形态）
- not_found + 无 dataLayer 字段（{}）→ false（dataLayerFailed 非 true）
- error + errorCode=NAVIGATION_FAILED_RETRYABLE → true
- error + errorCode=PROXY_CONNECTION_FAILED → true
- error + errorCode=UNEXPECTED_ERROR → false
- error + 无 errorCode + error='page.goto: Timeout 30000ms exceeded' → true（兜底路径）
- error + 无 errorCode + error='net::ERR_TUNNEL_CONNECTION_FAILED' → true（兜底路径）
- error + 无 errorCode + error='status code 404' → false（兜底路径）
- status=timeout → true（不区分产地）
- success / sku_mismatch → false

**isRegionFallbackCandidate**
- not_found + PAGE_NO_RESULT → true
- not_found + NO_PRODUCT_URL / CF_CHALLENGE_UNRESOLVED → false
- error + PAGE_NO_RESULT → false（status 不对）

**dataLayerCounterAction**（钉住语义，为阶段 2 对照）
- success + dataLayerFailed=true + dataLayerNotFound=false → 'reset'（**顺序抵消场景**：现状净效果是清零，三态显式化后必须仍是 reset）
- success + 无 dataLayer 位 → 'reset'
- not_found + dataLayerFailed=true + dataLayerNotFound=undefined → 'increment'
- not_found + dataLayerFailed=true + dataLayerNotFound=false → 'increment'
- not_found + dataLayerFailed=false + dataLayerNotFound=true → 'hold'
- not_found + dataLayerFailed=false + dataLayerNotFound=false → 'reset'
- not_found + 无 dataLayer 位（dataLayerNotFound=undefined, dataLayerFailed=undefined）→ 'reset'（对应 channel L356 `!undefined` 为真）
- error 终态 → 按同一组布尔位规则推导（channel 现状对 error result 也走 L350-360，行为需对齐）

**isHeadedFallbackCandidate**
- error + NAVIGATION_FAILED_RETRYABLE / PROXY_CONNECTION_FAILED → true
- error + UNEXPECTED_ERROR → false（含"HTTP 500 不再触发"的行为差异钉例）
- not_found / timeout / success → false

**isTimeoutResult**
- status=timeout（无 errorCode）→ true
- errorCode=TASK_DEADLINE_EXCEEDED / GOTO_TIMEOUT → true
- status=error + error='Timeout 30000ms exceeded'（无 errorCode）→ true（兜底）
- status=error + error 无 Timeout 文案 → false

**isDataLayerSignal**：true/false/undefined 三值 × dataLayerFailed 三值的全组合表（9 例）。

### 5.2 既有测试加固

- page-crawler 相关测试（test/page-crawler-cf-rotation.test.js、page-crawler-datalayer-notfound.test.js 等）补充断言：各分支 result 带预期 errorCode。**只加断言不改既有断言**。
- worker-retry-on-timeout.test.js / worker-deadline.test.js：补 errorCode 断言（GOTO_TIMEOUT / TASK_DEADLINE_EXCEEDED）。

### 5.3 全局门禁

- `npm test`：现有 **521 个测试必须全绿不动**（2026-10-10 基线：521 pass / 128 suites / 0 fail）。
- 每个 PR 合并前跑：`npm test` + `node test-sku.js <已知可用 SKU>` 冒烟（有代理环境时）。

---

## 6. PR 切分与验证

### PR-1：errorCode 编码表落地（page-crawler + worker 产出侧）

- 内容：新增 result-verdict.js（仅 ERROR_CODES + 纯判定函数，先不被引用）；page-crawler 6 处 errorCode 赋值；worker buildErrorResult / deadline 两处 errorCode 赋值。
- 验证：`npm test` 全绿 + `node --test test/result-verdict.test.js` + page-crawler/worker 相关测试文件单跑。
- 风险：极低（纯新增字段，无消费方）。
- 回滚：revert 单 PR 即可，result 多一个字段对 pusher buildBody 无影响（buildBody 只取固定字段，见 pusher.js:103-118）。

### PR-2：worker 判读切换 verdict

- 内容：worker.js L37-60 / L189 换 verdict 调用（含无 errorCode 兜底）。
- 验证：`npm test` 全绿；重点跑 `node --test test/worker.test.js test/worker-retry-on-timeout.test.js test/worker-region.test.js test/worker-channel-integration.test.js`。
- 回滚：revert；兜底路径保证旧 result 形态行为不变。

### PR-3：channel error 文案判定切换 verdict（L382-389 / L395-396）

- 内容：headed fallback 的 error-result 分支与 isTimeoutResult 换 verdict。
- 验证：`npm test` 全绿；重点跑 `node --test test/channel-headed-fallback.test.js test/channel.test.js test/stealth-adaptive.test.js`。
- 声明事项：HTTP 4xx/5xx error 不再触发 headed fallback 的行为差异写进 PR 描述。
- 回滚：revert。

### 每个 PR 的通用验证命令

```bash
npm test                                    # 521 全绿
node --test test/result-verdict.test.js     # 新模块单测
git diff --stat                             # 确认只动了计划内文件
```

### 阶段 1 完成定义（DoD）

1. 8 个返回分支 + timeout 双产地全部带 errorCode（用 grep 验证：`grep -n "errorCode" src/page-crawler.js src/worker.js`）。
2. worker / channel 中对 result 的判读无一处直接读 `result.dataLayerFailed` / `result.dataLayerNotFound` / error 文案正则（channel L350-360 计数段与 L368-379 异常路径除外，那是阶段 2 范围）。
3. `npm test` 521 全绿 + 新 verdict 测试全绿。
