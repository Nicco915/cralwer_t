# Windows 原生部署说明

## 用途

本目录包含 Windows 原生（无 Docker）PowerShell 部署脚本，用于直接在 Windows 上启动一个或多个 VEVOR SKU 爬虫节点进程。

与 Docker 部署方案的区别：

- **无需 Docker Desktop**：直接以 `node` 进程运行，资源占用更低。
- **依赖本机 Node.js 环境**：需要提前安装 Node.js 和项目依赖。
- **日志写入本地文件**：每个节点的 stdout 重定向到 `output/windows-native-logs/` 下的 `${nodeCode}.log`，stderr 重定向到 `${nodeCode}.err.log`。两者分离，避免日志交错。

## 环境要求

- Windows 10/11（64 位）
- Node.js >= 20（建议 LTS 版本）
- npm（随 Node.js 一起安装）
- 项目已克隆到本地，并执行过 `npm ci`
- Playwright Chromium 已安装（`npx playwright install chromium`），或系统已安装 Edge 并配置 `CRAWLER_BROWSER_PATH`

## 初始化配置

1. 复制环境变量模板：

   ```powershell
   cd scripts\deploy\windows\native
   Copy-Item .env.example .env
   ```

2. 用文本编辑器打开 `.env`，填写必填项：

   - `CRAWLER_TASK_URL` — 上游任务 API 地址
   - `CRAWLER_CALLBACK_URL` — 结果回调 API 地址
   - `CRAWLER_NODE_TOKEN` — 节点认证令牌

   按需调整可选项，如代理 `CRAWLER_PROXY` 或浏览器路径 `CRAWLER_BROWSER_PATH`。

## 可用命令

| 命令 | 说明 |
|------|------|
| `.\deploy.ps1 check` | 检查 Node.js、npm、依赖、Playwright 浏览器及环境变量 |
| `.\deploy.ps1 start` | 启动爬虫后台进程（根据 `CRAWLER_NODE_COUNT` 决定数量） |
| `.\deploy.ps1 status` | 查看匹配前缀的爬虫进程运行状态 |
| `.\deploy.ps1 logs` | 显示日志文件路径，并输出每个日志文件的最后 50 行 |
| `.\deploy.ps1 stop` | 优雅停止并强制清理所有匹配前缀的爬虫进程 |
| `.\deploy.ps1 help` | 显示帮助信息 |

## 使用示例

### 启动 2 个节点

```powershell
# 在 .env 中设置
CRAWLER_NODE_COUNT=2
CRAWLER_NODE_PREFIX=win-native-crawler

# 然后执行
.\deploy.ps1 start
```

输出示例：

```
=== 启动爬虫节点 ===

  启动节点 1/2: win-native-crawler-1 ... 成功 (PID=12345)
  启动节点 2/2: win-native-crawler-2 ... 成功 (PID=12346)

启动完成: 共 2 个节点
  PID=12345, NodeCode=win-native-crawler-1, Log=C:\...\output\windows-native-logs\win-native-crawler-1.log
  PID=12346, NodeCode=win-native-crawler-2, Log=C:\...\output\windows-native-logs\win-native-crawler-2.log
```

### 查看状态

```powershell
.\deploy.ps1 status
```

### 查看日志

```powershell
.\deploy.ps1 logs
```

### 停止所有节点

```powershell
.\deploy.ps1 stop
```

## 注意事项

- **执行策略**：如果 PowerShell 提示无法运行脚本，请先执行：

  ```powershell
  Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
  ```

- **每个节点是独立进程**：`CRAWLER_CHANNELS=1`，每个节点只运行单通道，便于横向扩展。
- **日志目录**：`output/windows-native-logs/` 会在首次 `start` 时自动创建。
- **节点代码覆盖**：可通过环境变量 `CRAWLER_NODE_CODE` 全局覆盖，或通过 `CRAWLER_NODE_CODE_1`、`CRAWLER_NODE_CODE_2` 等单独为每个节点设置。
- **进程识别**：`stop` 和 `status` 通过查找命令行包含 `bin/run.js --mode service` 的 `node.exe` 进程，并匹配 `CRAWLER_NODE_CODE` 前缀来定位目标进程。
