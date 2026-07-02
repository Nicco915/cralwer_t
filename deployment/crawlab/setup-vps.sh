#!/bin/bash
set -euo pipefail

VPS_IP="${1:?请提供 VPS IP,例如 ./setup-vps.sh 203.0.113.10}"
SSH_USER="${2:-root}"
GITHUB_OWNER="${GITHUB_OWNER:?请设置 GITHUB_OWNER 环境变量}"
REPO="${REPO:?请设置 REPO 环境变量}"

echo ">>> 1. 安装 Docker"
ssh "${SSH_USER}@${VPS_IP}" '
  export DEBIAN_FRONTEND=noninteractive
  apt-get update && apt-get upgrade -y
  curl -fsSL https://get.docker.com | sh
  apt-get install -y docker-compose-plugin git
'

echo ">>> 2. 创建部署用户"
ssh "${SSH_USER}@${VPS_IP}" '
  useradd -m -s /bin/bash crawler || true
  usermod -aG docker crawler
  mkdir -p /opt/crawler/logs /opt/crawler/output /opt/crawler/images
  chown -R crawler:crawler /opt/crawler
'

echo ">>> 3. 克隆仓库"
ssh "crawler@${VPS_IP}" "
  rm -rf /opt/crawler/repo
  git clone https://github.com/${GITHUB_OWNER}/${REPO}.git /opt/crawler/repo
  ln -sf /opt/crawler/repo/deployment/crawlab/* /opt/crawler/
"

echo ">>> 4. 初始化 .env"
ssh "crawler@${VPS_IP}" '
  cd /opt/crawler
  cp .env.example .env
'

echo ">>> 完成。请执行:"
echo "    export CRAWLER_IMAGE_BASE=ghcr.io/${GITHUB_OWNER}/${REPO}"
echo "    ssh crawler@${VPS_IP}"
echo "    cd /opt/crawler"
echo "    nano .env"
echo "    ./deploy.sh v1.0.0"
