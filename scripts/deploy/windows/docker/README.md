# Windows Docker 部署指南

本文档介绍如何在 Windows 系统上使用 Docker Desktop 部署 VEVOR SKU 爬虫节点。

## 用途

通过 Docker 容器在 Windows 主机上运行一个或多个爬虫服务节点，每个节点独立拉取任务、执行爬取并回调结果。适合本地测试、小规模生产部署或作为 Windows 服务器上的长期运行服务。

## 前提条件

- Windows 10（版本 1903 或更高）或 Windows 11
- Docker Desktop 已安装并运行（WSL 2 后端推荐）
- 项目代码已克隆到本地

## 快速开始

### 1. 配置环境变量

将示例文件复制为 `.env` 并填写实际值：

```powershell
cd scripts\deploy\windows\docker
copy .env.example .env
notepad .env
```

至少填写以下三项必填配置：

- `CRAWLER_TASK_URL` —— 上游任务接口地址
- `CRAWLER_CALLBACK_URL` —— 结果回调接口地址
- `CRAWLER_NODE_TOKEN` —— 节点认证令牌

### 2. 检查环境

```powershell
.\deploy.ps1 check
```

该命令会验证：

- Docker 是否已安装
- Docker 守护进程是否可达
- 必要环境变量是否已设置

## 可用命令

| 命令 | 说明 |
|------|------|
| `check` | 检查 Docker 环境与配置 |
| `start` | 启动爬虫容器节点 |
| `status` | 查看容器运行状态 |
| `logs` | 收集所有容器日志到本地 |
| `stop` | 停止并移除所有爬虫容器 |
| `help` | 显示帮助信息 |

## 使用示例

### 启动多个节点

修改 `.env` 中的 `CRAWLER_NODE_COUNT=2`，然后执行：

```powershell
.\deploy.ps1 start
```

脚本会启动两个容器：

- `win-crawler-1`
- `win-crawler-2`

每个容器内部运行 `npm ci && npm run service`，首次启动可能需要几分钟安装依赖。

### 查看状态

```powershell
.\deploy.ps1 status
```

输出示例：

```
win-crawler-1: Up 5 minutes (Green)
win-crawler-2: Up 5 minutes (Green)
```

### 收集日志

```powershell
.\deploy.ps1 logs
```

日志会被保存到 `output/windows-docker-logs/<时间戳>/` 目录下，每个容器对应一个 `.log` 文件。

### 停止所有节点

```powershell
.\deploy.ps1 stop
```

该命令会停止并删除所有名称匹配 `win-crawler-*` 的容器。

## 注意事项

- **首次启动较慢**：每个容器在首次运行时会执行 `npm ci` 安装依赖，视网络情况可能需要 2–5 分钟。
- **水平扩展**：通过增加 `CRAWLER_NODE_COUNT` 来启动更多节点，每个节点使用 `CRAWLER_CHANNELS=1`（单通道），避免单个容器内并发过高。
- **日志保留**：`logs` 命令收集的日志保存在 `output/windows-docker-logs/` 目录，按时间戳分文件夹存储，不会自动清理。
- **节点代码**：默认节点代码为 `${CRAWLER_NODE_PREFIX}-${序号}`，可通过环境变量 `CRAWLER_NODE_CODE` 全局覆盖，或通过 `CRAWLER_NODE_CODE_1`、`CRAWLER_NODE_CODE_2` 等单独指定。
- **代理与浏览器路径**：如需代理，取消 `CRAWLER_PROXY` 的注释并填写地址；`CRAWLER_BROWSER_PATH` 在容器内通常不需要设置，因为 Playwright 镜像已内置 Chromium。
