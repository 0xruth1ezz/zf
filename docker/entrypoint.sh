#!/usr/bin/env bash
set -euo pipefail

mkdir -p "${ZF_PROFILE_DIR:-/data/browser-profile}" \
  "${CRAWLEE_STORAGE_DIR:-/data/crawlee-storage}" \
  "$(dirname "${ZF_ENGAGED_DB:-/data/engaged-lotteries.sqlite}")"

run_crawler_once() {
  run_mode="${1:-full}"
  timeout_seconds="${CRAWLER_RUN_TIMEOUT_SECONDS:-1800}"
  kill_after_seconds="${CRAWLER_KILL_AFTER_SECONDS:-60}"
  crawler_command=(npm start)
  if [ "$run_mode" = "pre-draw" ]; then
    crawler_command+=(-- --tracked-only)
  fi

  echo "[crawler] starting ${run_mode} run at $(date -Is)"
  if timeout --preserve-status --kill-after="${kill_after_seconds}s" "${timeout_seconds}s" "${crawler_command[@]}"; then
    echo "[crawler] completed ${run_mode} run at $(date -Is)"
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
  pre_draw_retry="${PRE_DRAW_RETRY_SECONDS:-60}"
  last_status=0
  last_mode="full"

  if [ "${RUN_ON_START:-1}" = "1" ]; then
    run_crawler_once "$last_mode" || last_status=$?
  fi

  while true; do
    if [ "$last_status" -eq 75 ]; then
      sleep_seconds="$restart_delay"
      next_mode="$last_mode"
      echo "[crawler] restarting ${next_mode} run after timeout in ${sleep_seconds}s"
    else
      sleep_seconds="$interval"
      next_mode="full"
      if pre_draw_delay="$(node zfrontier-lottery-crawler.js --next-pre-draw-delay)"; then
        if [[ "$pre_draw_delay" =~ ^[0-9]+$ ]] && [ "$pre_draw_delay" -lt "$sleep_seconds" ]; then
          next_mode="pre-draw"
          sleep_seconds="$pre_draw_delay"
          if [ "$sleep_seconds" -eq 0 ] && [ "$last_mode" = "pre-draw" ]; then
            sleep_seconds="$pre_draw_retry"
          fi
        fi
      else
        echo "[crawler] could not calculate the next pre-draw run; using the regular interval" >&2
      fi
      echo "[crawler] next ${next_mode} run in ${sleep_seconds}s"
    fi
    sleep "${sleep_seconds}"
    last_status=0
    last_mode="$next_mode"
    run_crawler_once "$last_mode" || last_status=$?
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
