# 加拿大 Windows 多爬虫 PM2 部署设计

- 日期：2026-07-14
- 范围：**仅一台**加拿大 Windows 机器。其它 Windows 机器继续使用 `deployment/windows/ecosystem.config.js`，不受影响。
- 目标：在该机器上用 PM2 跑 5 个爬虫进程（w01~w05），使用 cliproxy 住宅代理，**与 VPS 上的 Docker 爬虫硬隔离**（完全不同的出口 IP 集），零代码改动。

## 1. 背景与约束

- 该机器在加拿大，无地域网络问题。
- 已有部署形态：PM2 + fork 模式 + `--mode=service`，强制 Playwright 自带 Chromium。
- 每个爬虫：1 个 channel（`CRAWLER_CHANNELS=1`）。
- 代理：与 VPS 同一 cliproxy 账号，但用**不同地区 + 不同 ASN** 实现硬隔离。
  - VPS：`REGION=DE` + `ASN=AS12897`，prefix `v01~v08`。
  - 本机：`REGION=CA` + `ASN=AS11290`（Cogeco，实测可并发拿 10 个不同 IP），prefix `w01~w05`。
- 未来 VPS 可能也迁到 CA：届时 region 相同，**靠 ASN 不同**继续保持隔离（让 VPS 换用另一个 CA ASN 即可）。

## 2. 核心机制：每进程独立工作目录（per-process cwd）

代码里所有文件态都走相对路径，因此给每个 PM2 进程一个独立 `cwd` 即可一次性隔离全部文件：

| 文件 | 代码位置 | 默认相对路径 | 隔离后（w01 为例） |
|---|---|---|---|
| 应用日志 | `src/logger.js:43` | `./logs/crawler.jsonl` | `instances/w01/logs/crawler.jsonl` |
| 浏览器临时目录 | `bin/run.js:91` | `./output/browser-temp` | `instances/w01/output/browser-temp` |
| cliproxy 分配文件 | `bin/run.js:71` | `./output/cliproxy-assignments.json` | `instances/w01/output/cliproxy-assignments.json` |
| 图片目录 | `bin/run.js:15` | `./output/images` | `instances/w01/output/images` |

`cliproxy-assignments.json` 的隔离尤其关键：它持久化了每个 session 的 nonce。多进程共享同一文件会读到同一个 nonce，导致 sid 相同 → 共享同一出口 IP（temp 容器共享 output 卷时踩过的坑）。per-process cwd 从根上杜绝。

> 说明：`bin/run.js` 与 `src/service.js` 都会 `mkdirSync(..., { recursive: true })` 自动创建 `output/*` 与 `logs/` 子目录；只有顶层 `instances/wNN` 需要预先创建（PM2 不会自动建 `cwd`）。

## 3. 每进程配置

| 进程 | nodeCode | session prefix（双写） | health port | cwd |
|---|---|---|---|---|
| crawler-ca-w01 | `w01` | `w01` | 3101 | `instances/w01` |
| crawler-ca-w02 | `w02` | `w02` | 3102 | `instances/w02` |
| crawler-ca-w03 | `w03` | `w03` | 3103 | `instances/w03` |
| crawler-ca-w04 | `w04` | `w04` | 3104 | `instances/w04` |
| crawler-ca-w05 | `w05` | `w05` | 3105 | `instances/w05` |

所有进程共享（在 `SHARED_PROXY` 中）：

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

sid 形如 `w01-ch1-<nonce>`，第一段 `w01` 唯一 ⇒ 出口 IP 唯一。

## 4. cliproxy 隔离原理（必读）

### 4.1 session key = sid 第一个 `-` 前的字符串

cliproxy 服务端只用 sid 的第一段做 session key：

```
sid = "w01-ch1-a3f9c2d8"
       ^^^^
       cliproxy 只认这一段
```

因此 prefix 必须**两两唯一且不含 `-`**。`w01~w05` 满足；`crawler-01` 这类会让第一段恒为 `crawler`，导致所有进程共享同一 IP（VPS 已踩并修复，见 `部署vps.md` 4.2）。

### 4.2 双 env 变量陷阱

`CRAWLER_CLIPROXY_SESSION_PREFIX` 与 `CLIPROXY_SESSION_PREFIX` 都映射到 `cliproxySessionPrefix`，且 `src/cli.js:246-248` 是 first-match-wins，前者先出现、优先级更高。**两个都必须设置**，否则旧值仍生效。本配置已双写同一值。

### 4.3 不同 sid ≠ 硬隔离

不同 sid 只能保证**同一时刻**不撞同一 IP。若与 VPS 共用 region+ASN，则共用同一底层 IP 池，sticky 过期后 IP 会回流，可能出现「VPS 用过的 IP 后来被本机拿到」。要达到「完全不同的 IP 集」，必须再叠加**不同 ASN**（本方案 CA/AS11290 vs VPS DE/AS12897）。

### 4.4 PARAM_NAME 必须与 VPS 一致

VPS `/opt/crawler/.env` 实测使用 `region/asn/sid/t` 这组参数名，而代码默认是 `country/session/sticky`。若依赖默认值，代理 username 编码错误、鉴权失败。本配置已显式对齐。

## 5. 部署步骤

```powershell
# ① 拉取代码（含 deployment/windows/ecosystem.canada.config.js）

# ② 创建每进程工作目录（一次性）
1..5 | % { New-Item -ItemType Directory -Force "instances\w0$_" }

# ③ 注入 cliproxy 凭据（与 VPS 同账号；setx 后需重开终端/重启 PM2）
setx CLIPROXY_USERNAME "<同 VPS>"
setx CLIPROXY_PASSWORD "<同 VPS>"

# ④ 启动
pm2 start deployment/windows/ecosystem.canada.config.js
pm2 save
```

## 6. 验证

```powershell
# ① 5 个进程都在线
pm2 list

# ② 每进程 sid 第一段唯一且格式正确（wNN-ch1-<nonce>）
1..5 | % { Get-Content "instances\w0$_\output\cliproxy-assignments.json" }

# ③ 出口 IP 全部唯一，且归属 CA / AS11290（非 VPS 的 DE / AS12897）
#    用各进程 assignments 文件里的代理逐条 curl mayips.com / ipinfo.io 核对
```

预期：5 个不同 IP，均在加拿大、ASN=AS11290；与 VPS 的 8 个 IP 无任何重叠。

## 7. 红线（禁止复现）

- **禁止** SESSION_PREFIX 含 `-` 或各进程不唯一 → 多进程共享同一出口 IP。
- **禁止**只设 `CLIPROXY_SESSION_PREFIX` 不设 `CRAWLER_CLIPROXY_SESSION_PREFIX` → 旧值仍生效。
- **禁止**多进程共用同一 `cwd` / 同一 `cliproxy-assignments.json` → sid 串号。
- **禁止**依赖 PARAM_NAME 的代码默认值（`country/session/sticky`）→ 必须用 `region/asn/sid/t`。
- **禁止**本机与 VPS 使用相同 region+ASN（会退回「同一 IP 池」，失去硬隔离）。

## 8. 扩容

改 `ecosystem.canada.config.js` 顶部 `NODE_COUNT`（prefix 自动生成 w01..wNN，health port 自动 3101..），并 `New-Item` 对应的 `instances\wNN` 目录，然后 `pm2 start ... --only crawler-ca-wNN`。

## 9. 未来 VPS 迁 CA 时的操作

本机已固定 `ASN=AS11290`。VPS 迁 CA 时，在 VPS 的 `rolling-update.py` / `.env` 中把 `CLIPROXY_ASN` 换成**另一个** CA ASN（如 AS577/AS812/AS852/AS6327/AS5769），即可继续保持与本机的硬隔离。
