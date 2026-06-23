#!/usr/bin/env bash
set -euo pipefail

# Real API Smoke Test Script
# Starts the crawler in service mode against real upstream API and VEVOR site.
# Captures logs, waits for tasks to complete, outputs summary.

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
SMOKE_TIMEOUT_SECONDS="${SMOKE_TIMEOUT_SECONDS:-300}"
SMOKE_MIN_SUCCESS="${SMOKE_MIN_SUCCESS:-1}"
SMOKE_LOG_FILE="${SMOKE_LOG_FILE:-${PROJECT_DIR}/test/real/smoke-test.log}"

# Log pattern variables
PATTERN_START_TASK='start task'
PATTERN_DONE_SUCCESS='done task .* status success'
PATTERN_DONE_ERROR='done task .* status error'
PATTERN_DONE_NOT_FOUND='done task .* status not_found'

# Ensure log directory exists
mkdir -p "$(dirname "${SMOKE_LOG_FILE}")"

echo "========================================"
echo "  Real API Smoke Test"
echo "========================================"
echo "  Project:  ${PROJECT_DIR}"
echo "  Log file: ${SMOKE_LOG_FILE}"
echo "  Timeout:  ${SMOKE_TIMEOUT_SECONDS}s"
echo "  Min success: ${SMOKE_MIN_SUCCESS}"
echo ""

# Validate required env vars
if [ -z "${CRAWLER_NODE_CODE:-}" ]; then
  echo "ERROR: CRAWLER_NODE_CODE is not set. Copy test/real/.env.example to .env and configure."
  exit 1
fi

if [ -z "${CRAWLER_NODE_TOKEN:-}" ]; then
  echo "ERROR: CRAWLER_NODE_TOKEN is not set. Copy test/real/.env.example to .env and configure."
  exit 1
fi

# Check node_modules
if [ ! -d "${PROJECT_DIR}/node_modules" ]; then
  echo "Installing dependencies..."
  (cd "${PROJECT_DIR}" && npm ci)
fi

# Check Playwright browsers
if ! npx playwright install chromium 2>/dev/null; then
  echo "WARNING: Playwright browser installation may have failed. Continuing..."
fi

echo "Starting crawler service mode (logging to ${SMOKE_LOG_FILE})..."
echo ""

# Start service in background, redirect output to log file
(
  cd "${PROJECT_DIR}"
  node bin/run.js --mode service > "${SMOKE_LOG_FILE}" 2>&1
) &
SERVICE_PID=$!

# Ensure cleanup on exit
cleanup() {
  if kill -0 "$SERVICE_PID" 2>/dev/null; then
    echo ""
    echo "Sending SIGTERM to crawler service (PID ${SERVICE_PID})..."
    kill -TERM "$SERVICE_PID" 2>/dev/null || true
    wait "$SERVICE_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# Wait for service startup
START_TIME=$(date +%s)
STARTUP_TIMEOUT=30

while true; do
  if grep -q "Starting crawler service" "$SMOKE_LOG_FILE" 2>/dev/null; then
    echo "Service started successfully."
    break
  fi

  if ! kill -0 "$SERVICE_PID" 2>/dev/null; then
    echo "ERROR: Service process exited before startup."
    exit 1
  fi

  ELAPSED=$(( $(date +%s) - START_TIME ))
  if [ "$ELAPSED" -ge "$STARTUP_TIMEOUT" ]; then
    echo "ERROR: Service startup timed out after ${STARTUP_TIMEOUT}s."
    exit 1
  fi

  sleep 1
done

echo "Waiting for tasks to complete (timeout: ${SMOKE_TIMEOUT_SECONDS}s)..."
echo ""

# Wait loop: exit when either:
# 1. Timeout reached
# 2. Service process dies
# 3. completed >= started (all tasks done)

while true; do
  if ! kill -0 "$SERVICE_PID" 2>/dev/null; then
    echo "Service process exited."
    break
  fi

  # Count from log file
  STARTED=$(grep -c "$PATTERN_START_TASK" "$SMOKE_LOG_FILE" 2>/dev/null) || STARTED=0
  SUCCESS=$(grep -c "$PATTERN_DONE_SUCCESS" "$SMOKE_LOG_FILE" 2>/dev/null) || SUCCESS=0
  ERROR=$(grep -c "$PATTERN_DONE_ERROR" "$SMOKE_LOG_FILE" 2>/dev/null) || ERROR=0
  NOT_FOUND=$(grep -c "$PATTERN_DONE_NOT_FOUND" "$SMOKE_LOG_FILE" 2>/dev/null) || NOT_FOUND=0
  COMPLETED=$((SUCCESS + ERROR + NOT_FOUND))

  ELAPSED=$(( $(date +%s) - START_TIME ))

  # Print progress
  printf "\r  Elapsed: %3ds | Started: %2d | Completed: %2d (success=%2d error=%2d not_found=%2d)" \
    "$ELAPSED" "$STARTED" "$COMPLETED" "$SUCCESS" "$ERROR" "$NOT_FOUND"

  if [ "$COMPLETED" -ge "$STARTED" ] && [ "$STARTED" -gt 0 ]; then
    echo ""
    echo "All started tasks have completed."
    break
  fi

  if [ "$ELAPSED" -ge "$SMOKE_TIMEOUT_SECONDS" ]; then
    echo ""
    echo "WARNING: Reached timeout (${SMOKE_TIMEOUT_SECONDS}s). Stopping service."
    break
  fi

  sleep 2
done

echo ""
echo "========================================"
echo "  Smoke Test Summary"
echo "========================================"

# Final counts from log
STARTED=$(grep -c "$PATTERN_START_TASK" "$SMOKE_LOG_FILE" 2>/dev/null) || STARTED=0
SUCCESS=$(grep -c "$PATTERN_DONE_SUCCESS" "$SMOKE_LOG_FILE" 2>/dev/null) || SUCCESS=0
ERROR=$(grep -c "$PATTERN_DONE_ERROR" "$SMOKE_LOG_FILE" 2>/dev/null) || ERROR=0
NOT_FOUND=$(grep -c "$PATTERN_DONE_NOT_FOUND" "$SMOKE_LOG_FILE" 2>/dev/null) || NOT_FOUND=0
COMPLETED=$((SUCCESS + ERROR + NOT_FOUND))

# Check for service shutdown
if grep -q "Shutdown complete" "$SMOKE_LOG_FILE" 2>/dev/null; then
  SHUTDOWN="yes"
else
  SHUTDOWN="no"
fi

echo "  Service started: yes"
echo "  Service shutdown: ${SHUTDOWN}"
echo "  Tasks started:   ${STARTED}"
echo "  Tasks completed: ${COMPLETED}"
echo "    - success:    ${SUCCESS}"
echo "    - error:      ${ERROR}"
echo "    - not_found:  ${NOT_FOUND}"
echo ""

# Validation
PASS=true

if [ "$STARTED" -eq 0 ]; then
  echo "FAIL: No tasks were started. The upstream API may have no tasks."
  PASS=false
fi

if [ "$COMPLETED" -lt "$STARTED" ]; then
  echo "WARNING: Completed tasks (${COMPLETED}) < started tasks (${STARTED})."
  echo "         Some tasks may still be in progress or were interrupted."
fi

if [ "$SUCCESS" -lt "$SMOKE_MIN_SUCCESS" ]; then
  echo "FAIL: Success count (${SUCCESS}) < minimum required (${SMOKE_MIN_SUCCESS})."
  PASS=false
fi

echo ""
if [ "$PASS" = true ]; then
  echo "RESULT: PASS"
  exit 0
else
  echo "RESULT: FAIL"
  exit 1
fi
