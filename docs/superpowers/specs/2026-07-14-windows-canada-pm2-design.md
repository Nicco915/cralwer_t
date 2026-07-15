# 加拿大 Windows 多爬虫 PM2 部署设计

- 日期：2026-07-14（v2：nodeCode 与 sessionPrefix 解耦）
- 范围：**仅一台**加拿大 Windows 机器。其它 Windows 机器继续使用 `deployment/windows/ecosystem.config.js` + `.env`，不受影响。
- 目标：在该机器上用 PM2 跑多个爬虫进程，使用 cliproxy 住宅代理，**与 VPS 上的 Docker 爬虫硬隔离**（完全不同的出口 IP 集），零代码改动。

## 1. 背景与约束

- 该机器在加拿大，无地域网络问题。
- 已有部署形态：PM2 + fork 模式 + `--mode=service`，强制 Playwright 自带 Chromium。
- 每个爬虫：1 个 channel（`CRAWLER_CHANNELS=1`）。
- **nodeCode 命名**：与其它 Windows 机器同一约定（如 `crawler-15`，可带 `-`）。其它机器单进程、用 `.env` 设一个 `CRAWLER_NODE_CODE`；本机多进程、每个进程 nodeCode 不同，单个 `.env` 放不下，因此在本配置的 `NODE_CODES` 数组里逐个手填。
- 代理：与 VPS 同一 cliproxy 账号，但用**不同地区 + 不同 ASN** 实现硬隔离。
  - VPS：`REGION=DE` + `ASN=AS12897`，prefix `v01~v08`。
  - 本机：`REGION=CA` + `ASN=AS11290`（Cogeco，实测可并发拿 10 个不同 IP）。
- 未来 VPS 可能也迁到 CA：届时 region 相同，**靠 ASN 不同**继续保持隔离。

## 2. 核心机制一：nodeCode 与 sessionPrefix 解耦

两个东西，各管各的，**不要混用**：

| 配置项 | env | 能否带 `-` | 作用 | 本机取值 |
|---|---|---|---|---|
| nodeCode | `CRAWLER_NODE_CODE` | ✅ 可以 | 任务端看到的节点名（拉任务/回调/日志） | 你手填，如 `crawler-15` |
| sessionPrefix | `CRAWLER_CLIPROXY_SESSION_PREFIX` + `CLIPROXY_SESSION_PREFIX` | ❌ 不能 | cliproxy session key，决定出口 IP | **代码自动派生**：nodeCode 去掉所有 `-` |

派生规则：`crawler-15 → crawler15`。因为 cliproxy 只用 sid 第一个 `-` 前的字符串做 session key：

```
sid = "crawler15-ch1-a3f9c2d8"
       ^^^^^^^^^^
       cliproxy 只认这一段 = "crawler15"（唯一 ⇒ 独立出口 IP）
```

如果让 sessionPrefix 直接等于带 `-` 的 nodeCode（`crawler-15`），第一段会被截成 `crawler`，于是所有 `crawler-XX` 进程共享同一 IP（VPS 已踩并修复，见 `部署vps.md` 4.2）。**去掉 `-` 后第一段完整且唯一**，从根上避免。

配置里还有一道防呆：`NODE_CODES` 中任意两个 nodeCode 去掉 `-` 后若撞车（如 `crawler-15` 与 `crawler1-5` → 都是 `crawler15`），PM2 加载配置时直接抛错，而不是静默共享 IP。

> 双 env 陷阱：`CRAWLER_CLIPROXY_SESSION_PREFIX` 与 `CLIPROXY_SESSION_PREFIX` 都映射到 `cliproxySessionPrefix`，`src/cli.js:246-248` first-match-wins、前者优先。配置已**双写**同一派生值。

## 3. 核心机制二：每进程独立工作目录（per-process cwd）

代码里所有文件态都走相对路径，给每个进程一个独立 `cwd`（`instances/<nodeCode>`）即可一次性隔离：

| 文件 | 代码位置 | 隔离后（crawler-15 为例） |
|---|---|---|
| 应用日志 | `src/logger.js:43` | `instances/crawler-15/logs/crawler.jsonl` |
| 浏览器临时目录 | `bin/run.js:91` | `instances/crawler-15/output/browser-temp` |
| cliproxy 分配文件 | `bin/run.js:71` | `instances/crawler-15/output/cliproxy-assignments.json` |
| 图片目录 | `bin/run.js:15` | `instances/crawler-15/output/images` |

`cliproxy-assignments.json` 隔离尤其关键：它持久化每个 session 的 nonce，多进程共享会读到同一 nonce → sid 相同 → 共享 IP（temp 容器共享 output 卷踩过的坑）。

> 实例目录 `instances/<nodeCode>` 由配置在 PM2 加载时 `fs.mkdirSync(recursive)` **自动创建**，无需手动建目录（目录不存在 PM2 会 ENOENT 起不来）。

## 4. 每进程配置（NODE_CODES 手填区）

在 `ecosystem.canada.config.js` 的 `NODE_CODES` 数组里手动维护每台爬虫的 nodeCode：

```js
const NODE_CODES = [
  'crawler-13',
  'crawler-14',
  'crawler-15',
  'crawler-16',
  'crawler-17',
  'crawler-18',
  'crawler-19',
  'crawler-20',
];
```

每个进程自动得到：

| 进程名(pm2) | nodeCode（手填） | sessionPrefix（派生） | health port | cwd |
|---|---|---|---|---|
| crawler-13 | `crawler-13` | `crawler13` | 3101 | `instances/crawler-13` |
| crawler-14 | `crawler-14` | `crawler14` | 3102 | `instances/crawler-14` |
| crawler-15 | `crawler-15` | `crawler15` | 3103 | `instances/crawler-15` |
| crawler-16 | `crawler-16` | `crawler16` | 3104 | `instances/crawler-16` |
| crawler-17 | `crawler-17` | `crawler17` | 3105 | `instances/crawler-17` |
| crawler-18 | `crawler-18` | `crawler18` | 3106 | `instances/crawler-18` |
| crawler-19 | `crawler-19` | `crawler19` | 3107 | `instances/crawler-19` |
| crawler-20 | `crawler-20` | `crawler20` | 3108 | `instances/crawler-20` |

所有进程共享（`SHARED_PROXY`）：

```
CLIPROXY_HOST=us2.cliproxy.io
CLIPROXY_PORT=3010
CLIPROXY_REGION=CA
CLIPROXY_ASN=AS11290
CLIPROXY_STICKY_MINUTES=10
CLIPROXY_REGION_PARAM_NAME=region
CLIPROXY_ASN_PARAM_NAME=asn
CLIPROXY_SESSION_PARAM_NAME=sid
CLIPROXY_STICKY_PARAM_NAME=t
CLIPROXY_USERNAME / CLIPROXY_PASSWORD   # 与 VPS 同账号，经环境变量注入，不提交
```

## 5. cliproxy 隔离原理（必读）

- **不同 sid ≠ 硬隔离**：不同 sid 只保证同一时刻不撞同一 IP。若与 VPS 共用 region+ASN，则共用底层 IP 池，sticky 过期后 IP 回流，可能出现「VPS 用过的 IP 后来被本机拿到」。要「完全不同的 IP 集」必须再叠加**不同 ASN**（本方案 CA/AS11290 vs VPS DE/AS12897）。
- **PARAM_NAME 必须与 VPS 一致**：VPS `.env` 实测用 `region/asn/sid/t`，代码默认是 `country/session/sticky`。依赖默认值会导致 username 编码错误、鉴权失败。本配置已显式对齐。

## 6. 部署步骤

```powershell
# ① 拉取代码（含 deployment/windows/ecosystem.canada.config.js），npm install

# ② 编辑 ecosystem.canada.config.js：
#    - NODE_CODES 改成你实际的 5 个 nodeCode
#    - 填入 cliproxy 凭据（方式 b：直接改两个 ''；或方式 a：setx，见下）
#      setx CLIPROXY_USERNAME "<同 VPS>"
#      setx CLIPROXY_PASSWORD "<同 VPS>"     # setx 后需重开终端 / pm2 kill 后重启

# ③ 启动（实例目录自动创建，无需手动建）
pm2 start deployment/windows/ecosystem.canada.config.js
pm2 save
```

## 7. 验证

```powershell
# ① 进程都在线，名字即 nodeCode
pm2 list

# ② 每进程 sid 第一段 = 派生 prefix（crawlerNN，无 -），格式 crawlerNN-ch1-<nonce>
Get-Content "instances\crawler-15\output\cliproxy-assignments.json"

# ③ 健康端口（crawler-13 -> 3101 … crawler-17 -> 3105）
curl http://localhost:3101/health

# ④ 出口 IP：用各进程 assignments 文件里的代理逐条 curl mayips.com / ipinfo.io
#    预期：5 个互不相同，全属 加拿大/AS11290，与 VPS 的 8 个 IP（DE/AS12897）零重叠
```

## 8. 红线（禁止复现）

- **禁止**让 sessionPrefix 含 `-`（例如直接拿带 `-` 的 nodeCode 当 prefix）→ 第一段被截断，多进程共享 IP。sessionPrefix 一律走自动派生（去 `-`）。
- **禁止**只设 `CLIPROXY_SESSION_PREFIX` 不设 `CRAWLER_CLIPROXY_SESSION_PREFIX` → 旧值仍生效。
- **禁止**多进程共用同一 `cwd` / 同一 `cliproxy-assignments.json` → sid 串号。
- **禁止**依赖 PARAM_NAME 的代码默认值（`country/session/sticky`）→ 必须用 `region/asn/sid/t`。
- **禁止**本机与 VPS 使用相同 region+ASN → 退回同一 IP 池，失去硬隔离。

## 9. 扩容 / 缩容

改 `NODE_CODES` 数组（增/删 nodeCode 行），然后 `pm2 start deployment/windows/ecosystem.canada.config.js`（新进程）或 `pm2 delete <nodeCode>`（下线）。sessionPrefix、健康端口、实例目录全部自动派生/创建，无需其它改动。

## 10. 未来 VPS 迁 CA 时的操作

本机已固定 `ASN=AS11290`。VPS 迁 CA 时，在 VPS 的 `rolling-update.py` / `.env` 中把 `CLIPROXY_ASN` 换成**另一个** CA ASN（如 AS577/AS812/AS852/AS6327/AS5769），即可继续保持与本机的硬隔离。
