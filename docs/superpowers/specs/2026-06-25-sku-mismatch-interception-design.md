# SKU 不匹配拦截设计

## 背景

当前正式爬取代码 `src/page-crawler.js` 在搜索 SKU 并进入商品详情页后，会直接抓取标题、卖点、规格、图片并写入 Excel，全程没有校验“页面上的实际 SKU 是否等于搜索的 SKU”。

这会导致以下问题：
- 搜索 SKU A 时，网站因无结果、重定向、canonical 跳转等原因实际打开 SKU B 的商品详情页；
- 代码按 SKU A 的名义把 SKU B 的数据写入 Excel；
- 最终 SKU 与数据不匹配。

参考 `vevor_crawler_workflow_v2.js` 中的 `extractPageSku(page)` 和比对逻辑，但参考实现只打印警告、不拦截，因此需要在当前正式代码中增加真正的拦截。

## 目标

在当前正式爬取流程中增加 SKU 不匹配拦截：
- 进入商品详情页后，提取页面真实 SKU；
- 若页面 SKU 与搜索 SKU 不一致，立即停止抓取并返回 `sku_mismatch` 状态；
- 不把错误 SKU 的标题、卖点、规格、图片写入 Excel；
- 在 checkpoint 中独立记录 `mismatched_skus`，便于排查和统计。

## 非目标

- 不重写整个爬取流程；
- 不修改 search result 页的提取逻辑；
- 不对代理、浏览器启动、翻译等模块做改动。

## 设计决策

### 1. 校验位置

将校验放在 `src/page-crawler.js` 的 `PageCrawler.crawlSingleSku` 中，进入商品详情页之后、抓取任何商品数据之前。

理由：`PageCrawler` 负责“一页怎么抓”，自然也应该负责“这页是不是我要抓的”。

### 2. 校验时机

不等到原有 8 秒等待结束后再校验，而是：
1. 进入商品详情页；
2. 处理 Cloudflare；
3. 等待 2 秒让 `dataLayer`/关键 JSON 稳定；
4. 立即提取并比对 SKU；
5. 若不一致，直接返回；
6. 若一致或无法提取，继续原有等待和抓取流程。

这样可以在 SKU 不匹配时提前失败，避免白白等待 8 秒。

### 3. 页面 SKU 提取策略

参考 `vevor_crawler_workflow_v2.js:515-543`，按优先级提取：
1. `window.dataLayer` 中的 `item.product.sku`；
2. `window.dataLayer` 中的 `item.ecommerce.detail.products[0].sku`；
3. HTML 正则 `"sku":"([^"]{5,})"`；
4. `<meta ... sku ... content="...">`。

若全部失败，返回空字符串。

### 4. 无法提取 SKU 时的策略

若 `extractPageSku(page)` 返回空字符串，**放行**，继续原有抓取流程。

理由：
- 无法提取不等于一定不匹配；
- Vevor 页面偶尔会有动态加载或结构变化，强制失败会导致大量误杀；
- 校验的核心目标是“发现不一致时拦截”，不是“必须能提取到 SKU 才能爬”。

### 5. 返回状态

新增状态 `sku_mismatch`。

与 `not_found`、`error` 区分开，便于在 Excel 和 checkpoint 中单独识别。

### 6. Checkpoint 处理

在 `src/crawler.js` 中：
- `loadCheckpoint` 默认结构增加 `mismatched_skus: []`；
- `writerTask` 中分支逻辑改为：
  - `success` → `completed_skus`
  - `not_found` → `not_found_skus`
  - `sku_mismatch` → `mismatched_skus`
  - 其他 → `failed_skus`

## 修改详情

### `src/page-crawler.js`

1. 在 `PageCrawler` 类中新增方法 `extractPageSku(page)`。
2. 在 `crawlSingleSku` 中，进入商品详情页并处理 Cloudflare 后，将原有 `await this.sleep(8000)` 拆分为：
   - `await this.sleep(2000)`（等待 dataLayer 稳定）
   - SKU 校验
   - 若通过，再 `await this.sleep(6000)`（补足原 8 秒等待）
3. SKU 不匹配时设置：
   - `result.status = 'sku_mismatch'`
   - `result.error = 'SKU mismatch: searched ${sku}, page SKU is ${pageSku}'`
   - `result.product_url = page.url()`
   - 立即 `return result`

### `src/crawler.js`

1. `loadCheckpoint` 默认返回值增加 `mismatched_skus: []`。
2. `writerTask` 中增加 `sku_mismatch` 分支：
   ```js
   else if (r.status === 'sku_mismatch') checkpoint.mismatched_skus.push(r.sku);
   ```

## 测试策略

新增/更新测试覆盖以下场景：

1. **SKU 匹配**：mock 页面返回与搜索 SKU 一致的 `dataLayer.sku`，验证结果 `status === 'success'`，且正常抓取到商品数据。
2. **SKU 不匹配**：mock 页面返回不同 SKU，验证结果 `status === 'sku_mismatch'`，`error` 包含两个 SKU，且 `product_name`/`features_details`/`product_specification`/`image_paths` 为空。
3. **无法提取 SKU**：mock 页面没有 SKU 信息，验证结果 `status === 'success'`（放行策略）。
4. **Checkpoint 分类**：验证 `sku_mismatch` 结果进入 `checkpoint.mismatched_skus`。

## 风险与回滚

- **风险**：`extractPageSku` 提取逻辑如果不够鲁棒，可能漏检真实的不匹配情况。可通过多层兜底和观察线上日志逐步优化。
- **回滚**：若发现误拦截正常 SKU，可快速将校验块注释掉，或改为仅打印警告不拦截。

## 验收标准

- [ ] `src/page-crawler.js` 中存在 `extractPageSku(page)` 方法。
- [ ] `crawlSingleSku` 在抓取数据前完成 SKU 校验。
- [ ] SKU 不一致时返回 `status: 'sku_mismatch'` 且不抓取标题/规格/图片。
- [ ] `src/crawler.js` 将 `sku_mismatch` 写入 `checkpoint.mismatched_skus`。
- [ ] 相关测试通过。
