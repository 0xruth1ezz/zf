#!/usr/bin/env bash
set -euo pipefail

mkdir -p "${ZF_PROFILE_DIR:-/data/browser-profile}" \
  "${CRAWLEE_STORAGE_DIR:-/data/crawlee-storage}" \
  "$(dirname "${ZF_ENGAGED_DB:-/data/engaged-lotteries.sqlite}")"

cleanup() {
  trap - INT TERM
  kill "${worker_pid:-}" "${server_pid:-}" 2>/dev/null || true
  wait "${worker_pid:-}" "${server_pid:-}" 2>/dev/null || true
}
trap 'cleanup; exit 0' INT TERM

node zfrontier-lottery-crawler.js --service &
worker_pid=$!
zfrontier-report-server &
server_pid=$!

status=0
wait -n "$worker_pid" "$server_pid" || status=$?
cleanup
exit "$status"
