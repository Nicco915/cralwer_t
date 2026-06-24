# hs-sku-crawler Windows 部署后验证与生产运维指南

本文档面向运维人员和开发/测试人员，说明项目通过 `deployment/windows/deploy.ps1` 成功部署到 Windows 服务器后：

- 如何验证部署是否成功
- 如何在生产机上执行日常操作（查看状态、重启、升级、回滚）
- 如何运行测试验证端到端流程
- 如何排查常见问题

适用范围：已完成首次部署，PM2 已注册为 Windows 服务，安装目录默认为 `C:\hs-sku-crawler`。

---

## 1. 部署后验证清单

部署脚本执行完成后，按以下顺序验证服务是否正常运行。

### 1.1 以管理员身份打开 PowerShell

所有 PM2 和部署相关操作都需要管理员权限。右键点击 PowerShell 图标，选择「以管理员身份运行」。

### 1.2 检查 PM2 进程状态

```powershell
pm2 list
```

**通过标准：**

- `crawler` 进程状态为 `online`
- `uptime` 持续增长，没有频繁重启

查看更详细的进程信息：

```powershell
pm2 describe crawler
```

重点关注：

- `restart count`：若数值持续增加，说明进程在反复崩溃
- `error log path`：确认错误日志路径正确

### 1.3 检查 Windows 服务

PM2 已被注册为 Windows 服务，系统重启后会自动恢复 crawler 进程。

```powershell
Get-Service PM2
```

**通过标准：** `Status` 为 `Running`。

也可以在「服务」管理控制台中查看：

```powershell
services.msc
```

### 1.4 检查日志文件

```powershell
Get-ChildItem C:\hs-sku-crawler\logs
```

**通过标准：** 存在以下日志文件：

- `crawler-out.log` —— 标准输出
- `crawler-error.log` —— 错误输出
- `crawler-combined.log` —— 合并日志

查看最近的输出：

```powershell
Get-Content C:\hs-sku-crawler\logs\crawler-out.log -Tail 30
```

### 1.5 核对 .env 配置

```powershell
Get-Content C:\hs-sku-crawler\.env
```

**必须确认的关键变量：**

| 变量 | 说明 |
|------|------|
| `CRAWLER_NODE_CODE` | 节点唯一标识，如 `crawler-01` |
| `CRAWLER_NODE_TOKEN` | 上游 API 认证 Token |
| `CRAWLER_TASK_URL` | 任务拉取地址 |
| `CRAWLER_CALLBACK_URL` | 结果回调地址 |
| `CRAWLER_CHANNELS` | 并发通道数，生产环境通常为 `4` |

### 1.6 检查上游 API 连通性（可选）

```powershell
$body = '{"nodeCode":"test","nodeToken":"","limit":1}'
Invoke-WebRequest -Uri "http://117.72.52.0/renren-api/classify/open/crawler/tasks" -Method POST -Body $body -ContentType "application/json" -UseBasicParsing
```

**通过标准：** 返回 HTTP 200。即使业务返回码非 0，也说明网络可达。

---

## 2. 生产环境日常操作

### 2.1 查看服务状态

```powershell
pm2 list
pm2 describe crawler
pm2 monit
```

`pm2 monit` 会打开一个实时 CPU/内存监控面板，按 `q` 退出。

### 2.2 查看日志

实时跟踪日志：

```powershell
pm2 logs crawler
```

查看最近 100 行：

```powershell
pm2 logs crawler --lines 100
```

直接读取日志文件：

```powershell
Get-Content C:\hs-sku-crawler\logs\crawler-out.log -Tail 50
Get-Content C:\hs-sku-crawler\logs\crawler-error.log -Tail 50
```

### 2.3 重启与重载服务

**普通重启**（进程会短暂中断）：

```powershell
pm2 restart crawler
```

**平滑重载**（推荐，服务不中断）：

```powershell
pm2 reload crawler
```

**停止服务：**

```powershell
pm2 stop crawler
```

**启动已停止的服务：**

```powershell
pm2 start crawler
```

> 注意：如果执行了 `pm2 delete crawler`，则需要重新运行 `deploy.ps1` 或手动通过 `ecosystem.config.js` 启动。

### 2.4 系统重启后的自动恢复

PM2 注册为 Windows 服务后，会在系统启动时自动加载已保存的进程列表。保存当前进程列表：

```powershell
pm2 save
```

如果新增或删除了 crawler 进程，建议重新执行一次 `pm2 save`。

### 2.5 更新代码

在已部署的服务器上执行：

```powershell
cd C:\hs-sku-crawler\deployment\windows
.\update.ps1 -InstallDir "C:\hs-sku-crawler" -Branch "main"
```

`update.ps1` 会完成以下操作：

1. `git fetch origin`
2. `git reset --hard origin/<branch>`
3. `npm ci`
4. `pm2 reload` 重启服务
5. 健康检查，等待 `crawler` 状态变为 `online`

**自动回滚：** 如果更新后健康检查失败，脚本会自动回滚到上一个成功版本。

### 2.6 回滚代码

回滚到上一个版本：

```powershell
cd C:\hs-sku-crawler\deployment\windows
.\rollback.ps1 -InstallDir "C:\hs-sku-crawler"
```

回滚到指定 commit：

```powershell
.\rollback.ps1 -InstallDir "C:\hs-sku-crawler" -TargetCommit "abc1234"
```

`rollback.ps1` 会：

1. `git reset --hard <target_commit>`
2. `npm ci`
3. `pm2 reload`
4. 健康检查确认服务恢复

> 回滚依赖 `.deployment-state.json` 中记录的历史版本。如果该文件丢失，可手动通过 `git log` 查找目标 commit。

### 2.7 代理池日常维护

如果启用了 Kuaidaili 独享代理池（配置了 `KUAIDAILI_SECRET_ID` / `KUAIDAILI_SECRET_KEY`），需要进行以下日常维护。

#### 查看当前 Channel-IP 分配

```powershell
Get-Content C:\hs-sku-crawler\proxy-assignments.json
```

#### 手动刷新代理池

服务会按 `PROXY_REFRESH_INTERVAL_MS` 自动刷新。如需立即刷新（例如发现多个 Channel 被拦截）：

```powershell
cd C:\hs-sku-crawler
node -e "const { KuaidailiClient } = require('./src/kuaidaili-client'); const { ProxyPool } = require('./src/proxy-pool'); (async () => { const client = new KuaidailiClient({ secretId: process.env.KUAIDAILI_SECRET_ID, secretKey: process.env.KUAIDAILI_SECRET_KEY, proxyNum: process.env.KUAIDAILI_PROXY_NUM || 1000 }); const pool = new ProxyPool({ client, machineIndex: process.env.PROXY_MACHINE_INDEX || 0, machineTotal: process.env.PROXY_MACHINE_TOTAL || 1, channels: process.env.CRAWLER_CHANNELS || 4, assignmentsFile: process.env.PROXY_ASSIGNMENTS_FILE || 'C:\\\\hs-sku-crawler\\\\proxy-assignments.json' }); const map = await pool.assign(); console.log(JSON.stringify(map, null, 2)); })().catch(console.error);"
```

然后平滑重载服务使新分配生效：

```powershell
pm2 reload crawler
```

#### 手动切换指定 Channel 的 IP

当某个 Channel 频繁被拦截时，可手动让它切换到分区中的下一个 IP：

```powershell
cd C:\hs-sku-crawler
node -e "const { KuaidailiClient } = require('./src/kuaidaili-client'); const { ProxyPool } = require('./src/proxy-pool'); (async () => { const client = new KuaidailiClient({ secretId: process.env.KUAIDAILI_SECRET_ID, secretKey: process.env.KUAIDAILI_SECRET_KEY }); const pool = new ProxyPool({ client, machineIndex: process.env.PROXY_MACHINE_INDEX || 0, machineTotal: process.env.PROXY_MACHINE_TOTAL || 1, channels: process.env.CRAWLER_CHANNELS || 4, assignmentsFile: process.env.PROXY_ASSIGNMENTS_FILE || 'C:\\\\hs-sku-crawler\\\\proxy-assignments.json' }); await pool.assign(); const next = await pool.nextForChannel('ch-1'); console.log('ch-1 next proxy:', next); })().catch(console.error);"
pm2 reload crawler
```

#### 清理 Token 缓存

如果 Kuaidaili 鉴权 token 过期或异常，可删除缓存文件强制重新获取：

```powershell
Remove-Item C:\hs-sku-crawler\.kdl_token -ErrorAction SilentlyContinue
pm2 reload crawler
```

#### 水平扩展时调整机器分区

新增机器时，需要为每台机器分配唯一的 `PROXY_MACHINE_INDEX`：

| 机器 | `PROXY_MACHINE_INDEX` | `PROXY_MACHINE_TOTAL` |
|------|----------------------:|----------------------:|
| machine-01 | 0 | N |
| machine-02 | 1 | N |
| ... | ... | N |
| machine-N | N-1 | N |

确保：

- 所有机器使用相同的 `PROXY_MACHINE_TOTAL`（机器总数）
- 每台机器的 `PROXY_MACHINE_INDEX` 从 `0` 开始递增，不重复
- 单个分区内的 IP 数 ≥ 该机器的 `CRAWLER_CHANNELS`

如果 `KUAIDAILI_PROXY_NUM / PROXY_MACHINE_TOTAL < CRAWLER_CHANNELS`，需要增加 `KUAIDAILI_PROXY_NUM` 或减少 Channel 数。

#### 代理池健康监控要点

日常巡检时关注日志中的以下关键字：

| 关键字 | 含义 | 处理建议 |
|--------|------|----------|
| `[PROXY] Refresh failed:` | 刷新代理列表失败 | 检查网络、Kuaidaili 凭据、token 缓存 |
| `[PROXY] Refresh changed proxies:` | 部分 Channel IP 已变更 | 观察后续任务成功率 |
| `[SERVICE] Channel X unhealthy detected` | Channel 不健康 | 服务会自动尝试切换 IP，若持续失败则检查代理可用性 |
| `[SERVICE] Rotating channel X to ...` | 正在切换 IP | 正常自愈行为 |
| `Proxy partition too small` | 分区 IP 不足 | 增加 `KUAIDAILI_PROXY_NUM` 或减少 `CRAWLER_CHANNELS` |

---

## 3. 测试方法

### 3.1 单元与集成测试

```powershell
cd C:\hs-sku-crawler
npm test
```

覆盖范围：Poller、Pusher、代理配置、stub server、service 集成测试等。

### 3.2 部署脚本单元测试

```powershell
npm run test:deployment:unit
```

验证 `deploy.js`、`update.js`、`rollback.js` 在缺少 `.env` 或参数错误时能否正确退出。

### 3.3 真实 API 冒烟测试

这是最重要的生产验证测试，连接真实的上游任务 API 和 VEVOR 网站。

#### 环境准备

```powershell
cd C:\hs-sku-crawler
Copy-Item test\real\.env.example .env
```

编辑 `.env`，填入真实值：

```env
CRAWLER_NODE_CODE=smoke-test-node
CRAWLER_NODE_TOKEN=your-real-token-here
CRAWLER_TASK_URL=http://117.72.52.0/renren-api/classify/open/crawler/tasks
CRAWLER_CALLBACK_URL=http://117.72.52.0/renren-api/classify/open/crawler/callback
CRAWLER_CHANNELS=2
CRAWLER_POLL_LIMIT=5
SMOKE_MIN_SUCCESS=1
SMOKE_TIMEOUT_SECONDS=300
```

> 建议使用独立的 `CRAWLER_NODE_CODE`（如 `smoke-test-node`），避免干扰正式生产节点。

#### 执行测试

```powershell
.\test\real\smoke-test.ps1
```

如果 PowerShell 执行策略限制，先运行：

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

#### 通过标准

测试输出应类似：

```text
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

关键指标：

- `Service started: yes`
- `success >= SMOKE_MIN_SUCCESS`（默认至少 1 个成功）
- `completed >= started`

测试日志保留在 `test/real/smoke-test.log`，可用于事后分析。

### 3.4 代理池 IP 测试

本项目支持 Kuaidaili 独享代理池：按机器分区、每台机器上的每个 Channel 分配不同 IP，并定时刷新。使用代理池时，必须验证 IP 分配、可用性、自动刷新与失败重切。

#### 环境准备

在 `.env` 中配置 Kuaidaili 凭据与分区参数：

```env
# Kuaidaili 独享代理池凭据
KUAIDAILI_SECRET_ID=your-secret-id
KUAIDAILI_SECRET_KEY=your-secret-key
KUAIDAILI_PROXY_TYPE=kps
KUAIDAILI_PROXY_NUM=1000

# 机器分区（3 台机器时分别设为 0/1/2）
PROXY_MACHINE_INDEX=0
PROXY_MACHINE_TOTAL=3

# Channel-IP 映射持久化文件
PROXY_ASSIGNMENTS_FILE=C:\hs-sku-crawler\proxy-assignments.json

# 刷新间隔（默认 5 分钟）
PROXY_REFRESH_INTERVAL_MS=300000

# 每个 Channel 使用不同 IP
CRAWLER_CHANNELS=2
```

> **优先级说明：** 静态代理 `CRAWLER_PROXY` 优先级高于代理池。如果同时配置了 `CRAWLER_PROXY`，代理池不会生效。

#### 3.4.1 检查 Channel-IP 分配

启动服务后，查看持久化文件：

```powershell
Get-Content C:\hs-sku-crawler\proxy-assignments.json
```

预期输出：

```json
{
  "ch-1": "1.2.3.4:8080",
  "ch-2": "5.6.7.8:8080"
}
```

通过标准：

- 每个 Channel 都有独立的 IP
- 同一机器内不同 Channel 的 IP 不相同
- IP 格式为 `host:port`

#### 3.4.2 验证代理可用性

通过代理访问 VEVOR 网站：

```powershell
$proxy = "http://1.2.3.4:8080"
Invoke-WebRequest -Uri "https://eur.vevor.com" -Proxy $proxy -UseBasicParsing -TimeoutSec 30
```

通过标准：

- 返回 HTTP 200
- 响应时间合理（通常 < 10 秒）

Kuaidaili `kps` 产品的认证信息通常已嵌入 IP 中，无需额外 `-ProxyCredential`。

#### 3.4.3 验证服务启动日志

启动服务后观察日志：

```powershell
pm2 logs crawler --lines 50
```

应看到类似输出：

```text
[PROXY] Assigned proxies: { 'ch-1': '1.2.3.4:8080', 'ch-2': '5.6.7.8:8080' }
[SERVICE] Running with nodeCode=crawler-01, channels=2
```

#### 3.4.4 验证自动刷新

默认每 5 分钟（`PROXY_REFRESH_INTERVAL_MS`）代理池会从 Kuaidaili 重新拉取 IP 列表并刷新映射。当日志出现：

```text
[PROXY] Refresh changed proxies: [ 'ch-1' ]
[PROXY] Reinitializing channel 1 with 9.8.7.6:8080
```

表示刷新成功，Channel 1 的 IP 已变更并重新初始化。

#### 3.4.5 验证失败重切

当某个 Channel 被 Cloudflare 拦截或代理失效时，服务会自动切换到该 Channel 分区中的下一个 IP。观察日志：

```text
[SERVICE] Channel 1 unhealthy detected
[SERVICE] Rotating channel 1 to 9.8.7.6:8080
[SERVICE] Channel 1 recovered after proxy rotation
```

通过标准：

- unhealthy 检测后成功切换到新 IP
- Channel 恢复在线，任务继续处理

#### 3.4.6 多机器分区验证

对于多机器部署，确保每台机器的 `PROXY_MACHINE_INDEX` 不同且 `PROXY_MACHINE_TOTAL` 相同：

| 机器 | PROXY_MACHINE_INDEX | PROXY_MACHINE_TOTAL |
|------|---------------------|---------------------|
| machine-01 | 0 | 3 |
| machine-02 | 1 | 3 |
| machine-03 | 2 | 3 |

验证方法：

1. 在每台机器上启动服务
2. 分别查看 `proxy-assignments.json`
3. 确认不同机器的 IP 无重叠

```powershell
# 在 machine-01 上
Get-Content C:\hs-sku-crawler\proxy-assignments.json

# 在 machine-02 上
Get-Content C:\hs-sku-crawler\proxy-assignments.json
```

通过标准：

- 同一机器内不同 Channel IP 不重复
- 不同机器之间的 IP 不重叠

#### 3.4.7 代理池常见问题

1. **启动报错 `Proxy partition too small for machine X: got N IPs but need M channels`**
   - 原因：该机器分区到的 IP 数少于 Channel 数
   - 解决：减少 `CRAWLER_CHANNELS`，或增加 `KUAIDAILI_PROXY_NUM`，或减少 `PROXY_MACHINE_TOTAL`

2. **`proxy-assignments.json` 为空或不生成**
   - 原因：未配置 `KUAIDAILI_SECRET_ID` / `KUAIDAILI_SECRET_KEY`，或凭据错误
   - 解决：检查 `.env` 并确认 Kuaidaili 账户可用

3. **所有 Channel 使用同一 IP**
   - 原因：可能同时配置了 `CRAWLER_PROXY`（静态代理优先级更高）
   - 解决：删除或注释 `CRAWLER_PROXY`

4. **代理刷新失败**
   - 原因：网络不稳定、Kuaidaili 接口限流、token 过期
   - 解决：检查日志中 `[PROXY] Refresh failed:` 错误信息，确认能访问 `auth.kdlapi.com` 和 `kps.kdlapi.com`

### 3.5 负载测试（可选）

```powershell
npm run test:load
```

使用本地 stub server 验证 4 并发通道下任务不重复、全部成功回调。

### 3.6 多机部署测试（可选）

- **本地 Docker Compose 模拟：** `npm run test:deployment:local`
- **真实多机部署：** 参考 `test/deployment/README.md`

---

## 4. 常见问题排查

### 4.1 PM2 状态为 `errored` 或 `stopped`

1. 查看错误日志：
   ```powershell
   pm2 logs crawler --lines 200
   ```
2. 检查 `.env` 是否存在且关键变量正确。
3. 手动前台运行一次，观察报错：
   ```powershell
   cd C:\hs-sku-crawler
   node bin/run.js --mode service
   ```

### 4.2 浏览器启动失败 / Chromium 找不到

1. 安装 Playwright 浏览器：
   ```powershell
   npx playwright install chromium
   ```
2. 检查日志中 `[BROWSER]` 相关输出。
3. 如需指定浏览器路径，在 `.env` 中设置：
   ```env
   CRAWLER_BROWSER_PATH=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
   ```

### 4.3 上游 API 拉不到任务

1. 检查 `.env` 中的 `CRAWLER_TASK_URL`、`CRAWLER_NODE_CODE`、`CRAWLER_NODE_TOKEN`。
2. 使用 `Invoke-WebRequest` 测试连通性（见 1.6）。
3. 确认上游任务队列中有待处理任务。

### 4.4 Callback 推送失败

1. 检查 `CRAWLER_CALLBACK_URL` 是否正确。
2. 查看日志中 `Pusher` 相关错误与重试记录。
3. 确认网络可以访问回调地址，无防火墙拦截。

### 4.5 升级后健康检查失败

1. `update.ps1` 会自动回滚到上一个版本，观察日志确认回滚是否成功。
2. 若自动回滚失败，手动执行：
   ```powershell
   .\rollback.ps1 -InstallDir "C:\hs-sku-crawler"
   ```

### 4.6 代理池 IP 失效或分配异常

1. 检查 `proxy-assignments.json` 是否生成：
   ```powershell
   Get-Content C:\hs-sku-crawler\proxy-assignments.json
   ```
2. 检查日志中 `[PROXY]` 相关输出，确认 `assign`、`refresh`、`rotate` 是否正常。
3. 验证 Kuaidaili 凭据：
   ```powershell
   node -e "require('./src/kuaidaili-client').KuaidailiClient" 2>&1
   ```
   或直接查看 `.kdl_token` 缓存文件是否存在。
4. 使用 `Invoke-WebRequest -Proxy` 测试单个代理是否可用（见 3.4.2）。
5. 如果问题持续，参考 3.4.7「代理池常见问题」逐项排查。

### 4.7 回滚失败

1. 确认 `.deployment-state.json` 存在：
   ```powershell
   Get-Content C:\hs-sku-crawler\.deployment-state.json
   ```
2. 检查 Git 历史：
   ```powershell
   cd C:\hs-sku-crawler
   git log --oneline -5
   ```
3. 手动指定 commit 回滚：
   ```powershell
   .\rollback.ps1 -InstallDir "C:\hs-sku-crawler" -TargetCommit "<commit-sha>"
   ```

---

## 5. 附录

### 5.1 环境变量速查表

| 环境变量 | 说明 | 默认值/示例 |
|----------|------|-------------|
| `CRAWLER_NODE_CODE` | 节点唯一标识 | `crawler-01` |
| `CRAWLER_NODE_TOKEN` | 上游 API 认证 Token | `your-token` |
| `CRAWLER_TASK_URL` | 任务拉取地址 | `http://117.72.52.0/renren-api/classify/open/crawler/tasks` |
| `CRAWLER_CALLBACK_URL` | 结果回调地址 | `http://117.72.52.0/renren-api/classify/open/crawler/callback` |
| `CRAWLER_CHANNELS` | 并发通道数 | `4` |
| `CRAWLER_POLL_INTERVAL` | 轮询间隔（毫秒） | `5000` |
| `CRAWLER_POLL_LIMIT` | 每次拉取任务数 | `10` |
| `CRAWLER_PUSH_RETRIES` | 回调失败重试次数 | `3` |
| `CRAWLER_HEADLESS` | 是否无头运行浏览器 | `true` |
| `CRAWLER_MIN_DELAY` | SKU 间最小延迟（秒） | `5` |
| `CRAWLER_MAX_DELAY` | SKU 间最大延迟（秒） | `10` |
| `CRAWLER_PROXY` | 静态代理地址（优先级高于代理池） | `http://proxy.example.com:8080` |
| `KUAIDAILI_SECRET_ID` | Kuaidaili 订单 SecretId | - |
| `KUAIDAILI_SECRET_KEY` | Kuaidaili 订单 SecretKey | - |
| `KUAIDAILI_PROXY_TYPE` | Kuaidaili 产品类型 | `kps` |
| `KUAIDAILI_PROXY_NUM` | 每次拉取代理数量 | `1000` |
| `KUAIDAILI_TOKEN_CACHE_FILE` | Kuaidaili token 缓存文件 | `.kdl_token` |
| `PROXY_MACHINE_INDEX` | 当前机器序号（从 0 开始） | `0` |
| `PROXY_MACHINE_TOTAL` | 机器总数 | `1` |
| `PROXY_REFRESH_INTERVAL_MS` | 代理池刷新间隔（毫秒） | `300000` |
| `PROXY_ASSIGNMENTS_FILE` | Channel-IP 映射持久化文件 | `./proxy-assignments.json` |

### 5.2 PM2 命令速查表

| 命令 | 作用 |
|------|------|
| `pm2 list` | 查看所有进程 |
| `pm2 describe crawler` | 查看 crawler 详情 |
| `pm2 logs crawler` | 实时查看日志 |
| `pm2 logs crawler --lines 100` | 查看最近 100 行日志 |
| `pm2 restart crawler` | 重启服务 |
| `pm2 reload crawler` | 平滑重载服务 |
| `pm2 stop crawler` | 停止服务 |
| `pm2 start crawler` | 启动已停止的服务 |
| `pm2 save` | 保存进程列表，用于开机自启 |
| `pm2 monit` | 打开监控面板 |

### 5.3 关键文件路径清单

| 路径 | 说明 |
|------|------|
| `C:\hs-sku-crawler` | 项目安装目录 |
| `C:\hs-sku-crawler\.env` | 环境变量配置 |
| `C:\hs-sku-crawler\.deployment-state.json` | 部署状态（当前/历史 commit） |
| `C:\hs-sku-crawler\logs\` | 应用日志目录 |
| `C:\hs-sku-crawler\proxy-assignments.json` | Channel-IP 映射持久化文件 |
| `C:\hs-sku-crawler\.kdl_token` | Kuaidaili token 缓存文件 |
| `C:\hs-sku-crawler\deployment\windows\` | 部署脚本目录 |
| `C:\hs-sku-crawler\deployment\windows\ecosystem.config.js` | PM2 进程配置 |
| `C:\hs-sku-crawler\bin\run.js` | 服务入口文件 |

---

## 6. 相关文档

- [Windows 部署说明](README.md) —— 首次部署、更新、回滚脚本说明
- [项目主 README](../../README.md) —— 整体架构、配置项、CLI 用法
- [真实 API 测试说明](../../test/real/README.md) —— 冒烟测试与故障容忍测试详情
- [多机部署测试说明](../../test/deployment/README.md) —— 本地模拟与真实多机测试
