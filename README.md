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
| `--kuaidaili-token-cache-file` | `KUAIDAILI_TOKEN_CACHE_FILE` | `.kdl_token` | Token cache file |
| `--proxy-machine-index` | `PROXY_MACHINE_INDEX` | `0` | This machine's index |
| `--proxy-machine-total` | `PROXY_MACHINE_TOTAL` | `1` | Total machines |
| `--proxy-refresh-interval-ms` | `PROXY_REFRESH_INTERVAL_MS` | `300000` | Proxy list refresh interval |
| `--proxy-assignments-file` | `PROXY_ASSIGNMENTS_FILE` | `./proxy-assignments.json` | Channel-IP assignment file |

Secrets:
- `DASHSCOPE_API_KEY` — required only if translation is enabled.

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

## Output

- `{output}/vevor_result.xlsx` — main results
- `{output}/vevor_result.jsonl` — line-delimited JSON results
- `{output}/images/` — downloaded product images
- `{output}/checkpoint.json` — resume checkpoint

## Notes

- This copy does **not** include the original `node_modules/`, `.env`, debug scripts, or Python prototypes.
- Keep your API keys in environment variables or a `.env` file in the working directory; never commit them.
