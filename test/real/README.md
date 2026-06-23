# Real API Smoke Test

This directory contains scripts for running a **real upstream API smoke test** against the actual task server and VEVOR website.

## Purpose

Unlike the unit/integration tests and load tests (which use stub servers), the real smoke test:

- Connects to the **real upstream task API** (`CRAWLER_TASK_URL`)
- Pushes results to the **real callback API** (`CRAWLER_CALLBACK_URL`)
- Crawls the **real VEVOR website** (`https://eur.vevor.com`)
- Validates that the end-to-end pipeline works in production-like conditions

## Setup

1. Copy the example environment file and fill in real credentials:

```bash
cp test/real/.env.example .env
# Edit .env with your real CRAWLER_NODE_TOKEN and other settings
```

2. Ensure dependencies are installed:

```bash
npm ci
npx playwright install chromium
```

## Run

### Linux / macOS

```bash
./test/real/smoke-test.sh
```

### Windows (PowerShell)

```powershell
.\test\real\smoke-test.ps1
```

If script execution is disabled, run `Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser` first.

## How It Works

1. Loads environment variables from `.env`
2. Validates required settings (`CRAWLER_NODE_CODE`, `CRAWLER_NODE_TOKEN`)
3. Starts the crawler in service mode (`node bin/run.js --mode service`)
4. Waits for service startup by monitoring logs for `Starting crawler service`
5. Polls the log file every 2 seconds, counting:
   - `start task` → tasks started
   - `done task .* status success` → successful crawls
   - `done task .* status error` → failed crawls
   - `done task .* status not_found` → SKUs not found on VEVOR
6. Exits when all started tasks are completed or timeout is reached
7. Sends SIGTERM to gracefully shut down the service
8. Prints a summary and validates:
   - `completed >= started` (warns if not)
   - `success >= SMOKE_MIN_SUCCESS` (default: 1)

## Configuration

| Environment Variable | Default | Description |
|----------------------|---------|-------------|
| `CRAWLER_NODE_CODE` | — | **Required.** Node identifier for upstream API |
| `CRAWLER_NODE_TOKEN` | — | **Required.** Auth token for upstream API |
| `CRAWLER_TASK_URL` | `http://117.72.52.0/renren-api/classify/open/crawler/tasks` | Task pull endpoint |
| `CRAWLER_CALLBACK_URL` | `http://117.72.52.0/renren-api/classify/open/crawler/callback` | Result push endpoint |
| `SMOKE_TIMEOUT_SECONDS` | `300` | Max seconds to wait for tasks |
| `SMOKE_MIN_SUCCESS` | `1` | Minimum successful crawls to pass |
| `SMOKE_LOG_FILE` | 项目根目录下的 `test/real/smoke-test.log` | Log file path |

## Expected Output

```
========================================
  Real API Smoke Test
========================================
  Project:  /Users/nz/Downloads/hs_sku/crawler
  Log file: /Users/nz/Downloads/hs_sku/crawler/test/real/smoke-test.log
  Timeout:  300s
  Min success: 1

Service started successfully.
Waiting for tasks to complete (timeout: 300s)...

  Elapsed:  45s | Started:  5 | Completed:  5 (success= 4 error= 0 not_found= 1)
All started tasks have completed.

========================================
  Smoke Test Summary
========================================
  Service started: yes
  Service shutdown: yes
  Tasks started:   5
  Tasks completed: 5
    - success:    4
    - error:      0
    - not_found:  1

RESULT: PASS
```

## Notes

- The test does **not** check upstream API responses or task states directly, because the real upstream may not provide query interfaces.
- Statistics are derived entirely from crawler logs, which is the single source of truth.
- The log file is preserved after the test for debugging.
- Use a dedicated `CRAWLER_NODE_CODE` (e.g., `smoke-test-node`) to avoid interfering with production nodes.

## Fault Tolerance Test

The fault tolerance test runs the crawler service against the **real upstream API** and injects client-side failures to verify self-recovery.

It covers four scenarios:

1. **Block task API** — temporarily black-holes the upstream task endpoint and verifies the service resumes polling when connectivity returns.
2. **Kill Chromium** — finds and `kill -9`s the browser child process and verifies the service detects the crash, restarts the browser/channels, and continues processing tasks.
3. **Block callback API** — starts a local stub that returns HTTP 500 for callbacks, verifies the service handles callback failures, then restores the real callback URL.
4. **Graceful service restart** — sends `SIGTERM` to the running service, verifies the old process exits cleanly, and starts a new instance.

### Setup

Use the same `.env` file created for the smoke test. Optionally tune fault-tolerance settings:

```bash
# test/real/.env
FAULT_TIMEOUT_SECONDS=600
FAULT_MIN_SUCCESS=5
FAULT_BLOCK_DURATION=30
FAULT_CALLBACK_STUB_PORT=19000
```

### Run

```bash
./test/real/fault-tolerance-test.sh
```

The script needs `sudo` to modify system routes during scenario 1.

### Expected Output

```
========================================
  Real API Fault Tolerance Test
========================================
  Timeout:     600s
  Min success: 5
  Log file:    /Users/nz/Downloads/hs_sku/crawler/test/real/fault-tolerance-test.log

[INFO] Starting crawler service (callback: http://117.72.52.0/renren-api/classify/open/crawler/callback)...
[INFO] Service started with PID 12345.

[INFO] [SCENE 1] Block task API for 30s
  PASS
[INFO] [SCENE 2] Kill Chromium process
  PASS
[INFO] [SCENE 3] Block callback API for 30s
  PASS
[INFO] [SCENE 4] Graceful service restart
  PASS

  Elapsed: 120s | Started: 10 | Completed: 10 (success= 6 error= 0 not_found= 4)
[INFO] All started tasks have completed.

========================================
  Fault Tolerance Test Summary
========================================
  Service currently alive: yes
  Tasks started:   10
  Tasks completed: 10
    - success:    6
    - error:      0
    - not_found:  4

RESULT: PASS
```

### Notes

- The script preserves the log file at `test/real/fault-tolerance-test.log` for debugging.
- It uses a fresh log file on each run.
- Duplicate successful task IDs in the log are treated as a failure because the service should not callback the same task as successful more than once.
- The callback-blocking stub (`test/real/fault-callback-stub.js`) can also be run standalone for ad-hoc testing.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `No tasks were started` | Upstream API has no tasks | Check upstream task queue or use a different node code |
| `Service startup timed out` | Dependencies missing or port conflict | Run `npm ci` and `npx playwright install chromium` |
| `Success count < minimum` | VEVOR site blocking or SKU not found | Check logs, increase `FAULT_TIMEOUT_SECONDS` or `SMOKE_TIMEOUT_SECONDS`, verify proxy settings |
| `sudo: route: command not found` | Running on Linux without route/ip tools | The script auto-detects `ip` on Linux; ensure `iproute2` is installed |
| `Could not find any Chromium child process` | Browser process already exited or uses unexpected name | Check the service log and use `ps` to identify the actual browser process name |
