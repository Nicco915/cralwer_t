# hs-sku-crawler Docker 部署与运维手册 —— Windows 生产版

> **适用场景**：`deployment/docker/`，目标环境是 **Windows Server 2019 及以上**，已启用 Docker Linux 容器模式。
>
> **配套阅读**：[`readme_docker_linux.md`](./readme_docker_linux.md)（Linux VPS 部署，与本手册共用同一个 Dockerfile 与镜像命名规范）。
>
> **不适用**：本文档不覆盖 `scripts/deploy/windows/docker/` 的"开发模式"，那个模式仅供本地调试使用，参见其自带 README。

---

## 目录

- [1. 什么时候用本手册](#1-什么时候用本手册)
- [2. 部署架构与生命周期](#2-部署架构与生命周期)
- [3. 共用基础设施](#3-共用基础设施)
- [4. 文件清单](#4-文件清单)
- [5. 前置条件](#5-前置条件)
- [6. 首次部署（端到端）](#6-首次部署端到端)
- [7. 滚动更新](#7-滚动更新)
- [8. 回滚](#8-回滚)
- [9. 状态文件 `.deployment-state.json`](#9-状态文件-deployment-statejson)
- [10. 日常运维](#10-日常运维)
- [11. 常见问题 FAQ](#11-常见问题-faq)
- [附录 A：环境变量速查](#附录-a环境变量速查)

---

## 1. 什么时候用本手册

适合你的场景：

- 你是 Windows Server 运维，希望有一套**正式发布流程**：构建 → 推送镜像 → 部署 → 可回滚。
- 你需要**自动回滚**：新版本一启动失败，脚本自己切回上一个稳定版本。
- 你希望**保留版本历史**：谁部署的、什么时候部署的、回滚能回到哪一版，都有记录。

不适合：

- 想在本机开发环境跑爬虫 → 用 [`scripts/deploy/windows/docker/`](./scripts/deploy/windows/docker/README.md)。
- 想跑在 Linux 上 → 用 [`readme_docker_linux.md`](./readme_docker_linux.md)。
- 想在 Windows 上跑 PM2 长驻进程（不经过 Docker）→ 那条路已经规划但本文档不涉及。

---

## 2. 部署架构与生命周期

### 2.1 一次完整部署的流程

部署的关键认知是：**代码不在主机上，而是在镜像里**。Dockerfile 在构建时把所有源码烤进了镜像，因此每一次代码改动都必须重新构建镜像。

```
┌─────────────┐  git commit  ┌──────────────┐  docker build/push  ┌──────────────┐
│  代码仓库    │ ──────────▶ │  构建机       │ ──────────────────▶ │  镜像仓库     │
│ (任意 OS)   │             │  (任意 OS)   │  <reg>/name:<sha>  │  (registry)  │
└─────────────┘             └──────────────┘                     └──────┬───────┘
                                                                       │ docker pull
                                                                       ▼
                                                              ┌────────────────┐
                                                              │  生产机         │
                                                              │  Windows Server │
                                                              │                │
                                                              │  deploy.ps1   │  首次部署
                                                              │  update.ps1   │  滚动更新（含自动回滚）
                                                              │  rollback.ps1 │  手动回滚
                                                              └────────────────┘
```

### 2.2 什么时候需要重新构建镜像？

| 操作 | 是否需要重新构建？ |
|---|---|
| 改了 `src/`、`bin/` 下的业务代码 | ✅ **必须**重新构建 |
| 改了 `package.json` / `package-lock.json` | ✅ **必须**重新构建 |
| 改了 `Dockerfile` 本身 | ✅ **必须**重新构建 |
| 只改 `C:\hs-sku-crawler\.env` 里的环境变量 | ❌ 不需要，重启容器即可 |
| 只在 `C:\hs-sku-crawler\logs/` 翻看日志 | ❌ 与镜像无关 |

> **常见误区**：以为"在主机上 `git pull` 后重启容器就能拿到新代码"。**错**——重启容器只会重新跑同一个旧镜像里的旧代码。

---

## 3. 共用基础设施

### 3.1 Dockerfile 要点

`deployment/docker/Dockerfile` 关键内容：

- 基础镜像：`node:20-slim`
- 安装 Chromium 运行所需的系统库 + Playwright Chromium
- 创建非 root 用户 `crawler`
- 工作目录 `/app`
- 生产模式入口：`CMD ["node", "bin/run.js"]`
- 通过 `CRAWLER_MODE` 环境变量切换 `service` / `cli` 等模式（详见容器内 `.env`）

### 3.2 镜像命名规范

```
<REGISTRY>/<IMAGE_NAME>:<TAG>
```

- `<REGISTRY>`：例如 `registry.example.com`、`ghcr.io/your-org`、`docker.io/your-user`
- `<IMAGE_NAME>`：默认 `hs-sku-crawler`
- `<TAG>`：**强烈建议使用 Git 短 SHA**（`git rev-parse --short HEAD`），例如 `a1b2c3d`
- `build-push.ps1` 会同时打两个 tag：`<sha>` 和 `latest`

> **为什么推荐 SHA 而不是 `v1.2.0` 这种语义版本？** 因为 SHA 一眼就能对应到具体 commit，事故回溯时方便；语义版本需要人工维护一致性。

### 3.3 卷与挂载点

| 容器路径 | 主机路径 | 用途 |
|---|---|---|
| `/app/logs` | `C:\hs-sku-crawler\logs` | 应用日志（由容器内 `crawler` 用户写入） |
| `/app/output` | `C:\hs-sku-crawler\output` | 任务输出、回调日志 |
| `/app/images` | `C:\hs-sku-crawler\images` | 爬虫下载的产品图片 |
| `/app/.env` | `C:\hs-sku-crawler\.env` | 以只读方式挂载 |

### 3.4 容器名称

`container_name: hs-sku-crawler`，**同一主机只能跑一个实例**，否则 compose 会拒绝启动（参见 [FAQ Q10](#q10docker-compose-up-报-container-name-already-in-use)）。

---

## 4. 文件清单

```
deployment/docker/
├── Dockerfile                 # 镜像构建配方
├── docker-compose.yml         # compose 模板，部署时拷贝到 C:\hs-sku-crawler\
├── build-push.ps1             # 构建并推送镜像（在构建机上执行）
├── deploy.ps1                 # 首次部署（在生产机上执行，需管理员）
├── update.ps1                 # 滚动更新 + 自动回滚（在生产机上执行，需管理员）
├── rollback.ps1               # 手动回滚（在生产机上执行，需管理员）
├── README.md                  # 仓库内自带的简版说明
└── lib/
    ├── deploy.js              # 首次部署逻辑
    ├── update.js              # 更新逻辑（含自动回滚）
    ├── rollback.js            # 手动回滚逻辑
    ├── state.js               # .deployment-state.json 读写
    └── health-check.js        # 容器健康探测（30 秒超时）
```

---

## 5. 前置条件

| 项目 | 要求 |
|---|---|
| 操作系统 | Windows Server 2019 及以上，启用 **Linux 容器** 模式 |
| Docker | Docker Engine + Docker Compose v2（`docker compose version` 可正常输出） |
| PowerShell | 5.1 及以上，**必须以管理员身份**运行 |
| Node.js | 任意 LTS 版本（脚本通过 `node` 调用 `lib/*.js`） |
| Git | 仅构建机需要 |
| 镜像仓库 | 可用的 registry，构建机已 `docker login` |

> ⚠️ **必须用 Docker Compose v2**（即 `docker compose`，中间是空格）。旧版独立可执行文件 `docker-compose`（带横杠）脚本不识别。详见 [FAQ Q2](#q2docker-compose-报-command-not-found)。

---

## 6. 首次部署（端到端）

整个过程分四步：**构建机出镜像 → 生产机写 `.env` → 生产机启动容器 → 验证**。

### 步骤 1：在构建机上构建并推送镜像

```powershell
cd D:\projects\hs-sku-crawler

# 同时推送两个 tag：<git 短 sha> + latest
.\deployment\docker\build-push.ps1 `
    -Registry "registry.example.com" `
    -ImageName "hs-sku-crawler"
```

如果想用自定义 tag，可以显式指定：

```powershell
.\deployment\docker\build-push.ps1 `
    -Registry "registry.example.com" `
    -ImageName "hs-sku-crawler" `
    -Tag "v1.2.0"
```

> **小贴士**：构建上下文是 `deployment/` 的上一级，即项目根目录，因此整个仓库的源码都会被烤进镜像。`.dockerignore` 已经排除了 `node_modules`、`.git`、`logs/` 等不需要的文件。
>
> **Mac / Linux 构建机**：参见 [FAQ Q1](#q1构建机能不能是-mac--linux)。

构建完成后，你应该能在 registry 里看到这样的镜像：

```
registry.example.com/hs-sku-crawler:a1b2c3d   # 这次构建的
registry.example.com/hs-sku-crawler:latest    # 始终指向最近一次构建
```

记下 `<sha>`（比如 `a1b2c3d`），下一步要传给 `deploy.ps1`。

### 步骤 2：在生产机上准备 `.env`

在 `C:\hs-sku-crawler\` 下放置 `.env`（字段参考 [附录 A](#附录-a环境变量速查)，完整模板见 `deployment/linux/.env.example`）。

**重要**：脚本不会创建也不会覆盖这个文件，必须人工先放好。

最小可用配置：

```ini
# 运行模式（必填，与 Dockerfile CMD 配合）
CRAWLER_MODE=service

# 节点身份
CRAWLER_NODE_CODE=crawler-eu-01
CRAWLER_NODE_TOKEN=your-node-token

# 上游 API
CRAWLER_TASK_URL=http://your-api/tasks
CRAWLER_CALLBACK_URL=http://your-api/callback

# 目标站点
CRAWLER_BASE_URL=https://eur.vevor.com
CRAWLER_HEADLESS=true

# 强烈建议：禁用 headed 兜底（容器内没有 X server，触发即报错）
CRAWLER_HEADED_FALLBACK=false

# 可选：代理与多通道
CRAWLER_CHANNELS=2
CLIPROXY_HOST=...
CLIPROXY_PORT=1080
CLIPROXY_USERNAME=...
CLIPROXY_PASSWORD=...
```

> Windows 模式下 `.env` 会被以**只读**方式挂载到 `/app/.env`，容器内 `node bin/run.js` 直接读取。

### 步骤 3：在生产机上首次部署

以**管理员身份**打开 PowerShell，进入项目目录：

```powershell
cd D:\projects\hs-sku-crawler

.\deployment\docker\deploy.ps1 `
    -ImageTag "a1b2c3d" `
    -Registry "registry.example.com" `
    -ImageName "hs-sku-crawler"
```

脚本执行步骤：

1. 校验管理员权限、Docker、Compose、Node、参数合法性
2. 在 `C:\hs-sku-crawler\` 下创建 `logs/`、`output/`、`images/` 三个目录
3. 若 `docker-compose.yml` 不存在，从模板拷贝过去
4. 调用 `node lib/deploy.js` 执行 `docker compose up -d`
5. 写入状态文件 `.deployment-state.json`：

   ```json
   {
     "current": "registry.example.com/hs-sku-crawler:a1b2c3d",
     "previous": null,
     "history": ["registry.example.com/hs-sku-crawler:a1b2c3d"]
   }
   ```

### 步骤 4：验证

```powershell
docker ps --filter name=hs-sku-crawler
docker logs --tail 100 hs-sku-crawler
```

看到容器处于 `Up` 状态、且日志里出现 `service` 模式启动成功的字样，就 OK 了。

---

## 7. 滚动更新

### 7.1 推荐流程

```powershell
# 1. 在构建机上：代码改动 → git commit → 构建并推送新镜像
git add -A
git commit -m "fix: ..."
.\deployment\docker\build-push.ps1 -Registry "registry.example.com" -ImageName "hs-sku-crawler"
# 假设得到新 SHA：b2c3d4e

# 2. 在生产机上：拉新镜像 → 自动回滚保护下切换
.\deployment\docker\update.ps1 -ImageTag "b2c3d4e"
```

### 7.2 `update.ps1` 的执行步骤

1. 读取 `.deployment-state.json`，拿到当前版本与上一版本
2. `docker pull <新镜像>`（120 秒超时）
3. `docker compose up -d`（使用新的 `CRAWLER_IMAGE`）
4. **健康检查**：每 2 秒轮询一次 `hs-sku-crawler` 容器状态，最多等 30 秒
5. 检查通过 → 写入新 state（`previous = 旧 current`、`current = 新镜像`、`history` 前插）
6. 检查失败 → **自动回滚**到 `state.previous`，并恢复完整状态文件

> ⚠️ 健康检查只判断 `docker inspect ... State.Status == running`，**不验证业务逻辑**。容器起来了就算成功。
>
> ⚠️ 自动回滚成功后会输出 `[update] health check failed after rollback`——**这是异常退出码**，请人工介入查看。

---

## 8. 回滚

```powershell
# 回滚到上一个版本（state.previous）
.\deployment\docker\rollback.ps1

# 回滚到指定历史版本（state.history 里的任何一个）
.\deployment\docker\rollback.ps1 -TargetImage "registry.example.com/hs-sku-crawler:a1b2c3d"
```

执行步骤：

1. 读取 `.deployment-state.json`
2. 用目标镜像执行 `docker compose up -d`
3. 健康检查 30 秒
4. 更新 state：`current` 切到目标镜像，`previous` 设为目标之前部署过的版本

---

## 9. 状态文件 `.deployment-state.json`

位置：`C:\hs-sku-crawler\.deployment-state.json`

```json
{
  "current":  "registry.example.com/hs-sku-crawler:b2c3d4e",
  "previous": "registry.example.com/hs-sku-crawler:a1b2c3d",
  "history": [
    "registry.example.com/hs-sku-crawler:b2c3d4e",
    "registry.example.com/hs-sku-crawler:a1b2c3d"
  ]
}
```

字段含义：

- `current`：当前正在跑的镜像
- `previous`：上一次部署的镜像（用于自动回滚）
- `history`：最近 20 次的部署记录，最新版本在最前面

> 这个文件是 `update.ps1` 自动回滚、跨版本回滚的唯一依据，**不要手动删除或修改**。

---

## 10. 日常运维

### 10.1 容器操作

```powershell
# 查看状态
docker ps --filter name=hs-sku-crawler --format "{{.Names}} {{.Status}}"

# 实时日志
docker logs -f --tail 200 hs-sku-crawler

# 进入容器调试
docker exec -it hs-sku-crawler sh

# 资源占用
docker stats hs-sku-crawler

# 停止 / 启动（不影响镜像版本）
docker stop hs-sku-crawler
docker start hs-sku-crawler

# 重启 compose 服务（配置变更时）
cd C:\hs-sku-crawler
docker compose restart crawler
```

### 10.2 查看当前部署版本

```powershell
Get-Content C:\hs-sku-crawler\.deployment-state.json
```

### 10.3 查看日志目录

```powershell
dir C:\hs-sku-crawler\logs
dir C:\hs-sku-crawler\output
dir C:\hs-sku-crawler\images
```

### 10.4 清理旧镜像

升级一段时间后，`docker images` 里会堆积大量 `<reg>/hs-sku-crawler:<old-sha>`。清理前请确认 `.deployment-state.json` 的 `history` 字段已经覆盖了你需要的回滚点。

```powershell
# 删除指定 tag
docker rmi registry.example.com/hs-sku-crawler:a1b2c3d

# 删除悬空镜像（推荐，无风险）
docker image prune -f

# 查看磁盘占用
docker system df
```

---

## 11. 常见问题 FAQ

### Q1：构建机能不能是 Mac / Linux？

**完全可以。** `build-push.ps1` 是 PowerShell，但内部逻辑只是 `docker build` + `docker push`，在任意有 Docker + Git 的机器上都能跑。

Mac / Linux 等价命令：

```bash
TAG=$(git rev-parse --short HEAD)
docker build -t registry.example.com/hs-sku-crawler:${TAG} \
    -f deployment/docker/Dockerfile .
docker tag registry.example.com/hs-sku-crawler:${TAG} \
          registry.example.com/hs-sku-crawler:latest
docker push registry.example.com/hs-sku-crawler:${TAG}
docker push registry.example.com/hs-sku-crawler:latest
```

### Q2：`docker compose` 报 `command not found`

Docker Compose v2 不再以独立 `docker-compose` 可执行文件分发，而是 Docker CLI 的一个插件（写法是 `docker compose`，中间空格）。

- **Windows**：升级 Docker Desktop 到最新版本即可。
- **Linux**（在 Linux 构建机上遇到时）：

  ```bash
  # apt 方式
  sudo apt-get update && sudo apt-get install docker-compose-plugin

  # 手动安装
  sudo curl -SL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64 \
      -o /usr/local/lib/docker/cli-plugins/docker-compose
  sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
  ```

### Q3：`deploy.ps1` 报 "must be run as Administrator"

用**管理员身份**打开 PowerShell（右击 → "以管理员身份运行"）。脚本里有 `#Requires -RunAsAdministrator`，非管理员身份会直接退出。

### Q4：`deploy.ps1` 报 "Docker is not installed" 或 "Docker Compose is not available"

PowerShell 默认 PATH 可能找不到 Docker CLI。把 Docker Desktop 的路径加到 PATH：

```
C:\Program Files\Docker\Docker\resources\bin
```

或者在 Docker Desktop 的设置里勾上 "Add Docker CLI to PATH"。

### Q5：`deploy.ps1` 报 ".env not found at C:\hs-sku-crawler\.env"

脚本**不会创建** `.env`，必须人工先放进去（参见 [步骤 2](#步骤-2在生产机上准备-env)）。

### Q6：`update.ps1` 失败后自动回滚也失败了

可能的原因：

1. `state.previous` 指向的镜像已经被清理（手动 `docker rmi` 过）→ 先 `docker pull <previous>` 再回滚
2. 镜像 registry 不可达（内网问题或鉴权过期）→ 检查 `docker login`、`docker pull` 是否能成功
3. `.env` 在更新过程中被改坏了 → 回滚用的是旧 state，但 `docker-compose.yml` 已经是新版本；恢复 `.env` 后重试

修复后建议人工执行 `rollback.ps1`，或者直接 `docker compose up -d` 指定一个能用的镜像。

### Q7：`update.ps1` 报 "ImageTag must not contain whitespace or shell metacharacters"

脚本禁止 `ImageTag` 包含 `\`、空格、`;`、`|`、`&`、`$`、`<`、`>`、`(`、`)` 等字符。Git 短 SHA（十六进制）天然满足；如果用自定义 tag，不要带分隔符以外的特殊字符。

### Q8：容器起来了，但爬虫一个任务都拉不到

按以下顺序排查：

1. `docker logs hs-sku-crawler | tail -100` —— 看启动阶段的报错
2. `docker exec hs-sku-crawler sh -c 'env | grep CRAWLER_'` —— 确认环境变量注入正确
3. 在容器内手动调用上游接口：
   ```bash
   docker exec hs-sku-crawler sh -c \
     "wget -qO- ${CRAWLER_TASK_URL}?token=${CRAWLER_NODE_TOKEN}"
   ```
4. 检查 `CRAWLER_NODE_TOKEN` 是否过期、节点是否被上游禁用

### Q9：Playwright 浏览器在容器里启动失败

`Dockerfile` 已经 `npx playwright install chromium`，并设置 `PLAYWRIGHT_BROWSERS_PATH=/app/ms-playwright`。如果你修改了 Dockerfile 或用 `--build-arg` 覆盖了 Playwright 版本，请确保：

1. `package.json` 中 `playwright` 版本与 `npx playwright install` 的版本一致
2. `/app` 目录属主是 `crawler` 用户（UID 由镜像决定）

### Q10：`docker compose up` 报 "container name already in use"

`hs-sku-crawler` 这个名字已经被另一个容器占用（可能来自其他 compose 项目）。处理方式：

```powershell
# 查找占用者
docker ps -a --filter name=hs-sku-crawler

# 删除残留
docker rm -f hs-sku-crawler
```

### Q11：Windows / Linux 模式可以混用吗？

**可以**，原因：

- 同一个 `Dockerfile`
- 同一个镜像名 `hs-sku-crawler`
- 同一个容器名（但同一主机不能并存）

你可以用 Linux 构建机出镜像、Windows 生产机部署，反过来也行。**只是回滚逻辑不互通**——Windows 用 `.deployment-state.json`，Linux 用 `.last_image`，两边需要分别维护。

### Q12：升级到新版镜像后磁盘没释放

Docker 的旧镜像层不会自动删除，需要手动清理：

```powershell
docker image prune -a -f   # 谨慎：会删除所有无引用的镜像
# 或者精准删除
docker rmi registry.example.com/hs-sku-crawler:<不再需要的 tag>
```

### Q13：怎么实现蓝绿 / 灰度发布？

当前的 compose 是单容器单实例，**不直接支持**。如需灰度，建议：

1. 复制一份 compose（容器名改为 `hs-sku-crawler-canary`），用不同的 `CRAWLER_NODE_CODE` 上线
2. 验证金丝雀没问题后，再 `update.ps1` 主实例
3. 下线金丝雀

### Q14：CI 集成示例

GitHub Actions 示例（精简版）：

```yaml
name: build-push
on:
  push:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Login
        run: docker login registry.example.com -u ${{ secrets.REG_USER }} -p ${{ secrets.REG_PASS }}
      - name: Build & push
        run: |
          TAG=$(git rev-parse --short HEAD)
          docker build -t registry.example.com/hs-sku-crawler:${TAG} \
              -f deployment/docker/Dockerfile .
          docker tag registry.example.com/hs-sku-crawler:${TAG} \
                    registry.example.com/hs-sku-crawler:latest
          docker push registry.example.com/hs-sku-crawler:${TAG}
          docker push registry.example.com/hs-sku-crawler:latest
          echo "TAG=${TAG}" >> $GITHUB_OUTPUT
        id: build
      - name: Trigger deploy
        run: |
          ssh prod "cd D:/projects/hs-sku-crawler && ./deployment/docker/update.ps1 -ImageTag ${{ steps.build.outputs.TAG }}"
```

---

## 附录 A：环境变量速查

完整字段参考 `deployment/linux/.env.example`。下面是必须关注的几项：

| 变量 | 必填 | 说明 |
|---|---|---|
| `CRAWLER_MODE` | ✅ | `service` 为长驻模式；其他值视 `bin/run.js` 支持情况 |
| `CRAWLER_NODE_CODE` | ✅ | 节点标识，回调到上游时使用 |
| `CRAWLER_NODE_TOKEN` | ✅ | 上游 API 鉴权 |
| `CRAWLER_TASK_URL` | ✅ | 任务拉取地址 |
| `CRAWLER_CALLBACK_URL` | ✅ | 结果回调地址 |
| `CRAWLER_BASE_URL` | 推荐 | 目标站点，默认 `https://eur.vevor.com` |
| `CRAWLER_HEADLESS` | 否 | `true` / `false`，默认 `true` |
| `CRAWLER_HEADED_FALLBACK` | **Docker 必填 `false`** | 容器内没有 X server，启用 headed 兜底会启动失败 |
| `CRAWLER_CHANNELS` | 否 | 单容器内并发通道数 |
| `CRAWLER_POLL_INTERVAL` | 否 | 拉取间隔（毫秒） |
| `CRAWLER_POLL_LIMIT` | 否 | 单次最多拉取任务数 |
| `CLIPROXY_*` | 否 | 住宅代理池配置（详见 `.env.example` 与 `开发日志.md`） |
| `CRAWLER_IMAGE` | 仅 compose | `docker-compose.yml` 用 `${CRAWLER_IMAGE:?...}` 读取，由 `deploy.ps1` / `update.ps1` 注入 |