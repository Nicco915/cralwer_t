#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 环境变量优先；手动部署未 export 时才读取 .env
if [ -z "${CRAWLER_IMAGE_BASE:-}" ] && [ -f .env ]; then
  set -a
  source .env
  set +a
fi

# 同步 repo 代码（docker-compose.yml 也可能需要更新）
# 使用 fetch + update-ref + checkout -f 绕过 root 拥有的 .git/ORIG_HEAD 导致的 git pull 失败
cd /opt/crawler/repo
git -c safe.directory=/opt/crawler/repo fetch origin main
git -c safe.directory=/opt/crawler/repo update-ref refs/heads/main FETCH_HEAD
git -c safe.directory=/opt/crawler/repo checkout -f main
cd "$SCRIPT_DIR"

IMAGE_TAG="${1:?请提供镜像 tag,例如 ./update.sh v1.0.0}"

if [ -z "${CRAWLER_IMAGE_BASE:-}" ]; then
  echo "错误:未设置 CRAWLER_IMAGE_BASE 环境变量" >&2
  exit 1
fi

if [[ "${CRAWLER_IMAGE_BASE}" == */ ]]; then
  echo "错误:CRAWLER_IMAGE_BASE 末尾不应包含斜杠" >&2
  exit 1
fi

if [ ! -f .env ]; then
  echo "错误:当前目录缺少 .env 文件" >&2
  exit 1
fi

if [[ ! "${IMAGE_TAG}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "警告：镜像 tag 格式不符合 vX.Y.Z 规范，继续执行: ${IMAGE_TAG}" >&2
fi

export CRAWLER_IMAGE="${CRAWLER_IMAGE_BASE}:${IMAGE_TAG}"

# 记录每个 crawler 节点当前镜像
crawler_services=$(docker compose config --services 2>/dev/null | grep '^crawler-' || true)
> .last_image
for service in $crawler_services; do
  index=${service#crawler-}
  container_name=$(printf "hs-sku-crawler-%d" "$index")
  current_image=$(docker inspect --format='{{.Config.Image}}' "$container_name" 2>/dev/null || true)
  if [ -n "$current_image" ]; then
    echo "$container_name=$current_image" >> .last_image
  fi
done

docker compose pull $crawler_services
for service in $crawler_services; do
  docker compose up -d --no-deps "$service"
done

echo "更新完成:${CRAWLER_IMAGE}"
docker compose ps
