# hs-sku-crawler Windows 部署说明

本文档说明如何在 Windows 服务器上首次部署、更新和回滚 hs-sku-crawler 服务。

## 环境要求

- Windows Server 2016 或更高版本 / Windows 10 或更高版本
- PowerShell 5.1 或更高版本
- 管理员权限（所有脚本均需以 Administrator 运行）
- 网络连接（用于下载 Node.js、Git 及项目依赖）

## 首次部署

1. 打开 PowerShell（以管理员身份运行）。
2. 进入 `deployment/windows` 目录。
3. 执行 `deploy.ps1`：

```powershell
.\deploy.ps1 -RepoUrl "https://github.com/your-org/hs-sku-crawler.git" -Branch "main" -InstallDir "C:\hs-sku-crawler"
```

参数说明：
- `-RepoUrl`（必填）：Git 仓库地址
- `-Branch`（可选）：目标分支，默认 `main`
- `-InstallDir`（可选）：安装目录，默认 `C:\hs-sku-crawler`

`deploy.ps1` 会自动完成以下操作：
- 检查并安装 Node.js LTS、Git（通过 winget）
- 全局安装 pm2
- 克隆仓库并安装依赖
- 调用 `setup-pm2-service.ps1` 将 PM2 注册为 Windows 服务

### 服务注册前置条件

- `setup-pm2-service.ps1` 必须在 `deploy.ps1` 成功运行之后执行
- 如果 PM2 中没有 crawler 进程，`setup-pm2-service.ps1` 会报错
- 服务注册后，系统重启会自动启动 crawler

## PM2 Windows 服务注册

如果首次部署时未成功注册服务，或需要重新注册：

```powershell
deployment\windows\setup-pm2-service.ps1
```

注意：执行前请确保 crawler 已在 PM2 中运行。

## 后续更新

在已部署的服务器上，执行 `update.ps1`：

```powershell
.\update.ps1 -Branch "main" -InstallDir "C:\hs-sku-crawler"
```

参数说明：
- `-Branch`（可选）：目标分支，默认 `main`
- `-InstallDir`（可选）：安装目录，默认 `C:\hs-sku-crawler`

`update.ps1` 会拉取最新代码、安装依赖并重启 PM2 进程。

## 回滚

若更新后出现问题，可回滚到上一个版本或指定版本：

```powershell
# 回滚到上一个版本
.\rollback.ps1 -InstallDir "C:\hs-sku-crawler"

# 回滚到指定 commit
.\rollback.ps1 -InstallDir "C:\hs-sku-crawler" -TargetCommit "abc1234"
```

参数说明：
- `-InstallDir`（可选）：安装目录，默认 `C:\hs-sku-crawler`
- `-TargetCommit`（可选）：目标 Git commit SHA，留空则回滚到上一个版本

## 日志位置

- 服务日志：`C:\hs-sku-crawler\logs\crawler-*.log`
- PM2 自身日志：默认位于运行 PM2 的用户目录下（如 SYSTEM 账户则为 `C:\Windows\System32\config\systemprofile\.pm2\logs\`）
- 应用日志：`<InstallDir>\logs\`
- 部署脚本日志：控制台输出，建议重定向保存

## 注意事项

1. **管理员权限**：所有 PowerShell 脚本均包含 `#Requires -RunAsAdministrator`，必须以管理员身份运行，否则脚本会报错退出。
2. **winget 可用性**：首次部署依赖 `winget` 安装 Node.js 和 Git。若服务器无法使用 winget，请手动安装后再次运行脚本。
3. **防火墙**：确保服务器出站规则允许访问 Git 仓库和 npm registry。
4. **服务状态**：PM2 注册为 Windows 服务后，可通过 `services.msc` 查看服务状态，服务名通常为 `PM2`。
5. **路径空格**：`InstallDir` 路径中若包含空格，PowerShell 会自动处理，无需额外加引号（传入参数时仍需加引号）。
