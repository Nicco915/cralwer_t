# 信号重构 · 阶段 2：channel 计数段重写

> **现状问题（一句话）**：channel.js L340-430 的完成路径上，dataLayerFailureCount 的增减靠"L350-360 先 ++ / L392-394 后清零"的执行顺序抵消维持正确性，`dataLayerNotFound` 的 undefined 语义靠 `!` 判读隐式兜住，error 文案正则同时承担上行红线和内部判定双重身份——三颗雷任何一次无关改动都可能引爆。
> **方案（一句话）**：先为该区段现有行为补边界测试钉住基准，再把计数逻辑重写为由 `verdict.dataLayerCounterAction()` 三态驱动的显式状态机，`dataLayerNotFound` undefined 语义在派生点一次性收敛为内部三态 `dataLayerOutcome`，error 文案正则全部换成阶段 1 落地的 errorCode 判定。
> **预估改动量**：源码 1 个文件为主（channel.js，约 60 行重写）+ worker.js 兜底路径删除（约 10 行）；新增边界测试约 25~35 用例（channel 现有行为钉例）+ verdict 测试增补；现有 521 个测试必须全绿不动（阶段 1 完成后基数会多于 521，以当时基数为准）。

---

## 1. 目标与非目标

### 目标：拆三颗雷

- **雷① dataLayerNotFound 的 undefined 语义**：现状 undefined 出现在"extract 未跑或未跑完"的路径（搜索页 CF 分支 page-crawler.js:407-413、DATA_LAYER_* catch page-crawler.js:582-588、通用 catch），而 worker.js:42 用 `!== true`、channel.js:351/356 用 `!` 两种判读。目标：内部统一派生出显式三态 `dataLayerOutcome: 'hit' | 'business_empty' | 'failed' | 'unknown'`，派生只在 verdict 模块一个地方做，channel/worker 不再直接读这两个布尔位。
- **雷② L351 与 L392 的顺序抵消**：现状 success + HTML 兜底（dataLayerFailed=true, dataLayerNotFound=false）场景下，channel.js:351-355 先 `++`（可能触发 L353-354 的 WARNING 日志）、channel.js:392-394 再清零，净效果靠执行顺序。目标：单点判定 `dataLayerCounterAction(result)` 三态驱动，一个 result 只产生一个动作，无顺序依赖。
- **雷③ error 文案双重身份**：现状 `result.error` 既是 pusher 上行 errorMessage（红线），又被 channel.js:384（headed fallback）与 channel.js:395（isTimeoutResult）正则匹配。阶段 1 已把这两处换成 errorCode 判定；本阶段收尾：channel.js:368-379 **异常路径**的 headed fallback 判定（作用在 Error 对象上的 `isTimeout` / `classifyGotoError` 文案解析）与 worker 中的无 errorCode 兜底路径一并收编。

### 非目标

- **仍不删布尔位**：`dataLayerFailed` / `dataLayerNotFound` / `cfChallengeFailed` 继续原样产出与透传（删除是已搁置的阶段 3）。`dataLayerOutcome` 是派生视图，不是替代品。
- **不动红线**：pusher payload（success 折叠、errorMessage 透传）、cli checkpoint 分类（crawler.js:449-454）、status 枚举，同阶段 1。
- **不动 service.js 的轮换策略**：checkChannelForRotation（service.js:513-560）继续读 `channel.consecutiveFailures` / `lastFailureWasProxy` / `needsProxyRotation()`（channel.js:216-218），字段名与阈值语义不变。
- **不动 adaptive 的阈值参数**：`adaptiveTimeoutThreshold` / `adaptiveRecoverySuccesses` / `adaptiveDataLayerThreshold`（channel.js:37-39）数值与配置键不变。

---

## 2. 前置工作（硬顺序：先补测试，再动代码）

在改任何 channel 代码**之前**，先为 channel.js L340-430（crawl 完成路径 + catch 路径）补边界测试，把现有行为钉成黄金基准。测试文件建议 `test/channel-counter-baseline.test.js`（新）+ 既有 channel-datalayer-rotation.test.js / stealth-adaptive.test.js 补例。

### 用例清单（每个用例断言 consecutiveFailures / dataLayerFailureCount / lastFailureWasProxy 的预期序列）

**dataLayerFailureCount 序列**
1. 连续 3 次 `not_found + dataLayerFailed=true + dataLayerNotFound=undefined`（CF 搜索页形态）→ 计数 1→2→3，第 3 次触发 WARNING 日志；`needsProxyRotation()`（阈值 dataLayerProxyRotationThreshold=2）从第 2 次起为 true。
2. 上述序列后接一次 `not_found + dataLayerNotFound=true`（业务无结果）→ 计数**保持 3**（hold 语义，channel.js:356-357 注释明确"保留不变"）。
3. 上述序列后接一次 `success` → 计数清零。
4. `success + dataLayerFailed=true + dataLayerNotFound=false`（HTML 兜底成功，page-crawler.js:286 形态）→ **顺序抵消场景**：现状最终计数为 0；WARNING 日志在该次会瞬时触发一次（L351-355 的 ++ 达到阈值时）。此用例同时钉住"最终值=0"和"WARNING 会误发一次"两个现状事实——重写后最终值必须仍为 0，WARNING 误发消失（见 §3.3 的显式偏差声明）。
5. `not_found + dataLayerFailed=false + dataLayerNotFound=false`（PAGE_NO_RESULT 但 extract 未失败的理论形态）→ 计数清零（channel.js:356 `!dataLayerNotFound` 分支）。
6. 商品页 CF 形态：`not_found + dataLayerFailed=true + cfChallengeFailed=true + dataLayerNotFound=false`（布尔，非 undefined——page-crawler.js:425 已赋值）→ 计数 ++。

**consecutiveFailures / lastFailureWasProxy**
7. crawl 抛 `ERR_TUNNEL_CONNECTION_FAILED` → consecutiveFailures=1，lastFailureWasProxy=true（channel.js:421-422、493-498）。
8. 上例后接一次普通 error（如 evaluate 抛错）→ consecutiveFailures=2，lastFailureWasProxy=false。
9. 连续 2 次代理错误后 service.checkChannelForRotation 判定 `proxyFailed=true`（service.js:525）——service 侧已有 service-health-check-rotation.test.js，此处只补 channel 字段侧断言。

**timeout 与 adaptive**
10. crawl 抛 `TimeoutError`（`Timeout 30000ms exceeded`）→ e.status='timeout'（channel.js:424-427），consecutiveTimeouts +1，达 adaptiveTimeoutThreshold=2 后 effectiveStealthMode 切 session（channel.js:149-165）。
11. result 形态 `status=error + error 含 'Timeout 30000ms exceeded'` → isTimeoutResult 正则命中（channel.js:395），同样驱动 adaptive 的 timeouts 路径。
12. timeout 后接 success → consecutiveTimeouts 清零、consecutiveSuccesses 累计；session 模式下连续 adaptiveRecoverySuccesses=3 次 success 切回 channel 模式（channel.js:170-179）。
13. timeout 后接 not_found（非 timeout 失败）→ consecutiveTimeouts 清零、consecutiveSuccesses 清零（channel.js:168、180-184）。

**僵尸/迟到完成不触碰状态**
14. deadline 作废后迟到完成（isStale）→ 所有计数/刷新/adaptive/currentTask 一律不动（channel.js:408-409、415-419、450-455）。已有 worker-late-completion.test.js 覆盖部分场景，补齐计数器字段的断言。

**验证命令**：`node --test test/channel-counter-baseline.test.js test/channel.test.js test/channel-datalayer-rotation.test.js test/stealth-adaptive.test.js` 全绿后，才允许进入 §3 的重写。这些测试在重写后**必须不修改地继续全绿**（除 §3.3 显式声明的两处偏差对应用例）。

---

## 3. 重写设计

### 3.1 dataLayerOutcome 三态（雷①）

在 `src/result-verdict.js`（阶段 1 产出）新增派生函数，**全项目唯一派生点**：

```js
// 从 errorCode + 布尔位派生 dataLayer 维度的事实结论。
// 优先级：errorCode 为准（产出点语义最明确），布尔位兜底（兼容阶段 1 前的旧 result 形态）。
function deriveDataLayerOutcome(result) {
  // 'business_empty'：业务无结果（SKU 在该区域确实没有）
  // 'failed'：dataLayer 抽取失败（CF 未过 / dataLayer 未推送或缺失 / 重试耗尽）
  // 'hit'：dataLayer 正常命中
  // 'unknown'：extract 未跑或未跑完（通用 catch、非 dataLayer 路径），等价于现状 undefined 的处理
}
```

派生规则（与现状逐条对照）：

| 条件 | outcome | 对应的现状形态 |
|---|---|---|
| errorCode ∈ {PAGE_NO_RESULT} 或 dataLayerNotFound === true | `business_empty` | extract L284/L291 |
| errorCode ∈ {CF_CHALLENGE_UNRESOLVED, DATA_LAYER_NEVER_PUSHED, DATA_LAYER_MISSING} 或 (dataLayerFailed === true && dataLayerNotFound !== true) | `failed` | CF 双分支、DATA_LAYER catch、extract L301 |
| status === 'success' 且非上两行 | `hit` | 正常成功 |
| 其余 | `unknown` | 通用 catch、sku_mismatch 等 |

`dataLayerCounterAction()`（阶段 1 已交付）内部改由 outcome 驱动：`failed → 'increment'`、`business_empty → 'hold'`、`hit → 'reset'`、`unknown → 'reset'`（对齐 channel.js:356 `!undefined === true` 的现行为，用例 5/6 钉住）。对外签名与返回值不变，阶段 1 的 verdict 测试继续全绿。

worker 侧 `shouldRetryWithNewIp` 同步改用 outcome：`failed → 换 IP`、`business_empty → 不换`，与现状 `!== true` 语义逐案对齐（阶段 1 测试已钉）。

### 3.2 计数逻辑显式状态机（雷②）

channel.js crawl 完成路径重写为"一次判定、一次落地"：

```
result 到手（含 headed fallback 之后的最终 result）
  └─ isStale() → 全部跳过（现状不变）
  └─ action = verdict.dataLayerCounterAction(result)
       'increment' → dataLayerFailureCount++，达阈值打 WARNING
       'reset'     → dataLayerFailureCount = 0
       'hold'      → 不动
  └─ updateAdaptiveState(...)（入参来源改为 verdict 判定，见 3.3）
  └─ consecutiveFailures = 0; lastFailureWasProxy = false（成功落地路径，现状不变）
```

要点：
- 现状 L350-360（crawl 成功后立即计数）与 L391-394（success 清零）两个分离代码块合并为一个判定块，物理上相邻，顺序抵消从结构上不可能再发生。
- 异常路径（catch，channel.js:414-429）保持现有结构：`consecutiveFailures++` / `lastFailureWasProxy = isProxyError(e)` / timeout 挂 status / `updateAdaptiveState`，只把其中的文案判定换成 errorCode 化（见 3.3）。
- **显式偏差声明（PR 描述必须写）**：
  1. 用例 4 的 WARNING 误发消失——现状下 HTML 兜底成功且计数达阈值时会先打一条 WARNING 再清零，重写后不再打。这是误报的消除，Grafana 若对该日志有告警需同步摘除。
  2. 阶段 1 已声明的偏差：HTTP 4xx/5xx error 不再触发 headed fallback。

### 3.3 error 文案判定全量 errorCode 化（雷③收尾）

阶段 1 已改：channel.js:382-389（error-result 的 headed fallback）、channel.js:395（isTimeoutResult）、worker.js:48-53（换 IP 的 classifyGotoError）。
本阶段收尾：

| 位置 | 现状 | 改为 |
|---|---|---|
| channel.js:368-369（异常路径 headed fallback 判定） | `e.name === 'TimeoutError' \|\| /Timeout \d+ms exceeded/.test(e.message)` + `classifyGotoError(e) === 'retryable' \|\| e.message.includes('net::ERR')` | 抽 verdict 新函数 `isHeadedFallbackError(e) → boolean`：内部仍是同一组文案判定（异常对象没有 errorCode 可用），但判定逻辑收进 verdict 模块单测钉住，channel 不再内联正则。**注意保持现状集合**：`isRetryableNetwork` 里的 `includes('net::ERR')` 比 classifyGotoError 的 retryable 集合宽（涵盖 non-retryable 的 HTTP 4xx/5xx 文案），为保持行为等价先原样搬运，是否收窄单独提 issue 评估 |
| channel.js:424（catch 内 isTimeout） | 同上正则 | `verdict.isTimeoutError(e)`（与 isTimeoutResult 共享正则实现） |
| worker.js 阶段 1 遗留的无 errorCode 兜底分支（shouldRetryWithNewIp 内 classifyGotoError 回落） | 兜底 | 删除——前提是阶段 1 全量发版后所有 result 必带 errorCode；删除前用日志观察确认无兜底命中（加一次性 debug 日志，灰度一个发版周期） |
| verdict.isTimeoutResult 内的兜底正则 | 兜底 | 同上，同步删除 |

updateAdaptiveState（channel.js:149-185）签名不变，但三个入参的产出来源统一：
- `status`：原样传。
- `isTimeout`：`verdict.isTimeoutResult(result)` / 异常路径 `verdict.isTimeoutError(e)`。
- `dataLayerFailed`：改为 `verdict.deriveDataLayerOutcome(result) === 'failed'`——注意这与现入参 `result.dataLayerFailed` 有细微差异：现状 success + HTML 兜底场景 dataLayerFailed=true 会参与 L154 的 `dataLayerStreakHit` 计算（虽然 L392 已清零计数，使 `dataLayerFailureCount >= threshold` 恒为 false，实际不触发）。重写后 success 路径 outcome='hit'，语义更干净；用 §2 用例 4 的扩展断言钉住"不触发 adaptive"这一净行为。

---

## 4. 阶段间依赖

阶段 2 依赖阶段 1 的以下产出，开工前逐项确认已合并：

1. **errorCode 编码表全量落地**（阶段 1 PR-1）：本阶段 §3.1 的派生规则以 errorCode 为准判定，缺任何一个码（尤其 CF_CHALLENGE_UNRESOLVED / DATA_LAYER_* / GOTO_TIMEOUT / TASK_DEADLINE_EXCEEDED）派生就会退化到布尔位兜底，雷①拆不干净。
2. **verdict 模块及测试**（阶段 1 PR-1）：`dataLayerCounterAction` / `isTimeoutResult` / `isHeadedFallbackCandidate` 已存在且语义被单测钉住，本阶段只做"内部改 outcome 驱动 + 新增 Error 对象变体"，不重新定义语义。
3. **worker/channel 的 result 判读已切换**（阶段 1 PR-2/PR-3）：本阶段 §3.3 删除的兜底路径是阶段 1 引入的，删除时机依赖阶段 1 已在全部节点（VPS 8 容器 + 加拿大 Windows 8 进程）发版并稳定运行至少一个观察周期。
4. **测试基数更新**：阶段 1 后 `npm test` 基数 > 521，本阶段 §2 的"全绿"以新基数为准。

---

## 5. 改动清单（按文件）

### src/result-verdict.js（阶段 1 已存在，本阶段扩展）

| 改动 | 类型 |
|---|---|
| 新增 `deriveDataLayerOutcome(result)` + 导出 | 纯新增 |
| `dataLayerCounterAction` 内部改 outcome 驱动（签名/返回值不变） | 需逻辑等价变换（阶段 1 测试钉住） |
| 新增 `isHeadedFallbackError(e)` / `isTimeoutError(e)`（Error 对象变体） | 纯新增（搬运 channel 内联正则） |
| `shouldRetryWithNewIp` 内部改 outcome 驱动 | 需逻辑等价变换 |
| 删除 `isTimeoutResult` 内的兜底正则（PR-3，灰度确认后） | 删除 |

### src/channel.js（主战场，L340-430 区段）

| 位置 | 改动 | 类型 |
|---|---|---|
| L350-360 + L391-394 | 合并为单一 `dataLayerCounterAction` 驱动块（§3.2） | 重写（行为等价，2 处显式偏差除外） |
| L368-369 | 内联正则/classifyGotoError → `verdict.isHeadedFallbackError(e)` | 纯替换（集合原样搬运） |
| L382-389 | 阶段 1 已改，本阶段复查 | — |
| L395-396 | 阶段 1 已改，本阶段随 verdict 删兜底 | 跟随 |
| L424 | 正则 → `verdict.isTimeoutError(e)` | 纯替换 |
| L396/L428 updateAdaptiveState 入参 | dataLayerFailed 入参改 outcome 派生 | 需逻辑等价变换 |
| L149-185 updateAdaptiveState 本体 | 不动 | — |
| L216-218 needsProxyRotation、L63-65 阈值字段 | 不动 | — |

### src/worker.js

| 位置 | 改动 | 类型 |
|---|---|---|
| shouldRetryWithNewIp 内兜底分支 | 灰度确认后删除 | 删除 |
| 其余 | 不动 | — |

### 不动的文件

pusher.js、crawler.js、image-uploader.js、service.js（确认 checkChannelForRotation 消费字段语义不变）、page-crawler.js（本阶段零改动——布尔位与 errorCode 产出已在阶段 1 定型）。

---

## 6. 测试计划

1. **§2 的基线测试**：重写前后都必须全绿（除两条显式偏差对应用例按新行为更新，PR 中逐条说明）。
2. **verdict 增补测试**（test/result-verdict.test.js）：
   - deriveDataLayerOutcome：errorCode 全值 × 布尔位三态的笛卡尔积（重点：errorCode 缺失时布尔位兜底、errorCode 与布尔位矛盾时 errorCode 优先）。
   - isHeadedFallbackError：TimeoutError 名 / `Timeout N ms exceeded` / 各 net::ERR 文案 / Navigation failed / 普通 Error → 与 channel 现正则逐一对照的预期表。
   - isTimeoutError：同上 timeout 子集。
3. **状态机序列测试**：对 channel 连续喂 result 序列（mock pageCrawler.crawlSingleSku），断言计数器序列与 §2 基线一致；新增"increment 后 hold 后 reset"等混合序列。
4. **全局门禁**：`npm test` 全绿（新基数）；`node --test test/channel-counter-baseline.test.js test/channel-datalayer-rotation.test.js test/channel-headed-fallback.test.js test/stealth-adaptive.test.js test/worker-retry-on-timeout.test.js test/result-verdict.test.js`。

---

## 7. PR 切分与回滚

### PR-1（前置）：channel 计数段基线测试

- 内容：仅新增/补充测试（§2 用例清单），零源码改动。
- 验证：`npm test` 全绿。
- 回滚：revert（无风险）。
- **合并门禁：此 PR 未合，后续 PR 一律不开工。**

### PR-2：verdict 扩展（deriveDataLayerOutcome + Error 变体 + 内部改 outcome 驱动）

- 内容：§5 verdict 行的"纯新增 + 等价变换"部分；channel/worker 尚未接入新函数。
- 验证：`npm test` 全绿 + verdict 增补用例。
- 回滚：revert。

### PR-3：channel 计数段重写

- 内容：§3.2 状态机 + §3.3 的 isHeadedFallbackError / isTimeoutError 接入 + updateAdaptiveState 入参改造。
- 验证：`npm test` 全绿；§2 基线测试除两条显式偏差用例外**零修改通过**；PR 描述附偏差声明与 Grafana 告警核对清单。
- 灰度：建议先在加拿大 Windows 单节点发版观察 1~2 天（dataLayerFailureCount 相关日志、轮换频率无异常漂移），再全量 VPS。
- 回滚：revert 即恢复旧计数逻辑；因计数器字段名/语义未变，service.js 无联动风险。

### PR-4：兜底路径删除（可与 PR-3 间隔一个发版周期）

- 内容：删除 worker 与 verdict 内的无 errorCode 兜底分支。
- 前置：全节点跑过阶段 1+2，一次性 debug 日志确认兜底零命中。
- 验证：`npm test` 全绿。
- 回滚：revert。

### 阶段 2 完成定义（DoD）

1. `grep -n "dataLayerFailed\|dataLayerNotFound" src/channel.js src/worker.js` 仅剩注释与透传，无判读。
2. `grep -n "net::ERR\|Timeout \\\\d" src/channel.js src/worker.js` 无内联正则（全部收进 verdict）。
3. channel.js 完成路径上每个 result 只经过一次计数判定（代码评审确认）。
4. §2 基线测试 + `npm test` 全绿。
5. 雷①②③ 的拆除在代码上可指认：① deriveDataLayerOutcome 唯一派生点；② 单判定块无顺序依赖；③ error 文案只剩 pusher 上行一个消费者。
