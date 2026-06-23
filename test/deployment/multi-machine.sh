#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# Configuration (override via environment)
STUB_SERVER_URL="${STUB_SERVER_URL:-http://117.72.52.0:8080}"
TASK_URL="${TASK_URL:-${STUB_SERVER_URL}/renren-api/classify/open/crawler/tasks}"
CALLBACK_URL="${CALLBACK_URL:-${STUB_SERVER_URL}/renren-api/classify/open/crawler/callback}"
NODE_TOKEN="${NODE_TOKEN:-}"
PROXY="${CRAWLER_PROXY:-}"
MACHINES="${MACHINES:-crawler-01 crawler-02 crawler-03}"
SSH_USER="${SSH_USER:-root}"
SSH_KEY="${SSH_KEY:-}"
REMOTE_DIR="${REMOTE_DIR:-/opt/vevor-crawler}"
HEADLESS="${HEADLESS:-true}"

usage() {
  cat <<EOF
Multi-machine deployment test helper.

Environment variables:
  STUB_SERVER_URL    Base URL of the stub upstream server (default: ${STUB_SERVER_URL})
  NODE_TOKEN         Auth token for upstream (default: empty)
  CRAWLER_PROXY      Proxy URL per node (default: empty)
  MACHINES           Space-separated list of node codes / hostnames (default: ${MACHINES})
  SSH_USER           SSH user for remote execution (default: ${SSH_USER})
  SSH_KEY            SSH private key path (default: none, use agent)
  REMOTE_DIR         Remote project directory (default: ${REMOTE_DIR})

Commands:
  check       Print environment checklist and example commands
  commands    Print start/stop commands for each machine (no execution)
  start       Start crawler nodes on remote machines via SSH
  stop        Stop crawler nodes on remote machines via SSH
  logs        Collect logs from remote machines
  validate    Query stub server stats and validate no duplicate callbacks
EOF
}

ssh_opts() {
  local opts="-o StrictHostKeyChecking=no -o ConnectTimeout=10"
  if [[ -n "${SSH_KEY}" ]]; then
    opts="${opts} -i ${SSH_KEY}"
  fi
  echo "${opts}"
}

cmd_check() {
  echo "=== Environment Checklist ==="
  echo "Local:"
  echo "  [ ] Node.js >= 20 installed: $(node --version 2>/dev/null || echo 'NOT FOUND')"
  echo "  [ ] npm installed: $(npm --version 2>/dev/null || echo 'NOT FOUND')"
  echo "  [ ] Playwright browsers installed or system Edge available"
  echo "  [ ] Project code deployed to each machine at ${REMOTE_DIR}"
  echo "  [ ] Dependencies installed on each machine (npm ci)"
  echo ""
  echo "Stub server:"
  echo "  [ ] Stub server running at ${STUB_SERVER_URL}"
  echo "  [ ] /health endpoint responds"
  echo "  [ ] /renren-api/classify/open/crawler/tasks returns tasks"
  echo "  [ ] /renren-api/classify/open/crawler/callback accepts callbacks"
  echo ""
  echo "Network:"
  echo "  [ ] Each machine can reach ${STUB_SERVER_URL}"
  echo "  [ ] SSH access configured: ${SSH_USER}@machine with key ${SSH_KEY:-'(agent)'}}"
  echo "  [ ] Proxy configured (optional): ${PROXY:-'(none)'}"
}

cmd_commands() {
  echo "=== Run these commands on each machine ==="
  echo ""
  for node in ${MACHINES}; do
    echo "--- ${node} ---"
    echo "cd ${REMOTE_DIR} && \\"
    echo "  CRAWLER_MODE=service \\"
    echo "  CRAWLER_NODE_CODE=${node} \\"
    echo "  CRAWLER_NODE_TOKEN=${NODE_TOKEN} \\"
    echo "  CRAWLER_TASK_URL=${TASK_URL} \\"
    echo "  CRAWLER_CALLBACK_URL=${CALLBACK_URL} \\"
    echo "  CRAWLER_CHANNELS=1 \\"
    echo "  CRAWLER_POLL_INTERVAL=2000 \\"
    echo "  CRAWLER_POLL_LIMIT=10 \\"
    echo "  CRAWLER_BASE_URL=${STUB_SERVER_URL} \\"
    echo "  CRAWLER_HEADLESS=${HEADLESS} \\"
    if [[ -n "${PROXY}" ]]; then
      echo "  CRAWLER_PROXY=${PROXY} \\"
    fi
    echo "  npm run service"
    echo ""
  done
  echo "=== Stop commands ==="
  for node in ${MACHINES}; do
    echo "ssh $(ssh_opts) ${SSH_USER}@${node} 'pkill -f \"node bin/run.js\" || true'"
  done
}

run_remote() {
  local node="$1"
  local command="$2"
  if command -v ssh >/dev/null 2>&1; then
    ssh $(ssh_opts) "${SSH_USER}@${node}" "${command}"
  else
    echo "ssh not available; manual command for ${node}: ${command}"
  fi
}

cmd_start() {
  for node in ${MACHINES}; do
    echo "[multi-machine] Starting ${node}..."
    local env_vars="CRAWLER_MODE=service CRAWLER_NODE_CODE=${node} CRAWLER_NODE_TOKEN=${NODE_TOKEN} CRAWLER_TASK_URL=${TASK_URL} CRAWLER_CALLBACK_URL=${CALLBACK_URL} CRAWLER_CHANNELS=1 CRAWLER_POLL_INTERVAL=2000 CRAWLER_POLL_LIMIT=10 CRAWLER_BASE_URL=${STUB_SERVER_URL} CRAWLER_HEADLESS=${HEADLESS}"
    if [[ -n "${PROXY}" ]]; then
      env_vars="${env_vars} CRAWLER_PROXY=${PROXY}"
    fi
    run_remote "${node}" "cd ${REMOTE_DIR} && nohup ${env_vars} npm run service > ${REMOTE_DIR}/crawler-${node}.log 2>&1 &" || true
  done
  echo "[multi-machine] Nodes started. Logs: ${REMOTE_DIR}/crawler-*.log"
}

cmd_stop() {
  for node in ${MACHINES}; do
    echo "[multi-machine] Stopping ${node}..."
    run_remote "${node}" "pkill -f 'node bin/run.js' || true" || true
  done
}

cmd_logs() {
  local out_dir="./output/multi-machine-logs-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "${out_dir}"
  for node in ${MACHINES}; do
    echo "[multi-machine] Collecting logs from ${node}..."
    scp $(ssh_opts) "${SSH_USER}@${node}:${REMOTE_DIR}/crawler-${node}.log" "${out_dir}/" 2>/dev/null || echo "  (no log collected for ${node})"
  done
  echo "[multi-machine] Logs saved to ${out_dir}"
}

cmd_validate() {
  echo "[multi-machine] Validating stub server stats at ${STUB_SERVER_URL}/stats ..."
  node "${SCRIPT_DIR}/validate-remote.js" "${STUB_SERVER_URL}/stats"
}

case "${1:-}" in
  check) cmd_check ;;
  commands) cmd_commands ;;
  start) cmd_start ;;
  stop) cmd_stop ;;
  logs) cmd_logs ;;
  validate) cmd_validate ;;
  *) usage ;;
esac
