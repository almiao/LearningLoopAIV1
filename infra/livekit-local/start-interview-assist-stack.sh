#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

export LIVEKIT_URL="${LIVEKIT_URL:-ws://127.0.0.1:7880}"
export LIVEKIT_WS_URL="${LIVEKIT_WS_URL:-ws://127.0.0.1:7880}"
export LIVEKIT_API_KEY="${LIVEKIT_API_KEY:-devkey}"
export LIVEKIT_API_SECRET="${LIVEKIT_API_SECRET:-secret}"
export LIVEKIT_AGENT_NAME="${LIVEKIT_AGENT_NAME:-interview-assist-agent}"
export INTERVIEW_ASSIST_LLM_PROVIDER="${INTERVIEW_ASSIST_LLM_PROVIDER:-DEEPSEEK}"

if [[ -f "$ROOT_DIR/.env.local" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env.local"
  set +a
fi

start_bg() {
  local name="$1"
  shift
  echo "Starting $name..."
  (cd "$ROOT_DIR" && "$@") &
  echo "$! $name"
}

start_bg "AI service" python3 -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --app-dir ai-service
start_bg "LiveKit session server + worker" env PORT=4200 AI_SERVICE_URL=http://127.0.0.1:8000 npm run start --prefix livekit-agent
start_bg "Frontend" bash -lc "cd frontend && exec env PORT=3002 NEXT_PUBLIC_INTERVIEW_ASSIST_API_BASE_URL=http://127.0.0.1:4200 npx next start -p 3002"

echo
echo "Local interview assist stack is starting."
echo "- LiveKit server must already be running: $LIVEKIT_URL"
echo "- Frontend: http://127.0.0.1:3002/interview-assist"
echo
wait
