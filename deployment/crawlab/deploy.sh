#!/bin/bash
set -euo pipefail

# 同步 VPS 上 repo 的最新代码（deploy.sh 通过软链接指向 /opt/crawler/repo/...）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

cd /opt/crawler/repo && git pull origin main

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

mkdir -p logs
crawler_services=$(docker compose config --services 2>/dev/null | grep '^crawler-' || true)
for service in $crawler_services; do
  index=${service#crawler-}
  node_code=$(printf "crawler-%02d" "$index")
  mkdir -p "output/${node_code}" "images/${node_code}"
done

docker compose pull
docker compose up -d

echo "部署完成:${CRAWLER_IMAGE}"
docker compose ps
