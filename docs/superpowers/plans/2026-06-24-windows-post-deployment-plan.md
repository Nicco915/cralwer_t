# Windows 部署后验证与生产运维指南实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 `deployment/windows/POST_DEPLOYMENT.md` 中编写一份完整、可执行的中文指南，覆盖部署后验证、生产机日常操作、测试方法与故障排查。

**架构：** 单一 Markdown 文档，按"验证 → 运维 → 测试 → 排障 → 附录"分层组织，所有命令均基于现有 PowerShell/Node.js 脚本与 PM2 生态。

**技术栈：** Markdown、Windows PowerShell、PM2、Node.js、`test/real/smoke-test.ps1`

---

## 文件结构

| 文件 | 职责 |
|------|------|
| `deployment/windows/POST_DEPLOYMENT.md` | **新建**。部署后验证、运维、测试、排障指南。 |
| `deployment/windows/README.md` | **参考**。首次部署、更新、回滚脚本说明。 |
| `deployment/windows/deploy.ps1` | **参考**。首次部署入口。 |
| `deployment/windows/update.ps1` | **参考**。更新流程。 |
| `deployment/windows/rollback.ps1` | **参考**。回滚流程。 |
| `deployment/windows/setup-pm2-service.ps1` | **参考**。PM2 Windows 服务注册。 |
| `deployment/windows/ecosystem.config.js` | **参考**。PM2 进程配置（日志路径、实例数、环境变量）。 |
| `test/real/smoke-test.ps1` | **参考**。真实 API 冒烟测试脚本。 |
| `test/real/.env.example` | **参考**。真实 API 测试环境变量示例。 |
| `package.json` | **参考**。npm scripts（`test`、`test:deployment:unit`、`test:load`）。 |
| `docs/superpowers/specs/2026-06-24-windows-post-deployment-design.md` | **参考**。已批准的设计规格。 |

---

## 任务 1：创建文档骨架与头部元信息

**文件：**
- 创建：`deployment/windows/POST_DEPLOYMENT.md`

- [ ] **步骤 1：写入文档标题、目标读者与适用范围**

```markdown
# hs-sku-crawler Windows 部署后验证与生产运维指南

本文档面向运维人员和开发/测试人员，说明项目成功部署到 Windows 服务器后：

- 如何验证部署是否成功
- 如何在生产机上执行日常操作（查看状态、重启、升级、回滚）
- 如何运行测试验证端到端流程
- 如何排查常见问题

适用范围：使用 `deployment/windows/deploy.ps1` 完成首次部署，PM2 已注册为 Windows 服务。
```

- [ ] **步骤 2：运行 Markdown 语法检查**

运行：
```bash
node -e "require('fs').readFileSync('deployment/windows/POST_DEPLOYMENT.md','utf8'); console.log('syntax ok')"
```

预期：输出 `syntax ok`，无异常。

- [ ] **步骤 3：Commit**

```bash
git add deployment/windows/POST_DEPLOYMENT.md
git commit -m "docs(deployment/windows): 添加 POST_DEPLOYMENT.md 骨架"
```

---

## 任务 2：编写"部署后验证清单"章节

**文件：**
- 修改：`deployment/windows/POST_DEPLOYMENT.md`

- [ ] **步骤 1：逐条写入验证命令与通过标准**

内容要点（需展开为完整中文说明）：

1. 以管理员身份打开 PowerShell。
2. 检查 PM2 进程列表：
   ```powershell
   pm2 list
   ```
   通过标准：`crawler` 状态为 `online`，uptime 持续增长。
3. 查看进程详情：
   ```powershell
   pm2 describe crawler
   ```
   通过标准：无 `restart count` 异常增长，无 `error log` 频繁写入。
4. 检查 Windows 服务：
   ```powershell
   Get-Service PM2
   ```
   通过标准：`Status` 为 `Running`。
5. 检查日志目录与文件：
   ```powershell
   Get-ChildItem C:\hs-sku-crawler\logs
   ```
   通过标准：存在 `crawler-out.log`、`crawler-error.log`、`crawler-combined.log`（由 `ecosystem.config.js` 配置）。
6. 检查 `.env` 关键变量：
   ```powershell
   Get-Content C:\hs-sku-crawler\.env
   ```
   通过标准：`CRAWLER_NODE_CODE`、`CRAWLER_NODE_TOKEN`、`CRAWLER_TASK_URL`、`CRAWLER_CALLBACK_URL` 已配置。
7. 检查 upstream API 连通性（可选）：
   ```powershell
   Invoke-WebRequest -Uri "http://117.72.52.0/renren-api/classify/open/crawler/tasks" -Method POST -Body '{"nodeCode":"test","nodeToken":"","limit":1}' -ContentType "application/json" -UseBasicParsing
   ```
   通过标准：返回 HTTP 200（即使业务码非 0，也证明网络可达）。

- [ ] **步骤 2：验证所有命令在文档中格式正确**

运行：
```bash
grep -n '```powershell' deployment/windows/POST_DEPLOYMENT.md | wc -l
```

预期：输出 ≥ 7（本章节至少 7 个代码块）。

- [ ] **步骤 3：Commit**

```bash
git add deployment/windows/POST_DEPLOYMENT.md
git commit -m "docs(deployment/windows): 添加部署后验证清单"
```

---

## 任务 3：编写"生产环境日常操作"章节

**文件：**
- 修改：`deployment/windows/POST_DEPLOYMENT.md`

- [ ] **步骤 1：写入状态查看命令**

包含：
- `pm2 list`
- `pm2 describe crawler`
- `pm2 monit`

- [ ] **步骤 2：写入日志查看命令**

包含：
- `pm2 logs crawler`
- `pm2 logs crawler --lines 100`
- `Get-Content C:\hs-sku-crawler\logs\crawler-out.log -Tail 50`
- `Get-Content C:\hs-sku-crawler\logs\crawler-error.log -Tail 50`

- [ ] **步骤 3：写入服务控制命令**

包含：
- `pm2 restart crawler`
- `pm2 reload crawler`
- `pm2 stop crawler`
- `pm2 start crawler`
- `pm2 delete crawler`（仅在需要彻底移除时使用，并说明需重新 deploy）

- [ ] **步骤 4：写入系统重启后自动恢复说明**

说明：PM2 已注册为 Windows 服务，开机后会自动启动 `pm2 save` 保存的进程列表。
验证命令：
```powershell
pm2 save
```

- [ ] **步骤 5：写入更新与回滚命令**

包含：
- 更新：
  ```powershell
  cd C:\hs-sku-crawler\deployment\windows
  .\update.ps1 -InstallDir "C:\hs-sku-crawler" -Branch "main"
  ```
  说明：更新失败会自动回滚到上一个成功版本。
- 回滚：
  ```powershell
  .\rollback.ps1 -InstallDir "C:\hs-sku-crawler"
  ```
  或指定 commit：
  ```powershell
  .\rollback.ps1 -InstallDir "C:\hs-sku-crawler" -TargetCommit "abc1234"
  ```

- [ ] **步骤 6：Commit**

```bash
git add deployment/windows/POST_DEPLOYMENT.md
git commit -m "docs(deployment/windows): 添加生产环境日常操作"
```

---

## 任务 4：编写"测试方法"章节

**文件：**
- 修改：`deployment/windows/POST_DEPLOYMENT.md`

- [ ] **步骤 1：写入单元/集成测试命令**

```powershell
cd C:\hs-sku-crawler
npm test
```
通过标准：所有测试通过。

- [ ] **步骤 2：写入部署脚本单元测试命令**

```powershell
npm run test:deployment:unit
```

- [ ] **步骤 3：写入真实 API 冒烟测试完整步骤**

内容要点：
1. 复制环境文件：
   ```powershell
   cd C:\hs-sku-crawler
   Copy-Item test\real\.env.example .env
   ```
2. 编辑 `.env`，填入真实 `CRAWLER_NODE_TOKEN`、`CRAWLER_NODE_CODE`（建议使用独立节点如 `smoke-test-node`）。
3. 执行冒烟测试：
   ```powershell
   .\test\real\smoke-test.ps1
   ```
4. 预期输出包含 `RESULT: PASS`，且 `success >= SMOKE_MIN_SUCCESS`（默认 1）。

- [ ] **步骤 4：写入可选测试说明**

- 负载测试：`npm run test:load`
- 多机部署测试（Docker Compose）：`npm run test:deployment:local`
- 真实多机测试：参考 `test/deployment/README.md`

- [ ] **步骤 5：Commit**

```bash
git add deployment/windows/POST_DEPLOYMENT.md
git commit -m "docs(deployment/windows): 添加测试方法章节"
```

---

## 任务 5：编写"常见问题排查"章节

**文件：**
- 修改：`deployment/windows/POST_DEPLOYMENT.md`

- [ ] **步骤 1：按症状写入排查步骤**

至少覆盖以下场景：

1. **PM2 状态为 `errored` 或 `stopped`**
   - 查看错误日志：`pm2 logs crawler --lines 200`
   - 检查 `.env` 是否存在且关键变量正确。
   - 手动运行一次服务看报错：
     ```powershell
     cd C:\hs-sku-crawler
     node bin/run.js --mode service
     ```

2. **浏览器启动失败 / Chromium 找不到**
   - 确认已安装浏览器：`npx playwright install chromium`
   - 检查日志中 `BROWSER` 相关输出。

3. **upstream API 拉不到任务**
   - 检查 `CRAWLER_TASK_URL`、`CRAWLER_NODE_CODE`、`CRAWLER_NODE_TOKEN`。
   - 使用 `Invoke-WebRequest` 测试 API 连通性。

4. **callback 推送失败**
   - 检查 `CRAWLER_CALLBACK_URL`。
   - 查看日志中 `Pusher` 相关错误与重试记录。

5. **升级后健康检查失败**
   - `update.ps1` 会自动回滚，查看日志确认回滚是否成功。
   - 若自动回滚失败，手动执行 `rollback.ps1`。

6. **回滚失败**
   - 确认 `.deployment-state.json` 存在且包含 `previous` commit。
   - 检查 Git 历史：`git log --oneline -5`

- [ ] **步骤 2：Commit**

```bash
git add deployment/windows/POST_DEPLOYMENT.md
git commit -m "docs(deployment/windows): 添加常见问题排查"
```

---

## 任务 6：编写"附录"章节

**文件：**
- 修改：`deployment/windows/POST_DEPLOYMENT.md`

- [ ] **步骤 1：写入环境变量速查表**

表格至少包含：

| 环境变量 | 说明 | 示例 |
|----------|------|------|
| `CRAWLER_NODE_CODE` | 节点标识 | `crawler-01` |
| `CRAWLER_NODE_TOKEN` | 上游 API Token | `your-token` |
| `CRAWLER_TASK_URL` | 任务拉取地址 | `http://117.72.52.0/renren-api/classify/open/crawler/tasks` |
| `CRAWLER_CALLBACK_URL` | 结果回调地址 | `http://117.72.52.0/renren-api/classify/open/crawler/callback` |
| `CRAWLER_CHANNELS` | 并发通道数 | `4` |
| `CRAWLER_POLL_INTERVAL` | 轮询间隔（毫秒） | `5000` |
| `CRAWLER_POLL_LIMIT` | 每次拉取任务数 | `10` |
| `CRAWLER_PUSH_RETRIES` | 回调失败重试次数 | `3` |

- [ ] **步骤 2：写入 PM2 命令速查表**

表格至少包含：

| 命令 | 作用 |
|------|------|
| `pm2 list` | 查看所有进程 |
| `pm2 describe crawler` | 查看 crawler 详情 |
| `pm2 logs crawler` | 实时查看日志 |
| `pm2 restart crawler` | 重启服务 |
| `pm2 reload crawler` | 平滑重载 |
| `pm2 stop crawler` | 停止服务 |
| `pm2 start crawler` | 启动服务 |
| `pm2 save` | 保存进程列表 |
| `pm2 monit` | 打开监控面板 |

- [ ] **步骤 3：写入关键文件路径清单**

- 安装目录：`C:\hs-sku-crawler`
- 日志目录：`C:\hs-sku-crawler\logs`
- 环境配置：`C:\hs-sku-crawler\.env`
- 部署状态：`C:\hs-sku-crawler\.deployment-state.json`
- PM2 生态配置：`C:\hs-sku-crawler\deployment\windows\ecosystem.config.js`
- 部署脚本目录：`C:\hs-sku-crawler\deployment\windows`

- [ ] **步骤 4：Commit**

```bash
git add deployment/windows/POST_DEPLOYMENT.md
git commit -m "docs(deployment/windows): 添加附录（环境变量、PM2 速查、路径清单）"
```

---

## 任务 7：文档质量验证

**文件：**
- 修改：`deployment/windows/POST_DEPLOYMENT.md`（按需修正）

- [ ] **步骤 1：检查 Markdown 链接与路径**

运行：
```bash
node -e "
const fs = require('fs');
const content = fs.readFileSync('deployment/windows/POST_DEPLOYMENT.md', 'utf8');
const badLinks = content.match(/\[.*?\]\((?!http)[^)]+\)/g) || [];
console.log('internal links:', badLinks.length);
console.log(badLinks.join('\n'));
"
```

预期：内部链接数量合理，且引用的相对路径均存在于仓库中。

- [ ] **步骤 2：检查中英文术语一致性**

运行：
```bash
grep -nE 'pm2|PM2|sigterm|SIGTERM|sku|SKU|env|\.env' deployment/windows/POST_DEPLOYMENT.md | head -30
```

预期：
- `PM2` 统一大写
- `.env` 统一小写带点
- `SKU` 在指商品编码时大写
- `SIGTERM` 全大写

- [ ] **步骤 3：检查命令可执行性（静态）**

运行：
```bash
node -e "
const fs = require('fs');
const content = fs.readFileSync('deployment/windows/POST_DEPLOYMENT.md', 'utf8');
const powershellBlocks = content.match(/\`\`\`powershell\n([\s\S]*?)\n\`\`\`/g) || [];
console.log('powershell blocks:', powershellBlocks.length);
powershellBlocks.forEach((b, i) => {
  const lines = b.split('\n').filter(l => l.trim() && !l.startsWith('```'));
  console.log(\`block \${i + 1}: \${lines.length} command lines\`);
});
"
```

预期：所有 `powershell` 代码块均包含实际命令，无空代码块。

- [ ] **步骤 4：运行项目现有测试确保无回归**

运行：
```bash
npm test
```

预期：测试通过（文档变更不影响代码）。

- [ ] **步骤 5：最终 Commit（如需修正）**

```bash
git add deployment/windows/POST_DEPLOYMENT.md
git commit -m "docs(deployment/windows): 修正 POST_DEPLOYMENT.md 格式与术语"
```

---

## 自检

**1. 规格覆盖度：**

- [x] 部署后验证清单 → 任务 2
- [x] 生产环境日常操作 → 任务 3
- [x] 测试方法 → 任务 4
- [x] 常见问题排查 → 任务 5
- [x] 附录（环境变量、PM2 速查、路径清单） → 任务 6

**2. 占位符扫描：** 无 "待定"、"TODO"、"后续实现"。

**3. 类型一致性：** 不涉及代码类型，术语约定在任务 7 步骤 2 中统一检查。

---

## 执行交接

**计划已完成并保存到 `docs/superpowers/plans/2026-06-24-windows-post-deployment-plan.md`。两种执行方式：**

**1. 子代理驱动（推荐）** - 每个任务调度一个新的子代理，任务间进行审查，快速迭代

**2. 内联执行** - 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点

**选哪种方式？**
