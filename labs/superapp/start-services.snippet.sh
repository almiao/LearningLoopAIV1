# FROZEN — superapp-service launch lines (removed from start-services.sh in the phase-1 cut)
# Revival: re-add each line to its matching region in start-services.sh, and change the
#          --prefix path from `superapp-service` to `labs/superapp/service` (the service moved).
# Also re-add `dev:superapp` to package.json scripts:
#   "dev:superapp": "npm run dev --prefix labs/superapp/service",

# port (top of file, with the other *_PORT defs)
SUPERAPP_PORT="${SUPERAPP_PORT:-4100}"

# health check (in wait-for-health block)
wait_for_health "Superapp service" "http://127.0.0.1:${SUPERAPP_PORT}/api/health"

# pid verification loop — add `superapp-service` back into the service list
#   for service in ai-service tts-worker bff superapp-service frontend; do

# print_summary lines
# - Superapp service: http://127.0.0.1:${SUPERAPP_PORT}
# - $LOG_DIR/superapp-service.log
# - $PID_DIR/superapp-service.pid

# port cleanup (in kill block)
kill_existing_on_port "$SUPERAPP_PORT"

# launch block (note: --prefix now points at labs/superapp/service)
echo "Starting superapp service..."
nohup bash -lc "
  cd '$ROOT_DIR'
  exec env PORT='$SUPERAPP_PORT' BFF_URL='http://127.0.0.1:${BFF_PORT}' AI_SERVICE_URL='http://127.0.0.1:${AI_PORT}' npm run start --prefix labs/superapp/service
" >"$LOG_DIR/superapp-service.log" 2>&1 < /dev/null &
echo $! >"$PID_DIR/superapp-service.pid"
