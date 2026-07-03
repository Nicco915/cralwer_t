# VPS 部署权限与配置管理设计

## 背景

当前 VPS 部署流程遇到两个问题：

1. **`safe.directory` 反复报错**：`/opt/crawler/repo` 属主为 `crawler`，但 `root` 用户执行 `deploy.sh` 时触发 git 2.35+ 的安全检查。
2. **`CRAWLER_IMAGE_BASE` 依赖环境变量**：每次手动部署都要 `export`，且 `.env` 中已配置但脚本未读取。

## 设计目标

- 消除 `safe.directory` 报错
- 实现零手动 export 的部署体验
- 保持 GitHub Actions 自动部署与手动部署行为一致
- 最小化代码改动

## 方案选择

采用**方案 A**：

- 所有部署/更新操作统一使用 `crawler` 用户执行
- `deploy.sh` / `update.sh` 启动时 `source .env`
- `setup-vps.sh` 初始化 `.env` 时填充真实 `CRAWLER_IMAGE_BASE`
- `update.sh` 开头也执行 `git pull origin main`，确保拿到最新 `docker-compose.yml`

## 详细设计

### 1. 权限模型

| 操作 | 执行用户 | 原因 |
|------|---------|------|
| 初始化 VPS（安装 Docker、创建用户） | `root` | 需要系统级权限 |
| 日常部署/更新 | `crawler` | 与 `/opt/crawler/repo` 属主一致，避免 `safe.directory` |
| 容器运行 | `crawler`（UID 1000） | 与宿主机 `crawler` 用户 UID 对齐，避免 EACCES |

### 2. 脚本改动

#### `deployment/crawlab/deploy.sh`

在 `SCRIPT_DIR` 赋值后、`CRAWLER_IMAGE_BASE` 检查前增加：

```bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 从 .env 读取 CRAWLER_IMAGE_BASE（若环境变量未设置）
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

# 同步 repo 最新配置（deploy.sh 通过软链接指向 repo 内文件）
cd /opt/crawler/repo && git pull origin main
cd "$SCRIPT_DIR"
```

#### `deployment/crawlab/update.sh`

同样增加：

```bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

# update 也需要最新 docker-compose.yml，否则新配置不生效
cd /opt/crawler/repo && git pull origin main
cd "$SCRIPT_DIR"
```

### 3. `.env` 初始化

`deployment/crawlab/setup-vps.sh` 在 `cp .env.example .env` 后增加：

```bash
sed -i "s|ghcr.io/<GITHUB_OWNER>/<REPO>|ghcr.io/${GITHUB_OWNER_LOWER}/${REPO_LOWER}|g" /opt/crawler/.env
```

### 4. GitHub Actions workflow

`.github/workflows/deploy-vps.yml` 的 deploy job 脚本简化为：

```yaml
script: |
  cd /opt/crawler
  ./update.sh "${{ github.ref_name }}"
```

`export CRAWLER_IMAGE_BASE=...` 可移除，因为 `.env` 已包含。

### 5. 文档更新

在 `部署vps.md` 中明确手动部署命令：

```bash
su - crawler -c "cd /opt/crawler && ./deploy.sh v1.0.3"
```

## 成功标准

- `root` 不再执行 `deploy.sh` / `update.sh`
- `crawler` 用户执行部署时不再出现 `safe.directory` 报错
- 不需要手动 `export CRAWLER_IMAGE_BASE`
- GitHub Actions 自动部署与手动部署行为一致
- 更新 `docker-compose.yml` 后，自动部署能拉取新配置

## 风险与回滚

- 风险：`.env` 中 `CRAWLER_IMAGE_BASE` 被误删会导致部署失败
- 缓解：`deploy.sh` / `update.sh` 仍保留空值检查，报错明确
- 回滚：若新脚本有问题，可手动 `export CRAWLER_IMAGE_BASE` 并回退到旧版脚本
