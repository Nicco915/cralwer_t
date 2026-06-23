# 真实环境容错测试设计

## 背景

当前已完成：

- 单元/集成测试（Poller、Pusher、proxy、stub server、service integration）。
- 单机负载测试（4 通道，stub server）。
- 多机本地部署测试（Docker Compose，stub server）。
- 真实 API 烟雾测试（单机，macOS Bash，300s，28/30 任务完成）。

下一步需要验证：服务节点在真实 API / 真实 VEVOR 站点环境下，遇到客户端侧故障后能否自愈、不丢任务、不重复回调。

## 目标

1. 实现 Chromium 浏览器崩溃自动恢复。
2. 编写场景化容错测试脚本，覆盖断网、浏览器崩溃、回调阻断、服务优雅重启四类故障。
3. 验证每个场景后服务能继续处理任务，且回调无重复。

## 方案

采用**真实环境 + 场景化顺序脚本**方案：

- 测试直接对接真实上游 API 与真实 VEVOR 站点。
- 故障从客户端注入（网络路由、进程信号），不修改上游行为。
- 脚本按顺序执行预设场景，每个场景前后检查日志与统计，最终输出 PASS/FAIL。

## 新增/修改文件

| 文件 | 类型 | 说明 |
|------|------|------|
| `src/service.js` | 修改 | 增加浏览器健康检查与自动重启逻辑。 |
| `src/channel.js` | 修改 | 暴露 `isHealthy()` 或 `reinit()` 接口，支持服务层统一重建。 |
| `test/real/fault-tolerance-test.sh` | 新增 | macOS/Linux 容错测试脚本。 |
| `test/real/fault-callback-stub.js` | 新增 | 场景 3 使用的本地 500 回调 stub。 |
| `test/real/README.md` | 修改 | 增加容错测试运行说明与场景解释。 |
| `test/real/.env.example` | 可选修改 | 增加 `FAULT_*` 相关超时配置。 |

## 浏览器崩溃恢复设计

### 触发条件

服务层启动周期性健康检查（默认每 30s）：

1. 调用 `browser.isConnected()` 判断浏览器进程是否存活。
2. 调用每个 Channel 的 `isHealthy()`（尝试在页面执行 `document.title` 或检查 context/page 是否关闭）。
3. 若任一检查失败，标记浏览器不可用。

### 恢复流程

1. `CrawlerService.restartBrowser()`：
   - 关闭所有 Channel。
   - 关闭旧 browser（若仍存活）。
   - 重新 `initBrowser()`。
   - 重新 `initChannels()`。
   - 日志输出 `[SERVICE] Browser restarted`。
2. Worker 保持运行，Channel 重建后自动接管后续任务。
3. 正在执行中的任务会失败，由 Pusher 回调失败状态；Worker 继续消费队列中剩余任务。

### 边界

- 不实现任务级重试（与现有需求一致：失败 SKU 不重试，直接上报）。
- 浏览器重启期间，Poller 继续拉取任务并加入 Worker 队列；任务不会丢失，但会等待浏览器恢复后处理。

## 测试场景

| # | 场景 | 注入方式 | 期望行为 |
|---|------|---------|---------|
| 1 | 上游任务 API 断网 30s | macOS: `sudo route add -net 117.72.52.0 -interface lo0`，超时后 `sudo route delete` | Poller 记录失败；恢复后继续拉取任务。 |
| 2 | Chromium 子进程被杀 | `kill -9 <chromium-pid>` | 服务检测到浏览器失效，自动重启浏览器/通道并继续处理任务。 |
| 3 | 回调 API 阻断 30s | 启动本地 stub 回调服务，对 `/callback` 返回 500；临时修改 `.env` 中 `CRAWLER_CALLBACK_URL` 指向该 stub；30s 后恢复为真实回调地址并重启服务 | Pusher 按配置重试；恢复后补发回调；日志无重复成功回调。 |
| 4 | 服务优雅重启 | `kill -TERM` 旧服务，启动新实例 | 旧进程退出，新进程接管，无孤儿进程；Poller 重新拉取任务。 |

## 验证断言

每个场景执行后：

1. 服务进程仍存活（PID 未变，除非场景 4）。
2. 日志中无未捕获异常（`UnhandledPromiseRejection` / `Error: Target closed` 等）。
3. 最终统计：`success + not_found >= FAULT_MIN_SUCCESS`（默认 5）。
4. 回调无重复：通过日志中 `done task .* status success` 的 `crawlerTaskId` 去重后数量与成功回调数量一致。
5. 场景 4 后旧 PID 已退出、新 PID 已启动。

## 前置条件

- macOS 或 Linux（Windows 脚本后续补充）。
- 运行测试需要 `sudo` 权限以修改路由表。
- 已配置真实 API 的 `.env`（`CRAWLER_NODE_CODE=crawler-01`、`CRAWLER_NODE_TOKEN=` 等）。
- 上游 API 有可分配任务。

## 运行方式

```bash
cd /Users/nz/Downloads/hs_sku/crawler
bash test/real/fault-tolerance-test.sh
```

输出示例：

```
========================================
  Real API Fault Tolerance Test
========================================
  Timeout: 600s
  Min success: 5

[SCENE 1] Block task API for 30s ... PASS
[SCENE 2] Kill Chromium process ... PASS
[SCENE 3] Block callback API for 30s ... PASS
[SCENE 4] Graceful service restart ... PASS

RESULT: PASS
  success=12, not_found=5, error=0
```

## 范围边界

- 不测试上游服务器宕机（不可控）。
- 不测试任务去重/幂等（已在开发日志中标记为暂不处理）。
- 不引入外部混沌工程工具，仅使用系统自带命令（`route`、`kill`）。
- 长稳测试本次跳过，记录在开发日志中后续补充。

## 后续可扩展

- Windows PowerShell 版本：`test/real/fault-tolerance-test.ps1`。
- 长稳运行测试（8h+）与基础监控指标采集。
- 回调去重/幂等实现后，增加重复任务注入测试。
