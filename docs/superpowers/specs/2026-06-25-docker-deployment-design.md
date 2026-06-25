# Docker 容器化部署方案

## 背景与目标

在现有 Windows PM2 原生部署方案的基础上，新增 Docker 容器化部署路径，使 hs_sku/crawler 服务能够以容器形式运行在 Windows 服务器（Docker Linux 容器模式）或其他支持 Docker 的 Linux 主机上。Docker 方案与现有 PM2 方案共存，运维团队可按目标环境选择。

## 关键决策

- **部署形式**：容器化 Node.js 服务，使用 `node:20-slim` 基础镜像，将 Chromium 浏览器打包进镜像。
- **目标环境**：Windows 服务器上预先安装 Docker Engine 与 Docker Compose，运行 Linux 容器。
- **镜像分发**：在本地或 CI 中构建镜像，以 Git commit SHA 为 tag 推送到镜像仓库。
- **编排工具**：使用 `docker-compose.yml` 管理容器、volume 与重启策略。
- **配置管理**：敏感配置（`.env`）由运维人员预先放置在目标机安装目录，`docker-compose.yml` 通过只读 volume 挂载，部署脚本只检查存在性。
- **进程守护**：容器崩溃或主机重启后由 Docker `restart: unless-stopped` 自动恢复。
- **状态管理**：在目标机维护 `.deployment-state.json`，记录 `current`、`previous` 与 `history` 镜像 tag，支持一键回滚。

## 新增文件结构

```
deployment/
├── windows/                          # 现有 PM2 原生部署（保持不变）
└── docker/                           # 新增 Docker 部署
    ├── Dockerfile
    ├── docker-compose.yml
    ├── .dockerignore
    ├── deploy.ps1                    # 目标机首次部署
    ├── update.ps1                    # 目标机更新
    ├── rollback.ps1                  # 目标机回滚
    ├── build-push.ps1                # 构建并推送镜像
    ├── lib/
    │   ├── state.js                  # .deployment-state.json 管理
    │   ├── health-check.js           # 容器健康检查
    │   ├── deploy.js                 # 首次部署逻辑
    │   ├── update.js                 # 更新逻辑
    │   └── rollback.js               # 回滚逻辑
    └── README.md                     # Docker 部署操作说明
```

## Dockerfile

```dockerfile
FROM node:20-slim

# 安装系统依赖与 Chromium 所需库
RUN apt-get update && apt-get install -y \
    wget gnupg ca-certificates procps \
    libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 \
    libgbm1 libasound2 libxcomposite1 libxdamage1 libxfixes3 \
    libxrandr2 libgtk-3-0 libpango-1.0-0 libcairo2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

# 安装 Playwright Chromium
RUN npx playwright install chromium

COPY . .

ENV NODE_ENV=production
ENV CRAWLER_MODE=service

CMD ["node", "bin/run.js", "--mode=service"]
```

- 使用 `node:20-slim` 而非 Alpine，避免 Playwright 浏览器依赖问题。
- 浏览器在镜像构建时安装，避免运行时下载。
- `npm ci --only=production` 仅安装生产依赖。

## docker-compose.yml

```yaml
version: "3.8"

services:
  crawler:
    image: ${CRAWLER_IMAGE:?未设置 CRAWLER_IMAGE 环境变量}
    container_name: hs-sku-crawler
    restart: unless-stopped
    volumes:
      - ./.env:/app/.env:ro
      - ./logs:/app/logs
      - ./output:/app/output
      - ./images:/app/images
    working_dir: /app
```

- `CRAWLER_IMAGE` 由部署脚本根据当前 tag 注入。
- 主机上的 `.env` 以只读 volume 形式挂载到容器 `/app/.env`，与 PM2 方案的"预放置配置"保持一致。
- 日志/输出/图片目录持久化到主机。

## 镜像构建与推送

`build-push.ps1` 用于本地或 CI 构建：

```powershell
param(
  [Parameter(Mandatory=$true)] [string]$ImageName,
  [Parameter(Mandatory=$true)] [string]$Registry,
  [string]$Tag = (git rev-parse --short HEAD)
)

$fullImage = "$Registry/$ImageName`:$Tag"
$latestImage = "$Registry/$ImageName`:latest"

docker build -t $fullImage -f deployment/docker/Dockerfile .
docker tag $fullImage $latestImage
docker push $fullImage
docker push $latestImage
```

- 镜像 tag 使用 Git commit 短 SHA，同时更新 `latest` 指针。
- 目标机部署/更新时使用精确的 SHA tag（如 `abc1234`），`latest` 仅作为人工拉取的别名，不用于状态追踪。

## 部署脚本

### deploy.ps1（首次部署）

1. 检查是否以管理员身份运行（`#Requires -RunAsAdministrator`）。
2. 检查 Docker 与 Docker Compose 是否已安装，不存在则退出并提示。
3. 创建安装目录 `C:\hs-sku-crawler`，包含 `logs`、`output`、`images` 子目录。
4. 检查 `.env` 是否存在，不存在则退出。
5. 复制 `deployment/docker/docker-compose.yml` 到安装目录。
6. 调用 Node.js `deploy.js`：
   - 记录 `current` 镜像 tag 到 `.deployment-state.json`。
   - 设置 `CRAWLER_IMAGE` 环境变量。
   - 执行 `docker compose up -d`。
   - 等待健康检查通过。

### update.ps1（更新）

1. 读取 `.deployment-state.json` 的 `current`。
2. 将 `current` 写入 `previous`。
3. 拉取新镜像 tag（通过 `-ImageTag` 参数，必须显式指定，如 `abc1234`）。
4. 更新 `CRAWLER_IMAGE` 环境变量，执行 `docker compose up -d`。
5. 健康检查：
   - 通过：将新 tag 写入 `current`，追加到 `history`。
   - 失败：调用回滚逻辑，切回 `previous`。

### rollback.ps1（回滚）

1. 读取 `.deployment-state.json` 的 `previous`。
2. 切换回 previous 镜像 tag，执行 `docker compose up -d`。
3. 支持 `-TargetImage` 参数指定任意历史 tag。
4. 回滚成功后更新状态文件：原 `current` 变为新的 `previous`，回滚目标变为新的 `current`。

## 状态管理

`.deployment-state.json` 结构：

```json
{
  "current": "registry.example.com/hs-sku-crawler:abc1234",
  "previous": "registry.example.com/hs-sku-crawler:def5678",
  "history": [
    "registry.example.com/hs-sku-crawler:def5678",
    "registry.example.com/hs-sku-crawler:abc1234"
  ]
}
```

- 首次部署时写入 `current`，`history` 初始为 `[current]`。
- 更新前将当前 `current` 写入 `previous`。
- 更新成功后将新镜像写入 `current` 并追加到 `history`。
- 回滚时从 `history` 中计算新的 `previous`。

## 健康检查

由于 crawler 服务未暴露 HTTP 健康检查接口，以容器运行状态作为健康判定依据：

- 通过 `docker inspect hs-sku-crawler --format='{{.State.Status}}'` 检查是否为 `running`。
- 默认等待 30 秒，间隔 2 秒。
- 可选在 Dockerfile 中增加 `HEALTHCHECK` 指令，但默认以容器状态为准。

## 错误处理与日志

- PowerShell 脚本开头 `#Requires -RunAsAdministrator`。
- Docker 不存在时给出清晰提示，不自动安装。
- `.env` 不存在时立即退出。
- 镜像拉取失败、容器启动失败、健康检查失败时，更新脚本自动回滚到 `previous`。
- 回滚失败时记录错误日志并退出非零状态码。
- 应用日志通过 volume 挂载到主机 `C:\hs-sku-crawler\logs`。
- 容器标准输出可通过 `docker logs hs-sku-crawler` 查看。

## 配置与安全管理

- `.env` 文件由运维人员手动放置到目标机安装目录，脚本只检查存在性。
- Git 仓库中不提交敏感配置。
- 镜像构建时不包含 `.env`（通过 `.dockerignore` 排除）。

## 权限要求

- 所有部署脚本需要以管理员身份运行 PowerShell。
- 目标机需预先安装 Docker Engine 与 Docker Compose。
- 镜像仓库需配置好访问凭据（docker login）。

## 测试策略

单元测试（与现有 `test/deployment/*.test.js` 结构一致）：

- `test/deployment/docker-state.test.js`
- `test/deployment/docker-health-check.test.js`
- `test/deployment/docker-deploy.test.js`
- `test/deployment/docker-update.test.js`
- `test/deployment/docker-rollback.test.js`

测试原则：

- Node.js 部署逻辑通过 mock `docker compose` / `docker inspect` 命令进行测试。
- PowerShell 脚本测试以路径/参数检查为主，避免在 macOS 上执行 Windows-only 命令。
- `package.json` 增加 `test:deployment:docker:unit`: `node --test test/deployment/docker-*.test.js`。

集成测试：

- `test/deployment/docker-integration.test.js`：在本地构建镜像并启动容器，验证容器能正常运行。
- 标记为可选，需要 Docker 环境。

## 成功标准

- `deployment/docker/Dockerfile` 可成功构建镜像。
- 在已安装 Docker 的 Windows 服务器上，运行 `deploy.ps1` 后 crawler 容器启动并稳定运行。
- 系统重启后，容器由 Docker 自动恢复。
- 运行 `update.ps1` 可拉取新镜像并重新创建容器；失败时自动回滚到上一版本。
- 运行 `rollback.ps1` 可快速恢复到上一版本或指定镜像 tag。
- 新增单元测试全部通过。

## 与现有 PM2 方案的关系

- Docker 部署为新增路径，不修改 `deployment/windows/` 已有文件。
- 两套方案共享同一套 `.env` 配置格式与安装目录约定（`C:\hs-sku-crawler`）。
- 运维人员可按目标环境选择 PM2 原生部署或 Docker 容器化部署。
