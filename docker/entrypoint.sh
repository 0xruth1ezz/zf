#!/usr/bin/env bash
set -euo pipefail

mkdir -p "${ZF_PROFILE_DIR:-/data/browser-profile}" \
  "${CRAWLEE_STORAGE_DIR:-/data/crawlee-storage}" \
  "$(dirname "${ZF_ENGAGED_DB:-/data/engaged-lotteries.sqlite}")"

run_crawler_once() {
  echo "[crawler] starting at $(date -Is)"
  if npm start; then
    echo "[crawler] completed at $(date -Is)"
  else
    status=$?
    echo "[crawler] failed with exit code ${status} at $(date -Is)" >&2
  fi
}

crawler_loop() {
  interval="${CRAWL_INTERVAL_SECONDS:-3600}"

  if [ "${RUN_ON_START:-1}" = "1" ]; then
    run_crawler_once
  fi

  while true; do
    echo "[crawler] sleeping ${interval}s"
    sleep "${interval}"
    run_crawler_once
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

