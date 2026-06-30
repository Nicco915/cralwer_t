# SKU 爬虫图片上传设计

## 背景

现有 SKU 爬虫 service 模式会把爬取结果推送到 `/renren-api/classify/open/crawler/callback`，但图片仅保存到本地 `output/images/`，未上传到上游图片接口 `/classify/open/image/upload`。

本设计在 service 模式下新增图片上传能力：主 callback 成功后再把该 SKU 的本地图片上传到上游，单图失败不影响其他图，也不影响主 callback 的成功状态。

## 已确认的需求

| 问题 | 决策 |
|---|---|
| 推送时机 | 主 callback 成功后再补传图片 |
| 失败处理 | 单图失败不影响，尽量多传 |
| 上传后返回的 `id` | 不需要回写上游，只记录本地日志 |
| 同 SKU 多图上传 | 可控并发，默认并发 2 |
| Content-Type 确定 | Magic Bytes + 扩展名校验，冲突时以 Magic Bytes 为准 |
| 启用模式 | 默认仅 service 模式，代码层面复用 `ImageUploader` 组件，CLI 模式保留扩展能力 |

## 架构

```
[Poller] → [Worker] → [Channel.crawl] → result
                              ↓
                    [Pusher.push(result)]
                              ↓
                        callback 成功
                              ↓
                    [ImageUploader.upload(result)]
                              ↓
                POST /classify/open/image/upload
```

- `Pusher`：职责不变，只推送主 callback。
- `ImageUploader`：新增组件，负责读取本地图片、校验格式、base64 编码、并发上传、记录结果。
- `Worker`：协调"爬取 → 主回调 → 图片上传"的顺序。

## 组件设计

### `src/image-uploader.js`

```js
class ImageUploader {
  constructor(options) {
    this.uploadUrl = options.uploadUrl;
    this.nodeCode = options.nodeCode;
    this.nodeToken = options.nodeToken || '';
    this.concurrency = options.concurrency || 2;
    this.maxRetries = options.maxRetries || 3;
    this.retryDelays = options.retryDelays || [1000, 2000, 4000];
    this.fetch = options.fetch || globalThis.fetch;
  }

  async upload(result) { /* 入口 */ }
  _detectContentType(buffer, fallbackExt) { /* Magic Bytes + 扩展名 */ }
  _buildPayload(sku, filePath, contentType) { /* 构造上传 payload */ }
  _uploadSingle(payload) { /* 单张图上传 + 重试 */ }
  _limitConcurrency(items, fn, limit) { /* 并发控制 */ }
}
```

**关键行为：**

- 只上传 `result.status === 'success'` 且 `image_paths` 非空的任务。
- 不存在的路径计入 `skipped`，并带原因。
- 空文件或无法识别的图片计入 `failed`。
- 单张图上传失败只影响该图，其他图继续。
- 返回结果里包含每张成功图的 `id`（来自上游响应），用于本地日志记录。

### Content-Type 校验

| Magic Bytes | MIME 类型 |
|---|---|
| `FF D8 FF` | `image/jpeg` |
| `89 50 4E 47` | `image/png` |
| `52 49 46 46` + 含 `57 45 42 50` | `image/webp` |

扩展名映射：

| 扩展名 | MIME 类型 |
|---|---|
| `.jpg` / `.jpeg` | `image/jpeg` |
| `.png` | `image/png` |
| `.webp` | `image/webp` |

冲突时以 Magic Bytes 为准，并输出 warning log。两者都无法识别时该图计入 `failed`。

### Worker 改动

在 `Worker.runTask` 中：

1. 调用 `pusher.push(result)` 推送主 callback。
2. 主 callback 成功后，若 `this.imageUploader` 存在且 `result.status === 'success'`，调用 `this.imageUploader.upload(result)`。
3. `Worker.drain()` 需要等待图片上传完成。

## 数据流示例

SKU `ABC-001` 爬取到 3 张图：

1. `Channel.crawl` 返回：
   ```json
   {
     "crawlerTaskId": 1,
     "sku": "ABC-001",
     "status": "success",
     "image_paths": "/output/images/ABC-001_1.jpg;/output/images/ABC-001_2.png;/output/images/ABC-001_3.webp"
   }
   ```

2. `Pusher.push` 成功返回 HTTP 200。

3. `ImageUploader.upload`：
   - 拆分 `image_paths` 为 3 个路径。
   - 并发 2 个调用 `/classify/open/image/upload`。
   - 每张图 payload：
     ```json
     {
       "nodeCode": "crawler-01",
       "nodeToken": "",
       "sku": "ABC-001",
       "imageBase64": "...",
       "contentType": "image/jpeg",
       "fileName": "ABC-001_1.jpg"
     }
     ```

4. 写 `logs/image-upload.log`：
   ```json
   {
     "sku": "ABC-001",
     "uploaded": [{ "id": 123, "fileName": "ABC-001_1.jpg" }],
     "failed": [{ "fileName": "ABC-001_2.png", "error": "timeout" }],
     "skipped": []
   }
   ```

## 错误处理

### 单张图重试

- 默认最多 3 次，退避 `[1000, 2000, 4000]` ms。
- 可重试：网络超时、HTTP 5xx、连接断开。
- 不可重试：HTTP 400（含 Content-Type 不匹配）、403 / 401。
- 失败记录 `failed: [{ fileName, error, attempts }]`，继续下一张。

### 整体任务视角

- 图片上传失败不影响主 callback 的 `success` 状态。
- 不因为某一张图失败而重跑整个 SKU。
- 所有图都失败仍认为主流程完成。

## 配置项

| CLI Flag | 环境变量 | 默认值 | 说明 |
|---|---|---|---|
| `--image-upload-url` | `CRAWLER_IMAGE_UPLOAD_URL` | - | `/classify/open/image/upload` 完整地址；未设置时不启用 |
| `--image-upload-concurrency` | `CRAWLER_IMAGE_UPLOAD_CONCURRENCY` | `2` | 单 SKU 图片并发上传数 |
| `--image-upload-retries` | `CRAWLER_IMAGE_UPLOAD_RETRIES` | `3` | 单张图上传重试次数 |
| `--image-upload` / `--no-image-upload` | `CRAWLER_IMAGE_UPLOAD` | `true`（URL 配置后生效） | 是否启用图片上传 |

**接入点：**

- `bin/run.js` 解析配置后传入 `runService(config)`。
- `CrawlerService.start()` 里，当 `config.imageUploadUrl` 存在时，实例化 `ImageUploader` 并传给 `Worker`。
- `Worker` 持有可选的 `imageUploader`，有则在上传阶段调用。

**兼容性：** 默认未配置 `CRAWLER_IMAGE_UPLOAD_URL` 时，行为与现在完全一致；CLI 模式默认不启用。

## 测试

### 单元测试：`test/image-uploader.test.js`

1. `detectContentType`：
   - 正确识别 JPEG / PNG / WebP。
   - 扩展名与 Magic Bytes 不一致时返回 Magic Bytes 并告警。
   - 无法识别时返回 `null`。

2. `upload`：
   - 多图并发上传，验证并发数限制。
   - 单张图失败不影响其他图。
   - 重试逻辑：5xx 重试，4xx 业务错误不重试。

3. Mock 上传服务器返回：
   ```json
   { "code": 0, "data": { "id": 123, "sku": "ABC-001", "contentType": "image/jpeg", "fileName": "ABC-001_1.jpg", "fileSize": 245678 } }
   ```

### 集成测试：扩展 `test/service.integration.test.js`

- 启动 stub callback server 和 stub image upload server。
- 验证主 callback 成功后，图片上传接口收到正确数量请求。
- 验证图片上传失败不会导致再次推送 error callback。

### 真实接口冒烟测试（后续迭代）

- 在 `test/real/` 下扩展真实图片上传冒烟脚本。

## 非目标

- 不修改现有主 callback 的字段和格式。
- 不上传图片 id 回上游（仅本地日志）。
- CLI 模式本次不默认启用图片上传（组件可复用）。
- 不修改图片下载逻辑（仍由 `PageCrawler` 负责）。

## 变更文件

- 新增 `src/image-uploader.js`
- 修改 `src/worker.js`
- 修改 `src/service.js`
- 修改 `src/cli.js`（解析新增配置）
- 新增 `test/image-uploader.test.js`
- 修改 `test/service.integration.test.js`
- 修改 `README.md`
