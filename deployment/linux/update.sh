#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 同步代码：/opt/crawler/repo 是仓库克隆，需要自动 pull 最新代码
REPO_DIR="/opt/crawler/repo"
if [ -d "${REPO_DIR}/.git" ]; then
  echo "[Update] syncing repo: ${REPO_DIR}"
  cd "${REPO_DIR}"
  git config --global --add safe.directory "${REPO_DIR}" 2>/dev/null || true
  git fetch origin
  git status --short | grep -q . && echo "[Update] WARNING: repo has local changes, stash or commit them first" || true
  git pull --rebase origin main || {
    echo "[Update] ERROR: git pull --rebase failed, please resolve conflicts manually" >&2
    exit 1
  }
  cd "$SCRIPT_DIR"
else
  echo "[Update] WARNING: ${REPO_DIR} is not a git repo, skipping sync"
fi

# 如果 .env 存在，读取环境变量
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

IMAGE_TAG="${1:?请提供镜像 tag，例如 ./update.sh abc1234}"

if [ -z "${CRAWLER_IMAGE_BASE:-}" ]; then
  echo "错误：未设置 CRAWLER_IMAGE_BASE 环境变量" >&2
  exit 1
fi

if [[ "${CRAWLER_IMAGE_BASE}" == */ ]]; then
  echo "错误：CRAWLER_IMAGE_BASE 末尾不应包含斜杠" >&2
  exit 1
fi

CURRENT_IMAGE=$(docker inspect --format='{{.Config.Image}}' hs-sku-crawler 2>/dev/null || true)
if [ -n "$CURRENT_IMAGE" ]; then
  echo "$CURRENT_IMAGE" > .last_image
fi

export CRAWLER_IMAGE="${CRAWLER_IMAGE_BASE}:${IMAGE_TAG}"

docker compose pull
docker compose up -d --no-deps crawler

echo "更新完成：${CRAWLER_IMAGE}"
