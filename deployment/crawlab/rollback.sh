#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -f .env ]; then
  echo "错误:当前目录缺少 .env 文件" >&2
  exit 1
fi

if [ ! -f .last_image ]; then
  echo "错误:未找到 .last_image,无法回滚" >&2
  exit 1
fi

# 按容器名逐行回滚
while IFS='=' read -r container_name image; do
  [ -z "$container_name" ] && continue
  [ -z "$image" ] && continue
  service_index=${container_name#hs-sku-crawler-}
  service_name="crawler-${service_index}"
  echo "回滚 ${service_name} 到 ${image}"
  CRAWLER_IMAGE="$image" docker compose up -d --no-deps "$service_name"
done < .last_image

echo "回滚完成"
docker compose ps
