#!/usr/bin/env bash
set -uo pipefail

EDITOR_PID=""
NEXT_PID=""
SHUTTING_DOWN=0

log() {
  printf '[combined] %s\n' "$*"
}

stop_children() {
  local signal="${1:-TERM}"
  if [[ "${SHUTTING_DOWN}" -eq 1 ]]; then
    return
  fi
  SHUTTING_DOWN=1
  trap - TERM INT
  log "forwarding ${signal} and stopping both processes"
  [[ -n "${EDITOR_PID}" ]] && kill "-${signal}" "${EDITOR_PID}" 2>/dev/null || true
  [[ -n "${NEXT_PID}" ]] && kill "-${signal}" "${NEXT_PID}" 2>/dev/null || true
  [[ -n "${EDITOR_PID}" ]] && wait "${EDITOR_PID}" 2>/dev/null || true
  [[ -n "${NEXT_PID}" ]] && wait "${NEXT_PID}" 2>/dev/null || true
}

on_term() {
  stop_children TERM
  exit 143
}

on_int() {
  stop_children INT
  exit 130
}

trap on_term TERM
trap on_int INT

log "starting FastAPI editor on 127.0.0.1:8000"
/opt/venv/bin/python -m uvicorn main:app \
  --app-dir /app/editor \
  --host 127.0.0.1 \
  --port 8000 &
EDITOR_PID=$!
log "FastAPI editor started (pid=${EDITOR_PID})"

HEALTH_DEADLINE_SECONDS="${EDITOR_HEALTH_DEADLINE_SECONDS:-60}"
if ! [[ "${HEALTH_DEADLINE_SECONDS}" =~ ^[1-9][0-9]*$ ]]; then
  log "invalid EDITOR_HEALTH_DEADLINE_SECONDS=${HEALTH_DEADLINE_SECONDS}"
  stop_children TERM
  exit 1
fi

ATTEMPT=0
START_SECONDS=${SECONDS}
while true; do
  if ! kill -0 "${EDITOR_PID}" 2>/dev/null; then
    wait "${EDITOR_PID}"
    EDITOR_STATUS=$?
    if [[ "${EDITOR_STATUS}" -eq 0 ]]; then EDITOR_STATUS=1; fi
    log "FastAPI editor exited before readiness (status=${EDITOR_STATUS})"
    stop_children TERM
    exit "${EDITOR_STATUS}"
  fi

  ELAPSED=$((SECONDS - START_SECONDS))
  REMAINING=$((HEALTH_DEADLINE_SECONDS - ELAPSED))
  if (( REMAINING <= 0 )); then
    log "FastAPI readiness deadline expired after ${ELAPSED}s"
    stop_children TERM
    exit 1
  fi

  ATTEMPT=$((ATTEMPT + 1))
  REQUEST_TIMEOUT=2
  if (( REMAINING < REQUEST_TIMEOUT )); then REQUEST_TIMEOUT=${REMAINING}; fi
  HEALTH_OUTPUT=$(/opt/venv/bin/python -c 'import sys, urllib.error, urllib.request
try:
    with urllib.request.urlopen("http://127.0.0.1:8000/salud", timeout=float(sys.argv[1])) as response:
        print("HTTP %s" % response.status)
        sys.exit(0 if 200 <= response.status < 300 else 1)
except urllib.error.HTTPError as exc:
    print("HTTP %s" % exc.code)
    sys.exit(1)
except Exception as exc:
    print("%s: %s" % (type(exc).__name__, exc))
    sys.exit(1)' "${REQUEST_TIMEOUT}" 2>&1)
  HEALTH_STATUS=$?

  if ! kill -0 "${EDITOR_PID}" 2>/dev/null; then
    wait "${EDITOR_PID}"
    EDITOR_STATUS=$?
    if [[ "${EDITOR_STATUS}" -eq 0 ]]; then EDITOR_STATUS=1; fi
    log "FastAPI editor exited during readiness (status=${EDITOR_STATUS}; ${HEALTH_OUTPUT})"
    stop_children TERM
    exit "${EDITOR_STATUS}"
  fi

  ELAPSED=$((SECONDS - START_SECONDS))
  if [[ "${HEALTH_STATUS}" -eq 0 ]]; then
    log "FastAPI ready on attempt ${ATTEMPT} after ${ELAPSED}s (${HEALTH_OUTPUT})"
    break
  fi
  if (( ELAPSED >= HEALTH_DEADLINE_SECONDS )); then
    log "FastAPI readiness deadline expired after ${ELAPSED}s (${HEALTH_OUTPUT})"
    stop_children TERM
    exit 1
  fi

  log "FastAPI readiness attempt ${ATTEMPT} failed after ${ELAPSED}s (${HEALTH_OUTPUT})"
  sleep 1
done

log "starting Next.js ingress on 0.0.0.0:${PORT:-8080}"
PORT="${PORT:-8080}" HOSTNAME="0.0.0.0" node /app/server.js &
NEXT_PID=$!
log "Next.js ingress started (pid=${NEXT_PID})"

wait -n "${EDITOR_PID}" "${NEXT_PID}"
EXIT_STATUS=$?

if ! kill -0 "${EDITOR_PID}" 2>/dev/null; then
  log "FastAPI editor exited with status ${EXIT_STATUS}; stopping Next.js"
elif ! kill -0 "${NEXT_PID}" 2>/dev/null; then
  log "Next.js exited with status ${EXIT_STATUS}; stopping FastAPI editor"
else
  log "a child process exited with status ${EXIT_STATUS}; stopping sibling"
fi

# Either long-lived child exiting is a container failure, even if it returned 0.
if [[ "${EXIT_STATUS}" -eq 0 ]]; then EXIT_STATUS=1; fi
stop_children TERM
exit "${EXIT_STATUS}"
