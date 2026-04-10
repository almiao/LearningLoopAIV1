#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_DIR="$ROOT_DIR/.omx/state/split-services"

if [[ ! -d "$PID_DIR" ]]; then
  echo "No PID directory found: $PID_DIR"
  exit 0
fi

for pid_file in "$PID_DIR"/*.pid; do
  [[ -f "$pid_file" ]] || continue
  pid="$(cat "$pid_file")"
  if kill -0 "$pid" >/dev/null 2>&1; then
    kill "$pid" >/dev/null 2>&1 || true
    echo "Stopped PID $pid from $(basename "$pid_file")"
  fi
  rm -f "$pid_file"
done

echo "Split services stopped."
