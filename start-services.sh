#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$ROOT_DIR/.omx/logs/split-services"
PID_DIR="$ROOT_DIR/.omx/state/split-services"

FRONTEND_PORT="${FRONTEND_PORT:-3000}"
BFF_PORT="${BFF_PORT:-4000}"
AI_PORT="${AI_PORT:-8000}"

mkdir -p "$LOG_DIR" "$PID_DIR"

load_env_file() {
  local env_file="$1"
  if [[ -f "$env_file" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$env_file"
    set +a
  fi
}

load_env_file "$ROOT_DIR/.env"
load_env_file "$ROOT_DIR/.env.local"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_cmd node
require_cmd npm
require_cmd python3
require_cmd curl

kill_existing_on_port() {
  local port="$1"
  local pids
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    echo "$pids" | xargs kill >/dev/null 2>&1 || true
  fi
}

wait_for_health() {
  local name="$1"
  local url="$2"
  local attempts="${3:-60}"

  for ((i=1; i<=attempts; i++)); do
    if curl -sf "$url" >/dev/null 2>&1; then
      echo "$name is ready: $url"
      return 0
    fi
    sleep 1
  done

  echo "$name failed health check: $url" >&2
  return 1
}

cleanup_on_failure() {
  local pid_file
  for pid_file in "$PID_DIR"/*.pid; do
    [[ -f "$pid_file" ]] || continue
    kill "$(cat "$pid_file")" >/dev/null 2>&1 || true
    rm -f "$pid_file"
  done
}

trap cleanup_on_failure ERR

kill_existing_on_port "$FRONTEND_PORT"
kill_existing_on_port "$BFF_PORT"
kill_existing_on_port "$AI_PORT"

echo "Building frontend production bundle..."
(
  cd "$ROOT_DIR/frontend"
  NEXT_PUBLIC_API_BASE_URL="http://127.0.0.1:${BFF_PORT}" npm run build >/dev/null
)

echo "Starting AI service..."
nohup bash -lc "
  cd '$ROOT_DIR'
  exec python3 -m uvicorn app.main:app --host 127.0.0.1 --port '$AI_PORT' --app-dir ai-service
" >"$LOG_DIR/ai-service.log" 2>&1 < /dev/null &
echo $! >"$PID_DIR/ai-service.pid"

echo "Starting BFF..."
nohup bash -lc "
  cd '$ROOT_DIR'
  exec env PORT='$BFF_PORT' AI_SERVICE_URL='http://127.0.0.1:${AI_PORT}' node bff/src/server.js
" >"$LOG_DIR/bff.log" 2>&1 < /dev/null &
echo $! >"$PID_DIR/bff.pid"

echo "Starting frontend..."
nohup bash -lc "
  cd '$ROOT_DIR/frontend'
  exec env PORT='$FRONTEND_PORT' NEXT_PUBLIC_API_BASE_URL='http://127.0.0.1:${BFF_PORT}' npm run start -- --port '$FRONTEND_PORT'
" >"$LOG_DIR/frontend.log" 2>&1 < /dev/null &
echo $! >"$PID_DIR/frontend.pid"

wait_for_health "AI service" "http://127.0.0.1:${AI_PORT}/api/health"
wait_for_health "BFF" "http://127.0.0.1:${BFF_PORT}/api/health"
wait_for_health "Frontend" "http://127.0.0.1:${FRONTEND_PORT}"

trap - ERR

cat <<EOF

Learning Loop AI split services are running.

- Frontend: http://127.0.0.1:${FRONTEND_PORT}
- BFF: http://127.0.0.1:${BFF_PORT}
- AI service: http://127.0.0.1:${AI_PORT}

Logs:
- $LOG_DIR/frontend.log
- $LOG_DIR/bff.log
- $LOG_DIR/ai-service.log

PID files:
- $PID_DIR/frontend.pid
- $PID_DIR/bff.pid
- $PID_DIR/ai-service.pid

To stop all services:
  bash stop-services.sh
EOF
