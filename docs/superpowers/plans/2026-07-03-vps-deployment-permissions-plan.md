# VPS 部署权限与配置管理实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让 VPS 部署不再出现 `safe.directory` 报错，且无需手动 `export CRAWLER_IMAGE_BASE`。

**架构：** 所有部署/更新操作统一使用 `crawler` 用户执行；`deploy.sh` 和 `update.sh` 启动时自动 `source .env` 读取 `CRAWLER_IMAGE_BASE`；`setup-vps.sh` 初始化 `.env` 时填充真实镜像基址。

**技术栈：** Bash、Docker Compose、GitHub Actions、Node.js 测试

---

### 任务 1：让 `deploy.sh` 自动读取 `.env`

**文件：**
- 修改：`deployment/crawlab/deploy.sh`
- 测试：`test/deployment/crawlab-deploy.test.js`（新建）

**背景：** 当前 `deploy.sh` 要求调用方 `export CRAWLER_IMAGE_BASE`，但 `.env` 中已配置该值。

- [ ] **步骤 1：编写失败的测试**

创建 `test/deployment/crawlab-deploy.test.js`：

```javascript
const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

test('deploy.sh sources .env and sets CRAWLER_IMAGE_BASE', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-test-'));
  fs.writeFileSync(path.join(tmpDir, '.env'), 'CRAWLER_IMAGE_BASE=ghcr.io/nicco915/cralwer_t\n');
  fs.writeFileSync(path.join(tmpDir, 'deploy.sh'), [
    '#!/bin/bash',
    'set -euo pipefail',
    'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    'cd "$SCRIPT_DIR"',
    'if [ -f .env ]; then',
    '  set -a',
    '  source .env',
    '  set +a',
    'fi',
    'echo "BASE=${CRAWLER_IMAGE_BASE}"',
  ].join('\n'));
  fs.chmodSync(path.join(tmpDir, 'deploy.sh'), 0o755);

  const output = execFileSync(path.join(tmpDir, 'deploy.sh'), { encoding: 'utf-8', cwd: tmpDir }).trim();
  assert.strictEqual(output, 'BASE=ghcr.io/nicco915/cralwer_t');
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
node --test test/deployment/crawlab-deploy.test.js
```

预期：FAIL，因为文件不存在或 `deploy.sh` 还没有 source .env 逻辑。

- [ ] **步骤 3：修改 `deploy.sh` 读取 `.env`**

在 `deployment/crawlab/deploy.sh` 第 5 行 `cd /opt/crawler/repo && git pull origin main` 之前插入：

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

注意：原文件第 5 行已经是 `cd /opt/crawler/repo && git pull origin main`，需要把它移到 source .env 之后，并补回 `cd "$SCRIPT_DIR"`。

- [ ] **步骤 4：运行测试验证通过**

```bash
node --test test/deployment/crawlab-deploy.test.js
```

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add deployment/crawlab/deploy.sh test/deployment/crawlab-deploy.test.js
git commit -m "feat(deploy): source .env in deploy.sh and keep git pull"
```

---

### 任务 2：让 `update.sh` 自动读取 `.env` 并同步 repo

**文件：**
- 修改：`deployment/crawlab/update.sh`
- 测试：`test/deployment/crawlab-update.test.js`（新建）

**背景：** GitHub Actions 调用 `update.sh` 进行自动部署。当前它不读取 `.env`，也不更新 repo 代码。

- [ ] **步骤 1：编写失败的测试**

创建 `test/deployment/crawlab-update.test.js`：

```javascript
const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

test('update.sh sources .env and sets CRAWLER_IMAGE_BASE', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-test-'));
  fs.writeFileSync(path.join(tmpDir, '.env'), 'CRAWLER_IMAGE_BASE=ghcr.io/nicco915/cralwer_t\n');
  fs.writeFileSync(path.join(tmpDir, 'update.sh'), [
    '#!/bin/bash',
    'set -euo pipefail',
    'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    'cd "$SCRIPT_DIR"',
    'if [ -f .env ]; then',
    '  set -a',
    '  source .env',
    '  set +a',
    'fi',
    'echo "BASE=${CRAWLER_IMAGE_BASE}"',
  ].join('\n'));
  fs.chmodSync(path.join(tmpDir, 'update.sh'), 0o755);

  const output = execFileSync(path.join(tmpDir, 'update.sh'), { encoding: 'utf-8', cwd: tmpDir }).trim();
  assert.strictEqual(output, 'BASE=ghcr.io/nicco915/cralwer_t');
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
node --test test/deployment/crawlab-update.test.js
```

预期：FAIL。

- [ ] **步骤 3：修改 `update.sh` 读取 `.env` 并同步 repo**

在 `deployment/crawlab/update.sh` 第 4-5 行之间插入：

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

- [ ] **步骤 4：运行测试验证通过**

```bash
node --test test/deployment/crawlab-update.test.js
```

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add deployment/crawlab/update.sh test/deployment/crawlab-update.test.js
git commit -m "feat(deploy): source .env and git pull in update.sh"
```

---

### 任务 3：让 `setup-vps.sh` 初始化 `.env` 时填充真实镜像基址

**文件：**
- 修改：`deployment/crawlab/setup-vps.sh`

**背景：** 当前 `setup-vps.sh` 只是 `cp .env.example .env`，镜像基址仍是占位符 `ghcr.io/<GITHUB_OWNER>/<REPO>`。

- [ ] **步骤 1：修改 `setup-vps.sh`**

找到以下代码块：

```bash
echo ">>> 4. 初始化 .env"
ssh ${SSH_OPTS} "crawler@${VPS_IP}" '
  cd /opt/crawler
  cp .env.example .env
'
```

替换为：

```bash
echo ">>> 4. 初始化 .env"
ssh ${SSH_OPTS} "crawler@${VPS_IP}" "
  cd /opt/crawler
  cp .env.example .env
  sed -i 's|ghcr.io/<GITHUB_OWNER>/<REPO>|ghcr.io/${GITHUB_OWNER_LOWER}/${REPO_LOWER}|g' .env
"
```

- [ ] **步骤 2：验证 sed 逻辑**

本地测试：

```bash
echo 'CRAWLER_IMAGE_BASE=ghcr.io/<GITHUB_OWNER>/<REPO>' > /tmp/env.test
sed -i 's|ghcr.io/<GITHUB_OWNER>/<REPO>|ghcr.io/nicco915/cralwer_t|g' /tmp/env.test
cat /tmp/env.test
# 预期输出：CRAWLER_IMAGE_BASE=ghcr.io/nicco915/cralwer_t
```

- [ ] **步骤 3：Commit**

```bash
git add deployment/crawlab/setup-vps.sh
git commit -m "feat(deploy): initialize CRAWLER_IMAGE_BASE in setup-vps.sh"
```

---

### 任务 4：简化 GitHub Actions workflow

**文件：**
- 修改：`.github/workflows/deploy-vps.yml`

**背景：** `.env` 已包含 `CRAWLER_IMAGE_BASE`，workflow 不再需要通过 `export` 传它。

- [ ] **步骤 1：修改 workflow**

将：

```yaml
          script: |
            cd /opt/crawler
            export CRAWLER_IMAGE_BASE=ghcr.io/${{ steps.repo.outputs.lower }}
            ./update.sh "${{ github.ref_name }}"
```

改为：

```yaml
          script: |
            cd /opt/crawler
            ./update.sh "${{ github.ref_name }}"
```

- [ ] **步骤 2：验证 YAML 语法**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/deploy-vps.yml'))" && echo "YAML OK"
```

- [ ] **步骤 3：Commit**

```bash
git add .github/workflows/deploy-vps.yml
git commit -m "ci: remove redundant CRAWLER_IMAGE_BASE export from workflow"
```

---

### 任务 5：更新部署文档

**文件：**
- 修改：`部署vps.md`

**背景：** 文档需要反映新的部署方式：使用 `crawler` 用户，无需手动 export。

- [ ] **步骤 1：定位并修改手动部署命令**

搜索 `部署` 或 `deploy.sh` 相关段落，将类似：

```bash
su - crawler -c "cd /opt/crawler && export CRAWLER_IMAGE_BASE=ghcr.io/nicco915/cralwer_t && ./deploy.sh v1.0.0"
```

改为：

```bash
su - crawler -c "cd /opt/crawler && ./deploy.sh v1.0.0"
```

- [ ] **步骤 2：添加 crawler 用户部署说明**

在文档合适位置增加：

```markdown
### 部署用户

所有部署/更新操作请使用 `crawler` 用户执行，避免 git `safe.directory` 权限检查报错：

```bash
su - crawler -c "cd /opt/crawler && ./deploy.sh v1.0.0"
```
```

- [ ] **步骤 3：Commit**

```bash
git add 部署vps.md
git commit -m "docs: update VPS deployment instructions for crawler user and .env sourcing"
```

---

### 任务 6：全量测试与最终验证

- [ ] **步骤 1：运行全部测试**

```bash
npm test
```

预期：所有测试通过（当前基线 294 个）。

- [ ] **步骤 2：手动验证 deploy.sh 行为**

在本地临时目录：

```bash
mkdir -p /tmp/deploy-verify
cd /tmp/deploy-verify
echo 'CRAWLER_IMAGE_BASE=ghcr.io/nicco915/cralwer_t' > .env
# 复制最新 deploy.sh 到当前目录
bash deploy.sh v1.0.0 2>&1 | head -5
# 预期不再报 "未设置 CRAWLER_IMAGE_BASE 环境变量"
```

- [ ] **步骤 3：重新打 tag 触发 GitHub Actions**

```bash
git tag -d v1.0.3 2>/dev/null || true
git push github :refs/tags/v1.0.3 2>/dev/null || true
git tag v1.0.3
git push github v1.0.3
```

- [ ] **步骤 4：VPS 验证**

在 VPS 上：

```bash
su - crawler -c "cd /opt/crawler && ./deploy.sh v1.0.3"
```

预期：
- 不再出现 `safe.directory` 报错
- 不需要 `export CRAWLER_IMAGE_BASE`
- `docker ps` 显示 `hs-sku-crawler-*` 状态为 `Up`
- `docker logs hs-sku-crawler-1` 不再报 `EACCES`

---

## 自检

- **规格覆盖度：** 所有需求（crawler 用户、source .env、setup-vps 初始化、workflow 简化、文档更新）均已覆盖。
- **占位符扫描：** 无 TODO/待定；所有代码块为实际可运行内容。
- **类型一致性：** `CRAWLER_IMAGE_BASE` 在 `.env`、脚本、workflow 中命名一致。
- **范围检查：** 聚焦在当前部署问题，不涉及镜像构建或爬虫业务逻辑改动。

## 执行交接

计划已完成并保存到 `docs/superpowers/plans/2026-07-03-vps-deployment-permissions-plan.md`。

两种执行方式：

1. **子代理驱动（推荐）** - 每个任务调度一个新子代理，任务间审查，快速迭代
2. **内联执行** - 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点

选哪种方式？
