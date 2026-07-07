# hs-sku-crawler Windows 部署说明

本文档说明如何在 Windows 服务器上首次部署、更新和回滚 hs-sku-crawler 服务。

## 环境要求

- Windows Server 2016 或更高版本 / Windows 10 或更高版本
- PowerShell 5.1 或更高版本
- 管理员权限（所有脚本均需以 Administrator 运行）
- 网络连接（用于下载 Node.js、Git 及项目依赖）

## 首次部署

推荐先在目标服务器上 clone 代码，再运行 `deploy.ps1`：

```powershell
# 1. 以管理员身份打开 PowerShell
# 2. 安装 Git（如果还没装）
# 3. 把代码拉下来
git clone https://github.com/Nicco915/cralwer_t.git C:\hs-sku-crawler
cd C:\hs-sku-crawler

# 4. 把 .env 配置文件放进 C:\hs-sku-crawler\
# 5. 运行部署脚本
C:\hs-sku-crawler\deployment\windows\deploy.ps1 `
    -RepoUrl "https://github.com/Nicco915/cralwer_t.git" `
    -Branch "main" `
    -InstallDir "C:\hs-sku-crawler"
```

脚本会检测到 `InstallDir` 已经是 git 仓库，自动执行 `git fetch` + `git reset --hard`，然后安装 npm 依赖、启动 crawler、并把 PM2 注册成 Windows 服务。

参数说明：
- `-RepoUrl`（必填）：Git 仓库地址
- `-Branch`（可选）：目标分支，默认 `main`
- `-InstallDir`（可选）：安装目录，默认 `C:\hs-sku-crawler`

`deploy.ps1` 会自动完成以下操作：
- 检查并安装 Node.js LTS、Git（通过 winget）
- 全局安装 pm2
- 更新/克隆仓库并安装依赖
- 调用 `setup-pm2-service.ps1` 将 PM2 注册为 Windows 服务

### 异地/内网部署说明

在无法连接 Windows Update 的 Windows 11 24H2+ 机器上，`deploy.ps1` 会自动尝试以下兜底：

1. 检测并安装 WMIC 可选组件
2. 如果 WMIC 安装失败，且 `nssm.exe` 在 PATH 中，则使用 NSSM 注册 PM2 服务

如果两个条件都不满足，脚本会输出明确的下载/手动命令，不会静默失败。

### 服务注册前置条件

- `setup-pm2-service.ps1` 必须在 `deploy.ps1` 成功运行之后执行
- 如果 PM2 中没有 crawler 进程，`setup-pm2-service.ps1` 会报错
- 服务注册后，系统重启会自动启动 crawler

`setup-pm2-service.ps1` 现在会自动完成以下前置检查与修复（需要管理员权限）：

- 检测 npm 全局前缀是否位于用户目录；如果是，自动运行 `npm run configure` 迁移到 `C:\ProgramData\npm`
- 为 `NT AUTHORITY\LOCAL SERVICE` 授予项目目录 `ReadAndExecute, Modify` 权限
- 确保 `C:\ProgramData\pm2\home` 存在且对 `LOCAL SERVICE` 可写
- 安装服务后等待 PM2 服务进入 `Running` 状态，失败时输出诊断信息

## PM2 Windows 服务注册

如果首次部署时未成功注册服务，或需要重新注册：

```powershell
deployment\windows\setup-pm2-service.ps1
```

注意：执行前请确保 crawler 已在 PM2 中运行。

## 监控组件安装

crawler 业务日志与节点资源指标通过 Loki + Promtail + Grafana 统一监控。首次部署业务后，还需要在每台 Windows 服务器上安装监控组件。

### 前置条件

- 已在 VPS 上部署监控栈，详见项目根目录 `loki监控.md`
- VPS 的 Tailscale IP 当前为：`100.111.251.108`
- Windows 服务器已安装 Tailscale 并登录**同一个 Tailscale 账号**：https://tailscale.com/download/windows

### 安装 Promtail（推送日志到 Loki）

以管理员 PowerShell 执行：

```powershell
cd C:\hs-sku-crawler
.\deployment\windows\install-promtail.ps1 `
  -LokiUrl "http://100.111.251.108:3100/loki/api/v1/push" `
  -NodeCode "crawler-09" `
  -LogDir "C:\hs-sku-crawler\logs"
```

参数说明：
- `-LokiUrl`：VPS 上 Loki 的推送地址
- `-NodeCode`：节点唯一标识，建议 Windows PM2 节点用 `crawler-09` .. `crawler-14`
- `-LogDir`：crawler 日志目录，默认 `C:\promtail\logs`，建议改成业务实际目录

脚本会自动完成：
- 检测/安装 NSSM
- 下载 Promtail 2.9.8
- 生成 `C:\promtail\promtail.yml`
- 注册为 Windows 服务 `Promtail`
- 防火墙放行 9080 给 Tailscale 网段

验证服务：

```powershell
nssm status Promtail
Get-Content C:\promtail\promtail.log -Tail 20
```

### 安装 windows_exporter（节点资源监控）

以管理员 PowerShell 执行：

```powershell
cd C:\hs-sku-crawler
.\deployment\windows\install-windows-exporter.ps1
```

脚本会自动：
- 下载 windows_exporter MSI
- 安装并启动服务
- 防火墙放行 9182 给 Tailscale 网段

验证：

```powershell
Get-Service windows_exporter
```

### 监控安装后验证

1. 在 Grafana 的 "Crawler · 节点心跳" 面板看到该 `nodeCode`
2. 在 "Crawler · 节点资源" 面板看到 Windows 节点的 CPU/内存/磁盘
3. 运行以下 LogQL 看该节点是否有心跳日志：

```logql
{app="crawler"} | json | component="heartbeat" | nodeCode="crawler-09"
```

---

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

## 常见问题

### 1. PowerShell 执行策略报错

如果运行脚本时提示执行策略限制，在管理员 PowerShell 中执行：

```powershell
Set-ExecutionPolicy RemoteSigned -Scope CurrentUser
```

输入 `Y` 确认。如果仍然报错，可临时绕过：

```powershell
Set-ExecutionPolicy -ExecutionPolicy Bypass -Scope Process -Force
```

注意：
- `-Scope CurrentUser` 只对当前用户生效，安全性较好
- `-Scope Process` 只对当前 PowerShell 窗口生效，关闭后失效
- 修改执行策略需要管理员权限

### 2. npm 全局前缀警告

`pm2-installer` 可能会提示当前 npm 全局前缀是用户目录（如 `C:\Users\<用户名>\AppData\Roaming\npm`），而 Windows 服务通常以 `LocalService` 等系统账户运行，无法访问用户目录。

这会导致 PM2 服务开机自启失败。`setup-pm2-service.ps1` 现在会自动检测并修复该问题：如果前缀在用户目录，会自动运行 `npm run configure` 将 npm 全局位置改为 `C:\ProgramData\npm`，系统账户也能访问。

如果自动修复失败，可手动执行：

```powershell
cd "$env:APPDATA\npm\node_modules\pm2-installer"
npm run configure
```

配置完成后，再重新运行 `deploy.ps1`。

### 3. PM2 服务注册后当前会话找不到进程

`pm2-installer` 安装服务后会将 PM2_HOME 设置为 `C:\ProgramData\pm2\home`。当前 PowerShell 会话可能需要重新打开，或手动设置：

```powershell
$Env:PM2_HOME="C:\ProgramData\pm2\home"
```

## 注意事项

1. **管理员权限**：所有 PowerShell 脚本均包含 `#Requires -RunAsAdministrator`，必须以管理员身份运行，否则脚本会报错退出。
2. **winget 可用性**：首次部署依赖 `winget` 安装 Node.js 和 Git。若服务器无法使用 winget，请手动安装后再次运行脚本。
3. **防火墙**：确保服务器出站规则允许访问 Git 仓库和 npm registry。
4. **服务状态**：PM2 注册为 Windows 服务后，可通过 `services.msc` 查看服务状态，服务名通常为 `PM2`。
5. **路径空格**：`InstallDir` 路径中若包含空格，PowerShell 会自动处理，无需额外加引号（传入参数时仍需加引号）。
