#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_DIR="$ROOT_DIR/.omx/state/split-services"
SESSION_NAME="${SPLIT_SERVICES_SESSION_NAME:-learningloop-services}"
STOP_SCREEN=1
SCREEN_LIST=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-screen)
      STOP_SCREEN=0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
  shift
done

if [[ -d "$PID_DIR" ]]; then
  for pid_file in "$PID_DIR"/*.pid; do
    [[ -f "$pid_file" ]] || continue
    pid="$(cat "$pid_file")"
    if kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
      echo "Stopped PID $pid from $(basename "$pid_file")"
    fi
    rm -f "$pid_file"
  done
else
  echo "No PID directory found: $PID_DIR"
fi

if [[ "$STOP_SCREEN" == "1" ]] && command -v screen >/dev/null 2>&1; then
  SCREEN_LIST="$(screen -ls 2>/dev/null || true)"
  if printf '%s\n' "$SCREEN_LIST" | grep -Fq ".${SESSION_NAME}"; then
    screen -S "$SESSION_NAME" -X quit >/dev/null 2>&1 || true
    echo "Stopped screen session $SESSION_NAME"
  fi
fi

echo "Split services stopped."
