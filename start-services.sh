#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$ROOT_DIR/.omx/logs/split-services"
PID_DIR="$ROOT_DIR/.omx/state/split-services"
SESSION_NAME="${SPLIT_SERVICES_SESSION_NAME:-learningloop-services}"

FRONTEND_PORT="${FRONTEND_PORT:-3000}"
BFF_PORT="${BFF_PORT:-4000}"
TTS_WORKER_PORT="${TTS_WORKER_PORT:-4300}"
AI_PORT="${AI_PORT:-8000}"

# TTS is an optional Labs plugin (PRODUCT.md §7). Off by default so a fresh
# clone runs the core loop with only an LLM key. Set ENABLE_TTS=1 to launch it.
ENABLE_TTS="${ENABLE_TTS:-0}"

mkdir -p "$LOG_DIR" "$PID_DIR"

SUPERVISOR_MODE=0
DAEMON_MODE="${SPLIT_SERVICES_DAEMON:-1}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --supervisor)
      SUPERVISOR_MODE=1
      ;;
    --no-daemon)
      DAEMON_MODE=0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
  shift
done

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

DEFAULT_PYTHON_CLI_BIN_DIR="/Library/Frameworks/Python.framework/Versions/3.11/bin"
PYTHON_CLI_BIN_DIR="${PYTHON_CLI_BIN_DIR:-$DEFAULT_PYTHON_CLI_BIN_DIR}"
if [[ -d "$PYTHON_CLI_BIN_DIR" ]]; then
  export PATH="$PYTHON_CLI_BIN_DIR:$PATH"
fi

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

    for _ in {1..20}; do
      if ! lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
        return 0
      fi
      sleep 0.2
    done

    pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    if [[ -n "$pids" ]]; then
      echo "$pids" | xargs kill -9 >/dev/null 2>&1 || true
    fi
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

wait_for_port() {
  local name="$1"
  local port="$2"
  local attempts="${3:-60}"

  for ((i=1; i<=attempts; i++)); do
    if lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "$name is listening on port $port"
      return 0
    fi
    sleep 1
  done

  echo "$name failed to open port $port" >&2
  return 1
}

wait_for_all_health_checks() {
  wait_for_health "AI service" "http://127.0.0.1:${AI_PORT}/api/health"
  if [[ "$ENABLE_TTS" == "1" ]]; then
    wait_for_health "TTS worker" "http://127.0.0.1:${TTS_WORKER_PORT}/api/health"
  fi
  wait_for_health "BFF" "http://127.0.0.1:${BFF_PORT}/api/health"
  wait_for_health "Frontend" "http://127.0.0.1:${FRONTEND_PORT}"
}

verify_pid_files() {
  local service pid_file pid services
  services=(ai-service bff frontend)
  if [[ "$ENABLE_TTS" == "1" ]]; then
    services=(ai-service tts-worker bff frontend)
  fi
  for service in "${services[@]}"; do
    pid_file="$PID_DIR/$service.pid"
    if [[ ! -f "$pid_file" ]]; then
      echo "$service did not write PID file: $pid_file" >&2
      return 1
    fi
    pid="$(cat "$pid_file")"
    if [[ -z "$pid" ]] || ! kill -0 "$pid" >/dev/null 2>&1; then
      echo "$service PID is not running: ${pid:-<empty>}" >&2
      return 1
    fi
  done
}

print_summary() {
  local TTS_SUMMARY_URL="" TTS_SUMMARY_LOG="" TTS_SUMMARY_PID=""
  if [[ "$ENABLE_TTS" == "1" ]]; then
    TTS_SUMMARY_URL="
- TTS worker: http://127.0.0.1:${TTS_WORKER_PORT}"
    TTS_SUMMARY_LOG="
- $LOG_DIR/tts-worker.log"
    TTS_SUMMARY_PID="
- $PID_DIR/tts-worker.pid"
  fi
  cat <<EOF

Learning Loop AI split services are running.

- Frontend: http://127.0.0.1:${FRONTEND_PORT}
- BFF: http://127.0.0.1:${BFF_PORT}
- AI service: http://127.0.0.1:${AI_PORT}${TTS_SUMMARY_URL}

Logs:
- $LOG_DIR/frontend.log
- $LOG_DIR/bff.log
- $LOG_DIR/ai-service.log${TTS_SUMMARY_LOG}
- $LOG_DIR/supervisor.log

PID files:
- $PID_DIR/frontend.pid
- $PID_DIR/bff.pid
- $PID_DIR/ai-service.pid${TTS_SUMMARY_PID}

To stop all services:
  bash stop-services.sh
EOF

  if [[ "$DAEMON_MODE" != "0" ]] && command -v screen >/dev/null 2>&1; then
    cat <<EOF

Supervisor:
- screen session: $SESSION_NAME
- inspect: screen -r $SESSION_NAME
EOF
  fi
}

cleanup_on_failure() {
  local pid_file
  for pid_file in "$PID_DIR"/*.pid; do
    [[ -f "$pid_file" ]] || continue
    kill "$(cat "$pid_file")" >/dev/null 2>&1 || true
    rm -f "$pid_file"
  done
}

start_daemon_supervisor() {
  require_cmd screen

  bash "$ROOT_DIR/stop-services.sh" >/dev/null 2>&1 || true
  : >"$LOG_DIR/supervisor.log"

  screen -dmS "$SESSION_NAME" bash -c \
    'cd "$1" && exec bash start-services.sh --supervisor >>"$2/supervisor.log" 2>&1' \
    _ "$ROOT_DIR" "$LOG_DIR"

  wait_for_all_health_checks
  verify_pid_files
  print_summary
}

if [[ "$SUPERVISOR_MODE" != "1" && "$DAEMON_MODE" != "0" ]]; then
  if command -v screen >/dev/null 2>&1; then
    start_daemon_supervisor
    exit 0
  fi

  echo "screen is unavailable; starting services without a detached supervisor." >&2
fi

trap cleanup_on_failure ERR

kill_existing_on_port "$FRONTEND_PORT"
kill_existing_on_port "$BFF_PORT"
kill_existing_on_port "$AI_PORT"
if [[ "$ENABLE_TTS" == "1" ]]; then
  kill_existing_on_port "$TTS_WORKER_PORT"
fi

echo "Building frontend production bundle..."
(
  cd "$ROOT_DIR/frontend"
  NEXT_PUBLIC_API_BASE_URL="http://127.0.0.1:${BFF_PORT}" \
  NEXT_PUBLIC_INTERVIEW_ASSIST_API_BASE_URL="http://127.0.0.1:${AI_PORT}" \
  npm run build >/dev/null
)

echo "Starting AI service..."
nohup bash -lc "
  cd '$ROOT_DIR'
  exec python3 -m uvicorn app.main:app --host 127.0.0.1 --port '$AI_PORT' --app-dir ai-service
" >"$LOG_DIR/ai-service.log" 2>&1 < /dev/null &
echo $! >"$PID_DIR/ai-service.pid"

if [[ "$ENABLE_TTS" == "1" ]]; then
  echo "Starting TTS worker (ENABLE_TTS=1)..."
  nohup bash -lc "
    cd '$ROOT_DIR'
    exec python3 -m uvicorn app.loopassist.tts_worker:app --host 127.0.0.1 --port '$TTS_WORKER_PORT' --app-dir ai-service
  " >"$LOG_DIR/tts-worker.log" 2>&1 < /dev/null &
  echo $! >"$PID_DIR/tts-worker.pid"
else
  echo "Skipping TTS worker (optional Labs plugin; set ENABLE_TTS=1 to enable)."
fi


echo "Starting BFF..."
nohup bash -lc "
  cd '$ROOT_DIR'
  exec env PORT='$BFF_PORT' AI_SERVICE_URL='http://127.0.0.1:${AI_PORT}' TTS_SERVICE_URL='http://127.0.0.1:${TTS_WORKER_PORT}' node bff/src/server.js
" >"$LOG_DIR/bff.log" 2>&1 < /dev/null &
echo $! >"$PID_DIR/bff.pid"

echo "Starting frontend..."
nohup bash -lc "
  cd '$ROOT_DIR/frontend'
  exec env PORT='$FRONTEND_PORT' NEXT_PUBLIC_API_BASE_URL='http://127.0.0.1:${BFF_PORT}' NEXT_PUBLIC_INTERVIEW_ASSIST_API_BASE_URL='http://127.0.0.1:${AI_PORT}' npm run start -- --port '$FRONTEND_PORT'
" >"$LOG_DIR/frontend.log" 2>&1 < /dev/null &
echo $! >"$PID_DIR/frontend.pid"

wait_for_all_health_checks
verify_pid_files

trap - ERR

print_summary

if [[ "$SUPERVISOR_MODE" == "1" ]]; then
  trap 'bash "$ROOT_DIR/stop-services.sh" --skip-screen >/dev/null 2>&1 || true; exit 0' TERM INT
  while true; do
    sleep 3600
  done
fi
