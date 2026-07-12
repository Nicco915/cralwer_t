#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -f .env ]; then
  echo "错误：当前目录缺少 .env 文件" >&2
  exit 1
fi

if [ ! -f .last_image ]; then
  echo "错误：未找到 .last_image，无法回滚" >&2
  exit 1
fi

LAST_IMAGE=$(cat .last_image)
export CRAWLER_IMAGE="$LAST_IMAGE"

docker compose up -d --no-deps crawler

echo "回滚完成：${LAST_IMAGE}"
