# VEVOR Crawler (Reusable Sub-Project)

A reusable VEVOR SKU crawler that can be invoked as a sub-project by a larger application.

## Install

```bash
cd /Users/nz/Downloads/hs_sku/crawler
npm ci
npx playwright install chromium   # only needed if you want to use bundled Chromium
```

> On macOS/Linux you can skip browser installation if system Microsoft Edge is available; the crawler will auto-detect it.

## Quick Start

### Production run

```bash
node bin/run.js \
  --input /path/to/SKU_List.xlsx \
  --output /path/to/output
```

### Service mode (API polling / callback)

Run as a daemon that pulls tasks from an upstream API, crawls with 4 concurrent channels, and pushes each result back.

```bash
CRAWLER_MODE=service \
  CRAWLER_NODE_CODE=crawler-01 \
  CRAWLER_NODE_TOKEN=xxx \
  node bin/run.js
```

Or use the npm script:

```bash
npm run service
```

### Test run (10 SKUs by default)

```bash
node bin/run-test.js \
  --input /path/to/SKU_List.xlsx \
  --output /path/to/output \
  --test-count 3
```

## Service Mode

In service mode the crawler does **not** read an Excel file. Instead it:

1. Polls the upstream task API for tasks assigned to this node.
2. Processes up to 4 tasks concurrently (one per Playwright channel).
3. Pushes each result to the upstream callback API immediately.

### Upstream API Contract

**Pull tasks**

```http
POST /renren-api/classify/open/crawler/tasks
Content-Type: application/json

{
  "nodeCode": "crawler-01",
  "nodeToken": "",
  "limit": 10
}
```

Expected response:

```json
{
  "code": 0,
  "data": [
    { "crawlerTaskId": 1, "sku": "ABC-001" }
  ]
}
```

**Push result**

```http
POST /renren-api/classify/open/crawler/callback
Content-Type: application/json

{
  "crawlerTaskId": 1,
  "sku": "ABC-001",
  "nodeCode": "crawler-01",
  "nodeToken": "",
  "goodsName": "Product name",
  "goodsDesc": "Product description",
  "sourceUrl": "https://eur.vevor.com/p/...",
  "rawContent": "Product specification",
  "success": true,
  "errorMessage": ""
}
```

**Upload product images**

```http
POST /renren-api/classify/open/image/upload
Content-Type: application/json

{
  "nodeCode": "crawler-01",
  "nodeToken": "",
  "sku": "ABC-001",
  "imageBase64": "...",
  "contentType": "image/jpeg",
  "fileName": "ABC-001_1.jpg"
}
```

图片在 `/renren-api/classify/open/crawler/callback` 返回 `success: true` 后上传。单张图片上传失败不会影响其他图片，也不会改变 callback 的成功状态。

**Callback field mapping**

| Crawled field | Callback field | Notes |
|---------------|----------------|-------|
| `product_name` | `goodsName` | Product name from the product page |
| `features_details` | `goodsDesc` | Product features / selling points |
| `product_specification` | `rawContent` | Product specifications |
| `product_url` | `sourceUrl` | Canonical product page URL |
| `status` | `success` | `true` when `status === 'success'` |
| `error` | `errorMessage` | Error message on failure |

See `src/pusher.js` for the exact implementation.

### Service Configuration

| CLI Flag | Environment Variable | Default | Description |
|----------|---------------------|---------|-------------|
| `--mode` | `CRAWLER_MODE` | `cli` | `cli` or `service` |
| `--node-code` | `CRAWLER_NODE_CODE` | hostname | Unique node identifier |
| `--node-token` | `CRAWLER_NODE_TOKEN` | - | Upstream auth token |
| `--task-url` | `CRAWLER_TASK_URL` | `http://117.72.52.0/renren-api/classify/open/crawler/tasks` | Task pull URL |
| `--callback-url` | `CRAWLER_CALLBACK_URL` | `http://117.72.52.0/renren-api/classify/open/crawler/callback` | Result callback URL |
| `--channels` | `CRAWLER_CHANNELS` | `4` | Concurrent crawl channels |
| `--poll-interval` | `CRAWLER_POLL_INTERVAL` | `5000` | Poll interval (ms) |
| `--poll-limit` | `CRAWLER_POLL_LIMIT` | `10` | Tasks per poll |
| `--push-retries` | `CRAWLER_PUSH_RETRIES` | `3` | Callback retry count |
| `--image-upload-url` | `CRAWLER_IMAGE_UPLOAD_URL` | - | 图片上传接口 URL；未设置时不启用 |
| `--image-upload-concurrency` | `CRAWLER_IMAGE_UPLOAD_CONCURRENCY` | `2` | 单 SKU 图片并发上传数 |
| `--image-upload-retries` | `CRAWLER_IMAGE_UPLOAD_RETRIES` | `3` | 单张图上传重试次数 |
| `--image-upload` / `--no-image-upload` | `CRAWLER_IMAGE_UPLOAD` | `true`（URL 配置后生效） | 是否启用图片上传 |

### Multi-machine deployment

Start multiple instances with different `CRAWLER_NODE_CODE`. The upstream system is responsible for task distribution; nodes are stateless and do not communicate with each other.

```bash
# Machine 1
CRAWLER_NODE_CODE=crawler-01 npm run service

# Machine 2
CRAWLER_NODE_CODE=crawler-02 npm run service
```

### 多机器独享代理池部署

所有机器共享同一组 Kuaidaili 凭据（`KUAIDAILI_SECRET_ID` 和 `KUAIDAILI_SECRET_KEY`），通过 `PROXY_MACHINE_INDEX` 与 `PROXY_MACHINE_TOTAL` 将可用 IP 均匀切分，每台机器上的每个 Channel 获得不同 IP。Channel-IP 映射会持久化到 `PROXY_ASSIGNMENTS_FILE`，进程重启后仍保持同一 IP，避免会话中断。

| 环境变量 | 说明 |
|---------|------|
| `PROXY_MACHINE_INDEX` | 当前机器序号，从 `0` 开始 |
| `PROXY_MACHINE_TOTAL` | 机器总数 |
| `PROXY_ASSIGNMENTS_FILE` | 映射持久化文件路径 |

示例：3 台机器部署

```bash
# machine-01
CRAWLER_NODE_CODE=machine-01
CRAWLER_CHANNELS=2
PROXY_MACHINE_INDEX=0
PROXY_MACHINE_TOTAL=3

# machine-02
CRAWLER_NODE_CODE=machine-02
CRAWLER_CHANNELS=1
PROXY_MACHINE_INDEX=1
PROXY_MACHINE_TOTAL=3

# machine-03
CRAWLER_NODE_CODE=machine-03
CRAWLER_CHANNELS=3
PROXY_MACHINE_INDEX=2
PROXY_MACHINE_TOTAL=3
```

### Windows deployment

For Windows hosts we provide two deployment options. Both run each node with `CRAWLER_CHANNELS=1`; scale horizontally by increasing the node count.

**Option 1: Docker Desktop (`scripts/deploy/windows/docker/`)**

Requires Docker Desktop with WSL 2 backend.

```powershell
cd scripts\deploy\windows\docker
copy .env.example .env
# Edit .env with real API endpoints and token
.\deploy.ps1 check
.\deploy.ps1 start
.\deploy.ps1 status
.\deploy.ps1 logs
.\deploy.ps1 stop
```

See [`scripts/deploy/windows/docker/README.md`](scripts/deploy/windows/docker/README.md) for details.

**Option 2: Native PowerShell (`scripts/deploy/windows/native/`)**

No Docker required. Requires Node.js >= 20, npm, and project dependencies installed locally.

```powershell
cd scripts\deploy\windows\native
Copy-Item .env.example .env
# Edit .env with real API endpoints and token
.\deploy.ps1 check
.\deploy.ps1 start
.\deploy.ps1 status
.\deploy.ps1 logs
.\deploy.ps1 stop
```

If PowerShell refuses to run the script, set the execution policy first:

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

See [`scripts/deploy/windows/native/README.md`](scripts/deploy/windows/native/README.md) for details.

## SKU Handling

### SKUs containing hyphens (`-`)

VEVOR's search path treats `-` as a word separator. Searching `https://eur.vevor.com/s/PQFJYNF-250-2T001V7` returns broad matches instead of the exact SKU. To force an exact search, the crawler encodes each `-` as `%2D` in the search URL.

| Step | Handling |
|------|----------|
| Search URL | `PQFJYNF-250-2T001V7` → `https://eur.vevor.com/s/PQFJYNF%2D250%2D2T001V7` |
| dataLayer lookup | Raw SKU with `-` preserved |
| HTML regex extraction | `-` escaped as a literal character |
| Page SKU validation | Case-insensitive comparison with raw SKU |
| Image filenames | Raw SKU with `-` preserved, e.g. `PQFJYNF-250-2T001V7_1.jpg` |
| Callback payload | Raw SKU with `-` preserved in the `sku` field |

Implementation: `src/page-crawler.js` (`encodeSkuForSearchPath`).

## 独立图片传输脚本

不启动爬虫，直接把已有图片文件上传到 `/classify/open/image/upload`。支持多张并发、目录批量、日志监控、**断点续传**——25k 张大目录内存峰值 < 1MB，上次跑过的图片自动跳过。

### 三种典型用法

```bash
# 1. 单张 / 多张位置参数 + 默认 .env 中的 CRAWLER_IMAGE_UPLOAD_URL
node bin/transfer-images.js ./output/ABC-001_1.jpg ./output/ABC-001_2.jpg

# 2. 命令行覆盖接口地址 / 并发 / 重试
node bin/transfer-images.js \
  --upload-url=http://47.92.233.36:8003/renren-api/classify/open/image/upload \
  --upload-concurrency=4 \
  --upload-retries=5 \
  ./img/*.jpg

# 3. 内置 mock 服务（覆盖真实接口，便于 CI / 离线调试）
node bin/transfer-images.js --mock-upload ./img/foo.jpg ./img/bar.jpg
```

### CLI 参数一览

| 参数 | 默认 | 说明 |
|---|---|---|
| `[<path1> <path2> ...]` | — | 一个或多个本地图片路径（空格分隔，去重保序） |
| `--dir=<path>` | — | 扫描整个目录；与位置参数混用时合并 |
| `--recursive` | `false` | 配合 `--dir` 递归子目录 |
| `--upload-url=<url>` | `CRAWLER_IMAGE_UPLOAD_URL` env | 覆盖上传目标地址 |
| `--upload-concurrency=<n>` | env 或 `2` | 同时上传的并发数（worker 池大小） |
| `--upload-retries=<n>` | env 或 `3` | 单图最大重试次数；4xx 立即停止重试，5xx 与业务码非 0 走重试 |
| `--node-code=<code>` | `CRAWLER_NODE_CODE` env | 透传到 payload.nodeCode |
| `--node-token=<token>` | `CRAWLER_NODE_TOKEN` env | 透传到 payload.nodeToken |
| `--mock-upload` | `false` | 启动内置 mock HTTP server，覆盖 `--upload-url` |
| `--no-progress` | `false` | 关闭 stdout 上的逐张日志（`--log-file` 仍写） |
| `--log-file=<path>` | — | 同步追加日志到这个文件，可用 `tail -f` 监控 |
| `--quiet` | `false` | 关闭所有 stdout 日志输出（`--log-file` 仍写） |
| `--state-file=<path>` | `<cwd>/.transfer-state/<sha1-of-dir>.ndjson` | NDJSON 状态文件位置；不存在则视为空集 |
| `--force` | `false` | 忽略 state 全部重传（覆盖默认的 resume 行为） |

环境变量优先级：命令行 `--xxx=` > 进程 env > 代码内 fallback。`--mock-upload` 优先级最高（启动后直接覆盖 `--upload-url`）。

### SKU 推断

`fileName` 匹配 `<sku>_<index>.<ext>` 约定，**去掉末尾 `_数字.扩展名` 得到 SKU**：

| 文件名 | SKU |
|---|---|
| `100PCSGXBSYT00001V0_1.jpg` | `100PCSGXBSYT00001V0` |
| `100PCSGXBSYT00001V0_12.jpg` | `100PCSGXBSYT00001V0` |
| `XYZ-100_3.jpeg` | `XYZ-100` |
| `foo.png`（无 `_N`） | `foo`（回退：去掉扩展名） |

**支持的文件扩展名**（大小写不敏感）：`.jpg` `.jpeg` `.png` `.webp` `.gif` `.bmp`。

### 批量上传整个目录 + 日志监控

```bash
# 单层目录扫描
node bin/transfer-images.js --dir=/mnt/d/images/0625 --upload-concurrency=4

# 递归扫描子目录
node bin/transfer-images.js --dir=/mnt/d/images/0625 --recursive --upload-concurrency=4

# 同时写入日志文件（适合 tail -f 实时监控）
node bin/transfer-images.js \
  --dir=/mnt/d/images/0625 \
  --recursive \
  --log-file=/tmp/transfer.log \
  --upload-concurrency=4

# 另一个终端监控：
tail -f /tmp/transfer.log
```

日志格式：

```
[2026-07-01T14:50:01Z] [INFO] Scanned 142 images from /mnt/d/images (recursive)
[2026-07-01T14:50:01Z] [INFO] Starting transfer: 142 images, uploadUrl=...
[2026-07-01T14:50:03Z] [UPLOAD] [1/142] 100PCSGXBSYT00001V0_1.jpg (26 KB) ...
[2026-07-01T14:50:04Z] [UPLOAD] [1/142] 100PCSGXBSYT00001V0_1.jpg ... ok (id=12345)
[2026-07-01T14:50:05Z] [UPLOAD] [2/142] 100PCSGXBSYT00001V0_2.jpg ... FAIL (七牛图片上传失败)
[2026-07-01T14:55:12Z] [INFO] Done: 142 attempted, 138 success, 4 failed, 312.4s elapsed, 0.45 img/s
```

### 断点续传 / State 文件

跑大目录（> 1000 张）时，进程崩溃或上游恢复后想继续跑，没必要从头传：

```bash
# 第一次：传 25k 张；中途 kill -9 也行（最多丢 ≤ concurrency 张）
node bin/transfer-images.js --dir=/mnt/d/.../images --log-file=/tmp/xfer.log

# 第二次：自动跳过已成功的，只传剩下的
node bin/transfer-images.js --dir=/mnt/d/.../images --log-file=/tmp/xfer.log
```

**state 文件位置**：

- 默认：`<cwd>/.transfer-state/<sha1-of-resolved-dir>.ndjson`（按 `--dir` 的绝对路径派生 sha1）
- 覆盖：`--state-file=/path/to/state.ndjson`

例：`/mnt/d/project/hs-sku-crawler/.transfer-state/3a4b5c6d7e8f.ndjson`

**强制重传**：`--force`（忽略 state 全部重新传）

state 文件每行一条 NDJSON：

```json
{"basename":"100PCSGXBSYT00001V0_1.jpg","sku":"100PCSGXBSYT00001V0","id":12345,"ts":"2026-07-01T14:50:04Z","uploadUrl":"http://.../upload"}
```

字段含义：`basename` 主键 · `sku` 推断 SKU · `id` 上游返回 id · `ts` ISO 时间 · `uploadUrl` 上传 endpoint。

**内存特性**：流式扫描 + worker 内逐张 `readFile`，25k 张峰值 < 1MB。

**重要约束**：**不要同时跑两个 `transfer-images` 进程处理同一 `--dir`**，会双写 state 文件混乱。

### 终态输出 (stdout)

单块 JSON：

```json
{
  "total": 3,
  "success": 2,
  "failed": 1,
  "results": [
    {
      "path": "/mnt/d/.../100PCSGXBSYT00001V0_1.jpg",
      "sku": "100PCSGXBSYT00001V0",
      "fileName": "100PCSGXBSYT00001V0_1.jpg",
      "contentType": "image/jpeg",
      "fileSize": 26789,
      "ok": true,
      "response": { "id": 12345, "sku": "100PCSGXBSYT00001V0", ... }
    },
    {
      "path": "/mnt/d/.../100PCSGXBSYT00001V0_2.jpg",
      "sku": "100PCSGXBSYT00001V0",
      "fileName": "100PCSGXBSYT00001V0_2.jpg",
      "contentType": "image/jpeg",
      "fileSize": 28103,
      "ok": false,
      "error": "Upload business failure: 七牛图片上传失败"
    },
    {
      "path": "100PCSGXBSYT00001V0_3.jpg",
      "sku": "100PCSGXBSYT00001V0",
      "fileName": "100PCSGXBSYT00001V0_3.jpg",
      "contentType": null,
      "fileSize": 0,
      "ok": true,
      "skipped": true
    }
  ]
}
```

`results` 中三种状态共享同一 schema（path / sku / fileName / contentType / fileSize / ok），外加状态特定字段：
- **uploaded** → `ok: true, response: {...}` 透传上游 `data` 字段
- **failed** → `ok: false, error: "..."` 错误描述
- **skipped**（state 命中）→ `ok: true, skipped: true` 跳过

可用 jq 过滤：`jq '.results[] | select(.ok)'` 列出所有成功的；`jq '.results[] | select(.skipped)'` 列出被 resume 跳过的。

### 退出码

| 码 | 含义 |
|---|---|
| `0` | 至少一张上传成功（即便其它失败） |
| `1` | 全部失败 / 启动错误（路径不存在 / 全部 magic bytes 无法识别） |
| `2` | 配置错误（`ConfigError`：上传 URL 未配置且非 mock） |

### Mock 模式

`--mock-upload` 启动内置 HTTP mock server（端口随机），不依赖真实接口；适合：
- CI 集成测试
- 离线调试 payload 拼装
- 学习脚本行为（mock 会把请求的 imageBase64、sku、contentType 等回显到 response）

```bash
node bin/transfer-images.js --mock-upload --dir=./test-imgs
# mock 模式不需要 --upload-url，也不需要 .env
```

### 环境变量（.env）

脚本启动时调 `loadEnvFile()` 读 `process.cwd()/.env`，读取以下变量：

| 变量 | 用途 |
|---|---|
| `CRAWLER_IMAGE_UPLOAD_URL` | 默认上传 endpoint（`--upload-url=` 覆盖） |
| `CRAWLER_IMAGE_UPLOAD_CONCURRENCY` | 默认并发数（`--upload-concurrency=` 覆盖） |
| `CRAWLER_IMAGE_UPLOAD_RETRIES` | 默认重试次数（`--upload-retries=` 覆盖） |
| `CRAWLER_NODE_CODE` | 默认 nodeCode（`--node-code=` 覆盖） |
| `CRAWLER_NODE_TOKEN` | 默认 nodeToken（`--node-token=` 覆盖） |

### 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| `[transfer-images] upload url required` 退出码 2 | `.env` 没设 `CRAWLER_IMAGE_UPLOAD_URL` 且命令行未给 `--upload-url=`；用 `--mock-upload` 或补 env |
| 全部失败 `Upload business failure: 七牛图片上传失败` | 上游业务码 500；先 `--mock-upload` 验证本地逻辑，再查上游 |
| 全部失败 `400` / `401` / `403` | payload 缺字段或 token 无效；检查 `nodeCode` / `nodeToken` / `sku` |
| 进程卡住不动 | 检查 `--upload-concurrency` 是否过大被上游限流；降到 2 试 |
| state 文件没生成 | `--dir` 没传 → 没有默认 state path；显式 `--state-file=` 才会写 |
| 同一文件重复上传 | `--force` 或 `--state-file` 指向了另一个文件；检查 `ls .transfer-state/` |
| OOM / 进程被 kill | 25k+ 大目录 + 上游慢；升级后内存峰值 < 1MB 应消失。若仍 OOM 检查是否启用了 `node --max-old-space-size=` |
| 第二次跑没跳过 | state 文件路径变了；用 `--state-file=` 显式指定相同路径 |

详见规格 `docs/superpowers/specs/2026-07-01-transfer-images-streaming-resume-design.md`。

## Use as a Node.js Module

```js
const { run } = require('./src/crawler');

run({
  inputExcel: '/path/to/SKU_List.xlsx',
  outputDir: '/path/to/output',
  order: 'reverse',
  headless: true,
}).catch(console.error);
```

Or run the service programmatically:

```js
const { runService } = require('./src/service');

runService({
  nodeCode: 'crawler-01',
  nodeToken: 'xxx',
}).catch(console.error);
```

## Configuration

Configuration precedence: **CLI flags > environment variables > defaults**.

| CLI Flag | Environment Variable | Default | Description |
|----------|---------------------|---------|-------------|
| `--input` | `CRAWLER_INPUT` | - | Input Excel file (required) |
| `--output` | `CRAWLER_OUTPUT` | `./output` | Output directory |
| `--image-dir` | `CRAWLER_IMAGE_DIR` | `{output}/images` | Image download directory |
| `--checkpoint` | `CRAWLER_CHECKPOINT` | `{output}/checkpoint.json` | Resume checkpoint file |
| `--result` | `CRAWLER_RESULT` | `{output}/vevor_result.xlsx` | Result Excel path |
| `--base-url` | `CRAWLER_BASE_URL` | `https://eur.vevor.com` | VEVOR site base URL |
| `--regions` | `CRAWLER_REGIONS` | 内置五区域 | 区域码→站点映射，如 `EU=https://eur.vevor.com,...,CN=`（空值=禁用） |
| `--default-region` | `CRAWLER_DEFAULT_REGION` | `EU` | task 缺 regionCode 时的默认区域 |
| `--clear-cookies-on-region-switch` | `CRAWLER_CLEAR_COOKIES_ON_REGION_SWITCH` | `false` | 通道热切换区域时清空 cookie |
| `--order` | `CRAWLER_ORDER` | `forward` | `forward` or `reverse` |
| `--headless` / `--no-headless` | `CRAWLER_HEADLESS` | `true` | Run browser headlessly |
| `--browser-path` | `CRAWLER_BROWSER_PATH` | auto-detect | Path to browser executable |
| `--min-delay` | `CRAWLER_MIN_DELAY` | `5` | Min delay between SKUs (seconds) |
| `--max-delay` | `CRAWLER_MAX_DELAY` | `10` | Max delay between SKUs (seconds) |
| `--flush-interval` | `CRAWLER_FLUSH_INTERVAL` | `10` | Rows to buffer before Excel flush |
| `--translate` / `--no-translate` | `CRAWLER_TRANSLATE` | `true` | Enable Chinese translation |
| `--translate-model` | `DASHSCOPE_MODEL` | `qwen3.6-flash-2026-04-16` | Translation model |
| `--feishu` / `--no-feishu` | `CRAWLER_FEISHU` | `false` | Send Feishu notification on finish |
| `--feishu-to` | `CRAWLER_FEISHU_TO` | `feishu` | Feishu target |
| `--max-images` | `CRAWLER_MAX_IMAGES` | `5` | Max images per SKU |
| `--cloudflare-max-wait` | `CRAWLER_CLOUDFLARE_MAX_WAIT` | `45` | Seconds to wait for Cloudflare challenge |
| `--test-count` | `CRAWLER_TEST_COUNT` | `10` | Only in `bin/run-test.js` |
| `--mode` | `CRAWLER_MODE` | `cli` | `cli` or `service` |
| `--node-code` | `CRAWLER_NODE_CODE` | hostname | Unique node identifier (service mode) |
| `--node-token` | `CRAWLER_NODE_TOKEN` | - | Upstream auth token (service mode) |
| `--task-url` | `CRAWLER_TASK_URL` | - | Task pull URL (service mode) |
| `--callback-url` | `CRAWLER_CALLBACK_URL` | - | Result callback URL (service mode) |
| `--channels` | `CRAWLER_CHANNELS` | `4` | Concurrent channels (service mode) |
| `--poll-interval` | `CRAWLER_POLL_INTERVAL` | `5000` | Poll interval in ms (service mode) |
| `--poll-limit` | `CRAWLER_POLL_LIMIT` | `10` | Tasks per poll (service mode) |
| `--push-retries` | `CRAWLER_PUSH_RETRIES` | `3` | Callback retry count (service mode) |
| `--kuaidaili-secret-id` | `KUAIDAILI_SECRET_ID` | - | Kuaidaili order SecretId |
| `--kuaidaili-secret-key` | `KUAIDAILI_SECRET_KEY` | - | Kuaidaili order SecretKey |
| `--kuaidaili-proxy-type` | `KUAIDAILI_PROXY_TYPE` | `kps` | Proxy product type |
| `--kuaidaili-proxy-num` | `KUAIDAILI_PROXY_NUM` | `1000` | Number of proxies to fetch per call |
| `--kuaidaili-token-cache-file` | `KUAIDAILI_TOKEN_CACHE_FILE` | `.kdl_token` | ~~Token cache file~~ (保留兼容，当前使用 `hmacsha1` 签名，不再读取 token 缓存) |
| `--proxy-machine-index` | `PROXY_MACHINE_INDEX` | `0` | This machine's index |
| `--proxy-machine-total` | `PROXY_MACHINE_TOTAL` | `1` | Total machines |
| `--proxy-refresh-interval-ms` | `PROXY_REFRESH_INTERVAL_MS` | `300000` | Proxy list refresh interval |
| `--proxy-assignments-file` | `PROXY_ASSIGNMENTS_FILE` | `./proxy-assignments.json` | Channel-IP assignment file |

Secrets:
- `DASHSCOPE_API_KEY` — required only if translation is enabled.

## Project Structure

### Crawling code

| File | Responsibility |
|------|----------------|
| `src/page-crawler.js` | Single-SKU page crawl: URL encoding, dataLayer/HTML extraction, SKU validation, image download |
| `src/channel.js` | Browser context lifecycle, headed fallback, health checks |
| `src/service.js` | Service-mode orchestrator: browser, proxy pools, channels, crash recovery |
| `src/worker.js` | Task dispatch to channels and result pushing |
| `src/poller.js` | Upstream task polling |
| `src/pusher.js` | Upstream callback pushing |
| `src/crawler.js` | Batch Excel-mode orchestrator |
| `bin/run.js` | Production entry point |
| `test-sku.js` | Single-SKU ad-hoc debug script |

### Translation code

Translation is implemented entirely in **`src/crawler.js`** and is used **only in batch Excel mode**. It is **not** invoked in service mode.

| Config | Default | How to disable |
|--------|---------|----------------|
| `enableTranslation` | `true` | `--no-translate`, `CRAWLER_TRANSLATE=false`, or `enableTranslation: false` |
| `dashscopeApiKey` | `DASHSCOPE_API_KEY` | — |
| `dashscopeModel` | `qwen3.6-flash-2026-04-16` | `--translate-model` / `DASHSCOPE_MODEL` |

If translation is enabled but `DASHSCOPE_API_KEY` is not set, translation is skipped with a warning.

## Testing

### Unit and integration tests

```bash
npm test
```

Covers Poller, Pusher, proxy configuration, stub server, and the service integration test.

### Load test

```bash
npm run test:load
```

Runs a single service node with 4 concurrent channels against a local stub server and verifies all tasks are processed without duplicates.

### Multi-machine deployment test (local)

Requires Docker.

```bash
npm run test:deployment:local
```

Starts 3 crawler nodes via Docker Compose, each with 1 channel, and verifies task distribution and deduplication.

### Multi-machine deployment test (real machines)

See [`test/deployment/README.md`](test/deployment/README.md) for instructions on running nodes across multiple real machines.

### Real API smoke test

A manual smoke test that runs a single service node against the **real** upstream task API and the real VEVOR site. This is not part of `npm test` because it requires live credentials and produces real network traffic.

Setup:

```bash
cd test/real
cp .env.example .env
# Edit .env with real CRAWLER_TASK_URL, CRAWLER_CALLBACK_URL, and CRAWLER_NODE_TOKEN
```

Run:

```bash
# Linux / macOS
bash test/real/smoke-test.sh

# Windows PowerShell (requires execution policy: RemoteSigned or Unrestricted)
.\test\real\smoke-test.ps1
```

The script starts one service node, waits for it to process at least `SMOKE_MIN_SUCCESS` tasks, then gracefully shuts it down and prints a PASS/FAIL summary. See [`test/real/README.md`](test/real/README.md) for full configuration options.

## 海外 VPS 部署（Linux + Docker + Cliproxy）

用于将爬虫部署到欧洲 VPS，通过 Cliproxy 住宅代理访问 `eur.vevor.com`。

### 准备

1. 准备一台欧洲 VPS（推荐 Hetzner CPX31，4C8G）
2. 安装 Docker 和 Docker Compose
3. 准备 Cliproxy 账号

### 部署步骤

```bash
cd deployment/linux
cp .env.example .env
# 编辑 .env，填入真实凭据和 CRAWLER_IMAGE_BASE
export CRAWLER_IMAGE_BASE=ghcr.io/your-org/hs-sku-crawler
./deploy.sh <git-commit-short-sha>
```

### 更新

```bash
./update.sh <new-git-commit-short-sha>
```

### 回滚

```bash
./rollback.sh
```

## Loki 监控

容器与 Windows PM2 节点通过 Loki + Promtail + Grafana 统一监控，详见 `docs/superpowers/specs/2026-07-06-loki-monitoring-design.md` 与 `docs/superpowers/plans/2026-07-06-loki-monitoring-plan.md`。

### VPS 部署

```bash
cd /opt/crawler
docker compose -f deployment/monitoring/docker-compose.yml up -d
```

### Windows 部署（每台）

```powershell
.\deployment\windows\install-promtail.ps1 -LokiUrl "http://100.x.x.V:3100/loki/api/v1/push" -NodeCode "crawler-09"
.\deployment\windows\install-windows-exporter.ps1
```

### Grafana 访问

仅内网（绑定 Tailscale IP）：`http://100.x.x.V:3000`，默认账号 `admin` / 密码取自 `GRAFANA_ADMIN_PASSWORD`。

## Output

- `{output}/vevor_result.xlsx` — main results
- `{output}/vevor_result.jsonl` — line-delimited JSON results
- `{output}/images/` — downloaded product images
- `{output}/checkpoint.json` — resume checkpoint

## Notes

- This copy does **not** include the original `node_modules/`, `.env`, debug scripts, or Python prototypes.
- Keep your API keys in environment variables or a `.env` file in the working directory; never commit them.
