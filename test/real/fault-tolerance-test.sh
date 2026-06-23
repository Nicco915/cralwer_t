#!/usr/bin/env bash
set -euo pipefail

# Real API Fault Tolerance Test
# Runs four failure scenarios against the real upstream API and VEVOR site.
# Requires macOS or Linux, sudo access for route/ip commands, and a configured .env.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# Load environment variables from .env if present
if [ -f "${PROJECT_DIR}/.env" ]; then
  set -a
  # shellcheck source=/dev/null
  source "${PROJECT_DIR}/.env"
  set +a
fi

# Defaults
FAULT_TIMEOUT_SECONDS="${FAULT_TIMEOUT_SECONDS:-600}"
FAULT_MIN_SUCCESS="${FAULT_MIN_SUCCESS:-5}"
FAULT_BLOCK_DURATION="${FAULT_BLOCK_DURATION:-30}"
FAULT_CALLBACK_STUB_PORT="${FAULT_CALLBACK_STUB_PORT:-19000}"
FAULT_LOG_FILE="${FAULT_LOG_FILE:-${PROJECT_DIR}/test/real/fault-tolerance-test.log}"

PATTERN_START_TASK='start task'
PATTERN_DONE_SUCCESS='done task .* status success'
PATTERN_DONE_ERROR='done task .* status error'
PATTERN_DONE_NOT_FOUND='done task .* status not_found'

SERVICE_PID=0
STUB_PID=0
PASS=true

# Ensure log directory exists
mkdir -p "$(dirname "${FAULT_LOG_FILE}")"
# Start with a fresh log file for this run
: > "${FAULT_LOG_FILE}"

PLATFORM=$(uname -s)
TASK_API_IP=""

log_info() {
  echo "[INFO] $*"
}

log_error() {
  echo "[ERROR] $*" >&2
}

fail() {
  log_error "$*"
  PASS=false
}

validate_env() {
  if [ -z "${CRAWLER_NODE_CODE:-}" ]; then
    log_error "CRAWLER_NODE_CODE is not set. Copy test/real/.env.example to .env and configure."
    exit 1
  fi

  if [ -z "${CRAWLER_NODE_TOKEN+set}" ]; then
    log_error "CRAWLER_NODE_TOKEN is not set. Copy test/real/.env.example to .env and configure."
    exit 1
  fi

  if [ ! -d "${PROJECT_DIR}/node_modules" ]; then
    log_info "Installing dependencies..."
    (cd "${PROJECT_DIR}" && npm ci)
  fi
}

resolve_task_api_ip() {
  local url="$1"
  local host
  host=$(echo "$url" | sed -n 's|^[a-zA-Z]*://\([^/]*\).*|\1|p')
  host="${host%%:*}"

  if [[ "$host" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    TASK_API_IP="$host"
    return
  fi

  TASK_API_IP=$(getent hosts "$host" 2>/dev/null | awk '{print $1}' | head -n1)
  if [ -z "$TASK_API_IP" ]; then
    TASK_API_IP=$(dig +short "$host" 2>/dev/null | head -n1)
  fi
  if [ -z "$TASK_API_IP" ]; then
    log_error "Could not resolve IP for task API host: $host"
    exit 1
  fi
}

block_task_api() {
  log_info "Blocking task API IP ${TASK_API_IP} for ${FAULT_BLOCK_DURATION}s..."
  if [ "$PLATFORM" = "Darwin" ]; then
    sudo route add -host "$TASK_API_IP" -interface lo0 || true
  else
    sudo ip route add blackhole "${TASK_API_IP}/32" || true
  fi
  sleep "$FAULT_BLOCK_DURATION"
  unblock_task_api
}

unblock_task_api() {
  log_info "Unblocking task API IP ${TASK_API_IP}..."
  if [ "$PLATFORM" = "Darwin" ]; then
    sudo route delete -host "$TASK_API_IP" -interface lo0 || true
  else
    sudo ip route del blackhole "${TASK_API_IP}/32" || true
  fi
}

service_alive() {
  [ "$SERVICE_PID" -gt 0 ] && kill -0 "$SERVICE_PID" 2>/dev/null
}

wait_for_log() {
  local pattern="$1"
  local timeout="${2:-30}"
  local start_time
  start_time=$(date +%s)
  while true; do
    if grep -qE "$pattern" "$FAULT_LOG_FILE" 2>/dev/null; then
      return 0
    fi
    if ! service_alive; then
      return 1
    fi
    if [ "$(($(date +%s) - start_time))" -ge "$timeout" ]; then
      return 1
    fi
    sleep 1
  done
}

count_pattern() {
  local pattern="$1"
  grep -cE "$pattern" "$FAULT_LOG_FILE" 2>/dev/null || true
}

start_service() {
  local callback_url="${1:-$CRAWLER_CALLBACK_URL}"
  # Stop any existing service first
  if service_alive; then
    stop_service
  fi

  log_info "Starting crawler service (callback: ${callback_url})..."
  (
    cd "${PROJECT_DIR}"
    CRAWLER_CALLBACK_URL="$callback_url" node bin/run.js --mode service >> "${FAULT_LOG_FILE}" 2>&1
  ) &
  SERVICE_PID=$!

  if ! wait_for_log 'Starting crawler service' 30; then
    fail "Service failed to start (PID ${SERVICE_PID})."
    return 1
  fi
  log_info "Service started with PID ${SERVICE_PID}."
}

stop_service() {
  local signal="${1:-TERM}"
  if [ "$SERVICE_PID" -le 0 ] || ! service_alive; then
    SERVICE_PID=0
    return 0
  fi

  log_info "Sending SIG${signal} to service (PID ${SERVICE_PID})..."
  kill -"$signal" "$SERVICE_PID" 2>/dev/null || true
  local waited=0
  while service_alive && [ "$waited" -lt 30 ]; do
    sleep 1
    waited=$((waited + 1))
  done
  if service_alive; then
    log_info "Service did not stop gracefully; sending SIGKILL..."
    kill -KILL "$SERVICE_PID" 2>/dev/null || true
    wait "$SERVICE_PID" 2>/dev/null || true
  fi
  SERVICE_PID=0
}

get_descendant_pids() {
  local parent=$1
  local children
  children=$(pgrep -P "$parent" 2>/dev/null || true)
  for child in $children; do
    echo "$child"
    get_descendant_pids "$child"
  done
}

find_chromium_pids() {
  local parent=$1
  local chromium_pattern='[Cc]hromium|[Cc]hrome|chrome'
  for pid in $(get_descendant_pids "$parent" | sort -u); do
    local comm=""
    if [ "$PLATFORM" = "Darwin" ]; then
      comm=$(ps -p "$pid" -o comm= 2>/dev/null || true)
    else
      comm=$(cat "/proc/$pid/comm" 2>/dev/null || true)
    fi
    if echo "$comm" | grep -qE "$chromium_pattern"; then
      echo "$pid"
    fi
  done
}

kill_chromium() {
  local pids
  pids=$(find_chromium_pids "$SERVICE_PID")
  if [ -z "$pids" ]; then
    fail "Could not find any Chromium child process to kill."
    return 1
  fi
  log_info "Killing Chromium PIDs: $pids"
  for pid in $pids; do
    kill -9 "$pid" 2>/dev/null || true
  done
}

start_stub() {
  if [ "$STUB_PID" -gt 0 ] && kill -0 "$STUB_PID" 2>/dev/null; then
    stop_stub
  fi
  log_info "Starting callback stub on port ${FAULT_CALLBACK_STUB_PORT}..."
  (
    cd "${PROJECT_DIR}"
    node test/real/fault-callback-stub.js --port "$FAULT_CALLBACK_STUB_PORT" >> "${FAULT_LOG_FILE}" 2>&1
  ) &
  STUB_PID=$!

  local start_time
  start_time=$(date +%s)
  while true; do
    if curl -sf "http://127.0.0.1:${FAULT_CALLBACK_STUB_PORT}/health" >/dev/null 2>&1; then
      break
    fi
    if ! kill -0 "$STUB_PID" 2>/dev/null; then
      fail "Callback stub exited before startup."
      return 1
    fi
    if [ "$(($(date +%s) - start_time))" -ge 10 ]; then
      fail "Callback stub startup timed out."
      return 1
    fi
    sleep 0.5
  done
  log_info "Callback stub started with PID ${STUB_PID}."
}

stop_stub() {
  if [ "$STUB_PID" -le 0 ] || ! kill -0 "$STUB_PID" 2>/dev/null; then
    STUB_PID=0
    return 0
  fi
  log_info "Stopping callback stub (PID ${STUB_PID})..."
  kill -TERM "$STUB_PID" 2>/dev/null || true
  local waited=0
  while kill -0 "$STUB_PID" 2>/dev/null && [ "$waited" -lt 10 ]; do
    sleep 0.5
    waited=$((waited + 1))
  done
  if kill -0 "$STUB_PID" 2>/dev/null; then
    kill -KILL "$STUB_PID" 2>/dev/null || true
    wait "$STUB_PID" 2>/dev/null || true
  fi
  STUB_PID=0
}

stub_stats() {
  curl -sf "http://127.0.0.1:${FAULT_CALLBACK_STUB_PORT}/stats" 2>/dev/null || echo '{}'
}

wait_for_tasks() {
  local deadline=$1
  while true; do
    if ! service_alive; then
      fail "Service process exited unexpectedly."
      return 1
    fi

    local started success error not_found completed
    started=$(count_pattern "$PATTERN_START_TASK")
    success=$(count_pattern "$PATTERN_DONE_SUCCESS")
    error=$(count_pattern "$PATTERN_DONE_ERROR")
    not_found=$(count_pattern "$PATTERN_DONE_NOT_FOUND")
    completed=$((success + error + not_found))

    printf "\r  Elapsed: %3ds | Started: %2d | Completed: %2d (success=%2d error=%2d not_found=%2d)" \
      "$(($(date +%s) - START_TIME))" "$started" "$completed" "$success" "$error" "$not_found"

    if [ "$started" -gt 0 ] && [ "$completed" -ge "$started" ]; then
      echo ""
      log_info "All started tasks have completed."
      return 0
    fi

    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo ""
      log_info "Reached wait deadline."
      return 0
    fi

    sleep 2
  done
}

check_no_unhandled_errors() {
  if grep -qiE 'UnhandledPromiseRejection|uncaughtException|Error: Target closed|Target page, context or browser has been closed' "$FAULT_LOG_FILE" 2>/dev/null; then
    fail "Detected unhandled exception in service log."
    return 1
  fi
  return 0
}

check_no_duplicate_success() {
  local duplicates
  duplicates=$(grep -oE 'done task [0-9]+ status success' "$FAULT_LOG_FILE" 2>/dev/null | sed 's/done task //;s/ status success//' | sort | uniq -d)
  if [ -n "$duplicates" ]; then
    fail "Duplicate successful task IDs detected: $duplicates"
    return 1
  fi
  return 0
}

scene_1_block_task_api() {
  echo ""
  log_info "[SCENE 1] Block task API for ${FAULT_BLOCK_DURATION}s"

  # Ensure at least one task has started before blocking
  if ! wait_for_log "$PATTERN_START_TASK" 60; then
    fail "No tasks started before blocking task API."
    return 1
  fi

  block_task_api

  if ! service_alive; then
    fail "Service died while task API was blocked."
    return 1
  fi
  check_no_unhandled_errors
  echo "  PASS"
}

scene_2_kill_chromium() {
  echo ""
  log_info "[SCENE 2] Kill Chromium process"

  if ! service_alive; then
    fail "Service is not alive before killing Chromium."
    return 1
  fi

  # Wait until Chromium has been launched
  if ! wait_for_log 'Edge not found, falling back to Playwright bundled Chromium|Using:' 30; then
    fail "Browser did not start before kill attempt."
    return 1
  fi
  sleep 2

  if ! kill_chromium; then
    return 1
  fi

  if ! wait_for_log 'Browser restarted' 60; then
    fail "Browser did not restart after being killed."
    return 1
  fi

  if ! service_alive; then
    fail "Service died after Chromium was killed."
    return 1
  fi
  check_no_unhandled_errors
  echo "  PASS"
}

scene_3_block_callback() {
  echo ""
  log_info "[SCENE 3] Block callback API for ${FAULT_BLOCK_DURATION}s"

  # Stop current service, start stub, then restart service pointing at stub
  stop_service
  start_stub
  start_service "http://127.0.0.1:${FAULT_CALLBACK_STUB_PORT}/callback" || return 1

  # Wait for at least one callback attempt to hit the stub
  local start_time
  start_time=$(date +%s)
  while true; do
    local total_requests
    total_requests=$(stub_stats | sed -n 's/.*"totalRequests":\([0-9]*\).*/\1/p')
    if [ "${total_requests:-0}" -gt 0 ]; then
      break
    fi
    if ! service_alive; then
      fail "Service died while callback API was blocked."
      return 1
    fi
    if [ "$(($(date +%s) - start_time))" -ge 60 ]; then
      fail "No callback attempts reached the stub within 60s."
      return 1
    fi
    sleep 1
  done

  sleep "$FAULT_BLOCK_DURATION"

  # Restore real callback URL by restarting the service
  stop_service
  stop_stub
  start_service "$CRAWLER_CALLBACK_URL" || return 1

  if ! service_alive; then
    fail "Service died after restoring callback URL."
    return 1
  fi
  check_no_unhandled_errors
  echo "  PASS"
}

scene_4_graceful_restart() {
  echo ""
  log_info "[SCENE 4] Graceful service restart"

  local old_pid=$SERVICE_PID
  if [ "$old_pid" -le 0 ]; then
    fail "No service PID available for graceful restart."
    return 1
  fi

  stop_service TERM

  # Confirm old PID is gone
  if kill -0 "$old_pid" 2>/dev/null; then
    fail "Old service PID ${old_pid} did not exit after SIGTERM."
    return 1
  fi

  start_service "$CRAWLER_CALLBACK_URL" || return 1
  if [ "$SERVICE_PID" -eq "$old_pid" ]; then
    fail "New service PID is the same as the old PID."
    return 1
  fi

  echo "  PASS"
}

print_summary() {
  echo ""
  echo "========================================"
  echo "  Fault Tolerance Test Summary"
  echo "========================================"

  local started success error not_found completed
  started=$(count_pattern "$PATTERN_START_TASK")
  success=$(count_pattern "$PATTERN_DONE_SUCCESS")
  error=$(count_pattern "$PATTERN_DONE_ERROR")
  not_found=$(count_pattern "$PATTERN_DONE_NOT_FOUND")
  completed=$((success + error + not_found))

  echo "  Service currently alive: $(service_alive && echo yes || echo no)"
  echo "  Tasks started:   ${started}"
  echo "  Tasks completed: ${completed}"
  echo "    - success:    ${success}"
  echo "    - error:      ${error}"
  echo "    - not_found:  ${not_found}"
  echo ""

  check_no_unhandled_errors
  check_no_duplicate_success

  if [ "$started" -eq 0 ]; then
    fail "No tasks were started. The upstream API may have no tasks."
  fi

  if [ "$((success + not_found))" -lt "$FAULT_MIN_SUCCESS" ]; then
    fail "success + not_found ($((success + not_found))) < minimum required (${FAULT_MIN_SUCCESS})."
  fi

  echo ""
  if [ "$PASS" = true ]; then
    echo "RESULT: PASS"
    exit 0
  else
    echo "RESULT: FAIL"
    exit 1
  fi
}

# Main
echo "========================================"
echo "  Real API Fault Tolerance Test"
echo "========================================"
echo "  Timeout:     ${FAULT_TIMEOUT_SECONDS}s"
echo "  Min success: ${FAULT_MIN_SUCCESS}"
echo "  Log file:    ${FAULT_LOG_FILE}"
echo ""

validate_env
resolve_task_api_ip "$CRAWLER_TASK_URL"

START_TIME=$(date +%s)
DEADLINE=$((START_TIME + FAULT_TIMEOUT_SECONDS))

cleanup() {
  echo ""
  log_info "Cleaning up..."
  unblock_task_api || true
  stop_service || true
  stop_stub || true
}
trap cleanup EXIT

# Phase 0: start service and let it warm up
start_service "$CRAWLER_CALLBACK_URL" || exit 1

# Run scenes
scene_1_block_task_api
scene_2_kill_chromium
scene_3_block_callback
scene_4_graceful_restart

# After all scenes, wait for remaining tasks up to the overall deadline
wait_for_tasks "$DEADLINE"

print_summary
