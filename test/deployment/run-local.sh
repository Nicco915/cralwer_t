#!/bin/bash
set -e

cd "$(dirname "$0")"

echo "[deploy-test] Starting local multi-machine deployment test..."
docker-compose down >/dev/null 2>&1 || true
docker-compose up -d

cleanup() {
  echo "[deploy-test] Cleaning up..."
  docker-compose down
}
trap cleanup EXIT

echo "[deploy-test] Waiting for crawlers to process all tasks..."
node validate.js
