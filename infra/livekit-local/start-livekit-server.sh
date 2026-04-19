#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"

exec livekit-server \
  --dev \
  --bind 127.0.0.1 \
  --node-ip 127.0.0.1 \
  --rtc.node_ip.ipv4 127.0.0.1 \
  --keys 'devkey: secret'
