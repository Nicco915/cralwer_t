# Windows 异地快速部署方案

## 背景与目标

将当前 Node.js 爬虫服务（hs_sku/crawler）快速部署到一台干净的远程 Windows Server 上，并实现可重复的自动化部署流程。目标环境具备管理员权限、可远程访问、允许安装 Node.js 等依赖。

## 关键决策

- **部署形式**：原生 Node.js 服务，不在目标机上使用 Docker。
- **触发方式**：在目标 Windows 服务器上执行 PowerShell 脚本，从 Git 仓库拉取代码。
- **进程守护**：PM2 负责日常运行、自动重启和日志管理；同时将 PM2 注册为 Windows 服务，实现开机自启。
- **配置管理**：敏感配置（`.env`）由运维人员预先放置在目标机安装目录，部署脚本只检查存在性，不生成、不覆盖。

## 总体流程

1. **准备阶段**：在目标 Windows 服务器上预先放置 `.env` 配置文件到指定安装目录（例如 `C:\hs-sku-crawler`）。
2. **首次部署**：管理员运行 `deploy.ps1`，脚本自动完成：
   - 检测并安装 Node.js LTS、Git
   - 全局安装 PM2
   - 从 Git 仓库 clone 代码到安装目录
   - 安装 npm 依赖
   - 使用 PM2 启动 crawler 服务
   - 将 PM2 注册为 Windows 服务，实现开机自启
3. **后续更新**：运行 `update.ps1`，拉取最新代码、安装依赖、执行 `pm2 reload` 热重启。
4. **回滚**：运行 `rollback.ps1`，切回 `.deployment-state.json` 中记录的上一个成功版本并重启服务。

## 新增文件结构

```
deployment/
└── windows/
    ├── deploy.ps1              # 首次部署
    ├── update.ps1              # 后续更新
    ├── rollback.ps1            # 版本回滚
    ├── setup-pm2-service.ps1   # 注册 PM2 为 Windows 服务
    ├── ecosystem.config.js     # PM2 进程配置
    └── README.md               # 部署操作说明
```

## 脚本设计

### deploy.ps1

- **参数化**：支持传入 Git 仓库地址、分支、安装目录、Node.js 版本等参数。
- **管理员检查**：脚本开头检查是否以管理员身份运行，否则退出并提示。
- **依赖安装**：
  - 优先使用 `winget` 安装 Node.js LTS 和 Git。
  - 若 `winget` 不可用，回退到 Chocolatey 或从官网下载 MSI 安装。
- **幂等性**：重复运行不会重复 clone；若安装目录已存在且为合法 Git 仓库，则进入更新逻辑。
- **配置检查**：检测 `.env` 是否存在，不存在则告警退出。
- **服务注册**：调用 `setup-pm2-service.ps1` 将 PM2 注册为 Windows 服务。
- **状态记录**：首次部署成功后，将当前 commit 写入 `.deployment-state.json`，作为后续回滚的基准版本。

### update.ps1

- 进入安装目录，备份当前 commit 到 `.deployment-state.json` 的 `previous` 字段。
- 执行 `git fetch` 和 `git reset --hard origin/<branch>` 更新代码。
- 安装/更新 npm 依赖。
- 执行 `pm2 reload` 或 `pm2 restart`。
- 等待 5 秒后检查服务状态；若健康检查失败，自动切回 `previous` commit 并重启。
- 更新成功后，将新 commit 写入 `.deployment-state.json` 的 `current` 字段。

### rollback.ps1

- 读取 `.deployment-state.json` 中记录的上一版本 commit。
- 切换到该 commit，重新安装依赖并重启服务。
- 支持手动通过参数指定任意目标 commit 或 tag。
- 更新失败时自动记录当前失败版本，便于排查。

### setup-pm2-service.ps1

- 使用 `pm2-installer` 将 PM2 注册为 Windows 服务。
- 保存 PM2 进程列表，确保重启后自动恢复。
- 可单独执行，便于服务注册失败时排查。

### ecosystem.config.js

- 定义应用名称、入口脚本 `node bin/run.js --mode=service`、环境变量、日志路径。
- 日志目录初始化为 `C:\hs-sku-crawler\logs`。
- 启用 PM2 内置日志轮转。

## Windows 服务注册

- 使用 [pm2-installer](https://github.com/jessety/pm2-installer) 将 PM2 注册为 Windows 服务。
- 系统重启后，PM2 服务自动启动，并恢复已保存的进程列表。
- PM2 以系统服务方式运行，确保无需用户登录即可保持 crawler 在线。

## 健康检查与回滚

- 部署或更新完成后，脚本等待 5 秒，调用 `pm2 list` 检查 crawler 服务状态是否为 `online`。
- 健康检查失败时，自动执行回滚逻辑，切回 `.deployment-state.json` 中记录的上一版本 commit 并重启服务。
- 由于 crawler 服务未暴露 HTTP 健康检查接口，暂以 PM2 进程状态作为健康判定依据。

## 配置与安全管理

- `.env` 文件由运维人员手动放置到目标机安装目录，脚本只检查存在性。
- Git 仓库中不提交敏感配置。
- 脚本执行日志记录到 `C:\hs-sku-crawler\logs\deploy.log`，便于审计和排障。

## 权限要求

- 所有部署脚本需要以管理员身份运行 PowerShell。
- 脚本开头显式检查管理员权限，不满足时给出清晰提示并退出。

## 成功标准

- 在干净的 Windows Server 上，运行 `deploy.ps1` 后，crawler 服务自动启动并稳定运行。
- 系统重启后，crawler 服务自动恢复在线。
- 运行 `update.ps1` 可在不中断服务的情况下完成代码更新（`pm2 reload`）。
- 运行 `rollback.ps1` 可在更新失败时快速恢复到上一版本。
