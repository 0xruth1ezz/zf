#!/usr/bin/env bash
set -euo pipefail

mkdir -p "${ZF_PROFILE_DIR:-/data/browser-profile}" \
  "${CRAWLEE_STORAGE_DIR:-/data/crawlee-storage}" \
  "$(dirname "${ZF_ENGAGED_DB:-/data/engaged-lotteries.sqlite}")"

run_crawler_once() {
  timeout_seconds="${CRAWLER_RUN_TIMEOUT_SECONDS:-1800}"
  kill_after_seconds="${CRAWLER_KILL_AFTER_SECONDS:-60}"

  echo "[crawler] starting at $(date -Is)"
  if timeout --preserve-status --kill-after="${kill_after_seconds}s" "${timeout_seconds}s" npm start; then
    echo "[crawler] completed at $(date -Is)"
    return 0
  else
    status=$?
    if [ "$status" -eq 124 ] || [ "$status" -eq 137 ] || [ "$status" -eq 143 ]; then
      echo "[crawler] timed out after ${timeout_seconds}s; killed run at $(date -Is)" >&2
      return 75
    else
      echo "[crawler] failed with exit code ${status} at $(date -Is)" >&2
      return 0
    fi
  fi
}

crawler_loop() {
  interval="${CRAWL_INTERVAL_SECONDS:-3600}"
  restart_delay="${CRAWLER_RESTART_DELAY_SECONDS:-60}"
  last_status=0

  if [ "${RUN_ON_START:-1}" = "1" ]; then
    run_crawler_once || last_status=$?
  fi

  while true; do
    if [ "$last_status" -eq 75 ]; then
      sleep_seconds="$restart_delay"
      echo "[crawler] restarting after timeout in ${sleep_seconds}s"
    else
      sleep_seconds="$interval"
      echo "[crawler] sleeping ${sleep_seconds}s"
    fi
    sleep "${sleep_seconds}"
    last_status=0
    run_crawler_once || last_status=$?
  done
}

cleanup() {
  echo "[entrypoint] shutting down"
  kill "${crawler_pid:-}" "${server_pid:-}" 2>/dev/null || true
  wait "${crawler_pid:-}" "${server_pid:-}" 2>/dev/null || true
}

trap cleanup INT TERM

crawler_loop &
crawler_pid=$!

zfrontier-report-server &
server_pid=$!

wait -n "$crawler_pid" "$server_pid"
status=$?
cleanup
exit "$status"
