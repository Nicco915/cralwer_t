# hs-sku-crawler Docker 部署与运维手册 —— Linux 版

> **适用场景**：`deployment/linux/`，目标环境是 **任意主流 Linux 发行版**（Ubuntu / Debian / CentOS / AlmaLinux 等）。
>
> **配套阅读**：[`readme_docker_windows.md`](./readme_docker_windows.md)（Windows Server 生产部署，含自动回滚机制；与本手册共用同一个 Dockerfile 与镜像命名规范）。
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
- [7. 更新](#7-更新)
- [8. 回滚](#8-回滚)
- [9. 日常运维](#9-日常运维)
- [10. 常见问题 FAQ](#10-常见问题-faq)
- [附录 A：环境变量速查](#附录-a环境变量速查)

---

## 1. 什么时候用本手册

适合你的场景：

- 你要在一台 Linux VPS（Ubuntu / Debian / CentOS 等）上跑爬虫节点
- 你想要**轻量部署**：bash + docker compose，不需要装 Node.js
- 你能接受**手动回滚**：通过 `.last_image` 文件记录上一个版本
- 你不需要 Windows 那种 30 秒健康检查 + 自动回滚的机制

不适合：

- 你要自动回滚保护 → 用 [`readme_docker_windows.md`](./readme_docker_windows.md)（借同一份镜像，把 `update.ps1` 搬过来也未尝不可）
- 你只是想在本地开发环境跑 → 用 [`scripts/deploy/windows/docker/`](./scripts/deploy/windows/docker/README.md)（在 Linux 本地同理可用）
- 你想跑多个容器实例做集群 → 当前 compose 不直接支持，需要改造

---

## 2. 部署架构与生命周期

### 2.1 一次完整部署的流程

Linux 部署的关键认知同样是：**代码不在主机上，而是在镜像里**。每一次代码改动都必须重新构建镜像。

```
┌─────────────┐  git commit  ┌──────────────┐  docker build/push  ┌──────────────┐
│  代码仓库    │ ──────────▶ │  构建机       │ ──────────────────▶ │  镜像仓库     │
│ (任意 OS)   │             │  (任意 OS)   │  <reg>/name:<sha>  │  (registry)  │
└─────────────┘             └──────────────┘                     └──────┬───────┘
                                                                       │ docker pull
                                                                       ▼
                                                              ┌────────────────┐
                                                              │  生产机         │
                                                              │  Linux VPS      │
                                                              │                │
                                                              │  deploy.sh   │  首次部署
                                                              │  update.sh   │  更新（写 .last_image）
                                                              │  rollback.sh │  回滚（读 .last_image）
                                                              └────────────────┘
```

### 2.2 什么时候需要重新构建镜像？

| 操作 | 是否需要重新构建？ |
|---|---|
| 改了 `src/`、`bin/` 下的业务代码 | ✅ **必须**重新构建 |
| 改了 `package.json` / `package-lock.json` | ✅ **必须**重新构建 |
| 改了 `Dockerfile` 本身 | ✅ **必须**重新构建 |
| 只改 `.env` 里的环境变量 | ❌ 不需要，重启容器即可 |
| 只在 `logs/` 翻看日志 | ❌ 与镜像无关 |

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
- 通过 `CRAWLER_MODE` 环境变量切换 `service` / `cli` 等模式

### 3.2 镜像命名规范

```
<REGISTRY>/<IMAGE_NAME>:<TAG>
```

- `<REGISTRY>`：例如 `registry.example.com`、`ghcr.io/your-org`、`docker.io/your-user`
- `<IMAGE_NAME>`：默认 `hs-sku-crawler`
- `<TAG>`：**强烈建议使用 Git 短 SHA**（`git rev-parse --short HEAD`），例如 `a1b2c3d`

### 3.3 卷与挂载点

| 容器路径 | 主机路径 | 用途 |
|---|---|---|
| `/app/logs` | `./logs` | 应用日志（由容器内 `crawler` 用户写入） |
| `/app/output` | `./output` | 任务输出、回调日志 |
| `/app/images` | `./images` | 爬虫下载的产品图片 |
| `.env` | compose `env_file: .env` | 通过 compose 注入环境变量（**不挂载为文件**） |

### 3.4 日志轮转

`docker-compose.yml` 已经配置好：

```yaml
logging:
  driver: "json-file"
  options:
    max-size: "50m"
    max-file: "5"
```

每个容器最多保留 5 个 50MB 的日志文件，超出会自动清理。

### 3.5 容器名称

`container_name: hs-sku-crawler`，**同一主机只能跑一个实例**，否则 compose 会拒绝启动（参见 [FAQ Q11](#q11docker-compose-up-报-container-name-already-in-use)）。

---

## 4. 文件清单

```
deployment/linux/
├── docker-compose.yml          # 运行时 compose（直接使用，不拷贝）
├── .env.example                # 环境变量模板
├── deploy.sh                   # 首次部署
├── update.sh                   # 更新（写入 .last_image）
└── rollback.sh                 # 回滚（读取 .last_image）
```

> 与 Windows 模式不同，**Linux 模式不拷贝任何文件到部署目录**，所有脚本和 compose 都在仓库原位使用。

---

## 5. 前置条件

| 项目 | 要求 |
|---|---|
| 操作系统 | 任意主流 Linux 发行版 |
| Docker | Docker Engine + Docker Compose v2 |
| 镜像 | 与 Windows 模式完全兼容（同一 Dockerfile） |
| 端口 | 默认无需对外暴露端口（容器作为 client 拉任务 / 回调结果） |

> ⚠️ **必须用 Docker Compose v2**（即 `docker compose`，中间是空格）。详见 [FAQ Q2](#q2docker-compose-报-command-not-found)。

---

## 6. 首次部署（端到端）

整个过程分四步：**构建机出镜像 → 生产机准备目录与 `.env` → 启动容器 → 验证**。

### 步骤 1：在构建机上构建并推送镜像

可以直接在生产机上构建，也可以在其他机器构建后推送：

```bash
# 方式 A：直接在 VPS 构建（适合单机部署，无 registry）
docker build -t your-registry/hs-sku-crawler:<sha> \
    -f deployment/docker/Dockerfile .

# 方式 B：构建并推送（适合多机部署）
docker build -t your-registry/hs-sku-crawler:<sha> \
    -f deployment/docker/Dockerfile .
docker push  your-registry/hs-sku-crawler:<sha>
```

**Windows / Mac 构建机**：使用 [`build-push.ps1`](./readme_docker_windows.md#q1构建机能不能是-mac--linux)，或在 shell 里跑等价命令。

记下 `<sha>`（比如 `a1b2c3d`），下一步要传给 `deploy.sh`。

### 步骤 2：在生产机上准备目录与 `.env`

```bash
# 创建部署目录
mkdir -p /opt/hs-sku-crawler && cd /opt/hs-sku-crawler

# 拷贝 compose 与脚本
cp /path/to/repo/deployment/linux/docker-compose.yml .
cp /path/to/repo/deployment/linux/{deploy,update,rollback}.sh .
cp /path/to/repo/deployment/linux/.env.example .env

# 编辑 .env，必须设置 CRAWLER_IMAGE_BASE
sed -i 's|^CRAWLER_IMAGE_BASE=.*|CRAWLER_IMAGE_BASE=your-registry/hs-sku-crawler|' .env

chmod +x deploy.sh update.sh rollback.sh
```

`.env` 字段参考 [附录 A](#附录-a环境变量速查)。完整模板见 `deployment/linux/.env.example`。

### 步骤 3：启动容器

```bash
cd /opt/hs-sku-crawler
CRAWLER_IMAGE_BASE=your-registry/hs-sku-crawler ./deploy.sh a1b2c3d
```

脚本执行步骤：

1. 校验 `CRAWLER_IMAGE_BASE` 已设置且末尾不带 `/`
2. 校验当前目录有 `.env`
3. 创建 `logs/`、`output/`、`images/` 三个目录
4. 导出 `CRAWLER_IMAGE=<base>:<tag>`
5. `docker compose pull && docker compose up -d`
6. 打印 `docker compose ps`

> ⚠️ `deploy.sh` **不会自动记录当前镜像到 `.last_image`**，这是它与 `update.sh` 的差别。意味着首次部署之后直接执行 `rollback.sh` 会失败（找不到 `.last_image`）。
>
> 如果你部署完就想保留回滚能力，二选一：
>
> - 跑一次 `update.sh` 触发 `.last_image` 写入（用任意 tag，包括当前的）
> - 手工写一行：`echo 'your-registry/hs-sku-crawler:a1b2c3d' > .last_image`

### 步骤 4：验证

```bash
docker ps --filter name=hs-sku-crawler
docker logs --tail 100 hs-sku-crawler
```

看到容器处于 `Up` 状态、且日志里出现 `service` 模式启动成功的字样，就 OK 了。

---

## 7. 更新

```bash
cd /opt/hs-sku-crawler
CRAWLER_IMAGE_BASE=your-registry/hs-sku-crawler ./update.sh b2c3d4e
```

执行步骤：

1. `docker inspect hs-sku-crawler` 拿到当前镜像 → 写入 `.last_image`（这就是回滚锚点）
2. 导出新的 `CRAWLER_IMAGE`
3. `docker compose pull && docker compose up -d --no-deps crawler`

> `--no-deps` 不会拉起任何依赖服务。当前 compose 只有 `crawler` 一个服务，效果等同于不带这个参数，但更显式。
>
> ⚠️ `update.sh` **没有健康检查**——`docker compose up -d` 退出即视为成功，业务是否正常需要人工确认。

---

## 8. 回滚

```bash
cd /opt/hs-sku-crawler
./rollback.sh
```

执行步骤：

1. 要求当前目录存在 `.env` 与 `.last_image`
2. 读取 `.last_image`，拿到上一个镜像
3. `docker compose up -d --no-deps crawler`

> ⚠️ 回滚之后 `.last_image` 不会被更新。**也就是说连续两次 `rollback.sh` 只会回到同一个旧版本**——这是有意为之，避免"回滚 A → 更新 `.last_image` → 再次回滚却回到 B"的混乱。

如需回滚到更早的版本，请人工指定：

```bash
export CRAWLER_IMAGE=your-registry/hs-sku-crawler:<某历史 tag>
docker compose up -d --no-deps crawler
```

> Windows 模式没有这个问题——`rollback.ps1` 会自动维护 `state.previous` 与 `state.history`（详见 [`readme_docker_windows.md`](./readme_docker_windows.md)）。

---

## 9. 日常运维

### 9.1 容器操作

```bash
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
cd /opt/hs-sku-crawler
docker compose restart crawler
```

### 9.2 查看当前部署版本

```bash
docker inspect --format='{{.Config.Image}}' hs-sku-crawler
```

### 9.3 查看本地日志目录

```bash
ls -lh /opt/hs-sku-crawler/logs/
du -sh /opt/hs-sku-crawler/output/ /opt/hs-sku-crawler/images/
```

容器内写文件的是 `crawler` 用户（UID 由镜像决定，参见 `Dockerfile`）。如果主机目录的属主是 `root`，容器内写入会失败，请：

```bash
chown -R 1000:1000 /opt/hs-sku-crawler/logs /opt/hs-sku-crawler/output /opt/hs-sku-crawler/images
```

`1000:1000` 是镜像内 `crawler` 用户的默认 UID/GID。

### 9.4 清理旧镜像

升级一段时间后，`docker images` 里会堆积大量 `<reg>/hs-sku-crawler:<old-sha>`。清理前请确认 `.last_image` 已经覆盖了你需要的回滚点。

```bash
# 删除指定 tag
docker rmi your-registry/hs-sku-crawler:a1b2c3d

# 删除悬空镜像（推荐，无风险）
docker image prune -f

# 查看磁盘占用
docker system df
```

---

## 10. 常见问题 FAQ

### Q1：构建机能不能是 Mac / Windows？

**完全可以。** 在 [`readme_docker_windows.md` FAQ Q1](./readme_docker_windows.md#q1构建机能不能是-mac--linux) 里给出了 Mac/Linux 等价的 docker 命令，或者直接使用 Windows 上的 `build-push.ps1`。

### Q2：`docker compose` 报 `command not found`

Docker Compose v2 不再以独立 `docker-compose` 可执行文件分发，而是 Docker CLI 的一个插件（写法是 `docker compose`，中间空格）。

```bash
# apt 方式
sudo apt-get update && sudo apt-get install docker-compose-plugin

# 手动安装
sudo curl -SL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64 \
    -o /usr/local/lib/docker/cli-plugins/docker-compose
sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
```

### Q3：`deploy.sh` 报 "未设置 CRAWLER_IMAGE_BASE"

`CRAWLER_IMAGE_BASE` 必须以**环境变量**形式传入，不能写在 `.env` 里——脚本只读 `.env` 喂给容器内的爬虫，不读 `CRAWLER_IMAGE_BASE` 本身。

```bash
CRAWLER_IMAGE_BASE=your-registry/hs-sku-crawler ./deploy.sh a1b2c3d
```

或者 export 到当前 shell 的 rc 文件里：

```bash
echo 'export CRAWLER_IMAGE_BASE=your-registry/hs-sku-crawler' >> ~/.bashrc
source ~/.bashrc
```

### Q4：`deploy.sh` 报 "CRAWLER_IMAGE_BASE 末尾不应包含斜杠"

正确形式：

```bash
CRAWLER_IMAGE_BASE=registry.example.com/hs-sku-crawler   # ✅
CRAWLER_IMAGE_BASE=registry.example.com/hs-sku-crawler/  # ❌
```

### Q5：`deploy.sh` 报 "当前目录缺少 .env"

需要在 `deploy.sh` 所在目录准备 `.env`（参见 [步骤 2](#步骤-2在生产机上准备目录与-env)）。Linux 模式下 `.env` 不会自动拷贝，必须人工放置。

### Q6：`rollback.sh` 报 "找不到 .last_image"

`deploy.sh` 首次部署**不会写** `.last_image`。处理方式：

```bash
# 方案 A：用一次 update 触发写入
./update.sh <任意 tag，比如当前镜像 tag>

# 方案 B：手工写入
docker inspect --format='{{.Config.Image}}' hs-sku-crawler > .last_image
```

### Q7：`rollback.sh` 连续执行没有变化

设计上 `.last_image` 在 rollback 之后**不会被更新**。这是为了避免"回滚 A → 更新 `.last_image` → 再次回滚却回到 B"的混乱。

如果需要回滚到更早的版本，请人工指定：

```bash
export CRAWLER_IMAGE=your-registry/hs-sku-crawler:<某历史 tag>
docker compose up -d --no-deps crawler
```

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
3. 主机挂载的 `logs/output/images` 目录属主也是该 UID（参见 [9.3](#93-查看本地日志目录)）

### Q10：Windows / Linux 模式可以混用吗？

**可以**，原因：

- 同一个 `Dockerfile`
- 同一个镜像名 `hs-sku-crawler`
- 同一个容器名（但同一主机不能并存）

你可以用 Windows 构建机出镜像、Linux 生产机部署，反过来也行。**只是回滚逻辑不互通**——Windows 用 `.deployment-state.json`，Linux 用 `.last_image`，两边需要分别维护。

### Q11：`docker compose up` 报 "container name already in use"

`hs-sku-crawler` 这个名字已经被另一个容器占用（可能来自其他 compose 项目）。处理方式：

```bash
# 查找占用者
docker ps -a --filter name=hs-sku-crawler

# 删除残留
docker rm -f hs-sku-crawler
```

### Q12：升级到新版镜像后磁盘没释放

Docker 的旧镜像层不会自动删除，需要手动清理：

```bash
docker image prune -a -f   # 谨慎：会删除所有无引用的镜像
# 或者精准删除
docker rmi your-registry/hs-sku-crawler:<不再需要的 tag>
```

### Q13：怎么实现蓝绿 / 灰度发布？

当前的 compose 是单容器单实例，**不直接支持**。如需灰度，建议：

1. 复制一份 compose（容器名改为 `hs-sku-crawler-canary`），用不同的 `CRAWLER_NODE_CODE` 上线
2. 验证金丝雀没问题后，再 `update.sh` 主实例
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
      - name: Trigger deploy (Linux)
        run: |
          ssh prod "cd /opt/hs-sku-crawler && \
            CRAWLER_IMAGE_BASE=registry.example.com/hs-sku-crawler \
            ./update.sh ${{ steps.build.outputs.TAG }}"
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
| `CRAWLER_CHANNELS` | 否 | 单容器内并发通道数，`.env.example` 给 `2` |
| `CRAWLER_POLL_INTERVAL` | 否 | 拉取间隔（毫秒） |
| `CRAWLER_POLL_LIMIT` | 否 | 单次最多拉取任务数 |
| `CRAWLER_PUSH_RETRIES` | 否 | 回调失败重试次数 |
| `CLIPROXY_*` | 否 | 住宅代理池配置（详见 `.env.example` 与 `开发日志.md`） |
| `CRAWLER_IMAGE_BASE` | **shell 必填** | `deploy.sh` / `update.sh` 用，与 `IMAGE_TAG` 拼成完整镜像，**末尾不能带 `/`** |
| `CRAWLER_IMAGE` | **compose 必填** | `docker-compose.yml` 用 `${CRAWLER_IMAGE:?...}` 读取，由 `deploy.sh` / `update.sh` 注入 |