# Windows 部署后验证与生产运维指南 — 设计规格

## 背景

`hs-sku-crawler` 已完成 Windows 服务器部署脚本（`deployment/windows/deploy.ps1` 等），但缺少一份面向运维与测试人员的部署后操作文档。本文档规格定义将要编写的 `deployment/windows/POST_DEPLOYMENT.md` 的内容范围、结构与验收标准。

## 目标读者

- 运维人员：部署完成后按清单验证服务健康，日常监控、升级、回滚。
- 开发/测试人员：在 Windows 生产机上执行验证测试、排查问题。

## 文件位置

`deployment/windows/POST_DEPLOYMENT.md`

## 内容结构

1. **部署后验证清单**
   - 检查 PM2 进程状态：`pm2 list`、`pm2 describe crawler`
   - 检查 Windows 服务：`services.msc` 中 PM2 服务状态
   - 检查日志文件生成：`C:\hs-sku-crawler\logs\crawler-*.log`
   - 核对 `.env` 关键变量是否生效
   - 可选：检查 upstream API 连通性

2. **生产环境日常操作**
   - 查看状态：`pm2 list`、`pm2 monit`
   - 查看日志：`pm2 logs crawler`、`Get-Content`
   - 重启/重载/停止/启动服务
   - 系统重启后的自动恢复说明
   - 更新代码：`update.ps1`
   - 回滚代码：`rollback.ps1`

3. **测试方法**
   - 单元/集成测试：`npm test`
   - 部署脚本单元测试：`npm run test:deployment:unit`
   - 真实 API 冒烟测试：`test/real/smoke-test.ps1`
   - 负载测试与多机部署测试（可选）

4. **常见问题排查**
   - 服务未启动 / PM2 errored
   - 浏览器启动失败
   - 拉不到任务 / callback 失败
   - 升级/回滚健康检查失败

5. **附录**
   - 环境变量速查表
   - PM2 命令速查表
   - 关键文件路径清单

## 验收标准

- 文档使用中文，术语保留英文（如 PM2、SIGTERM、SKU）。
- 所有命令均可在 Windows PowerShell（管理员）中直接复制执行。
- 必须包含真实 API 冒烟测试的完整 `.env` 准备、执行、通过标准。
- 必须说明升级/回滚失败时的自动回滚行为。
- 不引入新的代码实现，仅基于现有脚本与配置文件整理。

## 依赖

- 现有文件：`deployment/windows/README.md`、`deploy.ps1`、`update.ps1`、`rollback.ps1`、`setup-pm2-service.ps1`、`ecosystem.config.js`
- 现有文件：`test/real/smoke-test.ps1`、`test/real/.env.example`、`README.md`
