#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_TAG="${1:?请提供镜像 tag,例如 ./deploy.sh v1.0.0}"

if [ -z "${CRAWLER_IMAGE_BASE:-}" ]; then
  echo "错误:未设置 CRAWLER_IMAGE_BASE 环境变量" >&2
  exit 1
fi

if [[ "${CRAWLER_IMAGE_BASE}" == */ ]]; then
  echo "错误:CRAWLER_IMAGE_BASE 末尾不应包含斜杠" >&2
  exit 1
fi

export CRAWLER_IMAGE="${CRAWLER_IMAGE_BASE}:${IMAGE_TAG}"

if [ ! -f .env ]; then
  echo "错误:当前目录缺少 .env 文件" >&2
  exit 1
fi

mkdir -p logs output images

docker compose pull
docker compose up -d

echo "部署完成:${CRAWLER_IMAGE}"
docker compose ps
